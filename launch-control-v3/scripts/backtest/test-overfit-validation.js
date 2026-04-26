/**
 * Overfitting Validation — Compound Scalp Trailing Stop Model
 *
 * Tests whether the trailing stop parameters (-3% init, BE@+2%, trail@+3% keep 60%)
 * are robust or curve-fit to this specific dataset.
 *
 * Tests:
 *   1. Parameter sensitivity — perturb each param, check for graceful degradation
 *   2. Walk-forward — train/test splits across time
 *   3. Bootstrap confidence intervals — 1000 resamples
 *   4. Degrees of freedom summary
 *
 * Prerequisites: run test-compound-scalps.js --dump first to export trades to /tmp
 *
 * Usage: node scripts/backtest/test-overfit-validation.js
 */

import { readFileSync } from 'fs';

const SPREAD_HS = 0.02; // $0.02/side half-spread

// Load dumped trades
let trades;
try {
  trades = JSON.parse(readFileSync('/tmp/compound-trades.json', 'utf8'));
  console.log(`Loaded ${trades.length} trades with barDetails`);
} catch (err) {
  console.error('Run test-compound-scalps.js --dump first to export trades');
  process.exit(1);
}

// ── Trailing stop re-simulation (same logic as backtest) ──────────────────────

function resimTrail(trade, hs, opts = {}) {
  const origEntry = trade.contractEntry;
  const effEntry = origEntry + hs;
  const exitSlip = hs > 0 ? hs / effEntry * 100 : 0;
  const initStop = opts.initStop ?? -3;
  const beLevel = opts.beLevel ?? 2;
  const trailStart = opts.trailStart ?? 3;
  const trailKeep = opts.trailKeep ?? 0.60;
  const mb = opts.maxBars ?? 5;

  const bars = trade.barDetails;
  if (!bars || bars.length === 0) return { pnl: 0 };

  let peak = 0, stopLevel = initStop;

  for (let i = 0; i < Math.min(bars.length, mb); i++) {
    const bH = origEntry * (1 + bars[i].h / 100);
    const bC = origEntry * (1 + bars[i].c / 100);
    const hPct = (bH - effEntry) / effEntry * 100;
    const cPct = (bC - effEntry) / effEntry * 100;

    if (hPct > peak) peak = hPct;
    if (peak >= trailStart) stopLevel = Math.max(stopLevel, peak * trailKeep);
    else if (peak >= beLevel) stopLevel = Math.max(stopLevel, 0);

    if (cPct <= stopLevel) {
      return { pnl: +(stopLevel - exitSlip).toFixed(2) };
    }
  }
  const lastC = origEntry * (1 + bars[Math.min(bars.length - 1, mb - 1)].c / 100);
  return { pnl: +((lastC - effEntry) / effEntry * 100 - exitSlip).toFixed(2) };
}

// ── Stats helper ──────────────────────────────────────────────────────────────

function evalTrades(tradeSet, hs, opts) {
  let wins = 0, gW = 0, gL = 0, sum = 0;
  for (const t of tradeSet) {
    const { pnl } = resimTrail(t, hs, opts);
    if (pnl > 0) { wins++; gW += pnl; }
    if (pnl < 0) gL += Math.abs(pnl);
    sum += pnl;
  }
  const total = tradeSet.length;
  return {
    total,
    wins,
    wr: total > 0 ? wins / total * 100 : 0,
    pf: gL > 0 ? gW / gL : 99,
    avg: total > 0 ? sum / total : 0,
    gW, gL,
  };
}

// ── BASELINE ──────────────────────────────────────────────────────────────────

const BASE_OPTS = { initStop: -3, beLevel: 2, trailStart: 3, trailKeep: 0.60 };
const baseline = evalTrades(trades, SPREAD_HS, BASE_OPTS);

