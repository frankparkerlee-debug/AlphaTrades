/**
 * Strategy Trajectory Backtest — Minute-by-Minute Greeks & Optimal Exit Analysis
 *
 * For every strategy signal detected across 6 months of stored bars, walks
 * forward minute-by-minute and estimates option greeks (delta, theta, IV, vega)
 * to compute estimated option P&L at each minute. Stores trajectories in
 * lc_v3.signal_trajectories and identifies the optimal exit minute where
 * estimated_option_pnl_pct peaked.
 *
 * Run: node --max-old-space-size=512 scripts/backtest-trajectory.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

// ── DTE assumptions per strategy ─────────────────────────────────────────────
const STRATEGY_DTE = {
  GAP_REVERSAL: 1,
  GAP_UP_REVERSAL: 1,
  CAPITULATION_BOUNCE: 2,
  VOL_DROP_PUT: 2,
  SECTOR_ROTATION_BOUNCE: 1,
  CONSEC_BOUNCE: 5,
};

// ── Greeks model parameters ──────────────────────────────────────────────────
const INITIAL_DELTA = 0.50;
const GAMMA_PER_PCT = 0.02;        // delta change per 1% stock move
const VEGA_MULTIPLIER = 0.0025;    // 10% IV change → 2.5% option price move (0.25% per 1% IV)
const MAX_DELTA = 0.99;
const MIN_DELTA = 0.05;

/**
 * Theta decay rate as fraction of option value per day.
 * Calibrated from real ATM option theta observations.
 */
const THETA_BY_DTE = { 0: -0.18, 1: -0.10, 2: -0.07, 3: -0.055, 4: -0.045, 5: -0.04 };
function thetaPerDay(dte) {
  const rounded = Math.max(0, Math.min(5, Math.round(dte)));
  return THETA_BY_DTE[rounded] ?? -0.04;
}

// ── Strategy detection (copied from backtest-strategies.js) ──────────────────

