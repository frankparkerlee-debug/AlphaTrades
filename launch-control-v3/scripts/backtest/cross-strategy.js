/**
 * Cross-Strategy Correlation Analysis
 *
 * Measures how the 5 strategies correlate with each other.
 * Low correlation = diversification benefit = smoother equity curve.
 */

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function correlation(x, y) {
  if (x.length !== y.length || x.length < 3) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : 0;
}

/**
 * Build daily P&L time series per strategy.
 */
function buildDailyPnl(signals) {
  const strategies = [...new Set(signals.map(s => s.strategy))];
  const allDates = [...new Set(signals.map(s => s.date))].sort();

  const dailyPnl = {};
  for (const strat of strategies) {
    dailyPnl[strat] = {};
    for (const date of allDates) dailyPnl[strat][date] = 0;
  }

  for (const s of signals) {
    dailyPnl[s.strategy][s.date] += s.pnlDollars || 0;
  }

  return { strategies, dates: allDates, dailyPnl };
}

/**
 * Compute correlation matrix between strategy daily P&Ls.
 * @param {Array} signals - all trade results with strategy field
 * @returns {Object} { matrix, strategies }
 */
export function computeCorrelationMatrix(signals) {
  const { strategies, dates, dailyPnl } = buildDailyPnl(signals);

  if (dates.length < 5) {
    return { matrix: {}, strategies, error: 'Need 5+ trading days' };
  }

  const matrix = {};
  for (const s1 of strategies) {
    matrix[s1] = {};
    const x = dates.map(d => dailyPnl[s1][d]);
    for (const s2 of strategies) {
      const y = dates.map(d => dailyPnl[s2][d]);
      matrix[s1][s2] = parseFloat(correlation(x, y).toFixed(3));
    }
  }

  return { matrix, strategies };
}

/**
 * Compute portfolio-level metrics.
 * @param {Array} signals - all trade results
 * @param {number} accountSize
 * @returns {Object} portfolio metrics
 */
export function portfolioMetrics(signals, accountSize = 7500) {
  const { strategies, dates, dailyPnl } = buildDailyPnl(signals);

  // Portfolio daily P&L = sum of all strategies
  const portfolioDaily = dates.map(d =>
    strategies.reduce((sum, s) => sum + dailyPnl[s][d], 0)
  );

  const avgDaily = mean(portfolioDaily);
  const stdDaily = stddev(portfolioDaily);

  // Sharpe (annualized)
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  // Sortino (downside deviation)
  const downside = portfolioDaily.filter(d => d < 0);
  const downsideDev = downside.length > 0
    ? Math.sqrt(mean(downside.map(d => d * d)))
    : 0;
  const sortino = downsideDev > 0 ? (avgDaily / downsideDev) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const dpnl of portfolioDaily) {
    cumPnl += dpnl;
    peak = Math.max(peak, cumPnl);
    maxDD = Math.min(maxDD, cumPnl - peak);
  }

  // Calmar ratio
  const calmar = maxDD < 0 ? (avgDaily * 252) / Math.abs(maxDD) : 0;

  // Weekly returns
  const weeklyPnls = [];
  let weekPnl = 0;
  for (let i = 0; i < portfolioDaily.length; i++) {
    weekPnl += portfolioDaily[i];
    if ((i + 1) % 5 === 0 || i === portfolioDaily.length - 1) {
      weeklyPnls.push(weekPnl);
      weekPnl = 0;
    }
  }
  const weeklyReturns = weeklyPnls.map(w => (w / accountSize) * 100);
  const avgWeeklyReturn = mean(weeklyReturns);

  return {
    sharpe:       parseFloat(sharpe.toFixed(2)),
    sortino:      parseFloat(sortino.toFixed(2)),
    calmar:       parseFloat(calmar.toFixed(2)),
    maxDrawdown:  Math.round(maxDD),
    maxDrawdownPct: parseFloat((maxDD / accountSize * 100).toFixed(2)),
    avgDailyPnl:  Math.round(avgDaily),
    stdDailyPnl:  Math.round(stdDaily),
    avgWeeklyReturnPct: parseFloat(avgWeeklyReturn.toFixed(2)),
    tradingDays:  dates.length,
    totalPnl:     Math.round(portfolioDaily.reduce((a, b) => a + b, 0)),
  };
}