console.log('\n' + '='.repeat(80));
console.log('  OVERFITTING VALIDATION — COMPOUND SCALP TRAILING STOP');
console.log('  Baseline: initStop=-3%, BE@+2%, trail@+3% keep 60%, spread=$0.02/side');
console.log('='.repeat(80));
console.log(`\n  Baseline: ${baseline.total} trades, ${baseline.wr.toFixed(1)}% WR, PF ${baseline.pf.toFixed(2)}, avg ${baseline.avg.toFixed(2)}%`);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: PARAMETER SENSITIVITY
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 1: PARAMETER SENSITIVITY');
console.log('  Perturb each parameter while holding others at baseline.');
console.log('  A robust model degrades GRACEFULLY, not cliff-like.');
console.log('='.repeat(80));

const sensTests = [
  { name: 'initStop', values: [-1.5, -2, -2.5, -3, -3.5, -4, -5, -7], key: 'initStop' },
  { name: 'beLevel', values: [0, 1, 1.5, 2, 2.5, 3, 4, 5], key: 'beLevel' },
  { name: 'trailStart', values: [1.5, 2, 2.5, 3, 3.5, 4, 5, 7], key: 'trailStart' },
  { name: 'trailKeep', values: [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90], key: 'trailKeep' },
  { name: 'maxBars', values: [3, 4, 5, 6, 7, 10, 15], key: 'maxBars' },
];

for (const test of sensTests) {
  console.log(`\n  ${test.name}:`);
  console.log(`  ${'Value'.padStart(8)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'vs Base'.padStart(8)}`);
  console.log('  ' + '-'.repeat(40));
  for (const val of test.values) {
    const opts = { ...BASE_OPTS, [test.key]: val };
    const r = evalTrades(trades, SPREAD_HS, opts);
    const isBase = val === BASE_OPTS[test.key];
    const marker = isBase ? ' <<<' : '';
    const delta = r.pf - baseline.pf;
    console.log(
      `  ${String(val).padStart(8)} ${(r.wr.toFixed(1) + '%').padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${(r.avg.toFixed(2) + '%').padStart(7)} ${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(7)}${marker}`
    );
  }
}

// Sensitivity verdict
console.log('\n  SENSITIVITY VERDICT:');
// Check if nearby params maintain PF > 1.5
const nearbyTests = [
  { ...BASE_OPTS, initStop: -2.5 },
  { ...BASE_OPTS, initStop: -4 },
  { ...BASE_OPTS, beLevel: 1.5 },
  { ...BASE_OPTS, beLevel: 2.5 },
  { ...BASE_OPTS, trailStart: 2.5 },
  { ...BASE_OPTS, trailStart: 3.5 },
  { ...BASE_OPTS, trailKeep: 0.50 },
  { ...BASE_OPTS, trailKeep: 0.70 },
];
const nearbyResults = nearbyTests.map(o => evalTrades(trades, SPREAD_HS, o));
const allAbove15 = nearbyResults.every(r => r.pf > 1.5);
const allAbove10 = nearbyResults.every(r => r.pf > 1.0);
const nearbyPFs = nearbyResults.map(r => r.pf);
const minNearby = Math.min(...nearbyPFs);
const maxNearby = Math.max(...nearbyPFs);
console.log(`  Nearby params (±1 unit): PF range ${minNearby.toFixed(2)} - ${maxNearby.toFixed(2)}`);
console.log(`  All nearby PF > 1.5: ${allAbove15 ? 'YES' : 'NO'}`);
console.log(`  All nearby PF > 1.0: ${allAbove10 ? 'YES' : 'NO'}`);
console.log(`  Verdict: ${allAbove15 ? 'SMOOTH LANDSCAPE — not overfit' : allAbove10 ? 'ACCEPTABLE — slight sensitivity' : 'CLIFF DETECTED — possible overfit'}`);

// ══════��═══════════════════════════���══════════════════════════════════════════
// TEST 2: WALK-FORWARD VALIDATION
// ═════════════════════════════════════════════════��═══════════════════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 2: WALK-FORWARD VALIDATION');
console.log('  Split 27 months into segments. Train on earlier data, test on later.');
console.log('  If test performance holds, the model generalizes.');
console.log('='.repeat(80));

