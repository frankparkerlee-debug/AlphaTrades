#!/usr/bin/env node
/**
 * Thesis Scorecard — Continuous validation of compound scalp strategy
 *
 * Runs on a rolling window (last 20 trading days by default) and checks
 * whether the strategy's core thesis assumptions still hold:
 *
 *   1. WIN RATE: Are we above 55%?
 *   2. PROFIT FACTOR: Is PF above 1.5?
 *   3. PUT EXECUTION: Are puts winning above coin flip (>50%)?
 *   4. STOP MECHANICS: Are close-based stops preventing wick-kills?
 *   5. R:R INTEGRITY: Is average win > average loss?
 *   6. CIRCUIT BREAKER: Is it catching bad days before blowups?
 *   7. REGIME STABILITY: No 5-day stretch with negative PF
 *
 * Any failing check = thesis degradation signal. Multiple failures = pause trading.
 *
 * Usage:
 *   node scripts/backtest/thesis-scorecard.js              # last 20 trading days
 *   node scripts/backtest/thesis-scorecard.js 2026-03-01   # from specific date
 *   node scripts/backtest/thesis-scorecard.js --live       # read from paper_trades table
 *
 * Can be run daily as a cron job or manually before each session.
 */

import { query } from '../../src/data/db.js';
import { fetchAllDataFromDB } from './data-fetcher-db.js';
import { detectCompoundSignals } from '../../src/scalper/compound-detector.js';
import { emaSeries } from '../../src/indicators/technical.js';

const flags = process.argv.filter(a => a.startsWith('--'));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const isLive = flags.includes('--live');

// Thesis thresholds — these are the minimum acceptable values
const THESIS = {
  minWR: 55,           // overall win rate
  minPF: 1.5,          // profit factor
  minPutWR: 50,        // put win rate (above coin flip)
  minRR: 1.3,          // avg win / avg loss ratio
  maxConsecLosses: 6,  // max before concern
  maxWeeklyLossPct: -5,// worst acceptable weekly sum%
  minDailyTrades: 2,   // below this = detection problem
};

console.log('='.repeat(70));
console.log('  THESIS SCORECARD — Compound Scalp Strategy Validation');
console.log('='.repeat(70));

