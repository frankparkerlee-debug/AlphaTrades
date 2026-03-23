/**
 * Momentum Signal Backtest — Before vs After Validation
 *
 * Compares two signal regimes across 90 trading days:
 *   BEFORE: current momentum scorer (acceleration + freshness + volume)
 *   AFTER:  adds structural validators (trend, VWAP, fakeout block, min accel, flow)
 *
 * Uses stored 1-min bars from lc_v3.bars. Measures:
 *   - Signal count, win rate, avg P&L at 30m/60m/120m
 *   - False positive rate (signals that immediately reverse)
 *   - Best/worst tickers, time-of-day breakdown
 *
 * Run: node --max-old-space-size=512 scripts/backtest-momentum.js [--days 90]
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import { analyzeMomentum, shouldSkipOnFreshness } from '../src/scoring/momentum.js';
import { analyzeLevels, analyzeTrend, gateSignal, classifyRegime } from '../src/scoring/intelligence.js';
import { classifyTrend, detectFlushAndHold, checkBounceStructure } from '../src/strategies/support-check.js';

const DAYS_BACK = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--days') || '90');
const MIN_MOVE_ATRS = 0.1; // same threshold as live system

// ── Momentum signal detection ───────────────────────────────────────────────

function detectMomentumSignal(bars, openPrice, prevClose, atr, direction, vwap) {
  if (bars.length < 5) return null;

  const momentum = analyzeMomentum(bars, openPrice, prevClose, atr, direction);

  if (shouldSkipOnFreshness(momentum.freshness, momentum.entryRisk)) return null;
  if (momentum.momentumScore < 15) return null; // PA gate

  const price = bars[bars.length - 1].c;
  const moveFromOpen = openPrice > 0 ? (price - openPrice) / openPrice : 0;
  const moveInATRs = atr > 0 ? Math.abs(moveFromOpen) / atr : 0;
  if (moveInATRs < MIN_MOVE_ATRS) return null;

  // Volume score (simplified — relative to window average)
  const avgVol = bars.slice(-10).reduce((s, b) => s + (b.v || 0), 0) / Math.max(1, bars.slice(-10).length);
  const latestVol = bars[bars.length - 1].v || 0;
  const relVol = avgVol > 0 ? latestVol / avgVol : 1;
  const volScore = Math.min(30, Math.round(relVol * 12));
  if (volScore < 12) return null; // VOL gate

  return {
    direction,
    entry_price: price,
    momentum,
    volScore,
    relVol,
    moveFromOpen,
    moveInATRs,
    vwap,
    bars_snapshot: bars.slice(-20),
  };
}

// ── Structural validators (the AFTER additions) ─────────────────────────────

function applyStructuralValidation(signal, dailyBars, todayBars, spyChange, qqqChange, flowBuyRatio) {
  const reasons = [];
  const { direction, entry_price, momentum, vwap } = signal;

  // 1. Daily trend confirmation via checkBounceStructure
  if (dailyBars && dailyBars.length >= 5) {
    const structure = checkBounceStructure(entry_price, dailyBars, {
      todayLow: Math.min(...todayBars.map(b => b.l)),
      todayHigh: Math.max(...todayBars.map(b => b.h)),
      todayOpen: todayBars[0]?.o || entry_price,
      vwap: vwap || 0,
      intradayBars: todayBars.slice(-20),
    }, 'intraday');

    // CALL in confirmed downtrend = fakeout risk
    if (direction === 'CALL' && structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7) {
      reasons.push('DOWNTREND');
    }
    // PUT in confirmed uptrend = fighting the trend
    if (direction === 'PUT' && structure.trend === 'UPTREND' && structure.trendConfidence >= 0.7) {
      reasons.push('UPTREND');
    }

    // 3. Fakeout block: CALL + downtrend + no stabilization
    const noStab = !structure.stabilization.stabilized;
    if (direction === 'CALL' && structure.trend === 'DOWNTREND' && noStab) {
      // Allow if volume surge >= 2x (capitulation override)
      if (momentum.volSurge < 2.0) {
        reasons.push('FAKEOUT_BLOCK');
      }
    }
  }

  // 2. VWAP alignment
  if (vwap && vwap > 0) {
    if (direction === 'CALL' && entry_price < vwap * 0.997) {
      reasons.push('BELOW_VWAP');
    }
    if (direction === 'PUT' && entry_price > vwap * 1.003) {
      reasons.push('ABOVE_VWAP');
    }
  }

  // 4. Minimum acceleration threshold
  if (Math.abs(momentum.recentAccel) < 0.15) {
    reasons.push('LOW_ACCEL');
  }

  // 5. Flow confirmation (when available)
  if (flowBuyRatio !== null) {
    if (direction === 'CALL' && flowBuyRatio < 0.45) {
      reasons.push('WEAK_FLOW');
    }
    if (direction === 'PUT' && flowBuyRatio > 0.55) {
      reasons.push('WEAK_FLOW');
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
  };
}

// ── Outcome measurement ─────────────────────────────────────────────────────

function measureOutcome(entryPrice, direction, bars, entryIdx) {
  const dir = direction === 'CALL' ? 1 : -1;
  const result = {};

  for (const mins of [30, 60, 120]) {
    const targetIdx = entryIdx + mins;
    if (targetIdx < bars.length) {
      const price = bars[targetIdx].c;
      const move = ((price - entryPrice) / entryPrice) * dir;
      result[`move_${mins}m`] = move;
      result[`win_${mins}m`] = move > 0;
    }
  }

  // Max adverse excursion in first 30 bars
  let maxAdverse = 0;
  for (let i = entryIdx + 1; i < Math.min(bars.length, entryIdx + 30); i++) {
    const move = ((bars[i].c - entryPrice) / entryPrice) * dir;
    if (move < maxAdverse) maxAdverse = move;
  }
  result.max_adverse = maxAdverse;

  // False positive: reverses >0.5% within 10 bars
  result.false_positive = maxAdverse < -0.005;

  return result;
}

// ── Compute VWAP from bars ──────────────────────────────────────────────────

function computeVWAP(bars, upToIdx) {
  let cumVol = 0, cumTpVol = 0;
  for (let i = 0; i <= upToIdx && i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.h + b.l + b.c) / 3;
    cumVol += b.v || 0;
    cumTpVol += tp * (b.v || 0);
  }
  return cumVol > 0 ? cumTpVol / cumVol : 0;
}

// ── Load bars ───────────────────────────────────────────────────────────────

async function loadDayBars(day) {
  const res = await query(`
    SELECT ticker, open as o, high as h, low as l, close as c, volume as v,
           EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')::int * 60 +
           EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')::int as et_mins
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
      AND DATE(ts AT TIME ZONE 'America/New_York') = $1
    ORDER BY ticker, ts
  `, [day]);

  const byTicker = {};
  for (const r of res.rows) {
    if (!byTicker[r.ticker]) byTicker[r.ticker] = [];
    byTicker[r.ticker].push({
      o: parseFloat(r.o), h: parseFloat(r.h),
      l: parseFloat(r.l), c: parseFloat(r.c),
      v: parseInt(r.v), et_mins: parseInt(r.et_mins),
    });
  }
  return byTicker;
}

async function loadDailyBars(ticker, beforeDate, count) {
  const res = await query(`
    SELECT open as o, high as h, low as l, close as c, volume as v,
           DATE(ts AT TIME ZONE 'America/New_York') as day
    FROM lc_v3.bars
    WHERE ticker = $1 AND session = 'REGULAR'
      AND DATE(ts AT TIME ZONE 'America/New_York') < $2
    ORDER BY ts DESC
    LIMIT $3
  `, [ticker, beforeDate, count * 390]); // ~390 bars per day

  // Aggregate to daily bars
  const dailyMap = {};
  for (const r of res.rows) {
    const d = r.day.toISOString().split('T')[0];
    if (!dailyMap[d]) dailyMap[d] = { o: parseFloat(r.o), h: -Infinity, l: Infinity, c: 0, v: 0, day: d };
    dailyMap[d].h = Math.max(dailyMap[d].h, parseFloat(r.h));
    dailyMap[d].l = Math.min(dailyMap[d].l, parseFloat(r.l));
    dailyMap[d].c = parseFloat(r.c); // last bar's close
    dailyMap[d].v += parseInt(r.v);
  }

  return Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=' .repeat(80));
  console.log('  MOMENTUM SIGNAL BACKTEST — BEFORE vs AFTER VALIDATION');
  console.log('='.repeat(80));

  // Get trading days
  const daysRes = await query(`
    SELECT DISTINCT DATE(ts AT TIME ZONE 'America/New_York') as day
    FROM lc_v3.bars WHERE session = 'REGULAR'
    ORDER BY day DESC LIMIT $1
  `, [DAYS_BACK]);
  const allDays = daysRes.rows.map(r => r.day.toISOString().split('T')[0]).reverse();

  if (allDays.length < 5) {
    console.log('Not enough trading days in database. Need at least 5.');
    process.exit(1);
  }

  console.log(`  Period: ${allDays[0]} -> ${allDays[allDays.length - 1]} (${allDays.length} days)`);
  console.log(`  Scanning every 15 bars (simulating 15-second poll cycle)\n`);

  // Get daily closes for ATR calculation
  const dcRes = await query(`
    SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
      ticker, DATE(ts AT TIME ZONE 'America/New_York') as day, close, open
    FROM lc_v3.bars WHERE session = 'REGULAR'
    ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'), ts DESC
  `);
  const dailyClose = {};
  const dailyOpen = {};
  for (const r of dcRes.rows) {
    const d = r.day.toISOString().split('T')[0];
    if (!dailyClose[r.ticker]) dailyClose[r.ticker] = {};
    if (!dailyOpen[r.ticker]) dailyOpen[r.ticker] = {};
    dailyClose[r.ticker][d] = parseFloat(r.close);
    dailyOpen[r.ticker][d] = parseFloat(r.open);
  }

  const tickers = Object.keys(dailyClose).filter(t => !['SPY', 'QQQ', 'IWM'].includes(t));
  console.log(`  Universe: ${tickers.length} tickers\n`);

  // Results accumulators
  const before = { signals: [], wins: { '30m': 0, '60m': 0, '120m': 0 }, count: { '30m': 0, '60m': 0, '120m': 0 }, totalPnl: { '30m': 0, '60m': 0, '120m': 0 }, falsePositives: 0, byTicker: {}, byHour: {} };
  const after  = { signals: [], wins: { '30m': 0, '60m': 0, '120m': 0 }, count: { '30m': 0, '60m': 0, '120m': 0 }, totalPnl: { '30m': 0, '60m': 0, '120m': 0 }, falsePositives: 0, byTicker: {}, byHour: {}, blockReasons: {} };

  // Daily bar cache for trend analysis
  const dailyBarCache = {};

  for (let dayIdx = 1; dayIdx < allDays.length; dayIdx++) {
    const today = allDays[dayIdx];
    const yesterday = allDays[dayIdx - 1];

    if (dayIdx % 10 === 0) console.log(`  Day ${dayIdx}/${allDays.length}: ${today}`);

    const barsByTicker = await loadDayBars(today);

    // SPY/QQQ for regime
    const spyBars = barsByTicker['SPY'] || [];
    const qqqBars = barsByTicker['QQQ'] || [];
    const spyPrevClose = dailyClose['SPY']?.[yesterday] || 0;
    const qqqPrevClose = dailyClose['QQQ']?.[yesterday] || 0;

    // Track signals per ticker per day (dedup)
    const signalsToday = new Set();

    for (const ticker of tickers) {
      const bars = barsByTicker[ticker];
      if (!bars || bars.length < 30) continue;

      const prevClose = dailyClose[ticker]?.[yesterday];
      const openPrice = bars[0]?.o || dailyOpen[ticker]?.[today];
      if (!prevClose || !openPrice) continue;

      // Compute ATR from recent daily closes (simplified)
      const recentDays = allDays.slice(Math.max(0, dayIdx - 20), dayIdx);
      let atrSum = 0, atrCount = 0;
      for (let i = 1; i < recentDays.length; i++) {
        const c0 = dailyClose[ticker]?.[recentDays[i - 1]];
        const c1 = dailyClose[ticker]?.[recentDays[i]];
        if (c0 && c1) { atrSum += Math.abs(c1 - c0) / c0; atrCount++; }
      }
      const atr = atrCount > 0 ? atrSum / atrCount : 0.025;

      // Load daily bars for trend analysis (cached)
      if (!dailyBarCache[ticker]) {
        try {
          dailyBarCache[ticker] = await loadDailyBars(ticker, today, 15);
        } catch { dailyBarCache[ticker] = []; }
      }

      // Scan every 15 bars (simulating 15-second cycle on 1-min bars)
      for (let barIdx = 20; barIdx < bars.length; barIdx += 15) {
        const windowBars = bars.slice(Math.max(0, barIdx - 20), barIdx + 1);
        const price = windowBars[windowBars.length - 1].c;

        // Session move determines direction (same as live)
        const sessionMove = openPrice > 0 ? (price - openPrice) / openPrice : 0;
        const direction = sessionMove >= 0 ? 'CALL' : 'PUT';
        const moveInATRs = atr > 0 ? Math.abs(sessionMove) / atr : 0;
        if (moveInATRs < MIN_MOVE_ATRS) continue;

        // Dedup: one signal per ticker+direction per day
        const dedupKey = `${ticker}:${direction}`;
        if (signalsToday.has(dedupKey)) continue;

        // Compute VWAP
        const vwap = computeVWAP(bars, barIdx);

        // SPY/QQQ at this point in time
        const spyAtBar = spyBars[Math.min(barIdx, spyBars.length - 1)]?.c || 0;
        const qqqAtBar = qqqBars[Math.min(barIdx, qqqBars.length - 1)]?.c || 0;
        const spyChange = spyPrevClose > 0 ? (spyAtBar - spyPrevClose) / spyPrevClose : 0;
        const qqqChange = qqqPrevClose > 0 ? (qqqAtBar - qqqPrevClose) / qqqPrevClose : 0;

        // Detect momentum signal (BEFORE — no structural validation)
        const signal = detectMomentumSignal(windowBars, openPrice, prevClose, atr, direction, vwap);
        if (!signal) continue;

        signalsToday.add(dedupKey);

        // Measure outcome
        const outcome = measureOutcome(price, direction, bars, barIdx);
        const hour = Math.floor((bars[barIdx].et_mins || 570) / 60);

        // Record BEFORE
        before.signals.push({ ticker, direction, date: today, ...outcome });
        if (!before.byTicker[ticker]) before.byTicker[ticker] = { count: 0, wins: 0 };
        before.byTicker[ticker].count++;
        if (!before.byHour[hour]) before.byHour[hour] = { count: 0, wins: 0 };
        before.byHour[hour].count++;
        if (outcome.false_positive) before.falsePositives++;

        for (const mins of ['30m', '60m', '120m']) {
          if (outcome[`win_${mins}`] !== undefined) {
            before.count[mins]++;
            if (outcome[`win_${mins}`]) { before.wins[mins]++; before.byTicker[ticker].wins++; before.byHour[hour].wins++; }
            before.totalPnl[mins] += outcome[`move_${mins}`] || 0;
          }
        }

        // Apply structural validation (AFTER)
        const validation = applyStructuralValidation(
          signal, dailyBarCache[ticker], bars.slice(0, barIdx + 1),
          spyChange, qqqChange, null // no flow data in backtest
        );

        if (!validation.blocked) {
          // Signal passes AFTER validation
          after.signals.push({ ticker, direction, date: today, ...outcome });
          if (!after.byTicker[ticker]) after.byTicker[ticker] = { count: 0, wins: 0 };
          after.byTicker[ticker].count++;
          if (!after.byHour[hour]) after.byHour[hour] = { count: 0, wins: 0 };
          after.byHour[hour].count++;
          if (outcome.false_positive) after.falsePositives++;

          for (const mins of ['30m', '60m', '120m']) {
            if (outcome[`win_${mins}`] !== undefined) {
              after.count[mins]++;
              if (outcome[`win_${mins}`]) { after.wins[mins]++; after.byTicker[ticker].wins++; after.byHour[hour].wins++; }
              after.totalPnl[mins] += outcome[`move_${mins}`] || 0;
            }
          }
        } else {
          // Track what was blocked and whether it would have been a winner
          for (const reason of validation.reasons) {
            if (!after.blockReasons[reason]) after.blockReasons[reason] = { blocked: 0, wouldWin: 0, wouldLose: 0 };
            after.blockReasons[reason].blocked++;
            if (outcome.win_60m === true) after.blockReasons[reason].wouldWin++;
            else if (outcome.win_60m === false) after.blockReasons[reason].wouldLose++;
          }
        }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(80));
  console.log('  RESULTS');
  console.log('='.repeat(80));

  function printRegime(label, data) {
    console.log(`\n  ${label}`);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  Signals:         ${data.signals.length}`);
    console.log(`  False positives: ${data.falsePositives} (${data.signals.length > 0 ? (data.falsePositives / data.signals.length * 100).toFixed(1) : 0}%)`);

    for (const mins of ['30m', '60m', '120m']) {
      if (data.count[mins] > 0) {
        const wr = (data.wins[mins] / data.count[mins] * 100).toFixed(1);
        const avgPnl = (data.totalPnl[mins] / data.count[mins] * 100).toFixed(2);
        console.log(`  ${mins} accuracy:  ${wr}% (${data.wins[mins]}/${data.count[mins]})  avg: ${avgPnl}%`);
      }
    }

    // Top tickers
    const sorted = Object.entries(data.byTicker).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    if (sorted.length > 0) {
      console.log(`  Top tickers:     ${sorted.map(([t, s]) => `${t}(${s.count}, ${s.count > 0 ? (s.wins / s.count * 100).toFixed(0) : 0}%W)`).join('  ')}`);
    }

    // By hour
    const hours = Object.entries(data.byHour).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    if (hours.length > 0) {
      console.log(`  By hour:`);
      for (const [h, s] of hours) {
        const wr = s.count > 0 ? (s.wins / s.count * 100).toFixed(1) : '0.0';
        console.log(`    ${h}:00 ET — ${s.count} signals, ${wr}% win`);
      }
    }
  }

  printRegime('BEFORE (current — no structural validation)', before);
  printRegime('AFTER (with trend + VWAP + fakeout block + min accel)', after);

  // Comparison
  const beforeWR = before.count['60m'] > 0 ? before.wins['60m'] / before.count['60m'] : 0;
  const afterWR = after.count['60m'] > 0 ? after.wins['60m'] / after.count['60m'] : 0;
  const beforeFP = before.signals.length > 0 ? before.falsePositives / before.signals.length : 0;
  const afterFP = after.signals.length > 0 ? after.falsePositives / after.signals.length : 0;

  console.log(`\n  ${'='.repeat(70)}`);
  console.log(`  COMPARISON (60m horizon)`);
  console.log(`  ${'='.repeat(70)}`);
  console.log(`  Signals:        ${before.signals.length} -> ${after.signals.length} (${after.signals.length - before.signals.length > 0 ? '+' : ''}${((after.signals.length / Math.max(1, before.signals.length) - 1) * 100).toFixed(0)}%)`);
  console.log(`  Win rate:       ${(beforeWR * 100).toFixed(1)}% -> ${(afterWR * 100).toFixed(1)}% (${((afterWR - beforeWR) * 100).toFixed(1)}pp)`);
  console.log(`  False positive: ${(beforeFP * 100).toFixed(1)}% -> ${(afterFP * 100).toFixed(1)}% (${((afterFP - beforeFP) * 100).toFixed(1)}pp)`);
  console.log(`  Avg P&L:        ${before.count['60m'] > 0 ? (before.totalPnl['60m'] / before.count['60m'] * 100).toFixed(2) : '0.00'}% -> ${after.count['60m'] > 0 ? (after.totalPnl['60m'] / after.count['60m'] * 100).toFixed(2) : '0.00'}%`);

  // Block reason analysis
  if (Object.keys(after.blockReasons).length > 0) {
    console.log(`\n  BLOCKED SIGNAL ANALYSIS`);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  ${'Reason'.padEnd(20)} ${'Blocked'.padStart(8)} ${'Would Win'.padStart(10)} ${'Would Lose'.padStart(11)} ${'Block Accuracy'.padStart(15)}`);
    for (const [reason, stats] of Object.entries(after.blockReasons).sort((a, b) => b[1].blocked - a[1].blocked)) {
      const total = stats.wouldWin + stats.wouldLose;
      const blockAcc = total > 0 ? (stats.wouldLose / total * 100).toFixed(1) : 'N/A';
      console.log(`  ${reason.padEnd(20)} ${String(stats.blocked).padStart(8)} ${String(stats.wouldWin).padStart(10)} ${String(stats.wouldLose).padStart(11)} ${(blockAcc + '%').padStart(15)}`);
    }
    console.log(`\n  Block Accuracy = % of blocked signals that WOULD have lost`);
    console.log(`  Higher is better — means we're blocking the right signals`);
  }

  console.log('\n' + '='.repeat(80));
  process.exit(0);
}

main().catch(err => { console.error('[BACKTEST] FATAL:', err.message, err.stack); process.exit(1); });
