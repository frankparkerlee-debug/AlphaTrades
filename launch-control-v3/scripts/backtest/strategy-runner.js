/**
 * Multi-Strategy Backtest Runner
 *
 * Orchestrates all 5 strategies, applies portfolio constraints,
 * simulates spread P&L, and feeds validation pipeline.
 *
 * Returns a unified results object for frontend consumption.
 */

import { fetchAllDataFromDB } from './data-fetcher-db.js';
import { fetchAllData } from './data-fetcher.js';
import { loadStrategyData } from './strategy-data-loader.js';
import { simulateAllSpreads } from './spread-pnl.js';
import { splitTrainTest, reportSideBySide } from './oos-split.js';
import { runMonteCarlo } from './monte-carlo.js';
import { runWalkForward } from './walk-forward.js';
import { runRegimeStress } from './regime-stress.js';
import { runSensitivity } from './sensitivity.js';
import { analyzeEntryExitQuality } from './entry-exit-analysis.js';
import { runStatisticalTests } from './statistical-tests.js';
import { query } from '../../src/data/db.js';

// Strategy imports
import { generateA1Signals } from './strategies/a1-fresh-momentum.js';
import { generateA2Signals } from './strategies/a2-cluster-lag.js';
import { generateA3Signals } from './strategies/a3-overextension-reversal.js';
import { generateB1Signals } from './strategies/b1-iv-premium.js';
import { generateB2Signals } from './strategies/b2-post-earnings-drift.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const MAX_CONCURRENT_POSITIONS = 5;    // max open positions at once
const MAX_DAILY_RISK_PCT       = 0.10; // max 10% of account at risk per day
const STRATEGIES = [
  { name: 'A1_FRESH_MOMENTUM',          fn: generateA1Signals,  intraday: true },
  { name: 'A2_CLUSTER_LAG',             fn: generateA2Signals,  intraday: true },
  { name: 'A3_OVEREXTENSION_REVERSAL',  fn: generateA3Signals,  intraday: true },
  { name: 'B1_IV_PREMIUM',              fn: generateB1Signals,  intraday: false },
  { name: 'B2_POST_EARNINGS_DRIFT',     fn: generateB2Signals,  intraday: false },
];

/**
 * Run multi-strategy backtest.
 *
 * @param {string} startDate
 * @param {string} endDate
 * @param {number} accountSize
 * @param {string[]|null} tickerFilter
 * @returns {Object} full results
 */