/**
 * Measure diversification benefit.
 * Portfolio vol should be < sum of individual vols if strategies are uncorrelated.
 */
export function diversificationBenefit(signals, accountSize = 7500) {
  const { strategies, dates, dailyPnl } = buildDailyPnl(signals);

  // Individual strategy vols
  const individualVols = {};
  let sumIndividualVol = 0;
  for (const s of strategies) {
    const returns = dates.map(d => dailyPnl[s][d]);
    const vol = stddev(returns);
    individualVols[s] = Math.round(vol);
    sumIndividualVol += vol;
  }

  // Portfolio vol
  const portfolioReturns = dates.map(d =>
    strategies.reduce((sum, s) => sum + dailyPnl[s][d], 0)
  );
  const portfolioVol = stddev(portfolioReturns);

  // Diversification ratio: portfolioVol / sumIndividualVol
  // Lower = more diversification benefit
  const ratio = sumIndividualVol > 0 ? portfolioVol / sumIndividualVol : 1;

  return {
    individualVols,
    sumIndividualVol: Math.round(sumIndividualVol),
    portfolioVol: Math.round(portfolioVol),
    diversificationRatio: parseFloat(ratio.toFixed(3)),
    benefit: parseFloat(((1 - ratio) * 100).toFixed(1)), // % reduction in vol
    verdict: ratio < 0.7 ? 'STRONG' : ratio < 0.85 ? 'MODERATE' : 'WEAK',
  };
}

/**
 * Suggest optimal capital weights per strategy.
 * Uses inverse-volatility weighting (simple but effective).
 */
export function optimalWeights(signals) {
  const { strategies, dates, dailyPnl } = buildDailyPnl(signals);

  if (dates.length < 10) {
    return { weights: {}, method: 'insufficient_data' };
  }

  // Inverse volatility weighting
  const vols = {};
  const sharpes = {};
  for (const s of strategies) {
    const returns = dates.map(d => dailyPnl[s][d]);
    const vol = stddev(returns);
    vols[s] = vol || 1;

    const avg = mean(returns);
    sharpes[s] = vol > 0 ? avg / vol : 0;
  }

  // Method 1: Inverse volatility
  const totalInvVol = strategies.reduce((sum, s) => sum + 1 / vols[s], 0);
  const invVolWeights = {};
  for (const s of strategies) {
    invVolWeights[s] = parseFloat(((1 / vols[s]) / totalInvVol).toFixed(3));
  }

  // Method 2: Sharpe-weighted (allocate more to higher Sharpe strategies)
  const positiveSharpees = strategies.filter(s => sharpes[s] > 0);
  const sharpeWeights = {};
  if (positiveSharpees.length > 0) {
    const totalSharpe = positiveSharpees.reduce((sum, s) => sum + sharpes[s], 0);
    for (const s of strategies) {
      sharpeWeights[s] = sharpes[s] > 0
        ? parseFloat((sharpes[s] / totalSharpe).toFixed(3))
        : 0;
    }
  }

  return {
    invVolWeights,
    sharpeWeights: Object.keys(sharpeWeights).length > 0 ? sharpeWeights : null,
    strategySharpes: Object.fromEntries(
      strategies.map(s => [s, parseFloat(sharpes[s].toFixed(3))])
    ),
    strategyVols: Object.fromEntries(
      strategies.map(s => [s, Math.round(vols[s])])
    ),
    recommended: Object.keys(sharpeWeights).length > 0 ? sharpeWeights : invVolWeights,
    method: Object.keys(sharpeWeights).length > 0 ? 'sharpe_weighted' : 'inverse_volatility',
  };
}