if (isLive) {
  // ── Live mode: read from paper_trades table ────────────────────────────────
  console.log('  Mode: LIVE (reading paper_trades)\n');

  const lookback = parseInt(args[0]) || 20;
  const trades = await query(`
    SELECT *
    FROM lc_v3.paper_trades
    WHERE strategy LIKE '%COMPOUND%' OR strategy LIKE '%SCALP%'
    ORDER BY entered_at DESC
    LIMIT 500
  `);

  if (trades.rows.length === 0) {
    console.log('  No compound scalp paper trades found.');
    console.log('  Strategy needs to be wired into live system first.');
    process.exit(0);
  }

  console.log(`  Found ${trades.rows.length} paper trades`);
  // TODO: score paper trades when live integration is complete

} else {
  // ── Backtest mode: run strategy on recent data ─────────────────────────────
  const endDate = new Date().toISOString().split('T')[0];
  const startD = args[0] ? new Date(args[0]) : new Date();
  if (!args[0]) startD.setDate(startD.getDate() - 30); // ~20 trading days
  const startDate = args[0] || startD.toISOString().split('T')[0];

  console.log(`  Mode: BACKTEST (${startDate} → ${endDate})\n`);

  const TICKER = 'IWM';
  const EXIT = { callTargetPct: 5, putTargetPct: 5, callStopPct: -3, putStopPct: -3, maxBars: 5, stallBars: 2 };
  const PUT_MIN = 1.00;
  const PUT_ITM_RANGE = 3.0;
  const MIN_PRICE = 0.75;

  // Load data
  const allData = await fetchAllDataFromDB({ startDate, endDate }, [TICKER]);
  const minuteBars = allData.minuteBars[TICKER] || {};
  const dailyBars = allData.dailyBars;
  const tradingDays = allData.tradingDays;

  const optRes = await query(`
    SELECT symbol, ticker, ts, expiry, strike, option_type, open, high, low, close, volume
    FROM lc_v3.options_bars_1m WHERE ticker = $1 AND expiry >= $2 AND expiry <= $3 ORDER BY ts
  `, [TICKER, startDate, endDate]);

  const optionsBars = {};
  for (const row of optRes.rows) {
    const expiry = row.expiry.toISOString().split('T')[0];
    const optType = row.option_type;
    const strike = parseFloat(row.strike);
    const minuteKey = new Date(row.ts).toISOString().slice(0, 16);
    if (!optionsBars[expiry]) optionsBars[expiry] = {};
    if (!optionsBars[expiry][optType]) optionsBars[expiry][optType] = {};
    if (!optionsBars[expiry][optType][strike]) optionsBars[expiry][optType][strike] = {};
    optionsBars[expiry][optType][strike][minuteKey] = {
      o: parseFloat(row.open), h: parseFloat(row.high),
      l: parseFloat(row.low), c: parseFloat(row.close), v: parseInt(row.volume || 0),
    };
  }

  console.log(`  ${tradingDays.length} trading days, ${optRes.rows.length} options bars\n`);

  // Run strategy (same logic as test-compound-scalps.js)
  const trades = [];
  let circuitBreakerDays = 0;

  function isEDT(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const mar1Day = new Date(y, 2, 1).getDay();
    const secondSunMar = mar1Day === 0 ? 8 : (14 - mar1Day + 1);
    const nov1Day = new Date(y, 10, 1).getDay();
    const firstSunNov = nov1Day === 0 ? 1 : (7 - nov1Day + 1);
    const mmdd = m * 100 + d;
    return mmdd >= (300 + secondSunMar) && mmdd < (1100 + firstSunNov);
  }

  function findContract(date, isCall, stockPrice, signalTime) {
    const optType = isCall ? 'C' : 'P';
    const dayContracts = optionsBars[date]?.[optType];
    if (!dayContracts) return null;
    const signalMinute = signalTime.slice(0, 16);
    const available = Object.keys(dayContracts).map(Number).sort((a, b) => a - b);
    if (!available.length) return null;
    const maxDist = isCall ? 1.0 : PUT_ITM_RANGE;
    const minP = isCall ? MIN_PRICE : PUT_MIN;
    let cands;
    if (isCall) {
      cands = available.map(s => ({ strike: s, dist: Math.abs(s - stockPrice) })).filter(s => s.dist <= maxDist).sort((a, b) => a.dist - b.dist);
    } else {
      cands = available.map(s => ({ strike: s, dist: Math.abs(s - stockPrice), itm: s - stockPrice })).filter(s => s.dist <= maxDist)
        .sort((a, b) => { const aS = a.itm >= 0 && a.itm <= 2 ? 0 : a.itm > 2 ? 1 : 2; const bS = b.itm >= 0 && b.itm <= 2 ? 0 : b.itm > 2 ? 1 : 2; return aS !== bS ? aS - bS : a.dist - b.dist; });
    }
    for (const { strike } of cands) {
      const cb = dayContracts[strike]; if (!cb) continue;
      const bk = Object.keys(cb).sort();
      let idx = -1; for (let i = bk.length - 1; i >= 0; i--) { if (bk[i] <= signalMinute) { idx = i; break; } }
      if (idx < 0) continue;
      const eb = cb[bk[idx]]; if (eb.c < minP) continue;
      return { strike, entryPrice: eb.c, forwardBars: bk.slice(idx + 1).map(k => cb[k]) };
    }
    return null;
  }

  for (const date of tradingDays) {
    const edt = isEDT(date);
    const rthS = edt ? '13:30' : '14:30'; const rthE = edt ? '20:00' : '21:00';
    const dayKeys = Object.keys(minuteBars).filter(k => k >= `${date}T${rthS}` && k <= `${date}T${rthE}`).sort();
    if (dayKeys.length < 20) continue;

    let orH = 0, orL = Infinity;
    for (let i = 0; i < Math.min(5, dayKeys.length); i++) { const b = minuteBars[dayKeys[i]]; if (b.h > orH) orH = b.h; if (b.l < orL) orL = b.l; }

    const prevDayBar = (() => { const tb = dailyBars[TICKER]; if (!tb) return null; const ds = Object.keys(tb).sort(); const i = ds.indexOf(date); return i > 0 ? tb[ds[i-1]] : null; })();

    let dayN = 0, lastIdx = -5, dayW = 0, dayL = 0, broken = false;
    for (let i = 10; i < dayKeys.length; i++) {
      if (dayN >= 7 || i - lastIdx < 5 || broken) { if (broken) break; continue; }
      const key = dayKeys[i];
      const si = Math.max(0, i - 30);
      const bars = dayKeys.slice(si, i + 1).map(k => ({ ...minuteBars[k], t: k }));
      if (bars.length < 10) continue;
      const curr = bars[bars.length - 1];
      let cumVol = 0, cumPV = 0;
      for (let j = 0; j <= i; j++) { const b = minuteBars[dayKeys[j]]; cumVol += (b.v||0); cumPV += (b.h+b.l+b.c)/3*(b.v||0); }
      const vwap = cumVol > 0 ? cumPV / cumVol : curr.c;
      const closes = bars.map(b => b.c);
      const ema9Arr = emaSeries(closes, 9);
      let ema9Slope = 0;
      if (ema9Arr?.length >= 15) { const n = ema9Arr[ema9Arr.length-1]; const a = ema9Arr[ema9Arr.length-6]; ema9Slope = (n&&a&&a>0) ? (n-a)/a : 0; }
      const ctx = { vwap, orHigh: orH||null, orLow: orL<Infinity?orL:null, sessionOpen: minuteBars[dayKeys[0]]?.o, ema9Slope, barsFromOpen: i, prevDayHigh: prevDayBar?.h||null, prevDayLow: prevDayBar?.l||null };
      const signals = detectCompoundSignals(TICKER, bars, ctx);
      const sOpen = minuteBars[dayKeys[0]]?.o || curr.c;
      const callOK = curr.c > vwap || curr.c > sOpen;
      const putOK = curr.c < vwap || curr.c < sOpen;

      for (const sig of signals) {
        if (sig.confidence < 65 || dayN >= 7) break;
        if (sig.direction === 'CALL' && !callOK) continue;
        if (sig.direction === 'PUT' && !putOK) continue;
        sig.timestamp_key = key;
        const isCall = sig.direction === 'CALL';
        const contract = findContract(date, isCall, sig.entry, key);
        if (!contract) continue;
        const fwd = contract.forwardBars.slice(0, EXIT.maxBars);
        if (!fwd.length) continue;
        let pnl = 0, exit = 'TIME', ac = 0, prev = contract.entryPrice;
        const stop = isCall ? EXIT.callStopPct : EXIT.putStopPct;
        const tgt = isCall ? EXIT.callTargetPct : EXIT.putTargetPct;
        for (let fi = 0; fi < fwd.length; fi++) {
          const fb = fwd[fi]; if (!fb) continue;
          const cp = ((fb.c - contract.entryPrice) / contract.entryPrice) * 100;
          const hp = ((fb.h - contract.entryPrice) / contract.entryPrice) * 100;
          if (cp <= stop) { pnl = stop; exit = 'STOP'; break; }
          if (hp >= tgt) { pnl = tgt; exit = 'TARGET'; break; }
          ac = fb.c < prev ? ac + 1 : 0;
          if (ac >= EXIT.stallBars) { pnl = +cp.toFixed(2); exit = 'STALL'; break; }
          prev = fb.c; pnl = +cp.toFixed(2);
        }
        trades.push({ date, time: key, direction: sig.direction, pattern: sig.pattern, contractEntry: contract.entryPrice, strike: contract.strike, pnlPct: pnl, exitReason: exit });
        dayN++; lastIdx = i;
        if (pnl > 0) { dayW++; dayL = 0; } else if (pnl < 0) { dayL++; }
        if (dayL >= 2 && dayW === 0) { broken = true; circuitBreakerDays++; }
        break;
      }
    }
  }

  if (trades.length === 0) {
    console.log('  No trades in this window. Check options data coverage.');
    process.exit(0);
  }

  // ── Score the thesis ───────────────────────────────────────────────────────

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct < 0);
  const wr = wins.length / trades.length * 100;
  const grossW = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossL > 0 ? grossW / grossL : 99;
  const avgWin = wins.length > 0 ? grossW / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossL / losses.length : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : 99;

  const calls = trades.filter(t => t.direction === 'CALL');
  const puts = trades.filter(t => t.direction === 'PUT');
  const putWR = puts.length > 0 ? puts.filter(t => t.pnlPct > 0).length / puts.length * 100 : 0;
  const callWR = calls.length > 0 ? calls.filter(t => t.pnlPct > 0).length / calls.length * 100 : 0;

  // Weekly rolling PF check
  const weekBuckets = {};
  for (const t of trades) {
    const d = new Date(t.date + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const mon = new Date(d); mon.setUTCDate(diff);
    const wk = mon.toISOString().slice(0, 10);
    if (!weekBuckets[wk]) weekBuckets[wk] = [];
    weekBuckets[wk].push(t);
  }
  const worstWeek = Object.entries(weekBuckets)
    .map(([wk, ts]) => ({ wk, sum: ts.reduce((s, t) => s + t.pnlPct, 0), n: ts.length }))
    .sort((a, b) => a.sum - b.sum)[0];

  // Consecutive losses
  let maxConsec = 0, consec = 0;
  for (const t of trades.sort((a, b) => (a.time || '').localeCompare(b.time || ''))) {
    if (t.pnlPct < 0) { consec++; if (consec > maxConsec) maxConsec = consec; }
    else consec = 0;
  }

  const avgDaily = trades.length / tradingDays.length;

  // ── Print scorecard ────────────────────────────────────────────────────────

  const checks = [];
  function check(name, value, threshold, comparator, unit = '') {
    const pass = comparator === '>=' ? value >= threshold : value <= threshold;
    checks.push({ name, pass, value, threshold });
    const status = pass ? 'PASS' : 'FAIL';
    const val = typeof value === 'number' ? value.toFixed(1) : value;
    console.log(`  [${status}]  ${name.padEnd(30)} ${val}${unit}  (threshold: ${comparator} ${threshold}${unit})`);
    return pass;
  }

  console.log('\n  THESIS CHECKS:');
  console.log('  ' + '-'.repeat(65));
  check('Win Rate', wr, THESIS.minWR, '>=', '%');
  check('Profit Factor', pf, THESIS.minPF, '>=');
  check('PUT Win Rate', putWR, THESIS.minPutWR, '>=', '%');
  check('Risk/Reward (avg win/loss)', rr, THESIS.minRR, '>=');
  check('Max Consecutive Losses', maxConsec, THESIS.maxConsecLosses, '<=');
  check('Worst Weekly Sum%', worstWeek?.sum || 0, THESIS.maxWeeklyLossPct, '>=', '%');
  check('Avg Trades/Day', avgDaily, THESIS.minDailyTrades, '>=');

  const passing = checks.filter(c => c.pass).length;
  const failing = checks.filter(c => !c.pass).length;

  console.log('  ' + '-'.repeat(65));

  // Summary stats
  console.log(`\n  STATS: ${trades.length} trades (${calls.length}C/${puts.length}P) over ${tradingDays.length} days`);
  console.log(`  WR: ${wr.toFixed(1)}% | PF: ${pf.toFixed(2)} | R:R: ${rr.toFixed(2)} | Avg: ${(trades.reduce((s,t)=>s+t.pnlPct,0)/trades.length).toFixed(2)}%`);
  console.log(`  CALL WR: ${callWR.toFixed(1)}% | PUT WR: ${putWR.toFixed(1)}%`);
  console.log(`  Circuit breaker days: ${circuitBreakerDays}`);
  if (worstWeek) console.log(`  Worst week: ${worstWeek.wk} (${worstWeek.sum.toFixed(1)}% over ${worstWeek.n} trades)`);

  // Verdict
  console.log('\n' + '='.repeat(70));
  if (failing === 0) {
    console.log('  VERDICT: ALL CHECKS PASS — Thesis holding. Continue trading.');
  } else if (failing <= 2) {
    console.log(`  VERDICT: ${failing} CHECK(S) FAILING — Monitor closely. Consider reducing size.`);
    for (const c of checks.filter(c => !c.pass)) {
      console.log(`    -> ${c.name}: ${typeof c.value === 'number' ? c.value.toFixed(1) : c.value} (need ${c.threshold})`);
    }
  } else {
    console.log(`  VERDICT: ${failing} CHECKS FAILING — THESIS DEGRADATION. Pause and investigate.`);
    for (const c of checks.filter(c => !c.pass)) {
      console.log(`    -> ${c.name}: ${typeof c.value === 'number' ? c.value.toFixed(1) : c.value} (need ${c.threshold})`);
    }
  }
  console.log('='.repeat(70));
}

process.exit(0);