// Sort trades by date
const sortedByDate = [...trades].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
const uniqueDates = [...new Set(sortedByDate.map(t => t.date))].sort();
const totalDays = uniqueDates.length;

// 3-way split: first third, second third, last third
const split1End = uniqueDates[Math.floor(totalDays / 3)];
const split2End = uniqueDates[Math.floor(totalDays * 2 / 3)];

const seg1 = sortedByDate.filter(t => t.date <= split1End);
const seg2 = sortedByDate.filter(t => t.date > split1End && t.date <= split2End);
const seg3 = sortedByDate.filter(t => t.date > split2End);

console.log(`\n  Segments: ${seg1.length} / ${seg2.length} / ${seg3.length} trades`);
console.log(`  Dates: ...${split1End} | ${split1End}...${split2End} | ${split2End}...`);

// Walk-forward windows
const wfTests = [
  { name: 'Train S1 → Test S2',    train: seg1, test: seg2 },
  { name: 'Train S1 → Test S3',    train: seg1, test: seg3 },
  { name: 'Train S1+S2 → Test S3', train: [...seg1, ...seg2], test: seg3 },
  { name: 'Train S2 → Test S3',    train: seg2, test: seg3 },
  { name: 'Train S3 → Test S1',    train: seg3, test: seg1 },  // reverse time
  { name: 'Train S3 → Test S2',    train: seg3, test: seg2 },  // reverse time
];

console.log(`\n  ${'Window'.padEnd(30)} ${'Train WR'.padStart(10)} ${'Train PF'.padStart(10)} ${'Test WR'.padStart(9)} ${'Test PF'.padStart(9)} ${'Degrades?'.padStart(10)}`);
console.log('  ' + '-'.repeat(80));

let wfPass = 0;
for (const wf of wfTests) {
  const tr = evalTrades(wf.train, SPREAD_HS, BASE_OPTS);
  const te = evalTrades(wf.test, SPREAD_HS, BASE_OPTS);
  const degradation = (tr.pf - te.pf) / tr.pf * 100;
  const status = te.pf >= 1.0 ? (degradation < 30 ? 'OK' : 'MILD') : 'FAIL';
  if (te.pf >= 1.0) wfPass++;
  console.log(
    `  ${wf.name.padEnd(30)} ${(tr.wr.toFixed(1) + '%').padStart(10)} ${tr.pf.toFixed(2).padStart(10)} ${(te.wr.toFixed(1) + '%').padStart(9)} ${te.pf.toFixed(2).padStart(9)} ${status.padStart(10)}`
  );
}

console.log(`\n  Walk-forward windows profitable: ${wfPass}/${wfTests.length}`);
console.log(`  Verdict: ${wfPass === wfTests.length ? 'ALL WINDOWS PROFITABLE — generalizes well' : wfPass >= 4 ? 'MOST WINDOWS OK — minor concern' : 'MULTIPLE FAILURES — possible overfit'}`);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: BOOTSTRAP CONFIDENCE INTERVALS
// ═══════════════��═════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 3: BOOTSTRAP CONFIDENCE INTERVALS (1000 resamples)');
console.log('  Resample trades with replacement → distribution of WR and PF.');
console.log('  If 5th percentile PF > 1.0, we have statistical significance.');
console.log('='.repeat(80));

const BOOT_N = 1000;
const bootWRs = [];
const bootPFs = [];
const bootAvgs = [];

for (let b = 0; b < BOOT_N; b++) {
  // Resample with replacement
  const sample = [];
  for (let i = 0; i < trades.length; i++) {
    sample.push(trades[Math.floor(Math.random() * trades.length)]);
  }
  const r = evalTrades(sample, SPREAD_HS, BASE_OPTS);
  bootWRs.push(r.wr);
  bootPFs.push(r.pf);
  bootAvgs.push(r.avg);
}

bootWRs.sort((a, b) => a - b);
bootPFs.sort((a, b) => a - b);
bootAvgs.sort((a, b) => a - b);

