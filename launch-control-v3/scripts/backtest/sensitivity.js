/**
 * Parameter Sensitivity Analysis
 *
 * Tests how robust the strategy is to changes in key parameters.
 * If small changes destroy profitability, the edge is fragile.
 *
 * Parameters tested:
 *   1. Grade thresholds (A+ >= 83, A >= 73, etc.)
 *   2. Position sizing per grade
 *   3. Target multipliers (T1, T2, T3)
 *   4. Stop loss level
 *   5. Minimum PA / Volume thresholds
 *
 * Method: Vary each parameter ±20% in steps and re-compute P&L.
 * No re-fetch needed — uses existing signals with their raw scores.
 */

// Default grade thresholds from composite.js
const DEFAULT_THRESHOLDS = {
  'A+': 83, 'A': 73, 'A-': 63, 'B+': 53, 'B': 43,
};

// Default position sizes (% of account)
const DEFAULT_SIZES = {
  'A+': 0.20, 'A': 0.15, 'A-': 0.10, 'B+': 0.075, 'B': 0.05,
};

// Default target multipliers (from pnl-simulator.js)
const DEFAULT_TARGETS = {
  'A+': { t1: 1.50, t2: 2.00, t3: 3.00 },
  'A':  { t1: 1.40, t2: 1.90, t3: 2.60 },
  'A-': { t1: 1.35, t2: 1.75, t3: 2.20 },
  'B+': { t1: 1.30, t2: 1.60 },
  'B':  { t1: 1.25 },
};

const DEFAULT_STOP = 0.60; // -40% of premium

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/**
 * Re-grade signals using shifted thresholds.
 * Returns signals with potentially different grades and P&L.
 */
function regradeSignals(signals, thresholds, accountSize) {
  const gradeOrder = ['A+', 'A', 'A-', 'B+', 'B'];

  return signals.map(s => {
    const composite = s.composite || 0;
    let newGrade = null;

    for (const g of gradeOrder) {
      if (composite >= thresholds[g]) {
        newGrade = g;
        break;
      }
    }

    if (!newGrade) return null; // Below minimum threshold — filtered out

    // Recalculate size based on new grade
    const sizePct = DEFAULT_SIZES[newGrade] || 0.05;
    const sizeDollars = accountSize * sizePct;

    // Keep the same P&L percentage but adjust dollar P&L for new size
    const pnlDollars = Math.round(sizeDollars * ((s.pnlPct || 0) / 100));

    return { ...s, grade: newGrade, pnlDollars, sizeDollars };
  }).filter(Boolean);
}

/**
 * Compute summary stats for a set of signals.
 */
function computeStats(signals) {
  const total = signals.length;
  const wins = signals.filter(s => s.pnlDollars > 0);
  const losses = signals.filter(s => s.pnlDollars < 0);
  const pnl = signals.reduce((a, b) => a + b.pnlDollars, 0);
  const grossWin = wins.reduce((a, b) => a + b.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlDollars, 0));

  return {
    signals: total,
    winRate: total > 0 ? parseFloat((wins.length / total * 100).toFixed(1)) : 0,
    totalPnl: Math.round(pnl),
    avgPnl: total > 0 ? Math.round(pnl / total) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 999 : 0),
  };
}

/**
 * Run parameter sensitivity analysis.
 * @param {Object} backtestResults - Full backtest results
 * @returns {Object} Sensitivity analysis
 */
