/**
 * Multi-Strategy Backtest Runner
 *
 * 4 focused strategies with academic backing and TA-driven entries:
 *   ORB_BREAKOUT, GAP_FILL_REVERSION, POWER_HOUR_MOMENTUM, MOMENTUM_SCALP
 *
 * Applies portfolio constraints, simulates single-leg P&L, and feeds
 * validation pipeline.
 *
 * Returns a unified results object for frontend consumption.
 */

import { fetchAllDataFromDB } from './data-fetcher-db.js';
import { fetchAllData } from './data-fetcher.js';
import { loadStrategyData } from './strategy-data-loader.js';
import { simulateAllSpreads } from './spread-pnl.js';
import { clearCorrelationCache } from './correlation-engine.js';
import { splitTrainTest, reportSideBySide } from './oos-split.js';
import { runMonteCarlo } from './monte-carlo.js';
import { runWalkForward } from './walk-forward.js';
import { runRegimeStress } from './regime-stress.js';
import { runSensitivity } from './sensitivity.js';
import { analyzeEntryExitQuality } from './entry-exit-analysis.js';
import { runStatisticalTests } from './statistical-tests.js';
import { scoreSetupQuality } from './setup-quality.js';
import { calibrateGrades } from './grade-calibrator.js';
import { buildReportCard, deriveDeploymentVerdict } from './strategy-report-card.js';
import { runDirectionalStudy } from './directional-study.js';
import { query } from '../../src/data/db.js';

// Spread-based strategies decommissioned — margin account, no documented edge

// 4 focused strategies — academic backing + TA-driven entries
import {
  generateORBBreakoutSignals,
  generateGapFillSignals,
  generatePowerHourMomentumSignals,
  generateMomentumScalpSignals,
} from './strategies/live-adapter.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const MAX_CONCURRENT_POSITIONS = 5;    // max open positions at once
const MAX_DAILY_RISK_PCT       = 0.40; // max 40% of account at risk per day

