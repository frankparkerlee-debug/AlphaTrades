/**
 * Position Sizing Optimizer
 *
 * Kelly criterion per strategy and portfolio-level.
 * Target sizing: find the multiplier that maximizes P(15%/week)
 * while keeping P(50% drawdown) under control.
 */

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Compute Kelly fraction for a single strategy.
 */
function kellyFraction(signals) {
  const wins = signals.filter(s => s.pnlDollars > 0);
  const losses = signals.filter(s => s.pnlDollars < 0);

  if (wins.length === 0 || losses.length === 0) return 0;

  const winRate = wins.length / signals.length;
  const avgWin = mean(wins.map(s => Math.abs(s.pnlDollars)));
  const avgLoss = mean(losses.map(s => Math.abs(s.pnlDollars)));
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Kelly: f = (p * b - q) / b where p = winRate, b = winLossRatio, q = 1-p
  const kelly = winLossRatio > 0
    ? (winRate * winLossRatio - (1 - winRate)) / winLossRatio
    : 0;

  // Half-Kelly is standard practice (full Kelly is too aggressive)
  return Math.max(0, Math.min(1, kelly));
}

/**
 * Compute Kelly fraction per strategy.
 * @param {Array} signals - all trade results
 * @returns {Object} { strategy: { fullKelly, halfKelly, quarterKelly } }
 */
export function kellyPerStrategy(signals) {
  const strategies = [...new Set(signals.map(s => s.strategy))];
  const result = {};

  for (const strat of strategies) {
    const stratSigs = signals.filter(s => s.strategy === strat);
    const kelly = kellyFraction(stratSigs);

    result[strat] = {
      signals: stratSigs.length,
      fullKelly:    parseFloat((kelly * 100).toFixed(1)),
      halfKelly:    parseFloat((kelly * 50).toFixed(1)),
      quarterKelly: parseFloat((kelly * 25).toFixed(1)),
    };
  }

  return result;
}

/**
 * Find sizing multiplier that maximizes P(weekly target) with risk constraint.
 *
 * Binary search over sizing multipliers from 0.5x to 3.0x.
 * For each multiplier, run MC to estimate P(weekly target) and P(max drawdown).
 *
 * @param {Array} signals - all trade results
 * @param {number} accountSize
 * @param {Object} opts - { weeklyTarget: 0.15, maxDrawdownProb: 0.10, iterations: 5000 }
 * @returns {Object} optimal sizing recommendation
 */
export function targetSizing(signals, accountSize = 7500, opts = {}) {
  const weeklyTarget = opts.weeklyTarget || 0.15;    // 15%
  const maxDrawdownProb = opts.maxDrawdownProb || 0.10; // 10% chance of 50% DD
  const drawdownThreshold = opts.drawdownThreshold || 0.50; // 50% drawdown
  const iterations = opts.iterations || 3000;
  const simWeeks = opts.simWeeks || 4; // simulate 4 weeks

  // Group signals by date for daily sampling
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }
  const dailyBlocks = Object.values(byDate);

  if (dailyBlocks.length < 5) {
    return { error: 'Need 5+ trading days for sizing optimization' };
  }

  const multipliers = [0.50, 0.75, 1.00, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00];
  const results = [];

  for (const mult of multipliers) {
    let profitWeeks = 0;
    let targetWeeks = 0;
    let ruinPaths = 0;

    for (let i = 0; i < iterations; i++) {
      let cumPnl = 0;
      let peak = 0;
      let maxDD = 0;
      let weekPnl = 0;
      let weeksHit = 0;

      for (let d = 0; d < simWeeks * 5; d++) {
        const dayBlock = pickRandom(dailyBlocks);
        const dayPnl = dayBlock.reduce((sum, s) => sum + s.pnlDollars * mult, 0);
        cumPnl += dayPnl;
        weekPnl += dayPnl;

        peak = Math.max(peak, cumPnl);
        maxDD = Math.min(maxDD, cumPnl - peak);

        // End of week (every 5 days)
        if ((d + 1) % 5 === 0) {
          const weekReturn = weekPnl / accountSize;
          if (weekReturn > 0) profitWeeks++;
          if (weekReturn >= weeklyTarget) weeksHit++;
          weekPnl = 0;
        }
      }

      if (weeksHit > 0) targetWeeks++;
      if (maxDD <= -(accountSize * drawdownThreshold)) ruinPaths++;
    }

    const totalWeeks = iterations * simWeeks;
    results.push({
      multiplier: `${mult}x`,
      mult,
      pWeeklyTarget: parseFloat((targetWeeks / iterations * 100).toFixed(1)),
      pWeeklyProfit: parseFloat((profitWeeks / totalWeeks * 100).toFixed(1)),
      pDrawdown:     parseFloat((ruinPaths / iterations * 100).toFixed(1)),
      avgWeeklyReturn: 0, // computed below
    });
  }

  // Find optimal: highest P(target) where P(drawdown) < maxDrawdownProb*100
  const safe = results.filter(r => r.pDrawdown <= maxDrawdownProb * 100);
  const optimal = safe.length > 0
    ? safe.reduce((best, r) => r.pWeeklyTarget > best.pWeeklyTarget ? r : best, safe[0])
    : results[0]; // fallback to lowest multiplier

  return {
    weeklyTarget: `${(weeklyTarget * 100).toFixed(0)}%`,
    drawdownConstraint: `P(${(drawdownThreshold * 100).toFixed(0)}% DD) < ${(maxDrawdownProb * 100).toFixed(0)}%`,
    results,
    optimal: {
      multiplier: optimal.multiplier,
      pWeeklyTarget: optimal.pWeeklyTarget,
      pDrawdown: optimal.pDrawdown,
    },
    recommendation: `Use ${optimal.multiplier} sizing for ${optimal.pWeeklyTarget}% chance of hitting ${(weeklyTarget*100).toFixed(0)}%/week target with ${optimal.pDrawdown}% risk of ${(drawdownThreshold*100).toFixed(0)}% drawdown.`,
  };
}
