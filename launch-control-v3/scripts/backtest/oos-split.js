/**
 * Out-of-Sample Splitter
 *
 * Enforces strict chronological 70/30 train/test split.
 * Critical rule: NEVER peek at the test set during strategy development.
 */

/**
 * Split signals into train (in-sample) and test (out-of-sample) sets.
 * Split is chronological — NOT random.
 *
 * @param {Array} signals - all backtest signals
 * @param {Array} tradingDays - sorted array of YYYY-MM-DD strings
 * @param {number} trainRatio - fraction for training (default 0.7)
 * @returns {{ train, test, splitDate, meta }}
 */
export function splitTrainTest(signals, tradingDays, trainRatio = 0.70) {
  const sorted = [...tradingDays].sort();
  if (sorted.length === 0) {
    return {
      train: { signals: [], days: [] },
      test:  { signals: [], days: [] },
      splitDate: null,
      meta: { totalDays: 0, trainDays: 0, testDays: 0, trainSignals: 0, testSignals: 0, trainRatio: 0 },
    };
  }
  const splitIdx = Math.floor(sorted.length * trainRatio);
  const splitDate = sorted[splitIdx] || sorted[sorted.length - 1];

  const trainDays = new Set(sorted.slice(0, splitIdx));
  const testDays = new Set(sorted.slice(splitIdx));

  const train = signals.filter(s => trainDays.has(s.date));
  const test  = signals.filter(s => testDays.has(s.date));

  return {
    train:     { signals: train, days: [...trainDays].sort() },
    test:      { signals: test,  days: [...testDays].sort() },
    splitDate,
    meta: {
      totalDays:    sorted.length,
      trainDays:    trainDays.size,
      testDays:     testDays.size,
      trainSignals: train.length,
      testSignals:  test.length,
      trainRatio:   parseFloat((trainDays.size / sorted.length).toFixed(2)),
    },
  };
}

/**
 * Compute metrics for a signal set.
 */
function computeMetrics(signals, accountSize) {
  const total = signals.length;
  if (total === 0) return nullMetrics();

  const wins = signals.filter(s => s.pnlDollars > 0);
  const losses = signals.filter(s => s.pnlDollars < 0);
  const totalPnl = signals.reduce((a, b) => a + b.pnlDollars, 0);
  const grossWin = wins.reduce((a, b) => a + b.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlDollars, 0));

  // Sharpe
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = 0;
    byDate[s.date] += s.pnlDollars;
  }
  const dailyPnls = Object.values(byDate);
  const avgDaily = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
  const stdDaily = Math.sqrt(dailyPnls.reduce((s, v) => s + (v - avgDaily) ** 2, 0) / dailyPnls.length);
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const date of Object.keys(byDate).sort()) {
    cumPnl += byDate[date];
    peak = Math.max(peak, cumPnl);
    maxDD = Math.min(maxDD, cumPnl - peak);
  }

  return {
    signals: total,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat((wins.length / total * 100).toFixed(1)),
    totalPnl: Math.round(totalPnl),
    totalPnlPct: accountSize > 0 ? parseFloat((totalPnl / accountSize * 100).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 999 : 0),
    sharpe: parseFloat(sharpe.toFixed(2)),
    maxDrawdown: Math.round(maxDD),
    avgPnlPerTrade: Math.round(totalPnl / total),
    avgHoldMinutes: Math.round(signals.reduce((a, b) => a + (b.holdMinutes || 0), 0) / total),
  };
}

function nullMetrics() {
  return {
    signals: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, totalPnlPct: 0, profitFactor: 0,
    sharpe: 0, maxDrawdown: 0, avgPnlPerTrade: 0, avgHoldMinutes: 0,
  };
}

/**
 * Generate side-by-side IS vs OOS comparison report.
 * Also breaks down by strategy.
 *
 * @param {Object} split - output of splitTrainTest
 * @param {number} accountSize
 * @returns {Object} - comparison report
 */
export function reportSideBySide(split, accountSize = 7500) {
  const trainMetrics = computeMetrics(split.train.signals, accountSize);
  const testMetrics  = computeMetrics(split.test.signals, accountSize);

  // Degradation ratios (test / train)
  const degradation = {
    winRate:      trainMetrics.winRate > 0 ? parseFloat((testMetrics.winRate / trainMetrics.winRate).toFixed(2)) : 0,
    profitFactor: trainMetrics.profitFactor > 0 ? parseFloat((testMetrics.profitFactor / trainMetrics.profitFactor).toFixed(2)) : 0,
    sharpe:       trainMetrics.sharpe > 0 ? parseFloat((testMetrics.sharpe / trainMetrics.sharpe).toFixed(2)) : 0,
    avgPnl:       trainMetrics.avgPnlPerTrade !== 0 ? parseFloat((testMetrics.avgPnlPerTrade / trainMetrics.avgPnlPerTrade).toFixed(2)) : 0,
  };

  // Verdict
  const avgDegradation = (degradation.winRate + degradation.profitFactor + degradation.sharpe) / 3;
  let verdict, verdictDetail;
  if (avgDegradation >= 0.85) {
    verdict = 'ROBUST';
    verdictDetail = `OOS performance is ${Math.round(avgDegradation * 100)}% of IS — edge appears real.`;
  } else if (avgDegradation >= 0.60) {
    verdict = 'MODERATE';
    verdictDetail = `OOS degradation to ${Math.round(avgDegradation * 100)}% — some overfitting likely.`;
  } else {
    verdict = 'OVERFIT';
    verdictDetail = `OOS collapsed to ${Math.round(avgDegradation * 100)}% — strategy is overfit.`;
  }

  // Per-strategy breakdown
  const strategies = [...new Set(split.train.signals.map(s => s.strategy))];
  const byStrategy = {};
  for (const strat of strategies) {
    const trainStrat = split.train.signals.filter(s => s.strategy === strat);
    const testStrat  = split.test.signals.filter(s => s.strategy === strat);
    byStrategy[strat] = {
      train: computeMetrics(trainStrat, accountSize),
      test:  computeMetrics(testStrat, accountSize),
    };
  }

  return {
    splitDate: split.splitDate,
    meta: split.meta,
    inSample:    trainMetrics,
    outOfSample: testMetrics,
    degradation,
    verdict,
    verdictDetail,
    byStrategy,
  };
}
