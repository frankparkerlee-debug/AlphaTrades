/**
 * Single-Leg Option P&L Simulator
 *
 * Models buying and SELLING 0DTE/1DTE ATM options as a resale trade.
 * This is NOT a hold-to-expiry model. The trade is:
 *   1. Buy ATM option at premium
 *   2. Underlying moves → option price changes (delta + gamma)
 *   3. Sell the option when profit target hit, or cut loss
 *
 * Key features:
 *   - Gamma-aware pricing: winners gain more than losers lose (0DTE gamma is high)
 *   - Option P&L-based exits: sell at +30%, cut at -35%, trail from +15%
 *   - Underlying stop preserved as thesis-invalidation exit
 *   - Max loss capped at premium paid
 */

import {
  estimateSlippage,
  estimateCommissions,
  contractCount,
  allInCost,
} from './execution-model.js';

// ── Premium Estimation ───────────────────────────────────────────────────────

/**
 * Estimate ATM option premium when no market quote is available.
 * @param {number} atr - ATR as decimal (e.g., 0.025 for 2.5%)
 * @param {number} entryPrice - underlying price at entry
 * @returns {number} estimated premium per share
 */
function estimatePremium(atr, entryPrice) {
  return atr * entryPrice * 0.4;
}

// ── Theta Decay ──────────────────────────────────────────────────────────────

/**
 * Time decay factor using square-root model.
 * For short holds (5-25 min on a 390-min day), decay is < 3%.
 * @returns {number} decay factor in [0, 1], where 1 = no decay
 */
function timeDecayFactor(minutesHeld, totalTradingMinutes) {
  const remaining = Math.max(0, totalTradingMinutes - minutesHeld);
  if (totalTradingMinutes <= 0) return 0;
  return Math.sqrt(remaining / totalTradingMinutes);
}

// ── Gamma-Aware Option Value ─────────────────────────────────────────────────

/**
 * Estimate option value using delta integration (captures gamma).
 *
 * For 0DTE ATM options, gamma is very high. Delta swings from ~0.05 (deep OTM)
 * to ~0.95 (deep ITM) within 1-2 ATR. This creates asymmetric payoff:
 *   - Favorable moves: delta increases → gains accelerate
 *   - Adverse moves: delta decreases → losses decelerate
 *
 * Uses midpoint delta approximation: avgDelta(move) ≈ delta(move/2)
 * with tanh curve scaled by ATR.
 *
 * @param {number} premium - entry premium per share
 * @param {number} favorableMove - signed dollar move in favorable direction
 * @param {number} atrDollar - dollar ATR (atr * entryPrice)
 * @param {number} decay - time decay factor [0, 1]
 * @returns {number} estimated option value per share
 */
function estimateOptionValue(premium, favorableMove, atrDollar, decay) {
  // 0.45 coefficient: 0DTE gamma is high, delta swings ~0.05-0.95 within 2 ATR
  const avgDelta = 0.50 + 0.45 * Math.tanh(favorableMove / (2 * atrDollar));
  const optionGain = favorableMove * avgDelta;
  const rawValue = (premium + optionGain) * decay;
  // Floor at 0 (max loss = premium), cap at 5x (realistic 0DTE max on big moves)
  return Math.max(0, Math.min(premium * 5, rawValue));
}

// ── Option P&L Exit Thresholds ───────────────────────────────────────────────

const OPTION_PROFIT_TARGET_PCT = 30;   // sell option at +30% gain
const OPTION_TRAIL_ACTIVATE_PCT = 15;  // trail activates at +15%
const OPTION_TRAIL_GIVE_BACK = 0.50;   // exit when P&L drops to 50% of peak
const OPTION_LOSS_CUT_PCT = -35;       // cut option at -35% loss

// ── Single-Leg Simulator ─────────────────────────────────────────────────────

/**
 * Simulate buying and selling an ATM option based on underlying price action.
 *
 * Exit priority:
 *   1. STOP    — underlying price broke TA level (thesis invalidated)
 *   2. TARGET  — option P&L hit +30% (sell into the spike)
 *   3. TRAIL   — option was up 15%+, now giving back (protect gains)
 *   4. CUT     — option P&L hit -35% (premium eroding, cut loss)
 *   5. TIME    — maxHoldMinutes reached (backstop)
 *   6. EOD     — end of available data
 */
