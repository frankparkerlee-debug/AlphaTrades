/**
 * Execution Model
 * Centralized realistic execution assumptions: slippage, commissions, liquidity, fills.
 * Shared by all strategies and the spread P&L engine.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const COMMISSION_PER_CONTRACT = 0.65;      // Alpaca per-contract fee
export const SEC_FEE_PER_DOLLAR     = 0.0000278;  // SEC transaction fee (sells only)
export const SLIPPAGE_TICKS_LIQUID   = 1;          // ticks slippage on liquid options (OI > 500)
export const SLIPPAGE_TICKS_ILLIQUID = 2;          // ticks slippage on illiquid options (OI 50-500)
export const TICK_SIZE               = 0.01;       // option price tick size (most options)
export const MIN_OI                  = 50;         // minimum open interest
export const MAX_BID_ASK_PCT         = 0.25;       // max bid-ask spread as % of mid
export const MIN_FILL_PROBABILITY    = 0.85;       // fill probability on illiquid contracts

// Position sizing per grade
export const POSITION_SIZES = {
  'A+': 0.25, 'A': 0.20, 'A-': 0.15, 'B+': 0.10, 'B': 0.075,
};

// Spread widths by underlying price tier
export const SPREAD_WIDTHS = {
  under50:   1.00,  // stocks < $50: $1 wide spreads
  under150:  2.50,  // stocks $50-$150: $2.50 wide
  under300:  5.00,  // stocks $150-$300: $5 wide
  over300:  10.00,  // stocks > $300: $10 wide
};

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Get spread width based on underlying stock price.
 */
export function getSpreadWidth(underlyingPrice) {
  if (underlyingPrice < 50)  return SPREAD_WIDTHS.under50;
  if (underlyingPrice < 150) return SPREAD_WIDTHS.under150;
  if (underlyingPrice < 300) return SPREAD_WIDTHS.under300;
  return SPREAD_WIDTHS.over300;
}

/**
 * Estimate slippage in dollars per spread.
 * @param {number} oiEstimate - estimated open interest
 * @param {number} bidAskPct - bid-ask spread as % of mid price
 * @returns {number} slippage in dollars per contract
 */
export function estimateSlippage(oiEstimate, bidAskPct = 0.10) {
  const ticks = oiEstimate > 500 ? SLIPPAGE_TICKS_LIQUID : SLIPPAGE_TICKS_ILLIQUID;
  const slippagePerLeg = ticks * TICK_SIZE;
  // 2 legs per spread, slippage on each
  return slippagePerLeg * 2;
}

/**
 * Calculate total round-trip commissions for a spread trade.
 * @param {number} legs - number of legs (2 for vertical, 4 for iron condor)
 * @param {number} contracts - number of contracts
 * @returns {number} total commission in dollars
 */
export function estimateCommissions(legs = 2, contracts = 1) {
  // Open + close = 2 transactions per leg
  return COMMISSION_PER_CONTRACT * legs * 2 * contracts;
}

/**
 * Estimate fill probability based on open interest.
 * @param {number} oiEstimate - estimated open interest
 * @returns {number} probability 0-1
 */
export function estimateFillProbability(oiEstimate) {
  if (oiEstimate < MIN_OI) return 0;        // won't trade
  if (oiEstimate < 100) return 0.85;
  if (oiEstimate < 200) return 0.90;
  if (oiEstimate < 500) return 0.95;
  return 0.99;
}

/**
 * Check if a trade passes liquidity filters.
 * @param {number} oiEstimate - estimated open interest
 * @param {number} bidAskPct - bid-ask spread as % of mid
 * @returns {{ pass: boolean, reason: string|null }}
 */
export function liquidityFilter(oiEstimate, bidAskPct = 0.10) {
  if (oiEstimate < MIN_OI) {
    return { pass: false, reason: `OI ${oiEstimate} < ${MIN_OI} minimum` };
  }
  if (bidAskPct > MAX_BID_ASK_PCT) {
    return { pass: false, reason: `Bid-ask ${(bidAskPct * 100).toFixed(1)}% > ${MAX_BID_ASK_PCT * 100}% max` };
  }
  return { pass: true, reason: null };
}

/**
 * Model overnight gap risk for multi-day holds.
 * Uses ATR to estimate potential overnight gap.
 * @param {number} atr - ATR as decimal (e.g., 0.025)
 * @param {number} holdDays - number of overnight holds
 * @param {number} spreadWidth - width of the spread
 * @returns {{ gapRiskPct: number, adjustedMaxLoss: number }}
 */
export function overnightGapRisk(atr, holdDays, spreadWidth) {
  // Overnight gaps are typically 0.5-1.5x daily ATR
  // With a spread, max loss is capped at spread width regardless of gap
  const expectedGap = atr * 0.75 * holdDays;
  const gapRiskPct = Math.min(1.0, expectedGap / (spreadWidth / 100));

  return {
    gapRiskPct: parseFloat(gapRiskPct.toFixed(3)),
    adjustedMaxLoss: spreadWidth, // spreads cap the loss regardless
  };
}

/**
 * Calculate all-in cost for a spread trade (commissions + slippage).
 * @param {number} legs - 2 for vertical, 4 for iron condor
 * @param {number} contracts - number of contracts
 * @param {number} oiEstimate - open interest estimate
 * @returns {{ commissions: number, slippage: number, totalCost: number }}
 */
export function allInCost(legs = 2, contracts = 1, oiEstimate = 200) {
  const commissions = estimateCommissions(legs, contracts);
  const slippage = estimateSlippage(oiEstimate) * contracts;
  return {
    commissions: parseFloat(commissions.toFixed(2)),
    slippage: parseFloat(slippage.toFixed(2)),
    totalCost: parseFloat((commissions + slippage).toFixed(2)),
  };
}

/**
 * Estimate number of contracts for a given allocation.
 * @param {number} allocationDollars - dollars allocated to this trade
 * @param {number} riskPerContract - max risk per contract (debit or spread width - credit)
 * @returns {number} number of contracts (at least 1)
 */
export function contractCount(allocationDollars, riskPerContract) {
  if (riskPerContract <= 0) return 1;
  // Each contract controls 100 shares; cost is per-share basis * 100
  const maxContracts = Math.floor(allocationDollars / (riskPerContract * 100));
  return Math.max(1, maxContracts);
}