function detectGapReversal(ticker, todayOpen, prevClose, firstCandle) {
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap < -0.03 || gap > -0.02) return null;
  if (firstCandle.close <= firstCandle.open) return null;
  const gapAmount = prevClose - todayOpen;
  return {
    strategy: 'GAP_REVERSAL', direction: 'CALL', ticker,
    entry_price: firstCandle.close,
    stop_price: (firstCandle.low || firstCandle.open) - firstCandle.close * 0.005,
    t1: todayOpen + gapAmount * 0.40, t2: todayOpen + gapAmount * 0.77,
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
    stop_price: (firstCandle.high || firstCandle.open) + firstCandle.close * 0.005,
    t1: todayOpen - gapAmount * 0.40, t2: prevClose,
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
      entry_price: bar.close, bar_index: i, hold: 'OVERNIGHT', drop_pct: drop * 100,
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

// ── Greeks trajectory builder ────────────────────────────────────────────────

/**
 * Build minute-by-minute trajectory with estimated greeks.
 *
 * @param {Object} signal - strategy signal
 * @param {number} entryBarIdx - index in todayBars where entry occurs
 * @param {Array} todayBars - all bars for today (sorted by time)
 * @param {Array|null} nextDayBars - bars for next trading day
 * @param {Object} baselines - volume baselines { "TICKER:HH:MM": avg_volume }
 * @returns {{ trajectory: Array, optimalMinute: number }}
 */
function buildTrajectory(signal, entryBarIdx, todayBars, nextDayBars, baselines) {
  const dir = signal.direction === 'CALL' ? 1 : -1;
  const dte = STRATEGY_DTE[signal.strategy] || 2;
  const entryPrice = signal.entry_price;
  const trajectory = [];

  // Build the forward bars from entry
  const forwardBars = [];
  for (let i = entryBarIdx; i < todayBars.length; i++) forwardBars.push(todayBars[i]);
  if (nextDayBars) for (const b of nextDayBars) forwardBars.push(b);

  // Determine max minutes to track based on strategy
  let maxMins;
  if (signal.exit_by_mins) maxMins = signal.exit_by_mins + 10; // a bit past exit window
  else if (signal.hold === 'OVERNIGHT') maxMins = todayBars.length - entryBarIdx + 5;
  else if (signal.hold === 'MULTIDAY') maxMins = Math.min(forwardBars.length, 780); // ~2 days
  else maxMins = 240;

  const numBars = Math.min(forwardBars.length, maxMins);

  // State for running estimates
  let delta = INITIAL_DELTA;
  let cumulativeTheta = 0;
  let cumulativeIVChange = 0;
  let prevPrice = entryPrice;
  let bestPnl = -Infinity;
  let optimalMinute = 0;

  for (let m = 0; m < numBars; m++) {
    const bar = forwardBars[m];
    const stockPrice = bar.close;
    const stockMovePct = (stockPrice - entryPrice) / entryPrice; // total move from entry
    const minuteMovePct = (stockPrice - prevPrice) / prevPrice;  // move this minute
    const favorableMove = stockMovePct * dir; // positive when stock moves in our direction

    // ── Delta estimate ───────────────────────────────────────────────────
    // Gamma effect: delta moves toward 1.0 as stock moves favorably
    const deltaShift = GAMMA_PER_PCT * minuteMovePct * 100 * dir;
    delta = Math.max(MIN_DELTA, Math.min(MAX_DELTA, delta + deltaShift));

    // ── Theta decay ──────────────────────────────────────────────────────
    // Effective DTE decreases each minute (390 minutes per trading day)
    const effectiveDTE = Math.max(0.01, dte - m / 390);
    const thetaThisMinute = thetaPerDay(effectiveDTE) / 390; // fraction per minute
    cumulativeTheta += thetaThisMinute;

    // ── IV change proxy ──────────────────────────────────────────────────
    // Compute volume ratio for this minute vs baseline
    const barHour = Math.floor((bar.et_mins || 570) / 60);
    const barMinBlock = Math.floor(((bar.et_mins || 570) % 60) / 15) * 15;
    const windowKey = `${barHour.toString().padStart(2, '0')}:${barMinBlock.toString().padStart(2, '0')}`;
    const minuteBaseline = (baselines[`${signal.ticker}:${windowKey}`] || 0) / 15;
    const volRatio = minuteBaseline > 0 ? bar.volume / minuteBaseline : 1.0;

    if (volRatio > 3.0) cumulativeIVChange += 5.0;       // +5% IV
    else if (volRatio < 0.5) cumulativeIVChange -= 3.0;   // -3% IV

    // ── Option P&L attribution ───────────────────────────────────────────
    // delta_gain: integral of delta * stock_move (simplified: avg_delta * total_move)
    const avgDelta = (INITIAL_DELTA + delta) / 2;
    const deltaGain = avgDelta * favorableMove * 100;      // as % of option value

    // gamma_gain: 0.5 * gamma * move^2 (convexity bonus)
    const gammaGain = 0.5 * GAMMA_PER_PCT * (favorableMove * 100) ** 2 / 100;

    // vega_gain: vega_sensitivity * IV_change
    const vegaGain = VEGA_MULTIPLIER * cumulativeIVChange;

    // theta_decay: cumulative (negative)
    const thetaDecay = cumulativeTheta * 100; // as %

    const estimatedPnl = deltaGain + gammaGain + vegaGain + thetaDecay;

    trajectory.push({
      minute_offset: m,
      stock_price: stockPrice,
      stock_pnl_pct: stockMovePct * dir * 100,
      estimated_delta: parseFloat(delta.toFixed(4)),
      estimated_theta_decay: parseFloat((cumulativeTheta * 100).toFixed(4)),
      estimated_iv_change: parseFloat(cumulativeIVChange.toFixed(2)),
      estimated_option_pnl_pct: parseFloat(estimatedPnl.toFixed(4)),
      volume_ratio: parseFloat(volRatio.toFixed(2)),
    });

    if (estimatedPnl > bestPnl) {
      bestPnl = estimatedPnl;
      optimalMinute = m;
    }

    prevPrice = stockPrice;
  }

  return { trajectory, optimalMinute };
}

// ── Load bars for a single day ───────────────────────────────────────────────

async function loadDayBars(day) {
  const res = await query(`
    SELECT ticker, open, high, low, close, volume,
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
      open: parseFloat(r.open), high: parseFloat(r.high),
      low: parseFloat(r.low), close: parseFloat(r.close),
      volume: parseInt(r.volume), et_mins: parseInt(r.et_mins),
    });
  }
  return byTicker;
}

// ── Batch insert trajectories ────────────────────────────────────────────────

async function insertTrajectoryBatch(rows) {
  if (rows.length === 0) return;

  // Build multi-row INSERT (batches of 500 to stay under param limit)
  const batchSize = 500;
  for (let b = 0; b < rows.length; b += batchSize) {
    const batch = rows.slice(b, b + batchSize);
    const values = [];
    const params = [];
    let idx = 1;

    for (const r of batch) {
      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9},$${idx+10},$${idx+11},$${idx+12})`);
      params.push(
        r.strategy, r.ticker, r.trade_date, r.direction, r.entry_price,
        r.minute_offset, r.stock_price, r.stock_pnl_pct,
        r.estimated_delta, r.estimated_theta_decay, r.estimated_iv_change,
        r.estimated_option_pnl_pct, r.optimal_exit_minute,
      );
      idx += 13;
    }

    await query(`
      INSERT INTO lc_v3.signal_trajectories (
        strategy, ticker, trade_date, direction, entry_price,
        minute_offset, stock_price, stock_pnl_pct,
        estimated_delta, estimated_theta_decay, estimated_iv_change,
        estimated_option_pnl_pct, optimal_exit_minute
      ) VALUES ${values.join(',')}
    `, params);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[TRAJECTORY] Starting minute-by-minute greeks trajectory backtest...');

  // Create table
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.signal_trajectories (
      id SERIAL PRIMARY KEY,
      strategy VARCHAR(30) NOT NULL,
      ticker VARCHAR(10) NOT NULL,
      trade_date DATE NOT NULL,
      direction VARCHAR(4) NOT NULL,
      entry_price DECIMAL(12,4),
      minute_offset INTEGER NOT NULL,
      stock_price DECIMAL(12,4),
      stock_pnl_pct DECIMAL(8,4),
      estimated_delta DECIMAL(6,4),
      estimated_theta_decay DECIMAL(8,4),
      estimated_iv_change DECIMAL(8,4),
      estimated_option_pnl_pct DECIMAL(8,4),
      optimal_exit_minute INTEGER
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_traj_strat ON lc_v3.signal_trajectories(strategy)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_traj_ticker ON lc_v3.signal_trajectories(ticker, trade_date)`);

  // Truncate previous run
  await query('TRUNCATE lc_v3.signal_trajectories');
  console.log('[TRAJECTORY] Table ready (truncated previous data)');

  // Load metadata
  const daysRes = await query(`
    SELECT DISTINCT DATE(ts AT TIME ZONE 'America/New_York') as day
    FROM lc_v3.bars WHERE session = 'REGULAR' ORDER BY day
  `);
  const allDays = daysRes.rows.map(r => r.day.toISOString().split('T')[0]);
  console.log(`[TRAJECTORY] ${allDays.length} trading days: ${allDays[0]} → ${allDays[allDays.length - 1]}`);

  const dcRes = await query(`
    SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
      ticker, DATE(ts AT TIME ZONE 'America/New_York') as day, close
    FROM lc_v3.bars WHERE session = 'REGULAR'
    ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'), ts DESC
  `);
  const dailyClose = {};
  for (const r of dcRes.rows) {
    const day = r.day.toISOString().split('T')[0];
    if (!dailyClose[r.ticker]) dailyClose[r.ticker] = {};
    dailyClose[r.ticker][day] = parseFloat(r.close);
  }
  const tickers = Object.keys(dailyClose).filter(t => !['SPY', 'QQQ', 'IWM'].includes(t));

  const blRes = await query('SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines');
  const baselines = {};
  for (const r of blRes.rows) baselines[`${r.ticker}:${r.window_key}`] = parseFloat(r.avg_volume);
  console.log(`[TRAJECTORY] ${tickers.length} tickers, ${blRes.rows.length} baselines loaded`);

  // Tracking for summary report
  const summaries = {
    GAP_REVERSAL: [], GAP_UP_REVERSAL: [], CAPITULATION_BOUNCE: [],
    VOL_DROP_PUT: [], SECTOR_ROTATION_BOUNCE: [], CONSEC_BOUNCE: [],
  };

  let cachedBars = {};
  let totalSignals = 0;
  let pendingRows = [];

  for (let dayIdx = 1; dayIdx < allDays.length; dayIdx++) {
    const today = allDays[dayIdx];
    const yesterday = allDays[dayIdx - 1];
    const tomorrow = dayIdx + 1 < allDays.length ? allDays[dayIdx + 1] : null;

    if (dayIdx % 10 === 0) console.log(`[TRAJECTORY] Day ${dayIdx}/${allDays.length}: ${today}  (${totalSignals} signals so far)`);

    if (!cachedBars[today]) cachedBars[today] = await loadDayBars(today);
    const barsByTicker = cachedBars[today];

    let nextDayBarsByTicker = null;
    if (tomorrow) {
      if (!cachedBars[tomorrow]) cachedBars[tomorrow] = await loadDayBars(tomorrow);
      nextDayBarsByTicker = cachedBars[tomorrow];
    }

    for (const d of Object.keys(cachedBars)) {
      if (d !== today && d !== tomorrow) delete cachedBars[d];
    }

    const spyBars = barsByTicker['SPY'] || [];
    const qqqBars = barsByTicker['QQQ'] || [];
    const spyPrevClose = dailyClose['SPY']?.[yesterday] || 0;
    const qqqPrevClose = dailyClose['QQQ']?.[yesterday] || 0;
    const spyLatest = spyBars.length > 0 ? spyBars[spyBars.length - 1].close : 0;
    const qqqLatest = qqqBars.length > 0 ? qqqBars[qqqBars.length - 1].close : 0;
    const spyChange = spyPrevClose > 0 ? (spyLatest - spyPrevClose) / spyPrevClose : 0;
    const qqqChange = qqqPrevClose > 0 ? (qqqLatest - qqqPrevClose) / qqqPrevClose : 0;

    for (const ticker of tickers) {
      const bars = barsByTicker[ticker];
      if (!bars || bars.length < 10) continue;

      const prevClose = dailyClose[ticker]?.[yesterday];
      if (!prevClose) continue;

      const todayOpen = bars[0].open;
      const firstCandle = { open: bars[0].open, high: bars[0].high, low: bars[0].low, close: bars[0].close };
      const nextBars = nextDayBarsByTicker?.[ticker] || null;

      let volBaseline = 0;
      for (let m = 570; m < 690; m += 15) {
        const wk = `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`;
        volBaseline += baselines[`${ticker}:${wk}`] || 0;
      }

      // Detect all strategies and build trajectories
      const signals = [];

      const gapSig = detectGapReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gapSig) signals.push({ sig: gapSig, entryIdx: 0 });

      const gapUpSig = detectGapUpReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gapUpSig) signals.push({ sig: gapUpSig, entryIdx: 0 });

      const midBars = bars.filter(b => b.et_mins >= 630 && b.et_mins <= 870);
      const capSig = detectCapitulationBounce(ticker, midBars, todayOpen, volBaseline);
      if (capSig) {
        const entryIdx = bars.findIndex(b => b.et_mins >= 630) + (capSig.bar_index || 0);
        signals.push({ sig: capSig, entryIdx });
      }

      const vdpSig = detectVolDropPut(ticker, midBars, todayOpen, volBaseline);
      if (vdpSig) {
        const entryIdx = bars.findIndex(b => b.et_mins >= 630) + (vdpSig.bar_index || 0);
        signals.push({ sig: vdpSig, entryIdx });
      }

      const secSig = detectSectorRotation(ticker, todayOpen, prevClose, spyChange, qqqChange);
      if (secSig) signals.push({ sig: secSig, entryIdx: 0 });

      const recentDays = allDays.slice(Math.max(0, dayIdx - 4), dayIdx).filter(d => dailyClose[ticker]?.[d] != null);
      const recentCloses = recentDays.map(d => dailyClose[ticker][d]);
      const consecSig = detectConsecBounce(ticker, recentCloses);
      if (consecSig) signals.push({ sig: consecSig, entryIdx: 0 });

      for (const { sig, entryIdx } of signals) {
        const { trajectory, optimalMinute } = buildTrajectory(sig, entryIdx, bars, nextBars, baselines);

        // Get fixed-time P&Ls and optimal P&L for summary
        const pnlAt = {};
        for (const mins of [30, 60, 120]) {
          const pt = trajectory.find(t => t.minute_offset === mins);
          pnlAt[mins] = pt ? pt.estimated_option_pnl_pct : null;
        }
        const optPt = trajectory.find(t => t.minute_offset === optimalMinute);
        const optPnl = optPt ? optPt.estimated_option_pnl_pct : 0;

        summaries[sig.strategy].push({
          ticker, date: today, optimalMinute,
          optPnl, pnl30: pnlAt[30], pnl60: pnlAt[60], pnl120: pnlAt[120],
        });

        // Queue rows for batch insert
        for (const pt of trajectory) {
          pendingRows.push({
            strategy: sig.strategy, ticker, trade_date: today,
            direction: sig.direction, entry_price: sig.entry_price,
            ...pt, optimal_exit_minute: optimalMinute,
          });
        }
        totalSignals++;

        // Flush every 5000 rows
        if (pendingRows.length >= 5000) {
          await insertTrajectoryBatch(pendingRows);
          pendingRows = [];
        }
      }
    }
  }

  // Flush remaining
  if (pendingRows.length > 0) {
    await insertTrajectoryBatch(pendingRows);
  }

  // Count stored rows
  const countRes = await query('SELECT COUNT(*) as cnt FROM lc_v3.signal_trajectories');
  console.log(`\n[TRAJECTORY] Stored ${countRes.rows[0].cnt} trajectory points for ${totalSignals} signals`);

  // ── Report ─────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(110));
  console.log('  TRAJECTORY ANALYSIS — OPTIMAL EXIT vs FIXED TIME EXITS');
  console.log('  ' + allDays[0] + ' → ' + allDays[allDays.length - 1]);
  console.log('='.repeat(110));

  const bucketLabels = ['<15min', '15-30min', '30-60min', '60-120min', '>120min'];
  function getBucket(mins) {
    if (mins < 15) return 0;
    if (mins < 30) return 1;
    if (mins < 60) return 2;
    if (mins < 120) return 3;
    return 4;
  }

  for (const [strategy, trades] of Object.entries(summaries)) {
    console.log(`\n${'─'.repeat(110)}`);
    console.log(`  ${strategy}  (${trades.length} signals)`);
    console.log(`${'─'.repeat(110)}`);
    if (trades.length === 0) { console.log('  No signals'); continue; }

    // Avg optimal exit minute
    const avgOptMin = trades.reduce((s, t) => s + t.optimalMinute, 0) / trades.length;
    console.log(`  Avg optimal exit minute:  ${avgOptMin.toFixed(1)} min`);

    // Distribution of optimal exits
    const dist = [0, 0, 0, 0, 0];
    for (const t of trades) dist[getBucket(t.optimalMinute)]++;
    console.log(`  Optimal exit distribution:`);
    for (let i = 0; i < 5; i++) {
      const pct = (dist[i] / trades.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(dist[i] / trades.length * 40));
      console.log(`    ${bucketLabels[i].padEnd(12)} ${dist[i].toString().padStart(4)}  (${pct.padStart(5)}%)  ${bar}`);
    }

    // Avg option P&L at optimal vs fixed exits
    const avgOptPnl = trades.reduce((s, t) => s + t.optPnl, 0) / trades.length;
    console.log(`\n  Avg estimated option P&L:`);
    console.log(`    OPTIMAL EXIT:   ${avgOptPnl >= 0 ? '+' : ''}${avgOptPnl.toFixed(2)}%`);

    for (const mins of [30, 60, 120]) {
      const valid = trades.filter(t => t[`pnl${mins}`] != null);
      if (valid.length === 0) { console.log(`    ${mins}min fixed:    n/a`); continue; }
      const avgPnl = valid.reduce((s, t) => s + t[`pnl${mins}`], 0) / valid.length;
      const leftOnTable = avgOptPnl - avgPnl;
      console.log(`    ${(mins + 'min fixed:').padEnd(16)} ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%  (${leftOnTable >= 0 ? '+' : ''}${leftOnTable.toFixed(2)}% left on table)`);
    }

    // Win rate comparison: optimal vs fixed
    console.log(`\n  Win rates (option P&L > 0):`);
    const optWins = trades.filter(t => t.optPnl > 0).length;
    console.log(`    OPTIMAL EXIT:   ${(optWins / trades.length * 100).toFixed(1)}% (${optWins}/${trades.length})`);
    for (const mins of [30, 60, 120]) {
      const valid = trades.filter(t => t[`pnl${mins}`] != null);
      if (valid.length === 0) continue;
      const wins = valid.filter(t => t[`pnl${mins}`] > 0).length;
      console.log(`    ${(mins + 'min fixed:').padEnd(16)} ${(wins / valid.length * 100).toFixed(1)}% (${wins}/${valid.length})`);
    }
  }

  // Grand totals
  const allTrades = Object.values(summaries).flat();
  console.log(`\n${'='.repeat(110)}`);
  console.log(`  ALL STRATEGIES COMBINED  (${allTrades.length} signals)`);
  console.log(`${'='.repeat(110)}`);

  if (allTrades.length > 0) {
    const avgOptMin = allTrades.reduce((s, t) => s + t.optimalMinute, 0) / allTrades.length;
    const avgOptPnl = allTrades.reduce((s, t) => s + t.optPnl, 0) / allTrades.length;
    console.log(`  Avg optimal exit minute:  ${avgOptMin.toFixed(1)} min`);
    console.log(`  Avg optimal option P&L:   ${avgOptPnl >= 0 ? '+' : ''}${avgOptPnl.toFixed(2)}%`);

    const dist = [0, 0, 0, 0, 0];
    for (const t of allTrades) dist[getBucket(t.optimalMinute)]++;
    console.log(`  Optimal exit distribution:`);
    for (let i = 0; i < 5; i++) {
      const pct = (dist[i] / allTrades.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(dist[i] / allTrades.length * 40));
      console.log(`    ${bucketLabels[i].padEnd(12)} ${dist[i].toString().padStart(4)}  (${pct.padStart(5)}%)  ${bar}`);
    }

    console.log(`\n  Value left on table vs fixed exits:`);
    for (const mins of [30, 60, 120]) {
      const valid = allTrades.filter(t => t[`pnl${mins}`] != null);
      if (valid.length === 0) continue;
      const avgPnl = valid.reduce((s, t) => s + t[`pnl${mins}`], 0) / valid.length;
      const leftOnTable = avgOptPnl - avgPnl;
      console.log(`    ${(mins + 'min fixed:').padEnd(16)} ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%  →  ${leftOnTable >= 0 ? '+' : ''}${leftOnTable.toFixed(2)}% left on table`);
    }
  }

  console.log('\n' + '='.repeat(110));
  process.exit(0);
}

main().catch(err => { console.error('[TRAJECTORY] FATAL:', err.message, err.stack); process.exit(1); });