export function simulateSingleLeg(signal, bars, params) {
  const {
    premium: premiumParam = null,
    stopCondition,
    targetCondition,
    maxHoldMinutes = 45,
    holdDays = 0,
    accountSize = 7500,
    sizePct = 0.10,
    oiEstimate = 200,
  } = params;

  const direction = signal.direction;
  const entryPrice = signal.entryPrice;
  const atr = signal.atr || 0.025;
  const atrDollar = atr * entryPrice;
  const mult = direction === 'CALL' ? 1 : -1;

  // ── Premium ────────────────────────────────────────────────────────────────
  const premium = premiumParam != null ? premiumParam : estimatePremium(atr, entryPrice);

  // ── Time parameters ────────────────────────────────────────────────────────
  const totalTradingMinutes = holdDays === 0 ? 390 : (holdDays + 1) * 390;

  // ── Underlying stop level (thesis invalidation) ────────────────────────────
  let stopPrice;
  if (stopCondition?.type === 'PRICE' && stopCondition.value > 0) {
    stopPrice = stopCondition.value;
  } else {
    const stopATR = stopCondition?.value || 0.5;
    stopPrice = entryPrice - (stopATR * atrDollar * mult);
  }

  // ── Position sizing ────────────────────────────────────────────────────────
  const allocation = accountSize * sizePct;
  const contracts = contractCount(allocation, premium);

  // ── Execution costs ────────────────────────────────────────────────────────
  const commissions = estimateCommissions(1, contracts);
  const rawSlippage = estimateSlippage(oiEstimate);
  const slippage = (rawSlippage / 2) * contracts;
  const totalCosts = parseFloat((commissions + slippage).toFixed(2));

  // ── Parse entry time ───────────────────────────────────────────────────────
  const entryTime = new Date(
    signal.time.length <= 16 ? signal.time + ':00Z' : signal.time
  );

  // Debug: log first trade
  if (!simulateSingleLeg._logged) {
    simulateSingleLeg._logged = true;
    const firstBar = bars[0];
    console.log(`[SIM-DEBUG] signal.time=${signal.time} bars=${bars.length} premium=$${premium.toFixed(2)} maxHold=${maxHoldMinutes}min`);
    console.log(`[SIM-DEBUG] entry=${entryPrice} direction=${direction} atrDollar=${atrDollar.toFixed(2)} stopPrice=${stopPrice}`);
    console.log(`[SIM-DEBUG] exits: TARGET=+${OPTION_PROFIT_TARGET_PCT}% TRAIL=+${OPTION_TRAIL_ACTIVATE_PCT}%→${OPTION_TRAIL_GIVE_BACK*100}% CUT=${OPTION_LOSS_CUT_PCT}%`);
  }

  // ── Scan bars for exit conditions ──────────────────────────────────────────
  let exitType = 'EOD';
  let exitBar = bars[bars.length - 1] || null;
  let holdMinutes = 0;

  // Track option P&L state
  let mfeOptionPnl = 0;
  let maeOptionPnl = 0;
  let peakOptionPnlPct = 0;
  let exitOptionValue = premium; // default: no change

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barTime = new Date(bar.t);
    const minutesHeld = Math.round((barTime - entryTime) / 60000);

    if (minutesHeld < 0) continue;

    // Current option value
    const favorableMove = (bar.c - entryPrice) * mult;
    const decay = timeDecayFactor(minutesHeld, totalTradingMinutes);
    const currentOptionValue = estimateOptionValue(premium, favorableMove, atrDollar, decay);
    const currentPnl = currentOptionValue - premium;
    const currentPnlPct = premium > 0 ? (currentPnl / premium) * 100 : 0;

    // Also check high/low for more accurate MFE/MAE
    const favHigh = (direction === 'CALL' ? bar.h : bar.l);
    const favMoveBest = (favHigh - entryPrice) * mult;
    const bestOptionValue = estimateOptionValue(premium, favMoveBest, atrDollar, decay);
    const bestPnlPct = premium > 0 ? ((bestOptionValue - premium) / premium) * 100 : 0;

    const advLow = (direction === 'CALL' ? bar.l : bar.h);
    const advMoveWorst = (advLow - entryPrice) * mult;
    const worstOptionValue = estimateOptionValue(premium, advMoveWorst, atrDollar, decay);

    // Track MFE/MAE on option value
    mfeOptionPnl = Math.max(mfeOptionPnl, bestOptionValue - premium);
    maeOptionPnl = Math.min(maeOptionPnl, worstOptionValue - premium);
    peakOptionPnlPct = Math.max(peakOptionPnlPct, bestPnlPct);

    // ── Exit priority: STOP → TARGET → TRAIL → CUT → TIME ──

    // 1. Underlying stop (thesis invalidation — TA level broken)
    const hitStop = direction === 'CALL'
      ? bar.l <= stopPrice
      : bar.h >= stopPrice;

    if (hitStop) {
      exitType = 'STOP';
      exitBar = bar;
      holdMinutes = minutesHeld;
      // Option value at stop price
      const stopMove = (stopPrice - entryPrice) * mult;
      exitOptionValue = estimateOptionValue(premium, stopMove, atrDollar, decay);
      break;
    }

    // 2. Option profit target: sell at +30% (using bar high for favorable)
    if (bestPnlPct >= OPTION_PROFIT_TARGET_PCT) {
      exitType = 'TARGET';
      exitBar = bar;
      holdMinutes = minutesHeld;
      // Exit at the target percentage, not the peak
      exitOptionValue = premium * (1 + OPTION_PROFIT_TARGET_PCT / 100);
      break;
    }

    // 3. Option trailing stop: was up 15%+, now close P&L below 50% of peak
    if (peakOptionPnlPct >= OPTION_TRAIL_ACTIVATE_PCT &&
        currentPnlPct < peakOptionPnlPct * OPTION_TRAIL_GIVE_BACK) {
      exitType = 'TRAIL';
      exitBar = bar;
      holdMinutes = minutesHeld;
      exitOptionValue = currentOptionValue;
      break;
    }

    // 4. Option loss cut: cut at -35%
    const worstPnlPct = premium > 0 ? ((worstOptionValue - premium) / premium) * 100 : 0;
    if (worstPnlPct <= OPTION_LOSS_CUT_PCT) {
      exitType = 'CUT';
      exitBar = bar;
      holdMinutes = minutesHeld;
      exitOptionValue = premium * (1 + OPTION_LOSS_CUT_PCT / 100);
      break;
    }

    // 5. Time backstop
    if (minutesHeld > maxHoldMinutes) {
      exitType = 'TIME';
      exitBar = bar;
      holdMinutes = minutesHeld;
      exitOptionValue = currentOptionValue;
      break;
    }

    // Update default exit value for EOD
    exitOptionValue = currentOptionValue;
  }

  // ── Calculate final P&L ────────────────────────────────────────────────────

  const pnlPerShare = exitOptionValue - premium;
  const pnlPct = premium > 0 ? (pnlPerShare / premium) * 100 : 0;
  const grossPnl = pnlPerShare * 100 * contracts;

  // Net P&L after costs. Max loss capped at premium paid.
  const netPnl = Math.max(
    -(premium * 100 * contracts),
    grossPnl - totalCosts
  );

  // MFE/MAE as % of premium
  const mfePct = premium > 0 ? (mfeOptionPnl / premium) * 100 : 0;
  const maePct = premium > 0 ? (maeOptionPnl / premium) * 100 : 0;

  // Exit efficiency: how much of peak option P&L we captured
  const exitEfficiency = mfeOptionPnl > 0
    ? Math.min(1, pnlPerShare / mfeOptionPnl)
    : 0;

  // Effective exit price on underlying (for reporting)
  let effectiveExitPrice;
  if (exitType === 'STOP') {
    effectiveExitPrice = stopPrice;
  } else {
    effectiveExitPrice = exitBar?.c || entryPrice;
  }

  const exitMinutesHeld = holdMinutes || (exitBar
    ? Math.max(0, Math.round((new Date(exitBar.t) - entryTime) / 60000))
    : 0);

  return {
    exitType,
    exitPrice: effectiveExitPrice,
    exitTime: exitBar?.t || signal.time,
    pnlPct:      parseFloat(pnlPct.toFixed(2)),
    pnlDollars:  Math.round(netPnl),
    holdMinutes: Math.max(0, holdMinutes || exitMinutesHeld),
    contracts,
    commissions: parseFloat(commissions.toFixed(2)),
    slippage:    parseFloat(slippage.toFixed(2)),
    totalCosts,
    grossPnl:    Math.round(grossPnl),
    mfePct:      parseFloat(mfePct.toFixed(2)),
    maePct:      parseFloat(maePct.toFixed(2)),
    exitEfficiency: parseFloat(exitEfficiency.toFixed(3)),
    spreadDetails: {
      type: 'SINGLE_LEG',
      premium,
      maxLoss:   Math.round(-(premium * 100 * contracts)),
      maxGain:   null,
      strike:    entryPrice,
      entryDTE:  holdDays === 0 ? 0 : holdDays,
    },
  };
}
