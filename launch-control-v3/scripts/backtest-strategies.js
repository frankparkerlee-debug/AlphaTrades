/**
 * 6-Month Strategy Backtest Against Stored Bars
 *
 * Bulk-loads all bar data upfront, then replays all 6 strategy scanners
 * per trading day. Measures directional accuracy at 30/60/120 min,
 * win rate per strategy exit rules, and avg move on winners vs losers.
 *
 * Run: node scripts/backtest-strategies.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

// ── Strategy detection ───────────────────────────────────────────────────────

function detectGapReversal(ticker, todayOpen, prevClose, firstCandle) {
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap < -0.03 || gap > -0.02) return null;
  if (firstCandle.close <= firstCandle.open) return null;
  const gapAmount = prevClose - todayOpen;
  return {
    strategy: 'GAP_REVERSAL', direction: 'CALL', ticker,
    entry_price: firstCandle.close,
    stop_price: firstCandle.low || firstCandle.open,
    t1: todayOpen + gapAmount * 0.40,
    t2: todayOpen + gapAmount * 0.77,
    exit_by_mins: 210, gap_pct: gap * 100,
  };
}

function detectGapUpReversal(ticker, todayOpen, prevClose, firstCandle) {
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap < 0.02 || gap > 0.03) return null;
  if (firstCandle.close >= firstCandle.open) return null;
  const gapAmount = todayOpen - prevClose;
  return {
    strategy: 'GAP_UP_REVERSAL', direction: 'PUT', ticker,
    entry_price: firstCandle.close,
    stop_price: firstCandle.high || firstCandle.open,
    t1: todayOpen - gapAmount * 0.40,
    t2: prevClose,
    exit_by_mins: 210, gap_pct: gap * 100,
  };
}

function detectCapitulationBounce(ticker, todayBars, todayOpen, volBaseline) {
  for (let i = 0; i < todayBars.length; i++) {
    const bar = todayBars[i];
    const drop = (bar.close - todayOpen) / todayOpen;
    if (drop > -0.03) continue;
    if ((bar.close - todayOpen) / todayOpen > 0.015) continue;
    let cumVol = 0;
    for (let j = 0; j <= i; j++) cumVol += todayBars[j].volume;
    const volRatio = volBaseline > 0 ? cumVol / volBaseline : 0;
    if (volRatio < 1.5) continue;
    return {
      strategy: 'CAPITULATION_BOUNCE', direction: 'CALL', ticker,
      entry_price: todayOpen, bar_index: i, hold: 'OVERNIGHT', drop_pct: drop * 100,
    };
  }
  return null;
}

function detectVolDropPut(ticker, todayBars, todayOpen, volBaseline) {
  for (let i = 0; i < todayBars.length; i++) {
    const bar = todayBars[i];
    const drop = (bar.close - todayOpen) / todayOpen;
    if (drop > -0.03) continue;
    let cumVol = 0;
    for (let j = 0; j <= i; j++) cumVol += todayBars[j].volume;
    const volRatio = volBaseline > 0 ? cumVol / volBaseline : 0;
    if (volRatio >= 1.5 || volRatio <= 0) continue;
    return {
      strategy: 'VOL_DROP_PUT', direction: 'PUT', ticker,
      entry_price: bar.close, bar_index: i, hold: 'OVERNIGHT', drop_pct: drop * 100,
    };
  }
  return null;
}

function detectSectorRotation(ticker, todayOpen, prevClose, spyChange, qqqChange) {
  if (spyChange <= 0.003 || qqqChange <= 0.003) return null;
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap < -0.03 || gap > -0.02) return null;
  return {
    strategy: 'SECTOR_ROTATION_BOUNCE', direction: 'CALL', ticker,
    entry_price: todayOpen, t1: prevClose * 0.985, t2: prevClose,
    exit_by_mins: 270, gap_pct: gap * 100,
  };
}

function detectConsecBounce(ticker, dailyCloses) {
  if (dailyCloses.length < 3) return null;
  const n = dailyCloses.length;
  const c0 = dailyCloses[n - 3], c1 = dailyCloses[n - 2], c2 = dailyCloses[n - 1];
  if ((c1 - c0) / c0 > -0.03 || (c2 - c1) / c1 > -0.03) return null;
  let consecutiveDays = 2;
  if (dailyCloses.length >= 4) {
    const cPrev = dailyCloses[n - 4];
    if ((c0 - cPrev) / cPrev <= -0.03) consecutiveDays = 3;
  }
  return {
    strategy: 'CONSEC_BOUNCE', direction: 'CALL', ticker,
    entry_price: c2, consecutive_days: consecutiveDays, hold: 'MULTIDAY', exit_within_days: 3,
  };
}

// ── Outcome measurement ──────────────────────────────────────────────────────

function measureOutcome(signal, entryBarIdx, todayBars, nextDayBars) {
  const entryPrice = signal.entry_price;
  const dir = signal.direction === 'CALL' ? 1 : -1;
  const accuracy = {};

  for (const mins of [30, 60, 120]) {
    const targetIdx = entryBarIdx + mins;
    let price = null;
    if (targetIdx < todayBars.length) {
      price = todayBars[targetIdx].close;
    } else if (nextDayBars && targetIdx - todayBars.length < nextDayBars.length) {
      price = nextDayBars[targetIdx - todayBars.length].close;
    }
    if (price != null) {
      const move = (price - entryPrice) / entryPrice;
      accuracy[`dir_${mins}m`] = (move * dir > 0) ? 1 : 0;
      accuracy[`move_${mins}m`] = move * dir;
    }
  }

  let exitPrice = null, exitType = null;

  if (['GAP_REVERSAL', 'GAP_UP_REVERSAL', 'SECTOR_ROTATION_BOUNCE'].includes(signal.strategy)) {
    const maxBars = signal.exit_by_mins || 210;
    for (let i = entryBarIdx + 1; i < Math.min(todayBars.length, entryBarIdx + maxBars); i++) {
      const bar = todayBars[i];
      if (signal.stop_price != null) {
        if (signal.direction === 'CALL' && bar.low <= signal.stop_price) { exitPrice = signal.stop_price; exitType = 'STOP'; break; }
        if (signal.direction === 'PUT' && bar.high >= signal.stop_price) { exitPrice = signal.stop_price; exitType = 'STOP'; break; }
      }
      if (signal.t2 != null) {
        if (signal.direction === 'CALL' && bar.high >= signal.t2) { exitPrice = signal.t2; exitType = 'T2'; break; }
        if (signal.direction === 'PUT' && bar.low <= signal.t2) { exitPrice = signal.t2; exitType = 'T2'; break; }
      }
      if (signal.t1 != null && !exitType) {
        if (signal.direction === 'CALL' && bar.high >= signal.t1) { exitPrice = signal.t1; exitType = 'T1'; }
        if (signal.direction === 'PUT' && bar.low <= signal.t1) { exitPrice = signal.t1; exitType = 'T1'; }
      }
    }
    if (!exitType) {
      const exitBar = todayBars[Math.min(todayBars.length - 1, entryBarIdx + maxBars)];
      if (exitBar) { exitPrice = exitBar.close; exitType = 'TIME'; }
    }
  } else if (signal.hold === 'OVERNIGHT') {
    if (nextDayBars && nextDayBars.length > 0) {
      exitPrice = nextDayBars[0].open; exitType = 'NEXT_OPEN';
    } else {
      exitPrice = todayBars[todayBars.length - 1]?.close; exitType = 'CLOSE';
    }
  } else if (signal.hold === 'MULTIDAY') {
    if (nextDayBars && nextDayBars.length > 0) {
      const maxB = Math.min(nextDayBars.length, 1170);
      let best = nextDayBars[0].open;
      for (let i = 0; i < maxB; i++) if (nextDayBars[i].high > best) best = nextDayBars[i].high;
      exitPrice = best; exitType = 'BEST_3D';
    }
  }

  let pnl = null;
  if (exitPrice != null && entryPrice > 0) pnl = ((exitPrice - entryPrice) / entryPrice) * dir;
  return { ...accuracy, exitPrice, exitType, pnl, win: pnl != null && pnl > 0 };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[BACKTEST] Bulk loading all bar data...');

  // 1) Load ALL regular-session bars in one query, grouped by ticker+day
  const barsRes = await query(`
    SELECT ticker, DATE(ts AT TIME ZONE 'America/New_York') as day,
           open, high, low, close, volume,
           EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')::int * 60 +
           EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')::int as et_mins
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
    ORDER BY ticker, ts
  `);
  console.log(`[BACKTEST] Loaded ${barsRes.rows.length.toLocaleString()} bars`);

  // Index: barsByTicker[ticker][dayStr] = [bars...]
  const barsByTicker = {};
  for (const r of barsRes.rows) {
    const day = r.day.toISOString().split('T')[0];
    if (!barsByTicker[r.ticker]) barsByTicker[r.ticker] = {};
    if (!barsByTicker[r.ticker][day]) barsByTicker[r.ticker][day] = [];
    barsByTicker[r.ticker][day].push({
      open: parseFloat(r.open), high: parseFloat(r.high),
      low: parseFloat(r.low), close: parseFloat(r.close),
      volume: parseInt(r.volume), et_mins: parseInt(r.et_mins),
    });
  }

  // Get sorted unique trading days and tickers (exclude ETFs)
  const allDays = [...new Set(barsRes.rows.map(r => r.day.toISOString().split('T')[0]))].sort();
  const tickers = Object.keys(barsByTicker).filter(t => !['SPY', 'QQQ', 'IWM'].includes(t));
  console.log(`[BACKTEST] ${allDays.length} trading days: ${allDays[0]} → ${allDays[allDays.length - 1]}`);
  console.log(`[BACKTEST] ${tickers.length} tickers`);

  // Build daily close map: dailyClose[ticker][day] = last bar close
  const dailyClose = {};
  for (const [ticker, days] of Object.entries(barsByTicker)) {
    dailyClose[ticker] = {};
    for (const [day, bars] of Object.entries(days)) {
      if (bars.length > 0) dailyClose[ticker][day] = bars[bars.length - 1].close;
    }
  }

  // Load volume baselines
  const blRes = await query('SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines');
  const baselines = {};
  for (const r of blRes.rows) baselines[`${r.ticker}:${r.window_key}`] = parseFloat(r.avg_volume);
  console.log(`[BACKTEST] ${blRes.rows.length} baseline pairs loaded`);

  // Results
  const results = {
    GAP_REVERSAL: [], GAP_UP_REVERSAL: [], CAPITULATION_BOUNCE: [],
    VOL_DROP_PUT: [], SECTOR_ROTATION_BOUNCE: [], CONSEC_BOUNCE: [],
  };

  // Process each day
  for (let dayIdx = 1; dayIdx < allDays.length; dayIdx++) {
    const today = allDays[dayIdx];
    const yesterday = allDays[dayIdx - 1];
    const tomorrow = dayIdx + 1 < allDays.length ? allDays[dayIdx + 1] : null;
    // For CONSEC_BOUNCE multiday exit, get up to 3 days ahead
    const next3Days = allDays.slice(dayIdx + 1, dayIdx + 4);

    if (dayIdx % 20 === 0) console.log(`[BACKTEST] Day ${dayIdx}/${allDays.length}: ${today}`);

    // SPY/QQQ change for sector rotation
    const spyBarsToday = barsByTicker['SPY']?.[today] || [];
    const qqqBarsToday = barsByTicker['QQQ']?.[today] || [];
    const spyPrevClose = dailyClose['SPY']?.[yesterday] || 0;
    const qqqPrevClose = dailyClose['QQQ']?.[yesterday] || 0;
    const spyLatest = spyBarsToday.length > 0 ? spyBarsToday[spyBarsToday.length - 1].close : 0;
    const qqqLatest = qqqBarsToday.length > 0 ? qqqBarsToday[qqqBarsToday.length - 1].close : 0;
    const spyChange = spyPrevClose > 0 ? (spyLatest - spyPrevClose) / spyPrevClose : 0;
    const qqqChange = qqqPrevClose > 0 ? (qqqLatest - qqqPrevClose) / qqqPrevClose : 0;

    for (const ticker of tickers) {
      const bars = barsByTicker[ticker]?.[today];
      if (!bars || bars.length < 10) continue;

      const prevClose = dailyClose[ticker]?.[yesterday];
      if (!prevClose) continue;

      const todayOpen = bars[0].open;
      const firstCandle = { open: bars[0].open, high: bars[0].high, low: bars[0].low, close: bars[0].close };

      // Next day bars for overnight exits
      const nextBars = tomorrow ? (barsByTicker[ticker]?.[tomorrow] || null) : null;

      // Multi-day bars for CONSEC_BOUNCE
      let multiDayBars = null;
      if (next3Days.length > 0) {
        multiDayBars = [];
        for (const nd of next3Days) {
          const nb = barsByTicker[ticker]?.[nd];
          if (nb) multiDayBars.push(...nb);
        }
        if (multiDayBars.length === 0) multiDayBars = null;
      }

      // Volume baseline (sum first 2 hours of windows)
      let volBaseline = 0;
      for (let m = 570; m < 690; m += 15) {
        const wk = `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`;
        volBaseline += baselines[`${ticker}:${wk}`] || 0;
      }

      // 1) GAP_REVERSAL
      const gapSig = detectGapReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gapSig) {
        const outcome = measureOutcome(gapSig, 0, bars, nextBars);
        results.GAP_REVERSAL.push({ ...outcome, ticker, date: today });
      }

      // 2) GAP_UP_REVERSAL
      const gapUpSig = detectGapUpReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gapUpSig) {
        const outcome = measureOutcome(gapUpSig, 0, bars, nextBars);
        results.GAP_UP_REVERSAL.push({ ...outcome, ticker, date: today });
      }

      // 3) CAPITULATION_BOUNCE
      const midBars = bars.filter(b => b.et_mins >= 630 && b.et_mins <= 870);
      const capSig = detectCapitulationBounce(ticker, midBars, todayOpen, volBaseline);
      if (capSig) {
        const entryIdx = bars.findIndex(b => b.et_mins >= 630) + (capSig.bar_index || 0);
        const outcome = measureOutcome(capSig, entryIdx, bars, nextBars);
        results.CAPITULATION_BOUNCE.push({ ...outcome, ticker, date: today });
      }

      // 4) VOL_DROP_PUT
      const vdpSig = detectVolDropPut(ticker, midBars, todayOpen, volBaseline);
      if (vdpSig) {
        const entryIdx = bars.findIndex(b => b.et_mins >= 630) + (vdpSig.bar_index || 0);
        const outcome = measureOutcome(vdpSig, entryIdx, bars, nextBars);
        results.VOL_DROP_PUT.push({ ...outcome, ticker, date: today });
      }

      // 5) SECTOR_ROTATION_BOUNCE
      const secSig = detectSectorRotation(ticker, todayOpen, prevClose, spyChange, qqqChange);
      if (secSig) {
        const outcome = measureOutcome(secSig, 0, bars, nextBars);
        results.SECTOR_ROTATION_BOUNCE.push({ ...outcome, ticker, date: today });
      }

      // 6) CONSEC_BOUNCE — need last 4 daily closes
      const recentDays = allDays.slice(Math.max(0, dayIdx - 4), dayIdx).filter(d => dailyClose[ticker]?.[d] != null);
      const recentCloses = recentDays.map(d => dailyClose[ticker][d]);
      const consecSig = detectConsecBounce(ticker, recentCloses);
      if (consecSig) {
        const outcome = measureOutcome(consecSig, 0, bars, multiDayBars);
        results.CONSEC_BOUNCE.push({ ...outcome, ticker, date: today, consec: consecSig.consecutive_days });
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(100));
  console.log('  6-MONTH STRATEGY BACKTEST RESULTS');
  console.log('  ' + allDays[0] + ' → ' + allDays[allDays.length - 1] + '  (' + allDays.length + ' trading days, ' + tickers.length + ' tickers)');
  console.log('='.repeat(100));

  for (const [strategy, trades] of Object.entries(results)) {
    console.log(`\n${'─'.repeat(100)}`);
    console.log(`  ${strategy}  (${trades.length} signals)`);
    console.log(`${'─'.repeat(100)}`);

    if (trades.length === 0) { console.log('  No signals fired'); continue; }

    for (const mins of [30, 60, 120]) {
      const key = `dir_${mins}m`;
      const moveKey = `move_${mins}m`;
      const valid = trades.filter(t => t[key] != null);
      if (valid.length === 0) continue;
      const correct = valid.filter(t => t[key] === 1).length;
      const avgMove = valid.reduce((s, t) => s + (t[moveKey] || 0), 0) / valid.length;
      console.log(`  ${mins}min accuracy: ${(correct / valid.length * 100).toFixed(1)}% (${correct}/${valid.length})  avg directional move: ${avgMove >= 0 ? '+' : ''}${(avgMove * 100).toFixed(2)}%`);
    }

    const withPnl = trades.filter(t => t.pnl != null);
    if (withPnl.length > 0) {
      const wins = withPnl.filter(t => t.win);
      const losses = withPnl.filter(t => !t.win);
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length * 100 : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length * 100 : 0;
      const totalPnl = withPnl.reduce((s, t) => s + t.pnl, 0) * 100;

      console.log(`  Win rate:     ${(wins.length / withPnl.length * 100).toFixed(1)}% (${wins.length}W / ${losses.length}L of ${withPnl.length})`);
      console.log(`  Avg winner:   +${avgWin.toFixed(2)}%`);
      console.log(`  Avg loser:    ${avgLoss.toFixed(2)}%`);
      console.log(`  Total P&L:    ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`);

      const exitTypes = {};
      for (const t of withPnl) exitTypes[t.exitType] = (exitTypes[t.exitType] || 0) + 1;
      console.log(`  Exit types:   ${Object.entries(exitTypes).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    }

    const tickerStats = {};
    for (const t of trades) {
      if (!tickerStats[t.ticker]) tickerStats[t.ticker] = { count: 0, wins: 0, pnl: 0 };
      tickerStats[t.ticker].count++;
      if (t.win) tickerStats[t.ticker].wins++;
      if (t.pnl != null) tickerStats[t.ticker].pnl += t.pnl;
    }
    const top = Object.entries(tickerStats).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
    console.log(`  Top tickers:  ${top.map(([t, s]) => `${t}(${s.count}, ${(s.wins / s.count * 100).toFixed(0)}%W)`).join('  ')}`);
  }

  const all = Object.values(results).flat();
  const allPnl = all.filter(t => t.pnl != null);
  console.log(`\n${'='.repeat(100)}`);
  console.log(`  TOTAL: ${all.length} signals  ${allPnl.filter(t => t.win).length}W / ${allPnl.filter(t => !t.win).length}L`);
  if (allPnl.length > 0) {
    console.log(`  Overall win rate: ${(allPnl.filter(t => t.win).length / allPnl.length * 100).toFixed(1)}%`);
    console.log(`  Cumulative P&L: ${(allPnl.reduce((s, t) => s + t.pnl, 0) * 100).toFixed(2)}%`);
  }
  console.log('='.repeat(100));

  process.exit(0);
}

main().catch(err => { console.error('[BACKTEST] FATAL:', err.message); process.exit(1); });
