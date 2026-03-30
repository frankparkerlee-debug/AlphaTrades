/**
 * Single-Leg Option P&L Simulator
 *
 * Models naked long calls/puts for cash account backtesting.
 * Complements spread-pnl.js with a simpler, single-leg payoff structure:
 *   - Defined max loss (premium paid)
 *   - Uncapped upside
 *   - Simplified delta + theta decay model
 *   - ATR-based premium estimation when market data unavailable
 *
 * Suitable for 0DTE and 1DTE ATM options where the trade thesis is
 * a directional move in the underlying over a short time window.
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
 * Higher-ATR stocks have more expensive options; this captures that relationship.
 *
 * @param {number} atr - ATR as decimal (e.g., 0.025 for 2.5%)
 * @param {number} entryPrice - underlying price at entry
 * @returns {number} estimated premium per share
 */
function estimatePremium(atr, entryPrice) {
  // atr * entryPrice gives the dollar ATR (expected daily range).
  // Multiply by 0.4 to approximate ATM option price: options price in
  // roughly 40% of the expected move for near-expiry ATM contracts.
  return atr * entryPrice * 0.4;
}

// ── Simplified Delta Model ───────────────────────────────────────────────────

/**
 * Approximate delta for an ATM option as it moves ITM or OTM.
 * ATM starts at 0.50. Favorable moves push toward 1.0, unfavorable toward 0.
 * Uses tanh for a smooth, bounded transition.
 *
 * @param {number} favorableMove - signed dollar move in the favorable direction
 * @param {number} atrDollar - dollar ATR (atr * entryPrice)
 * @returns {number} approximate delta in [~0.0, ~1.0]
 */
function estimateDelta(favorableMove, atrDollar) {
  return 0.50 + 0.25 * Math.tanh(favorableMove / atrDollar);
}

// ── Theta Decay Model ────────────────────────────────────────────────────────

/**
 * Calculate time-decay factor for near-expiry options.
 *
 * Uses square-root decay: remaining value proportional to sqrt(remaining time).
 * This matches observed behavior where theta accelerates sharply into expiration.
 *
 * 0DTE: 390 total trading minutes, aggressive decay.
 * 1DTE+: total minutes spread across multiple days, gentler curve.
 *
 * @param {number} minutesHeld - minutes elapsed since entry
 * @param {number} holdDays - 0 for 0DTE, 1+ for multi-day
 * @param {number} totalTradingMinutes - total trading minutes for the option's life
 * @returns {number} decay factor in [0, 1], where 1 = no decay yet
 */
function timeDecayFactor(minutesHeld, holdDays, totalTradingMinutes) {
  const remaining = Math.max(0, totalTradingMinutes - minutesHeld);
  if (totalTradingMinutes <= 0) return 0;
  // sqrt decay: value erodes faster as expiration nears
  return Math.sqrt(remaining / totalTradingMinutes);
}

// ── Option Value Model ───────────────────────────────────────────────────────

/**
 * Estimate the current option value given the underlying's move and time elapsed.
 *
 * Simplified model:
 *   optionValue = premium * (1 + (favorableMove / atrDollar) * 0.6) * timeDecay
 *   clamped to [0, premium * 3]
 *
 * The 0.6 sensitivity factor means a 1-ATR favorable move adds ~60% to the
 * option's value (before time decay). Capped at 3x to reflect realistic
 * single-day option gains on strong directional moves.
 *
 * @param {number} premium - entry premium per share
 * @param {number} favorableMove - signed dollar move in the favorable direction
 * @param {number} atrDollar - dollar ATR
 * @param {number} decay - time decay factor [0, 1]
 * @returns {number} estimated option value per share
 */
function estimateOptionValue(premium, favorableMove, atrDollar, decay) {
  const rawValue = premium * (1 + (favorableMove / atrDollar) * 0.6) * decay;
  return Math.max(0, Math.min(premium * 3, rawValue));
}

// ── Single-Leg Simulator ─────────────────────────────────────────────────────

