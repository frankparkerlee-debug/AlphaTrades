/**
 * Institutional-Grade Statistical Tests
 *
 * Tests that separate real edge from noise.
 * These are the tests that the top 1% of quant shops run
 * before deploying capital.
 *
 * 1. Deflated Sharpe Ratio (DSR) — corrects for multiple testing
 * 2. Statistical significance — t-test on returns
 * 3. Block bootstrap — preserves autocorrelation in MC
 * 4. CVaR / Expected Shortfall — tail risk beyond VaR
 * 5. Drawdown duration — how long until recovery
 * 6. Benchmark comparison — do we beat buy-and-hold SPY?
 * 7. Regime transition — do we survive regime changes?
 * 8. Return distribution — are returns normal? fat tails?
 */

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function skewness(arr) {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  const s = stddev(arr);
  if (s === 0) return 0;
  return arr.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0) / arr.length;
}

function kurtosis(arr) {
  if (arr.length < 4) return 0;
  const m = mean(arr);
  const s = stddev(arr);
  if (s === 0) return 0;
  return arr.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0) / arr.length - 3; // excess kurtosis
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

// Approximate inverse normal CDF (Beasley-Springer-Moro algorithm)
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
             -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// Normal CDF approximation
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p = d * Math.exp(-x * x / 2) * (0.3193815*t - 0.3565638*t*t + 1.781478*t*t*t - 1.821256*t*t*t*t + 1.330274*t*t*t*t*t);
  return x > 0 ? 1 - p : p;
}

// ── 1. Deflated Sharpe Ratio ─────────────────────────────────────────────────

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014)
 *
 * Corrects for multiple testing: if you test N strategies, the probability
 * of finding one with a high Sharpe by chance alone increases.
 *
 * DSR answers: "Given we tested N strategies, is this Sharpe still significant?"
 *
 * @param {number} observedSharpe - the strategy's annualized Sharpe ratio
 * @param {number} numTrials - number of strategies tested
 * @param {number} numReturns - number of return observations
 * @param {number} skew - skewness of returns
 * @param {number} kurt - excess kurtosis of returns
 * @returns {Object} { deflatedSharpe, pValue, significant }
 */
function deflatedSharpeRatio(observedSharpe, numTrials, numReturns, skew, kurt) {
  // Expected maximum Sharpe from N random strategies (Euler-Mascheroni)
  const euler = 0.5772156649;
  const expectedMaxSharpe = Math.sqrt(2 * Math.log(numTrials)) -
    (Math.log(Math.PI) + Math.log(Math.log(numTrials)) + euler) /
    (2 * Math.sqrt(2 * Math.log(numTrials)));

  // Standard error of Sharpe estimate (Lo, 2002)
  const se = Math.sqrt((1 + 0.25 * skew * observedSharpe - (kurt / 4) * observedSharpe * observedSharpe) / numReturns);

  if (se === 0) return { deflatedSharpe: 0, pValue: 1, significant: false };

  // Test statistic: is observed Sharpe > expected max from random?
  const testStat = (observedSharpe - expectedMaxSharpe) / se;
  const pValue = 1 - normCDF(testStat);

  return {
    observedSharpe: parseFloat(observedSharpe.toFixed(3)),
    expectedMaxRandomSharpe: parseFloat(expectedMaxSharpe.toFixed(3)),
    testStatistic: parseFloat(testStat.toFixed(3)),
    pValue: parseFloat(pValue.toFixed(4)),
    significant: pValue < 0.05,
    interpretation: pValue < 0.01 ? 'HIGHLY_SIGNIFICANT'
      : pValue < 0.05 ? 'SIGNIFICANT'
      : pValue < 0.10 ? 'MARGINAL'
      : 'NOT_SIGNIFICANT',
  };
}

// ── 2. T-Test on Returns ────────────────────────────────────────────────────

function tTestReturns(returns) {
  const n = returns.length;
  if (n < 5) return { tStat: 0, pValue: 1, significant: false };

  const m = mean(returns);
  const s = stddev(returns);
  if (s === 0) return { tStat: 0, pValue: 1, significant: false };

  const tStat = m / (s / Math.sqrt(n));
  // Approximate p-value from normal (valid for n > 30)
  const pValue = 2 * (1 - normCDF(Math.abs(tStat)));

  return {
    meanReturn: parseFloat(m.toFixed(4)),
    stdReturn: parseFloat(s.toFixed(4)),
    tStatistic: parseFloat(tStat.toFixed(3)),
    pValue: parseFloat(pValue.toFixed(4)),
    significant: pValue < 0.05,
    n,
  };
}

