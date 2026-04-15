/**
 * Alpaca Order API
 *
 * Handles all order placement and management via Alpaca's trading API.
 * Supports: single-leg options, vertical spreads (2-leg), iron condors (4-leg).
 *
 * Alpaca options orders use the /v2/orders endpoint with option contract symbols.
 * Multi-leg spreads are placed as separate limit orders for each leg.
 */

import axios from 'axios';

const TRADING_URL = process.env.ALPACA_TRADING_URL || 'https://paper-api.alpaca.markets';

// Paper trading needs paper keys (PK*). Check all possible env var names, fall back to main keys.
const PAPER_KEY    = process.env.ALPACA_PAPER_API_KEY || process.env.ALPACA_PAPER_KEY || process.env.ALPACA_API_KEY;
const PAPER_SECRET = process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_PAPER_SECRET || process.env.ALPACA_SECRET_KEY;

const headers = {
  'APCA-API-KEY-ID':     PAPER_KEY,
  'APCA-API-SECRET-KEY': PAPER_SECRET,
  'Content-Type':        'application/json',
};

// Startup diagnostic — surface key mismatch early
const isPaperUrl = TRADING_URL.includes('paper');
const isPaperKey = (PAPER_KEY || '').startsWith('PK');
if (isPaperUrl && !isPaperKey) {
  console.error(
    `[ORDERS] WARNING: Trading URL is paper (${TRADING_URL}) but key does NOT start with PK. ` +
    `Paper API requires paper keys. Set ALPACA_PAPER_KEY / ALPACA_PAPER_SECRET in your env.`
  );
} else {
  console.log(`[ORDERS] Trading: ${TRADING_URL} | Key: ${(PAPER_KEY || '').slice(0, 4)}*** | Paper: ${isPaperKey}`);
}

// ── Order Placement ────────────────────────────────────────────────────────────

/**
 * Submit a single-leg options order.
 */