// Active strategies — POWER_HOUR SHELVE'd (23% WR, 0.34 PF, hogged all slots at A+)
const STRATEGIES = [
  { name: 'ORB_BREAKOUT',          fn: generateORBBreakoutSignals,       intraday: true },  // DEPLOY: 68% WR, 1.97 PF, MC 89.5%
  { name: 'GAP_FILL_REVERSION',    fn: generateGapFillSignals,           intraday: true },  // 100% directional, tuning needed
  { name: 'MOMENTUM_SCALP',        fn: generateMomentumScalpSignals,     intraday: true },  // 92.7% directional, was blocked by POWER_HOUR
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

  // Clear correlation engine cache between runs
  clearCorrelationCache();

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

  // Include ETFs (SPY, QQQ, IWM) in scanning universe for scalp strategies.
  // They have minute bars in etfMinuteBars and are high-liquidity targets.
  const ETF_TICKERS = ['SPY', 'QQQ', 'IWM'];
  for (const etf of ETF_TICKERS) {
    if (!profiles[etf]) {
      profiles[etf] = {
        ticker: etf,
        atr_20d: 0.012,       // ETFs have lower volatility than individual stocks
        atr_5d: 0.012,
        sector_etf: null,
        avg_volume_20d: 80000000, // high liquidity
        avg_volume: 80000000,
        options_liquidity_score: 1.0,
      };
    }
  }

  let tickers = tickerFilter || Object.keys(profiles);
  tickers = tickers.filter(t => profiles[t]);
  console.log(`[MULTI-STRAT] ${tickers.length} tickers (including ETFs: ${ETF_TICKERS.join(', ')})`);

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

  // 3b. Merge ETF bars into minuteBars so strategies can scan SPY/QQQ/IWM
  for (const etf of ETF_TICKERS) {
    if (data.etfMinuteBars[etf] && !data.minuteBars[etf]) {
      data.minuteBars[etf] = data.etfMinuteBars[etf];
    }
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

  // Log per-strategy signal counts for diagnostics
  const signalCounts = {};
  for (const s of allSignals) {
    signalCounts[s.strategy] = (signalCounts[s.strategy] || 0) + 1;
  }
  console.log(`[MULTI-STRAT] Total signals generated: ${allSignals.length}`);
  for (const [strat, count] of Object.entries(signalCounts)) {
    console.log(`[MULTI-STRAT]   ${strat}: ${count} signals`);
  }
  // 5. Apply portfolio constraints
  const constrained = applyPortfolioConstraints(allSignals, accountSize);
  console.log(`[MULTI-STRAT] After constraints: ${constrained.length} signals`);

  if (constrained.length === 0) {
    return buildEmptyResults(config);
  }

  // 5b. Validate entries — does the underlying actually move in the right direction?
  console.log('[MULTI-STRAT] Validating entry quality (underlying price action)...');
  const entryValidation = validateEntries(constrained, data.rawMinuteBars);

  // 6. Simulate spread P&L
  console.log('[MULTI-STRAT] Simulating spread P&L...');
  const results = simulateAllSpreads(constrained, data.rawMinuteBars, { accountSize });
  console.log(`[MULTI-STRAT] ${results.length} trades simulated`);

  // Exit type diagnostics
  const exitCounts = {};
  for (const r of results) exitCounts[r.exitType] = (exitCounts[r.exitType] || 0) + 1;
  console.log(`[MULTI-STRAT] Exit types: ${JSON.stringify(exitCounts)}`);
  // Sample first 3 trades for debugging
  for (const r of results.slice(0, 3)) {
    console.log(`[MULTI-STRAT] SAMPLE: ${r.ticker} ${r.direction} ${r.strategy} entry=$${r.entryPrice} exit=$${r.exitPrice} type=${r.exitType} hold=${r.holdMinutes}m pnl=$${r.pnlDollars} contracts=${r.contracts} spread=${r.spreadDetails?.type} stopCond=${JSON.stringify(r.stopCondition)} premium=${r.spreadDetails?.premium?.toFixed(2)}`);
  }

  // 7. Build results
  const output = buildMultiStratResults(results, config, data.tradingDays);
  output.entryValidation = entryValidation;

  // 7b. Directional study — raw price movement independent of option PnL
  console.log('[MULTI-STRAT] Running directional study (raw price movement)...');
  output.directionalStudy = runDirectionalStudy(constrained, data.minuteBars, data.etfMinuteBars);

  // ── 8-14: AGGREGATE validation (full portfolio) ──────────────────────────
  console.log('[MULTI-STRAT] Running aggregate validation pipeline...');

  console.log('[MULTI-STRAT]   Out-of-sample split...');
  const split = splitTrainTest(results, data.tradingDays);
  output.outOfSample = reportSideBySide(split, accountSize);
  console.log(`[MULTI-STRAT]   OOS verdict: ${output.outOfSample.verdict}`);

  console.log('[MULTI-STRAT]   Monte Carlo...');
  output.monteCarlo = runMonteCarlo(output);
  console.log(`[MULTI-STRAT]   MC P(profit): ${output.monteCarlo.base?.probability?.profit}%`);

  console.log('[MULTI-STRAT]   Walk-forward...');
  output.walkForward = runWalkForward(output);

  console.log('[MULTI-STRAT]   Regime stress...');
  output.regimeStress = runRegimeStress(output);

  console.log('[MULTI-STRAT]   Sensitivity...');
  output.sensitivity = runSensitivity(output);

  console.log('[MULTI-STRAT]   Entry/exit quality...');
  output.entryExitQuality = analyzeEntryExitQuality(output);

  console.log('[MULTI-STRAT]   Statistical tests...');
  output.statisticalTests = runStatisticalTests(output);

  // ── 15: PER-STRATEGY validation + report cards ─────────────────────────
  // Each strategy gets its own full validation suite so weak strategies
  // can't hide behind strong ones. Strategies that fail validation
  // individually should be removed or reworked.
  console.log('[MULTI-STRAT] Running per-strategy validation + report cards...');
  output.strategyValidation = {};
  output.strategyReportCards = {};
  output.gradeCalibrations = {};

  const stratNames = [...new Set(results.map(r => r.strategy))];
  for (const stratName of stratNames) {
    const stratSignals = results.filter(r => r.strategy === stratName);
    if (stratSignals.length < 5) {
      output.strategyValidation[stratName] = {
        signalCount: stratSignals.length,
        verdict: 'INSUFFICIENT_DATA',
        note: `Only ${stratSignals.length} signals — need 5+ for validation`,
      };
      output.strategyReportCards[stratName] = {
        strategy: stratName,
        signalCount: stratSignals.length,
        verdict: { decision: 'INSUFFICIENT_DATA' },
      };
      console.log(`[MULTI-STRAT]   ${stratName}: ${stratSignals.length} signals — skipped (insufficient)`);
      continue;
    }

    // Score setup quality for each signal
    for (const sig of stratSignals) {
      const sq = scoreSetupQuality(sig);
      sig.setupQuality = sq.score;
      sig.setupFactors = sq.factors;
    }

    // Build a mini-output object for this strategy only
    const stratOutput = buildMultiStratResults(stratSignals, config, data.tradingDays);

    const validation = {
      signalCount: stratSignals.length,
      summary: stratOutput.summary,
    };

    // Monte Carlo — does this strategy have an edge on its own?
    if (stratSignals.length >= 10) {
      validation.monteCarlo = runMonteCarlo(stratOutput);
    }

    // Walk-forward — is it overfit?
    if (stratSignals.length >= 20) {
      validation.walkForward = runWalkForward(stratOutput);
    }

    // Regime stress — does it survive all conditions?
    if (stratSignals.length >= 10) {
      validation.regimeStress = runRegimeStress(stratOutput);
    }

    // Entry/exit quality — are entries well-timed?
    if (stratSignals.length >= 5) {
      validation.entryExitQuality = analyzeEntryExitQuality(stratOutput);
    }

    // Statistical significance — is the edge real or noise?
    if (stratSignals.length >= 10) {
      validation.statisticalTests = runStatisticalTests(stratOutput);
    }

    // Out-of-sample — train/test consistency
    if (stratSignals.length >= 15) {
      const stratSplit = splitTrainTest(stratSignals, data.tradingDays);
      validation.outOfSample = reportSideBySide(stratSplit, accountSize);
    }

    // Calibrate grades for this strategy
    const calibration = calibrateGrades(stratName, stratSignals);
    output.gradeCalibrations[stratName] = calibration;

    // Build report card with three-phase scores
    const reportCard = buildReportCard(stratName, stratSignals, validation, entryValidation, calibration);

    // Derive verdict (DEPLOY/REFINE/SHELVE) — replaces old deriveStrategyVerdict
    const verdict = deriveDeploymentVerdict(reportCard);
    reportCard.verdict = verdict;
    output.strategyReportCards[stratName] = reportCard;

    // Also store legacy validation for backward compatibility
    validation.verdict = verdict.decision;
    validation.demerits = verdict.demerits;
    validation.flags = verdict.weaknesses;
    output.strategyValidation[stratName] = validation;

    const mc = validation.monteCarlo?.base?.probability?.profit;
    const wr = validation.summary?.winRate;
    const pf = validation.summary?.profitFactor;
    const setupAvg = reportCard.phases?.setup?.avgScore ?? 'N/A';
    const dirPct = reportCard.phases?.direction?.dirCorrectPct ?? 'N/A';
    const exitAvg = reportCard.phases?.exit?.avgScore ?? 'N/A';
    console.log(`[MULTI-STRAT]   ${stratName}: ${stratSignals.length} sigs | WR=${wr}% PF=${pf} MC=${mc || 'N/A'}% | Setup=${setupAvg} Dir=${dirPct}% Exit=${exitAvg} | Cal=${calibration.calibrationQuality} → ${verdict.decision} (net=${verdict.netScore}: +${verdict.merits}/-${verdict.demerits})`);
  }

  console.log(`[MULTI-STRAT] Backtest complete.\n`);
  return output;
}

// ── Entry Validation ─────────────────────────────────────────────────────────
// Check if the underlying price action after entry supports the signal direction.
// This is independent of option pricing — pure directional edge check.

function validateEntries(signals, rawMinuteBars) {
  const results = [];

  for (const signal of signals) {
    const tickerBars = rawMinuteBars[signal.ticker] || [];
    const rawTime = signal.time.length <= 16 ? signal.time + ':00Z' : signal.time;
    const signalTimeMs = new Date(rawTime).getTime();
    const signalDate = signal.date;

    // Get bars after entry, same day
    const allRemaining = tickerBars.filter(b => {
      const bt = new Date(b.t).getTime();
      const bd = new Date(b.t).toISOString().split('T')[0];
      return bd === signalDate && bt > signalTimeMs;
    }).sort((a, b) => new Date(a.t) - new Date(b.t));

    if (allRemaining.length === 0) {
      results.push({ ...signal, barsAfter: 0, maxFav: 0, maxAdv: 0, holdWindowMove: 0, dirCorrect: false });
      continue;
    }

    // Filter to strategy's actual hold window (not EOD)
    const holdMinutes = signal.maxHoldMinutes || 60;
    const holdWindowMs = holdMinutes * 60000;
    const holdWindowBars = allRemaining.filter(b => {
      const bt = new Date(b.t).getTime();
      return (bt - signalTimeMs) <= holdWindowMs;
    });
    // Use hold window bars if available, fall back to all remaining
    const remaining = holdWindowBars.length > 0 ? holdWindowBars : allRemaining;

    const mult = signal.direction === 'CALL' ? 1 : -1;
    const entry = signal.entryPrice;
    let maxFav = 0, maxAdv = 0;

    for (const bar of remaining) {
      const favHigh = ((signal.direction === 'CALL' ? bar.h : bar.l) - entry) * mult;
      const advLow = ((signal.direction === 'CALL' ? bar.l : bar.h) - entry) * mult;
      maxFav = Math.max(maxFav, favHigh);
      maxAdv = Math.min(maxAdv, advLow);
    }

    // Measure direction at end of hold window, not EOD
    const windowClose = remaining[remaining.length - 1].c;
    const holdWindowMove = (windowClose - entry) * mult;
    const maxFavPct = (maxFav / entry) * 100;
    const holdWindowMovePct = (holdWindowMove / entry) * 100;

    results.push({
      ticker: signal.ticker,
      strategy: signal.strategy,
      direction: signal.direction,
      date: signal.date,
      entry,
      holdMinutes,
      barsAfter: remaining.length,
      maxFavPct: +maxFavPct.toFixed(2),
      maxAdvPct: +((maxAdv / entry) * 100).toFixed(2),
      holdWindowMovePct: +holdWindowMovePct.toFixed(2),
      dirCorrect: holdWindowMove > 0,
      everFavorable: maxFav > 0,
    });
  }

  // Summarize
  const total = results.length;
  const dirCorrect = results.filter(r => r.dirCorrect).length;
  const everFav = results.filter(r => r.everFavorable).length;
  const noBars = results.filter(r => r.barsAfter === 0).length;
  const avgMaxFav = total > 0 ? results.reduce((a, b) => a + b.maxFavPct, 0) / total : 0;
  const avgHoldWindowMove = total > 0 ? results.reduce((a, b) => a + b.holdWindowMovePct, 0) / total : 0;

  // By strategy
  const byStrategy = {};
  const stratNames = [...new Set(results.map(r => r.strategy))];
  for (const strat of stratNames) {
    const s = results.filter(r => r.strategy === strat);
    byStrategy[strat] = {
      count: s.length,
      dirCorrectPct: s.length > 0 ? +(s.filter(r => r.dirCorrect).length / s.length * 100).toFixed(1) : 0,
      everFavPct: s.length > 0 ? +(s.filter(r => r.everFavorable).length / s.length * 100).toFixed(1) : 0,
      avgMaxFavPct: s.length > 0 ? +(s.reduce((a, b) => a + b.maxFavPct, 0) / s.length).toFixed(2) : 0,
      avgHoldWindowMovePct: s.length > 0 ? +(s.reduce((a, b) => a + b.holdWindowMovePct, 0) / s.length).toFixed(2) : 0,
      noBars: s.filter(r => r.barsAfter === 0).length,
    };
  }

  // By direction
  const calls = results.filter(r => r.direction === 'CALL');
  const puts = results.filter(r => r.direction === 'PUT');

  const summary = {
    total,
    noBars,
    dirCorrectPct: total > 0 ? +(dirCorrect / total * 100).toFixed(1) : 0,
    everFavorablePct: total > 0 ? +(everFav / total * 100).toFixed(1) : 0,
    avgMaxFavPct: +avgMaxFav.toFixed(2),
    avgHoldWindowMovePct: +avgHoldWindowMove.toFixed(2),
    calls: {
      count: calls.length,
      dirCorrectPct: calls.length > 0 ? +(calls.filter(r => r.dirCorrect).length / calls.length * 100).toFixed(1) : 0,
      everFavPct: calls.length > 0 ? +(calls.filter(r => r.everFavorable).length / calls.length * 100).toFixed(1) : 0,
    },
    puts: {
      count: puts.length,
      dirCorrectPct: puts.length > 0 ? +(puts.filter(r => r.dirCorrect).length / puts.length * 100).toFixed(1) : 0,
      everFavPct: puts.length > 0 ? +(puts.filter(r => r.everFavorable).length / puts.length * 100).toFixed(1) : 0,
    },
  };

  console.log(`[ENTRY-CHECK] ${total} signals | ${noBars} had 0 bars after entry`);
  console.log(`[ENTRY-CHECK] Direction correct at hold window end: ${dirCorrect}/${total} (${summary.dirCorrectPct}%)`);
  console.log(`[ENTRY-CHECK] Ever moved favorably: ${everFav}/${total} (${summary.everFavorablePct}%)`);
  console.log(`[ENTRY-CHECK] Avg max favorable move: ${avgMaxFav.toFixed(2)}% | Avg hold window move: ${avgHoldWindowMove.toFixed(2)}%`);
  console.log(`[ENTRY-CHECK] CALLs: ${summary.calls.count} (${summary.calls.dirCorrectPct}% correct) | PUTs: ${summary.puts.count} (${summary.puts.dirCorrectPct}% correct)`);
  for (const [strat, s] of Object.entries(byStrategy)) {
    console.log(`[ENTRY-CHECK]   ${strat}: ${s.count} sigs | dir_correct=${s.dirCorrectPct}% | ever_fav=${s.everFavPct}% | avg_max_fav=${s.avgMaxFavPct}% | avg_hold_window=${s.avgHoldWindowMovePct}%${s.noBars ? ` | ${s.noBars} NO BARS` : ''}`);
  }

  return { summary, byStrategy, signals: results };
}

// ── Portfolio Constraints ──────────────────────────────────────────────────────

function applyPortfolioConstraints(signals, accountSize) {
  // Round-robin by strategy then grade — ensures each strategy gets representation
  const gradeOrder = { 'A+': 0, 'A': 1, 'A-': 2, 'B+': 3, 'B': 4 };

  // Group by date, then by strategy
  const byDateStrategy = {};
  for (const sig of signals) {
    const key = `${sig.date}:${sig.strategy}`;
    if (!byDateStrategy[key]) byDateStrategy[key] = [];
    byDateStrategy[key].push(sig);
  }
  // Sort each group by grade then time
  for (const group of Object.values(byDateStrategy)) {
    group.sort((a, b) => {
      const ga = gradeOrder[a.grade] ?? 5;
      const gb = gradeOrder[b.grade] ?? 5;
      if (ga !== gb) return ga - gb;
      return (a.time || '').localeCompare(b.time || '');
    });
  }

  // Get all dates
  const dates = [...new Set(signals.map(s => s.date))].sort();
  const strategies = [...new Set(signals.map(s => s.strategy))];

  const accepted = [];
  const activeByDate = {};
  const dailyRisk = {};

  for (const date of dates) {
    if (!activeByDate[date]) activeByDate[date] = 0;
    if (!dailyRisk[date]) dailyRisk[date] = 0;

    // Round-robin: take best signal from each strategy in turn
    const cursors = {};
    for (const strat of strategies) cursors[strat] = 0;

    let added = true;
    while (added && activeByDate[date] < MAX_CONCURRENT_POSITIONS) {
      added = false;
      for (const strat of strategies) {
        if (activeByDate[date] >= MAX_CONCURRENT_POSITIONS) break;

        const group = byDateStrategy[`${date}:${strat}`] || [];
        while (cursors[strat] < group.length) {
          const sig = group[cursors[strat]];
          cursors[strat]++;

          // Risk = position size * max loss %. ETF scalps with tight cuts have lower real risk.
          const posnSize = accountSize * (sig.sizePct || 0.10);
          const lossCutPct = Math.abs(sig.exitOverrides?.lossCutPct ?? 20) / 100;
          const tradeRisk = posnSize * lossCutPct;
          if (dailyRisk[date] + tradeRisk > accountSize * MAX_DAILY_RISK_PCT) continue;

          const dupeKey = `${date}:${sig.ticker}:${sig.strategy}`;
          if (accepted.some(a => `${a.date}:${a.ticker}:${a.strategy}` === dupeKey)) continue;

          activeByDate[date]++;
          dailyRisk[date] += tradeRisk;
          accepted.push(sig);
          added = true;
          break;
        }
      }
    }
  }

  return accepted;
}

// ── Results Builder ────────────────────────────────────────────────────────────

function buildMultiStratResults(results, config, tradingDays) {
  // Filter out any results with NaN/undefined pnlDollars (defensive)
  const valid = results.filter(r => Number.isFinite(r.pnlDollars));
  if (valid.length < results.length) {
    console.warn(`[MULTI-STRAT] WARNING: ${results.length - valid.length} results had invalid pnlDollars — excluded`);
  }

  const total = valid.length;
  const wins = valid.filter(r => r.pnlDollars > 0);
  const losses = valid.filter(r => r.pnlDollars < 0);
  const totalPnl = valid.reduce((a, b) => a + (b.pnlDollars || 0), 0);
  const totalPnlPct = config.accountSize > 0 ? (totalPnl / config.accountSize) * 100 : 0;
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;

  const grossWins = wins.reduce((a, b) => a + (b.pnlDollars || 0), 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + (b.pnlDollars || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);

  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + (b.pnlPct || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + (b.pnlPct || 0), 0) / losses.length : 0;
  const avgHold = total > 0 ? Math.round(valid.reduce((a, b) => a + (b.holdMinutes || 0), 0) / total) : 0;

  // Equity curve + drawdown
  let peak = 0, maxDD = 0, cumPnl = 0;
  const equityCurve = [];
  const byDate = {};
  for (const r of valid) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }
  for (const date of Object.keys(byDate).sort()) {
    const dayPnl = byDate[date].reduce((a, b) => a + (b.pnlDollars || 0), 0);
    cumPnl += dayPnl;
    peak = Math.max(peak, cumPnl);
    maxDD = Math.min(maxDD, cumPnl - peak);
    equityCurve.push({ date, dayPnl, cumPnl, signals: byDate[date].length });
  }
  const maxDDPct = config.accountSize > 0 ? (maxDD / config.accountSize) * 100 : 0;

  // Total costs
  const totalCommissions = valid.reduce((a, b) => a + (b.commissions || 0), 0);
  const totalSlippage = valid.reduce((a, b) => a + (b.slippage || 0), 0);

  // By strategy
  const stratNames = [...new Set(valid.map(r => r.strategy))];
  const byStrategy = {};
  for (const strat of stratNames) {
    const stratSigs = valid.filter(r => r.strategy === strat);
    const stratWins = stratSigs.filter(r => r.pnlDollars > 0);
    const stratGrossWin = stratWins.reduce((a, b) => a + (b.pnlDollars || 0), 0);
    const stratGrossLoss = Math.abs(stratSigs.filter(r => r.pnlDollars < 0).reduce((a, b) => a + (b.pnlDollars || 0), 0));

    byStrategy[strat] = {
      count: stratSigs.length,
      winRate: stratSigs.length > 0 ? parseFloat((stratWins.length / stratSigs.length * 100).toFixed(1)) : 0,
      totalPnl: stratSigs.reduce((a, b) => a + (b.pnlDollars || 0), 0),
      avgPnl: stratSigs.length > 0 ? Math.round(stratSigs.reduce((a, b) => a + (b.pnlDollars || 0), 0) / stratSigs.length) : 0,
      profitFactor: stratGrossLoss > 0 ? parseFloat((stratGrossWin / stratGrossLoss).toFixed(2)) : (stratGrossWin > 0 ? 999 : 0),
      avgHoldMinutes: stratSigs.length > 0 ? Math.round(stratSigs.reduce((a, b) => a + (b.holdMinutes || 0), 0) / stratSigs.length) : 0,
      commissions: stratSigs.reduce((a, b) => a + (b.commissions || 0), 0),
    };
  }

  // By grade
  const grades = ['A+', 'A', 'A-', 'B+', 'B'];
  const byGrade = {};
  for (const g of grades) {
    const gSigs = valid.filter(r => r.grade === g);
    const gWins = gSigs.filter(r => r.pnlDollars > 0);
    byGrade[g] = {
      count: gSigs.length,
      winRate: gSigs.length > 0 ? parseFloat((gWins.length / gSigs.length * 100).toFixed(1)) : 0,
      pnl: gSigs.reduce((a, b) => a + (b.pnlDollars || 0), 0),
    };
  }

  // By exit type
  const exitTypes = [...new Set(valid.map(r => r.exitType))];
  const byExit = {};
  for (const et of exitTypes) {
    const eSigs = valid.filter(r => r.exitType === et);
    byExit[et] = {
      count: eSigs.length,
      pct: total > 0 ? parseFloat((eSigs.length / total * 100).toFixed(1)) : 0,
      pnl: eSigs.reduce((a, b) => a + (b.pnlDollars || 0), 0),
    };
  }

  // Direction stats
  const calls = valid.filter(r => r.direction === 'CALL');
  const puts = valid.filter(r => r.direction === 'PUT');
  const neutrals = valid.filter(r => r.direction === 'NEUTRAL');

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
      tickerCount: new Set(valid.map(r => r.ticker)).size,
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
    signals: valid.map(r => ({
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
      setupQuality: r.setupQuality || null,
      setupFactors: r.setupFactors || null,
      metadata: r.metadata || null,
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
    pnlPct: parseFloat((w.pnl / accountSize * 100).toFixed(2)),
  }));
}

// ── Per-Strategy Verdict ──────────────────────────────────────────────────────

/**
 * Evaluate a single strategy's validation results and return a verdict.
 *
 * PASS     — strategy has a demonstrable edge across multiple tests
 * MARGINAL — strategy shows promise but has weaknesses; keep testing
 * FAIL     — strategy lacks edge or is statistically indistinguishable from noise
 *
 * Criteria (scored as demerits):
 *   - Monte Carlo P(profit) < 55%             → +2 demerits
 *   - Win rate < 40%                           → +1 demerit
 *   - Profit factor < 1.0                      → +2 demerits (negative expectancy)
 *   - Profit factor < 1.2                      → +1 demerit
 *   - OOS verdict FAIL                         → +2 demerits
 *   - OOS win rate degrades > 15pp             → +1 demerit
 *   - Walk-forward: worst fold negative         → +1 demerit
 *   - Statistical t-test p > 0.10              → +1 demerit
 *   - Regime stress: any regime avg P&L < -3%  → +1 demerit
 *
 * Verdict thresholds:
 *   0-1 demerits → PASS
 *   2-3 demerits → MARGINAL
 *   4+  demerits → FAIL
 */
function deriveStrategyVerdict(validation) {
  let demerits = 0;
  const flags = [];

  // ── Monte Carlo ──
  const mcProfit = validation.monteCarlo?.base?.probability?.profit;
  if (mcProfit != null) {
    if (mcProfit < 55) {
      demerits += 2;
      flags.push(`MC P(profit)=${mcProfit}% < 55%`);
    }
  }

  // ── Win Rate ──
  const winRate = validation.summary?.winRate;
  if (winRate != null && winRate < 40) {
    demerits += 1;
    flags.push(`WR=${winRate}% < 40%`);
  }

  // ── Profit Factor ──
  const pf = validation.summary?.profitFactor;
  if (pf != null) {
    if (pf < 1.0) {
      demerits += 2;
      flags.push(`PF=${pf} < 1.0 (negative expectancy)`);
    } else if (pf < 1.2) {
      demerits += 1;
      flags.push(`PF=${pf} < 1.2 (thin edge)`);
    }
  }

  // ── Out-of-Sample ──
  if (validation.outOfSample) {
    if (validation.outOfSample.verdict === 'FAIL') {
      demerits += 2;
      flags.push('OOS verdict FAIL');
    }
    // Check for win rate degradation train → test
    const trainWR = validation.outOfSample.train?.winRate;
    const testWR = validation.outOfSample.test?.winRate;
    if (trainWR != null && testWR != null && (trainWR - testWR) > 15) {
      demerits += 1;
      flags.push(`OOS WR degradation: ${trainWR}% → ${testWR}%`);
    }
  }

  // ── Walk-Forward ──
  if (validation.walkForward?.folds) {
    const worstFold = Math.min(...validation.walkForward.folds.map(f => f.pnl || f.pnlPct || 0));
    if (worstFold < 0) {
      demerits += 1;
      flags.push(`Walk-forward worst fold negative (${worstFold})`);
    }
  }

  // ── Statistical Tests ──
  if (validation.statisticalTests) {
    const pValue = validation.statisticalTests.tTest?.pValue
      ?? validation.statisticalTests.pValue;
    if (pValue != null && pValue > 0.10) {
      demerits += 1;
      flags.push(`t-test p=${pValue.toFixed(3)} > 0.10`);
    }
  }

  // ── Regime Stress ──
  if (validation.regimeStress?.regimes) {
    for (const [regime, stats] of Object.entries(validation.regimeStress.regimes)) {
      const avgPnl = stats.avgPnlPct ?? stats.avgPnl;
      if (avgPnl != null && avgPnl < -3) {
        demerits += 1;
        flags.push(`Regime ${regime} avg P&L=${avgPnl}%`);
        break; // count at most 1 demerit for regime stress
      }
    }
  }

  // ── Verdict ──
  let verdict;
  if (demerits <= 1) {
    verdict = 'PASS';
  } else if (demerits <= 3) {
    verdict = 'MARGINAL';
  } else {
    verdict = 'FAIL';
  }

  return { verdict, demerits, flags };
}
