/**
 * Backtest Reporter
 * Aggregates results and outputs console summary + JSON file.
 */

import { writeFileSync, mkdirSync } from 'fs';

function pad(str, len, right = false) {
  str = String(str);
  return right ? str.padEnd(len) : str.padStart(len);
}

function pct(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function dollar(n) {
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString()}`;
}

export function generateReport(results, config) {
  const total     = results.length;
  const wins      = results.filter(r => r.pnlDollars > 0);
  const losses    = results.filter(r => r.pnlDollars < 0);
  const breakeven = results.filter(r => r.pnlDollars === 0);
  const totalPnl  = results.reduce((a, b) => a + b.pnlDollars, 0);
  const totalPnlPct = config.accountSize > 0 ? (totalPnl / config.accountSize) * 100 : 0;
  const winRate   = total > 0 ? (wins.length / total) * 100 : 0;

  const grossWins   = wins.reduce((a, b) => a + b.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnlDollars, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  const avgWin  = wins.length > 0 ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length : 0;
  const avgHold = total > 0 ? Math.round(results.reduce((a, b) => a + b.holdMinutes, 0) / total) : 0;

  // Max drawdown
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

  // Signals per day
  const tradingDays = Object.keys(byDate).length;
  const sigPerDay   = tradingDays > 0 ? (total / tradingDays).toFixed(1) : 0;

  // By grade
  const grades = ['A+', 'A', 'A-', 'B+', 'B'];
  const byGrade = {};
  for (const g of grades) {
    const gSigs = results.filter(r => r.grade === g);
    const gWins = gSigs.filter(r => r.pnlDollars > 0);
    const gPnl  = gSigs.reduce((a, b) => a + b.pnlDollars, 0);
    byGrade[g] = {
      count:   gSigs.length,
      winRate: gSigs.length > 0 ? (gWins.length / gSigs.length * 100).toFixed(1) : '—',
      pnl:     gPnl,
      avgPnl:  gSigs.length > 0 ? Math.round(gPnl / gSigs.length) : 0,
    };
  }

  // By exit type
  const exitTypes = ['T1', 'T2', 'T3', 'STOP', 'EOD'];
  const byExit = {};
  for (const et of exitTypes) {
    const eSigs = results.filter(r => r.exitType === et);
    byExit[et] = {
      count: eSigs.length,
      pct:   total > 0 ? (eSigs.length / total * 100).toFixed(1) : '0',
      pnl:   eSigs.reduce((a, b) => a + b.pnlDollars, 0),
    };
  }

  // By ticker (top 10 by signal count)
  const tickerMap = {};
  for (const r of results) {
    if (!tickerMap[r.ticker]) tickerMap[r.ticker] = [];
    tickerMap[r.ticker].push(r);
  }
  const byTicker = Object.entries(tickerMap)
    .map(([ticker, sigs]) => ({
      ticker,
      count:   sigs.length,
      winRate: (sigs.filter(s => s.pnlDollars > 0).length / sigs.length * 100).toFixed(1),
      pnl:     sigs.reduce((a, b) => a + b.pnlDollars, 0),
    }))
    .sort((a, b) => b.pnl - a.pnl);

  // By hour
  const byHour = {};
  for (const r of results) {
    const h = r.time.slice(11, 13); // HH from ISO
    if (!byHour[h]) byHour[h] = { count: 0, wins: 0, pnl: 0 };
    byHour[h].count++;
    if (r.pnlDollars > 0) byHour[h].wins++;
    byHour[h].pnl += r.pnlDollars;
  }

  // By direction
  const calls = results.filter(r => r.direction === 'CALL');
  const puts  = results.filter(r => r.direction === 'PUT');
  const callWR = calls.length > 0 ? (calls.filter(r => r.pnlDollars > 0).length / calls.length * 100).toFixed(1) : '—';
  const putWR  = puts.length > 0 ? (puts.filter(r => r.pnlDollars > 0).length / puts.length * 100).toFixed(1) : '—';

  // ── Console Output ──────────────────────────────────────────────
  const line = '═'.repeat(64);
  console.log(`\n${line}`);
  console.log(`  BACKTEST: ${config.startDate} → ${config.endDate}`);
  console.log(`  Account: $${config.accountSize.toLocaleString()} | ${tradingDays} trading days`);
  console.log(line);

  console.log(`\n  Signals: ${total} (${sigPerDay}/day)    Win Rate: ${winRate.toFixed(1)}%    Profit Factor: ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`);
  console.log(`  Total P&L: ${dollar(totalPnl)} (${pct(totalPnlPct)})    Max Drawdown: ${dollar(maxDD)} (${pct(maxDDPct)})`);
  console.log(`  Avg Win: ${pct(avgWin)}    Avg Loss: ${pct(avgLoss)}    Avg Hold: ${avgHold}min`);
  console.log(`  Calls: ${calls.length} (${callWR}% win)    Puts: ${puts.length} (${putWR}% win)`);

  console.log(`\n  ${'BY GRADE'.padEnd(12)} ${'Count'.padStart(6)} ${'Win%'.padStart(7)} ${'Avg P&L'.padStart(9)} ${'Total'.padStart(10)}`);
  console.log(`  ${'─'.repeat(46)}`);
  for (const g of grades) {
    const d = byGrade[g];
    if (d.count === 0) continue;
    console.log(`  ${pad(g, 12, true)} ${pad(d.count, 6)} ${pad(d.winRate + '%', 7)} ${pad(dollar(d.avgPnl), 9)} ${pad(dollar(d.pnl), 10)}`);
  }

  console.log(`\n  ${'EXIT TYPE'.padEnd(12)} ${'Count'.padStart(6)} ${'%'.padStart(6)} ${'P&L'.padStart(10)}`);
  console.log(`  ${'─'.repeat(36)}`);
  for (const et of exitTypes) {
    const d = byExit[et];
    if (d.count === 0) continue;
    console.log(`  ${pad(et, 12, true)} ${pad(d.count, 6)} ${pad(d.pct + '%', 6)} ${pad(dollar(d.pnl), 10)}`);
  }

  console.log(`\n  ${'TOP TICKERS'.padEnd(12)} ${'Signals'.padStart(8)} ${'Win%'.padStart(7)} ${'P&L'.padStart(10)}`);
  console.log(`  ${'─'.repeat(39)}`);
  for (const t of byTicker.slice(0, 10)) {
    console.log(`  ${pad(t.ticker, 12, true)} ${pad(t.count, 8)} ${pad(t.winRate + '%', 7)} ${pad(dollar(t.pnl), 10)}`);
  }

  if (byTicker.length > 10) {
    const worst = byTicker.slice(-5).reverse();
    console.log(`\n  ${'WORST'.padEnd(12)} ${'Signals'.padStart(8)} ${'Win%'.padStart(7)} ${'P&L'.padStart(10)}`);
    console.log(`  ${'─'.repeat(39)}`);
    for (const t of worst) {
      if (t.pnl >= 0) continue;
      console.log(`  ${pad(t.ticker, 12, true)} ${pad(t.count, 8)} ${pad(t.winRate + '%', 7)} ${pad(dollar(t.pnl), 10)}`);
    }
  }

  console.log(`\n  ${'HOUR (ET)'.padEnd(12)} ${'Signals'.padStart(8)} ${'Win%'.padStart(7)} ${'P&L'.padStart(10)}`);
  console.log(`  ${'─'.repeat(39)}`);
  for (const h of Object.keys(byHour).sort()) {
    const d = byHour[h];
    const wr = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : '—';
    console.log(`  ${pad(h + ':00', 12, true)} ${pad(d.count, 8)} ${pad(wr + '%', 7)} ${pad(dollar(d.pnl), 10)}`);
  }

  console.log(`\n${line}\n`);

  // ── JSON Output ─────────────────────────────────────────────────
  const jsonOutput = {
    config: {
      startDate: config.startDate,
      endDate:   config.endDate,
      accountSize: config.accountSize,
      tickerCount: Object.keys(tickerMap).length,
      tradingDays,
    },
    summary: {
      totalSignals: total,
      signalsPerDay: parseFloat(sigPerDay),
      winRate:   parseFloat(winRate.toFixed(1)),
      profitFactor: profitFactor === Infinity ? 999 : parseFloat(profitFactor.toFixed(2)),
      totalPnlDollars: totalPnl,
      totalPnlPct:     parseFloat(totalPnlPct.toFixed(2)),
      maxDrawdownDollars: maxDD,
      maxDrawdownPct:     parseFloat(maxDDPct.toFixed(2)),
      avgWinPct:  parseFloat(avgWin.toFixed(2)),
      avgLossPct: parseFloat(avgLoss.toFixed(2)),
      avgHoldMinutes: avgHold,
    },
    byGrade,
    byExit,
    byTicker,
    byHour: Object.entries(byHour).map(([h, d]) => ({
      hour: h, ...d, winRate: d.count > 0 ? parseFloat((d.wins / d.count * 100).toFixed(1)) : 0,
    })),
    equityCurve,
    signals: results.map(r => ({
      date: r.date, time: r.time, ticker: r.ticker, direction: r.direction,
      grade: r.grade, composite: r.composite, freshness: r.freshness,
      regime: r.regime, signalType: r.signalType,
      entryPrice: r.entryPrice, exitType: r.exitType,
      pnlPct: r.pnlPct, pnlDollars: r.pnlDollars,
      holdMinutes: r.holdMinutes,
      scores: r.scores,
    })),
  };

  mkdirSync(config.outputDir, { recursive: true });
  writeFileSync(config.outputFile, JSON.stringify(jsonOutput, null, 2));
  console.log(`  Results saved to: ${config.outputFile}\n`);

  return jsonOutput;
}