export async function runMultiStrategyBacktest(startDate, endDate, accountSize = 7500, tickerFilter = null) {
  console.log(`\n[MULTI-STRAT] Running ${startDate} -> ${endDate}, account $${accountSize}`);
  console.log(`[MULTI-STRAT] Strategies: ${STRATEGIES.map(s => s.name).join(', ')}`);

  // 1. Load equity profiles
  const profileRes = await query('SELECT * FROM lc_v3.equity_profiles');
  const profiles = {};
  for (const row of profileRes.rows) {
    profiles[row.ticker] = {
      ticker:     row.ticker,
      atr_20d:    parseFloat(row.atr_20d || 0.025),
      atr_5d:     parseFloat(row.atr_5d || 0.025),
      sector_etf: row.sector_etf || null,
    };
  }

  let tickers = tickerFilter || Object.keys(profiles);
  tickers = tickers.filter(t => profiles[t]);
  console.log(`[MULTI-STRAT] ${tickers.length} tickers`);

  // 2. Fetch bar data
  const config = { startDate, endDate, tickers, accountSize };
  let data;
  try {
    console.log('[MULTI-STRAT] Fetching bar data from DB...');
    data = await fetchAllDataFromDB(config, tickers);
    if (!data.tradingDays || data.tradingDays.length === 0) {
      console.log('[MULTI-STRAT] No bars in DB — falling back to API...');
      data = await fetchAllData(config, tickers);
    }
  } catch (err) {
    console.log(`[MULTI-STRAT] DB fetch failed: ${err.message} — falling back to API...`);
    data = await fetchAllData(config, tickers);
  }

  console.log(`[MULTI-STRAT] ${data.tradingDays.length} trading days loaded`);

  // 3. Load strategy intelligence data
  console.log('[MULTI-STRAT] Loading strategy intelligence data...');
  const stratData = await loadStrategyData(startDate, endDate, tickers);

  // Merge profiles
  for (const [ticker, extended] of Object.entries(stratData.profiles)) {
    profiles[ticker] = { ...profiles[ticker], ...extended };
  }

  // 4. Generate signals for each strategy across all trading days
  console.log('[MULTI-STRAT] Generating signals...');
  const allSignals = [];

  for (const day of data.tradingDays) {
    const dayData = {
      minuteBars:    data.minuteBars,
      etfMinuteBars: data.etfMinuteBars,
      dailyBars:     data.dailyBars,
      vixByTime:     data.vixByTime,
      tradingDays:   data.tradingDays,
    };

    const context = {
      profiles,
      intelligence: stratData.intelligence,
      contagionMap:  stratData.contagionMap,
      secFilings:    stratData.secFilings,
      ivHistory:     stratData.ivHistory,
      earningsCalendar: stratData.earningsCalendar,
      tickers,
    };

    for (const strat of STRATEGIES) {
      try {
        const signals = strat.fn(day, dayData, context);
        allSignals.push(...signals);
      } catch (err) {
        console.log(`[MULTI-STRAT] ${strat.name} error on ${day}: ${err.message}`);
        console.log(`[MULTI-STRAT] Stack: ${err.stack?.split('\n').slice(0, 3).join(' | ')}`);
      }
    }
  }

  console.log(`[MULTI-STRAT] Total signals generated: ${allSignals.length}`);

  // 5. Apply portfolio constraints
  const constrained = applyPortfolioConstraints(allSignals, accountSize);
  console.log(`[MULTI-STRAT] After constraints: ${constrained.length} signals`);

  if (constrained.length === 0) {
    return buildEmptyResults(config);
  }

  // 6. Simulate spread P&L
  console.log('[MULTI-STRAT] Simulating spread P&L...');
  const results = simulateAllSpreads(constrained, data.rawMinuteBars, { accountSize });
  console.log(`[MULTI-STRAT] ${results.length} trades simulated`);

  // 7. Build results
  const output = buildMultiStratResults(results, config, data.tradingDays);

  // 8. Out-of-sample split
  console.log('[MULTI-STRAT] Running out-of-sample validation...');
  const split = splitTrainTest(results, data.tradingDays);
  output.outOfSample = reportSideBySide(split, accountSize);
  console.log(`[MULTI-STRAT] OOS verdict: ${output.outOfSample.verdict}`);

  // 9. Monte Carlo (on full set, then on OOS only)
  console.log('[MULTI-STRAT] Running Monte Carlo...');
  output.monteCarlo = runMonteCarlo(output);
  console.log(`[MULTI-STRAT] MC P(profit): ${output.monteCarlo.base?.probability?.profit}%`);

  // 10. Walk-forward
  console.log('[MULTI-STRAT] Running walk-forward validation...');
  output.walkForward = runWalkForward(output);

  // 11. Regime stress
  console.log('[MULTI-STRAT] Running regime stress...');
  output.regimeStress = runRegimeStress(output);

  // 12. Sensitivity
  console.log('[MULTI-STRAT] Running sensitivity analysis...');
  output.sensitivity = runSensitivity(output);

  // 13. Entry/exit quality (MFE/MAE analysis)
  console.log('[MULTI-STRAT] Running entry/exit quality analysis...');
  output.entryExitQuality = analyzeEntryExitQuality(output);

  // 14. Institutional statistical tests (DSR, t-test, block bootstrap, CVaR, benchmark)
  console.log('[MULTI-STRAT] Running statistical significance tests...');
  output.statisticalTests = runStatisticalTests(output);

  console.log(`[MULTI-STRAT] Backtest complete.\n`);
  return output;
}

// ── Portfolio Constraints ──────────────────────────────────────────────────────

function applyPortfolioConstraints(signals, accountSize) {
  // Sort by date/time, then apply concurrent position limits
  const sorted = [...signals].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.time || '').localeCompare(b.time || '');
  });

  const accepted = [];
  const activeByDate = {};  // date -> active count
  const dailyRisk = {};     // date -> total risk dollars

  for (const sig of sorted) {
    const date = sig.date;
    if (!activeByDate[date]) activeByDate[date] = 0;
    if (!dailyRisk[date]) dailyRisk[date] = 0;

    // Max concurrent positions per day
    if (activeByDate[date] >= MAX_CONCURRENT_POSITIONS) continue;

    // Max daily risk
    const tradeRisk = accountSize * (sig.sizePct || 0.10);
    if (dailyRisk[date] + tradeRisk > accountSize * MAX_DAILY_RISK_PCT) continue;

    // One signal per ticker per strategy per day
    const dupeKey = `${date}:${sig.ticker}:${sig.strategy}`;
    if (accepted.some(a => `${a.date}:${a.ticker}:${a.strategy}` === dupeKey)) continue;

    activeByDate[date]++;
    dailyRisk[date] += tradeRisk;
    accepted.push(sig);
  }

  return accepted;
}

// ── Results Builder ────────────────────────────────────────────────────────────

