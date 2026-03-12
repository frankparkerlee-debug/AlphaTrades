/**
 * Options Contract Selector
 * Fetches the options chain for a ticker and selects the optimal contract
 * based on signal grade, direction, current price, and ATR.
 */

import axios from 'axios';

const BASE_URL  = process.env.ALPACA_BASE_URL  || 'https://api.alpaca.markets';
const DATA_URL  = process.env.ALPACA_DATA_URL  || 'https://data.alpaca.markets';
const API_KEY   = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_SECRET_KEY;

const headers = {
  'APCA-API-KEY-ID':     API_KEY,
  'APCA-API-SECRET-KEY': API_SECRET,
};

// Grade → target delta range
const DELTA_TARGET = {
  'A+': { min: 0.45, max: 0.60 }, // near ATM — highest gamma
  'A':  { min: 0.38, max: 0.52 },
  'A-': { min: 0.30, max: 0.45 },
  'B+': { min: 0.25, max: 0.38 }, // slightly OTM
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
 * Get nearest real expiry from Alpaca options chain
 * Falls back to next monthly if no weekly exists
 */
async function getExpiry(ticker, direction) {
  try {
    const res = await axios.get(`${DATA_URL}/v1beta1/options/contracts`, {
      headers,
      params: {
        underlying_symbols: ticker,
        type: direction === 'CALL' ? 'call' : 'put',
        limit: 100,
        sort: 'expiration_date',
        order: 'asc',
      },
      timeout: 8000,
    });

    const contracts = res.data?.option_contracts || [];
    console.log(`[contract] ${ticker}: contracts endpoint returned ${contracts.length} results`);
    const today     = new Date().toISOString().split('T')[0];

    // Get unique expiry dates that are >= today
    const dates = [...new Set(
      contracts
        .map(c => c.expiration_date)
        .filter(d => d >= today)
    )].sort();

    console.log(`[contract] ${ticker}: real expiries = [${dates.join(', ')}]`);
    if (dates.length === 0) return null;

    const nearest = dates[0];
    const etNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const isToday = nearest === today;
    const label   = isToday ? '0DTE' : `${Math.round((new Date(nearest) - new Date(today)) / 86400000)}DTE`;

    return { date: nearest, label };
  } catch (err) {
    console.error(`[contract] Expiry fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Fetch options chain from Alpaca
 */
async function fetchChain(ticker, expiry, direction) {
  try {
    const type = direction === 'CALL' ? 'call' : 'put';
    const res  = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
      headers,
      params: {
        expiration_date: expiry,
        type,
        limit: 50,
      },
      timeout: 8000,
    });
    const snaps = res.data?.snapshots || {};
    console.log(`[contract] ${ticker}: ${Object.keys(snaps).length} snapshots for ${expiry}`);
    return snaps;
  } catch (err) {
    console.error(`[contract] Chain fetch failed for ${ticker}:`, err.response?.status, err.message);
    return {};
  }
}

/**
 * Select the best contract from the chain.
 * Uses progressive filter relaxation — strict first, then loosens until we find one.
 */
function selectContract(snapshots, direction, currentPrice, grade) {
  const deltaRange = DELTA_TARGET[grade] || DELTA_TARGET['B+'];
  const contracts  = Object.entries(snapshots);

  if (contracts.length === 0) return null;

  // Map all contracts once
  const all = contracts.map(([symbol, snap]) => {
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
  });

  console.log(`[contract] ${all.length} contracts in chain, delta range ${deltaRange.min}-${deltaRange.max}`);

  // Tier 1: strict filters
  let candidates = all.filter(c => {
    if (c.delta < deltaRange.min || c.delta > deltaRange.max) return false;
    if (c.bid < 0.05) return false;
    if (c.oi < 50)    return false;
    if (c.mid <= 0)   return false;
    const spread = c.ask - c.bid;
    if (spread / c.mid > 0.25) return false;
    return true;
  });

  // Tier 2: widen delta ±30%, drop OI to 10, widen spread to 40%
  if (candidates.length === 0) {
    console.log(`[contract] Tier 1 empty — relaxing filters`);
    candidates = all.filter(c => {
      if (c.delta < deltaRange.min * 0.7 || c.delta > deltaRange.max * 1.3) return false;
      if (c.bid < 0.02) return false;
      if (c.oi < 10)    return false;
      if (c.mid <= 0)   return false;
      const spread = c.ask - c.bid;
      if (c.mid > 0 && spread / c.mid > 0.40) return false;
      return true;
    });
  }

  // Tier 3: any contract with a bid and a delta — just find something real
  if (candidates.length === 0) {
    console.log(`[contract] Tier 2 empty — using any contract with bid+delta`);
    candidates = all.filter(c => c.bid > 0 && c.delta > 0.10 && c.mid > 0);
  }

  if (candidates.length === 0) {
    console.log(`[contract] All tiers empty. Sample:`, all.slice(0, 3).map(c =>
      `delta=${c.delta} bid=${c.bid} ask=${c.ask} oi=${c.oi}`
    ));
    return null;
  }

  // Sort: closest delta to ideal, then highest OI
  const idealDelta = (deltaRange.min + deltaRange.max) / 2;
  candidates.sort((a, b) => {
    const aDist = Math.abs(a.delta - idealDelta);
    const bDist = Math.abs(b.delta - idealDelta);
    if (Math.abs(aDist - bDist) > 0.05) return aDist - bDist;
    return b.oi - a.oi;
  });

  console.log(`[contract] Selected: ${candidates[0].symbol} delta=${candidates[0].delta} bid=${candidates[0].bid} ask=${candidates[0].ask} oi=${candidates[0].oi}`);
  return candidates[0];
}

/**
 * Build contract recommendation
 */
function buildRecommendation(contract, expiry, grade, direction, ticker) {
  const targets  = TARGETS[grade] || TARGETS['B+'];
  const mid      = contract.mid;
  const entry_lo = Math.max(0.01, mid * 0.95);
  const entry_hi = mid * 1.05;

  const t1   = mid * targets.t1;
  const t2   = targets.t2 ? mid * targets.t2 : null;
  const t3   = targets.t3 ? mid * targets.t3 : null;
  const stop = mid * STOP_MULT;

  // Format strike
  const strike = contract.strike;
  const label  = `${ticker} $${strike} ${direction} ${expiry.label}`;

  return {
    symbol:       contract.symbol,
    label,
    strike,
    expiry:       expiry.date,
    expiry_label: expiry.label,
    direction,
    // Pricing
    bid:          contract.bid,
    ask:          contract.ask,
    mid:          parseFloat(mid.toFixed(2)),
    entry_lo:     parseFloat(entry_lo.toFixed(2)),
    entry_hi:     parseFloat(entry_hi.toFixed(2)),
    // Greeks
    delta:        parseFloat((contract.delta || 0).toFixed(3)),
    iv:           parseFloat(((contract.iv || 0) * 100).toFixed(1)),
    open_interest: contract.oi,
    // Targets
    t1:           parseFloat(t1.toFixed(2)),
    t2:           t2 ? parseFloat(t2.toFixed(2)) : null,
    t3:           t3 ? parseFloat(t3.toFixed(2)) : null,
    stop:         parseFloat(stop.toFixed(2)),
    // Risk/reward
    max_loss_pct: 40,
    r_r:          parseFloat((t1 / mid - 1).toFixed(2)),
    estimated:    false,
  };
}

/**
 * Main export — get contract recommendation for a signal
 */
export async function selectOptionsContract(ticker, direction, grade, currentPrice, atr) {
  try {
    const expiry = await getExpiry(ticker, direction);

    if (!expiry) {
      // No contracts available for this ticker
      console.log(`[contract] No options available for ${ticker}`);
      return null;
    }

    const snapshots = await fetchChain(ticker, expiry.date, direction);
    const contract  = selectContract(snapshots, direction, currentPrice, grade);

    if (!contract) {
      console.log(`[contract] ${ticker}: no contract matched filters for ${expiry.date}`);
      return null;
    }

    return buildRecommendation(contract, expiry, grade, direction, ticker);
  } catch (err) {
    console.error(`[contract] Selection failed for ${ticker}:`, err.message);
    return null;
  }
}

