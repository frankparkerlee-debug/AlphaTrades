import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import cron from 'node-cron';
import { createServer } from 'http';
import { selectOptionsContract } from './src/options/contract-selector.js';
import { getNewsEvents } from './src/data/state.js';
import { computeNewsScore } from './src/scoring/news.js';
import { runBacktest } from './scripts/backtest/run.js';
import { scanGapReversal } from './src/strategies/gap-reversal.js';
import { scanCapitulationBounce } from './src/strategies/capitulation-bounce.js';
import { scanVolumeDropPut } from './src/strategies/volume-drop-put.js';
import { scanConsecutiveDrop } from './src/strategies/consecutive-drop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── API ROUTES ────────────────────────────────────────────────────────────────

// Signals — today's signals from lc_v3
app.get('/api/signals', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        s.signal_id, s.ticker, s.direction, s.grade, s.status,
        s.composite_raw, s.signal_tier,
        s.score_price_action, s.score_volume, s.score_news,
        s.score_market, s.score_timing,
        s.position_size_pct, s.position_size_dollars,
        s.confluence_score, s.news_headline,
        s.leader_ticker, s.propagation_lag_min,
        s.spy_change_pct, s.qqq_change_pct, s.sector_change_pct,
        s.relative_volume, s.atr_multiple,
        s.human_taken, s.human_pnl_pct, s.human_entry_price, s.human_exit_price, s.human_notes,
        s.contract_symbol, s.contract_strike, s.contract_expiry, s.contract_expiry_label,
        s.contract_bid, s.contract_ask, s.contract_mid,
        s.contract_entry_lo, s.contract_entry_hi,
        s.contract_delta, s.contract_iv,
        s.contract_t1, s.contract_t2, s.contract_t3, s.contract_stop,
        s.contract_estimated,
        s.first_seen_at, s.last_confirmed_at, s.confirmation_count,
        s.peak_composite, s.peak_grade, s.composite_history, s.momentum_trend,
        s.expires_at, s.created_at,
        ti.earnings_date, ti.earnings_days_away, ti.earnings_avg_move_pct,
        ti.earnings_beat_rate, ti.iv_rank_30d, ti.iv_percentile,
        ti.analyst_price_target, ti.beta_30d
      FROM lc_v3.signals s
      LEFT JOIN lc_v3.ticker_intelligence ti ON s.ticker = ti.ticker
      WHERE DATE(s.created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
      ORDER BY s.created_at DESC
      LIMIT 200
    `);
    const signals = result.rows.map(s => ({
      ...s,
      signal_id:         s.signal_id?.toString(),
      created_at:        s.created_at?.toISOString(),
      expires_at:        s.expires_at?.toISOString(),
      composite_raw:     Number(s.composite_raw)     || 0,
      relative_volume:   Number(s.relative_volume)   || null,
      atr_multiple:      Number(s.atr_multiple)       || null,
      spy_change_pct:    Number(s.spy_change_pct)     || null,
      qqq_change_pct:    Number(s.qqq_change_pct)     || null,
      sector_change_pct: Number(s.sector_change_pct)  || null,
      position_size_pct: Number(s.position_size_pct)  || 0,
      position_size_dollars: Number(s.position_size_dollars) || 0,
      score_price_action: Number(s.score_price_action) || 0,
      score_volume:      Number(s.score_volume)        || 0,
      score_news:        Number(s.score_news)          || 0,
      score_market:      Number(s.score_market)        || 0,
      score_timing:      Number(s.score_timing)        || 0,
      confluence_score:  Number(s.confluence_score)    || 0,
      contract_strike:   Number(s.contract_strike)     || null,
      contract_mid:      Number(s.contract_mid)        || null,
      contract_bid:      Number(s.contract_bid)        || null,
      contract_ask:      Number(s.contract_ask)        || null,
      contract_entry_lo: Number(s.contract_entry_lo)   || null,
      contract_entry_hi: Number(s.contract_entry_hi)   || null,
      contract_delta:    Number(s.contract_delta)      || null,
      contract_iv:       Number(s.contract_iv)         || null,
      contract_t1:       Number(s.contract_t1)         || null,
      contract_t2:       Number(s.contract_t2)         || null,
      contract_t3:       Number(s.contract_t3)         || null,
      contract_stop:     Number(s.contract_stop)       || null,
      human_entry_price: Number(s.human_entry_price)   || null,
      human_exit_price:  Number(s.human_exit_price)    || null,
      first_seen_at:     s.first_seen_at?.toISOString()  || null,
      last_confirmed_at: s.last_confirmed_at?.toISOString() || null,
      confirmation_count: Number(s.confirmation_count) || 1,
      peak_composite:    Number(s.peak_composite)      || null,
      peak_grade:        s.peak_grade                  || null,
      composite_history: s.composite_history            || [],
      momentum_trend:    s.momentum_trend              || null,
      // Intelligence overlay
      earnings_date:     s.earnings_date               || null,
      earnings_days_away: s.earnings_days_away != null ? Number(s.earnings_days_away) : null,
      earnings_avg_move_pct: s.earnings_avg_move_pct != null ? Number(s.earnings_avg_move_pct) : null,
      earnings_beat_rate: s.earnings_beat_rate != null ? Number(s.earnings_beat_rate) : null,
      iv_rank:           s.iv_rank_30d != null ? Number(s.iv_rank_30d) : null,
      iv_percentile:     s.iv_percentile != null ? Number(s.iv_percentile) : null,
      analyst_price_target: s.analyst_price_target != null ? Number(s.analyst_price_target) : null,
      beta:              s.beta_30d != null ? Number(s.beta_30d) : null,
    }));
    res.json({ signals, count: signals.length });
  } catch (err) {
    console.error('Signals error:', err.message);
    res.json({ signals: [], error: err.message });
  }
});

// Status — session + propagation windows
app.get('/api/status', async (req, res) => {
  try {
    const windows = await db.query(`
      SELECT event_id, leader_ticker, leader_grade,
             leader_direction, followers_alerted, window_close_at
      FROM lc_v3.propagation_events
      WHERE status = 'OPEN' AND window_close_at > NOW()
    `);

    const now = new Date();
    const prop = windows.rows.map(w => ({
      eventId:          w.event_id?.toString(),
      leaderTicker:     w.leader_ticker,
      leaderGrade:      w.leader_grade,
      leaderDirection:  w.leader_direction,
      followersAlerted: w.followers_alerted || [],
      minutesRemaining: Math.max(0, Math.round((new Date(w.window_close_at) - now) / 60000)),
    }));

    // Market session
    const etNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day      = etNow.getDay();
    const mins     = etNow.getHours() * 60 + etNow.getMinutes();
    let session    = 'OVERNIGHT';
    if (day === 0 || day === 6)           session = 'WEEKEND';
    else if (mins >= 240  && mins < 570)  session = 'PRE_MARKET';
    else if (mins >= 570  && mins < 960)  session = 'REGULAR';
    else if (mins >= 960  && mins < 1200) session = 'POST_MARKET';

    // Stream status from worker (shared via global)
    const streams = global.streamStatus || { bars: 'unknown', news: 'unknown' };
    const regime  = global.currentRegime || { regime: 'NEUTRAL', regimeNote: '', sizeMult: 1.0 };

    const mktCtx = global.marketContext || {};
    res.json({ session, propagation: prop, streams, regime: regime.regime, regimeNote: regime.regimeNote, market: mktCtx, time: now.toISOString() });
  } catch (err) {
    res.json({ session: 'UNKNOWN', propagation: [], streams: {}, error: err.message });
  }
});

// Pre-market briefing
app.get('/api/premarket', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT date, flagged_tickers, macro_events, market_bias, notes
      FROM lc_v3.premarket_briefing
      WHERE date = CURRENT_DATE
    `);
    const briefing = result.rows[0] || null;
    if (briefing?.date) briefing.date = briefing.date.toISOString();
    res.json({ briefing });
  } catch (err) {
    res.json({ briefing: null, error: err.message });
  }
});