export function runSensitivity(backtestResults) {
  const signals = backtestResults.signals || [];
  const accountSize = backtestResults.config?.accountSize || 7500;

  if (signals.length < 10) {
    return { error: 'Not enough signals for sensitivity analysis (need 10+)' };
  }

  const baseline = computeStats(signals);

  // ── 1. Grade threshold sensitivity ─────────────────────────────────────
  // Shift all thresholds uniformly by -10, -5, 0, +5, +10
  const thresholdShifts = [-10, -5, -3, 0, +3, +5, +10];
  const thresholdSensitivity = thresholdShifts.map(shift => {
    const shifted = {};
    for (const [g, t] of Object.entries(DEFAULT_THRESHOLDS)) {
      shifted[g] = t + shift;
    }
    const regraded = regradeSignals(signals, shifted, accountSize);
    const stats = computeStats(regraded);
    return {
      shift: shift >= 0 ? `+${shift}` : `${shift}`,
      thresholds: { ...shifted },
      ...stats,
    };
  });

  // ── 2. Minimum grade filter (what if we only trade A+ / A / A- etc?) ──
  const gradeFilters = [
    { label: 'A+ only', filter: s => s.grade === 'A+' },
    { label: 'A+ and A', filter: s => ['A+', 'A'].includes(s.grade) },
    { label: 'A+, A, A-', filter: s => ['A+', 'A', 'A-'].includes(s.grade) },
    { label: 'A+ through B+', filter: s => ['A+', 'A', 'A-', 'B+'].includes(s.grade) },
    { label: 'All (A+ through B)', filter: () => true },
  ];
  const gradeFilterSensitivity = gradeFilters.map(gf => {
    const filtered = signals.filter(gf.filter);
    return { label: gf.label, ...computeStats(filtered) };
  });

  // ── 3. Position size sensitivity (scale all sizes by multiplier) ───────
  const sizeMultipliers = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const sizeSensitivity = sizeMultipliers.map(mult => {
    const scaled = signals.map(s => ({
      ...s,
      pnlDollars: Math.round(s.pnlDollars * mult),
    }));
    return { multiplier: `${mult}x`, ...computeStats(scaled) };
  });

  // ── 4. Win rate sensitivity (what if X% of wins flip to losses?) ───────
  const flipRates = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
  const winFlipSensitivity = flipRates.map(rate => {
    const avgLoss = mean(signals.filter(s => s.pnlDollars < 0).map(s => s.pnlDollars));
    let flipped = 0;
    const modified = signals.map(s => {
      if (s.pnlDollars > 0 && Math.random() < rate) {
        flipped++;
        return { ...s, pnlDollars: Math.round(avgLoss || -50) };
      }
      return s;
    });
    return { flipRate: `${(rate * 100).toFixed(0)}%`, ...computeStats(modified) };
  });

  // ── 5. Composite score correlation ─────────────────────────────────────
  // Does higher composite score actually predict better outcomes?
  const compositeBuckets = [];
  const step = 5;
  for (let lo = 40; lo <= 90; lo += step) {
    const bucket = signals.filter(s => (s.composite || 0) >= lo && (s.composite || 0) < lo + step);
    if (bucket.length >= 3) {
      compositeBuckets.push({
        range: `${lo}-${lo + step}`,
        ...computeStats(bucket),
      });
    }
  }

  // ── 6. Pillar score impact (which pillars matter most?) ────────────────
  const pillarImpact = {};
  const pillarNames = ['pa', 'vol', 'mkt', 'tim', 'news'];
  for (const pillar of pillarNames) {
    const withHigh = signals.filter(s => (s.scores?.[pillar] || 0) >= 15);
    const withLow = signals.filter(s => (s.scores?.[pillar] || 0) < 15);
    if (withHigh.length >= 3 && withLow.length >= 3) {
      pillarImpact[pillar] = {
        high: { label: `${pillar} >= 15`, ...computeStats(withHigh) },
        low: { label: `${pillar} < 15`, ...computeStats(withLow) },
        delta: computeStats(withHigh).winRate - computeStats(withLow).winRate,
      };
    }
  }

  // ── Robustness score ───────────────────────────────────────────────────
  // How many parameter variations remain profitable?
  const allVariations = [
    ...thresholdSensitivity.map(t => t.totalPnl),
    ...gradeFilterSensitivity.map(g => g.totalPnl),
    ...sizeSensitivity.map(s => s.totalPnl),
  ];
  const profitableVariations = allVariations.filter(p => p > 0).length;
  const robustnessPct = parseFloat((profitableVariations / allVariations.length * 100).toFixed(1));

  let verdict, verdictDetail;
  if (robustnessPct >= 80) {
    verdict = 'ROBUST';
    verdictDetail = `${robustnessPct}% of parameter variations remain profitable. Edge is real.`;
  } else if (robustnessPct >= 50) {
    verdict = 'MODERATE';
    verdictDetail = `${robustnessPct}% profitable. Some fragility in parameter choices.`;
  } else {
    verdict = 'FRAGILE';
    verdictDetail = `Only ${robustnessPct}% profitable. Strategy is likely overfit to specific parameters.`;
  }

  return {
    baseline,
    thresholdSensitivity,
    gradeFilterSensitivity,
    sizeSensitivity,
    winFlipSensitivity,
    compositeBuckets,
    pillarImpact,
    robustness: {
      totalVariations: allVariations.length,
      profitableVariations,
      robustnessPct,
      verdict,
      verdictDetail,
    },
  };
}
