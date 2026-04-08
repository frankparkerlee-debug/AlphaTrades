/**
 * Unusual Options Flow Scanner
 *
 * Scans a watchlist of liquid tickers and surfaces contracts with
 * abnormal volume relative to open interest — the canonical "whale"
 * / smart-money footprint in options markets.
 *
 * Heuristic:
 *   - vol/OI ratio ≥ 2  → 2x more contracts traded today than existed
 *   - mid ≥ 0.10        → liquid enough to be real institutional size
 *   - volume ≥ 100      → filters noise
 *   - notional = mid × volume × 100   → dollar premium crossing
 *
 * Returns per-ticker aggregates (call vs put premium, C/P ratio,
 * unusual contract count) plus the top unusual contracts across
 * the entire watchlist.
 */

import axios from 'axios';

const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_SECRET_KEY;

const headers = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': API_SECRET,
};

// Default universe: most liquid options tickers
export const DEFAULT_FLOW_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  'AAPL', 'MSFT', 'NVDA', 'META', 'TSLA', 'AMZN', 'GOOGL',
  'AMD', 'NFLX', 'AVGO', 'COIN', 'PLTR',
];

const UNUSUAL_VOL_OI_RATIO = 2.0;
const MIN_VOLUME = 100;
const MIN_MID = 0.10;
const MAX_PAGES_PER_TYPE = 3; // caps per-ticker latency
const CONCURRENCY = 4;

/**
 * Parse OCC symbol → { type, strike, expiry }
 * e.g. "AAPL260327C00175000" → { type:'CALL', strike:175, expiry:'2026-03-27' }
 */
function parseOCC(symbol) {
  const m = symbol.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , d, cp, strikeStr] = m;
  return {
    type: cp === 'C' ? 'CALL' : 'PUT',
    strike: parseInt(strikeStr, 10) / 1000,
    expiry: `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`,
  };
}

/**
 * Fetch all option snapshots for one ticker (both calls + puts).
 * Paginates up to MAX_PAGES_PER_TYPE per side.
 */
async function fetchTickerChain(ticker) {
  const allSnaps = {};
  for (const type of ['call', 'put']) {
    let pageToken = null;
    let pages = 0;
    do {
      const params = { type, limit: 100 };
      if (pageToken) params.page_token = pageToken;
      try {
        const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
          headers, params, timeout: 8000,
        });
        Object.assign(allSnaps, res.data?.snapshots || {});
        pageToken = res.data?.next_page_token || null;
        pages++;
      } catch (err) {
        // Non-fatal — log and continue
        console.warn(`[flow-scanner] ${ticker} ${type} page ${pages} failed:`, err.response?.status || err.message);
        break;
      }
    } while (pageToken && pages < MAX_PAGES_PER_TYPE);
  }
  return allSnaps;
}

/**
 * Convert a snapshot map into a flat list of contract summaries with
 * vol/OI ratio and notional computed. Returns only contracts that meet
 * the minimum liquidity floor.
 */
function extractContracts(ticker, snapshots) {
  const out = [];
  for (const [symbol, snap] of Object.entries(snapshots || {})) {
    const parsed = parseOCC(symbol);
    if (!parsed) continue;

    const quote = snap.latestQuote || {};
    const bid = quote.bp || 0;
    const ask = quote.ap || 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const volume = snap.dayBar?.v || 0;
    const oi = snap.openInterest || 0;
    const greeks = snap.greeks || {};
    const delta = Math.abs(greeks.delta || 0);
    const iv = greeks.impliedVolatility || 0;

    // Hard liquidity floor — everything below is noise
    if (volume < MIN_VOLUME) continue;
    if (mid < MIN_MID) continue;

    const volOiRatio = oi > 0 ? volume / oi : volume; // treat OI=0 as "all new"
    const notional = Math.round(mid * volume * 100); // option premium dollars crossing

    out.push({
      ticker,
      symbol,
      type: parsed.type,
      strike: parsed.strike,
      expiry: parsed.expiry,
      volume,
      oi,
      volOiRatio: +volOiRatio.toFixed(2),
      mid: +mid.toFixed(2),
      bid: +bid.toFixed(2),
      ask: +ask.toFixed(2),
      delta: +delta.toFixed(3),
      iv: +((iv || 0) * 100).toFixed(1),
      notional,
    });
  }
  return out;
}