function buildMultiStratResults(results, config, tradingDays) {
  const total = results.length;
  const wins = results.filter(r => r.pnlDollars > 0);
  const losses = results.filter(r => r.pnlDollars < 0);
  const totalPnl = results.reduce((a, b) => a + b.pnlDollars, 0);
  const totalPnlPct = config.accountSize > 0 ? (totalPnl / config.accountSize) * 100 : 0;
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;

  const grossWins = wins.reduce((a, b) => a + b.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnlDollars, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);

  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length : 0;
  const avgHold = total > 0 ? Math.round(results.reduce((a, b) => a + (b.holdMinutes || 0), 0) / total) : 0;

  // Equity curve + drawdown
  let peak = 0, maxDD = 0, cumPnl = 0;
  const equityCurve = [];
  const byDate = {};
  for (const r of results) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }
  for (const date of Object.keys(byDate).sort()) {
    const dayPnl = byDate[date].reduce((a, b) => a + b.pnlDollars, 0);
    cumPnl += dayPnl;
    peak = Math.max(peak, cumPnl);
    maxDD = Math.min(maxDD, cumPnl - peak);
    equityCurve.push({ date, dayPnl, cumPnl, signals: byDate[date].length });
  }
  const maxDDPct = config.accountSize > 0 ? (maxDD / config.accountSize) * 100 : 0;

  // Total costs
  const totalCommissions = results.reduce((a, b) => a + (b.commissions || 0), 0);
  const totalSlippage = results.reduce((a, b) => a + (b.slippage || 0), 0);

  // By strategy
  const stratNames = [...new Set(results.map(r => r.strategy))];
  const byStrategy = {};
  for (const strat of stratNames) {
    const stratSigs = results.filter(r => r.strategy === strat);
    const stratWins = stratSigs.filter(r => r.pnlDollars > 0);
    const stratGrossWin = stratWins.reduce((a, b) => a + b.pnlDollars, 0);
    const stratGrossLoss = Math.abs(stratSigs.filter(r => r.pnlDollars < 0).reduce((a, b) => a + b.pnlDollars, 0));

    byStrategy[strat] = {
      count: stratSigs.length,
      winRate: stratSigs.length > 0 ? parseFloat((stratWins.length / stratSigs.length * 100).toFixed(1)) : 0,
      totalPnl: stratSigs.reduce((a, b) => a + b.pnlDollars, 0),
      avgPnl: stratSigs.length > 0 ? Math.round(stratSigs.reduce((a, b) => a + b.pnlDollars, 0) / stratSigs.length) : 0,
      profitFactor: stratGrossLoss > 0 ? parseFloat((stratGrossWin / stratGrossLoss).toFixed(2)) : (stratGrossWin > 0 ? 999 : 0),
      avgHoldMinutes: stratSigs.length > 0 ? Math.round(stratSigs.reduce((a, b) => a + (b.holdMinutes || 0), 0) / stratSigs.length) : 0,
      commissions: stratSigs.reduce((a, b) => a + (b.commissions || 0), 0),
    };
  }

  // By grade
  const grades = ['A+', 'A', 'A-', 'B+', 'B'];
  const byGrade = {};
  for (const g of grades) {
    const gSigs = results.filter(r => r.grade === g);
    const gWins = gSigs.filter(r => r.pnlDollars > 0);
    byGrade[g] = {
      count: gSigs.length,
      winRate: gSigs.length > 0 ? parseFloat((gWins.length / gSigs.length * 100).toFixed(1)) : 0,
      pnl: gSigs.reduce((a, b) => a + b.pnlDollars, 0),
    };
  }

  // By exit type
  const exitTypes = [...new Set(results.map(r => r.exitType))];
  const byExit = {};
  for (const et of exitTypes) {
    const eSigs = results.filter(r => r.exitType === et);
    byExit[et] = {
      count: eSigs.length,
      pct: total > 0 ? parseFloat((eSigs.length / total * 100).toFixed(1)) : 0,
      pnl: eSigs.reduce((a, b) => a + b.pnlDollars, 0),
    };
  }

  // Direction stats
  const calls = results.filter(r => r.direction === 'CALL');
  const puts = results.filter(r => r.direction === 'PUT');
  const neutrals = results.filter(r => r.direction === 'NEUTRAL');

  // Weekly P&L for target analysis
  const weeklyPnls = computeWeeklyPnls(equityCurve, config.accountSize);
  const weeklyReturn = weeklyPnls.map(w => w.pnlPct);
  const weeksAbove15 = weeklyReturn.filter(r => r >= 15).length;
  const weeksAbove20 = weeklyReturn.filter(r => r >= 20).length;

  return {
    config: {
      startDate: config.startDate,
      endDate: config.endDate,
      accountSize: config.accountSize,
      tickerCount: new Set(results.map(r => r.ticker)).size,
      tradingDays: tradingDays.length,
      strategies: stratNames,
    },
    summary: {
      totalSignals: total,
      signalsPerDay: parseFloat((total / Math.max(1, tradingDays.length)).toFixed(1)),
      winRate: parseFloat(winRate.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      totalPnlDollars: totalPnl,
      totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
      maxDrawdownDollars: maxDD,
      maxDrawdownPct: parseFloat(maxDDPct.toFixed(2)),
      avgWinPct: parseFloat(avgWin.toFixed(2)),
      avgLossPct: parseFloat(avgLoss.toFixed(2)),
      avgHoldMinutes: avgHold,
      calls: calls.length,
      callWinRate: calls.length > 0 ? parseFloat((calls.filter(r => r.pnlDollars > 0).length / calls.length * 100).toFixed(1)) : 0,
      puts: puts.length,
      putWinRate: puts.length > 0 ? parseFloat((puts.filter(r => r.pnlDollars > 0).length / puts.length * 100).toFixed(1)) : 0,
      neutrals: neutrals.length,
      totalCommissions: Math.round(totalCommissions),
      totalSlippage: Math.round(totalSlippage),
      totalCosts: Math.round(totalCommissions + totalSlippage),
    },
    weeklyPerformance: {
      weeks: weeklyPnls,
      avgWeeklyReturn: weeklyReturn.length > 0 ? parseFloat((weeklyReturn.reduce((a, b) => a + b, 0) / weeklyReturn.length).toFixed(2)) : 0,
      weeksAbove15Pct: weeksAbove15,
      weeksAbove20Pct: weeksAbove20,
      hitRateFor15Pct: weeklyReturn.length > 0 ? parseFloat((weeksAbove15 / weeklyReturn.length * 100).toFixed(1)) : 0,
      hitRateFor20Pct: weeklyReturn.length > 0 ? parseFloat((weeksAbove20 / weeklyReturn.length * 100).toFixed(1)) : 0,
    },
    byStrategy,
    byGrade,
    byExit,
    equityCurve,
    signals: results.map(r => ({
      strategy: r.strategy, date: r.date, time: r.time,
      ticker: r.ticker, direction: r.direction, grade: r.grade,
      composite: r.composite, freshness: r.freshness,
      regime: r.regime, signalType: r.signalType,
      entryPrice: r.entryPrice, exitType: r.exitType,
      pnlPct: r.pnlPct, pnlDollars: r.pnlDollars,
      holdMinutes: r.holdMinutes, scores: r.scores,
      spreadType: r.spreadType, contracts: r.contracts,
      commissions: r.commissions,
      mfePct: r.mfePct, maePct: r.maePct,
      exitEfficiency: r.exitEfficiency,
    })),
  };
}

