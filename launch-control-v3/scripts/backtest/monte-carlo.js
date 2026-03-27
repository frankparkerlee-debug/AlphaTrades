/**
 * Monte Carlo Simulation & Stress Testing
 *
 * Takes actual backtest signal results and runs probabilistic simulations
 * to answer: "How confident are we in this strategy's edge?"
 *
 * Monte Carlo: bootstrap resample from real trade outcomes → P&L distribution
 * Stress Test: simulate adverse scenarios (wider spreads, lower win rate, correlated losses)
 */

// ── Configuration ───────────────────────────────────────────────────────────

const MC_ITERATIONS    = 10000;  // simulation paths
const MC_DAYS          = 20;     // trading days per simulation
const RUIN_THRESHOLD   = -0.15;  // -15% of account = "ruin"
const PERCENTILES      = [1, 5, 10, 25, 50, 75, 90, 95, 99];

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function percentile(sorted, p) {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
}

// ── Core Monte Carlo Engine ─────────────────────────────────────────────────

/**
 * Run Monte Carlo simulation from backtest trade results.
 *
 * @param {Object} backtestResults - Full backtest results from run.js
 * @param {Object} opts - Override options
 * @returns {Object} - MC results with distributions, percentiles, stress tests
 */
export function runMonteCarlo(backtestResults, opts = {}) {
  const signals     = backtestResults.signals || [];
  const accountSize = backtestResults.config?.accountSize || 7500;
  const iterations  = opts.iterations || MC_ITERATIONS;
  const simDays     = opts.days || MC_DAYS;

  if (signals.length < 10) {
    return { error: 'Not enough signals for Monte Carlo (need 10+)', signalCount: signals.length };
  }

  // Group trades by date to understand signals-per-day distribution
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }
  const dailyCounts = Object.values(byDate).map(d => d.length);
  const avgSignalsPerDay = mean(dailyCounts);
  const sdSignalsPerDay  = stddev(dailyCounts);

  // Group by grade for stratified sampling
  const byGrade = {};
  for (const s of signals) {
    const g = s.grade || 'B';
    if (!byGrade[g]) byGrade[g] = [];
    byGrade[g].push(s);
  }

  // ── Run base simulation ──────────────────────────────────────────────────
  const baseSim = simulate(signals, dailyCounts, accountSize, iterations, simDays);

  // ── Stress tests ─────────────────────────────────────────────────────────
  const stressTests = {};

  // Stress 1: Win rate -10% (randomly flip wins to losses)
  stressTests.winRateDrop10 = stressWinRateDrop(signals, dailyCounts, accountSize, iterations, simDays, 0.10);

  // Stress 2: Win rate -20%
  stressTests.winRateDrop20 = stressWinRateDrop(signals, dailyCounts, accountSize, iterations, simDays, 0.20);

  // Stress 3: Wider spreads (reduce all P&L by $15/trade)
  stressTests.widerSpreads = stressSpreadCost(signals, dailyCounts, accountSize, iterations, simDays, 15);

  // Stress 4: Max consecutive losses (simulates cold streaks)
  stressTests.coldStreak = stressColdStreak(signals, accountSize);

  // Stress 5: Only losing trades (worst case daily P&L)
  stressTests.worstDay = stressWorstDay(signals, accountSize);

  // Stress 6: By grade isolation (how does each grade perform standalone?)
  stressTests.byGrade = {};
  for (const [grade, gradeSigs] of Object.entries(byGrade)) {
    if (gradeSigs.length < 5) continue;
    const gradeDailyCounts = [Math.round(avgSignalsPerDay * (gradeSigs.length / signals.length))];
    stressTests.byGrade[grade] = simulate(gradeSigs, gradeDailyCounts, accountSize, Math.min(iterations, 5000), simDays);
  }

  return {
    config: {
      iterations,
      simDays,
      signalCount:     signals.length,
      tradingDays:     Object.keys(byDate).length,
      avgSignalsPerDay: parseFloat(avgSignalsPerDay.toFixed(1)),
      accountSize,
    },
    base: baseSim,
    stress: stressTests,
    tradeStats: computeTradeStats(signals),
  };
}

// ── Simulation Runner ───────────────────────────────────────────────────────

