/**
 * Reality Checks Module
 *
 * Compares backtest performance against paper trading results.
 * Flags strategies with unrealistic backtest-vs-live ratios.
 * Models overnight gap risk for multi-day holds.
 */

import { query } from '../../src/data/db.js';

/**
 * Load paper trades from DB.
 */
async function loadPaperTrades() {
  try {
    const res = await query(`
      SELECT * FROM lc_v3.paper_trades
      WHERE status IN ('CLOSED', 'EXPIRED')
      ORDER BY entry_time DESC
    `);
    return res.rows;
  } catch {
    return [];
  }
}

/**
 * Compare backtest results against paper trading reality.
 *
 * @param {Array} backtestSignals - all simulated trade results
 * @param {number} accountSize
 * @returns {Object} reality check report
 */
export async function runRealityChecks(backtestSignals, accountSize = 7500) {
  const paperTrades = await loadPaperTrades();

  const report = {
    paperTradesAvailable: paperTrades.length,
    degradationFactor: null,
    strategyFlags: [],
    overnightGapAnalysis: null,
    costImpact: null,
  };

  // 1. Compare backtest vs paper trading performance
  if (paperTrades.length >= 5) {
    report.degradationFactor = computeDegradationFactor(backtestSignals, paperTrades);
  } else {
    report.degradationFactor = { status: 'INSUFFICIENT_DATA', message: `Only ${paperTrades.length} paper trades available (need 5+)` };
  }

  // 2. Flag unrealistic strategies
  report.strategyFlags = flagUnrealisticStrategies(backtestSignals, paperTrades);

  // 3. Overnight gap analysis for multi-day strategies
  report.overnightGapAnalysis = analyzeOvernightGaps(backtestSignals);

  // 4. Cost impact analysis
  report.costImpact = analyzeCostImpact(backtestSignals, accountSize);

  // 5. Overall verdict
  report.verdict = overallVerdict(report);

  return report;
}

/**
 * Match backtest trades to paper trades and compute degradation.
 */
function computeDegradationFactor(backtestSignals, paperTrades) {
  // Match by ticker + direction + similar date
  const matches = [];

  for (const paper of paperTrades) {
    const paperDate = new Date(paper.entry_time).toISOString().split('T')[0];
    const paperTicker = paper.ticker;
    const paperDirection = paper.direction;

    // Find closest backtest signal
    const backtest = backtestSignals.find(b =>
      b.ticker === paperTicker &&
      b.direction === paperDirection &&
      Math.abs(daysDiff(b.date, paperDate)) <= 1
    );

    if (backtest && paper.final_pnl_pct != null) {
      matches.push({
        ticker: paperTicker,
        direction: paperDirection,
        date: paperDate,
        backtestPnlPct: backtest.pnlPct,
        paperPnlPct: parseFloat(paper.final_pnl_pct),
      });
    }
  }

  if (matches.length < 3) {
    return { status: 'INSUFFICIENT_MATCHES', matches: matches.length };
  }

  // Compute degradation ratio: paper / backtest
  const backtestAvg = matches.reduce((a, m) => a + m.backtestPnlPct, 0) / matches.length;
  const paperAvg = matches.reduce((a, m) => a + m.paperPnlPct, 0) / matches.length;
  const ratio = backtestAvg !== 0 ? paperAvg / backtestAvg : 1;

  return {
    status: 'COMPUTED',
    matches: matches.length,
    backtestAvgPnl: parseFloat(backtestAvg.toFixed(2)),
    paperAvgPnl: parseFloat(paperAvg.toFixed(2)),
    degradationRatio: parseFloat(ratio.toFixed(2)),
    interpretation: ratio >= 0.8 ? 'REALISTIC'
      : ratio >= 0.5 ? 'MODERATE_DEGRADATION'
      : 'SIGNIFICANT_DEGRADATION',
  };
}

/**
 * Flag strategies where backtest performance is unrealistically good.
 */
function flagUnrealisticStrategies(backtestSignals, paperTrades) {
  const strategies = [...new Set(backtestSignals.map(s => s.strategy))];
  const flags = [];

  for (const strat of strategies) {
    const stratSigs = backtestSignals.filter(s => s.strategy === strat);
    const wins = stratSigs.filter(s => s.pnlDollars > 0);
    const winRate = stratSigs.length > 0 ? wins.length / stratSigs.length : 0;

    // Flag 1: Win rate > 80% is suspicious for any strategy
    if (winRate > 0.80 && stratSigs.length > 20) {
      flags.push({
        strategy: strat,
        flag: 'SUSPICIOUSLY_HIGH_WIN_RATE',
        detail: `${(winRate * 100).toFixed(1)}% win rate over ${stratSigs.length} trades — possible overfitting`,
      });
    }

    // Flag 2: Average win much larger than average loss (>3x)
    const avgWin = wins.length > 0 ? Math.abs(wins.reduce((a, b) => a + b.pnlDollars, 0) / wins.length) : 0;
    const losses = stratSigs.filter(s => s.pnlDollars < 0);
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b.pnlDollars, 0) / losses.length) : 1;
    if (avgWin > avgLoss * 3 && stratSigs.length > 10) {
      flags.push({
        strategy: strat,
        flag: 'ASYMMETRIC_WINS',
        detail: `Avg win $${Math.round(avgWin)} vs avg loss $${Math.round(avgLoss)} (${(avgWin/avgLoss).toFixed(1)}x) — verify exit logic`,
      });
    }

    // Flag 3: No losing streaks > 2 (unrealistic)
    let maxLosing = 0, currentLosing = 0;
    const sorted = [...stratSigs].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    for (const s of sorted) {
      if (s.pnlDollars < 0) {
        currentLosing++;
        maxLosing = Math.max(maxLosing, currentLosing);
      } else {
        currentLosing = 0;
      }
    }
    if (maxLosing <= 2 && stratSigs.length > 30) {
      flags.push({
        strategy: strat,
        flag: 'NO_LOSING_STREAKS',
        detail: `Max losing streak: ${maxLosing} — real trading has streaks of 5-10+`,
      });
    }
  }

  return flags;
}