/**
 * Simulate a single-leg (naked long) option trade.
 *
 * Models buying an ATM call or put and holding through one of four exit
 * conditions: underlying stop, underlying target, time limit, or end of data.
 *
 * @param {Object} signal - { direction, entryPrice, atr, time }
 *   direction: 'CALL' or 'PUT'
 *   entryPrice: underlying price at entry
 *   atr: ATR as decimal (e.g., 0.025)
 *   time: ISO timestamp string of entry
 *
 * @param {Array} bars - minute bars from entry forward: [{ t, o, h, l, c, v }]
 *
 * @param {Object} params - configuration:
 *   premium: option premium per share (null to auto-estimate)
 *   stopCondition: { value: N } where N = ATR multiples for stop
 *   targetCondition: { value: N } where N = ATR multiples for target
 *   maxHoldMinutes: max minutes to hold (intraday)
 *   holdDays: 0 for 0DTE, 1+ for multi-day
 *   accountSize: total account in dollars
 *   sizePct: fraction of account allocated to this trade
 *   oiEstimate: estimated open interest for slippage calc
 *
 * @returns {Object} trade result (see return format below)
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

  const direction = signal.direction;             // 'CALL' or 'PUT'
  const entryPrice = signal.entryPrice;
  const atr = signal.atr || 0.025;
  const atrDollar = atr * entryPrice;
  const mult = direction === 'CALL' ? 1 : -1;    // +1 for calls, -1 for puts

  // ── Premium ────────────────────────────────────────────────────────────────
  const premium = premiumParam != null ? premiumParam : estimatePremium(atr, entryPrice);

  // ── Time parameters ────────────────────────────────────────────────────────
  // 0DTE: 390 min in one trading day. 1DTE+: spans multiple sessions.
  const totalTradingMinutes = holdDays === 0 ? 390 : (holdDays + 1) * 390;

  // ── Stop and target on the underlying ──────────────────────────────────────
  // Support both absolute PRICE stops and ATR-multiple stops.
  // Live adapter passes { type: 'PRICE', value: dollarPrice }.
  // Legacy strategies pass { value: atrMultiple } or omit type.
  let stopPrice, targetPrice;
  if (stopCondition?.type === 'PRICE' && stopCondition.value > 0) {
    stopPrice = stopCondition.value;
  } else {
    const stopATR = stopCondition?.value || 0.5;
    stopPrice = entryPrice - (stopATR * atrDollar * mult);
  }
  if (targetCondition?.type === 'PRICE' && targetCondition.value > 0) {
    targetPrice = targetCondition.value;
  } else {
    const targetATR = targetCondition?.value || 1.0;
    targetPrice = entryPrice + (targetATR * atrDollar * mult);
  }

  // ── Position sizing ────────────────────────────────────────────────────────
  // Max risk per contract = premium * 100 (can't lose more than you paid)
  const allocation = accountSize * sizePct;
  const contracts = contractCount(allocation, premium); // premium is per-share risk

  // ── Execution costs ────────────────────────────────────────────────────────
  // Single leg: 1 leg (not 2). Slippage halved vs spread (only 1 leg of slippage).
  const commissions = estimateCommissions(1, contracts);
  const rawSlippage = estimateSlippage(oiEstimate);
  const slippage = (rawSlippage / 2) * contracts; // half the spread slippage, scaled by contracts
  const totalCosts = parseFloat((commissions + slippage).toFixed(2));

  // ── Parse entry time ───────────────────────────────────────────────────────
  const entryTime = new Date(
    signal.time.length <= 16 ? signal.time + ':00Z' : signal.time
  );

  // Debug: log first trade's time alignment
  if (!simulateSingleLeg._logged) {
    simulateSingleLeg._logged = true;
    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const firstBarTime = firstBar ? new Date(firstBar.t) : null;
    const firstMinHeld = firstBarTime ? Math.round((firstBarTime - entryTime) / 60000) : null;
    console.log(`[SIM-DEBUG] signal.time=${signal.time} entryTime=${entryTime.toISOString()} bars=${bars.length}`);
    console.log(`[SIM-DEBUG] firstBar.t=${firstBar?.t} firstMinHeld=${firstMinHeld} lastBar.t=${lastBar?.t}`);
    console.log(`[SIM-DEBUG] stopCond=${JSON.stringify(stopCondition)} stopPrice=${stopPrice} targetPrice=${targetPrice}`);
    console.log(`[SIM-DEBUG] entry=${entryPrice} direction=${direction} atrDollar=${atrDollar.toFixed(2)} premium=${premium.toFixed(2)} maxHold=${maxHoldMinutes}min`);
    if (firstBar) console.log(`[SIM-DEBUG] firstBar: o=${firstBar.o} h=${firstBar.h} l=${firstBar.l} c=${firstBar.c}`);
  }

  // ── Scan bars for exit conditions ──────────────────────────────────────────
  let exitType = 'EOD';
  let exitBar = bars[bars.length - 1] || null;
  let holdMinutes = 0;

  // Track MFE (max favorable excursion) and MAE (max adverse excursion)
  // as option value P&L relative to premium paid
  let mfeOptionPnl = 0;  // best per-share P&L seen
  let maeOptionPnl = 0;  // worst per-share P&L seen

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barTime = new Date(bar.t);
    const minutesHeld = Math.round((barTime - entryTime) / 60000);

    if (minutesHeld < 0) continue; // bar before entry

    // Current favorable move in the underlying
    const favorableMove = (bar.c - entryPrice) * mult;
    const decay = timeDecayFactor(minutesHeld, holdDays, totalTradingMinutes);
    const currentOptionValue = estimateOptionValue(premium, favorableMove, atrDollar, decay);
    const currentPnl = currentOptionValue - premium;

    // Track MFE/MAE
    mfeOptionPnl = Math.max(mfeOptionPnl, currentPnl);
    maeOptionPnl = Math.min(maeOptionPnl, currentPnl);

    // ── Exit: time limit ─────────────────────────────────────────────────────
    if (minutesHeld > maxHoldMinutes) {
      exitType = 'TIME';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    // ── Exit: underlying stop ────────────────────────────────────────────────
    // Check if bar's adverse extreme breached the stop price
    const hitStop = direction === 'CALL'
      ? bar.l <= stopPrice
      : bar.h >= stopPrice;

    if (hitStop) {
      exitType = 'STOP';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    // ── Exit: underlying target ──────────────────────────────────────────────
    // Check if bar's favorable extreme reached the target price
    const hitTarget = direction === 'CALL'
      ? bar.h >= targetPrice
      : bar.l <= targetPrice;

    if (hitTarget) {
      exitType = 'TARGET';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }
  }

  // ── Calculate final P&L ────────────────────────────────────────────────────

  // Determine the effective exit price on the underlying
  let effectiveExitPrice;
  if (exitType === 'STOP') {
    effectiveExitPrice = stopPrice;
  } else if (exitType === 'TARGET') {
    effectiveExitPrice = targetPrice;
  } else {
    effectiveExitPrice = exitBar?.c || entryPrice;
  }

  // Option value at exit
  const exitMinutesHeld = holdMinutes || (exitBar
    ? Math.max(0, Math.round((new Date(exitBar.t) - entryTime) / 60000))
    : 0);
  const exitDecay = timeDecayFactor(exitMinutesHeld, holdDays, totalTradingMinutes);
  const exitFavorableMove = (effectiveExitPrice - entryPrice) * mult;
  const exitOptionValue = estimateOptionValue(premium, exitFavorableMove, atrDollar, exitDecay);

  // P&L per share
  const pnlPerShare = exitOptionValue - premium;

  // Percentage return on premium paid
  const pnlPct = premium > 0 ? (pnlPerShare / premium) * 100 : 0;

  // Dollar P&L across all contracts
  const grossPnl = pnlPerShare * 100 * contracts;

  // Net P&L after costs. Max loss is capped at premium paid (can't lose more).
  const netPnl = Math.max(
    -(premium * 100 * contracts),
    grossPnl - totalCosts
  );

  // MFE/MAE as % of premium paid
  const mfePct = premium > 0 ? (mfeOptionPnl / premium) * 100 : 0;
  const maePct = premium > 0 ? (maeOptionPnl / premium) * 100 : 0;

  // Exit efficiency: how much of the best-seen P&L we captured
  const exitEfficiency = mfeOptionPnl > 0
    ? Math.min(1, pnlPerShare / mfeOptionPnl)
    : 0;

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
      maxGain:   null, // uncapped for naked long options
      strike:    entryPrice, // ATM
      entryDTE:  holdDays === 0 ? 0 : holdDays,
    },
  };
}
