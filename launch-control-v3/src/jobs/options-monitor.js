/**
 * Options Greeks Monitor
 *
 * Tracks live greeks on open paper trades every poll cycle.
 * Fetches current options snapshot, compares to entry greeks,
 * computes IV change, spread change, delta drift, cumulative
 * theta decay, and estimated P&L attribution from greeks.
 */

import axios from 'axios';

const DATA_URL   = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const API_KEY    = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_SECRET_KEY;

const headers = {
  'APCA-API-KEY-ID':     API_KEY,
  'APCA-API-SECRET-KEY': API_SECRET,
};

/**
 * Fetch options snapshot for a single contract symbol.
 * Uses /v1beta1/options/snapshots with symbols filter.
 * Returns { mid, delta, gamma, theta, vega, iv, bid, ask, spread, volume, oi } or null.
 */
async function fetchContractSnapshot(contractSymbol) {
  try {
    const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${contractSymbol.replace(/\d.*/, '')}`, {
      headers,
      params: { feed: 'indicative', limit: 100 },
      timeout: 8000,
    });

    const snaps = res.data?.snapshots || {};
    const snap = snaps[contractSymbol];
    if (!snap) return null;

    const greeks = snap.greeks || {};
    const quote  = snap.latestQuote || {};
    const bid    = quote.bp || 0;
    const ask    = quote.ap || 0;
    const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const spread = ask - bid;
    const volume = snap.dayBar?.v || 0;
    const oi     = snap.openInterest || 0;

    return {
      mid:    parseFloat(mid.toFixed(4)),
      delta:  greeks.delta || 0,
      gamma:  greeks.gamma || 0,
      theta:  greeks.theta || 0,
      vega:   greeks.vega || 0,
      iv:     greeks.impliedVolatility || 0,
      bid,
      ask,
      spread: parseFloat(spread.toFixed(4)),
      volume,
      oi,
    };
  } catch (err) {
    console.warn(`[GREEKS] Snapshot fetch failed for ${contractSymbol}: ${err.message}`);
    return null;
  }
}

/**
 * Monitor open paper trade positions — fetch live greeks and compute attribution.
 *
 * @param {import('pg').Pool} db — Postgres pool
 */
export async function monitorOpenPositions(db) {
  try {
    const res = await db.query(`
      SELECT paper_id, ticker, direction, entry_contract_symbol,
             entry_contract_mid, entry_contract_delta, entry_contract_iv,
             entry_time, entry_stock_price, current_stock_price
      FROM lc_v3.paper_trades
      WHERE status IN ('OPEN', 'WEAKENING')
        AND entry_contract_symbol IS NOT NULL
    `);

    if (res.rows.length === 0) return;

    for (const trade of res.rows) {
      const snap = await fetchContractSnapshot(trade.entry_contract_symbol);
      if (!snap) continue;

      const entryMid   = parseFloat(trade.entry_contract_mid) || 0;
      const entryDelta = parseFloat(trade.entry_contract_delta) || 0;
      const entryIV    = parseFloat(trade.entry_contract_iv) || 0; // stored as %, e.g. 45.2
      const entrySpread = 0; // not stored at entry — baseline is 0

      // Hours held since entry
      const hoursHeld = (Date.now() - new Date(trade.entry_time).getTime()) / 3_600_000;

      // IV change (both stored as decimal fractions in snapshot, entry_contract_iv is %)
      const currentIVPct = snap.iv * 100; // convert decimal → %
      const ivChangePct  = entryIV > 0 ? currentIVPct - entryIV : 0;

      // Spread change
      const spreadChange = snap.spread - entrySpread;

      // Delta change
      const deltaChange = snap.delta - entryDelta;

      // Cumulative theta decay: theta (per day) × hours_held / 24
      // theta is negative, so this gives negative decay value
      const cumulativeTheta = snap.theta * (hoursHeld / 24);

      // Stock price change since entry
      const entryStockPrice   = parseFloat(trade.entry_stock_price) || 0;
      const currentStockPrice = parseFloat(trade.current_stock_price) || entryStockPrice;
      const stockMove = currentStockPrice - entryStockPrice;

      // Greeks-based P&L attribution (per contract, in dollar terms):
      // delta_gain = delta × stock_move
      // gamma_gain = 0.5 × gamma × stock_move²
      // vega_gain  = vega × iv_change (in vol points, decimal)
      // theta_decay = theta × hours / 24  (negative)
      const deltaGain = entryDelta * stockMove;
      const gammaGain = 0.5 * snap.gamma * stockMove * stockMove;
      const vegaGain  = snap.vega * (ivChangePct / 100); // vega per 1pt vol move
      const thetaDecay = cumulativeTheta; // already negative

      const estimatedPnl = deltaGain + gammaGain + vegaGain + thetaDecay;

      // Express as % of entry mid
      const estimatedPnlPct = entryMid > 0 ? (estimatedPnl / entryMid) * 100 : 0;
      const thetaDecayPct   = entryMid > 0 ? (thetaDecay / entryMid) * 100 : 0;

      // Update paper_trades with current greeks
      await db.query(`
        UPDATE lc_v3.paper_trades SET
          current_delta = $1,
          current_iv = $2,
          current_spread = $3,
          cumulative_theta = $4,
          greeks_updated_at = NOW()
        WHERE paper_id = $5
      `, [
        parseFloat(snap.delta.toFixed(4)),
        parseFloat(currentIVPct.toFixed(2)),
        parseFloat(snap.spread.toFixed(4)),
        parseFloat(cumulativeTheta.toFixed(4)),
        trade.paper_id,
      ]);

      console.log(
        `[GREEKS] ${trade.ticker} delta=${snap.delta.toFixed(3)} iv=${currentIVPct.toFixed(1)}%` +
        ` spread=$${snap.spread.toFixed(2)} theta_decay=${thetaDecayPct.toFixed(1)}%` +
        ` estimated_pnl=${estimatedPnlPct.toFixed(1)}%`
      );
    }
  } catch (err) {
    console.error('[GREEKS] Monitor error:', err.message);
  }
}
