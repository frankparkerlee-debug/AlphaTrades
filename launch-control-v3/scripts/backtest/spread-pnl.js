/**
 * Spread P&L Engine
 *
 * Replaces the naive 3x-leverage option multiplier with actual spread payoff mechanics.
 * Supports: debit verticals, credit verticals, iron condors.
 *
 * Key improvement over pnl-simulator.js:
 *   - Defined max loss/gain per trade (spread-capped)
 *   - Realistic slippage and commission modeling
 *   - Delta-based mark-to-market at each bar
 *   - Multi-day hold support for B1/B2 strategies
 */

import {
  estimateSlippage,
  estimateCommissions,
  estimateFillProbability,
  contractCount,
  getSpreadWidth,
  allInCost,
} from './execution-model.js';
import { simulateSingleLeg } from './single-leg-pnl.js';

// ── Simplified Greeks Approximation ────────────────────────────────────────────
// We don't have live Greeks for historical bars. Use a simplified model:
//   - Delta from ATM proximity (0.5 at ATM, decreasing OTM)
//   - Theta as fixed daily decay scaled by DTE
//   - No vega modeling (spread partially offsets vega anyway)

function estimateDelta(underlyingPrice, strike, isCall) {
  const moneyness = (underlyingPrice - strike) / underlyingPrice;
  // Simplified delta: sigmoid around ATM
  if (isCall) {
    return 0.5 + 0.5 * Math.tanh(moneyness * 20);
  } else {
    return -0.5 + 0.5 * Math.tanh(moneyness * 20);
  }
}

/**
 * Estimate spread value at a given underlying price using a sigmoid model.
 *
 * The old intrinsic+extrinsic model (maxExtrinsic = 15% of width) valued ATM
 * spreads at $1.50 when we paid $4.50 — triggering SPREAD_STOP on the first bar.
 *
 * This sigmoid model is calibrated so that:
 *   - ATM entry value ≈ 45% of width (matches typical debit paid)
 *   - Net delta ≈ 0.25 at ATM (realistic for vertical spreads)
 *   - Deep OTM → 0, deep ITM → width
 *   - Theta decay: blends toward expiration payoff as DTE decreases
 *
 * @param {number} underlyingPrice - current underlying price
 * @param {number} longStrike - long leg strike
 * @param {number} shortStrike - short leg strike
 * @param {string} spreadType - 'DEBIT_CALL', 'DEBIT_PUT', 'CREDIT_CALL', 'CREDIT_PUT'
 * @param {number} dte - days to expiration remaining
 * @param {number} entryDTE - original DTE at entry
 * @returns {number} spread value per share (multiply by 100 for per-contract)
 */
function spreadIntrinsicValue(underlyingPrice, longStrike, shortStrike, spreadType, dte, entryDTE) {
  const width = Math.abs(shortStrike - longStrike);

  // Normalized position: 0 = at long strike (ATM at entry), 1 = at short strike
  let normalizedPos;
  if (spreadType === 'DEBIT_CALL' || spreadType === 'CREDIT_CALL') {
    const lowerStrike = Math.min(longStrike, shortStrike);
    normalizedPos = (underlyingPrice - lowerStrike) / width;
  } else {
    const upperStrike = Math.max(longStrike, shortStrike);
    normalizedPos = (upperStrike - underlyingPrice) / width;
  }

  // At-expiration payoff (hockey stick)
  const expirationValue = width * Math.max(0, Math.min(1, normalizedPos));

  // Pre-expiration "live" value: sigmoid centered at 0.2
  // Calibrated: sigmoid(0) = 0.45 → ATM spread worth 45% of width at entry
  // Net delta at ATM = k * 0.45 * 0.55 = 0.248 (realistic for ATM vertical spread)
  const k = 1.0;      // steepness — gives net delta ~0.25 at ATM
  const center = 0.2;  // sigmoid center — calibrated so sigmoid(0) = 0.45
  const smoothValue = width / (1 + Math.exp(-k * (normalizedPos - center)));

  // Time blend: transition from smooth (live) value to expiration payoff as DTE decays
  // At entry (full DTE): 100% live value
  // Near expiration: approaches hockey-stick payoff
  const timeRatio = entryDTE > 0 ? Math.max(0, dte) / entryDTE : 0;
  const expirationWeight = Math.pow(1 - timeRatio, 1.5);

  const value = smoothValue * (1 - expirationWeight) + expirationValue * expirationWeight;

  return Math.max(0, Math.min(width, value));
}

