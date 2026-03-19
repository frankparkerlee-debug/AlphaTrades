/**
 * Thesis-Based Exit Backtest
 *
 * Replays the continuation scorer's thesis checks against all 6 months of
 * stored 1-min bars. For every strategy signal detected, walks forward
 * minute-by-minute applying the exact same thesis rules from
 * continuation-scorer.js and records:
 *   - When thesis first breaks (THESIS_BROKEN exit)
 *   - When hard stop hits (-38% option P&L)
 *   - When VWAP cross below triggers (5+ bars above then close below)
 *   - When RSI bearish divergence triggers (>10pt divergence)
 *   - When theta exceeds gain rate (after 30 min)
 *   - Stock P&L and estimated option P&L at each exit type
 *
 * Compares thesis-based exits against fixed-time exits (30/60/120 min)
 * and the trajectory-optimal exit.
 *
 * Run: node --max-old-space-size=1024 scripts/backtest-thesis-exits.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

// ── DTE + theta model (from trajectory backtest) ─────────────────────────────
const STRATEGY_DTE = {
  GAP_REVERSAL: 1, GAP_UP_REVERSAL: 1, CAPITULATION_BOUNCE: 2,
  VOL_DROP_PUT: 2, SECTOR_ROTATION_BOUNCE: 1, CONSEC_BOUNCE: 5,
};
const THETA_BY_DTE = { 0: -0.18, 1: -0.10, 2: -0.07, 3: -0.055, 4: -0.045, 5: -0.04 };
function thetaPerDay(dte) {
  return THETA_BY_DTE[Math.max(0, Math.min(5, Math.round(dte)))] ?? -0.04;
}
const INITIAL_DELTA = 0.50;
const GAMMA_PER_PCT = 0.02;
const VEGA_MULTIPLIER = 0.0025;

// ── Strategy detection (same as trajectory backtest) ─────────────────────────

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
    if (volBaseline > 0 && cumVol / volBaseline < 1.5) continue;
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
  if (dailyCloses.length >= 4 && (c0 - dailyCloses[n - 4]) / dailyCloses[n - 4] <= -0.03) consecutiveDays = 3;
  return {
    strategy: 'CONSEC_BOUNCE', direction: 'CALL', ticker,
    entry_price: c2, consecutive_days: consecutiveDays, hold: 'MULTIDAY', exit_within_days: 3,
  };
}

// ── Thesis checks (exact copy from continuation-scorer.js) ──────────────────

function checkGapReversalThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;
  const dir = trade.direction === 'CALL' ? 1 : -1;
  const stopPrice = trade.stop_price || 0;
  const lastPrice = recentBars.length > 0 ? recentBars[recentBars.length - 1].close : 0;
  if (stopPrice > 0 && lastPrice < stopPrice && dir === 1) { intact = false; reasons.push('price_below_stop'); }
  if (stopPrice > 0 && lastPrice > stopPrice && dir === -1) { intact = false; reasons.push('price_above_stop'); }
  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    if (!(last3[1].low > last3[0].low && last3[2].low > last3[1].low) && dir === 1) reasons.push('no_higher_lows');
  }
  if (recentBars.length >= 6) {
    const last6 = recentBars.slice(-6);
    let greenVol = 0, redVol = 0;
    for (const b of last6) { if (b.close >= b.open) greenVol += b.volume; else redVol += b.volume; }
    if (dir === 1 && redVol > greenVol) reasons.push('red_volume_dominant');
    if (dir === -1 && greenVol > redVol) reasons.push('green_volume_dominant');
  }
  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry <= 0) reasons.push('spy_turned_negative');
  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkSectorRotationThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;
  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry <= 0) { intact = false; reasons.push('spy_turned_negative'); }
  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    if (!(last3[1].low > last3[0].low && last3[2].low > last3[1].low)) reasons.push('no_higher_lows');
  }
  if (recentBars.length >= 6) {
    const last6 = recentBars.slice(-6);
    let upVol = 0, downVol = 0;
    for (const b of last6) { if (b.close >= b.open) upVol += b.volume; else downVol += b.volume; }
    if (downVol > upVol) reasons.push('down_volume_exceeds_up');
  }
  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkCapitulationThesis(trade, recentBars) {
  const reasons = [];
  let intact = true;
  if (recentBars.length < 3) return { intact: true, reasons: [] };
  const entryPrice = trade.entry_price || 0;
  const sessionLow = Math.min(...recentBars.map(b => b.low));
  const lastPrice = recentBars[recentBars.length - 1].close;
  if (lastPrice <= sessionLow && recentBars.length > 5) { intact = false; reasons.push('at_session_low'); }
  if (sessionLow < entryPrice * 0.99) reasons.push('new_low_below_entry');
  const redBars = recentBars.filter(b => b.close < b.open);
  if (redBars.length >= 3) {
    const rr = redBars.slice(-3);
    if (rr[1].volume > rr[0].volume && rr[2].volume > rr[1].volume) reasons.push('red_volume_increasing');
  }
  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkConsecBounceThesis(trade, recentBars) {
  const reasons = [];
  let intact = true;
  const entryPrice = trade.entry_price || 0;
  const redBars = recentBars.filter(b => b.close < b.open);
  if (redBars.length >= 3) {
    const rr = redBars.slice(-3);
    if (rr[1].volume > rr[0].volume && rr[2].volume > rr[1].volume) reasons.push('red_volume_increasing');
  }
  if (recentBars.length > 0) {
    const sessionLow = Math.min(...recentBars.map(b => b.low));
    if (sessionLow < entryPrice * 0.97) { intact = false; reasons.push('below_entry_low'); }
  }
  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkThesis(strategy, trade, recentBars, marketContext) {
  switch (strategy) {
    case 'GAP_REVERSAL':           return checkGapReversalThesis(trade, recentBars, marketContext);
    case 'GAP_UP_REVERSAL':        return checkGapReversalThesis(trade, recentBars, marketContext);
    case 'SECTOR_ROTATION_BOUNCE': return checkSectorRotationThesis(trade, recentBars, marketContext);
    case 'CAPITULATION_BOUNCE':    return checkCapitulationThesis(trade, recentBars);
    case 'CONSEC_BOUNCE':          return checkConsecBounceThesis(trade, recentBars);
    case 'VOL_DROP_PUT':           return checkCapitulationThesis(trade, recentBars);
    default:                       return { intact: true, reasons: [] };
  }
}

// ── VWAP cross detection (direction-aware) ──────────────────────────────────

function checkVwapCross(allBarsFromSessionStart, currentIdx, direction) {
  if (currentIdx < 6) return { crossed: false };
  let cumVol = 0, cumTpVol = 0;
  const vwaps = [];
  for (let i = 0; i <= currentIdx; i++) {
    const b = allBarsFromSessionStart[i];
    const tp = (b.high + b.low + b.close) / 3;
    cumVol += b.volume;
    cumTpVol += tp * b.volume;
    vwaps.push(cumVol > 0 ? cumTpVol / cumVol : b.close);
  }
  // CALL: favorable = above VWAP. PUT: favorable = below VWAP.
  const isFavorable = (price, vwap) =>
    direction === 'CALL' ? price > vwap : price < vwap;
  let favorableStreak = 0;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (isFavorable(allBarsFromSessionStart[i].close, vwaps[i])) favorableStreak++;
    else break;
  }
  const onUnfavorableSide = !isFavorable(allBarsFromSessionStart[currentIdx].close, vwaps[currentIdx]);
  const crossed = onUnfavorableSide && favorableStreak >= 5;
  return { crossed, favorableStreak };
}

// ── Option P&L estimator (same model as trajectory backtest) ────────────────

function estimateOptionPnl(entryPrice, direction, forwardBars, dte, baselines, ticker) {
  const dir = direction === 'CALL' ? 1 : -1;
  let delta = INITIAL_DELTA, cumulativeTheta = 0, cumulativeIVChange = 0, prevPrice = entryPrice;
  const pnlByMinute = [];
  for (let m = 0; m < forwardBars.length; m++) {
    const bar = forwardBars[m];
    const stockMovePct = (bar.close - entryPrice) / entryPrice;
    const minuteMovePct = (bar.close - prevPrice) / prevPrice;
    const favorableMove = stockMovePct * dir;
    delta = Math.max(0.05, Math.min(0.99, delta + GAMMA_PER_PCT * minuteMovePct * 100 * dir));
    const effectiveDTE = Math.max(0.01, dte - m / 390);
    cumulativeTheta += thetaPerDay(effectiveDTE) / 390;
    const barMins = bar.et_mins || 570;
    const wk = `${Math.floor(barMins / 60).toString().padStart(2, '0')}:${(Math.floor((barMins % 60) / 15) * 15).toString().padStart(2, '0')}`;
    const minuteBaseline = (baselines[`${ticker}:${wk}`] || 0) / 15;
    const volRatio = minuteBaseline > 0 ? bar.volume / minuteBaseline : 1.0;
    if (volRatio > 3.0) cumulativeIVChange += 5.0;
    else if (volRatio < 0.5) cumulativeIVChange -= 3.0;
    const avgDelta = (INITIAL_DELTA + delta) / 2;
    const deltaGain = avgDelta * favorableMove * 100;
    const gammaGain = 0.5 * GAMMA_PER_PCT * (favorableMove * 100) ** 2 / 100;
    const vegaGain = VEGA_MULTIPLIER * cumulativeIVChange;
    const thetaDecay = cumulativeTheta * 100;
    pnlByMinute.push(deltaGain + gammaGain + vegaGain + thetaDecay);
    prevPrice = bar.close;
  }
  return pnlByMinute;
}

// ── Load bars ────────────────────────────────────────────────────────────────

async function loadDayBars(day) {
  const res = await query(`
    SELECT ticker, open, high, low, close, volume,
           EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')::int * 60 +
           EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')::int as et_mins
    FROM lc_v3.bars WHERE session = 'REGULAR'
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[THESIS-EXIT] Starting thesis-based exit backtest...\n');

  // Load metadata
  const daysRes = await query(`
    SELECT DISTINCT DATE(ts AT TIME ZONE 'America/New_York') as day
    FROM lc_v3.bars WHERE session = 'REGULAR' ORDER BY day
  `);
  const allDays = daysRes.rows.map(r => r.day.toISOString().split('T')[0]);
  console.log(`[THESIS-EXIT] ${allDays.length} trading days: ${allDays[0]} to ${allDays[allDays.length - 1]}`);

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
  console.log(`[THESIS-EXIT] ${tickers.length} tickers, ${blRes.rows.length} baselines`);

  // Results tracking
  const results = {};
  for (const s of ['GAP_REVERSAL', 'GAP_UP_REVERSAL', 'CAPITULATION_BOUNCE', 'VOL_DROP_PUT', 'SECTOR_ROTATION_BOUNCE', 'CONSEC_BOUNCE']) {
    results[s] = [];
  }

  let cachedBars = {};
  let totalSignals = 0;

  for (let dayIdx = 1; dayIdx < allDays.length; dayIdx++) {
    const today = allDays[dayIdx];
    const yesterday = allDays[dayIdx - 1];
    const tomorrow = dayIdx + 1 < allDays.length ? allDays[dayIdx + 1] : null;

    if (dayIdx % 10 === 0) console.log(`[THESIS-EXIT] Day ${dayIdx}/${allDays.length}: ${today}  (${totalSignals} signals)`);

    if (!cachedBars[today]) cachedBars[today] = await loadDayBars(today);
    const barsByTicker = cachedBars[today];

    let nextDayBars = null;
    if (tomorrow) {
      if (!cachedBars[tomorrow]) cachedBars[tomorrow] = await loadDayBars(tomorrow);
      nextDayBars = cachedBars[tomorrow];
    }

    // GC old days
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
      const nextBarsForTicker = nextDayBars?.[ticker] || null;

      let volBaseline = 0;
      for (let m = 570; m < 690; m += 15) {
        const wk = `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`;
        volBaseline += baselines[`${ticker}:${wk}`] || 0;
      }

      // Detect signals
      const detected = [];
      const gs = detectGapReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gs) detected.push({ sig: gs, entryIdx: 0 });
      const gus = detectGapUpReversal(ticker, todayOpen, prevClose, firstCandle);
      if (gus) detected.push({ sig: gus, entryIdx: 0 });
      const midBars = bars.filter(b => b.et_mins >= 630 && b.et_mins <= 870);
      const cs = detectCapitulationBounce(ticker, midBars, todayOpen, volBaseline);
      if (cs) detected.push({ sig: cs, entryIdx: bars.findIndex(b => b.et_mins >= 630) + (cs.bar_index || 0) });
      const vs = detectVolDropPut(ticker, midBars, todayOpen, volBaseline);
      if (vs) detected.push({ sig: vs, entryIdx: bars.findIndex(b => b.et_mins >= 630) + (vs.bar_index || 0) });
      const ss = detectSectorRotation(ticker, todayOpen, prevClose, spyChange, qqqChange);
      if (ss) detected.push({ sig: ss, entryIdx: 0 });
      const recentDays = allDays.slice(Math.max(0, dayIdx - 4), dayIdx).filter(d => dailyClose[ticker]?.[d] != null);
      const recentCloses = recentDays.map(d => dailyClose[ticker][d]);
      const cbs = detectConsecBounce(ticker, recentCloses);
      if (cbs) detected.push({ sig: cbs, entryIdx: 0 });

      for (const { sig, entryIdx } of detected) {
        // Build forward bars
        const forwardBars = [];
        for (let i = entryIdx; i < bars.length; i++) forwardBars.push(bars[i]);
        if (nextBarsForTicker) for (const b of nextBarsForTicker) forwardBars.push(b);

        if (forwardBars.length < 5) continue;

        const dte = STRATEGY_DTE[sig.strategy] || 2;
        const optionPnls = estimateOptionPnl(sig.entry_price, sig.direction, forwardBars, dte, baselines, ticker);

        // SPY bars aligned forward from entry
        const spyForward = [];
        const spyEntryIdx = spyBars.findIndex(b => b.et_mins >= (bars[entryIdx]?.et_mins || 570));
        if (spyEntryIdx >= 0) {
          for (let i = spyEntryIdx; i < spyBars.length; i++) spyForward.push(spyBars[i]);
          if (nextDayBars?.['SPY']) for (const b of nextDayBars['SPY']) spyForward.push(b);
        }
        const spyEntryPrice = spyForward.length > 0 ? spyForward[0].close : spyPrevClose;

        // Walk forward applying 3 rules every minute
        let thesisExitMin = null, thesisExitReason = null;
        let stopExitMin = null;
        let vwapExitMin = null;
        const INTRADAY = ['GAP_REVERSAL', 'GAP_UP_REVERSAL', 'SECTOR_ROTATION_BOUNCE', 'CAPITULATION_BOUNCE'];
        const isIntraday = INTRADAY.includes(sig.strategy);

        const maxMins = Math.min(forwardBars.length, sig.exit_by_mins ? sig.exit_by_mins + 10 : sig.hold === 'OVERNIGHT' ? forwardBars.length : sig.hold === 'MULTIDAY' ? Math.min(forwardBars.length, 780) : 240);

        for (let m = 3; m < maxMins; m++) { // start at 3 to have enough bars for thesis checks
          const recentWindow = forwardBars.slice(Math.max(0, m - 29), m + 1);
          const currentOptPnl = optionPnls[m] || 0;

          // SPY context
          const spyNow = spyForward[m]?.close || spyEntryPrice;
          const spyChangeSinceEntry = spyEntryPrice > 0 ? (spyNow - spyEntryPrice) / spyEntryPrice : 0;
          const mktCtx = { spyChangeSinceEntry };

          // Build trade-like object for thesis checker
          const tradeLike = {
            direction: sig.direction,
            entry_stock_price: sig.entry_price,
            entry_stop: sig.stop_price || 0,
            stop_price: sig.stop_price || 0,
            entry_price: sig.entry_price,
          };

          // Rule 1: Thesis check
          if (thesisExitMin === null) {
            const thesis = checkThesis(sig.strategy, tradeLike, recentWindow, mktCtx);
            if (!thesis.intact) {
              thesisExitMin = m;
              thesisExitReason = thesis.reasons.join(',');
            }
          }

          // Rule 2: Hard stop at -38% option P&L
          if (stopExitMin === null && currentOptPnl < -38) {
            stopExitMin = m;
          }

          // Rule 3: VWAP cross (intraday strategies only, direction-aware)
          if (vwapExitMin === null && m >= 6 && isIntraday) {
            const sessionBarIdx = entryIdx + m;
            if (sessionBarIdx < bars.length) {
              const vwapCheck = checkVwapCross(bars, sessionBarIdx, sig.direction);
              if (vwapCheck.crossed) vwapExitMin = m;
            }
          }
        }

        // Determine the first thesis-based exit (earliest of all rules)
        let thesisCombinedMin = null;
        let thesisCombinedRule = null;
        const candidates = [];
        if (stopExitMin != null) candidates.push({ min: stopExitMin, rule: 'STOP_HIT' });
        if (vwapExitMin != null) candidates.push({ min: vwapExitMin, rule: 'VWAP_CROSS' });
        if (thesisExitMin != null) candidates.push({ min: thesisExitMin, rule: 'THESIS_BROKEN' });
        candidates.sort((a, b) => a.min - b.min);
        if (candidates.length > 0) {
          thesisCombinedMin = candidates[0].min;
          thesisCombinedRule = candidates[0].rule;
        }

        // Collect P&L at various exit points
        const stockPnlAt = (m) => {
          if (m == null || m >= forwardBars.length) return null;
          const dir = sig.direction === 'CALL' ? 1 : -1;
          return (forwardBars[m].close - sig.entry_price) / sig.entry_price * dir * 100;
        };
        const optPnlAt = (m) => m != null && m < optionPnls.length ? optionPnls[m] : null;

        // Optimal exit (peak option P&L)
        let optimalMin = 0, optimalPnl = -Infinity;
        for (let m = 0; m < Math.min(optionPnls.length, maxMins); m++) {
          if (optionPnls[m] > optimalPnl) { optimalPnl = optionPnls[m]; optimalMin = m; }
        }

        results[sig.strategy].push({
          ticker, date: today,
          thesisExitMin: thesisCombinedMin,
          thesisExitRule: thesisCombinedRule,
          thesisExitReasons: thesisExitReason,
          thesisStockPnl: stockPnlAt(thesisCombinedMin),
          thesisOptPnl: optPnlAt(thesisCombinedMin),
          fixedPnl30: optPnlAt(30),
          fixedPnl60: optPnlAt(60),
          fixedPnl120: optPnlAt(120),
          fixedStockPnl30: stockPnlAt(30),
          fixedStockPnl60: stockPnlAt(60),
          fixedStockPnl120: stockPnlAt(120),
          optimalMin, optimalPnl: optimalPnl === -Infinity ? 0 : optimalPnl,
          // Individual rule exit minutes
          thesisBrokenMin: thesisExitMin,
          stopHitMin: stopExitMin,
          vwapCrossMin: vwapExitMin,
          // End-of-window P&L (what happens if you just hold)
          endPnl: optPnlAt(maxMins - 1),
        });
        totalSignals++;
      }
    }
  }

  // ── REPORT ──────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(120));
  console.log('  THESIS-BASED EXIT BACKTEST');
  console.log('  ' + allDays[0] + ' to ' + allDays[allDays.length - 1] + ` (${allDays.length} days, ${totalSignals} signals)`);
  console.log('='.repeat(120));

  for (const [strategy, trades] of Object.entries(results)) {
    console.log(`\n${'─'.repeat(120)}`);
    console.log(`  ${strategy}  (${trades.length} signals)`);
    console.log(`${'─'.repeat(120)}`);
    if (trades.length === 0) { console.log('  No signals detected'); continue; }

    // Thesis exit stats
    const withThesisExit = trades.filter(t => t.thesisExitMin != null);
    const noThesisExit = trades.filter(t => t.thesisExitMin == null);
    console.log(`\n  Thesis exit fired: ${withThesisExit.length}/${trades.length} (${(withThesisExit.length / trades.length * 100).toFixed(1)}%)`);
    console.log(`  No thesis exit (held to window): ${noThesisExit.length}`);

    if (withThesisExit.length > 0) {
      const avgThesisMin = withThesisExit.reduce((s, t) => s + t.thesisExitMin, 0) / withThesisExit.length;
      console.log(`  Avg thesis exit minute: ${avgThesisMin.toFixed(1)}`);

      // Breakdown by rule
      const byRule = {};
      for (const t of withThesisExit) {
        byRule[t.thesisExitRule] = (byRule[t.thesisExitRule] || 0) + 1;
      }
      console.log(`  Exit rule breakdown:`);
      for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${rule.padEnd(25)} ${count.toString().padStart(4)} (${(count / withThesisExit.length * 100).toFixed(1)}%)`);
      }
    }

    // P&L comparison table
    console.log(`\n  ${'Exit Method'.padEnd(25)} ${'Avg Opt P&L'.padStart(12)} ${'Win Rate'.padStart(10)} ${'Avg Stock'.padStart(12)} ${'Signals'.padStart(9)}`);
    console.log(`  ${'─'.repeat(70)}`);

    const reportRow = (label, trades, pnlKey, stockKey) => {
      const valid = trades.filter(t => t[pnlKey] != null);
      if (valid.length === 0) { console.log(`  ${label.padEnd(25)} ${'n/a'.padStart(12)}`); return; }
      const avgPnl = valid.reduce((s, t) => s + t[pnlKey], 0) / valid.length;
      const wins = valid.filter(t => t[pnlKey] > 0).length;
      const wr = (wins / valid.length * 100).toFixed(1);
      const avgStock = stockKey ? valid.filter(t => t[stockKey] != null).reduce((s, t) => s + (t[stockKey] || 0), 0) / valid.length : 0;
      console.log(`  ${label.padEnd(25)} ${(avgPnl >= 0 ? '+' : '') + avgPnl.toFixed(2) + '%'}${' '.repeat(Math.max(0, 10 - ((avgPnl >= 0 ? '+' : '') + avgPnl.toFixed(2) + '%').length))} ${(wr + '%').padStart(10)} ${stockKey ? (avgStock >= 0 ? '+' : '') + avgStock.toFixed(2) + '%' : ''}${' '.repeat(Math.max(0, 10))} ${valid.length.toString().padStart(5)}`);
    };

    reportRow('THESIS EXIT', withThesisExit, 'thesisOptPnl', 'thesisStockPnl');
    reportRow('30min fixed', trades, 'fixedPnl30', 'fixedStockPnl30');
    reportRow('60min fixed', trades, 'fixedPnl60', 'fixedStockPnl60');
    reportRow('120min fixed', trades, 'fixedPnl120', 'fixedStockPnl120');
    reportRow('OPTIMAL (peak)', trades, 'optimalPnl', null);
    reportRow('HOLD to window end', trades, 'endPnl', null);

    // Thesis exit vs optimal: how much value captured
    if (withThesisExit.length > 0) {
      const avgThesisPnl = withThesisExit.reduce((s, t) => s + (t.thesisOptPnl || 0), 0) / withThesisExit.length;
      const avgOptimalPnl = withThesisExit.reduce((s, t) => s + t.optimalPnl, 0) / withThesisExit.length;
      const captured = avgOptimalPnl !== 0 ? (avgThesisPnl / avgOptimalPnl * 100) : 0;
      console.log(`\n  Value captured by thesis exit: ${captured.toFixed(1)}% of optimal`);
    }

    // Thesis exit saved you from losses?
    const savedByThesis = withThesisExit.filter(t => (t.endPnl || 0) < (t.thesisOptPnl || 0));
    console.log(`  Thesis exit outperformed hold: ${savedByThesis.length}/${withThesisExit.length} (${withThesisExit.length > 0 ? (savedByThesis.length / withThesisExit.length * 100).toFixed(1) : 0}%)`);

    // Most common thesis breakdown reasons
    const reasonCounts = {};
    for (const t of withThesisExit) {
      if (t.thesisExitReasons) {
        for (const r of t.thesisExitReasons.split(',')) {
          reasonCounts[r] = (reasonCounts[r] || 0) + 1;
        }
      }
    }
    if (Object.keys(reasonCounts).length > 0) {
      console.log(`\n  Top thesis breakdown reasons:`);
      const sorted = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [reason, count] of sorted) {
        console.log(`    ${reason.padEnd(30)} ${count}`);
      }
    }
  }

  // ── GRAND TOTALS ────────────────────────────────────────────────────────────

  const allTrades = Object.values(results).flat();
  console.log(`\n${'='.repeat(120)}`);
  console.log(`  ALL STRATEGIES COMBINED  (${allTrades.length} signals)`);
  console.log(`${'='.repeat(120)}`);

  if (allTrades.length > 0) {
    const wt = allTrades.filter(t => t.thesisExitMin != null);
    console.log(`  Thesis exit fired: ${wt.length}/${allTrades.length} (${(wt.length / allTrades.length * 100).toFixed(1)}%)`);

    if (wt.length > 0) {
      const avgThesisMin = wt.reduce((s, t) => s + t.thesisExitMin, 0) / wt.length;
      const avgThesisPnl = wt.reduce((s, t) => s + (t.thesisOptPnl || 0), 0) / wt.length;
      const thesisWins = wt.filter(t => (t.thesisOptPnl || 0) > 0).length;
      console.log(`  Avg thesis exit minute: ${avgThesisMin.toFixed(1)}`);
      console.log(`  Avg thesis option P&L: ${avgThesisPnl >= 0 ? '+' : ''}${avgThesisPnl.toFixed(2)}%`);
      console.log(`  Thesis exit win rate: ${(thesisWins / wt.length * 100).toFixed(1)}%`);

      // By rule
      const byRule = {};
      for (const t of wt) byRule[t.thesisExitRule] = (byRule[t.thesisExitRule] || 0) + 1;
      console.log(`  Exit rule breakdown:`);
      for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${rule.padEnd(25)} ${count.toString().padStart(5)} (${(count / wt.length * 100).toFixed(1)}%)`);
      }
    }

    console.log(`\n  ${'Exit Method'.padEnd(25)} ${'Avg Opt P&L'.padStart(12)} ${'Win Rate'.padStart(10)} ${'Signals'.padStart(9)}`);
    console.log(`  ${'─'.repeat(60)}`);
    const rr = (label, key) => {
      const valid = allTrades.filter(t => t[key] != null);
      if (valid.length === 0) return;
      const avg = valid.reduce((s, t) => s + t[key], 0) / valid.length;
      const wins = valid.filter(t => t[key] > 0).length;
      console.log(`  ${label.padEnd(25)} ${(avg >= 0 ? '+' : '') + avg.toFixed(2) + '%'}${' '.repeat(Math.max(0, 10 - ((avg >= 0 ? '+' : '') + avg.toFixed(2) + '%').length))} ${(wins / valid.length * 100).toFixed(1).padStart(7)}%  ${valid.length.toString().padStart(7)}`);
    };
    rr('THESIS EXIT', 'thesisOptPnl');
    rr('30min fixed', 'fixedPnl30');
    rr('60min fixed', 'fixedPnl60');
    rr('120min fixed', 'fixedPnl120');
    rr('OPTIMAL (peak)', 'optimalPnl');
    rr('HOLD to window end', 'endPnl');

    const saved = allTrades.filter(t => t.thesisExitMin != null && (t.endPnl || 0) < (t.thesisOptPnl || 0));
    console.log(`\n  Thesis exit outperformed hold: ${saved.length}/${wt.length} trades`);
  }

  console.log('\n' + '='.repeat(120));
  process.exit(0);
}

main().catch(err => { console.error('[THESIS-EXIT] FATAL:', err.message, err.stack); process.exit(1); });