function buildEmptyResults(config) {
  return {
    config: {
      startDate: config.startDate,
      endDate: config.endDate,
      accountSize: config.accountSize,
      tickerCount: 0,
      tradingDays: 0,
      strategies: [],
    },
    summary: {
      totalSignals: 0, signalsPerDay: 0, winRate: 0, profitFactor: 0,
      totalPnlDollars: 0, totalPnlPct: 0, maxDrawdownDollars: 0, maxDrawdownPct: 0,
      avgWinPct: 0, avgLossPct: 0, avgHoldMinutes: 0,
      calls: 0, callWinRate: 0, puts: 0, putWinRate: 0, neutrals: 0,
      totalCommissions: 0, totalSlippage: 0, totalCosts: 0,
    },
    weeklyPerformance: {
      weeks: [], avgWeeklyReturn: 0,
      weeksAbove15Pct: 0, weeksAbove20Pct: 0,
      hitRateFor15Pct: 0, hitRateFor20Pct: 0,
    },
    byStrategy: {}, byGrade: {}, byExit: {},
    equityCurve: [], signals: [],
  };
}

function computeWeeklyPnls(equityCurve, accountSize = 7500) {
  if (equityCurve.length === 0) return [];

  const weeks = [];
  let weekStart = null;
  let weekPnl = 0;
  let weekSignals = 0;

  for (const day of equityCurve) {
    const dow = new Date(day.date).getDay();

    // New week (Monday or first day)
    if (dow === 1 || weekStart === null) {
      if (weekStart !== null) {
        weeks.push({ weekStart, pnl: weekPnl, signals: weekSignals });
      }
      weekStart = day.date;
      weekPnl = 0;
      weekSignals = 0;
    }

    weekPnl += day.dayPnl;
    weekSignals += day.signals;
  }

  // Last incomplete week
  if (weekStart !== null) {
    weeks.push({ weekStart, pnl: weekPnl, signals: weekSignals });
  }

  return weeks.map(w => ({
    ...w,
    pnlPct: parseFloat((w.pnl / 7500 * 100).toFixed(2)),
  }));
}