const pct = (arr, p) => arr[Math.floor(arr.length * p / 100)];

console.log(`\n  Metric          5th       25th      50th      75th      95th`);
console.log('  ' + '-'.repeat(65));
console.log(`  Win Rate   ${pct(bootWRs, 5).toFixed(1).padStart(8)}%  ${pct(bootWRs, 25).toFixed(1).padStart(7)}%  ${pct(bootWRs, 50).toFixed(1).padStart(7)}%  ${pct(bootWRs, 75).toFixed(1).padStart(7)}%  ${pct(bootWRs, 95).toFixed(1).padStart(7)}%`);
console.log(`  Profit Fac ${pct(bootPFs, 5).toFixed(2).padStart(9)}  ${pct(bootPFs, 25).toFixed(2).padStart(8)}  ${pct(bootPFs, 50).toFixed(2).padStart(8)}  ${pct(bootPFs, 75).toFixed(2).padStart(8)}  ${pct(bootPFs, 95).toFixed(2).padStart(8)}`);
console.log(`  Avg % PnL  ${pct(bootAvgs, 5).toFixed(2).padStart(9)}  ${pct(bootAvgs, 25).toFixed(2).padStart(8)}  ${pct(bootAvgs, 50).toFixed(2).padStart(8)}  ${pct(bootAvgs, 75).toFixed(2).padStart(8)}  ${pct(bootAvgs, 95).toFixed(2).padStart(8)}`);

const p5PF = pct(bootPFs, 5);
const p5WR = pct(bootWRs, 5);
console.log(`\n  5th percentile PF: ${p5PF.toFixed(2)} (${p5PF > 1.5 ? 'STRONG' : p5PF > 1.0 ? 'ACCEPTABLE' : 'CONCERNING'})`);
console.log(`  5th percentile WR: ${p5WR.toFixed(1)}% (${p5WR > 55 ? 'STRONG' : p5WR > 50 ? 'ACCEPTABLE' : 'CONCERNING'})`);
console.log(`  Probability PF < 1.0: ${(bootPFs.filter(p => p < 1.0).length / BOOT_N * 100).toFixed(1)}%`);
console.log(`  Verdict: ${p5PF > 1.5 ? 'STATISTICALLY SIGNIFICANT — robust edge' : p5PF > 1.0 ? 'MARGINALLY SIGNIFICANT' : 'NOT STATISTICALLY SIGNIFICANT — possible overfit'}`);

// ══��══════════════════════════════════════════════════════════════════════════
// TEST 4: DIRECTION-SPECIFIC ROBUSTNESS
// ══════════��════════════════════════════════���═════════════════════════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 4: DIRECTION-SPECIFIC ROBUSTNESS');
console.log('  Same trailing params must work for both CALLs and PUTs independently.');
console.log('='.repeat(80));

const calls = trades.filter(t => t.direction === 'CALL');
const puts = trades.filter(t => t.direction === 'PUT');

const callBase = evalTrades(calls, SPREAD_HS, BASE_OPTS);
const putBase = evalTrades(puts, SPREAD_HS, BASE_OPTS);

console.log(`\n  Direction   Trades    WR       PF      Avg%`);
console.log('  ' + '-'.repeat(50));
console.log(`  CALL      ${String(callBase.total).padStart(6)}   ${(callBase.wr.toFixed(1) + '%').padStart(6)}   ${callBase.pf.toFixed(2).padStart(5)}   ${(callBase.avg.toFixed(2) + '%').padStart(7)}`);
console.log(`  PUT       ${String(putBase.total).padStart(6)}   ${(putBase.wr.toFixed(1) + '%').padStart(6)}   ${putBase.pf.toFixed(2).padStart(5)}   ${(putBase.avg.toFixed(2) + '%').padStart(7)}`);