// ── 3. Block Bootstrap Monte Carlo ──────────────────────────────────────────

/**
 * Block bootstrap preserves autocorrelation in daily returns.
 * Standard MC assumes independent draws — this is wrong for trading.
 * Block bootstrap samples contiguous blocks of trades to preserve
 * the clustering pattern of wins and losses.
 *
 * @param {Array} dailyPnls - ordered array of daily P&L values
 * @param {number} blockSize - size of each block (default: 5 = 1 week)
 * @param {number} iterations - number of simulations
 * @param {number} simDays - days per simulation
 * @returns {Object} bootstrap results
 */
function blockBootstrap(dailyPnls, blockSize = 5, iterations = 5000, simDays = 20) {
  if (dailyPnls.length < blockSize * 2) {
    return { error: 'Not enough data for block bootstrap' };
  }

  // Create blocks
  const blocks = [];
  for (let i = 0; i <= dailyPnls.length - blockSize; i++) {
    blocks.push(dailyPnls.slice(i, i + blockSize));
  }

  const finalPnls = [];
  const maxDrawdowns = [];

  for (let iter = 0; iter < iterations; iter++) {
    let cumPnl = 0;
    let peak = 0;
    let maxDD = 0;
    let daysSimulated = 0;

    while (daysSimulated < simDays) {
      const block = blocks[Math.floor(Math.random() * blocks.length)];
      for (const dayPnl of block) {
        cumPnl += dayPnl;
        peak = Math.max(peak, cumPnl);
        maxDD = Math.min(maxDD, cumPnl - peak);
        daysSimulated++;
        if (daysSimulated >= simDays) break;
      }
    }

    finalPnls.push(cumPnl);
    maxDrawdowns.push(maxDD);
  }

  const sortedPnl = [...finalPnls].sort((a, b) => a - b);
  const sortedDD = [...maxDrawdowns].sort((a, b) => a - b);

  return {
    blockSize,
    iterations,
    pnl: {
      mean: Math.round(mean(finalPnls)),
      median: Math.round(percentile(sortedPnl, 50)),
      p5: Math.round(percentile(sortedPnl, 5)),
      p25: Math.round(percentile(sortedPnl, 25)),
      p75: Math.round(percentile(sortedPnl, 75)),
      p95: Math.round(percentile(sortedPnl, 95)),
    },
    drawdown: {
      mean: Math.round(mean(maxDrawdowns)),
      worst5: Math.round(percentile(sortedDD, 5)),
      worst1: Math.round(percentile(sortedDD, 1)),
    },
    probProfit: parseFloat((finalPnls.filter(p => p > 0).length / iterations * 100).toFixed(1)),
    probRuin15: parseFloat((finalPnls.filter(p => p < -1125).length / iterations * 100).toFixed(2)), // -15% of 7500
  };
}

// ── 4. CVaR / Expected Shortfall ────────────────────────────────────────────

function computeCVaR(dailyPnls, confidenceLevel = 0.95) {
  if (dailyPnls.length < 5) return { error: 'Not enough data' };

  const sorted = [...dailyPnls].sort((a, b) => a - b);
  const cutoff = Math.floor(sorted.length * (1 - confidenceLevel));
  const tail = sorted.slice(0, Math.max(1, cutoff));

  const VaR = sorted[cutoff] || sorted[0];
  const CVaR = mean(tail);

  return {
    VaR_95: Math.round(VaR),
    CVaR_95: Math.round(CVaR),
    VaR_99: Math.round(percentile(sorted, 1)),
    CVaR_99: Math.round(mean(sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.01))))),
    worstDay: Math.round(sorted[0]),
    tailObservations: tail.length,
    interpretation: CVaR > -200 ? 'MANAGEABLE'
      : CVaR > -500 ? 'MODERATE_RISK'
      : 'HIGH_TAIL_RISK',
  };
}

// ── 5. Drawdown Duration Analysis ───────────────────────────────────────────

