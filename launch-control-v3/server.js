import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import cron from 'node-cron';
import { createServer } from 'http';
import { selectOptionsContract } from './src/options/contract-selector.js';

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

    res.json({ session, propagation: prop, streams, regime: regime.regime, regimeNote: regime.regimeNote, time: now.toISOString() });
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

// Backtest status
app.get('/api/backtest/status', (req, res) => {
  res.json({ running: backtestRunning });
});

async function executeBacktest() {
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
    console.error('[BACKTEST] Failed:', err.message);
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

      // Classify market regime once for all signals this cycle
      const { classifyRegime } = await import('./src/scoring/intelligence.js');
      const regime = classifyRegime({ spyPct, qqqPct }, vix, spyBars);

      if (regime.regimeNote) {
        console.log(`[REGIME] ${regime.regime} — ${regime.regimeNote}`);
      }
      global.currentRegime = regime;

      console.log(`[POLL] ${Object.keys(allSnaps).length} snaps SPY=${(spyPct*100).toFixed(2)}% QQQ=${(qqqPct*100).toFixed(2)}% VIX=${vix} REGIME=${regime.regime}`);

      // Import intelligence functions
      const { analyzeLevels, analyzeTrend, gateSignal } = await import('./src/scoring/intelligence.js');

      let written = 0;
      const today = new Date().toISOString().split('T')[0];

      for (const [ticker, snap] of Object.entries(allSnaps)) {
        const price     = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
        const prevClose = snap.prevDailyBar?.c || 0;
        const openPrice = snap.dailyBar?.o || price;
        if (!price || !prevClose) continue;

        const latestBar = snap.minuteBar;
        const prevBar   = snap.prevMinuteBar;
        if (!latestBar || !prevBar) continue;

        const recentMove = latestBar.c > 0 && prevBar.c > 0
          ? (latestBar.c - prevBar.c) / prevBar.c
          : 0;

        const direction  = recentMove >= 0 ? 'CALL' : 'PUT';
        const mult       = direction === 'CALL' ? 1 : -1;
        const absRecent  = Math.abs(recentMove);
        const moveFromOpen = openPrice > 0 ? ((price - openPrice) / openPrice) * mult : 0;
        const atr        = parseFloat(profiles[ticker]?.atr_20d || 0.025);
        const moveInATRs = atr > 0 ? Math.abs(moveFromOpen) / atr : 0;

        if (absRecent < atr * 0.1) continue;

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

        // Freshness classification
        const freshness = moveInATRs < 0.5 ? 'FRESH'
                        : moveInATRs < 1.0 ? 'DEVELOPING'
                        : moveInATRs < 1.5 ? 'EXTENDED'
                        : moveInATRs < 2.0 ? 'LATE'
                        : 'EXHAUSTED';

        // Run intelligence analysis
        const levels = analyzeLevels(mockState, atr);
        const trend  = analyzeTrend(syntheticBars, direction); // limited without full bar history

        // Gate signal through full intelligence check
        const gate = gateSignal(direction, trend, levels, regime, freshness);

        if (!gate.allow) {
          console.log(`[GATE] ${ticker} ${direction} rejected — ${gate.reason}`);
          continue;
        }

        // Scoring
        const freshnessPenalty = moveInATRs > 1.5 ? 0.5 : moveInATRs > 1.0 ? 0.75 : 1.0;
        const atrMult  = atr > 0 ? absRecent / atr : 0;
        const paScore  = Math.min(35, Math.round(atrMult * 20 * freshnessPenalty));

        const avgDayVol = snap.dailyBar?.v || 0;
        const minsOpen  = Math.max(1, (() => {
          const et = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
          return Math.max(1, (et.getHours() * 60 + et.getMinutes()) - 570);
        })());
        const avgMinVol = avgDayVol / minsOpen;
        const curMinVol = latestBar.v || 0;
        const relVol    = avgMinVol > 0 ? curMinVol / avgMinVol : 1;
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

        const composite = paScore + volScore + mktScore + timScore;

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
          `Risk:${freshness === 'FRESH' ? 'LOW' : freshness === 'DEVELOPING' ? 'MOD' : 'HIGH'}`,
          `Type:${gate.signalType || 'NEUTRAL'}`,
          `From Open:${(moveFromOpen*100).toFixed(2)}%`,
          regime.regimeNote ? `Regime:${regime.regime}` : null,
          levels.nearestAbove ? `ResAt:$${levels.nearestAbove.price.toFixed(2)}(${levels.nearestAbove.name})` : null,
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
            contract_symbol = $14, contract_strike = $15, contract_expiry = $16,
            contract_expiry_label = $17, contract_bid = $18, contract_ask = $19,
            contract_mid = $20, contract_entry_lo = $21, contract_entry_hi = $22,
            contract_delta = $23, contract_iv = $24,
            contract_t1 = $25, contract_t2 = $26, contract_t3 = $27, contract_stop = $28,
            contract_estimated = $29` : '';
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
              score_price_action = $3, score_volume = $4, score_market = $5, score_timing = $6,
              position_size_pct = $7, position_size_dollars = $8,
              spy_change_pct = $9, qqq_change_pct = $10,
              relative_volume = $11, atr_multiple = $12,
              news_headline = $13,
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
            paScore, volScore, mktScore, timScore,
            sizePct, Math.round(ACCOUNT_SIZE * sizePct),
            spyPct, qqqPct,
            parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
            signalNote,
            ...contractParams,
          ]);

          written++;
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} (CONFIRM #${(row.confirmation_count||1)+1}, peak=${newPeakGrade}/${newPeak}, ${trend}) ${freshness} type=${gate.signalType}`);
        } else {
          // NEW signal
          const contractCols = contract ? `,
            contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
            contract_bid, contract_ask, contract_mid,
            contract_entry_lo, contract_entry_hi,
            contract_delta, contract_iv,
            contract_t1, contract_t2, contract_t3, contract_stop,
            contract_estimated` : '';
          const contractPlaceholders = contract ? ',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31' : '';
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
            ) VALUES ($1,$2,$3,'ACTIVE',$4,'primary',$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,
              NOW(), NOW(), 1, $4, $3, '[]'::jsonb, 'NEW',
              NOW() + INTERVAL '10 minutes', NOW()
              ${contractPlaceholders})
          `, [
            ticker, direction, grade, composite,
            paScore, volScore, mktScore, timScore,
            sizePct, Math.round(ACCOUNT_SIZE * sizePct),
            spyPct, qqqPct,
            parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
            signalNote,
            ...contractParams,
          ]);

          written++;
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} (NEW) ${freshness} type=${gate.signalType} regime=${regime.regime}`);
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