export async function submitOptionOrder(contractSymbol, qty, side, orderType = 'market', limitPrice = null) {
  const body = {
    symbol: contractSymbol,
    qty: String(qty),
    side,         // 'buy' or 'sell'
    type: orderType,
    time_in_force: 'day',
  };
  if (orderType === 'limit' && limitPrice) {
    body.limit_price = String(limitPrice);
  }

  const res = await axios.post(`${TRADING_URL}/v2/orders`, body, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Submit a vertical spread (2-leg order).
 * Alpaca supports multi-leg options orders via the /v2/orders endpoint.
 *
 * For a debit call spread:
 *   - Buy lower strike call (long leg)
 *   - Sell higher strike call (short leg)
 *   Net debit = long premium - short premium
 *
 * For a credit put spread:
 *   - Sell higher strike put (short leg)
 *   - Buy lower strike put (long leg)
 *   Net credit = short premium - long premium
 */
export async function submitSpreadOrder(longSymbol, shortSymbol, qty, netPrice, spreadType = 'debit') {
  // Alpaca multi-leg order format
  const body = {
    symbol: longSymbol.replace(/\d{6}[CP]\d{8}$/, '').replace(/[^A-Z]/g, ''), // underlying
    qty: String(qty),
    side: spreadType === 'debit' ? 'buy' : 'sell',
    type: 'limit',
    time_in_force: 'day',
    order_class: 'mleg',
    limit_price: String(Math.abs(netPrice).toFixed(2)),
    legs: [
      { symbol: longSymbol,  side: 'buy',  ratio_qty: '1' },
      { symbol: shortSymbol, side: 'sell', ratio_qty: '1' },
    ],
  };

  try {
    const res = await axios.post(`${TRADING_URL}/v2/orders`, body, { headers, timeout: 10000 });
    return { success: true, order: res.data };
  } catch (err) {
    // If multi-leg not supported, fall back to individual legs
    if (err.response?.status === 422 || err.response?.status === 400) {
      console.log(`[ORDERS] Multi-leg not supported, placing legs separately`);
      return submitSpreadLegsIndividually(longSymbol, shortSymbol, qty, netPrice, spreadType);
    }
    throw err;
  }
}

/**
 * Fallback: place spread as two individual orders.
 */
async function submitSpreadLegsIndividually(longSymbol, shortSymbol, qty, netPrice, spreadType) {
  const results = { success: true, legs: [] };

  try {
    // Leg 1: long leg (buy)
    const longOrder = await submitOptionOrder(longSymbol, qty, 'buy', 'limit', netPrice * 0.55);
    results.legs.push({ symbol: longSymbol, side: 'buy', order: longOrder });

    // Leg 2: short leg (sell) — only after long leg submitted
    const shortOrder = await submitOptionOrder(shortSymbol, qty, 'sell', 'limit', netPrice * 0.45);
    results.legs.push({ symbol: shortSymbol, side: 'sell', order: shortOrder });

    return results;
  } catch (err) {
    // If second leg fails, cancel first
    if (results.legs.length > 0) {
      try {
        await cancelOrder(results.legs[0].order.id);
      } catch (cancelErr) {
        console.error('[ORDERS] Failed to cancel orphan leg:', cancelErr.message);
      }
    }
    results.success = false;
    results.error = err.message;
    return results;
  }
}

/**
 * Submit an iron condor (4-leg order).
 */
export async function submitIronCondorOrder(
  longCallSymbol, shortCallSymbol,
  longPutSymbol, shortPutSymbol,
  qty, netCredit
) {
  // Try multi-leg first
  try {
    const underlying = longCallSymbol.replace(/\d{6}[CP]\d{8}$/, '').replace(/[^A-Z]/g, '');
    const body = {
      symbol: underlying,
      qty: String(qty),
      side: 'sell',
      type: 'limit',
      time_in_force: 'day',
      order_class: 'mleg',
      limit_price: String(netCredit.toFixed(2)),
      legs: [
        { symbol: shortCallSymbol, side: 'sell', ratio_qty: '1' },
        { symbol: longCallSymbol,  side: 'buy',  ratio_qty: '1' },
        { symbol: shortPutSymbol,  side: 'sell', ratio_qty: '1' },
        { symbol: longPutSymbol,   side: 'buy',  ratio_qty: '1' },
      ],
    };
    const res = await axios.post(`${TRADING_URL}/v2/orders`, body, { headers, timeout: 10000 });
    return { success: true, order: res.data };
  } catch (err) {
    // Fall back to two vertical spreads
    console.log('[ORDERS] Iron condor multi-leg failed, placing as 2 spreads');
    const callSpread = await submitSpreadOrder(longCallSymbol, shortCallSymbol, qty, netCredit * 0.5, 'credit');
    const putSpread = await submitSpreadOrder(longPutSymbol, shortPutSymbol, qty, netCredit * 0.5, 'credit');
    return { success: callSpread.success && putSpread.success, callSpread, putSpread };
  }
}

// ── Order Management ───────────────────────────────────────────────────────────

/**
 * Get order by ID.
 */
export async function getOrder(orderId) {
  const res = await axios.get(`${TRADING_URL}/v2/orders/${orderId}`, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Cancel an order.
 */
export async function cancelOrder(orderId) {
  const res = await axios.delete(`${TRADING_URL}/v2/orders/${orderId}`, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Cancel all open orders.
 */
export async function cancelAllOrders() {
  const res = await axios.delete(`${TRADING_URL}/v2/orders`, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Get all open orders.
 */
export async function getOpenOrders() {
  const res = await axios.get(`${TRADING_URL}/v2/orders?status=open`, { headers, timeout: 10000 });
  return res.data;
}

// ── Position Management ────────────────────────────────────────────────────────

/**
 * Get all open positions.
 */
export async function getPositions() {
  const res = await axios.get(`${TRADING_URL}/v2/positions`, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Close a specific position by symbol.
 */
export async function closePosition(symbol) {
  const res = await axios.delete(`${TRADING_URL}/v2/positions/${encodeURIComponent(symbol)}`, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Close all positions.
 */
export async function closeAllPositions() {
  const res = await axios.delete(`${TRADING_URL}/v2/positions`, { headers, timeout: 10000 });
  return res.data;
}

// ── Account ────────────────────────────────────────────────────────────────────

/**
 * Get account info (balance, buying power, etc.)
 */
export async function getAccount() {
  const res = await axios.get(`${TRADING_URL}/v2/account`, { headers, timeout: 10000 });
  return res.data;
}

/**
 * Get current buying power.
 */
export async function getBuyingPower() {
  const account = await getAccount();
  return parseFloat(account.buying_power || 0);
}

// ── Contract Selection Helpers ─────────────────────────────────────────────────

/**
 * Find spread contracts for a given underlying, direction, and width.
 * Selects ATM strike for long leg, OTM for short leg.
 *
 * @param {Object} snapshots - Alpaca options snapshots keyed by symbol
 * @param {number} underlyingPrice - current stock price
 * @param {string} direction - 'CALL' or 'PUT'
 * @param {number} spreadWidth - desired spread width in dollars
 * @param {number} minOI - minimum open interest
 * @returns {{ longSymbol, shortSymbol, longStrike, shortStrike, netDebit, netCredit }}
 */
export function selectSpreadContracts(snapshots, underlyingPrice, direction, spreadWidth, minOI = 50) {
  const contracts = Object.entries(snapshots).map(([symbol, snap]) => {
    const greeks = snap.greeks || {};
    const quote = snap.latestQuote || {};
    let strike = snap.details?.strikePrice || 0;
    if (!strike) {
      const m = symbol.match(/\d{8}$/);
      if (m) strike = parseInt(m[0]) / 1000;
    }
    return {
      symbol,
      strike,
      delta: Math.abs(greeks.delta || 0),
      bid: quote.bp || 0,
      ask: quote.ap || 0,
      mid: (quote.bp || 0) > 0 && (quote.ap || 0) > 0 ? ((quote.bp + quote.ap) / 2) : 0,
      oi: snap.openInterest || 0,
      iv: greeks.impliedVolatility || 0,
    };
  }).filter(c => c.oi >= minOI && c.mid > 0);

  if (contracts.length < 2) return null;

  // Sort by distance from ATM
  contracts.sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice));

  // Long leg: closest to ATM
  const longLeg = contracts[0];

  // Short leg: closest to (ATM + spreadWidth) for calls, (ATM - spreadWidth) for puts
  const targetShort = direction === 'CALL'
    ? longLeg.strike + spreadWidth
    : longLeg.strike - spreadWidth;

  const shortCandidates = contracts.filter(c =>
    c.symbol !== longLeg.symbol &&
    (direction === 'CALL' ? c.strike > longLeg.strike : c.strike < longLeg.strike)
  );

  if (shortCandidates.length === 0) return null;

  // Pick closest to target width
  shortCandidates.sort((a, b) =>
    Math.abs(a.strike - targetShort) - Math.abs(b.strike - targetShort)
  );
  const shortLeg = shortCandidates[0];

  const actualWidth = Math.abs(shortLeg.strike - longLeg.strike);
  const netDebit = longLeg.mid - shortLeg.mid;   // for debit spreads
  const netCredit = shortLeg.mid - longLeg.mid;   // for credit spreads

  return {
    longSymbol:  longLeg.symbol,
    shortSymbol: shortLeg.symbol,
    longStrike:  longLeg.strike,
    shortStrike: shortLeg.strike,
    actualWidth,
    netDebit:  Math.max(0, netDebit),
    netCredit: Math.max(0, netCredit),
    longMid:   longLeg.mid,
    shortMid:  shortLeg.mid,
    longOI:    longLeg.oi,
    shortOI:   shortLeg.oi,
  };
}