function drawdownDuration(equityCurve) {
  if (!equityCurve || equityCurve.length < 3) return { error: 'Not enough data' };

  let peak = 0;
  let ddStart = null;
  let currentDDDays = 0;
  const drawdowns = [];
  let cumPnl = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const day = equityCurve[i];
    cumPnl += day.dayPnl || 0;

    if (cumPnl > peak) {
      // New high — record the drawdown that just ended
      if (ddStart !== null && currentDDDays > 0) {
        drawdowns.push({
          startDate: ddStart,
          endDate: day.date,
          duration: currentDDDays,
          depth: Math.round(peak - (cumPnl - (day.dayPnl || 0))), // depth at worst point before recovery
        });
      }
      peak = cumPnl;
      ddStart = null;
      currentDDDays = 0;
    } else {
      if (ddStart === null) ddStart = day.date;
      currentDDDays++;
    }
  }

  // Record ongoing drawdown
  if (ddStart !== null && currentDDDays > 0) {
    drawdowns.push({
      startDate: ddStart,
      endDate: equityCurve[equityCurve.length - 1].date,
      duration: currentDDDays,
      depth: Math.round(peak - cumPnl),
      ongoing: true,
    });
  }

  if (drawdowns.length === 0) {
    return { drawdowns: [], maxDuration: 0, avgDuration: 0, verdict: 'NO_DRAWDOWNS' };
  }

  const durations = drawdowns.map(d => d.duration);
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const maxDD = drawdowns.reduce((worst, d) => d.depth > worst.depth ? d : worst, drawdowns[0]);

  return {
    totalDrawdowns: drawdowns.length,
    maxDurationDays: Math.max(...durations),
    avgDurationDays: parseFloat(mean(durations).toFixed(1)),
    medianDurationDays: percentile(sortedDurations, 50),
    longestDrawdown: maxDD,
    drawdowns: drawdowns.slice(0, 10), // top 10 for display
    // Probability of N+ day drawdown
    probDrawdown3Plus: parseFloat((durations.filter(d => d >= 3).length / durations.length * 100).toFixed(1)),
    probDrawdown5Plus: parseFloat((durations.filter(d => d >= 5).length / durations.length * 100).toFixed(1)),
    verdict: Math.max(...durations) <= 3 ? 'SHORT_RECOVERIES'
      : Math.max(...durations) <= 7 ? 'MODERATE_RECOVERIES'
      : 'EXTENDED_DRAWDOWNS',
  };
}

// ── 6. Benchmark Comparison ─────────────────────────────────────────────────

function benchmarkComparison(equityCurve, accountSize = 7500) {
  if (!equityCurve || equityCurve.length < 3) return { error: 'Not enough data' };

  const strategyReturn = equityCurve[equityCurve.length - 1].cumPnl / accountSize;
  const tradingDays = equityCurve.length;

  // SPY annualized return ~10% = ~0.04% per trading day
  const spyDailyReturn = 0.10 / 252;
  const spyReturnOverPeriod = spyDailyReturn * tradingDays;
  const spyDollarReturn = accountSize * spyReturnOverPeriod;

  // SPY with leverage (2x for margin comparison)
  const spyLeveragedReturn = spyReturnOverPeriod * 2;

  // Risk-free rate (~5% annualized)
  const rfDailyReturn = 0.05 / 252;
  const rfReturnOverPeriod = rfDailyReturn * tradingDays;

  // Strategy daily returns
  const dailyReturns = equityCurve.map(d => (d.dayPnl || 0) / accountSize);
  const stratSharpe = stddev(dailyReturns) > 0
    ? ((mean(dailyReturns) - rfDailyReturn) / stddev(dailyReturns)) * Math.sqrt(252)
    : 0;

  // Information ratio (vs SPY)
  const excessReturns = dailyReturns.map(r => r - spyDailyReturn);
  const trackingError = stddev(excessReturns);
  const informationRatio = trackingError > 0 ? (mean(excessReturns) / trackingError) * Math.sqrt(252) : 0;

  return {
    strategyReturn: parseFloat((strategyReturn * 100).toFixed(2)),
    spyReturn: parseFloat((spyReturnOverPeriod * 100).toFixed(2)),
    spyLeveragedReturn: parseFloat((spyLeveragedReturn * 100).toFixed(2)),
    riskFreeReturn: parseFloat((rfReturnOverPeriod * 100).toFixed(2)),
    excessOverSPY: parseFloat(((strategyReturn - spyReturnOverPeriod) * 100).toFixed(2)),
    excessOverRiskFree: parseFloat(((strategyReturn - rfReturnOverPeriod) * 100).toFixed(2)),
    annualizedSharpe: parseFloat(stratSharpe.toFixed(2)),
    informationRatio: parseFloat(informationRatio.toFixed(2)),
    tradingDays,
    verdict: strategyReturn > spyLeveragedReturn ? 'BEATS_LEVERAGED_SPY'
      : strategyReturn > spyReturnOverPeriod ? 'BEATS_SPY'
      : strategyReturn > rfReturnOverPeriod ? 'BEATS_RISK_FREE'
      : strategyReturn > 0 ? 'POSITIVE_BUT_UNDERPERFORMS'
      : 'NEGATIVE_RETURNS',
  };
}

