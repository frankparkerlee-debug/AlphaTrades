/**
 * P&L Simulator
 * Simulates option P&L from underlying price movement using ATR-based targets.
 * Uses the same target multipliers as contract-selector.js.
 */

// Target multipliers per grade (from contract-selector.js TARGETS)
// These represent premium return multipliers, mapped to underlying ATR moves
const TARGETS = {
  'A+': { t1: 1.50, t2: 2.00, t3: 3.00 },
  'A':  { t1: 1.40, t2: 1.90, t3: 2.60 },
  'A-': { t1: 1.35, t2: 1.75, t3: 2.20 },
  'B+': { t1: 1.30, t2: 1.60, t3: null },
  'B':  { t1: 1.25, t2: null, t3: null },
};
const STOP_MULT = 0.60; // -40% of premium

// ATR thresholds for underlying moves → option outcomes
const ATR_TARGETS = {
  t1: 1.0,  // 1 ATR move → T1 hit
  t2: 1.5,  // 1.5 ATR → T2
  t3: 2.0,  // 2 ATR → T3
  stop: -0.5, // 0.5 ATR against → stop
};

/**
 * Simulate P&L for a single signal by scanning forward through remaining bars.
 *
 * @param {Object} signal - { ticker, direction, entryPrice, atr, grade, sizeDollars, time }
 * @param {Array} remainingBars - minute bars from signal time to EOD, sorted chronologically
 * @returns {Object} - { exitType, exitPrice, exitTime, pnlPct, pnlDollars, holdMinutes }
 */
export function simulateSignal(signal, remainingBars) {
  const { direction, entryPrice, atr, grade, sizeDollars } = signal;
  const targets = TARGETS[grade] || TARGETS['B'];
  const mult = direction === 'CALL' ? 1 : -1;

  // Underlying price targets
  const atrDollar = atr * entryPrice; // ATR in dollar terms
  const t1Price   = entryPrice + (ATR_TARGETS.t1 * atrDollar * mult);
  const t2Price   = targets.t2 ? entryPrice + (ATR_TARGETS.t2 * atrDollar * mult) : null;
  const t3Price   = targets.t3 ? entryPrice + (ATR_TARGETS.t3 * atrDollar * mult) : null;
  const stopPrice = entryPrice + (ATR_TARGETS.stop * atrDollar * mult);

  // Track partial exits (split into thirds)
  const portions = [
    { target: 't1', price: t1Price,   mult: targets.t1,   filled: false },
    { target: 't2', price: t2Price,   mult: targets.t2,   filled: false },
    { target: 't3', price: t3Price,   mult: targets.t3,   filled: false },
  ].filter(p => p.price !== null && p.mult !== null);

  // Ensure we have at least one target
  if (portions.length === 0) {
    portions.push({ target: 't1', price: t1Price, mult: targets.t1, filled: false });
  }

  let stopped = false;
  let stopTime = null;
  let stopBarPrice = null;
  const exits = [];

  for (const bar of remainingBars) {
    const barHigh = bar.h;
    const barLow  = bar.l;

    // Check stop first (conservative)
    const hitStop = direction === 'CALL'
      ? barLow <= stopPrice
      : barHigh >= stopPrice;

    if (hitStop && !stopped) {
      stopped = true;
      stopTime = bar.t;
      stopBarPrice = bar.c;

      // All unfilled portions get stopped
      for (const p of portions) {
        if (!p.filled) {
          p.filled = true;
          exits.push({
            target: 'STOP',
            mult: STOP_MULT,
            time: bar.t,
            price: stopPrice,
          });
        }
      }
      break; // Stop exits everything
    }

    // Check targets (in order: T1, T2, T3)
    for (const p of portions) {
      if (p.filled) continue;

      const hitTarget = direction === 'CALL'
        ? barHigh >= p.price
        : barLow <= p.price;

      if (hitTarget) {
        p.filled = true;
        exits.push({
          target: p.target.toUpperCase(),
          mult: p.mult,
          time: bar.t,
          price: p.price,
        });
      }
    }
  }

  // EOD exit for any unfilled portions
  const lastBar = remainingBars[remainingBars.length - 1];
  for (const p of portions) {
    if (!p.filled) {
      p.filled = true;
      // Estimate P&L from underlying move
      const underlyingMove = lastBar
        ? (lastBar.c - entryPrice) / entryPrice * mult
        : 0;
      const eodMult = Math.max(STOP_MULT, 1 + underlyingMove * 3); // rough option leverage
      exits.push({
        target: 'EOD',
        mult: eodMult,
        time: lastBar?.t || signal.time,
        price: lastBar?.c || entryPrice,
      });
    }
  }

  // Compute weighted P&L
  const weight = 1 / portions.length; // equal weight per portion
  let totalPnlPct = 0;
  let bestExit = 'EOD';
  let bestExitTime = exits[exits.length - 1]?.time || signal.time;

  for (const exit of exits) {
    const pnl = (exit.mult - 1); // e.g., 1.50 - 1 = +50%
    totalPnlPct += pnl * weight;

    // Track the "best" exit type for classification
    if (exit.target === 'STOP') bestExit = 'STOP';
    else if (exit.target !== 'EOD' && bestExit !== 'STOP') {
      if (exit.target === 'T3' || (exit.target === 'T2' && bestExit !== 'T3') || (exit.target === 'T1' && bestExit === 'EOD')) {
        bestExit = exit.target;
      }
    }
  }

  const pnlDollars = Math.round(sizeDollars * totalPnlPct);
  const holdMinutes = lastBar
    ? Math.round((new Date(bestExitTime) - new Date(signal.time + ':00Z')) / 60000)
    : 0;

  return {
    exitType:    bestExit,
    exitPrice:   exits[exits.length - 1]?.price || entryPrice,
    exitTime:    bestExitTime,
    pnlPct:      parseFloat((totalPnlPct * 100).toFixed(2)),
    pnlDollars,
    holdMinutes: Math.max(0, holdMinutes),
    exits,       // detailed exit breakdown
    targets: { t1: t1Price, t2: t2Price, t3: t3Price, stop: stopPrice },
  };
}

/**
 * Run P&L simulation for all signals.
 * Needs raw minute bar arrays (not indexed) to scan forward from signal time.
 */
export function simulateAll(signals, rawMinuteBars) {
  const results = [];

  for (const signal of signals) {
    const tickerBars = rawMinuteBars[signal.ticker] || [];

    // Find bars after signal time on the same day
    const signalTime = signal.time + ':00Z';
    const signalDate = signal.date;

    const remaining = tickerBars.filter(b => {
      const bt = new Date(b.t);
      const bd = bt.toISOString().split('T')[0];
      return bd === signalDate && b.t > signalTime;
    }).sort((a, b) => new Date(a.t) - new Date(b.t));

    const result = simulateSignal(signal, remaining);

    results.push({
      ...signal,
      ...result,
    });
  }

  return results;
}