// ── Debit Vertical Spread Simulator ────────────────────────────────────────────

/**
 * Simulate a debit vertical spread (bull call or bear put).
 *
 * @param {Object} signal - strategy signal object
 * @param {Array} bars - minute bars from entry forward (intraday or multi-day)
 * @param {Object} params - { spreadWidth, entryDebit, stopCondition, targetCondition, maxHoldMinutes, holdDays, accountSize, grade, oiEstimate }
 * @returns {Object} - { exitType, pnlPct, pnlDollars, holdMinutes, commissions, slippage, spreadDetails }
 */
export function simulateDebitSpread(signal, bars, params) {
  const {
    spreadWidth,
    entryDebit = spreadWidth * 0.45, // default: pay 45% of width
    stopCondition,
    targetCondition,
    maxHoldMinutes = 45,
    holdDays = 0,
    accountSize = 7500,
    grade = 'B+',
    oiEstimate = 200,
  } = params;

  const direction = signal.direction;
  const entryPrice = signal.entryPrice;
  const atr = signal.atr || 0.025;
  const atrDollar = atr * entryPrice;
  const mult = direction === 'CALL' ? 1 : -1;

  // Spread strikes
  const longStrike = entryPrice; // ATM
  const shortStrike = entryPrice + (spreadWidth * mult); // OTM
  const spreadType = direction === 'CALL' ? 'DEBIT_CALL' : 'DEBIT_PUT';

  // Entry cost per share (debit paid)
  const debitPerShare = entryDebit;

  // Max outcomes per share
  const maxLoss = debitPerShare;              // lose the entire debit
  const maxGain = spreadWidth - debitPerShare; // width minus what you paid

  // Position sizing
  const sizePct = params.sizePct || 0.10;
  const allocation = accountSize * sizePct;
  const riskPerContract = maxLoss; // already in per-share terms
  const contracts = contractCount(allocation, riskPerContract);

  // Execution costs
  const costs = allInCost(2, contracts, oiEstimate);

  // Determine DTE (1 for intraday, more for multi-day)
  const entryDTE = holdDays > 0 ? Math.max(holdDays + 1, 2) : 1;

  // Stop and target prices on the underlying
  const stopATR = stopCondition?.value || 0.5;
  const targetATR = targetCondition?.value || 1.0;
  const stopPrice = entryPrice - (stopATR * atrDollar * mult);
  const targetPrice = entryPrice + (targetATR * atrDollar * mult);

  // P&L thresholds on the spread value
  const stopLossThreshold = debitPerShare * 0.50;    // close if spread loses 50% of debit (was 70% — too deep)
  const profitTarget = debitPerShare + (maxGain * 0.25); // take profit at 25% of max gain (was 65% — unreachable intraday)

  // Scan bars — track MFE/MAE as spread value excursions (not underlying price)
  let exitType = 'EOD';
  let exitBar = bars[bars.length - 1] || null;
  let holdMinutes = 0;
  let mfeSpreadPnl = 0;  // best spread P&L per share (favorable)
  let maeSpreadPnl = 0;  // worst spread P&L per share (adverse)
  const entryTime = new Date(signal.time.length <= 16 ? signal.time + ':00Z' : signal.time);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barTime = new Date(bar.t);
    const minutesHeld = Math.round((barTime - entryTime) / 60000);

    if (minutesHeld < 0) continue; // bar before entry

    // Track MFE/MAE using spread value (the metric that matters for options)
    const barDaysHeld = minutesHeld / (6.5 * 60);
    const barDTE = Math.max(0, entryDTE - barDaysHeld);
    const barSpreadValue = spreadIntrinsicValue(bar.c, longStrike, shortStrike, spreadType, barDTE, entryDTE);
    const barSpreadPnl = barSpreadValue - debitPerShare;
    mfeSpreadPnl = Math.max(mfeSpreadPnl, barSpreadPnl);
    maeSpreadPnl = Math.min(maeSpreadPnl, barSpreadPnl);

    // Check max hold time
    if (holdDays === 0 && minutesHeld > maxHoldMinutes) {
      exitType = 'TIME';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    // Estimate current DTE
    const daysHeld = minutesHeld / (6.5 * 60); // trading hours per day
    const currentDTE = Math.max(0, entryDTE - daysHeld);

    // For multi-day holds, check underlying stop/target
    // For intraday (holdDays === 0), skip — debit paid IS the defined risk,
    // and spread-value thresholds below handle exits properly.
    // Underlying stops on intraday debit spreads crystallize losses at the
    // worst moment due to high gamma near ATM.
    if (holdDays > 0) {
      const hitStop = direction === 'CALL'
        ? bar.l <= stopPrice
        : bar.h >= stopPrice;

      if (hitStop) {
        exitType = 'STOP';
        exitBar = bar;
        holdMinutes = minutesHeld;
        break;
      }

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

    // Check spread value thresholds
    const currentSpreadValue = spreadIntrinsicValue(
      bar.c, longStrike, shortStrike, spreadType, currentDTE, entryDTE
    );

    if (currentSpreadValue <= stopLossThreshold) {
      exitType = 'SPREAD_STOP';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    if (currentSpreadValue >= profitTarget) {
      exitType = 'SPREAD_TARGET';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }
  }

  // Calculate final P&L
  const exitPrice = exitBar?.c || entryPrice;
  const daysHeld = holdMinutes / (6.5 * 60);
  const exitDTE = Math.max(0, entryDTE - daysHeld);

  let exitSpreadValue;
  if (exitType === 'STOP' || exitType === 'SPREAD_STOP') {
    // On stop: spread is worth close to nothing (adverse move)
    exitSpreadValue = spreadIntrinsicValue(
      exitType === 'STOP' ? stopPrice : exitBar.c,
      longStrike, shortStrike, spreadType, exitDTE, entryDTE
    );
  } else if (exitType === 'TARGET' || exitType === 'SPREAD_TARGET') {
    // On target: spread approaches max value
    exitSpreadValue = spreadIntrinsicValue(
      exitType === 'TARGET' ? targetPrice : exitBar.c,
      longStrike, shortStrike, spreadType, exitDTE, entryDTE
    );
  } else {
    // EOD/TIME: value at whatever the spread is worth now
    exitSpreadValue = spreadIntrinsicValue(
      exitPrice, longStrike, shortStrike, spreadType, exitDTE, entryDTE
    );
  }

  // P&L per share = exit value - entry debit
  const pnlPerShare = exitSpreadValue - debitPerShare;
  const pnlPerContract = pnlPerShare * 100;  // 100 shares per contract
  const grossPnl = pnlPerContract * contracts;
  const netPnl = grossPnl - costs.totalCost;
  const pnlPct = debitPerShare > 0 ? (pnlPerShare / debitPerShare) * 100 : 0;

  // MFE/MAE as % of debit paid (same scale as pnlPct)
  const mfePctCalc = debitPerShare > 0 ? (mfeSpreadPnl / debitPerShare) * 100 : 0;
  const maePctCalc = debitPerShare > 0 ? (maeSpreadPnl / debitPerShare) * 100 : 0;

  return {
    exitType,
    exitPrice,
    exitTime: exitBar?.t || signal.time,
    pnlPct:     parseFloat(pnlPct.toFixed(2)),
    pnlDollars: Math.round(netPnl),
    holdMinutes: Math.max(0, holdMinutes),
    contracts,
    commissions: costs.commissions,
    slippage:    costs.slippage,
    totalCosts:  costs.totalCost,
    grossPnl:    Math.round(grossPnl),
    // MFE/MAE as % of debit paid (comparable to pnlPct)
    mfePct: parseFloat(mfePctCalc.toFixed(2)),
    maePct: parseFloat(maePctCalc.toFixed(2)),
    exitEfficiency: mfeSpreadPnl > 0
      ? parseFloat(Math.min(1, pnlPerShare / mfeSpreadPnl).toFixed(3))
      : 0,
    spreadDetails: {
      type: spreadType,
      width: spreadWidth,
      debit: debitPerShare,
      maxLoss: Math.round(-maxLoss * 100 * contracts),
      maxGain: Math.round(maxGain * 100 * contracts),
      longStrike,
      shortStrike,
      entryDTE,
    },
  };
}

// ── Credit Vertical Spread Simulator ───────────────────────────────────────────

/**
 * Simulate a credit vertical spread (sell OTM spread).
 *
 * @param {Object} signal - strategy signal object
 * @param {Array} bars - minute bars from entry forward
 * @param {Object} params - { spreadWidth, entryCredit, stopCondition, targetCondition, maxHoldMinutes, holdDays, accountSize, oiEstimate }
 * @returns {Object} - exit result
 */
export function simulateCreditSpread(signal, bars, params) {
  const {
    spreadWidth,
    entryCredit = spreadWidth * 0.33, // default: collect 33% of width
    stopCondition,
    targetCondition,
    maxHoldMinutes = 30,
    holdDays = 0,
    accountSize = 7500,
    oiEstimate = 200,
  } = params;

  const direction = signal.direction;
  const entryPrice = signal.entryPrice;
  const atr = signal.atr || 0.025;
  const atrDollar = atr * entryPrice;

  // For credit spreads, we sell in the DIRECTION of the overextension
  // If stock is overextended UP (signal direction = 'PUT' for reversal), we sell call credit spread
  // If stock is overextended DOWN (signal direction = 'CALL' for reversal), we sell put credit spread
  const sellingCalls = direction === 'PUT';   // reversal trade: selling calls above
  const spreadType = sellingCalls ? 'CREDIT_CALL' : 'CREDIT_PUT';

  // Strikes: sell near ATM, buy further OTM for protection
  const shortStrike = sellingCalls
    ? entryPrice + (atrDollar * 0.5)   // sell call above current price
    : entryPrice - (atrDollar * 0.5);  // sell put below current price
  const longStrike = sellingCalls
    ? shortStrike + spreadWidth
    : shortStrike - spreadWidth;

  // Credit received per share
  const creditPerShare = entryCredit;

  // Max outcomes per share
  const maxGain = creditPerShare;                   // keep the full credit
  const maxLoss = spreadWidth - creditPerShare;     // width minus credit

  // Position sizing
  const sizePct = params.sizePct || 0.10;
  const allocation = accountSize * sizePct;
  const riskPerContract = maxLoss;
  const contracts = contractCount(allocation, riskPerContract);

  // Execution costs
  const costs = allInCost(2, contracts, oiEstimate);

  const entryDTE = holdDays > 0 ? Math.max(holdDays + 1, 2) : 1;

  // Stop: close if losing 2x the credit received
  const stopLossAmount = creditPerShare * 2;
  // Target: close at 50% of max profit (credit received)
  const profitTargetAmount = creditPerShare * 0.50;

  // Underlying stop/target
  const stopATR = stopCondition?.value || 0.5;
  const stopPriceUnderlying = sellingCalls
    ? entryPrice + (stopATR * atrDollar)   // stock keeps going up past short call
    : entryPrice - (stopATR * atrDollar);  // stock keeps dropping past short put

  let exitType = 'EOD';
  let exitBar = bars[bars.length - 1] || null;
  let holdMinutes = 0;
  let bestPnl = 0;   // MFE for credit spread (best P&L reached)
  let worstPnl = 0;  // MAE for credit spread (worst P&L reached)
  const entryTime = new Date(signal.time.length <= 16 ? signal.time + ':00Z' : signal.time);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barTime = new Date(bar.t);
    const minutesHeld = Math.round((barTime - entryTime) / 60000);

    if (minutesHeld < 0) continue;

    if (holdDays === 0 && minutesHeld > maxHoldMinutes) {
      exitType = 'TIME';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    const daysHeld = minutesHeld / (6.5 * 60);
    const currentDTE = Math.max(0, entryDTE - daysHeld);

    // Underlying stop: only for multi-day holds
    // Intraday credit spreads rely on spread-value P&L thresholds
    if (holdDays > 0) {
      const hitStop = sellingCalls
        ? bar.h >= stopPriceUnderlying
        : bar.l <= stopPriceUnderlying;

      if (hitStop) {
        exitType = 'STOP';
        exitBar = bar;
        holdMinutes = minutesHeld;
        break;
      }
    }

    // Check spread value for P&L thresholds
    const currentCostToClose = spreadIntrinsicValue(
      bar.c, longStrike, shortStrike,
      sellingCalls ? 'DEBIT_CALL' : 'DEBIT_PUT', // cost to close is inverse
      currentDTE, entryDTE
    );

    // Current P&L = credit received - cost to close
    const currentPnl = creditPerShare - currentCostToClose;

    // Track MFE/MAE
    bestPnl = Math.max(bestPnl, currentPnl);
    worstPnl = Math.min(worstPnl, currentPnl);

    if (currentPnl <= -stopLossAmount) {
      exitType = 'SPREAD_STOP';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    // Target: we've captured enough profit, close early
    if (currentPnl >= profitTargetAmount) {
      exitType = 'SPREAD_TARGET';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }
  }

  // Calculate final P&L
  const exitPrice = exitBar?.c || entryPrice;
  const daysHeld = holdMinutes / (6.5 * 60);
  const exitDTE = Math.max(0, entryDTE - daysHeld);

  const exitCostToClose = spreadIntrinsicValue(
    exitPrice,
    longStrike, shortStrike,
    sellingCalls ? 'DEBIT_CALL' : 'DEBIT_PUT',
    exitDTE, entryDTE
  );

  const pnlPerShare = creditPerShare - exitCostToClose;
  const pnlPerContract = pnlPerShare * 100;
  const grossPnl = pnlPerContract * contracts;
  const netPnl = grossPnl - costs.totalCost;
  const pnlPct = maxLoss > 0 ? (pnlPerShare / maxLoss) * 100 : 0;

  return {
    exitType,
    exitPrice,
    exitTime: exitBar?.t || signal.time,
    pnlPct:     parseFloat(pnlPct.toFixed(2)),
    pnlDollars: Math.round(netPnl),
    holdMinutes: Math.max(0, holdMinutes),
    contracts,
    commissions: costs.commissions,
    slippage:    costs.slippage,
    totalCosts:  costs.totalCost,
    grossPnl:    Math.round(grossPnl),
    mfePct: maxLoss > 0 ? parseFloat((bestPnl / maxLoss * 100).toFixed(2)) : 0,
    maePct: maxLoss > 0 ? parseFloat((worstPnl / maxLoss * 100).toFixed(2)) : 0,
    exitEfficiency: bestPnl > 0 ? parseFloat(Math.min(1, pnlPerShare / bestPnl).toFixed(3)) : 0,
    spreadDetails: {
      type: spreadType,
      width: spreadWidth,
      credit: creditPerShare,
      maxLoss: Math.round(-maxLoss * 100 * contracts),
      maxGain: Math.round(maxGain * 100 * contracts),
      shortStrike,
      longStrike,
      entryDTE,
    },
  };
}

// ── Iron Condor Simulator ──────────────────────────────────────────────────────

/**
 * Simulate an iron condor (sell OTM call spread + OTM put spread).
 * Used by B1: IV Rank Premium Harvest.
 */
export function simulateIronCondor(signal, bars, params) {
  const {
    spreadWidth,
    entryCredit = spreadWidth * 0.30,  // total credit from both sides
    maxHoldMinutes = 0,  // ignored for multi-day
    holdDays = 5,
    accountSize = 7500,
    oiEstimate = 200,
    wingDistance = 1.5,  // ATR distance to short strikes
  } = params;

  const entryPrice = signal.entryPrice;
  const atr = signal.atr || 0.025;
  const atrDollar = atr * entryPrice;

  // Short strikes at wingDistance ATR from current price
  const shortCallStrike = entryPrice + (wingDistance * atrDollar);
  const shortPutStrike  = entryPrice - (wingDistance * atrDollar);
  const longCallStrike  = shortCallStrike + spreadWidth;
  const longPutStrike   = shortPutStrike - spreadWidth;

  const creditPerShare = entryCredit;
  const maxGain = creditPerShare;
  const maxLoss = spreadWidth - creditPerShare;

  const sizePct = params.sizePct || 0.10;
  const allocation = accountSize * sizePct;
  const riskPerContract = maxLoss;
  const contracts = contractCount(allocation, riskPerContract);

  // 4 legs for iron condor
  const costs = allInCost(4, contracts, oiEstimate);

  const entryDTE = Math.max(holdDays + 1, 3);
  const stopLossAmount = creditPerShare * 2;
  const profitTargetAmount = creditPerShare * 0.50;

  let exitType = 'EXPIRY';
  let exitBar = bars[bars.length - 1] || null;
  let holdMinutes = 0;
  let bestPnl = 0;
  let worstPnl = 0;
  const entryTime = new Date(signal.time.length <= 16 ? signal.time + ':00Z' : signal.time);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barTime = new Date(bar.t);
    const minutesHeld = Math.round((barTime - entryTime) / 60000);

    if (minutesHeld < 0) continue;

    // Max hold in trading minutes (holdDays * 6.5 hours)
    const maxMinutes = holdDays * 6.5 * 60;
    if (minutesHeld > maxMinutes) {
      exitType = 'EXPIRY';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    const daysHeld = minutesHeld / (6.5 * 60);
    const currentDTE = Math.max(0, entryDTE - daysHeld);

    // Cost to close each side
    const callSideCost = spreadIntrinsicValue(
      bar.c, longCallStrike, shortCallStrike, 'DEBIT_CALL', currentDTE, entryDTE
    );
    const putSideCost = spreadIntrinsicValue(
      bar.c, longPutStrike, shortPutStrike, 'DEBIT_PUT', currentDTE, entryDTE
    );
    const totalCostToClose = callSideCost + putSideCost;
    const currentPnl = creditPerShare - totalCostToClose;

    bestPnl = Math.max(bestPnl, currentPnl);
    worstPnl = Math.min(worstPnl, currentPnl);

    if (currentPnl <= -stopLossAmount) {
      exitType = 'STOP';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }

    if (currentPnl >= profitTargetAmount) {
      exitType = 'TARGET';
      exitBar = bar;
      holdMinutes = minutesHeld;
      break;
    }
  }

  // Final P&L
  const exitPrice = exitBar?.c || entryPrice;
  const daysHeld = holdMinutes / (6.5 * 60);
  const exitDTE = Math.max(0, entryDTE - daysHeld);

  const finalCallCost = spreadIntrinsicValue(
    exitPrice, longCallStrike, shortCallStrike, 'DEBIT_CALL', exitDTE, entryDTE
  );
  const finalPutCost = spreadIntrinsicValue(
    exitPrice, longPutStrike, shortPutStrike, 'DEBIT_PUT', exitDTE, entryDTE
  );
  const pnlPerShare = creditPerShare - (finalCallCost + finalPutCost);
  const pnlPerContract = pnlPerShare * 100;
  const grossPnl = pnlPerContract * contracts;
  const netPnl = grossPnl - costs.totalCost;
  const pnlPct = maxLoss > 0 ? (pnlPerShare / maxLoss) * 100 : 0;

  return {
    exitType,
    exitPrice,
    exitTime: exitBar?.t || signal.time,
    pnlPct:     parseFloat(pnlPct.toFixed(2)),
    pnlDollars: Math.round(netPnl),
    holdMinutes: Math.max(0, holdMinutes),
    contracts,
    commissions: costs.commissions,
    slippage:    costs.slippage,
    totalCosts:  costs.totalCost,
    grossPnl:    Math.round(grossPnl),
    mfePct: maxLoss > 0 ? parseFloat((bestPnl / maxLoss * 100).toFixed(2)) : 0,
    maePct: maxLoss > 0 ? parseFloat((worstPnl / maxLoss * 100).toFixed(2)) : 0,
    exitEfficiency: bestPnl > 0 ? parseFloat(Math.min(1, pnlPerShare / bestPnl).toFixed(3)) : 0,
    spreadDetails: {
      type: 'IRON_CONDOR',
      width: spreadWidth,
      credit: creditPerShare,
      maxLoss: Math.round(-maxLoss * 100 * contracts),
      maxGain: Math.round(maxGain * 100 * contracts),
      shortCallStrike,
      longCallStrike,
      shortPutStrike,
      longPutStrike,
      entryDTE,
    },
  };
}

// ── Batch Simulator ────────────────────────────────────────────────────────────

/**
 * Simulate P&L for an array of strategy signals.
 * Routes each signal to the appropriate spread simulator based on spreadType.
 *
 * @param {Array} signals - array of strategy signals with spreadType field
 * @param {Object} rawMinuteBars - { ticker: [bars] } indexed arrays
 * @param {Object} opts - { accountSize }
 * @returns {Array} - results with P&L and spread details
 */
export function simulateAllSpreads(signals, rawMinuteBars, opts = {}) {
  const results = [];
  const accountSize = opts.accountSize || 7500;

  for (const signal of signals) {
    const tickerBars = rawMinuteBars[signal.ticker] || [];

    // Get bars after signal time — normalize time to valid ISO
    const rawTime = signal.time.length <= 16 ? signal.time + ':00Z' : signal.time;
    const signalTimeMs = new Date(rawTime).getTime();
    const signalDate = signal.date;

    let remaining;
    if (signal.holdDays > 0) {
      // Multi-day: get all bars from signal time forward for N days
      const signalDateObj = new Date(signalDate);
      const endDateObj = new Date(signalDateObj);
      endDateObj.setDate(endDateObj.getDate() + signal.holdDays + 1);
      const endDateStr = endDateObj.toISOString().split('T')[0];

      remaining = tickerBars.filter(b => {
        const bt = new Date(b.t).getTime();
        const bd = new Date(b.t).toISOString().split('T')[0];
        return bt > signalTimeMs && bd <= endDateStr;
      }).sort((a, b) => new Date(a.t) - new Date(b.t));
    } else {
      // Intraday: same day only
      remaining = tickerBars.filter(b => {
        const bt = new Date(b.t).getTime();
        const bd = new Date(b.t).toISOString().split('T')[0];
        return bd === signalDate && bt > signalTimeMs;
      }).sort((a, b) => new Date(a.t) - new Date(b.t));
    }

    // Skip if no fill probability
    const fillProb = estimateFillProbability(signal.oiEstimate || 200);
    if (Math.random() > fillProb) {
      continue; // simulated no-fill
    }

    let result;
    const params = {
      spreadWidth:     signal.spreadWidth,
      entryDebit:      signal.entryDebit,
      entryCredit:     signal.entryCredit,
      stopCondition:   signal.stopCondition,
      targetCondition: signal.targetCondition,
      maxHoldMinutes:  signal.maxHoldMinutes || 45,
      holdDays:        signal.holdDays || 0,
      accountSize,
      sizePct:         signal.sizePct || 0.10,
      oiEstimate:      signal.oiEstimate || 200,
      wingDistance:     signal.wingDistance,
    };

    switch (signal.spreadType) {
      case 'DEBIT_VERTICAL':
        result = simulateDebitSpread(signal, remaining, params);
        break;
      case 'CREDIT_VERTICAL':
        result = simulateCreditSpread(signal, remaining, params);
        break;
      case 'IRON_CONDOR':
        result = simulateIronCondor(signal, remaining, params);
        break;
      case 'SINGLE_LEG':
        params.premium = signal.premium || null;
        params.exitOverrides = signal.exitOverrides || null;
        result = simulateSingleLeg(signal, remaining, params);
        break;
      default:
        result = simulateDebitSpread(signal, remaining, params);
    }

    results.push({
      ...signal,
      ...result,
    });
  }

  return results;
}