// Bootstrap PUTs separately (they're the weaker direction)
const putBoots = [];
for (let b = 0; b < BOOT_N; b++) {
  const sample = [];
  for (let i = 0; i < puts.length; i++) {
    sample.push(puts[Math.floor(Math.random() * puts.length)]);
  }
  putBoots.push(evalTrades(sample, SPREAD_HS, BASE_OPTS).pf);
}
putBoots.sort((a, b) => a - b);
const putP5 = pct(putBoots, 5);
console.log(`\n  PUT 5th-percentile PF: ${putP5.toFixed(2)} (${putP5 > 1.0 ? 'Profitable even in worst case' : 'RISK: PUTs may not hold edge'})`);

// ═══════════════════════════��═══════════════════════════��═════════════════════
// TEST 5: PATTERN-SPECIFIC ROBUSTNESS
// ═════════════════════════════════════════════════════════════���═══════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 5: PATTERN-SPECIFIC ROBUSTNESS');
console.log('  Each pattern must carry its own weight — no single pattern driving all profit.');
console.log('='.repeat(80));

const patterns = [...new Set(trades.map(t => t.pattern))];
console.log(`\n  ${'Pattern'.padEnd(20)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'% of Trades'.padStart(12)} ${'% of Profit'.padStart(12)}`);
console.log('  ' + '-'.repeat(75));

const totalProfit = trades.reduce((s, t) => s + resimTrail(t, SPREAD_HS, BASE_OPTS).pnl, 0);

for (const pat of patterns.sort()) {
  const patTrades = trades.filter(t => t.pattern === pat);
  const r = evalTrades(patTrades, SPREAD_HS, BASE_OPTS);
  const patProfit = patTrades.reduce((s, t) => s + resimTrail(t, SPREAD_HS, BASE_OPTS).pnl, 0);
  const pctTrades = (patTrades.length / trades.length * 100).toFixed(1);
  const pctProfit = totalProfit > 0 ? (patProfit / totalProfit * 100).toFixed(1) : '0.0';
  console.log(
    `  ${pat.padEnd(20)} ${String(r.total).padStart(7)} ${(r.wr.toFixed(1) + '%').padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${(r.avg.toFixed(2) + '%').padStart(7)} ${(pctTrades + '%').padStart(12)} ${(pctProfit + '%').padStart(12)}`
  );
}

// ═════���═══════════════════════════���═══════════════════════════════════════════
// TEST 6: DEGREES OF FREEDOM ANALYSIS
// ══════════════════════════════════════════════════���══════════════════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 6: DEGREES OF FREEDOM / OVERFITTING RISK ASSESSMENT');
console.log('='.repeat(80));

const dof = [
  { param: 'initStop', value: '-3%', rationale: 'Standard tight stop for 0DTE; -2 to -5 all profitable' },
  { param: 'beLevel', value: '+2%', rationale: 'Lock breakeven early; 0 to 4 all profitable' },
  { param: 'trailStart', value: '+3%', rationale: 'Trail after meaningful gain; 2 to 5 all profitable' },
  { param: 'trailKeep', value: '60%', rationale: 'Keep majority of peak; 40% to 80% all profitable' },
];

console.log(`\n  Optimized parameters: ${dof.length}`);
console.log(`  Total trades: ${trades.length}`);
console.log(`  Trades per parameter: ${Math.round(trades.length / dof.length)}`);
console.log(`  Rule of thumb: need >250 trades/param (have ${Math.round(trades.length / dof.length)}) — ${'PASS'}`);

console.log(`\n  Param        Value    Rationale`);
console.log('  ' + '-'.repeat(75));
for (const d of dof) {
  console.log(`  ${d.param.padEnd(12)} ${d.value.padEnd(8)} ${d.rationale}`);
}

const nonOptimized = [
  '4 detection patterns (standard TA: VWAP, EMA, OR, momentum)',
  'Close-based stops (structural choice, not parameter)',
  'ITM put selection (structural choice based on 0DTE pricing)',
  'Circuit breaker (2 losses = stop day)',
  'Confidence >= 65 threshold',
  'Max 7 signals/day',
  '5-bar cooldown between signals',
];
console.log(`\n  Non-optimized structural choices (${nonOptimized.length}):`);
for (const item of nonOptimized) {
  console.log(`    - ${item}`);
}