/**
 * Run the scan in bounded-concurrency batches so we don't hammer Alpaca.
 */
async function runConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

/**
 * Main export: scan the universe for unusual options flow.
 *
 * @param {string[]} tickers - ticker symbols to scan
 * @returns {{
 *   generatedAt: string,
 *   universe: string[],
 *   scannedCount: number,
 *   tickers: Array<{
 *     ticker: string,
 *     callNotional: number,
 *     putNotional: number,
 *     totalNotional: number,
 *     callVolume: number,
 *     putVolume: number,
 *     cpRatio: number | null,
 *     unusualCount: number,
 *     bias: 'BULLISH'|'BEARISH'|'MIXED'|'NEUTRAL',
 *     topContracts: Array
 *   }>,
 *   topUnusual: Array  // top 15 single-contract prints across the universe
 * }}
 */
export async function scanUnusualFlow(tickers = DEFAULT_FLOW_UNIVERSE) {
  const perTicker = await runConcurrent(tickers, CONCURRENCY, async (tk) => {
    try {
      const snaps = await fetchTickerChain(tk);
      const contracts = extractContracts(tk, snaps);

      // Aggregate
      let callNotional = 0, putNotional = 0, callVol = 0, putVol = 0;
      const unusual = [];
      for (const c of contracts) {
        if (c.type === 'CALL') { callNotional += c.notional; callVol += c.volume; }
        else                   { putNotional  += c.notional; putVol  += c.volume; }
        if (c.volOiRatio >= UNUSUAL_VOL_OI_RATIO) unusual.push(c);
      }

      // Sort unusual contracts by notional DESC, keep top 5 per ticker
      unusual.sort((a, b) => b.notional - a.notional);
      const topContracts = unusual.slice(0, 5);

      const totalNotional = callNotional + putNotional;
      const cpRatio = putNotional > 0 ? +(callNotional / putNotional).toFixed(2) : null;

      let bias = 'NEUTRAL';
      if (totalNotional > 0) {
        const callShare = callNotional / totalNotional;
        if (callShare >= 0.65)      bias = 'BULLISH';
        else if (callShare <= 0.35) bias = 'BEARISH';
        else                        bias = 'MIXED';
      }

      return {
        ticker: tk,
        callNotional,
        putNotional,
        totalNotional,
        callVolume: callVol,
        putVolume: putVol,
        cpRatio,
        unusualCount: unusual.length,
        bias,
        topContracts,
      };
    } catch (err) {
      console.error(`[flow-scanner] ${tk} scan failed:`, err.message);
      return {
        ticker: tk, callNotional: 0, putNotional: 0, totalNotional: 0,
        callVolume: 0, putVolume: 0, cpRatio: null, unusualCount: 0,
        bias: 'NEUTRAL', topContracts: [], error: err.message,
      };
    }
  });

  // Sort tickers by total notional DESC and keep non-empty ones
  const tickerRows = perTicker
    .filter(t => t.totalNotional > 0 || t.unusualCount > 0)
    .sort((a, b) => b.totalNotional - a.totalNotional);

  // Top unusual contracts across the entire universe
  const topUnusual = perTicker
    .flatMap(t => t.topContracts || [])
    .sort((a, b) => b.notional - a.notional)
    .slice(0, 15);

  return {
    generatedAt: new Date().toISOString(),
    universe: tickers,
    scannedCount: perTicker.length,
    tickers: tickerRows,
    topUnusual,
  };
}