/**
 * Analyze overnight gap risk for multi-day strategies.
 */
function analyzeOvernightGaps(signals) {
  const multiDay = signals.filter(s => (s.holdDays || 0) > 0);
  if (multiDay.length === 0) return { status: 'NO_MULTI_DAY_TRADES' };

  const strategies = [...new Set(multiDay.map(s => s.strategy))];
  const analysis = {};

  for (const strat of strategies) {
    const stratSigs = multiDay.filter(s => s.strategy === strat);

    // Estimate gap risk from ATR
    const avgATR = stratSigs.reduce((a, s) => a + (s.atr || 0.025), 0) / stratSigs.length;
    const avgHoldDays = stratSigs.reduce((a, s) => a + (s.holdDays || 1), 0) / stratSigs.length;

    // Expected overnight gap: 0.5-1.0x daily ATR
    const expectedGap = avgATR * 0.75;
    const gapsOverHold = expectedGap * avgHoldDays;

    // With spreads, max loss is capped, so gap risk is bounded
    const avgSpreadWidth = stratSigs.reduce((a, s) => a + (s.spreadWidth || 2.5), 0) / stratSigs.length;

    analysis[strat] = {
      trades: stratSigs.length,
      avgHoldDays: parseFloat(avgHoldDays.toFixed(1)),
      avgATR: parseFloat((avgATR * 100).toFixed(2)) + '%',
      expectedOvernightGap: parseFloat((expectedGap * 100).toFixed(2)) + '%',
      totalGapExposure: parseFloat((gapsOverHold * 100).toFixed(2)) + '%',
      spreadCap: `Max loss capped at $${avgSpreadWidth.toFixed(2)}/share regardless of gap`,
      risk: gapsOverHold > 0.03 ? 'ELEVATED' : 'MANAGEABLE',
    };
  }

  return analysis;
}

/**
 * Analyze the impact of realistic execution costs on profitability.
 */
function analyzeCostImpact(signals, accountSize) {
  const totalPnl = signals.reduce((a, b) => a + b.pnlDollars, 0);
  const totalCommissions = signals.reduce((a, b) => a + (b.commissions || 0), 0);
  const totalSlippage = signals.reduce((a, b) => a + (b.slippage || 0), 0);
  const totalCosts = totalCommissions + totalSlippage;
  const grossPnl = signals.reduce((a, b) => a + (b.grossPnl || b.pnlDollars + (b.commissions || 0) + (b.slippage || 0)), 0);

  return {
    grossPnl: Math.round(grossPnl),
    totalCommissions: Math.round(totalCommissions),
    totalSlippage: Math.round(totalSlippage),
    totalCosts: Math.round(totalCosts),
    netPnl: Math.round(totalPnl),
    costAsPctOfGross: grossPnl !== 0 ? parseFloat((totalCosts / Math.abs(grossPnl) * 100).toFixed(1)) : 0,
    costPerTrade: signals.length > 0 ? parseFloat((totalCosts / signals.length).toFixed(2)) : 0,
    breakEvenTrades: totalCosts > 0 && signals.length > 0
      ? Math.max(0, Math.ceil(totalCosts / Math.max(1, totalPnl / signals.length)))
      : 0,
  };
}

function overallVerdict(report) {
  const issues = [];

  if (report.degradationFactor?.interpretation === 'SIGNIFICANT_DEGRADATION') {
    issues.push('Paper trading shows significant underperformance vs backtest');
  }

  if (report.strategyFlags.length > 2) {
    issues.push(`${report.strategyFlags.length} suspicious patterns detected`);
  }

  if (report.costImpact?.costAsPctOfGross > 30) {
    issues.push('Execution costs consume >30% of gross P&L');
  }

  if (issues.length === 0) return { status: 'PASS', detail: 'No major red flags detected' };
  if (issues.length <= 2) return { status: 'CAUTION', detail: issues.join('; ') };
  return { status: 'FAIL', detail: issues.join('; ') };
}

function daysDiff(d1, d2) {
  return Math.abs(Math.round((new Date(d2) - new Date(d1)) / (1000 * 60 * 60 * 24)));
}
