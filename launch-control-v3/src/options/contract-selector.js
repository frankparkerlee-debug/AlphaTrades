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
 * Parse expiry date from OCC symbol: BKR260320P00033000 → "2026-03-20"
 */
function parseExpiryFromOCC(symbol) {
  const m = symbol.match(/^[A-Z]{1,6}(\d{6})[CP]\d{8}$/);
  if (!m) return null;
  const d = m[1];
  return `20${d.slice(0,2)}-${d.slice(2,4)}-${d.slice(4,6)}`;
}

/**
 * Fetch all option snapshots for a ticker+direction from Alpaca,
 * then pick the nearest expiry from the results.
 * Uses /v1beta1/options/snapshots which works (the /contracts endpoint 404s).
 */
async function fetchAllSnapshots(ticker, direction, minDTE = 0) {
  try {
    const type = direction === 'CALL' ? 'call' : 'put';
    let allSnaps = {};
    let pageToken = null;

    // Paginate to get all contracts (Alpaca caps at 100 per page, max 5 pages)
    let pages = 0;
    do {
      const params = { type, limit: 100 };
      if (pageToken) params.page_token = pageToken;
      const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
        headers, params, timeout: 10000,
      });
      const snaps = res.data?.snapshots || {};
      Object.assign(allSnaps, snaps);
      pageToken = res.data?.next_page_token || null;
      pages++;
    } while (pageToken && pages < 5);

    const symbols = Object.keys(allSnaps);
    const snaps = allSnaps;
    console.log(`[contract] ${ticker}: got ${symbols.length} snapshots (paginated)`);

    if (symbols.length === 0) return { snapshots: {}, expiry: null };

    // Extract unique expiry dates from OCC symbols
    const today = new Date().toISOString().split('T')[0];
    const expiries = [...new Set(symbols.map(parseExpiryFromOCC).filter(d => d && d >= today))].sort();
    console.log(`[contract] ${ticker}: real expiries from snapshots = [${expiries.join(', ')}]`);

    if (expiries.length === 0) return { snapshots: snaps, expiry: null };

    // Filter expiries by minimum DTE
    const eligible = expiries.filter(d => Math.round((new Date(d) - new Date(today)) / 86400000) >= minDTE);
    if (eligible.length === 0) {
      console.log(`[contract] ${ticker}: no expiries meet minDTE=${minDTE} (available: ${expiries.join(', ')})`);
      return { snapshots: snaps, expiry: null };
    }
    const nearest = eligible[0];
    const days = Math.round((new Date(nearest) - new Date(today)) / 86400000);
    const label = days <= 0 ? '0DTE' : `${days}DTE`;

    // Filter snapshots to nearest expiry only
    const filtered = {};
    for (const [sym, snap] of Object.entries(snaps)) {
      if (parseExpiryFromOCC(sym) === nearest) filtered[sym] = snap;
    }
    console.log(`[contract] ${ticker}: ${Object.keys(filtered).length} contracts for ${nearest} (${label})`);

    return { snapshots: filtered, expiry: { date: nearest, label } };
  } catch (err) {
    console.error(`[contract] Snapshot fetch failed for ${ticker}:`, err.response?.status, err.message);
    return { snapshots: {}, expiry: null };
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
    // Strike from snapshot details, fallback to parsing OCC symbol
    let strike = snap.details?.strikePrice || 0;
    if (!strike) {
      const sm = symbol.match(/\d{8}$/);
      if (sm) strike = parseInt(sm[0]) / 1000;
    }
    const gamma  = Math.abs(greeks.gamma || 0);
    const theta  = greeks.theta || 0;
    const vega   = greeks.vega || 0;
    const volume = snap.dayBar?.v || 0;
    return { symbol, delta, gamma, theta, vega, bid, ask, mid, oi, iv, volume, strike, greeks, quote };
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
    gamma:        parseFloat((contract.gamma || 0).toFixed(5)),
    theta:        parseFloat((contract.theta || 0).toFixed(4)),
    vega:         parseFloat((contract.vega || 0).toFixed(4)),
    iv:           parseFloat(((contract.iv || 0) * 100).toFixed(1)),
    open_interest: contract.oi,
    options_volume: contract.volume || 0,
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
export async function selectOptionsContract(ticker, direction, grade, currentPrice, atr, { minDTE = 0 } = {}) {
  try {
    const { snapshots, expiry } = await fetchAllSnapshots(ticker, direction, minDTE);

    if (!expiry) {
      console.log(`[contract] No options available for ${ticker}`);
      return null;
    }

    const contract = selectContract(snapshots, direction, currentPrice, grade);

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

/**
 * Fetch a live quote for a SPECIFIC options contract symbol.
 * Used by the monitor to refresh bid/ask/mid/greeks without re-running selection.
 * @param {string} contractSymbol - OCC symbol like "AAPL260327C00175000"
 * @returns {Object|null} { bid, ask, mid, delta, gamma, theta, vega, iv } or null
 */
export async function fetchContractQuote(contractSymbol) {
  try {
    // Extract underlying ticker from OCC symbol (1-6 alpha chars at start)
    const ticker = contractSymbol.match(/^([A-Z]{1,6})/)?.[1];
    if (!ticker) return null;

    const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
      headers,
      params: { limit: 100 },
      timeout: 10000,
    });
    const snaps = res.data?.snapshots || {};
    const snap = snaps[contractSymbol];
    if (!snap) {
      // Try paginating to find it
      let pageToken = res.data?.next_page_token;
      let pages = 1;
      while (pageToken && pages < 5) {
        const nextRes = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
          headers,
          params: { limit: 100, page_token: pageToken },
          timeout: 10000,
        });
        const nextSnaps = nextRes.data?.snapshots || {};
        if (nextSnaps[contractSymbol]) {
          const s = nextSnaps[contractSymbol];
          const greeks = s.greeks || {};
          const quote = s.latestQuote || {};
          const bid = quote.bp || 0;
          const ask = quote.ap || 0;
          const mid = bid > 0 && ask > 0 ? parseFloat(((bid + ask) / 2).toFixed(2)) : 0;
          return {
            bid, ask, mid,
            delta: parseFloat((Math.abs(greeks.delta || 0)).toFixed(3)),
            gamma: parseFloat((Math.abs(greeks.gamma || 0)).toFixed(5)),
            theta: parseFloat((greeks.theta || 0).toFixed(4)),
            vega: parseFloat((greeks.vega || 0).toFixed(4)),
            iv: parseFloat(((greeks.impliedVolatility || 0) * 100).toFixed(1)),
          };
        }
        pageToken = nextRes.data?.next_page_token;
        pages++;
      }
      console.log(`[contract] Quote not found for ${contractSymbol}`);
      return null;
    }

    const greeks = snap.greeks || {};
    const quote = snap.latestQuote || {};
    const bid = quote.bp || 0;
    const ask = quote.ap || 0;
    const mid = bid > 0 && ask > 0 ? parseFloat(((bid + ask) / 2).toFixed(2)) : 0;

    return {
      bid, ask, mid,
      delta: parseFloat((Math.abs(greeks.delta || 0)).toFixed(3)),
      gamma: parseFloat((Math.abs(greeks.gamma || 0)).toFixed(5)),
      theta: parseFloat((greeks.theta || 0).toFixed(4)),
      vega: parseFloat((greeks.vega || 0).toFixed(4)),
      iv: parseFloat(((greeks.impliedVolatility || 0) * 100).toFixed(1)),
    };
  } catch (err) {
    console.error(`[contract] Quote fetch failed for ${contractSymbol}:`, err.message);
    return null;
  }
}

