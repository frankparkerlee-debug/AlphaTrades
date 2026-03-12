/**
 * Options Contract Selector
 * Fetches the options chain for a ticker and selects the optimal contract.
 * Only returns REAL contracts from the live chain — never estimates.
 */

import axios from 'axios';

const DATA_URL   = process.env.ALPACA_DATA_URL  || 'https://data.alpaca.markets';
const API_KEY    = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_SECRET_KEY;

const headers = {
  'APCA-API-KEY-ID':     API_KEY,
  'APCA-API-SECRET-KEY': API_SECRET,
};

// Grade → target delta range
const DELTA_TARGET = {
  'A+': { min: 0.45, max: 0.60 },
  'A':  { min: 0.38, max: 0.52 },
  'A-': { min: 0.30, max: 0.45 },
  'B+': { min: 0.25, max: 0.38 },
  'B':  { min: 0.20, max: 0.32 },
};

// Grade → return multipliers for targets
const TARGETS = {
  'A+': { t1: 1.50, t2: 2.00, t3: 3.00 },
  'A':  { t1: 1.40, t2: 1.90, t3: 2.60 },
  'A-': { t1: 1.35, t2: 1.75, t3: 2.20 },
  'B+': { t1: 1.30, t2: 1.60, t3: null },
  'B':  { t1: 1.25, t2: null, t3: null },
};

const STOP_MULT = 0.60; // -40% of premium

/**
 * Parse OCC symbol like BKR20260313P00053500
 * into { ticker: 'BKR', date: '2026-03-13', type: 'PUT', strike: 53.50 }
 */
function parseOCC(symbol) {
  // OCC format: TICKER(1-6 chars) + YYMMDD(6) + C/P(1) + strike*1000(8)
  const match = symbol.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, ticker, dateStr, cp, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  return {
    ticker,
    date: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'CALL' : 'PUT',
    strike: parseInt(strikeStr) / 1000,
  };
}

/**
 * Format OCC symbol into human-readable: "BKR 3/20/2026 PUT $53.50"
 */
function formatContract(symbol) {
  const p = parseOCC(symbol);
  if (!p) return symbol;
  const [y, m, d] = p.date.split('-');
  return `${p.ticker} ${parseInt(m)}/${parseInt(d)}/${y} ${p.type} $${p.strike}`;
}

/**
 * Calculate DTE label from expiry date string
 */
function dteLabel(expiryDate) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const exp = new Date(expiryDate + 'T16:00:00');
  const diffMs = exp - now;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return '0DTE';
  if (days === 1) return '1DTE';
  return `${days}DTE`;
}

/**
 * Fetch options chain from Alpaca — try multiple expiries to find real contracts.
 * Tries nearest expiry first (today), then upcoming dates.
 */
async function fetchChainWithExpiry(ticker, direction) {
  const type = direction === 'CALL' ? 'call' : 'put';

  // Build candidate expiry dates: today, +1 through +14 (skipping weekends)
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  const candidates = [];
  const d = new Date(etNow);
  for (let i = 0; i < 21; i++) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      candidates.push(fmt(d));
    }
    d.setDate(d.getDate() + 1);
  }

  // Try each expiry date until we find one with contracts
  for (const expiry of candidates) {
    try {
      const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
        headers,
        params: {
          expiration_date: expiry,
          type,
          limit: 50,
        },
        timeout: 8000,
      });
      const snapshots = res.data?.snapshots || {};
      if (Object.keys(snapshots).length > 0) {
        console.log(`[contract] ${ticker}: found ${Object.keys(snapshots).length} contracts for ${expiry}`);
        return { snapshots, expiryDate: expiry };
      }
    } catch (err) {
      // 404 or no data for this expiry — try next
      if (err.response?.status !== 404) {
        console.error(`[contract] ${ticker} chain error (${expiry}):`, err.message);
      }
    }
  }

  console.log(`[contract] ${ticker}: no contracts found in next 14 trading days`);
  return { snapshots: {}, expiryDate: null };
}

/**
 * Select the best contract from the chain
 */