// ── 7. Regime Transition Analysis ───────────────────────────────────────────

function regimeTransitionAnalysis(signals) {
  if (signals.length < 10) return { error: 'Not enough signals' };

  // Sort by date
  const sorted = [...signals].sort((a, b) => a.date.localeCompare(b.date));

  // Detect regime changes
  const transitions = [];
  let prevRegime = null;
  for (const s of sorted) {
    const regime = s.regime || 'unknown';
    if (prevRegime && regime !== prevRegime) {
      transitions.push({ date: s.date, from: prevRegime, to: regime });
    }
    prevRegime = regime;
  }

  // Analyze P&L around transitions
  // Take signals within 2 days before and after each transition
  const transitionPerformance = [];
  for (const t of transitions) {
    const before = sorted.filter(s => s.date <= t.date && s.date >= shiftDate(t.date, -2));
    const after = sorted.filter(s => s.date >= t.date && s.date <= shiftDate(t.date, 2));

    const beforePnl = before.reduce((a, s) => a + (s.pnlDollars || 0), 0);
    const afterPnl = after.reduce((a, s) => a + (s.pnlDollars || 0), 0);

    transitionPerformance.push({
      date: t.date,
      from: t.from,
      to: t.to,
      beforePnl: Math.round(beforePnl),
      afterPnl: Math.round(afterPnl),
      adapted: afterPnl > beforePnl * 0.5 || afterPnl > 0,
    });
  }

  const adaptedCount = transitionPerformance.filter(t => t.adapted).length;

  return {
    totalTransitions: transitions.length,
    transitionDetails: transitionPerformance.slice(0, 10),
    adaptationRate: transitions.length > 0
      ? parseFloat((adaptedCount / transitions.length * 100).toFixed(1))
      : 0,
    verdict: transitions.length === 0 ? 'NO_TRANSITIONS'
      : (adaptedCount / transitions.length) >= 0.6 ? 'ADAPTS_WELL'
      : (adaptedCount / transitions.length) >= 0.4 ? 'MIXED_ADAPTATION'
      : 'POOR_ADAPTATION',
  };
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ── 8. Return Distribution Analysis ─────────────────────────────────────────

function returnDistribution(dailyPnls) {
  if (dailyPnls.length < 10) return { error: 'Not enough data' };

  const skew = skewness(dailyPnls);
  const kurt = kurtosis(dailyPnls);

  // Jarque-Bera test for normality
  const n = dailyPnls.length;
  const jbStat = (n / 6) * (skew * skew + (kurt * kurt) / 4);
  // JB follows chi-squared with 2 df; approx p-value
  const jbPValue = Math.exp(-jbStat / 2); // rough approximation

  return {
    skewness: parseFloat(skew.toFixed(3)),
    excessKurtosis: parseFloat(kurt.toFixed(3)),
    jarqueBera: parseFloat(jbStat.toFixed(2)),
    jbPValue: parseFloat(jbPValue.toFixed(4)),
    isNormal: jbPValue > 0.05,
    interpretation: {
      skew: skew > 0.5 ? 'POSITIVE_SKEW (right tail heavier — occasional big wins)'
        : skew < -0.5 ? 'NEGATIVE_SKEW (left tail heavier — occasional big losses)'
        : 'ROUGHLY_SYMMETRIC',
      tails: kurt > 2 ? 'FAT_TAILS (extreme events more likely than normal distribution predicts)'
        : kurt < -1 ? 'THIN_TAILS (extreme events less likely)'
        : 'NORMAL_TAILS',
    },
  };
}

// ── Master Test Runner ──────────────────────────────────────────────────────

/**
 * Run all institutional-grade statistical tests.
 *
 * @param {Object} backtestResults - Full backtest output
 * @returns {Object} Complete statistical test suite results
 */
export function runStatisticalTests(backtestResults) {
  const signals = backtestResults.signals || [];
  const equityCurve = backtestResults.equityCurve || [];
  const accountSize = backtestResults.config?.accountSize || 7500;

  if (signals.length < 10) {
    return { error: 'Not enough signals for statistical tests (need 10+)' };
  }

  // Build daily P&L series
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = 0;
    byDate[s.date] += s.pnlDollars || 0;
  }
  const dailyPnls = Object.keys(byDate).sort().map(d => byDate[d]);
  const dailyReturns = dailyPnls.map(p => p / accountSize);

  // Sharpe for DSR
  const dailyMean = mean(dailyReturns);
  const dailyStd = stddev(dailyReturns);
  const annualizedSharpe = dailyStd > 0 ? (dailyMean / dailyStd) * Math.sqrt(252) : 0;
  const skew = skewness(dailyReturns);
  const kurt = kurtosis(dailyReturns);

  // Number of strategies tested (for multiple comparison correction)
  const numStrategiesTested = 5; // A1, A2, A3, B1, B2

  const results = {};

  // 1. Deflated Sharpe Ratio
  results.deflatedSharpe = deflatedSharpeRatio(
    annualizedSharpe,
    numStrategiesTested,
    dailyReturns.length,
    skew,
    kurt
  );

  // 2. T-test on daily returns
  results.tTest = tTestReturns(dailyPnls);

  // Per-strategy t-tests
  const strategies = [...new Set(signals.map(s => s.strategy))];
  results.strategyTTests = {};
  for (const strat of strategies) {
    const stratSignals = signals.filter(s => s.strategy === strat);
    const stratPnls = stratSignals.map(s => s.pnlDollars || 0);
    results.strategyTTests[strat] = tTestReturns(stratPnls);
  }

  // 3. Block bootstrap (preserves autocorrelation)
  results.blockBootstrap = blockBootstrap(dailyPnls, 5, 5000, 20);

  // 4. CVaR / Expected Shortfall
  results.cvar = computeCVaR(dailyPnls);

  // 5. Drawdown duration
  results.drawdownDuration = drawdownDuration(equityCurve);

  // 6. Benchmark comparison
  results.benchmark = benchmarkComparison(equityCurve, accountSize);

  // 7. Regime transition
  results.regimeTransition = regimeTransitionAnalysis(signals);

  // 8. Return distribution
  results.returnDistribution = returnDistribution(dailyPnls);

  // ── Overall Statistical Verdict ─────────────────────────────────────────
  const verdicts = [];

  if (results.deflatedSharpe.significant) {
    verdicts.push('PASS: Sharpe survives multiple testing correction');
  } else {
    verdicts.push('FAIL: Sharpe does NOT survive multiple testing — could be luck');
  }

  if (results.tTest.significant && results.tTest.meanReturn > 0) {
    verdicts.push('PASS: Daily returns are statistically significantly positive');
  } else {
    verdicts.push('FAIL: Returns are NOT statistically significant');
  }

  if (results.blockBootstrap.probProfit > 60) {
    verdicts.push(`PASS: ${results.blockBootstrap.probProfit}% probability of profit (block bootstrap)`);
  } else {
    verdicts.push(`FAIL: Only ${results.blockBootstrap.probProfit}% probability of profit`);
  }

  if (results.benchmark.verdict === 'BEATS_LEVERAGED_SPY' || results.benchmark.verdict === 'BEATS_SPY') {
    verdicts.push(`PASS: ${results.benchmark.verdict}`);
  } else {
    verdicts.push(`WARN: ${results.benchmark.verdict}`);
  }

  const passes = verdicts.filter(v => v.startsWith('PASS')).length;
  const fails = verdicts.filter(v => v.startsWith('FAIL')).length;

  results.overallVerdict = {
    passes,
    fails,
    warnings: verdicts.filter(v => v.startsWith('WARN')).length,
    details: verdicts,
    conclusion: passes >= 3 ? 'STATISTICALLY_VIABLE'
      : passes >= 2 ? 'MARGINAL — needs more data or parameter tuning'
      : 'NOT_VIABLE — edge likely does not exist',
  };

  return results;
}
