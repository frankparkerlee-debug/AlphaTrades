/**
 * Reusable Backtest Runner
 * Core backtest logic extracted for both CLI and server use.
 * Returns results object instead of calling process.exit().
 */

import { fetchAllData } from './data-fetcher.js';
import { classifyAllNews } from './news-scorer.js';
import { replayAllDays } from './bar-replay.js';
import { simulateAll } from './pnl-simulator.js';
import { query } from '../../src/data/db.js';

/**
 * Run a full backtest and return results.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {number} accountSize - default 7500
 * @param {string[]} tickerFilter - optional list of tickers, null = all
 * @returns {Object} - full results object (same as reporter.js JSON output)
 */
export async function runBacktest(startDate, endDate, accountSize = 7500, tickerFilter = null) {
  const config = {
    startDate,
    endDate,
    tickers: tickerFilter,
    accountSize,
    outputDir: './backtest-results',
    outputFile: `./backtest-results/${startDate}_to_${endDate}.json`,
    feed: process.env.ALPACA_FEED || 'sip',
    maxConcurrent: 5,
  };

  console.log(`[BACKTEST] Running: ${startDate} → ${endDate}, account $${accountSize}`);

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
  console.log(`[BACKTEST] ${tickers.length} tickers`);

  // 2. Fetch historical data
  const data = await fetchAllData(config, tickers);

  // 3. Classify news
  console.log('[BACKTEST] Classifying news...');
  const scoredNews = await classifyAllNews(data.newsByTickerDate);

  // 4. Replay scoring
  console.log('[BACKTEST] Replaying scoring logic...');
  const signals = replayAllDays(data, profiles, config, scoredNews);
  console.log(`[BACKTEST] ${signals.length} signals generated`);

  if (signals.length === 0) {
    return buildEmptyResults(config);
  }

  // 5. Simulate P&L
  console.log('[BACKTEST] Simulating P&L...');
  const results = simulateAll(signals, data.rawMinuteBars);

  // 6. Build results object
  return buildResults(results, config);
}

function buildEmptyResults(config) {
  return {
    config: {
      startDate: config.startDate,
      endDate:   config.endDate,
      accountSize: config.accountSize,
      tickerCount: 0,
      tradingDays: 0,
    },
    summary: {
      totalSignals: 0, signalsPerDay: 0, winRate: 0, profitFactor: 0,
      totalPnlDollars: 0, totalPnlPct: 0, maxDrawdownDollars: 0, maxDrawdownPct: 0,
      avgWinPct: 0, avgLossPct: 0, avgHoldMinutes: 0,
    },
    byGrade: {}, byExit: {}, byTicker: [], byHour: [],
    equityCurve: [], signals: [],
  };
}

function buildResults(results, config) {
  const total     = results.length;
  const wins      = results.filter(r => r.pnlDollars > 0);
  const losses    = results.filter(r => r.pnlDollars < 0);
  const totalPnl  = results.reduce((a, b) => a + b.pnlDollars, 0);
  const totalPnlPct = config.accountSize > 0 ? (totalPnl / config.accountSize) * 100 : 0;
  const winRate   = total > 0 ? (wins.length / total) * 100 : 0;

  const grossWins   = wins.reduce((a, b) => a + b.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnlDollars, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);

  const avgWin  = wins.length > 0 ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length : 0;
  const avgHold = total > 0 ? Math.round(results.reduce((a, b) => a + b.holdMinutes, 0) / total) : 0;

  // Equity curve + max drawdown
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
  const tradingDays = Object.keys(byDate).length;

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
      avgPnl: gSigs.length > 0 ? Math.round(gSigs.reduce((a, b) => a + b.pnlDollars, 0) / gSigs.length) : 0,
    };
  }

  // By exit type
  const exitTypes = ['T1', 'T2', 'T3', 'STOP', 'EOD'];
  const byExit = {};
  for (const et of exitTypes) {
    const eSigs = results.filter(r => r.exitType === et);
    byExit[et] = {
      count: eSigs.length,
      pct: total > 0 ? parseFloat((eSigs.length / total * 100).toFixed(1)) : 0,
      pnl: eSigs.reduce((a, b) => a + b.pnlDollars, 0),
    };
  }

  // By ticker
  const tickerMap = {};
  for (const r of results) {
    if (!tickerMap[r.ticker]) tickerMap[r.ticker] = [];
    tickerMap[r.ticker].push(r);
  }
  const byTicker = Object.entries(tickerMap)
    .map(([ticker, sigs]) => ({
      ticker,
      count: sigs.length,
      winRate: parseFloat((sigs.filter(s => s.pnlDollars > 0).length / sigs.length * 100).toFixed(1)),
      pnl: sigs.reduce((a, b) => a + b.pnlDollars, 0),
    }))
    .sort((a, b) => b.pnl - a.pnl);

  // By hour
  const hourMap = {};
  for (const r of results) {
    const h = r.time.slice(11, 13);
    if (!hourMap[h]) hourMap[h] = { count: 0, wins: 0, pnl: 0 };
    hourMap[h].count++;
    if (r.pnlDollars > 0) hourMap[h].wins++;
    hourMap[h].pnl += r.pnlDollars;
  }
  const byHour = Object.entries(hourMap).map(([h, d]) => ({
    hour: h, ...d, winRate: d.count > 0 ? parseFloat((d.wins / d.count * 100).toFixed(1)) : 0,
  })).sort((a, b) => a.hour.localeCompare(b.hour));

  // Direction stats
  const calls = results.filter(r => r.direction === 'CALL');
  const puts  = results.filter(r => r.direction === 'PUT');

  return {
    config: {
      startDate: config.startDate,
      endDate:   config.endDate,
      accountSize: config.accountSize,
      tickerCount: Object.keys(tickerMap).length,
      tradingDays,
    },
    summary: {
      totalSignals: total,
      signalsPerDay: parseFloat((total / Math.max(1, tradingDays)).toFixed(1)),
      winRate:   parseFloat(winRate.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      totalPnlDollars: totalPnl,
      totalPnlPct:     parseFloat(totalPnlPct.toFixed(2)),
      maxDrawdownDollars: maxDD,
      maxDrawdownPct:     parseFloat(maxDDPct.toFixed(2)),
      avgWinPct:  parseFloat(avgWin.toFixed(2)),
      avgLossPct: parseFloat(avgLoss.toFixed(2)),
      avgHoldMinutes: avgHold,
      calls: calls.length,
      callWinRate: calls.length > 0 ? parseFloat((calls.filter(r => r.pnlDollars > 0).length / calls.length * 100).toFixed(1)) : 0,
      puts: puts.length,
      putWinRate: puts.length > 0 ? parseFloat((puts.filter(r => r.pnlDollars > 0).length / puts.length * 100).toFixed(1)) : 0,
    },
    byGrade, byExit, byTicker, byHour, equityCurve,
    signals: results.map(r => ({
      date: r.date, time: r.time, ticker: r.ticker, direction: r.direction,
      grade: r.grade, composite: r.composite, freshness: r.freshness,
      regime: r.regime, signalType: r.signalType,
      entryPrice: r.entryPrice, exitType: r.exitType,
      pnlPct: r.pnlPct, pnlDollars: r.pnlDollars,
      holdMinutes: r.holdMinutes, scores: r.scores,
    })),
  };
}
