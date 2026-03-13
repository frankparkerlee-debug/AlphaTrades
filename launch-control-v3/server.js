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
        signal_id, ticker, direction, grade, status,
        composite_raw, signal_tier,
        score_price_action, score_volume, score_news,
        score_market, score_timing,
        position_size_pct, position_size_dollars,
        confluence_score, news_headline,
        leader_ticker, propagation_lag_min,
        spy_change_pct, qqq_change_pct, sector_change_pct,
        relative_volume, atr_multiple,
        human_taken, human_pnl_pct, human_entry_price, human_exit_price, human_notes,
        contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
        contract_bid, contract_ask, contract_mid,
        contract_entry_lo, contract_entry_hi,
        contract_delta, contract_iv,
        contract_t1, contract_t2, contract_t3, contract_stop,
        contract_estimated,
        first_seen_at, last_confirmed_at, confirmation_count,
        peak_composite, peak_grade, composite_history, momentum_trend,
        expires_at, created_at
      FROM lc_v3.signals
      WHERE DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
      ORDER BY created_at DESC
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
      'SELECT results, run_date, created_at FROM lc_v3.backtest_results ORDER BY run_date DESC LIMIT 1'
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

// Backtest status
let backtestError = null;
app.get('/api/backtest/status', (req, res) => {
  res.json({ running: backtestRunning, error: backtestError });
});

async function executeBacktest() {
  backtestError = null;
  try {
    const { runBacktest } = await import('./scripts/backtest/run.js');

    // Last 20 trading days
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30); // ~30 calendar days ≈ 20 trading days
    const startDate = start.toISOString().split('T')[0];
    const endDate   = end.toISOString().split('T')[0];

    console.log(`[BACKTEST] Starting: ${startDate} → ${endDate}`);
    const results = await runBacktest(startDate, endDate, parseFloat(process.env.ACCOUNT_SIZE || '7500'));

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
    backtestError = err.message;
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
            contract_symbol = $15, contract_strike = $16, contract_expiry = $17,
            contract_expiry_label = $18, contract_bid = $19, contract_ask = $20,
            contract_mid = $21, contract_entry_lo = $22, contract_entry_hi = $23,
            contract_delta = $24, contract_iv = $25,
            contract_t1 = $26, contract_t2 = $27, contract_t3 = $28, contract_stop = $29,
            contract_estimated = $30` : '';
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
              news_headline = $14,
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
            signalNote,
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
          const contractPlaceholders = contract ? ',$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32' : '';
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
              news_headline,
              first_seen_at, last_confirmed_at, confirmation_count,
              peak_composite, peak_grade, composite_history, momentum_trend,
              expires_at, created_at
              ${contractCols}
            ) VALUES ($1,$2,$3,'ACTIVE',$4,'primary',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
              NOW(), NOW(), 1, $4, $3, '[]'::jsonb, 'NEW',
              NOW() + INTERVAL '10 minutes', NOW()
              ${contractPlaceholders})
          `, [
            ticker, direction, grade, composite,
            paScore, volScore, newsScore, mktScore, timScore,
            sizePct, Math.round(ACCOUNT_SIZE * sizePct),
            spyPct, qqqPct,
            parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
            signalNote,
            ...contractParams,
          ]);

          written++;
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} PA=${paScore} VOL=${volScore} NEWS=${newsScore} MKT=${mktScore} TIM=${timScore} (NEW) ${freshness} type=${gate.signalType} regime=${regime.regime}`);
        }
      }

      if (written > 0) console.log(`[POLL] ${written} signals written/updated`);

      // Post-signal monitoring — check active signals for breakdowns
      await monitorActiveSignals(alpacaHdrs, dataUrl, profiles);

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