function simulate(signals, dailyCounts, accountSize, iterations, simDays) {
  const finalPnls     = [];
  const maxDrawdowns  = [];
  const maxRunups     = [];
  const dailyPnls     = [];  // flatten all daily P&Ls for distribution
  const winRates      = [];
  const paths         = [];  // store a subset of paths for charting
  const storePathEvery = Math.max(1, Math.floor(iterations / 50)); // ~50 paths for chart

  for (let i = 0; i < iterations; i++) {
    let cumPnl = 0;
    let peak = 0;
    let maxDD = 0;
    let maxUp = 0;
    let wins = 0;
    let trades = 0;
    const path = [0]; // equity curve starting at 0

    for (let d = 0; d < simDays; d++) {
      // Sample how many signals this day (from historical distribution)
      const nSignals = pickRandom(dailyCounts);
      let dayPnl = 0;

      for (let s = 0; s < nSignals; s++) {
        const trade = pickRandom(signals);
        const pnl = trade.pnlDollars || 0;
        dayPnl += pnl;
        trades++;
        if (pnl > 0) wins++;
      }

      cumPnl += dayPnl;
      dailyPnls.push(dayPnl);
      peak = Math.max(peak, cumPnl);
      maxDD = Math.min(maxDD, cumPnl - peak);
      maxUp = Math.max(maxUp, cumPnl);
      path.push(cumPnl);
    }

    finalPnls.push(cumPnl);
    maxDrawdowns.push(maxDD);
    maxRunups.push(maxUp);
    winRates.push(trades > 0 ? (wins / trades) * 100 : 0);

    if (i % storePathEvery === 0) {
      paths.push(path);
    }
  }

  // Sort for percentile calculations
  const sortedPnl = [...finalPnls].sort((a, b) => a - b);
  const sortedDD  = [...maxDrawdowns].sort((a, b) => a - b);
  const sortedDaily = [...dailyPnls].sort((a, b) => a - b);

  // P&L distribution (histogram buckets)
  const histogram = buildHistogram(finalPnls, 30);

  // Probability metrics
  const probProfit   = finalPnls.filter(p => p > 0).length / iterations;
  const probRuin     = finalPnls.filter(p => p < accountSize * RUIN_THRESHOLD).length / iterations;
  const prob10pct    = finalPnls.filter(p => p > accountSize * 0.10).length / iterations;

  return {
    pnl: {
      mean:    Math.round(mean(finalPnls)),
      median:  Math.round(percentile(sortedPnl, 50)),
      stddev:  Math.round(stddev(finalPnls)),
      min:     Math.round(sortedPnl[0]),
      max:     Math.round(sortedPnl[sortedPnl.length - 1]),
      percentiles: Object.fromEntries(
        PERCENTILES.map(p => [p, Math.round(percentile(sortedPnl, p))])
      ),
    },
    drawdown: {
      mean:    Math.round(mean(maxDrawdowns)),
      median:  Math.round(percentile(sortedDD, 50)),
      worst5:  Math.round(percentile(sortedDD, 5)),
      worst1:  Math.round(percentile(sortedDD, 1)),
    },
    daily: {
      mean:    Math.round(mean(dailyPnls)),
      median:  Math.round(percentile(sortedDaily, 50)),
      stddev:  Math.round(stddev(dailyPnls)),
      worst5:  Math.round(percentile(sortedDaily, 5)),
      best95:  Math.round(percentile(sortedDaily, 95)),
    },
    probability: {
      profit:     parseFloat((probProfit * 100).toFixed(1)),
      ruin:       parseFloat((probRuin * 100).toFixed(2)),
      return10pct: parseFloat((prob10pct * 100).toFixed(1)),
    },
    winRate: {
      mean:    parseFloat(mean(winRates).toFixed(1)),
      stddev:  parseFloat(stddev(winRates).toFixed(1)),
    },
    histogram,
    paths,  // ~50 sample equity curves for fan chart
  };
}

// ── Stress Scenarios ────────────────────────────────────────────────────────

function stressWinRateDrop(signals, dailyCounts, accountSize, iterations, simDays, dropPct) {
  // Randomly flip `dropPct` of winning trades into losses
  const modifiedSignals = signals.map(s => {
    if (s.pnlDollars > 0 && Math.random() < dropPct) {
      // Flip win to a loss: use average loss magnitude
      const avgLoss = mean(signals.filter(x => x.pnlDollars < 0).map(x => x.pnlDollars));
      return { ...s, pnlDollars: avgLoss || -50 };
    }
    return s;
  });
  return simulate(modifiedSignals, dailyCounts, accountSize, Math.min(iterations, 5000), simDays);
}

function stressSpreadCost(signals, dailyCounts, accountSize, iterations, simDays, costPerTrade) {
  const modifiedSignals = signals.map(s => ({
    ...s,
    pnlDollars: s.pnlDollars - costPerTrade,
  }));
  return simulate(modifiedSignals, dailyCounts, accountSize, Math.min(iterations, 5000), simDays);
}