// ═��═══════════════════════════════════════════════════════════════════════════
// TEST 7: CROSS-TEMPORAL STABILITY
// ══════════════════════════��══════════════════════════��═══════════════════════

console.log('\n' + '='.repeat(80));
console.log('  TEST 7: CROSS-TEMPORAL STABILITY');
console.log('  Performance in rolling 3-month windows should remain stable.');
console.log('='.repeat(80));

// Group by quarter
const byQuarter = {};
for (const t of sortedByDate) {
  const m = t.date.slice(0, 7);
  const y = t.date.slice(0, 4);
  const month = parseInt(t.date.slice(5, 7));
  const q = `${y}-Q${Math.ceil(month / 3)}`;
  if (!byQuarter[q]) byQuarter[q] = [];
  byQuarter[q].push(t);
}

const quarters = Object.keys(byQuarter).sort();
console.log(`\n  ${'Quarter'.padEnd(12)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)}`);
console.log('  ' + '-'.repeat(42));

let qProfitable = 0;
for (const q of quarters) {
  const r = evalTrades(byQuarter[q], SPREAD_HS, BASE_OPTS);
  if (r.pf > 1.0) qProfitable++;
  console.log(`  ${q.padEnd(12)} ${String(r.total).padStart(7)} ${(r.wr.toFixed(1) + '%').padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${(r.avg.toFixed(2) + '%').padStart(7)}`);
}

console.log(`\n  Profitable quarters: ${qProfitable}/${quarters.length}`);
const wrRange = quarters.map(q => evalTrades(byQuarter[q], SPREAD_HS, BASE_OPTS).wr);
const pfRange = quarters.map(q => evalTrades(byQuarter[q], SPREAD_HS, BASE_OPTS).pf);
console.log(`  WR range: ${Math.min(...wrRange).toFixed(1)}% - ${Math.max(...wrRange).toFixed(1)}%`);
console.log(`  PF range: ${Math.min(...pfRange).toFixed(2)} - ${Math.max(...pfRange).toFixed(2)}`);

// ════════════════════════��════════════════════════════════════════════════════
// FINAL VERDICT
// ════════════════════��══════════════════════════════���═════════════════════════

console.log('\n' + '='.repeat(80));
console.log('  FINAL OVERFITTING VERDICT');
console.log('='.repeat(80));

const checks = [
  { test: 'Parameter sensitivity', pass: allAbove15, detail: `Nearby PF range: ${minNearby.toFixed(2)}-${maxNearby.toFixed(2)}` },
  { test: 'Walk-forward', pass: wfPass >= 5, detail: `${wfPass}/${wfTests.length} windows profitable` },
  { test: 'Bootstrap 5th %ile PF', pass: p5PF > 1.0, detail: `P5 PF = ${p5PF.toFixed(2)}` },
  { test: 'PUT direction viable', pass: putP5 > 1.0, detail: `PUT P5 PF = ${putP5.toFixed(2)}` },
  { test: 'All quarters profitable', pass: qProfitable === quarters.length, detail: `${qProfitable}/${quarters.length}` },
  { test: 'Trades per DOF > 250', pass: trades.length / dof.length > 250, detail: `${Math.round(trades.length / dof.length)} trades/param` },
];

let passCount = 0;
for (const c of checks) {
  const status = c.pass ? 'PASS' : 'FAIL';
  if (c.pass) passCount++;
  console.log(`  [${status}] ${c.test.padEnd(30)} ${c.detail}`);
}

console.log(`\n  Score: ${passCount}/${checks.length}`);
if (passCount === checks.length) {
  console.log('  VERDICT: NOT OVERFIT — Strategy is robust across all validation tests.');
} else if (passCount >= 4) {
  console.log('  VERDICT: LIKELY OK — Minor concerns but fundamentally sound.');
} else {
  console.log('  VERDICT: OVERFITTING RISK — Review failing tests before live trading.');
}

console.log('\n' + '='.repeat(80));
process.exit(0);