/**
 * Check total options volume for a ticker today.
 * Returns total volume across all call+put snapshots.
 */
export async function getOptionsVolume(ticker) {
  try {
    let totalVol = 0;
    let contractCount = 0;
    let logged = false;
    for (const type of ['call', 'put']) {
      const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
        headers,
        params: { type, limit: 100 },
        timeout: 8000,
      });
      const snaps = res.data?.snapshots || {};
      // Log raw structure of first snapshot to debug field names
      if (!logged && Object.keys(snaps).length > 0) {
        const firstKey = Object.keys(snaps)[0];
        console.log(`[contract] ${ticker} RAW snapshot keys: ${JSON.stringify(Object.keys(snaps[firstKey]))}`);
        console.log(`[contract] ${ticker} RAW first snapshot: ${JSON.stringify(snaps[firstKey]).slice(0, 500)}`);
        logged = true;
      }
      for (const snap of Object.values(snaps)) {
        contractCount++;
        // Sum all volume fields we can find
        totalVol += snap.latestTrade?.s || 0;
        totalVol += snap.latestTrade?.v || 0;
        totalVol += snap.dayBar?.v || 0;
        totalVol += snap.openInterest || 0;
        totalVol += snap.oi || 0;
      }
    }
    console.log(`[contract] ${ticker} options: ${contractCount} contracts, totalVol=${totalVol}`);
    return totalVol;
  } catch (err) {
    console.warn(`[contract] Options volume check failed for ${ticker}:`, err.message);
    return null;  // null = API error, let caller decide whether to block
  }
}