// Record outcome
app.post('/api/outcome', async (req, res) => {
  try {
    const { signal_id, taken, entry_price, exit_price } = req.body;
    const pnl = entry_price && exit_price
      ? (exit_price - entry_price) / entry_price
      : null;
    await db.query(`
      UPDATE lc_v3.signals SET
        human_taken = $1,
        human_entry_price = $2,
        human_exit_price = $3,
        human_pnl_pct = $4,
        status = CASE WHEN $1 THEN 'TAKEN' ELSE 'SKIPPED' END
      WHERE signal_id = $5
    `, [taken, entry_price || null, exit_price || null, pnl, signal_id]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Edit a previously recorded trade
app.post('/api/edit', async (req, res) => {
  try {
    const { signal_id, entry_price, exit_price, notes } = req.body;
    const pnl = entry_price && exit_price
      ? (exit_price - entry_price) / entry_price
      : null;
    await db.query(`
      UPDATE lc_v3.signals SET
        human_entry_price = $1,
        human_exit_price  = $2,
        human_pnl_pct     = $3,
        human_notes       = $4
      WHERE signal_id = $5
    `, [entry_price || null, exit_price || null, pnl, notes || null, signal_id]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Debug endpoint — test contract selector on live Render
// Snapshot scan — intraday movers
app.get('/api/snapshots', async (req, res) => {
  try {
    const alpacaHdrs = {
      'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    };
    const dataUrl = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
    const profileRes = await db.query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
    const tickers = profileRes.rows.map(r => r.ticker);
    const snapRes = await axios.get(`${dataUrl}/v2/stocks/snapshots`, {
      headers: alpacaHdrs, params: { symbols: tickers.join(','), feed: ALPACA_FEED }, timeout: 10000,
    });
    const snaps = snapRes.data || {};

    // Volume baselines
    const blRes = await db.query('SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines');
    const baselines = {};
    for (const row of blRes.rows) baselines[`${row.ticker}:${row.window_key}`] = parseFloat(row.avg_volume);

    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const mins = et.getHours() * 60 + et.getMinutes();
    const wH = Math.floor(mins / 15) * 15;
    const wKey = `${Math.floor(wH / 60).toString().padStart(2, '0')}:${(wH % 60).toString().padStart(2, '0')}`;

    const results = [];
    for (const [ticker, snap] of Object.entries(snaps)) {
      const open = snap.dailyBar?.o || 0;
      const price = snap.latestTrade?.p || 0;
      const vol = snap.dailyBar?.v || 0;
      const prevClose = snap.prevDailyBar?.c || 0;
      if (!open || !price) continue;
      const changePct = (price - open) / open;
      const gapPct = prevClose ? (open - prevClose) / prevClose : 0;
      const baseline = baselines[`${ticker}:${wKey}`] || 0;
      const volRatio = baseline > 0 ? vol / baseline : null;
      results.push({ ticker, price, open, prevClose, changePct, gapPct, vol, baseline, volRatio });
    }
    results.sort((a, b) => a.changePct - b.changePct);
    res.json({ count: results.length, windowKey: wKey, results });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/debug/contract/:ticker/:direction', async (req, res) => {
  try {
    const { ticker, direction } = req.params;
    const alpacaHdrs = {
      'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    };
    const dataUrl = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

    // 1) Stock snapshot
    let stockSnap = null;
    try {
      const r = await axios.get(`${dataUrl}/v2/stocks/snapshots`, {
        headers: alpacaHdrs, params: { symbols: ticker, feed: ALPACA_FEED }, timeout: 8000,
      });
      stockSnap = r.data?.[ticker] || null;
    } catch (e) { stockSnap = { error: e.response?.status + ' ' + e.message }; }

    const price = stockSnap?.latestTrade?.p || 100;

    // 2) Options snapshots
    let optSnap = null;
    try {
      const type = direction === 'CALL' ? 'call' : 'put';
      const r = await axios.get(`${dataUrl}/v1beta1/options/snapshots/${ticker}`, {
        headers: alpacaHdrs, params: { type, limit: 20 }, timeout: 10000,
      });
      optSnap = { count: Object.keys(r.data?.snapshots || {}).length, sample: Object.keys(r.data?.snapshots || {}).slice(0, 5) };
    } catch (e) { optSnap = { error: e.response?.status + ' ' + e.message }; }

    // 3) Full selector
    let contract = null;
    try {
      contract = await selectOptionsContract(ticker, direction, 'A', price, 0.025);
    } catch (e) { contract = { error: e.message }; }

    res.json({ ticker, direction, price, stockSnap: !!stockSnap, optSnap, contract });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Debug: see why signals aren't firing for a ticker
app.get('/api/debug/scoring/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const alpacaHdrs = {
      'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    };
    const dataUrl = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
    const { analyzeMomentum, shouldSkipOnFreshness } = await import('./src/scoring/momentum.js');
    const { analyzeLevels, analyzeTrend, gateSignal, classifyRegime } = await import('./src/scoring/intelligence.js');

    const snapRes = await axios.get(`${dataUrl}/v2/stocks/snapshots`, {
      headers: alpacaHdrs, params: { symbols: `${ticker},SPY,QQQ`, feed: ALPACA_FEED }, timeout: 10000,
    });
    const snap = snapRes.data?.[ticker];
    if (!snap) return res.json({ error: 'No snapshot for ticker' });

    const price = snap.latestTrade?.p || 0;
    const prevClose = snap.prevDailyBar?.c || 0;
    const openPrice = snap.dailyBar?.o || price;
    const profileRes = await db.query('SELECT atr_20d FROM lc_v3.equity_profiles WHERE ticker = $1', [ticker]);
    const atr = parseFloat(profileRes.rows[0]?.atr_20d || 0.025);

    // Session move (same logic as poller)
    const sessionMove = openPrice > 0 ? (price - openPrice) / openPrice : 0;
    const direction = sessionMove >= 0 ? 'CALL' : 'PUT';
    const moveInATRs = atr > 0 ? Math.abs(sessionMove) / atr : 0;
    const passesMinMove = moveInATRs >= 0.1;

    const latestBar = snap.minuteBar;
    const prevBar = snap.prevMinuteBar;
    const absRecent = (latestBar && prevBar && prevBar.c > 0)
      ? Math.abs((latestBar.c - prevBar.c) / prevBar.c) : 0;

    const syntheticBars = [prevBar, latestBar].filter(Boolean).map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }));

    // PA score (fallback logic matching poller)
    let paScore, freshness;
    if (syntheticBars.length >= 5) {
      const momentum = analyzeMomentum(syntheticBars, openPrice, prevClose, atr, direction);
      paScore = momentum.momentumScore;
      freshness = momentum.freshness;
    } else {
      freshness = moveInATRs < 0.5 ? 'FRESH'
                : moveInATRs < 1.0 ? 'DEVELOPING'
                : moveInATRs < 1.5 ? 'EXTENDED'
                : moveInATRs < 2.0 ? 'LATE'
                : 'EXHAUSTED';
      const freshnessPenalty = moveInATRs > 1.5 ? 0.5 : moveInATRs > 1.0 ? 0.75 : 1.0;
      paScore = Math.min(35, Math.round(moveInATRs * 35 * freshnessPenalty));
    }

    const mkt = snapRes.data;
    const spyPct = mkt.SPY ? ((mkt.SPY.latestTrade?.p||0)-(mkt.SPY.prevDailyBar?.c||0))/(mkt.SPY.prevDailyBar?.c||1) : 0;
    const qqqPct = mkt.QQQ ? ((mkt.QQQ.latestTrade?.p||0)-(mkt.QQQ.prevDailyBar?.c||0))/(mkt.QQQ.prevDailyBar?.c||1) : 0;
    const regime = classifyRegime({ spyPct, qqqPct }, 18, []);

    const mockState = { close: price, vwap: latestBar?.vw || price, sessionHigh: snap.dailyBar?.h || price, sessionLow: snap.dailyBar?.l || price, prevDayHigh: snap.prevDailyBar?.h || prevClose * 1.01, prevDayLow: snap.prevDailyBar?.l || prevClose * 0.99, sessionOpen: openPrice, bars: syntheticBars };
    const levels = analyzeLevels(mockState, atr);
    const trend = analyzeTrend(syntheticBars, direction);
    const gate = gateSignal(direction, trend, levels, regime, freshness);

    // Volume: daily pace vs yesterday
    const todayVol = snap.dailyBar?.v || 0;
    const prevDayVol = snap.prevDailyBar?.v || 1;
    const debugMinsOpen = Math.max(1, (() => {
      const et = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
      return Math.max(1, (et.getHours() * 60 + et.getMinutes()) - 570);
    })());
    const debugFraction = Math.min(1, debugMinsOpen / 390);
    const debugProjected = debugFraction > 0 ? todayVol / debugFraction : todayVol;
    const debugRelVol = prevDayVol > 0 ? debugProjected / prevDayVol : 1;
    const volScore = Math.min(30, Math.round(debugRelVol * 12));

    res.json({
      ticker, price, prevClose, openPrice, direction,
      sessionMove: parseFloat((sessionMove * 100).toFixed(3)),
      moveInATRs: parseFloat(moveInATRs.toFixed(3)),
      passesMinMove,
      syntheticBarsCount: syntheticBars.length,
      freshness, paScore, volScore,
      passesPA: paScore >= 15, passesVOL: volScore >= 12,
      gate, regime: regime.regime,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── BACKTEST ROUTES ──────────────────────────────────────────────────────────

// Serve backtest dashboard
app.get('/backtest', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'backtest.html'));
});

// Get latest backtest results
app.get('/api/backtest', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT results, run_date, created_at FROM lc_v3.backtest_results ORDER BY created_at DESC LIMIT 1'
    );
    if (result.rows.length === 0) {
      return res.json({ results: null, lastRun: null });
    }
    res.json({
      results:  result.rows[0].results,
      lastRun:  result.rows[0].created_at?.toISOString(),
      runDate:  result.rows[0].run_date,
    });
  } catch (err) {
    res.json({ results: null, error: err.message });
  }
});

// Trigger manual backtest run
let backtestRunning = false;
app.post('/api/backtest/run', async (req, res) => {
  if (backtestRunning) {
    return res.json({ ok: false, error: 'Backtest already running' });
  }
  res.json({ ok: true, message: 'Backtest started' });

  // Run in background
  backtestRunning = true;
  try {
    await executeBacktest();
  } finally {
    backtestRunning = false;
  }
});

// ── SEED BARS (one-shot, triggered via POST) ─────────────────────────────────
let seedRunning = false;
let seedResult = null;
app.post('/api/seed-bars', async (req, res) => {
  if (seedRunning) return res.json({ ok: false, error: 'Already running' });
  seedRunning = true;
  seedResult = null;
  res.json({ ok: true, message: 'Seed started' });
  try {
    const { execSync } = await import('child_process');
    const output = execSync('node scripts/seed-bars-historical.js', {
      cwd: process.cwd(), timeout: 600000, encoding: 'utf-8',
      env: { ...process.env },
    });
    seedResult = { ok: true, output: output.slice(-2000) };
    console.log('[SEED] Complete');
  } catch (err) {
    seedResult = { ok: false, error: err.message, output: (err.stdout || '').slice(-2000) };
    console.error('[SEED] Failed:', err.message);
  } finally {
    seedRunning = false;
  }
});
app.get('/api/seed-bars/status', (req, res) => {
  res.json({ running: seedRunning, result: seedResult });
});

// Seed earnings intelligence
let earningsRunning = false;
let earningsResult = null;
app.post('/api/seed-earnings', async (req, res) => {
  if (earningsRunning) return res.json({ ok: false, error: 'Already running' });
  earningsRunning = true;
  earningsResult = null;
  res.json({ ok: true, message: 'Earnings seed started' });
  try {
    const { execSync } = await import('child_process');
    const output = execSync('node scripts/seed-earnings.js', {
      cwd: process.cwd(), timeout: 600000, encoding: 'utf-8',
      env: { ...process.env },
    });
    earningsResult = { ok: true, output: output.slice(-2000) };
    console.log('[EARNINGS] Seed complete');
  } catch (err) {
    earningsResult = { ok: false, error: err.message, output: (err.stdout || '').slice(-2000) };
    console.error('[EARNINGS] Seed failed:', err.message);
  } finally {
    earningsRunning = false;
  }
});
app.get('/api/seed-earnings/status', (req, res) => {
  res.json({ running: earningsRunning, result: earningsResult });
});

// Seed IV rank
let ivRunning = false;
let ivResult = null;
app.post('/api/seed-iv', async (req, res) => {
  if (ivRunning) return res.json({ ok: false, error: 'Already running' });
  ivRunning = true;
  ivResult = null;
  res.json({ ok: true, message: 'IV seed started' });
  try {
    const { execSync } = await import('child_process');
    const output = execSync('node scripts/seed-iv-rank.js', {
      cwd: process.cwd(), timeout: 600000, encoding: 'utf-8',
      env: { ...process.env },
    });
    ivResult = { ok: true, output: output.slice(0, 3000) + '\n...\n' + output.slice(-2000) };
    console.log('[IV] Seed complete');
  } catch (err) {
    ivResult = { ok: false, error: err.message, output: (err.stdout || '').slice(-3000) };
    console.error('[IV] Seed failed:', err.message);
  } finally {
    ivRunning = false;
  }
});
app.get('/api/seed-iv/status', (req, res) => {
  res.json({ running: ivRunning, result: ivResult });
});

// Seed contagion map
let contagionRunning = false;
let contagionResult = null;
app.post('/api/seed-contagion', async (req, res) => {
  if (contagionRunning) return res.json({ ok: false, error: 'Already running' });
  contagionRunning = true;
  contagionResult = null;
  res.json({ ok: true, message: 'Contagion seed started' });
  try {
    const { execSync } = await import('child_process');
    const output = execSync('node scripts/seed-contagion.js', {
      cwd: process.cwd(), timeout: 600000, encoding: 'utf-8',
      env: { ...process.env },
    });
    contagionResult = { ok: true, output: output.slice(-3000) };
    console.log('[CONTAGION] Seed complete');
  } catch (err) {
    contagionResult = { ok: false, error: err.message, output: (err.stdout || '').slice(-3000) };
    console.error('[CONTAGION] Seed failed:', err.message);
  } finally {
    contagionRunning = false;
  }
});
app.get('/api/seed-contagion/status', (req, res) => {
  res.json({ running: contagionRunning, result: contagionResult });
});

// Seed macro sensitivity
let macroRunning = false;
let macroResult = null;
app.post('/api/seed-macro', async (req, res) => {
  if (macroRunning) return res.json({ ok: false, error: 'Already running' });
  macroRunning = true;
  macroResult = null;
  res.json({ ok: true, message: 'Macro seed started' });
  try {
    const { execSync } = await import('child_process');
    const output = execSync('node scripts/seed-macro.js', {
      cwd: process.cwd(), timeout: 600000, encoding: 'utf-8',
      env: { ...process.env },
    });
    macroResult = { ok: true, output: output.slice(-3000) };
    console.log('[MACRO] Seed complete');
  } catch (err) {
    macroResult = { ok: false, error: err.message, output: (err.stdout || '').slice(-3000) };
    console.error('[MACRO] Seed failed:', err.message);
  } finally {
    macroRunning = false;
  }
});
app.get('/api/seed-macro/status', (req, res) => {
  res.json({ running: macroRunning, result: macroResult });
});

// Seed insider transactions + SEC filings
let insiderRunning = false;
let insiderResult = null;
app.post('/api/seed-insider', async (req, res) => {
  if (insiderRunning) return res.json({ ok: false, error: 'Already running' });
  insiderRunning = true;
  insiderResult = null;
  res.json({ ok: true, message: 'Insider/filings seed started' });
  try {
    const { execSync } = await import('child_process');
    const output = execSync('node scripts/seed-insider-filings.js', {
      cwd: process.cwd(), timeout: 1200000, encoding: 'utf-8',
      env: { ...process.env },
    });
    insiderResult = { ok: true, output: output.slice(-3000) };
    console.log('[INSIDER] Seed complete');
  } catch (err) {
    insiderResult = { ok: false, error: err.message, output: (err.stdout || '').slice(-3000) };
    console.error('[INSIDER] Seed failed:', err.message);
  } finally {
    insiderRunning = false;
  }
});
app.get('/api/seed-insider/status', (req, res) => {
  res.json({ running: insiderRunning, result: insiderResult });
});

// Seed conviction universe fundamentals
let convictionRunning = false;
let convictionResult = null;
app.post('/api/seed-conviction', async (req, res) => {
  if (convictionRunning) return res.json({ ok: false, error: 'Already running' });
  convictionRunning = true;
  convictionResult = null;
  res.json({ ok: true, message: 'Conviction fundamentals seed started' });

  const FMP_KEY = process.env.FMP_API_KEY;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    const tickerRes = await db.query('SELECT ticker FROM lc_v3.conviction_universe ORDER BY ticker');
    const tickers = tickerRes.rows.map(r => r.ticker);
    console.log(`[CONV-FUND] ${tickers.length} tickers to process`);

    let inserted = 0;
    for (let i = 0; i < tickers.length; i += 5) {
      const batch = tickers.slice(i, i + 5);
      await Promise.all(batch.map(async (ticker) => {
        try {
          await sleep(400);
          const [incRes, cfRes] = await Promise.all([
            axios.get(`https://financialmodelingprep.com/stable/income-statement?symbol=${ticker}&period=quarter&limit=8&apikey=${FMP_KEY}`, { timeout: 15000 }),
            axios.get(`https://financialmodelingprep.com/stable/cash-flow-statement?symbol=${ticker}&period=quarter&limit=8&apikey=${FMP_KEY}`, { timeout: 15000 }),
          ]);
          const income = incRes.data || [];
          const cashflow = cfRes.data || [];
          if (!Array.isArray(income) || income.length === 0) return;

          const cfMap = {};
          if (Array.isArray(cashflow)) {
            for (const cf of cashflow) cfMap[cf.period] = cf;
          }

          for (const q of income) {
            if (!q.period) continue;
            const cf = cfMap[q.period] || {};
            const grossMargin = q.revenue && q.revenue !== 0 ? parseFloat((q.grossProfit / q.revenue).toFixed(4)) : null;
            const opMargin = q.revenue && q.revenue !== 0 ? parseFloat((q.operatingIncome / q.revenue).toFixed(4)) : null;

            await db.query(`
              INSERT INTO lc_v3.fundamentals (
                ticker, period, revenue, gross_profit, operating_income, net_income,
                free_cash_flow, gross_margin, operating_margin,
                accounts_receivable, inventory, total_debt, cash_and_equivalents, reported_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
              ON CONFLICT (ticker, period) DO UPDATE SET
                revenue = EXCLUDED.revenue, gross_profit = EXCLUDED.gross_profit,
                operating_income = EXCLUDED.operating_income, net_income = EXCLUDED.net_income,
                free_cash_flow = EXCLUDED.free_cash_flow, gross_margin = EXCLUDED.gross_margin,
                operating_margin = EXCLUDED.operating_margin, accounts_receivable = EXCLUDED.accounts_receivable,
                inventory = EXCLUDED.inventory, total_debt = EXCLUDED.total_debt,
                cash_and_equivalents = EXCLUDED.cash_and_equivalents, reported_at = EXCLUDED.reported_at
            `, [
              ticker, q.period, q.revenue ?? null, q.grossProfit ?? null,
              q.operatingIncome ?? null, q.netIncome ?? null, cf.freeCashFlow ?? null,
              grossMargin, opMargin, cf.accountsReceivables ?? null,
              cf.inventory ?? null, cf.totalDebt ?? cf.netDebt ?? null,
              cf.cashAtEndOfPeriod ?? null, q.date || null,
            ]);
            inserted++;
          }
          console.log(`[CONV-FUND] ${ticker} done`);
        } catch (err) {
          console.error(`[CONV-FUND] ${ticker} error: ${err.message}`);
        }
      }));

      if ((i + 5) % 50 === 0) console.log(`[CONV-FUND] Progress: ${i + 5}/${tickers.length}, ${inserted} rows`);
    }

    convictionResult = { ok: true, tickers: tickers.length, rows: inserted };
    console.log(`[CONV-FUND] Done — ${inserted} rows inserted for ${tickers.length} tickers`);
  } catch (err) {
    convictionResult = { ok: false, error: err.message };
    console.error('[CONV-FUND] FATAL:', err.message);
  } finally {
    convictionRunning = false;
  }
});
app.get('/api/seed-conviction/status', (req, res) => {
  res.json({ running: convictionRunning, result: convictionResult });
});

// Backtest status
let backtestError = null;
app.get('/api/backtest/status', (req, res) => {
  res.json({ running: backtestRunning, error: backtestError });
});

// Directional accuracy check — multi-horizon
app.get('/api/backtest/direction-check', async (req, res) => {
  try {
    const btRes = await db.query(
      'SELECT results FROM lc_v3.backtest_results ORDER BY created_at DESC LIMIT 1'
    );
    if (!btRes.rows[0]) return res.json({ error: 'no backtest results' });
    const signals = btRes.rows[0].results.signals || [];

    const horizons = [
      { label: '30min', ms: 30 * 60000 },
      { label: '1hr',   ms: 60 * 60000 },
      { label: '2hr',   ms: 120 * 60000 },
      { label: '4hr',   ms: 240 * 60000 },
    ];

    const results = {};
    for (const h of horizons) results[h.label] = { checked: 0, correct: 0 };
    results['next_day_close'] = { checked: 0, correct: 0 };

    // Track per-signal correctness for "wrong at 1hr but right later" analysis
    const perSignal = []; // { correct_1hr, correct_2hr, correct_4hr }

    for (const sig of signals) {
      const ticker = sig.ticker;
      const sigTime = sig.time + ':00Z';
      const sigDate = sig.date;

      // Get entry price
      const entryBar = await db.query(
        `SELECT close FROM lc_v3.bars WHERE ticker = $1 AND ts >= $2::timestamptz AND ts < $2::timestamptz + interval '2 minutes' LIMIT 1`,
        [ticker, sigTime]
      );
      if (!entryBar.rows[0]) continue;
      const entryPrice = parseFloat(entryBar.rows[0].close);

      const sigRecord = { correct_1hr: null, correct_2hr: null, correct_4hr: null };

      // Check each time horizon
      for (const h of horizons) {
        const checkTime = new Date(new Date(sigTime).getTime() + h.ms).toISOString();
        const exitBar = await db.query(
          `SELECT close FROM lc_v3.bars WHERE ticker = $1 AND ts >= $2::timestamptz AND ts < $2::timestamptz + interval '2 minutes' LIMIT 1`,
          [ticker, checkTime]
        );
        if (!exitBar.rows[0]) continue;
        const exitPrice = parseFloat(exitBar.rows[0].close);
        results[h.label].checked++;
        const moved = exitPrice - entryPrice;
        const isCorrect = (sig.direction === 'CALL' && moved > 0) || (sig.direction === 'PUT' && moved < 0);
        if (isCorrect) results[h.label].correct++;

        if (h.label === '1hr') sigRecord.correct_1hr = isCorrect;
        if (h.label === '2hr') sigRecord.correct_2hr = isCorrect;
        if (h.label === '4hr') sigRecord.correct_4hr = isCorrect;
      }

      // Next day close: find last bar of the next trading day
      const nextDayBar = await db.query(
        `SELECT close FROM lc_v3.bars WHERE ticker = $1 AND DATE(ts) > $2::date AND session = 'REGULAR' ORDER BY ts DESC LIMIT 1`,
        [ticker, sigDate]
      );
      if (nextDayBar.rows[0]) {
        const exitPrice = parseFloat(nextDayBar.rows[0].close);
        results['next_day_close'].checked++;
        const moved = exitPrice - entryPrice;
        if ((sig.direction === 'CALL' && moved > 0) || (sig.direction === 'PUT' && moved < 0)) {
          results['next_day_close'].correct++;
        }
      }

      perSignal.push(sigRecord);
    }

    // Compute accuracies
    const horizonResults = {};
    for (const [label, data] of Object.entries(results)) {
      horizonResults[label] = {
        ...data,
        accuracy: data.checked > 0 ? parseFloat((data.correct / data.checked * 100).toFixed(1)) : 0,
      };
    }

    // Wrong at 1hr but right later
    const wrong1hr = perSignal.filter(s => s.correct_1hr === false);
    const wrong1hr_right2hr = wrong1hr.filter(s => s.correct_2hr === true).length;
    const wrong1hr_right4hr = wrong1hr.filter(s => s.correct_4hr === true).length;
    const wrong1hr_right2or4 = wrong1hr.filter(s => s.correct_2hr === true || s.correct_4hr === true).length;

    res.json({
      horizons: horizonResults,
      earlyTiming: {
        wrong_at_1hr: wrong1hr.length,
        right_at_2hr: wrong1hr_right2hr,
        right_at_4hr: wrong1hr_right4hr,
        right_at_2hr_or_4hr: wrong1hr_right2or4,
        recovery_rate: wrong1hr.length > 0 ? parseFloat((wrong1hr_right2or4 / wrong1hr.length * 100).toFixed(1)) : 0,
      },
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Debug: check what bars exist in DB
app.get('/api/backtest/debug', async (req, res) => {
  try {
    const barStats = await db.query(`
      SELECT COUNT(*) as total_bars,
        COUNT(DISTINCT ticker) as tickers,
        MIN(ts) as min_ts, MAX(ts) as max_ts,
        COUNT(DISTINCT DATE(ts)) as distinct_days
      FROM lc_v3.bars
    `);
    const sampleDays = await db.query(`
      SELECT DATE(ts) as day, COUNT(*) as bars
      FROM lc_v3.bars
      GROUP BY DATE(ts)
      ORDER BY day DESC
      LIMIT 5
    `);
    const sampleTickers = await db.query(`
      SELECT ticker, COUNT(*) as bars
      FROM lc_v3.bars
      GROUP BY ticker
      ORDER BY bars DESC
      LIMIT 5
    `);
    res.json({
      stats: barStats.rows[0],
      recentDays: sampleDays.rows,
      topTickers: sampleTickers.rows,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

async function executeBacktest() {
  backtestError = null;
  try {
    // Ensure backtest_results table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.backtest_results (
        id SERIAL PRIMARY KEY,
        run_date DATE NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        results JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_bt_run_date ON lc_v3.backtest_results(run_date DESC)`);

    // Last 20 trading days
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30); // ~30 calendar days ≈ 20 trading days
    const startDate = start.toISOString().split('T')[0];
    const endDate   = end.toISOString().split('T')[0];

    console.log(`[BACKTEST] Starting: ${startDate} → ${endDate}`);
    const results = await runBacktest(startDate, endDate, parseFloat(process.env.ACCOUNT_SIZE || '7500'));
    console.log(`[BACKTEST] Results: ${results?.summary?.totalSignals || 0} signals, ${results?.config?.tradingDays || 0} days`);

    // Store in DB
    await db.query(`
      INSERT INTO lc_v3.backtest_results (run_date, start_date, end_date, results)
      VALUES (CURRENT_DATE, $1, $2, $3)
    `, [startDate, endDate, JSON.stringify(results)]);

    // Keep only last 30 runs
    await db.query(`
      DELETE FROM lc_v3.backtest_results
      WHERE id NOT IN (
        SELECT id FROM lc_v3.backtest_results ORDER BY run_date DESC LIMIT 30
      )
    `);

    console.log(`[BACKTEST] Complete: ${results.summary?.totalSignals || 0} signals, P&L: $${results.summary?.totalPnlDollars || 0}`);
  } catch (err) {
    backtestError = `${err.message}\n${err.stack}`;
    console.error('[BACKTEST] Failed:', err.message);
    console.error('[BACKTEST] Stack:', err.stack);
  }
}

// Schedule daily backtest at 5pm ET (after market close)
cron.schedule('0 17 * * 1-5', () => {
  if (!backtestRunning) {
    console.log('[BACKTEST] Scheduled daily run starting...');
    backtestRunning = true;
    executeBacktest().finally(() => { backtestRunning = false; });
  }
}, { timezone: 'America/New_York' });

// ── RALLY EXHAUSTION ANALYSIS (6mo daily bars from Alpaca) ──────────────────
app.get('/api/analysis/rally-exhaustion', async (req, res) => {
  try {
    const profileRes = await db.query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
    const tickers = profileRes.rows.map(r => r.ticker);

    const API_KEY = process.env.ALPACA_API_KEY;
    const API_SECRET = process.env.ALPACA_SECRET_KEY;
    if (!API_KEY || !API_SECRET) return res.status(500).json({ error: 'No Alpaca keys' });

    const headers = { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET };
    const allBars = {}; // ticker -> [{day, o, h, l, c, v}]
    const batchSize = 40;

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      let pageToken = null;
      do {
        const params = {
          symbols: batch.join(','), timeframe: '1Day',
          start: '2025-09-01', end: new Date().toISOString().slice(0, 10),
          limit: 10000, feed: 'sip', adjustment: 'split',
        };
        if (pageToken) params.page_token = pageToken;
        const resp = await axios.get('https://data.alpaca.markets/v2/stocks/bars', { headers, params });
        for (const [ticker, bars] of Object.entries(resp.data.bars || {})) {
          if (!allBars[ticker]) allBars[ticker] = [];
          for (const b of bars) allBars[ticker].push({ day: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        }
        pageToken = resp.data.next_page_token || null;
      } while (pageToken);
    }

    // Sort
    for (const t of Object.keys(allBars)) allBars[t].sort((a, b) => a.day.localeCompare(b.day));

    const totalBars = Object.values(allBars).reduce((s, v) => s + v.length, 0);
    const tickerCount = Object.keys(allBars).length;

    // 3-day rally exhaustion
    const b3Order = ['+1% to +2%', '+2% to +3%', '+3% to +5%', '+5% to +8%', '+8%+'];
    const b3 = {}, b3High = {}, b3NotHigh = {};
    for (const k of b3Order) { b3[k] = { total: 0, nextDown: 0, rets: [] }; b3High[k] = { total: 0, nextDown: 0, rets: [] }; b3NotHigh[k] = { total: 0, nextDown: 0, rets: [] }; }

    // 10-day rally exhaustion
    const b10Order = ['+3% to +5%', '+5% to +8%', '+8% to +12%', '+12%+'];
    const b10 = {};
    for (const k of b10Order) b10[k] = { total: 0, nextDown: 0, rets: [] };

    for (const [ticker, days] of Object.entries(allBars)) {
      for (let i = 20; i < days.length - 1; i++) {
        const curr = days[i], next = days[i + 1];
        if (curr.c === 0) continue;
        const nextRet = (next.c - curr.c) / curr.c * 100;

        // 3-day
        if (i >= 3) {
          const prev3 = days[i - 3];
          if (prev3.c > 0) {
            const ret3 = (curr.c - prev3.c) / prev3.c * 100;
            if (ret3 > 1) {
              const bk = ret3 <= 2 ? '+1% to +2%' : ret3 <= 3 ? '+2% to +3%' : ret3 <= 5 ? '+3% to +5%' : ret3 <= 8 ? '+5% to +8%' : '+8%+';
              b3[bk].total++; if (nextRet < 0) b3[bk].nextDown++; b3[bk].rets.push(nextRet);
              const high20 = Math.max(...days.slice(i - 19, i + 1).map(d => d.h));
              const atHigh = curr.c >= high20 * 0.99;
              const t = atHigh ? b3High : b3NotHigh;
              t[bk].total++; if (nextRet < 0) t[bk].nextDown++; t[bk].rets.push(nextRet);
            }
          }
        }

        // 10-day
        if (i >= 10) {
          const prev10 = days[i - 10];
          if (prev10.c > 0) {
            const ret10 = (curr.c - prev10.c) / prev10.c * 100;
            if (ret10 > 3) {
              const bk = ret10 <= 5 ? '+3% to +5%' : ret10 <= 8 ? '+5% to +8%' : ret10 <= 12 ? '+8% to +12%' : '+12%+';
              b10[bk].total++; if (nextRet < 0) b10[bk].nextDown++; b10[bk].rets.push(nextRet);
            }
          }
        }
      }
    }

    function stats(buckets, order) {
      return order.map(k => {
        const d = buckets[k];
        if (d.total === 0) return { bucket: k, total: 0 };
        const mean = d.rets.reduce((a, b) => a + b, 0) / d.total;
        const variance = d.rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.total - 1 || 1);
        const se = Math.sqrt(variance / d.total);
        const tStat = se > 0 ? mean / se : 0;
        return {
          bucket: k, total: d.total, nextDown: d.nextDown,
          downPct: +(d.nextDown / d.total * 100).toFixed(1),
          avgNext: +mean.toFixed(4), tStat: +tStat.toFixed(2),
          sig: Math.abs(tStat) > 2.58 ? '**' : Math.abs(tStat) > 1.96 ? '*' : '',
        };
      }).filter(x => x.total > 0);
    }

    res.json({
      totalBars, tickerCount,
      rally3d: stats(b3, b3Order),
      rally3dHigh: stats(b3High, b3Order),
      rally3dNotHigh: stats(b3NotHigh, b3Order),
      rally10d: stats(b10, b10Order),
    });
  } catch (err) {
    console.error('[ANALYSIS]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── IV EXPANSION PRE-EARNINGS ANALYSIS ──────────────────────────────────────
app.get('/api/analysis/iv-expansion', async (req, res) => {
  try {
    const API_KEY = process.env.ALPACA_API_KEY;
    const API_SECRET = process.env.ALPACA_SECRET_KEY;
    if (!API_KEY || !API_SECRET) return res.status(500).json({ error: 'No Alpaca keys' });

    // Get historical earnings
    const intelRes = await db.query(`
      SELECT ticker, historical_earnings FROM lc_v3.ticker_intelligence
      WHERE historical_earnings IS NOT NULL
    `);
    const allEvents = [];
    for (const row of intelRes.rows) {
      const hist = row.historical_earnings;
      for (const q of hist) {
        if (q.date) allEvents.push({ ticker: row.ticker, date: q.date });
      }
    }

    // Fetch 6mo daily bars
    const profileRes = await db.query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
    const tickers = profileRes.rows.map(r => r.ticker);
    const headers = { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET };
    const allBars = {};
    for (let i = 0; i < tickers.length; i += 40) {
      const batch = tickers.slice(i, i + 40);
      let pageToken = null;
      do {
        const params = {
          symbols: batch.join(','), timeframe: '1Day',
          start: '2025-09-01', end: new Date().toISOString().slice(0, 10),
          limit: 10000, feed: 'sip', adjustment: 'split',
        };
        if (pageToken) params.page_token = pageToken;
        const resp = await axios.get('https://data.alpaca.markets/v2/stocks/bars', { headers, params });
        for (const [t, bars] of Object.entries(resp.data.bars || {})) {
          if (!allBars[t]) allBars[t] = [];
          for (const b of bars) allBars[t].push({ day: b.t.slice(0, 10), o: b.o, c: b.c });
        }
        pageToken = resp.data.next_page_token || null;
      } while (pageToken);
    }
    for (const t of Object.keys(allBars)) allBars[t].sort((a, b) => a.day.localeCompare(b.day));

    // Build day index
    const dayIdx = {};
    for (const [t, days] of Object.entries(allBars)) {
      dayIdx[t] = {};
      days.forEach((d, i) => { dayIdx[t][d.day] = i; });
    }

    const windows = [10, 7, 5, 3, 1];
    const volByWindow = {};
    for (const w of windows) volByWindow[w] = [];
    const baselineVols = [];
    const erDayMoves = [];

    for (const ev of allEvents) {
      const days = allBars[ev.ticker];
      const idx = dayIdx[ev.ticker];
      if (!days || days.length < 30) continue;

      let ei = idx[ev.date];
      if (ei === undefined) {
        const after = Object.entries(idx).filter(([d]) => d >= ev.date).sort((a, b) => a[0].localeCompare(b[0]));
        if (after.length > 0) { ei = after[0][1]; }
        else {
          const before = Object.entries(idx).filter(([d]) => d <= ev.date).sort((a, b) => b[0].localeCompare(a[0]));
          if (before.length > 0) ei = before[0][1];
          else continue;
        }
      }
      if (ei < 25) continue;

      // Earnings day move
      if (days[ei].o > 0) {
        erDayMoves.push(Math.abs((days[ei].c - days[ei].o) / days[ei].o * 100));
      }

      // Vol at each window
      for (const w of windows) {
        const end = ei;
        const start = end - w;
        if (start < 1) continue;
        const rets = [];
        for (let j = start; j < end; j++) {
          if (days[j - 1].c > 0) rets.push((days[j].c - days[j - 1].c) / days[j - 1].c * 100);
        }
        if (rets.length >= 2) {
          const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
          const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
          volByWindow[w].push(Math.sqrt(variance) * Math.sqrt(252));
        }
      }

      // Baseline: 20d vol ending 15d before earnings
      const blEnd = ei - 15;
      const blStart = blEnd - 20;
      if (blStart >= 1) {
        const brets = [];
        for (let j = blStart; j < blEnd; j++) {
          if (days[j - 1].c > 0) brets.push((days[j].c - days[j - 1].c) / days[j - 1].c * 100);
        }
        if (brets.length >= 5) {
          const mean = brets.reduce((a, b) => a + b, 0) / brets.length;
          const variance = brets.reduce((a, b) => a + (b - mean) ** 2, 0) / (brets.length - 1);
          baselineVols.push(Math.sqrt(variance) * Math.sqrt(252));
        }
      }
    }

    const baselineAvg = baselineVols.length > 0 ? baselineVols.reduce((a, b) => a + b, 0) / baselineVols.length : 0;

    const windowResults = windows.map(w => {
      const vols = volByWindow[w];
      if (vols.length === 0) return { window: w, samples: 0 };
      const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
      return { window: w, samples: vols.length, avgAnnVol: +avg.toFixed(1), vsBaseline: baselineAvg > 0 ? +(avg / baselineAvg * 100).toFixed(0) : 0 };
    });

    const erMove = erDayMoves.length > 0 ? {
      events: erDayMoves.length,
      avgAbsMove: +(erDayMoves.reduce((a, b) => a + b, 0) / erDayMoves.length).toFixed(2),
      medianAbsMove: +erDayMoves.sort((a, b) => a - b)[Math.floor(erDayMoves.length / 2)].toFixed(2),
      movesOver5pct: erDayMoves.filter(m => m > 5).length,
    } : null;

    res.json({
      totalEvents: allEvents.length, matchedEvents: erDayMoves.length,
      baselineAnnVol: +baselineAvg.toFixed(1), baselineSamples: baselineVols.length,
      windows: windowResults, earningsDayMove: erMove,
    });
  } catch (err) {
    console.error('[ANALYSIS]', err);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all — serve dashboard
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[LC v3] Server running on port ${PORT}`);
  console.log(`[LC v3] Dashboard: http://localhost:${PORT}`);
  startWorker();
});

// ── SCORING WORKER ────────────────────────────────────────────────────────────
async function startWorker() {
  // Always start REST poller — guaranteed signal generation every 60s
  startRestPoller();

  // Also try WebSocket worker for real-time scoring
  try {
    await import('./src/main.js');
    console.log('[LC v3] WebSocket scoring worker started');
  } catch (err) {
    console.error('[LC v3] WebSocket worker failed — REST poller is backup:', err.message);
  }
}

// ── REST POLLING SCORER (guaranteed fallback) ─────────────────────────────────
const GRADE_SCALE  = [[83,'A+'],[73,'A'],[63,'A-'],[53,'B+'],[43,'B']];
const POSITION_SZ  = {'A+':0.20,'A':0.15,'A-':0.10,'B+':0.075,'B':0.05};
const ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || '7500');
const ALPACA_FEED  = process.env.ALPACA_FEED || 'sip';

// Catalyst type → polarity for REST news classification
const GENERIC_POLARITY_MAP = {
  earnings_beat: 2, earnings_miss: -2, analyst_upgrade: 2, analyst_downgrade: -2,
  hyperscaler_capex: 2, ai_chip_export_restriction: -2, ai_model_release: 1,
  memory_pricing: 1, hbm_demand: 2, delivery_numbers: 1, elon_event: 1,
  fsd_update: 1, ai_accelerator: 2, cpu_share_gain: 1, iphone_cycle: 1,
  services_growth: 1, ad_revenue: 1, ai_capex: 1, azure_growth: 2,
  openai_news: 1, search_revenue: 1, cloud_growth: 2, fab_capex: 2,
  macro_rate_cut: 1, macro_rate_hike: -1, macro_cpi: 0, macro_fomc: 0,
  regulatory: -2, other: 0,
};

function toGrade(score) {
  for (const [t, g] of GRADE_SCALE) if (score >= t) return g;
  return null;
}

function getSessionPoller() {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day  = et.getDay();
  if (day === 0 || day === 6) return 'WEEKEND';
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 240  && mins < 570)  return 'PRE_MARKET';
  if (mins >= 570  && mins < 960)  return 'REGULAR';
  if (mins >= 960  && mins < 1200) return 'POST_MARKET';
  return 'OVERNIGHT';
}

async function startRestPoller() {
  const alpacaHdrs = {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };
  const dataUrl = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

  async function poll() {
    const session = getSessionPoller();
    if (session === 'OVERNIGHT' || session === 'WEEKEND') return;

    try {
      const profileRes = await db.query('SELECT ticker, atr_20d FROM lc_v3.equity_profiles');
      const profiles   = {};
      profileRes.rows.forEach(p => { profiles[p.ticker] = p; });
      const tickers = Object.keys(profiles);

      const allSnaps = {};
      for (let i = 0; i < tickers.length; i += 50) {
        const batch = tickers.slice(i, i + 50);
        const res = await axios.get(`${dataUrl}/v2/stocks/snapshots`, {
          headers: alpacaHdrs, params: { symbols: batch.join(','), feed: ALPACA_FEED }, timeout: 10000,
        });
        Object.assign(allSnaps, res.data || {});
      }

      const mktRes = await axios.get(`${dataUrl}/v2/stocks/snapshots`, {
        headers: alpacaHdrs, params: { symbols: 'SPY,QQQ', feed: ALPACA_FEED }, timeout: 5000,
      });
      const mkt    = mktRes.data || {};
      const spyPct = mkt.SPY ? ((mkt.SPY.latestTrade?.p||0)-(mkt.SPY.prevDailyBar?.c||0))/(mkt.SPY.prevDailyBar?.c||1) : 0;
      const qqqPct = mkt.QQQ ? ((mkt.QQQ.latestTrade?.p||0)-(mkt.QQQ.prevDailyBar?.c||0))/(mkt.QQQ.prevDailyBar?.c||1) : 0;

      // SPY bars for regime detection (last 3 minute bars)
      const spyBars = mkt.SPY ? [mkt.SPY.prevMinuteBar, mkt.SPY.minuteBar].filter(Boolean) : [];

      // Fetch VIX
      let vix = 18;
      try {
        const vixRes = await axios.get(`${dataUrl}/v2/stocks/VIX/bars/latest`, {
          headers: alpacaHdrs, params: { feed: 'iex' }, timeout: 5000,
        });
        vix = vixRes.data?.bar?.c || 18;
      } catch(e) {}

      // Fetch recent news via REST to supplement WebSocket stream
      try {
        const { addNewsEvent } = await import('./src/data/state.js');
        const { classifyCatalyst } = await import('./src/scoring/news.js');
        const since = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // last 4 hours
        const newsRes = await axios.get(`${dataUrl}/v1beta1/news`, {
          headers: alpacaHdrs,
          params: { symbols: tickers.join(','), start: since, limit: 50, sort: 'desc' },
          timeout: 10000,
        });
        const articles = newsRes.data?.news || [];
        let newsAdded = 0;
        for (const article of articles) {
          const headline = article.headline || '';
          const timestamp = article.created_at || article.updated_at || new Date().toISOString();
          const symbols = article.symbols || [];
          const relevant = symbols.filter(s => profiles[s]);
          for (const ticker of relevant) {
            const existing = getNewsEvents(ticker);
            if (existing.some(e => e.headline === headline)) continue; // skip duplicates
            const classified = await classifyCatalyst(headline, ticker);
            addNewsEvent(ticker, {
              headline,
              catalyst: classified,
              polarity: GENERIC_POLARITY_MAP[classified.type] ?? 0,
              timestamp,
              symbols,
              source: article.source || 'alpaca-rest',
            });
            newsAdded++;
          }
        }
        if (newsAdded > 0) console.log(`[POLL] Added ${newsAdded} news events from REST (${articles.length} articles)`);
      } catch (newsErr) {
        console.error('[POLL] News fetch error:', newsErr.message);
      }

      // Classify market regime once for all signals this cycle
      const { classifyRegime } = await import('./src/scoring/intelligence.js');
      const regime = classifyRegime({ spyPct, qqqPct }, vix, spyBars);

      if (regime.regimeNote) {
        console.log(`[REGIME] ${regime.regime} — ${regime.regimeNote}`);
      }
      global.currentRegime = regime;
      global.marketContext = { spyPct, qqqPct, vix, updatedAt: new Date().toISOString() };

      console.log(`[POLL] ${Object.keys(allSnaps).length} snaps SPY=${(spyPct*100).toFixed(2)}% QQQ=${(qqqPct*100).toFixed(2)}% VIX=${vix} REGIME=${regime.regime}`);

      // Import intelligence functions
      const { analyzeLevels, analyzeTrend, gateSignal } = await import('./src/scoring/intelligence.js');
      const { analyzeMomentum, shouldSkipOnFreshness } = await import('./src/scoring/momentum.js');

      let written = 0;
      const today = new Date().toISOString().split('T')[0];

      for (const [ticker, snap] of Object.entries(allSnaps)) {
        const price     = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
        const prevClose = snap.prevDailyBar?.c || 0;
        const openPrice = snap.dailyBar?.o || price;
        if (!price || !prevClose) continue;

        // Direction based on session move (price vs open), not minute-to-minute
        const sessionMove = openPrice > 0 ? (price - openPrice) / openPrice : 0;
        const direction   = sessionMove >= 0 ? 'CALL' : 'PUT';
        const mult        = direction === 'CALL' ? 1 : -1;
        const moveFromOpen = sessionMove * mult; // always positive for the chosen direction
        const atr         = parseFloat(profiles[ticker]?.atr_20d || 0.025);
        const moveInATRs  = atr > 0 ? Math.abs(sessionMove) / atr : 0;

        // Gate: need at least 0.1 ATR session move to consider scoring
        if (moveInATRs < 0.1) continue;

        const latestBar = snap.minuteBar;
        const prevBar   = snap.prevMinuteBar;
        const absRecent = (latestBar && prevBar && prevBar.c > 0)
          ? Math.abs((latestBar.c - prevBar.c) / prevBar.c)
          : 0;

        // Build mock state for intelligence engine from snapshot data
        const vwap         = snap.minuteBar?.vw || price;
        const sessionHigh  = snap.dailyBar?.h || price;
        const sessionLow   = snap.dailyBar?.l || price;
        const prevDayHigh  = snap.prevDailyBar?.h || prevClose * 1.01;
        const prevDayLow   = snap.prevDailyBar?.l || prevClose * 0.99;

        // Build synthetic bar history from daily and minute bars
        // REST poller has limited bar history vs WebSocket — use what we have
        const syntheticBars = [
          snap.prevMinuteBar,
          snap.minuteBar,
        ].filter(Boolean).map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }));

        const mockState = {
          close: price, vwap, sessionHigh, sessionLow,
          prevDayHigh, prevDayLow, sessionOpen: openPrice,
          bars: syntheticBars,
        };

        // Momentum analysis — use full scorer if enough bars, else inline fallback
        let momentum, freshness, paScore;
        const atrMult = moveInATRs; // session move in ATRs, not minute-to-minute

        if (syntheticBars.length >= 5) {
          momentum = analyzeMomentum(syntheticBars, openPrice, prevClose, atr, direction);
          freshness = momentum.freshness;
          paScore = momentum.momentumScore;

          if (shouldSkipOnFreshness(freshness, momentum.entryRisk)) {
            continue;
          }
        } else {
          // REST poller fallback — score based on session move from open
          freshness = moveInATRs < 0.5 ? 'FRESH'
                    : moveInATRs < 1.0 ? 'DEVELOPING'
                    : moveInATRs < 1.5 ? 'EXTENDED'
                    : moveInATRs < 2.0 ? 'LATE'
                    : 'EXHAUSTED';
          if (freshness === 'EXHAUSTED') continue;

          const freshnessPenalty = moveInATRs > 1.5 ? 0.5 : moveInATRs > 1.0 ? 0.75 : 1.0;
          paScore = Math.min(35, Math.round(moveInATRs * 35 * freshnessPenalty));
          momentum = { momentumScore: paScore, freshness, entryRisk: freshness === 'FRESH' ? 'LOW' : 'MODERATE', barsInMove: 0, moveFromOpen: parseFloat((moveFromOpen * 100).toFixed(3)), recentAccel: parseFloat((absRecent * 100).toFixed(3)), volSurge: 1, exhaustion: false, moveInATRs: parseFloat(moveInATRs.toFixed(2)) };
        }

        // Run intelligence analysis
        const levels = analyzeLevels(mockState, atr);
        const trend  = analyzeTrend(syntheticBars, direction);

        // Gate signal through full intelligence check
        const gate = gateSignal(direction, trend, levels, regime, freshness);

        if (!gate.allow) {
          console.log(`[GATE] ${ticker} ${direction} rejected — ${gate.reason}`);
          continue;
        }

        // Volume scoring — daily pace vs yesterday (more stable than single-minute comparison)
        const todayVol  = snap.dailyBar?.v || 0;
        const prevDayVol = snap.prevDailyBar?.v || 1;
        const minsOpen  = Math.max(1, (() => {
          const et = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
          return Math.max(1, (et.getHours() * 60 + et.getMinutes()) - 570);
        })());
        const fractionOfDay = Math.min(1, minsOpen / 390);
        const projectedVol  = fractionOfDay > 0 ? todayVol / fractionOfDay : todayVol;
        const relVol    = prevDayVol > 0 ? projectedVol / prevDayVol : 1;
        const volScore  = Math.min(30, Math.round(relVol * 12));

        const spyOk    = direction === 'CALL' ? spyPct > 0 : spyPct < 0;
        const qqqOk    = direction === 'CALL' ? qqqPct > 0 : qqqPct < 0;
        const mktScore = (spyOk?7:0) + (qqqOk?7:0);

        const et2      = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
        const mins2    = et2.getHours()*60 + et2.getMinutes();
        const timScore = (mins2>=570 && mins2<660) ? 5
                       : (mins2>=660 && mins2<720) ? 4
                       : (mins2>=720 && mins2<780) ? 1
                       : (mins2>=780 && mins2<960) ? 3
                       : 2;

        // News scoring — pull events from WebSocket stream state
        const newsEvents = getNewsEvents(ticker);
        const newsResult = computeNewsScore({ direction, newsEvents, profile: profiles[ticker] });
        const newsScore  = newsResult.score;

        const composite = paScore + volScore + mktScore + timScore + newsScore;

        let grade = toGrade(composite);
        if (!grade) continue;
        if (paScore < 15 || volScore < 12) continue;

        const isExt = session !== 'REGULAR';
        if (isExt && ['A+','A','A-'].includes(grade)) grade = 'B+';

        // Apply intelligence size multiplier
        const baseSizePct = (POSITION_SZ[grade]||0.05) * (isExt?0.5:1.0);
        const sizePct     = baseSizePct * (gate.adjustedSizeMult || 1.0);

        // Build signal note with full context
        const signalNote = [
          freshness,
          `Risk:${momentum.entryRisk}`,
          `Type:${gate.signalType || 'NEUTRAL'}`,
          `Bars:${momentum.barsInMove}`,
          `Accel:${momentum.recentAccel.toFixed(3)}%`,
          `From Open:${momentum.moveFromOpen.toFixed(2)}%`,
          regime.regimeNote ? `Regime:${regime.regime}` : null,
          levels.nearestAbove ? `ResAt:$${levels.nearestAbove.price.toFixed(2)}(${levels.nearestAbove.name})` : null,
          newsScore > 0 && newsResult.headline ? `News:${newsResult.headline.slice(0, 60)}` : null,
        ].filter(Boolean).join(' · ');

        // ── MOMENTUM UPSERT — one signal per ticker+direction per day ──
        const existing = await db.query(`
          SELECT signal_id, composite_raw, grade, peak_composite, peak_grade,
                 confirmation_count, composite_history, human_taken
          FROM lc_v3.signals
          WHERE ticker = $1 AND direction = $2
            AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
            AND status NOT IN ('TAKEN','SKIPPED')
          ORDER BY created_at DESC LIMIT 1
        `, [ticker, direction]);

        // Fetch contract
        let contract = null;
        try {
          contract = await selectOptionsContract(ticker, direction, grade, price, atr);
        } catch (ce) {
          console.error(`[contract] ${ticker}: ${ce.message}`);
        }

        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          if (row.human_taken !== null) continue; // don't update taken/skipped

          const oldHistory = row.composite_history || [];
          const newHistory = [...oldHistory, { t: Date.now(), score: composite, grade }].slice(-60);
          const newPeak = composite > (row.peak_composite || 0) ? composite : row.peak_composite;
          const newPeakGrade = composite > (row.peak_composite || 0) ? grade : row.peak_grade;

          // Compute momentum trend from last 3 entries
          let trend = 'STABLE';
          if (newHistory.length >= 3) {
            const last3 = newHistory.slice(-3).map(h => h.score);
            if (last3[2] > last3[0] + 3) trend = 'STRENGTHENING';
            else if (last3[2] < last3[0] - 3) trend = 'WEAKENING';
          }

          const contractCols = contract ? `,
            contract_symbol = $16, contract_strike = $17, contract_expiry = $18,
            contract_expiry_label = $19, contract_bid = $20, contract_ask = $21,
            contract_mid = $22, contract_entry_lo = $23, contract_entry_hi = $24,
            contract_delta = $25, contract_iv = $26,
            contract_t1 = $27, contract_t2 = $28, contract_t3 = $29, contract_stop = $30,
            contract_estimated = $31` : '';
          const contractParams = contract ? [
            contract.symbol, contract.strike, contract.expiry,
            contract.expiry_label, contract.bid, contract.ask,
            contract.mid, contract.entry_lo, contract.entry_hi,
            contract.delta, contract.iv,
            contract.t1, contract.t2, contract.t3, contract.stop,
            contract.estimated || false,
          ] : [];

          await db.query(`
            UPDATE lc_v3.signals SET
              grade = $1, composite_raw = $2,
              score_price_action = $3, score_volume = $4, score_news = $5,
              score_market = $6, score_timing = $7,
              position_size_pct = $8, position_size_dollars = $9,
              spy_change_pct = $10, qqq_change_pct = $11,
              relative_volume = $12, atr_multiple = $13,
              news_headline = $14, vix_at_signal = $15,
              last_confirmed_at = NOW(),
              confirmation_count = COALESCE(confirmation_count, 1) + 1,
              peak_composite = ${newPeak},
              peak_grade = '${newPeakGrade}',
              composite_history = '${JSON.stringify(newHistory)}'::jsonb,
              momentum_trend = '${trend}',
              expires_at = NOW() + INTERVAL '10 minutes'
              ${contractCols}
            WHERE signal_id = ${row.signal_id}
          `, [
            grade, composite,
            paScore, volScore, newsScore, mktScore, timScore,
            sizePct, Math.round(ACCOUNT_SIZE * sizePct),
            spyPct, qqqPct,
            parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
            signalNote, vix,
            ...contractParams,
          ]);

          written++;
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} PA=${paScore} VOL=${volScore} NEWS=${newsScore} MKT=${mktScore} TIM=${timScore} (CONFIRM #${(row.confirmation_count||1)+1}, peak=${newPeakGrade}/${newPeak}, ${trend}) ${freshness} type=${gate.signalType}`);
        } else {
          // NEW signal
          const contractCols = contract ? `,
            contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
            contract_bid, contract_ask, contract_mid,
            contract_entry_lo, contract_entry_hi,
            contract_delta, contract_iv,
            contract_t1, contract_t2, contract_t3, contract_stop,
            contract_estimated` : '';
          const contractPlaceholders = contract ? ',$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33' : '';
          const contractParams = contract ? [
            contract.symbol, contract.strike, contract.expiry,
            contract.expiry_label, contract.bid, contract.ask,
            contract.mid, contract.entry_lo, contract.entry_hi,
            contract.delta, contract.iv,
            contract.t1, contract.t2, contract.t3, contract.stop,
            contract.estimated || false,
          ] : [];

          await db.query(`
            INSERT INTO lc_v3.signals (
              ticker, direction, grade, status, composite_raw, signal_tier,
              score_price_action, score_volume, score_news, score_market, score_timing,
              position_size_pct, position_size_dollars,
              spy_change_pct, qqq_change_pct, relative_volume, atr_multiple,
              news_headline, vix_at_signal,
              first_seen_at, last_confirmed_at, confirmation_count,
              peak_composite, peak_grade, composite_history, momentum_trend,
              expires_at, created_at
              ${contractCols}
            ) VALUES ($1,$2,$3,'ACTIVE',$4,'primary',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              NOW(), NOW(), 1, $4, $3, '[]'::jsonb, 'NEW',
              NOW() + INTERVAL '10 minutes', NOW()
              ${contractPlaceholders})
          `, [
            ticker, direction, grade, composite,
            paScore, volScore, newsScore, mktScore, timScore,
            sizePct, Math.round(ACCOUNT_SIZE * sizePct),
            spyPct, qqqPct,
            parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
            signalNote, vix,
            ...contractParams,
          ]);

          written++;
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} PA=${paScore} VOL=${volScore} NEWS=${newsScore} MKT=${mktScore} TIM=${timScore} (NEW) ${freshness} type=${gate.signalType} regime=${regime.regime}`);
        }
      }

      if (written > 0) console.log(`[POLL] ${written} signals written/updated`);

      // ── DATA-PROVEN STRATEGY SCANNERS ───────────────────────────────
      if (session === 'REGULAR') {
        try {
          // Build prevCloses from snapshots
          const prevCloses = {};
          for (const [ticker, snap] of Object.entries(allSnaps)) {
            if (snap.prevDailyBar?.c) prevCloses[ticker] = snap.prevDailyBar.c;
          }

          // Build snapshots object for strategy scanners
          const stratSnapshots = {};
          const et3 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const currentMins = et3.getHours() * 60 + et3.getMinutes();
          const windowH = Math.floor(currentMins / 15) * 15;
          const windowKey = `${Math.floor(windowH / 60).toString().padStart(2, '0')}:${(windowH % 60).toString().padStart(2, '0')}`;

          for (const [ticker, snap] of Object.entries(allSnaps)) {
            stratSnapshots[ticker] = {
              open: snap.dailyBar?.o || 0,
              price: snap.latestTrade?.p || 0,
              volume: snap.dailyBar?.v || 0,
              windowKey,
            };
          }

          // Build volumeBaselines from DB
          const blRes = await db.query('SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines');
          const volumeBaselines = {};
          for (const row of blRes.rows) {
            volumeBaselines[`${row.ticker}:${row.window_key}`] = parseFloat(row.avg_volume);
          }

          // Build firstCandles — earliest bar after 9:30 ET today for each ticker
          const firstCandles = {};
          const fcRes = await db.query(`
            SELECT DISTINCT ON (ticker) ticker, open, close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
              AND DATE(ts AT TIME ZONE 'America/New_York') = CURRENT_DATE
              AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60
                + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 575
            ORDER BY ticker, ts
          `);
          for (const row of fcRes.rows) {
            firstCandles[row.ticker] = { open: parseFloat(row.open), close: parseFloat(row.close) };
          }

          // If no bars in DB yet today (bars may not be seeded yet), build from snapshots
          if (Object.keys(firstCandles).length === 0 && currentMins >= 575) {
            for (const [ticker, snap] of Object.entries(allSnaps)) {
              const o = snap.dailyBar?.o;
              const firstMin = snap.prevMinuteBar || snap.minuteBar;
              if (o && firstMin) {
                firstCandles[ticker] = { open: o, close: firstMin.c };
              }
            }
          }

          // Build dailyBars for consecutive-drop scanner (last 5 daily bars per ticker from Alpaca)
          const dailyBars = {};
          try {
            const dbRes = await db.query(`
              SELECT ticker, DATE(ts AT TIME ZONE 'America/New_York') as day,
                     (array_agg(open ORDER BY ts))[1] as o,
                     MAX(high) as h, MIN(low) as l,
                     (array_agg(close ORDER BY ts DESC))[1] as c,
                     SUM(volume) as v
              FROM lc_v3.bars
              WHERE session = 'REGULAR'
                AND ts >= NOW() - INTERVAL '10 days'
              GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
              ORDER BY ticker, day
            `);
            for (const row of dbRes.rows) {
              if (!dailyBars[row.ticker]) dailyBars[row.ticker] = [];
              dailyBars[row.ticker].push({
                day: row.day, o: parseFloat(row.o), h: parseFloat(row.h),
                l: parseFloat(row.l), c: parseFloat(row.c), v: parseInt(row.v),
              });
            }
          } catch (dbErr) {
            console.error('[STRATEGY] Daily bars query error:', dbErr.message);
          }

          // Run all four scanners
          const gapSignals = scanGapReversal(stratSnapshots, prevCloses, firstCandles);
          const capSignals = scanCapitulationBounce(stratSnapshots, prevCloses, volumeBaselines);
          const putSignals = scanVolumeDropPut(stratSnapshots, prevCloses, volumeBaselines);
          const consecSignals = scanConsecutiveDrop(Object.keys(allSnaps), dailyBars);
          const allStratSignals = [...gapSignals, ...capSignals, ...putSignals, ...consecSignals];

          for (const sig of allStratSignals) {
            // Dedup: skip if strategy signal already exists today for this ticker+direction+strategy
            const dupCheck = await db.query(`
              SELECT 1 FROM lc_v3.signals
              WHERE ticker = $1 AND direction = $2
                AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
                AND news_headline LIKE $3
              LIMIT 1
            `, [sig.ticker, sig.direction, `%strategy=${sig.strategy}%`]);
            if (dupCheck.rows.length > 0) continue;

            let compositeRaw = sig.strategy === 'GAP_REVERSAL' ? 85
                             : sig.strategy === 'CAPITULATION_BOUNCE' ? 72
                             : sig.strategy === 'CONSEC_BOUNCE' ? (sig.consecutive_days >= 3 ? 85 : 64)
                             : 57;

            // Pre-earnings filter: reduce confidence if earnings within 5 days
            let nearEarnings = false;
            try {
              const eiRes = await db.query(
                `SELECT earnings_date FROM lc_v3.ticker_intelligence WHERE ticker = $1`,
                [sig.ticker]
              );
              if (eiRes.rows.length > 0 && eiRes.rows[0].earnings_date) {
                const earningsDate = new Date(eiRes.rows[0].earnings_date);
                const daysUntil = Math.round((earningsDate - new Date()) / 86400000);
                if (daysUntil >= 0 && daysUntil <= 5) {
                  compositeRaw -= 15;
                  nearEarnings = true;
                }
              }
            } catch (eiErr) {
              // Non-fatal — skip earnings check
            }

            const signalNote = [
              `strategy=${sig.strategy}`,
              `confidence=${sig.confidence}%`,
              nearEarnings ? 'NEAR_EARNINGS' : null,
              sig.gap_pct != null ? `gap=${sig.gap_pct}%` : null,
              sig.intraday_drop_pct != null ? `drop=${sig.intraday_drop_pct}%` : null,
              sig.volume_ratio != null ? `volRatio=${sig.volume_ratio}x` : null,
              sig.t1_target != null ? `T1=$${sig.t1_target}` : null,
              sig.t2_target != null ? `T2=$${sig.t2_target}` : null,
              sig.stop_price != null ? `stop=$${sig.stop_price}` : null,
              sig.exit_by ? `exitBy=${sig.exit_by}` : null,
              sig.exit_at ? `exitAt=${sig.exit_at}` : null,
              sig.hold ? `hold=${sig.hold}` : null,
              sig.consecutive_days ? `consec=${sig.consecutive_days}d` : null,
              sig.total_drop_pct != null ? `totalDrop=${sig.total_drop_pct}%` : null,
              sig.exit_within_days ? `exitWithin=${sig.exit_within_days}d` : null,
              sig.note || null,
            ].filter(Boolean).join(' · ');

            await db.query(`
              INSERT INTO lc_v3.signals (
                ticker, direction, grade, status, composite_raw, signal_tier,
                price_at_signal, news_headline,
                first_seen_at, last_confirmed_at, confirmation_count,
                peak_composite, peak_grade, composite_history, momentum_trend,
                expires_at, created_at
              ) VALUES ($1,$2,'A','ACTIVE',$3,'primary',$4,$5,
                NOW(), NOW(), 1, $3, 'A', '[]'::jsonb, 'NEW',
                NOW() + INTERVAL '4 hours', NOW())
            `, [sig.ticker, sig.direction, compositeRaw, sig.entry_price, signalNote]);

            console.log(`[STRATEGY] ${sig.ticker} ${sig.direction} ${sig.strategy} ${sig.confidence}%`);
          }

          if (allStratSignals.length > 0) {
            console.log(`[STRATEGY] ${allStratSignals.length} strategy signals fired`);
          }
        } catch (stratErr) {
          console.error('[STRATEGY] Scanner error:', stratErr.message);
        }
      }

      // Post-signal monitoring — check active signals for breakdowns
      await monitorActiveSignals(alpacaHdrs, dataUrl, profiles);

      // ── AUTO-STATUS: expire, miss, and invalidate signals ────────────
      try {
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const etMins = et.getHours() * 60 + et.getMinutes();

        // 1) GAP_REVERSAL past 9:45am with no human action → EXPIRED
        if (etMins >= 585) { // 9:45 ET
          const gapExpired = await db.query(`
            UPDATE lc_v3.signals SET status = 'EXPIRED',
              human_notes = COALESCE(human_notes, '') || ' | AUTO: WINDOW_CLOSED'
            WHERE status = 'ACTIVE'
              AND human_taken IS NULL
              AND news_headline LIKE '%strategy=GAP_REVERSAL%'
              AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
            RETURNING ticker
          `);
          for (const r of gapExpired.rows) {
            console.log(`[AUTO] ${r.ticker} GAP_REVERSAL → EXPIRED (window closed)`);
          }
        }

        // 2) Any ACTIVE signal with no human action and >15 min old → MISSED
        const missed = await db.query(`
          UPDATE lc_v3.signals SET status = 'MISSED',
            human_notes = COALESCE(human_notes, '') || ' | AUTO: NO_ACTION_15MIN'
          WHERE status = 'ACTIVE'
            AND human_taken IS NULL
            AND created_at < NOW() - INTERVAL '15 minutes'
            AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
          RETURNING ticker
        `);
        for (const r of missed.rows) {
          console.log(`[AUTO] ${r.ticker} → MISSED (no action 15min)`);
        }

        // 3) GAP_REVERSAL where stock dropped below stop → INVALID
        const gapSignals = await db.query(`
          SELECT signal_id, ticker, news_headline
          FROM lc_v3.signals
          WHERE status IN ('ACTIVE', 'WEAKENING')
            AND news_headline LIKE '%strategy=GAP_REVERSAL%'
            AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
        `);
        for (const sig of gapSignals.rows) {
          const stopMatch = (sig.news_headline || '').match(/stop=\$?([\d.]+)/);
          if (!stopMatch) continue;
          const stopPrice = parseFloat(stopMatch[1]);
          const snap = allSnaps[sig.ticker];
          const curPrice = snap?.latestTrade?.p || 0;
          if (curPrice > 0 && curPrice < stopPrice) {
            await db.query(`
              UPDATE lc_v3.signals SET status = 'INVALID',
                human_notes = COALESCE(human_notes, '') || ' | AUTO: CONDITIONS_CHANGED (price $' || $2 || ' < stop $' || $3 || ')'
              WHERE signal_id = $1
            `, [sig.signal_id, curPrice.toFixed(2), stopPrice.toFixed(2)]);
            console.log(`[AUTO] ${sig.ticker} GAP_REVERSAL → INVALID (price $${curPrice.toFixed(2)} < stop $${stopPrice.toFixed(2)})`);
          }
        }
      } catch (autoErr) {
        console.error('[AUTO] Status update error:', autoErr.message);
      }

    } catch(err) {
      console.error('[POLL] Error:', err.message);
    }
  }

  setTimeout(poll, 5000);
  setInterval(poll, 60000);
  console.log('[LC v3] REST poller started — scoring every 60s');
}

// ── POST-SIGNAL MONITORING ────────────────────────────────────────────────────
async function monitorActiveSignals(alpacaHdrs, dataUrl, profiles) {
  try {
    const { monitorSignal } = await import('./src/scoring/intelligence.js');

    // Get all ACTIVE and WEAKENING signals from today
    const res = await db.query(`
      SELECT signal_id, ticker, direction, atr_multiple, grade
      FROM lc_v3.signals
      WHERE status IN ('ACTIVE','WEAKENING')
      AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
      AND expires_at > NOW() - INTERVAL '30 minutes'
    `);

    if (res.rows.length === 0) return;

    // Fetch current snapshots for active signal tickers
    const tickers = [...new Set(res.rows.map(r => r.ticker))];
    const snapRes = await axios.get(`${dataUrl}/v2/stocks/snapshots`, {
      headers: alpacaHdrs,
      params: { symbols: tickers.join(','), feed: ALPACA_FEED },
      timeout: 8000,
    });
    const snaps = snapRes.data || {};

    for (const signal of res.rows) {
      const snap = snaps[signal.ticker];
      if (!snap) continue;

      const price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
      const vwap  = snap.minuteBar?.vw || price;
      const atr   = parseFloat(profiles[signal.ticker]?.atr_20d || 0.025);
      const bars  = [snap.prevMinuteBar, snap.minuteBar].filter(Boolean)
        .map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }));

      const mockState = { close: price, vwap, bars };
      const result    = monitorSignal(signal, mockState, atr);

      if (result.status !== 'ACTIVE' && result.status !== signal.status) {
        await db.query(`
          UPDATE lc_v3.signals
          SET status = $1, human_notes = COALESCE(human_notes || ' | ', '') || $2
          WHERE signal_id = $3
        `, [result.status, result.note, signal.signal_id]);

        console.log(`[MONITOR] ${signal.ticker} ${signal.direction} → ${result.status}: ${result.note}`);
      }

      // Refresh contract prices every cycle for active signals
      try {
        const contract = await selectOptionsContract(signal.ticker, signal.direction, signal.grade, price, atr);
        if (contract) {
          await db.query(`
            UPDATE lc_v3.signals SET
              contract_symbol = $1, contract_strike = $2, contract_expiry = $3,
              contract_expiry_label = $4, contract_bid = $5, contract_ask = $6,
              contract_mid = $7, contract_entry_lo = $8, contract_entry_hi = $9,
              contract_delta = $10, contract_iv = $11,
              contract_t1 = $12, contract_t2 = $13, contract_t3 = $14, contract_stop = $15,
              contract_estimated = $16
            WHERE signal_id = $17
          `, [
            contract.symbol, contract.strike, contract.expiry,
            contract.expiry_label, contract.bid, contract.ask,
            contract.mid, contract.entry_lo, contract.entry_hi,
            contract.delta, contract.iv,
            contract.t1, contract.t2, contract.t3, contract.stop,
            contract.estimated || false,
            signal.signal_id,
          ]);
        }
      } catch (ce) {
        // Don't log every cycle — only on first failure
      }
    }
  } catch(err) {
    console.error('[MONITOR] Error:', err.message);
  }
}

// ── CONTRACT BACKFILL ──────────────────────────────────────────────────────
async function backfillContracts() {
  try {
    const res = await db.query(`
      SELECT signal_id, ticker, direction, grade, composite_raw
      FROM lc_v3.signals
      WHERE contract_mid IS NULL
        AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
        AND status NOT IN ('TAKEN','SKIPPED')
    `);
    if (res.rows.length === 0) return;
    console.log(`[BACKFILL] ${res.rows.length} signals need contracts`);

    for (const row of res.rows) {
      try {
        const contract = await selectOptionsContract(row.ticker, row.direction, row.grade, 0, 0.025);
        if (!contract) continue;
        await db.query(`
          UPDATE lc_v3.signals SET
            contract_symbol = $1, contract_strike = $2, contract_expiry = $3,
            contract_expiry_label = $4, contract_bid = $5, contract_ask = $6,
            contract_mid = $7, contract_entry_lo = $8, contract_entry_hi = $9,
            contract_delta = $10, contract_iv = $11,
            contract_t1 = $12, contract_t2 = $13, contract_t3 = $14, contract_stop = $15,
            contract_estimated = $16
          WHERE signal_id = $17
        `, [
          contract.symbol, contract.strike, contract.expiry,
          contract.expiry_label, contract.bid, contract.ask,
          contract.mid, contract.entry_lo, contract.entry_hi,
          contract.delta, contract.iv,
          contract.t1, contract.t2, contract.t3, contract.stop,
          contract.estimated || false,
          row.signal_id,
        ]);
        console.log(`[BACKFILL] ${row.ticker} ${row.direction} → ${contract.symbol}`);
      } catch (e) {
        console.error(`[BACKFILL] ${row.ticker}: ${e.message}`);
      }
    }
  } catch (err) {
    console.error('[BACKFILL] Error:', err.message);
  }
}

// Run backfill 15s after startup, then every 5 min
setTimeout(backfillContracts, 15000);
setInterval(backfillContracts, 300000);