function selectContract(snapshots, direction, currentPrice, grade) {
  const deltaRange = DELTA_TARGET[grade] || DELTA_TARGET['B+'];
  const contracts  = Object.entries(snapshots);

  if (contracts.length === 0) return null;

  const candidates = contracts
    .map(([symbol, snap]) => {
      const greeks  = snap.greeks || {};
      const quote   = snap.latestQuote || {};
      const delta   = Math.abs(greeks.delta || 0);
      const bid     = quote.bp || 0;
      const ask     = quote.ap || 0;
      const mid     = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const oi      = snap.openInterest || 0;
      const iv      = greeks.impliedVolatility || 0;
      const strike  = snap.details?.strikePrice || 0;

      return { symbol, delta, bid, ask, mid, oi, iv, strike, greeks, quote };
    })
    .filter(c => {
      if (c.delta < deltaRange.min || c.delta > deltaRange.max) return false;
      if (c.bid < 0.05) return false;
      if (c.oi < 50)    return false;
      if (c.mid <= 0)   return false;
      const spread = c.ask - c.bid;
      if (spread / c.mid > 0.25) return false;
      return true;
    });

  if (candidates.length === 0) {
    // Relax filters — drop OI requirement, widen delta range slightly
    const relaxed = contracts
      .map(([symbol, snap]) => {
        const greeks = snap.greeks || {};
        const quote  = snap.latestQuote || {};
        const delta  = Math.abs(greeks.delta || 0);
        const bid    = quote.bp || 0;
        const ask    = quote.ap || 0;
        const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
        const iv     = greeks.impliedVolatility || 0;
        const strike = snap.details?.strikePrice || 0;
        const oi     = snap.openInterest || 0;

        return { symbol, delta, bid, ask, mid, oi, iv, strike, greeks, quote };
      })
      .filter(c => {
        if (c.delta < deltaRange.min * 0.7 || c.delta > deltaRange.max * 1.3) return false;
        if (c.bid < 0.01) return false;
        if (c.mid <= 0)   return false;
        return true;
      });

    if (relaxed.length === 0) return null;

    relaxed.sort((a, b) => {
      const idealDelta = (deltaRange.min + deltaRange.max) / 2;
      return Math.abs(a.delta - idealDelta) - Math.abs(b.delta - idealDelta);
    });
    return relaxed[0];
  }

  candidates.sort((a, b) => {
    const idealDelta = (deltaRange.min + deltaRange.max) / 2;
    const aDeltaDist = Math.abs(a.delta - idealDelta);
    const bDeltaDist = Math.abs(b.delta - idealDelta);
    if (Math.abs(aDeltaDist - bDeltaDist) > 0.05) return aDeltaDist - bDeltaDist;
    return b.oi - a.oi;
  });

  return candidates[0];
}

/**
 * Build contract recommendation
 */
function buildRecommendation(contract, expiryDate, grade, direction, ticker) {
  const targets  = TARGETS[grade] || TARGETS['B+'];
  const mid      = contract.mid;
  const entry_lo = Math.max(0.01, mid * 0.95);
  const entry_hi = mid * 1.05;

  const t1   = mid * targets.t1;
  const t2   = targets.t2 ? mid * targets.t2 : null;
  const t3   = targets.t3 ? mid * targets.t3 : null;
  const stop = mid * STOP_MULT;

  const label = formatContract(contract.symbol);
  const dteLbl = dteLabel(expiryDate);

  return {
    symbol:       contract.symbol,
    label,
    strike:       contract.strike,
    expiry:       expiryDate,
    expiry_label: dteLbl,
    direction,
    bid:          contract.bid,
    ask:          contract.ask,
    mid:          parseFloat(mid.toFixed(2)),
    entry_lo:     parseFloat(entry_lo.toFixed(2)),
    entry_hi:     parseFloat(entry_hi.toFixed(2)),
    delta:        parseFloat((contract.delta || 0).toFixed(3)),
    iv:           parseFloat(((contract.iv || 0) * 100).toFixed(1)),
    open_interest: contract.oi,
    t1:           parseFloat(t1.toFixed(2)),
    t2:           t2 ? parseFloat(t2.toFixed(2)) : null,
    t3:           t3 ? parseFloat(t3.toFixed(2)) : null,
    stop:         parseFloat(stop.toFixed(2)),
    max_loss_pct: 40,
    r_r:          parseFloat((t1 / mid - 1).toFixed(2)),
    estimated:    false,
  };
}

/**
 * Main export — get contract recommendation for a signal.
 * Only returns REAL contracts. Returns null if none found.
 */
export async function selectOptionsContract(ticker, direction, grade, currentPrice, atr) {
  try {
    const { snapshots, expiryDate } = await fetchChainWithExpiry(ticker, direction);
    if (!expiryDate) return null;

    const contract = selectContract(snapshots, direction, currentPrice, grade);
    if (!contract) {
      console.log(`[contract] ${ticker}: no contract matched filters for ${expiryDate}`);
      return null;
    }

    return buildRecommendation(contract, expiryDate, grade, direction, ticker);
  } catch (err) {
    console.error(`[contract] Selection failed for ${ticker}:`, err.message);
    return null;
  }
}
