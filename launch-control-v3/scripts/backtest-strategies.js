/**
 * 6-Month Strategy Backtest Against Stored Bars
 *
 * For each trading day in lc_v3.bars, replay all 6 strategy scanners
 * against actual bar data. Measure directional accuracy at 30/60/120 min,
 * win rate per strategy exit rules, and avg move on winners vs losers.
 *
 * Run: node scripts/backtest-strategies.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

// ── Strategy detection logic (mirrors scanners) ──────────────────────────────

function detectGapReversal(ticker, todayOpen, prevClose, firstCandle) {
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap < -0.03 || gap > -0.02) return null;
  if (firstCandle.close <= firstCandle.open) return null; // need green candle
  const gapAmount = prevClose - todayOpen;
  return {
    strategy: 'GAP_REVERSAL', direction: 'CALL', ticker,
    entry_price: firstCandle.close,
    stop_price: firstCandle.low || firstCandle.open,
    t1: todayOpen + gapAmount * 0.40,
    t2: todayOpen + gapAmount * 0.77,
    exit_by_mins: 210, // by 13:00 ET (3.5h after open)
    gap_pct: gap * 100,
  };
}

function detectGapUpReversal(ticker, todayOpen, prevClose, firstCandle) {
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap < 0.02 || gap > 0.03) return null;
  if (firstCandle.close >= firstCandle.open) return null; // need red candle
  const gapAmount = todayOpen - prevClose;
  return {
    strategy: 'GAP_UP_REVERSAL', direction: 'PUT', ticker,
    entry_price: firstCandle.close,
    stop_price: firstCandle.high || firstCandle.open,
    t1: todayOpen - gapAmount * 0.40,
    t2: prevClose,
    exit_by_mins: 210,
    gap_pct: gap * 100,
  };
}

function detectCapitulationBounce(ticker, todayBars, todayOpen, volumeBaseline) {
  // Check bars around 11:00-14:00 ET for 3%+ drop on high volume
  // We scan at each bar — if price drops 3%+ from open on high vol, signal fires
  for (let i = 0; i < todayBars.length; i++) {
    const bar = todayBars[i];
    const drop = (bar.close - todayOpen) / todayOpen;
    if (drop > -0.03) continue;

    // Cumulative volume up to this point
    let cumVol = 0;
    for (let j = 0; j <= i; j++) cumVol += todayBars[j].volume;

    // Check bounce guard: if price already >1.5% above open, skip
    if ((bar.close - todayOpen) / todayOpen > 0.015) continue;

    const volRatio = volumeBaseline > 0 ? cumVol / volumeBaseline : 0;
    if (volRatio < 1.5) continue;

    return {
      strategy: 'CAPITULATION_BOUNCE', direction: 'CALL', ticker,
      entry_price: todayOpen,
      bar_index: i,
      hold: 'OVERNIGHT',
      drop_pct: drop * 100,
    };
  }
  return null;
}

function detectVolDropPut(ticker, todayBars, todayOpen, volumeBaseline) {
  for (let i = 0; i < todayBars.length; i++) {
    const bar = todayBars[i];
    const drop = (bar.close - todayOpen) / todayOpen;
    if (drop > -0.03) continue;

    let cumVol = 0;
    for (let j = 0; j <= i; j++) cumVol += todayBars[j].volume;

    const volRatio = volumeBaseline > 0 ? cumVol / volumeBaseline : 0;
    if (volRatio >= 1.5) continue; // needs LOW volume (< 1.5x)
    if (volRatio <= 0) continue;

    return {
      strategy: 'VOL_DROP_PUT', direction: 'PUT', ticker,
      entry_price: bar.close,
      bar_index: i,
      hold: 'OVERNIGHT',
      drop_pct: drop * 100,
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
    entry_price: todayOpen,
    t1: prevClose * 0.985,
    t2: prevClose,
    exit_by_mins: 270, // by 14:00 ET
    gap_pct: gap * 100,
  };
}

function detectConsecBounce(ticker, dailyCloses) {
  // Need at least 3 recent daily closes
  if (dailyCloses.length < 3) return null;
  const n = dailyCloses.length;
  const c0 = dailyCloses[n - 3];
  const c1 = dailyCloses[n - 2];
  const c2 = dailyCloses[n - 1];
  const drop1 = (c1 - c0) / c0;
  const drop2 = (c2 - c1) / c1;
  if (drop1 > -0.03 || drop2 > -0.03) return null;

  let consecutiveDays = 2;
  if (dailyCloses.length >= 4) {
    const cPrev = dailyCloses[n - 4];
    const drop0 = (c0 - cPrev) / cPrev;
    if (drop0 <= -0.03) consecutiveDays = 3;
  }

  return {
    strategy: 'CONSEC_BOUNCE', direction: 'CALL', ticker,
    entry_price: c2,
    consecutive_days: consecutiveDays,
    hold: 'MULTIDAY',
    exit_within_days: 3,
  };
}

// ── Outcome measurement ──────────────────────────────────────────────────────

function measureOutcome(signal, entryBarIdx, todayBars, nextDayBars) {
  const entryPrice = signal.entry_price;
  const dir = signal.direction === 'CALL' ? 1 : -1;

  // Directional accuracy at 30min, 60min, 120min after signal
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
      accuracy[`move_${mins}m`] = move * dir; // directional move
    }
  }

  // Strategy-specific exit logic
  let exitPrice = null;
  let exitType = null;

  if (signal.strategy === 'GAP_REVERSAL' || signal.strategy === 'GAP_UP_REVERSAL' || signal.strategy === 'SECTOR_ROTATION_BOUNCE') {
    // Intraday strategies — check stop, T1, T2 then forced exit
    const maxBars = signal.exit_by_mins || 210;
    for (let i = entryBarIdx + 1; i < Math.min(todayBars.length, entryBarIdx + maxBars); i++) {
      const bar = todayBars[i];
      if (signal.stop_price != null) {
        if (signal.direction === 'CALL' && bar.low <= signal.stop_price) {
          exitPrice = signal.stop_price; exitType = 'STOP'; break;
        }
        if (signal.direction === 'PUT' && bar.high >= signal.stop_price) {
          exitPrice = signal.stop_price; exitType = 'STOP'; break;
        }
      }
      if (signal.t2 != null) {
        if (signal.direction === 'CALL' && bar.high >= signal.t2) {
          exitPrice = signal.t2; exitType = 'T2'; break;
        }
        if (signal.direction === 'PUT' && bar.low <= signal.t2) {
          exitPrice = signal.t2; exitType = 'T2'; break;
        }
      }
      if (signal.t1 != null && !exitType) {
        if (signal.direction === 'CALL' && bar.high >= signal.t1) {
          exitPrice = signal.t1; exitType = 'T1';
          // Don't break — keep looking for T2
        }
        if (signal.direction === 'PUT' && bar.low <= signal.t1) {
          exitPrice = signal.t1; exitType = 'T1';
        }
      }
    }
    if (!exitType) {
      // Forced exit at time limit or close
      const exitBar = todayBars[Math.min(todayBars.length - 1, entryBarIdx + maxBars)];
      if (exitBar) { exitPrice = exitBar.close; exitType = 'TIME'; }
    }
  } else if (signal.hold === 'OVERNIGHT') {
    // CAPITULATION_BOUNCE and VOL_DROP_PUT — exit at next day open
    if (nextDayBars && nextDayBars.length > 0) {
      exitPrice = nextDayBars[0].open;
      exitType = 'NEXT_OPEN';
    } else {
      // No next day data — use today's close
      exitPrice = todayBars[todayBars.length - 1]?.close;
      exitType = 'CLOSE';
    }
  } else if (signal.hold === 'MULTIDAY') {
    // CONSEC_BOUNCE — exit within 3 days, at best close
    // Entry is at prev day close, so look at next 3 days of bars
    if (nextDayBars && nextDayBars.length > 0) {
      // Check peak over available bars (up to 3 days worth = ~1170 bars)
      const maxBars = Math.min(nextDayBars.length, 1170);
      let bestPrice = nextDayBars[0].open;
      for (let i = 0; i < maxBars; i++) {
        if (nextDayBars[i].high > bestPrice) bestPrice = nextDayBars[i].high;
      }
      exitPrice = bestPrice;
      exitType = 'BEST_3D';
    }
  }

  let pnl = null;
  if (exitPrice != null && entryPrice > 0) {
    pnl = ((exitPrice - entryPrice) / entryPrice) * dir;
  }

  return { ...accuracy, exitPrice, exitType, pnl, win: pnl != null && pnl > 0 };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[BACKTEST] Loading bar data...');

  // Get all trading days
  const daysRes = await query(`
    SELECT DISTINCT DATE(ts AT TIME ZONE 'America/New_York') as day
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
    ORDER BY day
  `);
  const tradingDays = daysRes.rows.map(r => r.day.toISOString().split('T')[0]);
  console.log(`[BACKTEST] ${tradingDays.length} trading days from ${tradingDays[0]} to ${tradingDays[tradingDays.length - 1]}`);

  // Get all tickers
  const tickerRes = await query('SELECT DISTINCT ticker FROM lc_v3.bars WHERE session = \'REGULAR\' AND ticker NOT IN (\'SPY\',\'QQQ\',\'IWM\')');
  const tickers = tickerRes.rows.map(r => r.ticker);
  console.log(`[BACKTEST] ${tickers.length} tickers`);

  // Load volume baselines
  const blRes = await query('SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines');
  const baselines = {};
  for (const r of blRes.rows) baselines[`${r.ticker}:${r.window_key}`] = parseFloat(r.avg_volume);

  // Results collector
  const results = {
    GAP_REVERSAL: [], GAP_UP_REVERSAL: [], CAPITULATION_BOUNCE: [],
    VOL_DROP_PUT: [], SECTOR_ROTATION_BOUNCE: [], CONSEC_BOUNCE: [],
  };

  // Process each day
  for (let dayIdx = 1; dayIdx < tradingDays.length; dayIdx++) {
    const today = tradingDays[dayIdx];
    const yesterday = tradingDays[dayIdx - 1];
    const tomorrow = dayIdx + 1 < tradingDays.length ? tradingDays[dayIdx + 1] : null;

    if (dayIdx % 20 === 0) {
      console.log(`[BACKTEST] Processing day ${dayIdx}/${tradingDays.length}: ${today}`);
    }

    // Load today's bars for all tickers (regular session only, sorted by time)
    const barsRes = await query(`
      SELECT ticker, open, high, low, close, volume,
             EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
             EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') as et_mins
      FROM lc_v3.bars
      WHERE session = 'REGULAR'
        AND DATE(ts AT TIME ZONE 'America/New_York') = $1
      ORDER BY ticker, ts
    `, [today]);

    // Group by ticker
    const barsByTicker = {};
    for (const row of barsRes.rows) {
      if (!barsByTicker[row.ticker]) barsByTicker[row.ticker] = [];
      barsByTicker[row.ticker].push({
        open: parseFloat(row.open), high: parseFloat(row.high),
        low: parseFloat(row.low), close: parseFloat(row.close),
        volume: parseInt(row.volume), et_mins: parseInt(row.et_mins),
      });
    }

    // Load yesterday's close per ticker
    const prevRes = await query(`
      SELECT ticker, close FROM lc_v3.bars
      WHERE session = 'REGULAR'
        AND DATE(ts AT TIME ZONE 'America/New_York') = $1
        AND ticker = ANY($2)
      ORDER BY ticker, ts
    `, [yesterday, tickers]);
    const prevCloses = {};
    for (const r of prevRes.rows) prevCloses[r.ticker] = parseFloat(r.close); // last one wins (latest bar)

    // Load next day bars for overnight strategies
    let nextDayBars = {};
    if (tomorrow) {
      const nextRes = await query(`
        SELECT ticker, open, high, low, close, volume FROM lc_v3.bars
        WHERE session = 'REGULAR'
          AND DATE(ts AT TIME ZONE 'America/New_York') = $1
        ORDER BY ticker, ts
      `, [tomorrow]);
      for (const r of nextRes.rows) {
        if (!nextDayBars[r.ticker]) nextDayBars[r.ticker] = [];
        nextDayBars[r.ticker].push({
          open: parseFloat(r.open), high: parseFloat(r.high),
          low: parseFloat(r.low), close: parseFloat(r.close),
          volume: parseInt(r.volume),
        });
      }
    }

    // SPY/QQQ change for sector rotation
    const spyBars = barsByTicker['SPY'] || [];
    const qqqBars = barsByTicker['QQQ'] || [];
    const spyPrevClose = prevCloses['SPY'] || 0;
    const qqqPrevClose = prevCloses['QQQ'] || 0;
    const spyLatest = spyBars.length > 0 ? spyBars[spyBars.length - 1].close : 0;
    const qqqLatest = qqqBars.length > 0 ? qqqBars[qqqBars.length - 1].close : 0;
    const spyChange = spyPrevClose > 0 ? (spyLatest - spyPrevClose) / spyPrevClose : 0;
    const qqqChange = qqqPrevClose > 0 ? (qqqLatest - qqqPrevClose) / qqqPrevClose : 0;

    // Build daily closes history for CONSEC_BOUNCE (need last 5 days)
    // We'll use prevCloses from successive days — but simpler to just track
    // We build from bars data: last close of each of the 5 preceding days
    let dailyCloseHistory = {};
    if (dayIdx >= 4) {
      const histDays = tradingDays.slice(Math.max(0, dayIdx - 4), dayIdx + 1);
      const histRes = await query(`
        SELECT ticker, DATE(ts AT TIME ZONE 'America/New_York') as day, close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
          AND DATE(ts AT TIME ZONE 'America/New_York') = ANY($1)
        ORDER BY ticker, ts
      `, [histDays]);
      for (const r of histRes.rows) {
        const t = r.ticker;
        const d = r.day.toISOString().split('T')[0];
        if (!dailyCloseHistory[t]) dailyCloseHistory[t] = {};
        dailyCloseHistory[t][d] = parseFloat(r.close); // last bar wins
      }
    }

    for (const ticker of tickers) {
      const bars = barsByTicker[ticker];
      if (!bars || bars.length < 10) continue;

      const prevClose = prevCloses[ticker];
      if (!prevClose) continue;

      const todayOpen = bars[0].open;
      const firstCandle = {
        open: bars[0].open, high: bars[0].high,
        low: bars[0].low, close: bars[0].close,
      };

      // Total volume baseline for this ticker (sum of first ~2 hours of windows)
      let volBaseline = 0;
      for (let m = 570; m < 690; m += 15) {
        const wk = `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`;
        volBaseline += baselines[`${ticker}:${wk}`] || 0;
      }

      // 1) GAP_REVERSAL
      const gapSig = detectGapReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gapSig) {
        const outcome = measureOutcome(gapSig, 0, bars, nextDayBars[ticker]);
        results.GAP_REVERSAL.push({ ...outcome, ticker, date: today, gap_pct: gapSig.gap_pct });
      }

      // 2) GAP_UP_REVERSAL
      const gapUpSig = detectGapUpReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gapUpSig) {
        const outcome = measureOutcome(gapUpSig, 0, bars, nextDayBars[ticker]);
        results.GAP_UP_REVERSAL.push({ ...outcome, ticker, date: today, gap_pct: gapUpSig.gap_pct });
      }

      // 3) CAPITULATION_BOUNCE (scan mid-day bars)
      const midBars = bars.filter(b => b.et_mins >= 630 && b.et_mins <= 870); // 10:30-14:30 ET
      const capSig = detectCapitulationBounce(ticker, midBars, todayOpen, volBaseline);
      if (capSig) {
        // Entry at the bar where signal fires — measure from there
        const entryIdx = bars.findIndex(b => b.et_mins >= 630) + (capSig.bar_index || 0);
        const outcome = measureOutcome(capSig, entryIdx, bars, nextDayBars[ticker]);
        results.CAPITULATION_BOUNCE.push({ ...outcome, ticker, date: today, drop_pct: capSig.drop_pct });
      }

      // 4) VOL_DROP_PUT
      const vdpSig = detectVolDropPut(ticker, midBars, todayOpen, volBaseline);
      if (vdpSig) {
        const entryIdx = bars.findIndex(b => b.et_mins >= 630) + (vdpSig.bar_index || 0);
        const outcome = measureOutcome(vdpSig, entryIdx, bars, nextDayBars[ticker]);
        results.VOL_DROP_PUT.push({ ...outcome, ticker, date: today, drop_pct: vdpSig.drop_pct });
      }

      // 5) SECTOR_ROTATION_BOUNCE
      const secSig = detectSectorRotation(ticker, todayOpen, prevClose, spyChange, qqqChange);
      if (secSig) {
        const outcome = measureOutcome(secSig, 0, bars, nextDayBars[ticker]);
        results.SECTOR_ROTATION_BOUNCE.push({ ...outcome, ticker, date: today, gap_pct: secSig.gap_pct });
      }

      // 6) CONSEC_BOUNCE
      if (dailyCloseHistory[ticker]) {
        const sortedDays = Object.keys(dailyCloseHistory[ticker]).sort();
        const closes = sortedDays.map(d => dailyCloseHistory[ticker][d]);
        const consecSig = detectConsecBounce(ticker, closes);
        if (consecSig) {
          // Entry at prev close, first bar of today is the trade
          const outcome = measureOutcome(consecSig, 0, bars, nextDayBars[ticker]);
          results.CONSEC_BOUNCE.push({ ...outcome, ticker, date: today, consec: consecSig.consecutive_days });
        }
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(100));
  console.log('  6-MONTH STRATEGY BACKTEST RESULTS');
  console.log('  ' + tradingDays[0] + ' → ' + tradingDays[tradingDays.length - 1]);
  console.log('='.repeat(100));

  for (const [strategy, trades] of Object.entries(results)) {
    console.log(`\n${'─'.repeat(100)}`);
    console.log(`  ${strategy}  (${trades.length} signals)`);
    console.log(`${'─'.repeat(100)}`);

    if (trades.length === 0) {
      console.log('  No signals fired');
      continue;
    }

    // Directional accuracy
    for (const mins of [30, 60, 120]) {
      const key = `dir_${mins}m`;
      const moveKey = `move_${mins}m`;
      const valid = trades.filter(t => t[key] != null);
      if (valid.length === 0) continue;
      const correct = valid.filter(t => t[key] === 1).length;
      const avgMove = valid.reduce((s, t) => s + (t[moveKey] || 0), 0) / valid.length;
      console.log(`  ${mins}min directional accuracy: ${(correct / valid.length * 100).toFixed(1)}% (${correct}/${valid.length})  avg move: ${(avgMove * 100).toFixed(2)}%`);
    }

    // Win rate by exit rules
    const withPnl = trades.filter(t => t.pnl != null);
    if (withPnl.length > 0) {
      const wins = withPnl.filter(t => t.win);
      const losses = withPnl.filter(t => !t.win);
      const winRate = wins.length / withPnl.length * 100;
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length * 100 : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length * 100 : 0;
      const totalPnl = withPnl.reduce((s, t) => s + t.pnl, 0) * 100;

      console.log(`  Win rate:       ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L of ${withPnl.length})`);
      console.log(`  Avg winner:     +${avgWin.toFixed(2)}%`);
      console.log(`  Avg loser:      ${avgLoss.toFixed(2)}%`);
      console.log(`  Total P&L:      ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}% (sum of all trades)`);

      // Exit type breakdown
      const exitTypes = {};
      for (const t of withPnl) {
        exitTypes[t.exitType] = (exitTypes[t.exitType] || 0) + 1;
      }
      console.log(`  Exit types:     ${Object.entries(exitTypes).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    }

    // Top tickers
    const tickerStats = {};
    for (const t of trades) {
      if (!tickerStats[t.ticker]) tickerStats[t.ticker] = { count: 0, wins: 0, pnl: 0 };
      tickerStats[t.ticker].count++;
      if (t.win) tickerStats[t.ticker].wins++;
      if (t.pnl != null) tickerStats[t.ticker].pnl += t.pnl;
    }
    const topTickers = Object.entries(tickerStats)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);
    console.log(`  Top tickers:    ${topTickers.map(([t, s]) => `${t}(${s.count} sigs, ${(s.wins / s.count * 100).toFixed(0)}%W, ${(s.pnl * 100).toFixed(1)}%)`).join('  ')}`);
  }

  // Summary
  const allTrades = Object.values(results).flat();
  const allWithPnl = allTrades.filter(t => t.pnl != null);
  console.log(`\n${'='.repeat(100)}`);
  console.log(`  TOTAL: ${allTrades.length} signals, ${allWithPnl.filter(t => t.win).length}W / ${allWithPnl.filter(t => !t.win).length}L`);
  console.log(`  Overall win rate: ${(allWithPnl.filter(t => t.win).length / allWithPnl.length * 100).toFixed(1)}%`);
  console.log(`  Total cumulative P&L: ${(allWithPnl.reduce((s, t) => s + t.pnl, 0) * 100).toFixed(2)}%`);
  console.log('='.repeat(100));

  process.exit(0);
}

main().catch(err => { console.error('[BACKTEST] FATAL:', err.message); process.exit(1); });