function stressColdStreak(signals, accountSize) {
  // What's the worst N consecutive trades?
  const sorted = [...signals].sort((a, b) => a.pnlDollars - b.pnlDollars);
  const streaks = {};

  for (const n of [3, 5, 7, 10, 15, 20]) {
    if (sorted.length < n) continue;
    // Worst N trades in a row
    const worstN = sorted.slice(0, n);
    const totalLoss = worstN.reduce((a, b) => a + b.pnlDollars, 0);
    streaks[n] = {
      pnl: Math.round(totalLoss),
      pctOfAccount: parseFloat((totalLoss / accountSize * 100).toFixed(2)),
    };
  }

  return { consecutiveLosses: streaks };
}

function stressWorstDay(signals, accountSize) {
  // Group by date, find worst and best days
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = { pnl: 0, count: 0, wins: 0 };
    byDate[s.date].pnl += s.pnlDollars;
    byDate[s.date].count++;
    if (s.pnlDollars > 0) byDate[s.date].wins++;
  }

  const days = Object.entries(byDate)
    .map(([date, d]) => ({ date, ...d, winRate: d.count > 0 ? parseFloat((d.wins / d.count * 100).toFixed(1)) : 0 }))
    .sort((a, b) => a.pnl - b.pnl);

  return {
    worst3: days.slice(0, 3).map(d => ({ ...d, pctOfAccount: parseFloat((d.pnl / accountSize * 100).toFixed(2)) })),
    best3:  days.slice(-3).reverse().map(d => ({ ...d, pctOfAccount: parseFloat((d.pnl / accountSize * 100).toFixed(2)) })),
  };
}

// ── Trade Statistics ────────────────────────────────────────────────────────

function computeTradeStats(signals) {
  const wins    = signals.filter(s => s.pnlDollars > 0);
  const losses  = signals.filter(s => s.pnlDollars < 0);
  const winAmts = wins.map(s => s.pnlDollars);
  const lossAmts = losses.map(s => s.pnlDollars);

  const avgWin  = mean(winAmts);
  const avgLoss = mean(lossAmts);
  const expectancy = signals.length > 0
    ? (wins.length / signals.length) * avgWin + (losses.length / signals.length) * avgLoss
    : 0;

  // Kelly criterion
  const winRate = wins.length / signals.length;
  const winLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const kelly = winLossRatio > 0
    ? (winRate * winLossRatio - (1 - winRate)) / winLossRatio
    : 0;

  // Sortino ratio (downside deviation)
  const dailyPnls = {};
  for (const s of signals) {
    if (!dailyPnls[s.date]) dailyPnls[s.date] = 0;
    dailyPnls[s.date] += s.pnlDollars;
  }
  const dpArr = Object.values(dailyPnls);
  const avgDaily = mean(dpArr);
  const downsideDev = Math.sqrt(mean(dpArr.filter(d => d < 0).map(d => d ** 2)));
  const sortino = downsideDev > 0 ? (avgDaily / downsideDev) : 0;

  // Sharpe (annualized, ~252 trading days)
  const dailyStd = stddev(dpArr);
  const sharpe = dailyStd > 0 ? (avgDaily / dailyStd) * Math.sqrt(252) : 0;

  return {
    totalTrades:  signals.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat((winRate * 100).toFixed(1)),
    avgWin:       Math.round(avgWin),
    avgLoss:      Math.round(avgLoss),
    expectancy:   Math.round(expectancy),
    kellyPct:     parseFloat((kelly * 100).toFixed(1)),
    sharpe:       parseFloat(sharpe.toFixed(2)),
    sortino:      parseFloat(sortino.toFixed(2)),
    profitFactor: Math.abs(mean(lossAmts)) > 0
      ? parseFloat((winAmts.reduce((a, b) => a + b, 0) / Math.abs(lossAmts.reduce((a, b) => a + b, 0))).toFixed(2))
      : 999,
  };
}

// ── Histogram Builder ───────────────────────────────────────────────────────

function buildHistogram(values, buckets) {
  // Filter out NaN/Infinity values that break histogram math
  const clean = values.filter(v => Number.isFinite(v));
  if (clean.length === 0) return [];

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const bucketSize = range / buckets;

  const bins = Array.from({ length: buckets }, (_, i) => ({
    lo: Math.round(min + i * bucketSize),
    hi: Math.round(min + (i + 1) * bucketSize),
    count: 0,
  }));

  for (const v of clean) {
    const idx = Math.max(0, Math.min(Math.floor((v - min) / bucketSize), buckets - 1));
    bins[idx].count++;
  }

  // Normalize to percentages
  const total = values.length;
  for (const b of bins) {
    b.pct = parseFloat((b.count / total * 100).toFixed(2));
  }

  return bins;
}
