import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import cron from 'node-cron';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { selectOptionsContract, getOptionsVolume, fetchContractQuote } from './src/options/contract-selector.js';
import { getNewsEvents, getTickerState } from './src/data/state.js';
import { computeNewsScore } from './src/scoring/news.js';
import { runMultiStrategyBacktest } from './scripts/backtest/strategy-runner.js';
import { computeCorrelationMatrix, portfolioMetrics, diversificationBenefit, optimalWeights } from './scripts/backtest/cross-strategy.js';
import { kellyPerStrategy, targetSizing } from './scripts/backtest/position-sizing.js';
import { runRealityChecks } from './scripts/backtest/reality-checks.js';
// Kept scanners (map to 7 research-backed strategies, will be rewritten after backtest validation)
import { scanGapReversal } from './src/strategies/gap-reversal.js';
import { scanGapUpReversal } from './src/strategies/gap-up-reversal.js';
import { scanCapitulationBounce } from './src/strategies/capitulation-bounce.js';
import { scanSectorRotationBounce } from './src/strategies/sector-rotation-bounce.js';
import { scanOpeningRangeBreakout } from './src/strategies/opening-range-breakout.js';
import { scanVwapReclaim } from './src/strategies/vwap-reclaim.js';
import { scanPowerHour } from './src/strategies/power-hour.js';
import { scanPostMacro } from './src/strategies/post-macro.js';
import { scanFailedBreakdown } from './src/strategies/failed-breakdown.js';
import { scoreConvictionSetup } from './src/strategies/conviction-scorer.js';
import { getRecentFlow } from './src/data/alpaca-streams.js';
import { monitorOpenPositions } from './src/jobs/options-monitor.js';
import { scoreContinuation } from './src/jobs/continuation-scorer.js';
import { startAutoTrader, stopAutoTrader, getAutoTraderStatus } from './src/execution/auto-trader.js';
import { manualHalt, resume as resumeTrading, getDailyState } from './src/execution/risk-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── MACRO EVENT CALENDAR 2026 ─────────────────────────────────────────────────
const MACRO_EVENTS_2026 = [
  // FOMC decisions
  { date: '2026-03-18', event: 'FOMC' },
  { date: '2026-05-07', event: 'FOMC' },
  { date: '2026-06-18', event: 'FOMC' },
  { date: '2026-07-30', event: 'FOMC' },
  { date: '2026-09-17', event: 'FOMC' },
  { date: '2026-11-05', event: 'FOMC' },
  { date: '2026-12-17', event: 'FOMC' },
  // CPI (~10th of each month)
  { date: '2026-01-14', event: 'CPI' }, { date: '2026-02-12', event: 'CPI' },
  { date: '2026-03-11', event: 'CPI' }, { date: '2026-04-10', event: 'CPI' },
  { date: '2026-05-12', event: 'CPI' }, { date: '2026-06-10', event: 'CPI' },
  { date: '2026-07-14', event: 'CPI' }, { date: '2026-08-12', event: 'CPI' },
  { date: '2026-09-10', event: 'CPI' }, { date: '2026-10-13', event: 'CPI' },
  { date: '2026-11-10', event: 'CPI' }, { date: '2026-12-10', event: 'CPI' },
  // NFP (first Friday of each month)
  { date: '2026-01-02', event: 'NFP' }, { date: '2026-02-06', event: 'NFP' },
  { date: '2026-03-06', event: 'NFP' }, { date: '2026-04-03', event: 'NFP' },
  { date: '2026-05-01', event: 'NFP' }, { date: '2026-06-05', event: 'NFP' },
  { date: '2026-07-02', event: 'NFP' }, { date: '2026-08-07', event: 'NFP' },
  { date: '2026-09-04', event: 'NFP' }, { date: '2026-10-02', event: 'NFP' },
  { date: '2026-11-06', event: 'NFP' }, { date: '2026-12-04', event: 'NFP' },
  // PPI (~11th of each month)
  { date: '2026-01-15', event: 'PPI' }, { date: '2026-02-13', event: 'PPI' },
  { date: '2026-03-12', event: 'PPI' }, { date: '2026-04-11', event: 'PPI' },
  { date: '2026-05-13', event: 'PPI' }, { date: '2026-06-11', event: 'PPI' },
  { date: '2026-07-15', event: 'PPI' }, { date: '2026-08-13', event: 'PPI' },
  { date: '2026-09-11', event: 'PPI' }, { date: '2026-10-14', event: 'PPI' },
  { date: '2026-11-12', event: 'PPI' }, { date: '2026-12-11', event: 'PPI' },
];

function isHighImpactMacroDay() {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayStr = `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, '0')}-${String(etNow.getDate()).padStart(2, '0')}`;
  const matches = MACRO_EVENTS_2026.filter(e => e.date === todayStr);
  if (matches.length === 0) return null;
  return matches.map(e => e.event).join('+');
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── MM ENGINE (password-protected, registered BEFORE express.static) ────────

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function mmAuth(req, res, next) {
  const pw = process.env.MM_PASSWORD;
  if (!pw) return res.status(503).json({ error: 'MM_PASSWORD not configured' });
  const cookies = parseCookies(req);
  if (cookies.mm_session === pw) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

const MM_LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Launch Control -- MM Engine</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root { --bg0:#060a0f; --bg1:#0b1118; --border:#1e2d3d; --amber:#f59e0b; --green:#10b981; --red:#ef4444; --text1:#e2e8f0; --text3:#6b7f94; --mono:'IBM Plex Mono',monospace; --sans:'IBM Plex Sans',sans-serif; }
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg0);color:var(--text1);font-family:var(--sans);font-size:13px}
body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.025) 2px,rgba(0,0,0,0.025) 4px)}
.login-box{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg1);border:1px solid var(--border);border-radius:4px;padding:32px;width:340px;text-align:center}
.login-title{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:2px;color:var(--text3);margin-bottom:20px}
.login-input{width:100%;background:var(--bg0);border:1px solid var(--border);border-radius:3px;padding:10px 12px;color:var(--text1);font-family:var(--mono);font-size:13px;margin-bottom:12px;outline:none}
.login-input:focus{border-color:var(--amber)}
.login-btn{width:100%;background:rgba(245,158,11,0.1);border:1px solid var(--amber);border-radius:3px;padding:10px;color:var(--amber);font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:1px;cursor:pointer;text-transform:uppercase}
.login-btn:hover{background:rgba(245,158,11,0.2)}
.login-err{font-family:var(--mono);font-size:10px;color:var(--red);margin-top:10px;display:none}
.login-warn{font-family:var(--mono);font-size:10px;color:var(--amber);margin-top:14px}
</style></head><body>
<div class="login-box">
  <div class="login-title">MM ENGINE ACCESS</div>
  <form method="POST" action="/mm/login">
    <input class="login-input" type="password" name="password" placeholder="Password" autofocus>
    <button class="login-btn" type="submit">AUTHENTICATE</button>
  </form>
  <div class="login-err" id="err">INVALID PASSWORD</div>
</div>
<script>if(location.search.includes('invalid'))document.getElementById('err').style.display='block';</script>
</body></html>`;

const MM_NOPASS_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Launch Control -- MM Engine</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root { --bg0:#060a0f; --bg1:#0b1118; --border:#1e2d3d; --amber:#f59e0b; --text1:#e2e8f0; --text3:#6b7f94; --mono:'IBM Plex Mono',monospace; --sans:'IBM Plex Sans',sans-serif; }
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg0);color:var(--text1);font-family:var(--sans);font-size:13px}
body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.025) 2px,rgba(0,0,0,0.025) 4px)}
.msg-box{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg1);border:1px solid var(--border);border-radius:4px;padding:32px;width:400px;text-align:center}
.msg-title{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:2px;color:var(--amber);margin-bottom:16px}
.msg-body{font-family:var(--mono);font-size:11px;color:var(--text3);line-height:1.6}
code{background:rgba(245,158,11,0.1);color:var(--amber);padding:2px 6px;border-radius:3px;font-size:11px}
</style></head><body>
<div class="msg-box">
  <div class="msg-title">CONFIGURATION REQUIRED</div>
  <div class="msg-body">The <code>MM_PASSWORD</code> environment variable is not set.<br><br>Add it in the Render dashboard under Environment Variables, then redeploy.</div>
</div>
</body></html>`;

app.get('/mm', (req, res) => {
  const pw = process.env.MM_PASSWORD;
  if (!pw) return res.send(MM_NOPASS_HTML);
  const cookies = parseCookies(req);
  if (cookies.mm_session === pw) {
    return res.sendFile(join(__dirname, 'templates', 'mm.html'));
  }
  res.send(MM_LOGIN_HTML);
});

app.post('/mm/login', (req, res) => {
  const pw = process.env.MM_PASSWORD;
  if (!pw) return res.send(MM_NOPASS_HTML);
  if (req.body.password === pw) {
    res.setHeader('Set-Cookie', `mm_session=${encodeURIComponent(pw)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.redirect('/mm');
  }
  res.redirect('/mm?invalid=1');
});

// MM data directory — defaults to cwd, override with MM_DATA_DIR
const mmDataDir = process.env.MM_DATA_DIR || process.cwd();

function todayDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
}

function readHeartbeat() {
  const p = join(mmDataDir, 'data', 'heartbeat.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function readFillsToday() {
  const dateStr = todayDateStr();
  const jsonlPath = join(mmDataDir, 'data', `fills_${dateStr}.jsonl`);
  if (existsSync(jsonlPath)) {
    try {
      const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.map(l => JSON.parse(l));
    } catch { /* fall through to CSV */ }
  }
  const csvPath = join(mmDataDir, 'logs', `fills_${dateStr}.csv`);
  if (!existsSync(csvPath)) return [];
  try {
    const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
      return obj;
    });
  } catch { return []; }
}

app.get('/api/mm/status', mmAuth, (req, res) => {
  const hb = readHeartbeat();
  const fills = readFillsToday();
  const totalFills = fills.length;
  const wins = fills.filter(f => f.win === true || f.win === 'True' || f.win === '1').length;
  const adverse = fills.filter(f => f.adverse_selection === true || f.adverse_selection === 'True' || f.adverse_selection === '1').length;
  const dailyPnl = fills.reduce((sum, f) => sum + (parseFloat(f.net_pnl) || 0), 0);
  res.json({
    daily_pnl: +dailyPnl.toFixed(2),
    total_fills: totalFills,
    win_rate: totalFills > 0 ? Math.round(wins / totalFills * 100) : null,
    adverse_rate: totalFills > 0 ? Math.round(adverse / totalFills * 100) : null,
    open_positions: hb?.positions?.length || 0,
    kill_switch: hb ? 'OK' : null,
    pdt_status: null,
    rate_blocked: null,
    data_fresh: hb ? true : null,
    heartbeat_ts: hb?.timestamp || null,
    engine_pid: hb?.engine_pid || null,
  });
});

app.get('/api/mm/fills', mmAuth, (req, res) => {
  res.json(readFillsToday());
});

app.get('/api/mm/positions', mmAuth, (req, res) => {
  const hb = readHeartbeat();
  res.json(hb?.positions || []);
});

// Static files AFTER /mm routes so they can't be intercepted
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
        s.confluence_score, s.news_headline, s.price_at_signal,
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
        s.options_delta, s.options_gamma, s.options_theta, s.options_vega,
        s.options_iv, s.options_bid, s.options_ask, s.options_mid,
        s.options_volume, s.options_open_interest,
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
      strategy:          ((s.news_headline || '').match(/strategy=(\w+)/) || [])[1] || null,
      paper_only:        s.status === 'PAPER_ONLY',
      news_warning:      (s.news_headline || '').includes('news_warning=true'),
      news_text:         ((s.news_headline || '').match(/news_text=(.+?)(?:\s·|$)/) || [])[1] || null,
      // Locked targets parsed from signal headline (set once at insertion, never updated)
      locked_entry:      s.price_at_signal != null ? Number(s.price_at_signal) : null,
      locked_t1:         ((s.news_headline || '').match(/T1=\$([0-9.]+)/) || [])[1] ? Number(((s.news_headline || '').match(/T1=\$([0-9.]+)/) || [])[1]) : null,
      locked_t2:         ((s.news_headline || '').match(/T2=\$([0-9.]+)/) || [])[1] ? Number(((s.news_headline || '').match(/T2=\$([0-9.]+)/) || [])[1]) : null,
      locked_stop:       ((s.news_headline || '').match(/stop=\$([0-9.]+)/) || [])[1] ? Number(((s.news_headline || '').match(/stop=\$([0-9.]+)/) || [])[1]) : null,
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
    const macroEvent = isHighImpactMacroDay();
    res.json({ session, propagation: prop, streams, regime: regime.regime, regimeNote: regime.regimeNote, macro_event_today: macroEvent, market: mktCtx, time: now.toISOString() });
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

// Open paper trades with continuation status
app.get('/api/paper-trades/open', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT paper_id, signal_id, ticker, direction, strategy, grade,
             entry_time, entry_stock_price, entry_contract_symbol, entry_contract_mid,
             current_stock_price, current_contract_est, unrealized_pnl_pct,
             peak_pnl_pct, max_adverse_pnl_pct, status,
             hit_t1, hit_t2, hit_stop,
             current_delta, current_iv, current_spread, cumulative_theta,
             continuation_action, continuation_reason, continuation_details,
             continuation_scored_at, greeks_updated_at, last_updated,
             auto_traded
      FROM lc_v3.paper_trades
      WHERE status IN ('OPEN', 'WEAKENING')
      ORDER BY entry_time DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// Close a paper trade — now calculates final P&L and outcome
app.post('/api/paper-trades/close', async (req, res) => {
  try {
    const { paper_id, exit_price } = req.body;

    // Fetch current trade data to compute P&L
    const trade = await db.query(
      'SELECT entry_stock_price, current_stock_price, unrealized_pnl_pct, direction FROM lc_v3.paper_trades WHERE paper_id = $1',
      [paper_id]
    );

    let finalPnl = null;
    let exitStockPrice = exit_price || null;
    let outcome = null;

    if (trade.rows.length > 0) {
      const t = trade.rows[0];
      // Use provided exit price, or current price, or unrealized P&L
      if (!exitStockPrice && t.current_stock_price) {
        exitStockPrice = parseFloat(t.current_stock_price);
      }

      if (t.unrealized_pnl_pct !== null) {
        finalPnl = parseFloat(t.unrealized_pnl_pct);
      } else if (exitStockPrice && t.entry_stock_price) {
        const entry = parseFloat(t.entry_stock_price);
        const move = (exitStockPrice - entry) / entry;
        // Approximate option P&L from underlying move (rough 3x leverage)
        finalPnl = parseFloat((move * (t.direction === 'CALL' ? 3 : -3) * 100).toFixed(2));
      }

      if (finalPnl !== null) {
        outcome = finalPnl > 1 ? 'WIN' : finalPnl < -1 ? 'LOSS' : 'FLAT';
      }
    }

    await db.query(`
      UPDATE lc_v3.paper_trades SET
        status = 'CLOSED',
        exit_time = NOW(),
        exit_stock_price = COALESCE($2, current_stock_price),
        final_pnl_pct = $3,
        outcome = $4,
        exit_reason = 'MANUAL_CLOSE'
      WHERE paper_id = $1
    `, [paper_id, exitStockPrice, finalPnl, outcome]);
    res.json({ ok: true, finalPnl, outcome });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Paper trade stats — accepts ?auto_traded=true or false
app.get('/api/paper/stats', async (req, res) => {
  try {
    const autoFilter = req.query.auto_traded;
    let where = `WHERE status = 'CLOSED' AND final_pnl_pct IS NOT NULL`;
    const params = [];
    if (autoFilter === 'true') { where += ` AND auto_traded = TRUE`; }
    else if (autoFilter === 'false') { where += ` AND (auto_traded = FALSE OR auto_traded IS NULL)`; }

    const result = await db.query(`
      SELECT
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS') as losses,
        ROUND(AVG(final_pnl_pct)::numeric, 2) as avg_pnl,
        ROUND(MAX(final_pnl_pct)::numeric, 2) as best_trade,
        ROUND(MIN(final_pnl_pct)::numeric, 2) as worst_trade,
        ROUND((COUNT(*) FILTER (WHERE outcome = 'WIN')::numeric / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as win_rate
      FROM lc_v3.paper_trades
      ${where}
    `, params);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.json({ error: err.message });
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
app.get('/api/flow/:ticker', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT ticker, ts, buy_volume, sell_volume, total_trades, buy_ratio, delta
      FROM lc_v3.bar_flow
      WHERE ticker = $1 AND ts >= NOW() - INTERVAL '60 minutes'
      ORDER BY ts DESC
    `, [req.params.ticker.toUpperCase()]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Debug: check ticker subscription and data availability
app.get('/api/debug/ticker-check/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const [conv, prof, volBl, barCount, recentBars] = await Promise.all([
      db.query('SELECT ticker FROM lc_v3.conviction_universe WHERE ticker = $1', [ticker]),
      db.query('SELECT ticker, atr_20d FROM lc_v3.equity_profiles WHERE ticker = $1', [ticker]),
      db.query('SELECT COUNT(*)::int as count FROM lc_v3.volume_baselines WHERE ticker = $1', [ticker]),
      db.query('SELECT COUNT(*)::int as count FROM lc_v3.bars WHERE ticker = $1 AND ts >= NOW() - INTERVAL \'3 days\'', [ticker]),
      db.query(`SELECT DATE(ts AT TIME ZONE 'America/New_York') as day, COUNT(*)::int as bars,
                MIN(ts) as first_bar, MAX(ts) as last_bar
                FROM lc_v3.bars WHERE ticker = $1 AND ts >= NOW() - INTERVAL '10 days'
                GROUP BY DATE(ts AT TIME ZONE 'America/New_York') ORDER BY day DESC LIMIT 5`, [ticker]),
    ]);
    res.json({
      ticker,
      in_conviction_universe: conv.rows.length > 0,
      in_equity_profiles: prof.rows.length > 0,
      equity_profile: prof.rows[0] || null,
      volume_baselines_count: volBl.rows[0]?.count || 0,
      bars_last_3_days: barCount.rows[0]?.count || 0,
      recent_bar_days: recentBars.rows,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Debug: paper trade stats
app.get('/api/debug/paper-stats', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE auto_traded = true)::int as auto_traded,
        COUNT(*) FILTER (WHERE auto_traded = false OR auto_traded IS NULL)::int as manual,
        COUNT(*) FILTER (WHERE status = 'OPEN')::int as open_count,
        COUNT(*) FILTER (WHERE status = 'CLOSED')::int as closed_count,
        COUNT(*) FILTER (WHERE outcome = 'WIN')::int as wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')::int as losses
      FROM lc_v3.paper_trades
    `);
    res.json(r.rows[0]);
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
    // analyzeMomentum decommissioned — momentum scoring removed
    const { shouldSkipOnFreshness } = await import('./src/scoring/momentum.js');
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

    // PA score — analyzeMomentum decommissioned, inline fallback only
    let paScore, freshness;
    freshness = moveInATRs < 0.5 ? 'FRESH'
              : moveInATRs < 1.0 ? 'DEVELOPING'
              : moveInATRs < 1.5 ? 'EXTENDED'
              : moveInATRs < 2.0 ? 'LATE'
              : 'EXHAUSTED';
    const freshnessPenalty = moveInATRs > 1.5 ? 0.5 : moveInATRs > 1.0 ? 0.75 : 1.0;
    paScore = Math.min(35, Math.round(moveInATRs * 35 * freshnessPenalty));

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
// Serve consolidated validation dashboard
app.get('/validation', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'validation.html'));
});

// Get full validation results (MC + walk-forward + regime + sensitivity)
app.get('/api/backtest/validation', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT results->'monteCarlo' as mc, results->'walkForward' as wf,
              results->'regimeStress' as regime, results->'sensitivity' as sens,
              results->'config' as config, results->'summary' as summary,
              results->'byGrade' as by_grade, results->'equityCurve' as equity_curve,
              run_date, created_at
       FROM lc_v3.backtest_results ORDER BY created_at DESC LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.json({ results: null, lastRun: null });
    }
    const row = result.rows[0];
    res.json({
      monteCarlo:   row.mc,
      walkForward:  row.wf,
      regimeStress: row.regime,
      sensitivity:  row.sens,
      config:       row.config,
      summary:      row.summary,
      byGrade:      row.by_grade,
      equityCurve:  row.equity_curve,
      lastRun:      row.created_at?.toISOString(),
      runDate:      row.run_date,
    });
  } catch (err) {
    res.json({ results: null, error: err.message });
  }
});

// Get Monte Carlo results (from latest backtest that includes MC data)
app.get('/api/backtest/monte-carlo', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT results->'monteCarlo' as mc, results->'config' as config, results->'summary' as summary, run_date, created_at FROM lc_v3.backtest_results ORDER BY created_at DESC LIMIT 1"
    );
    if (result.rows.length === 0 || !result.rows[0].mc) {
      return res.json({ results: null, lastRun: null, message: 'No Monte Carlo results yet. Run a backtest first.' });
    }
    res.json({
      monteCarlo: result.rows[0].mc,
      config:     result.rows[0].config,
      summary:    result.rows[0].summary,
      lastRun:    result.rows[0].created_at?.toISOString(),
      runDate:    result.rows[0].run_date,
    });
  } catch (err) {
    res.json({ results: null, error: err.message });
  }
});

// Paper trading P&L summary with full breakdown
app.get('/api/paper/summary', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'OPEN') as open_count,
        COUNT(*) FILTER (WHERE status = 'CLOSED') as closed_count,
        COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS') as losses,
        COUNT(*) FILTER (WHERE outcome = 'FLAT') as flats,
        ROUND(AVG(final_pnl_pct) FILTER (WHERE status = 'CLOSED' AND final_pnl_pct IS NOT NULL)::numeric, 2) as avg_pnl,
        ROUND(SUM(COALESCE(final_pnl_dollars, 0)) FILTER (WHERE status = 'CLOSED')::numeric, 2) as total_pnl_dollars,
        ROUND(MAX(final_pnl_pct) FILTER (WHERE status = 'CLOSED')::numeric, 2) as best_trade,
        ROUND(MIN(final_pnl_pct) FILTER (WHERE status = 'CLOSED')::numeric, 2) as worst_trade,
        ROUND((COUNT(*) FILTER (WHERE outcome = 'WIN')::numeric / NULLIF(COUNT(*) FILTER (WHERE status = 'CLOSED'), 0) * 100)::numeric, 1) as win_rate,
        COUNT(*) FILTER (WHERE auto_traded = TRUE) as auto_count,
        COUNT(*) FILTER (WHERE auto_traded = FALSE OR auto_traded IS NULL) as manual_count
      FROM lc_v3.paper_trades
    `);

    // Recent closed trades
    const recent = await db.query(`
      SELECT paper_id, ticker, direction, strategy, grade, entry_time, exit_time,
             entry_stock_price, exit_stock_price, final_pnl_pct, final_pnl_dollars,
             outcome, exit_reason, auto_traded,
             EXTRACT(EPOCH FROM (exit_time - entry_time))/60 as hold_minutes
      FROM lc_v3.paper_trades
      WHERE status = 'CLOSED'
      ORDER BY exit_time DESC
      LIMIT 50
    `);

    // By strategy breakdown
    const byStrategy = await db.query(`
      SELECT strategy,
        COUNT(*) as trades,
        COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
        ROUND(AVG(final_pnl_pct) FILTER (WHERE final_pnl_pct IS NOT NULL)::numeric, 2) as avg_pnl,
        ROUND(SUM(COALESCE(final_pnl_dollars, 0))::numeric, 2) as total_pnl,
        ROUND((COUNT(*) FILTER (WHERE outcome = 'WIN')::numeric / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as win_rate
      FROM lc_v3.paper_trades
      WHERE status = 'CLOSED'
      GROUP BY strategy
      ORDER BY total_pnl DESC
    `);

    // By grade breakdown
    const byGrade = await db.query(`
      SELECT grade,
        COUNT(*) as trades,
        COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
        ROUND(AVG(final_pnl_pct) FILTER (WHERE final_pnl_pct IS NOT NULL)::numeric, 2) as avg_pnl,
        ROUND(SUM(COALESCE(final_pnl_dollars, 0))::numeric, 2) as total_pnl,
        ROUND((COUNT(*) FILTER (WHERE outcome = 'WIN')::numeric / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as win_rate
      FROM lc_v3.paper_trades
      WHERE status = 'CLOSED'
      GROUP BY grade
      ORDER BY grade
    `);

    res.json({
      summary: result.rows[0] || {},
      recentTrades: recent.rows,
      byStrategy: byStrategy.rows,
      byGrade: byGrade.rows,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
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
let seedOutput = '';
app.post('/api/seed-bars', async (req, res) => {
  if (seedRunning) return res.json({ ok: false, error: 'Already running' });
  seedRunning = true;
  seedResult = null;
  seedOutput = '';
  res.json({ ok: true, message: 'Seed started' });
  // Use spawn (non-blocking) so status endpoint stays responsive
  const { spawn } = await import('child_process');
  const child = spawn('node', ['scripts/seed-bars-historical.js'], {
    cwd: process.cwd(), env: { ...process.env },
  });
  child.stdout.on('data', d => { seedOutput = (seedOutput + d.toString()).slice(-4000); });
  child.stderr.on('data', d => { seedOutput = (seedOutput + d.toString()).slice(-4000); });
  child.on('close', code => {
    seedResult = code === 0
      ? { ok: true, output: seedOutput.slice(-2000) }
      : { ok: false, error: `exit code ${code}`, output: seedOutput.slice(-2000) };
    seedRunning = false;
    console.log(`[SEED] ${code === 0 ? 'Complete' : 'Failed with code ' + code}`);
  });
});
app.get('/api/seed-bars/status', (req, res) => {
  res.json({ running: seedRunning, result: seedResult, output: seedRunning ? seedOutput.slice(-2000) : undefined });
});

// One-off AMAT reseed
app.post('/api/seed-amat', async (req, res) => {
  res.json({ ok: true, message: 'AMAT reseed started' });
  const { spawn } = await import('child_process');
  const child = spawn('node', ['scripts/seed-amat.js'], { cwd: process.cwd(), env: { ...process.env } });
  child.stdout.on('data', d => console.log(d.toString().trim()));
  child.stderr.on('data', d => console.error(d.toString().trim()));
  child.on('close', code => console.log(`[AMAT] reseed ${code === 0 ? 'complete' : 'failed code=' + code}`));
});

// Expand universe to ~200 tickers
app.post('/api/seed-universe', async (req, res) => {
  res.json({ ok: true, message: 'Universe expansion started' });
  const { spawn } = await import('child_process');
  const child = spawn('node', ['scripts/seed-sp500-expansion.js'], { cwd: process.cwd(), env: { ...process.env } });
  child.stdout.on('data', d => console.log(d.toString().trim()));
  child.stderr.on('data', d => console.error(d.toString().trim()));
  child.on('close', code => console.log(`[UNIVERSE] expansion ${code === 0 ? 'complete' : 'failed code=' + code}`));
});

// Run strategy backtest
let btRunning = false, btResult = null, btOutput = '';
app.post('/api/backtest/run-strategies', async (req, res) => {
  if (btRunning) return res.json({ ok: false, error: 'Already running' });
  btRunning = true; btResult = null; btOutput = '';
  res.json({ ok: true, message: 'Backtest started' });
  const { spawn } = await import('child_process');
  const child = spawn('node', ['--max-old-space-size=512', 'scripts/backtest-strategies.js'], { cwd: process.cwd(), env: { ...process.env } });
  child.stdout.on('data', d => { btOutput = (btOutput + d.toString()).slice(-8000); });
  child.stderr.on('data', d => { btOutput = (btOutput + d.toString()).slice(-8000); });
  child.on('close', code => {
    btResult = code === 0
      ? { ok: true, output: btOutput.slice(-6000) }
      : { ok: false, error: `exit code ${code}`, output: btOutput.slice(-6000) };
    btRunning = false;
    console.log(`[BACKTEST] strategies ${code === 0 ? 'complete' : 'failed code=' + code}`);
  });
});
app.get('/api/backtest/run-strategies/status', (req, res) => {
  res.json({ running: btRunning, result: btResult, output: btRunning ? btOutput.slice(-4000) : undefined });
});

// Run trajectory backtest
let trajRunning = false, trajResult = null, trajOutput = '';
app.post('/api/backtest/run-trajectory', async (req, res) => {
  if (trajRunning) return res.json({ ok: false, error: 'Already running' });
  trajRunning = true; trajResult = null; trajOutput = '';
  res.json({ ok: true, message: 'Trajectory backtest started' });
  const { spawn } = await import('child_process');
  const child = spawn('node', ['--max-old-space-size=512', 'scripts/backtest-trajectory.js'], { cwd: process.cwd(), env: { ...process.env } });
  child.stdout.on('data', d => { trajOutput = (trajOutput + d.toString()).slice(-8000); });
  child.stderr.on('data', d => { trajOutput = (trajOutput + d.toString()).slice(-8000); });
  child.on('close', code => {
    trajResult = code === 0
      ? { ok: true, output: trajOutput.slice(-6000) }
      : { ok: false, error: `exit code ${code}`, output: trajOutput.slice(-6000) };
    trajRunning = false;
    console.log(`[BACKTEST] trajectory ${code === 0 ? 'complete' : 'failed code=' + code}`);
  });
});
app.get('/api/backtest/run-trajectory/status', (req, res) => {
  res.json({ running: trajRunning, result: trajResult, output: trajRunning ? trajOutput.slice(-4000) : undefined });
});

// Seed daily bars (2 years)
let dailySeedRunning = false;
let dailySeedResult = null;
let dailySeedOutput = '';
app.post('/api/seed-daily-bars', async (req, res) => {
  if (dailySeedRunning) return res.json({ ok: false, error: 'Already running' });
  dailySeedRunning = true;
  dailySeedResult = null;
  dailySeedOutput = '';
  res.json({ ok: true, message: 'Daily bars seed started' });
  const { spawn } = await import('child_process');
  const child = spawn('node', ['scripts/seed-daily-bars.js'], {
    cwd: process.cwd(), env: { ...process.env },
  });
  child.stdout.on('data', d => { dailySeedOutput = (dailySeedOutput + d.toString()).slice(-4000); });
  child.stderr.on('data', d => { dailySeedOutput = (dailySeedOutput + d.toString()).slice(-4000); });
  child.on('close', code => {
    dailySeedResult = code === 0
      ? { ok: true, output: dailySeedOutput.slice(-2000) }
      : { ok: false, error: `exit code ${code}`, output: dailySeedOutput.slice(-2000) };
    dailySeedRunning = false;
    console.log(`[DAILY-SEED] ${code === 0 ? 'Complete' : 'Failed with code ' + code}`);
  });
});
app.get('/api/seed-daily-bars/status', (req, res) => {
  res.json({ running: dailySeedRunning, result: dailySeedResult, output: dailySeedRunning ? dailySeedOutput.slice(-2000) : undefined });
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

    console.log(`[BACKTEST] Starting multi-strategy: ${startDate} → ${endDate}`);
    const accountSize = parseFloat(process.env.ACCOUNT_SIZE || '7500');
    const results = await runMultiStrategyBacktest(startDate, endDate, accountSize);
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

// Cleanup stale signals every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  try {
    // Expire signals past their expires_at
    const r1 = await db.query(`
      UPDATE lc_v3.signals SET status = 'EXPIRED',
        human_notes = COALESCE(human_notes, '') || ' | AUTO: PAST_EXPIRY'
      WHERE status = 'ACTIVE'
        AND human_taken IS NULL
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
      RETURNING ticker
    `);

    // Hard TTL: expire any signal older than 30 minutes with no human action
    const r2 = await db.query(`
      UPDATE lc_v3.signals SET status = 'EXPIRED',
        human_notes = COALESCE(human_notes, '') || ' | AUTO: 30MIN_TTL'
      WHERE status = 'ACTIVE'
        AND human_taken IS NULL
        AND created_at < NOW() - INTERVAL '30 minutes'
      RETURNING ticker
    `);

    const total = r1.rows.length + r2.rows.length;
    if (total > 0) {
      console.log(`[CLEANUP] Expired ${total} signals (${r1.rows.length} past expiry, ${r2.rows.length} past 30min TTL)`);
    }
  } catch (err) {
    console.error('[CLEANUP] Error:', err.message);
  }
});

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

// ── CONVICTION SCANNER ───────────────────────────────────────────────────────

// In-memory latest prices from poller (ticker → price)
let latestPrices = {};

app.get('/api/prices', (req, res) => {
  const tickers = (req.query.tickers || '').split(',').filter(Boolean);
  const allTickers = tickers.length > 0 ? tickers : Object.keys(latestPrices);
  const merged = {};
  for (const t of allTickers) {
    // Prefer real-time WebSocket price (updated every bar) over REST snapshot cache
    const ws = getTickerState(t);
    if (ws && ws.close > 0 && ws.lastBarAt && (Date.now() - ws.lastBarAt.getTime()) < 120000) {
      merged[t] = ws.close;
    } else if (latestPrices[t] != null) {
      merged[t] = latestPrices[t];
    }
  }
  res.json(merged);
});

// In-memory conviction scan state
let convictionScan = { status: 'idle', results: null, started_at: null, completed_at: null, progress: null, error: null };

app.get('/api/conviction', async (req, res) => {
  // Return cached results if a scan has completed
  if (convictionScan.status === 'complete' && convictionScan.results) {
    return res.json(convictionScan.results);
  }

  try {
    // Get tickers from equity_profiles UNION conviction_universe
    const tickerRes = await db.query(`
      SELECT ticker FROM lc_v3.equity_profiles
      UNION
      SELECT ticker FROM lc_v3.conviction_universe
    `);
    const tickers = tickerRes.rows.map(r => r.ticker);

    // Score each ticker
    const scored = [];
    for (const ticker of tickers) {
      try {
        const result = await scoreConvictionSetup(ticker, db);
        if (result.conviction_score >= 50 || result.recommendation === 'DEAL_RISK_PUT') {
          scored.push(result);
        }
      } catch (err) {
        console.error(`[CONVICTION] Error scoring ${ticker}:`, err.message);
      }
    }

    // Sort by score desc, take top 20
    scored.sort((a, b) => b.conviction_score - a.conviction_score);
    const top20 = scored.slice(0, 20);

    res.json({
      results: top20,
      total_scanned: tickers.length,
      total_qualifying: scored.length,
      scanned_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CONVICTION]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conviction/scan', (req, res) => {
  if (convictionScan.status === 'running') {
    return res.json({ status: 'already_running', started_at: convictionScan.started_at, progress: convictionScan.progress });
  }

  convictionScan = { status: 'running', results: null, started_at: new Date().toISOString(), completed_at: null, progress: '0/?', error: null };
  res.json({ status: 'started', started_at: convictionScan.started_at });

  // Run in background
  (async () => {
    try {
      const tickerRes = await db.query(`
        SELECT ticker FROM lc_v3.equity_profiles
        UNION
        SELECT ticker FROM lc_v3.conviction_universe
      `);
      const tickers = tickerRes.rows.map(r => r.ticker);
      const scored = [];
      const errors = [];

      // Process in batches of 3 with 500ms delay
      for (let i = 0; i < tickers.length; i += 3) {
        const batch = tickers.slice(i, i + 3);
        convictionScan.progress = `${i}/${tickers.length}`;

        const results = await Promise.allSettled(
          batch.map(t => scoreConvictionSetup(t, db))
        );

        for (let j = 0; j < results.length; j++) {
          if (results[j].status === 'rejected') {
            errors.push({ ticker: batch[j], error: results[j].reason?.message });
            continue;
          }
          const r = results[j].value;
          if (r.recommendation === 'STRONG_PUT' || r.recommendation === 'MONITOR' || r.recommendation === 'DEAL_RISK_PUT') {
            scored.push(r);
            console.log(`[CONVICTION SCAN] ${r.ticker} score=${r.conviction_score} rec=${r.recommendation} thesis=${r.thesis} red_flags=${r.eight_k_red_flags?.length || 0}`);
          }
        }

        if (i + 3 < tickers.length) await new Promise(r => setTimeout(r, 500));
      }

      scored.sort((a, b) => b.conviction_score - a.conviction_score);

      convictionScan.status = 'complete';
      convictionScan.completed_at = new Date().toISOString();
      convictionScan.progress = `${tickers.length}/${tickers.length}`;
      convictionScan.results = {
        results: scored.slice(0, 30),
        total_scanned: tickers.length,
        total_qualifying: scored.length,
        errors: errors.length,
        scanned_at: convictionScan.completed_at,
      };
      console.log(`[CONVICTION SCAN] Complete: ${scored.length} qualifying out of ${tickers.length}, ${errors.length} errors`);
    } catch (err) {
      console.error('[CONVICTION SCAN] Fatal:', err);
      convictionScan.status = 'error';
      convictionScan.error = err.message;
      convictionScan.completed_at = new Date().toISOString();
    }
  })();
});

app.get('/api/conviction/status', (req, res) => {
  const resp = {
    status: convictionScan.status,
    started_at: convictionScan.started_at,
    completed_at: convictionScan.completed_at,
    progress: convictionScan.progress,
    error: convictionScan.error,
  };
  if (convictionScan.status === 'complete' && convictionScan.results) {
    resp.total_scanned = convictionScan.results.total_scanned;
    resp.total_qualifying = convictionScan.results.total_qualifying;
    resp.errors = convictionScan.results.errors;
    resp.results = convictionScan.results.results;
  }
  res.json(resp);
});

// ── MULTI-STRATEGY BACKTEST ENDPOINTS ──────────────────────────────────────────

app.get('/multi-strategy', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'multi-strategy.html'));
});

// Latest multi-strategy results
app.get('/api/multi-strategy', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM lc_v3.backtest_multi_results ORDER BY run_date DESC LIMIT 1'
    );
    if (result.rows.length === 0) return res.json(null);
    const row = result.rows[0];
    res.json({
      runDate: row.run_date,
      startDate: row.start_date,
      endDate: row.end_date,
      ...row.portfolio,
      strategies: row.strategies,
      crossStrategy: row.cross_strategy,
      positionSizing: row.position_sizing,
      realityChecks: row.reality_checks,
      monteCarlo: row.monte_carlo,
      walkForward: row.walk_forward,
      outOfSample: row.out_of_sample,
    });
  } catch (err) {
    console.error('[API] multi-strategy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Run multi-strategy backtest
let multiStratRun = { status: 'idle' };

app.post('/api/multi-strategy/run', async (req, res) => {
  if (multiStratRun.status === 'running') {
    return res.json({ status: 'already_running', started: multiStratRun.started_at });
  }

  multiStratRun = { status: 'running', started_at: new Date().toISOString() };
  res.json({ status: 'started' });

  try {
    // Default: last 20 trading days
    const endDate = new Date().toISOString().split('T')[0];
    const startDateObj = new Date();
    startDateObj.setDate(startDateObj.getDate() - 30);
    const startDate = startDateObj.toISOString().split('T')[0];

    const results = await runMultiStrategyBacktest(startDate, endDate, 7500);

    // Cross-strategy analysis (guard empty signals)
    const sigs = results.signals || [];
    const crossStrat = sigs.length >= 5 ? {
      correlation: computeCorrelationMatrix(sigs),
      portfolio: portfolioMetrics(sigs, 7500),
      diversification: diversificationBenefit(sigs, 7500),
      weights: optimalWeights(sigs),
    } : { error: 'Not enough signals for cross-strategy analysis' };

    // Position sizing
    const sizing = sigs.length >= 5 ? {
      kelly: kellyPerStrategy(sigs),
      optimal: targetSizing(sigs, 7500),
    } : { error: 'Not enough signals for position sizing' };

    // Reality checks
    const realityChecks = await runRealityChecks(sigs, 7500);

    // Store in DB
    await db.query(`
      INSERT INTO lc_v3.backtest_multi_results
        (run_date, start_date, end_date, strategies, portfolio, cross_strategy, position_sizing, reality_checks, monte_carlo, walk_forward, out_of_sample)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      endDate, startDate, endDate,
      JSON.stringify(results.byStrategy),
      JSON.stringify(results),
      JSON.stringify(crossStrat),
      JSON.stringify(sizing),
      JSON.stringify(realityChecks),
      JSON.stringify(results.monteCarlo),
      JSON.stringify(results.walkForward),
      JSON.stringify(results.outOfSample),
    ]);

    // Keep last 30 runs
    await db.query(`
      DELETE FROM lc_v3.backtest_multi_results
      WHERE id NOT IN (
        SELECT id FROM lc_v3.backtest_multi_results ORDER BY run_date DESC LIMIT 30
      )
    `);

    // Store per-strategy grade calibrations
    if (results.gradeCalibrations) {
      for (const [strategy, cal] of Object.entries(results.gradeCalibrations)) {
        try {
          await db.query(`
            INSERT INTO lc_v3.grade_calibrations (strategy, thresholds, performance_at_grade, sample_size, calibration_quality, monotonic, calibrated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (strategy) DO UPDATE SET
              thresholds = $2, performance_at_grade = $3, sample_size = $4,
              calibration_quality = $5, monotonic = $6, calibrated_at = NOW()
          `, [strategy, JSON.stringify(cal.thresholds), JSON.stringify(cal.performanceAtGrade),
              cal.sampleSize, cal.calibrationQuality, cal.monotonic]);
        } catch (calErr) {
          // Non-fatal — table may not exist yet
          if (!calErr.message.includes('does not exist')) {
            console.error(`[MULTI-STRAT] Grade calibration store error for ${strategy}:`, calErr.message);
          }
        }
      }
    }

    multiStratRun = { status: 'complete', completed_at: new Date().toISOString(), summary: results.summary };
  } catch (err) {
    console.error('[MULTI-STRAT] Run failed:', err.message);
    console.error('[MULTI-STRAT] Stack:', err.stack);
    multiStratRun = { status: 'error', error: err.message, stack: err.stack };
  }
});

app.get('/api/multi-strategy/status', (req, res) => {
  res.json(multiStratRun);
});

// ── AUTO-TRADER ENDPOINTS ────────────────────────────────────────────────────

app.get('/auto-trader', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'auto-trader.html'));
});

app.get('/api/auto-trader/status', (req, res) => {
  res.json(getAutoTraderStatus());
});

app.post('/api/auto-trader/start', async (req, res) => {
  try {
    await startAutoTrader();
    res.json({ status: 'started', ...getAutoTraderStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto-trader/stop', (req, res) => {
  stopAutoTrader();
  res.json({ status: 'stopped', ...getAutoTraderStatus() });
});

app.post('/api/auto-trader/halt', (req, res) => {
  const reason = req.body?.reason || 'Manual halt from dashboard';
  manualHalt(reason);
  res.json({ status: 'halted', reason, ...getAutoTraderStatus() });
});

app.post('/api/auto-trader/resume', (req, res) => {
  resumeTrading();
  res.json({ status: 'resumed', ...getAutoTraderStatus() });
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
const GRADE_SCALE  = [[95,'A+'],[90,'A'],[84,'A-'],[74,'B+'],[60,'B']];
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
  let continuationCycle = 0;

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

      // Update in-memory price cache for /api/prices
      for (const [t, snap] of Object.entries(allSnaps)) {
        const p = snap.latestTrade?.p || snap.latestQuote?.ap;
        if (p) latestPrices[t] = p;
      }

      console.log(`[POLL] ${Object.keys(allSnaps).length} snaps SPY=${(spyPct*100).toFixed(2)}% QQQ=${(qqqPct*100).toFixed(2)}% VIX=${vix} REGIME=${regime.regime}`);

      // Import intelligence functions
      const { analyzeLevels, analyzeTrend, gateSignal } = await import('./src/scoring/intelligence.js');
      // analyzeMomentum decommissioned — momentum scoring removed
      const { shouldSkipOnFreshness } = await import('./src/scoring/momentum.js');

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

        // analyzeMomentum decommissioned — inline fallback only
        freshness = moveInATRs < 0.5 ? 'FRESH'
                  : moveInATRs < 1.0 ? 'DEVELOPING'
                  : moveInATRs < 1.5 ? 'EXTENDED'
                  : moveInATRs < 2.0 ? 'LATE'
                  : 'EXHAUSTED';
        if (freshness === 'EXHAUSTED') continue;

        const freshnessPenalty = moveInATRs > 1.5 ? 0.5 : moveInATRs > 1.0 ? 0.75 : 1.0;
        paScore = Math.min(35, Math.round(moveInATRs * 35 * freshnessPenalty));
        momentum = { momentumScore: paScore, freshness, entryRisk: freshness === 'FRESH' ? 'LOW' : 'MODERATE', barsInMove: 0, moveFromOpen: parseFloat((moveFromOpen * 100).toFixed(3)), recentAccel: parseFloat((absRecent * 100).toFixed(3)), volSurge: 1, exhaustion: false, moveInATRs: parseFloat(moveInATRs.toFixed(2)) };

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
        let volScore  = Math.min(30, Math.round(relVol * 12));

        // Flow absorption adjustment — real buy/sell order flow
        const flow = getRecentFlow(ticker, 5);
        if (flow.avgBuyRatio !== null && flow.minutes >= 3) {
          if (direction === 'CALL') {
            if (flow.avgBuyRatio >= 0.60) volScore = Math.min(30, volScore + 5);
            else if (flow.avgBuyRatio >= 0.55) volScore = Math.min(30, volScore + 3);
            else if (flow.avgBuyRatio <= 0.35) volScore = Math.max(0, volScore - 4);
            else if (flow.avgBuyRatio <= 0.40) volScore = Math.max(0, volScore - 2);
          } else {
            if (flow.avgBuyRatio <= 0.35) volScore = Math.min(30, volScore + 5);
            else if (flow.avgBuyRatio <= 0.40) volScore = Math.min(30, volScore + 3);
            else if (flow.avgBuyRatio >= 0.65) volScore = Math.max(0, volScore - 4);
            else if (flow.avgBuyRatio >= 0.60) volScore = Math.max(0, volScore - 2);
          }
        }

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

        // Gate check: PA and VOL must pass before spending resources on news
        if (paScore < 15 || volScore < 12) continue;

        // News scoring — only runs when gatekeepers pass
        const newsEvents = getNewsEvents(ticker);
        const newsResult = computeNewsScore({ direction, newsEvents, profile: profiles[ticker] });
        const newsScore  = newsResult.score;

        const composite = paScore + volScore + mktScore + timScore + newsScore;

        let grade = toGrade(composite);
        if (!grade) continue;

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

        // ── MOMENTUM SIGNALS DISABLED — only strategy signals write to DB ──
        continue;

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

        // Fetch contract only for new signals — existing signals keep their locked contract
        let contract = null;
        const isUpdate = existing.rows.length > 0;
        if (!isUpdate || !existing.rows[0]?.contract_symbol) {
          try {
            contract = await selectOptionsContract(ticker, direction, grade, price, atr);
          } catch (ce) {
            console.error(`[contract] ${ticker}: ${ce.message}`);
          }
        }

        if (isUpdate) {
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
      const macroEvent = isHighImpactMacroDay();
      if (macroEvent) {
        console.log(`[MACRO] ${macroEvent} detected — confidence -20, SECTOR_ROTATION blocked`);
      }

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
            SELECT DISTINCT ON (ticker) ticker, open, high, low, close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
              AND DATE(ts AT TIME ZONE 'America/New_York') = CURRENT_DATE
              AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60
                + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 575
            ORDER BY ticker, ts
          `);
          for (const row of fcRes.rows) {
            firstCandles[row.ticker] = { open: parseFloat(row.open), high: parseFloat(row.high), low: parseFloat(row.low), close: parseFloat(row.close) };
          }

          // If no bars in DB yet today (bars may not be seeded yet), build from snapshots
          if (Object.keys(firstCandles).length === 0 && currentMins >= 575) {
            for (const [ticker, snap] of Object.entries(allSnaps)) {
              const o = snap.dailyBar?.o;
              const firstMin = snap.prevMinuteBar || snap.minuteBar;
              if (o && firstMin) {
                firstCandles[ticker] = { open: o, high: firstMin.h || o, low: firstMin.l || firstMin.c, close: firstMin.c };
              }
            }
          }

          // Build dailyBars for consecutive-drop scanner — derive daily OHLCV from minute bars
          const dailyBars = {};
          try {
            const dbRes = await db.query(`
              WITH daily AS (
                SELECT ticker,
                       DATE(ts AT TIME ZONE 'America/New_York') as day,
                       (array_agg(open ORDER BY ts))[1] as o,
                       MAX(high) as h,
                       MIN(low) as l,
                       (array_agg(close ORDER BY ts DESC))[1] as c,
                       SUM(volume) as v
                FROM lc_v3.bars
                WHERE session = 'REGULAR'
                  AND ts >= NOW() - INTERVAL '10 days'
                GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
              )
              SELECT * FROM daily
              WHERE day < CURRENT_DATE
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

          // Build support/resistance level data for bounce-confirmation scanners
          const prevDayLows = {}, prevDayHighs = {}, todayLows = {}, todayHighs = {}, currentPrices = {};
          const vwaps = {}, intradayBarsMap = {};
          for (const [ticker, snap] of Object.entries(allSnaps)) {
            if (snap.prevDailyBar?.l) prevDayLows[ticker] = snap.prevDailyBar.l;
            if (snap.prevDailyBar?.h) prevDayHighs[ticker] = snap.prevDailyBar.h;
            if (snap.dailyBar?.l) todayLows[ticker] = snap.dailyBar.l;
            if (snap.dailyBar?.h) todayHighs[ticker] = snap.dailyBar.h;
            if (snap.latestTrade?.p) currentPrices[ticker] = snap.latestTrade.p;
            // Pull VWAP and intraday bars from state for bounce structure analysis
            const ts = getTickerState(ticker);
            if (ts?.vwap) vwaps[ticker] = ts.vwap;
            if (ts?.bars?.length > 0) intradayBarsMap[ticker] = ts.bars;
          }
          const levelData = { prevDayLows, prevDayHighs, todayLows, todayHighs, dailyBars, vwaps, intradayBars: intradayBarsMap };

          // Old strategy scanners decommissioned — no documented edge (28.3% directional accuracy)
          // New 7 research-backed strategies run via backtest pipeline only.
          // Live scanners for new strategies will be built when backtest validates them.
          const allStratSignals = [];

          // Diagnostic: log scanner inputs + outputs every 5th cycle
          if (continuationCycle % 5 === 0) {
            // Sample a few tickers to show gap calculations
            const sampleTickers = ['ADBE', 'NVDA', 'TSLA', 'AAPL', 'MSFT'].filter(t => stratSnapshots[t]);
            for (const t of sampleTickers.slice(0, 3)) {
              const o = stratSnapshots[t]?.open;
              const pc = prevCloses[t];
              const fc = firstCandles[t];
              const gap = o && pc ? ((o - pc) / pc * 100).toFixed(2) : 'N/A';
              const fcColor = fc ? (fc.close > fc.open ? 'GREEN' : 'RED') : 'NONE';
              console.log(`[DIAG] ${t} open=${o} prevClose=${pc} gap=${gap}% firstCandle=${fcColor} fc=${JSON.stringify(fc||null)}`);
            }
          }

          // Contradiction filter: if same ticker has both CALL and PUT signals,
          // keep only the higher-confidence one. Both firing = market is choppy, not directional.
          const tickerDirections = {};
          for (const sig of allStratSignals) {
            const key = sig.ticker;
            if (!tickerDirections[key]) tickerDirections[key] = [];
            tickerDirections[key].push(sig);
          }
          const contradictions = new Set();
          for (const [ticker, sigs] of Object.entries(tickerDirections)) {
            const dirs = new Set(sigs.map(s => s.direction));
            if (dirs.has('CALL') && dirs.has('PUT')) {
              contradictions.add(ticker);
              console.log(`[CONTRADICTION] ${ticker} has both CALL and PUT signals — blocking both (choppy, not directional)`);
            }
          }

          for (const sig of allStratSignals) {
            if (contradictions.has(sig.ticker)) continue;

            console.log(`[STRATEGY CANDIDATE] ${sig.ticker} ${sig.direction} ${sig.strategy} confidence=${sig.confidence} entry=$${sig.entry_price}`);

            // ── Fakeout block: CALL bounces in downtrend with no stabilization ──
            // A stock in confirmed downtrend that hasn't stabilized is likely a dead cat bounce.
            // Block CALL signals UNLESS there's overwhelming volume (2x+) which suggests capitulation.
            const isCallBounce = sig.direction === 'CALL' && [
              'GAP_REVERSAL', 'CAPITULATION_BOUNCE', 'SECTOR_ROTATION_BOUNCE',
              'GAP_UP_REVERSAL', 'CONSEC_BOUNCE'
            ].includes(sig.strategy);

            if (isCallBounce) {
              const hasDowntrend = sig.trend === 'DOWNTREND' || sig.trend_flags?.includes('downtrend');
              const noStab = sig.stabilized === false || sig.trend_flags?.includes('no_stabilization');
              const overwhelmingVolume = sig.volume_ratio && sig.volume_ratio >= 2.0;

              if (hasDowntrend && noStab && !overwhelmingVolume) {
                console.log(`[FAKEOUT BLOCK] ${sig.ticker} ${sig.strategy} — downtrend + no stabilization (vol=${sig.volume_ratio || 'N/A'}x). Skipping CALL.`);
                continue;
              }
            }

            // ── Full TA confirmation: intelligence gate + stabilization + momentum ──
            // Run the same pipeline as momentum signals to confirm price action & volume
            const INTRADAY_STRATEGIES = [
              'GAP_REVERSAL', 'GAP_UP_REVERSAL', 'SECTOR_ROTATION_BOUNCE',
              'CAPITULATION_BOUNCE', 'BREAKDOWN_PUT', 'RELATIVE_WEAKNESS_PUT',
              'OPENING_RANGE_BREAKOUT', 'VWAP_RECLAIM', 'POWER_HOUR',
              'CORRELATION_CASCADE', 'POST_MACRO', 'FAILED_BREAKDOWN',
            ];
            if (INTRADAY_STRATEGIES.includes(sig.strategy)) {
              const bars = intradayBarsMap[sig.ticker];
              const snap = allSnaps[sig.ticker];
              const prevClose = snap?.prevDailyBar?.c || 0;
              const openPrice = snap?.dailyBar?.o || sig.entry_price;
              const atr = parseFloat(profiles[sig.ticker]?.atr_20d || 0.025);
              const ts = getTickerState(sig.ticker);

              if (bars && bars.length >= 5) {
                // 1. Stabilization gate — for CALL bounces, price must have stabilized
                //    (3+ bars without making new lows after the flush)
                if (sig.direction === 'CALL' && sig.stabilized === false) {
                  console.log(`[TA BLOCK] ${sig.ticker} ${sig.strategy} CALL — no stabilization (${sig.bars_held || 0} bars held). Waiting for bottom to form.`);
                  continue;
                }

                // 2. VWAP confirmation — CALL must be at or reclaiming VWAP, PUT must be below
                const vwap = vwaps[sig.ticker] || ts?.vwap || 0;
                const price = sig.entry_price;
                if (vwap > 0) {
                  if (sig.direction === 'CALL' && price < vwap * 0.995) {
                    // Allow if stabilized AND close to VWAP (within 0.5%)
                    // Block if clearly below VWAP — buyers haven't taken control
                    const vwapDist = ((price - vwap) / vwap * 100).toFixed(2);
                    console.log(`[TA BLOCK] ${sig.ticker} ${sig.strategy} CALL — below VWAP ($${vwap.toFixed(2)}) by ${vwapDist}%. Waiting for reclaim.`);
                    continue;
                  }
                }

                // 3. Higher low formation — current bar low must be above the lowest low
                //    of bars 2-5 ago (bottom has formed, not still falling)
                if (sig.direction === 'CALL') {
                  const recentLows = bars.slice(-5, -1).map(b => b.l);
                  const swingLow = Math.min(...recentLows);
                  const currentLow = bars[bars.length - 1].l;
                  if (currentLow < swingLow) {
                    console.log(`[TA BLOCK] ${sig.ticker} ${sig.strategy} CALL — still making new lows (${currentLow.toFixed(2)} < swing low ${swingLow.toFixed(2)}). No higher low yet.`);
                    continue;
                  }
                }

                // 4. Volume confirmation — reversal bars should show buyer participation
                //    Average volume of last 3 bars must be >= average of prior 5
                const last3vol = bars.slice(-3).reduce((s, b) => s + (b.v || 0), 0) / 3;
                const prior5vol = bars.slice(-8, -3).length > 0
                  ? bars.slice(-8, -3).reduce((s, b) => s + (b.v || 0), 0) / bars.slice(-8, -3).length
                  : last3vol;
                if (prior5vol > 0 && last3vol < prior5vol * 0.5) {
                  console.log(`[TA BLOCK] ${sig.ticker} ${sig.strategy} — volume drying up (last3=${Math.round(last3vol)} < 50% of prior5=${Math.round(prior5vol)}). No conviction.`);
                  continue;
                }

                // 5. Momentum freshness — reject LATE/EXHAUSTED entries
                const momentum = analyzeMomentum(bars, openPrice, prevClose, atr, sig.direction);
                if (momentum.freshness === 'EXHAUSTED' || momentum.freshness === 'LATE') {
                  console.log(`[TA BLOCK] ${sig.ticker} ${sig.strategy} — move is ${momentum.freshness} (${momentum.barsInMove} bars in). Too late to enter.`);
                  continue;
                }

                // 6. Intelligence gate — trend, levels, regime, VWAP overextension
                const mockState = {
                  close: price, vwap: vwap || price,
                  sessionHigh: todayHighs[sig.ticker] || price,
                  sessionLow: todayLows[sig.ticker] || price,
                  prevDayHigh: prevDayHighs[sig.ticker] || prevClose * 1.01,
                  prevDayLow: prevDayLows[sig.ticker] || prevClose * 0.99,
                  sessionOpen: openPrice, bars,
                };
                const levels = analyzeLevels(mockState, atr);
                const trend = analyzeTrend(bars, sig.direction);
                const gate = gateSignal(sig.direction, trend, levels, regime, momentum.freshness);

                if (!gate.allow) {
                  console.log(`[TA GATE] ${sig.ticker} ${sig.strategy} ${sig.direction} — ${gate.reason}`);
                  continue;
                }

                console.log(`[TA PASS] ${sig.ticker} ${sig.strategy} ${sig.direction} — freshness=${momentum.freshness} bars=${momentum.barsInMove} trend=${trend.signalType} gate=ALLOW`);
              }
            }

            // Dedup: skip if strategy signal already exists today for this ticker+direction+strategy
            const dupCheck = await db.query(`
              SELECT 1 FROM lc_v3.signals
              WHERE ticker = $1 AND direction = $2
                AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
                AND news_headline LIKE $3
              LIMIT 1
            `, [sig.ticker, sig.direction, `%strategy=${sig.strategy}%`]);
            if (dupCheck.rows.length > 0) {
              console.log(`[STRATEGY DEDUP] ${sig.ticker} ${sig.strategy} — already exists today`);
              continue;
            }

            // Options volume gate — DISABLED pending API field debugging
            // These are all large-cap names; liquidity is not a concern
            const optVol = await getOptionsVolume(sig.ticker);
            console.log(`[STRATEGY VOL-INFO] ${sig.ticker} ${sig.strategy} — options vol=${optVol} (gate disabled, allowing through)`);

            let compositeRaw = Math.round(sig.confidence || 50);

            // Macro event penalty: reduce confidence by 20 on high-impact days
            if (macroEvent) compositeRaw -= 20;

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

            // News warning for CAPITULATION_BOUNCE — check if recent news drove the drop
            let newsWarning = false;
            let newsHeadlineText = null;
            if (sig.strategy === 'CAPITULATION_BOUNCE') {
              try {
                const newsCheck = await db.query(`
                  SELECT news_headline FROM lc_v3.signals
                  WHERE ticker = $1
                    AND created_at >= NOW() - INTERVAL '4 hours'
                    AND news_headline IS NOT NULL
                    AND news_headline NOT LIKE 'strategy=%'
                  ORDER BY created_at DESC LIMIT 1
                `, [sig.ticker]);
                if (newsCheck.rows.length > 0) {
                  newsWarning = true;
                  newsHeadlineText = newsCheck.rows[0].news_headline;
                  console.log(`[STRATEGY] ${sig.ticker} CAPITULATION_BOUNCE has recent news: ${newsHeadlineText.slice(0, 80)}`);
                }
              } catch { /* non-fatal */ }
            }

            const signalNote = [
              `strategy=${sig.strategy}`,
              `confidence=${sig.confidence}%`,
              nearEarnings ? 'NEAR_EARNINGS' : null,
              newsWarning ? `news_warning=true` : null,
              newsHeadlineText ? `news_text=${newsHeadlineText.slice(0, 120)}` : null,
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
              sig.front_leg ? `frontLeg=${sig.front_leg}` : null,
              sig.back_leg ? `backLeg=${sig.back_leg}` : null,
              sig.exit_time ? `exitTime=${sig.exit_time}` : null,
              sig.range_pct != null ? `rangePct=${sig.range_pct}%` : null,
              sig.vix_level != null ? `vixLevel=${sig.vix_level}` : null,
              sig.conviction_score != null ? `conviction=${sig.conviction_score}` : null,
              sig.earnings_date ? `earningsDate=${sig.earnings_date}` : null,
              sig.days_to_earnings != null ? `daysToER=${sig.days_to_earnings}` : null,
              sig.iv_rank != null ? `ivRank=${sig.iv_rank}%` : null,
              sig.pct_below_high != null ? `belowHigh=${sig.pct_below_high}%` : null,
              sig.strike_range ? `strike=${sig.strike_range}` : null,
              sig.hard_exit ? `hardExit=${sig.hard_exit}` : null,
              sig.position_size_pct != null ? `size=${sig.position_size_pct}%` : null,
              sig.trend ? `trend=${sig.trend}` : null,
              sig.trend_flags?.length > 0 ? `flags=${sig.trend_flags.join(',')}` : null,
              sig.vwap_support ? 'VWAP_SUPPORT' : null,
              sig.vwap_bearish ? 'VWAP_BEARISH' : null,
              sig.spread_type ? `spreadType=${sig.spread_type}` : null,
              sig.defended_level != null ? `defendedLevel=$${sig.defended_level}` : null,
              sig.level_source ? `levelSource=${sig.level_source}` : null,
              sig.credit_target_pct != null ? `creditTarget=${sig.credit_target_pct}%` : null,
              sig.level_defended_count != null ? `defended=${sig.level_defended_count}x` : null,
              sig.stabilized ? `STABILIZED(${sig.bars_held}bars)` : null,
              sig.stabilized === false && sig.bars_held !== undefined ? 'NO_STABILIZATION' : null,
              sig.note || null,
            ].filter(Boolean).join(' · ');

            const expiryInterval = sig.strategy === 'CONSEC_BOUNCE' ? '2 days'
              : sig.strategy === 'OVERNIGHT_CALENDAR' ? '18 hours'
              : sig.strategy === 'PRE_EARNINGS_PUT' ? `${(sig.exit_within_days || 22)} days`
              : sig.strategy === 'CREDIT_SPREAD' ? '3 days'
              : sig.strategy === 'CORRELATION_CASCADE' ? '6 hours'
              : sig.strategy === 'POST_MACRO' ? '6 hours'
              : sig.strategy === 'POWER_HOUR' ? '2 hours'
              : '4 hours';

            // VOL_DROP_PUT fires as PAPER_ONLY — track but don't prompt for live entry
            const signalStatus = sig.strategy === 'VOL_DROP_PUT' ? 'PAPER_ONLY' : 'ACTIVE';

            // Strategy sub-scores: use real setup factors if available, else distribute
            const setupFactors = sig.setup_factors || {};
            const hasRealFactors = Object.keys(setupFactors).length > 0;
            let stratPA, stratVOL, stratNEWS, stratMKT, stratTIM;
            if (hasRealFactors) {
              // Map real factors to pillar scores (0-100 each)
              stratPA  = setupFactors.candle_type?.scored ?? setupFactors.trap_quality?.scored ?? Math.round(compositeRaw * 0.40);
              stratVOL = setupFactors.volume_ratio?.scored ?? setupFactors.vwap_tests?.scored ?? Math.round(compositeRaw * 0.20);
              stratNEWS = setupFactors.market_move?.scored ?? setupFactors.market_strength?.scored ?? Math.round(compositeRaw * 0.10);
              stratMKT = setupFactors.confluence?.scored ?? Math.round(compositeRaw * 0.15);
              stratTIM = setupFactors.trend_quality?.scored ?? setupFactors.trend?.scored ?? Math.round(compositeRaw * 0.15);
            } else {
              stratPA  = Math.round(compositeRaw * 0.40);
              stratVOL = Math.round(compositeRaw * 0.20);
              stratNEWS = Math.round(compositeRaw * 0.10);
              stratMKT = Math.round(compositeRaw * 0.15);
              stratTIM = Math.round(compositeRaw * 0.15);
            }

            const grade = toGrade(compositeRaw) || 'B';
            const insertRes = await db.query(`
              INSERT INTO lc_v3.signals (
                ticker, direction, grade, status, composite_raw, signal_tier,
                price_at_signal, news_headline,
                score_price_action, score_volume, score_news, score_market, score_timing,
                first_seen_at, last_confirmed_at, confirmation_count,
                peak_composite, peak_grade, composite_history, momentum_trend,
                expires_at, created_at
              ) VALUES ($1,$2,$12,$3,$4,'primary',$5,$6,
                $7,$8,$9,$10,$11,
                NOW(), NOW(), 1, $4, $12, '[]'::jsonb, 'NEW',
                NOW() + INTERVAL '${expiryInterval}', NOW())
              RETURNING signal_id
            `, [sig.ticker, sig.direction, signalStatus, compositeRaw, sig.entry_price, signalNote,
                stratPA, stratVOL, stratNEWS, stratMKT, stratTIM, grade]);

            const newSignalId = insertRes.rows[0]?.signal_id;
            console.log(`[STRATEGY] ${sig.ticker} ${sig.direction} ${sig.strategy} ${sig.confidence}% ${signalStatus === 'PAPER_ONLY' ? '(PAPER)' : ''}`);

            // Capture options greeks at signal creation time
            if (newSignalId) {
              try {
                const minDTE = STRATEGY_MIN_DTE[sig.strategy] ?? 0;
                const contract = await selectOptionsContract(sig.ticker, sig.direction, grade, sig.entry_price, 0.025, { minDTE });
                if (contract) {
                  await db.query(`
                    UPDATE lc_v3.signals SET
                      options_delta = $1, options_gamma = $2, options_theta = $3, options_vega = $4,
                      options_iv = $5, options_bid = $6, options_ask = $7, options_mid = $8,
                      options_volume = $9, options_open_interest = $10,
                      contract_symbol = $11, contract_strike = $12, contract_expiry = $13,
                      contract_expiry_label = $14, contract_bid = $6, contract_ask = $7,
                      contract_mid = $8, contract_entry_lo = $15, contract_entry_hi = $16,
                      contract_delta = $1, contract_iv = $5,
                      contract_t1 = $17, contract_t2 = $18, contract_t3 = $19, contract_stop = $20,
                      contract_estimated = false
                    WHERE signal_id = $21
                  `, [
                    contract.delta, contract.gamma, contract.theta, contract.vega,
                    contract.iv, contract.bid, contract.ask, contract.mid,
                    contract.options_volume, contract.open_interest,
                    contract.symbol, contract.strike, contract.expiry,
                    contract.expiry_label, contract.entry_lo, contract.entry_hi,
                    contract.t1, contract.t2, contract.t3, contract.stop,
                    newSignalId,
                  ]);
                  console.log(`[GREEKS] ${sig.ticker} delta=${contract.delta} gamma=${contract.gamma} theta=${contract.theta} vega=${contract.vega} iv=${contract.iv}%`);
                }
              } catch (greeksErr) {
                console.warn(`[GREEKS] ${sig.ticker} capture failed: ${greeksErr.message}`);
              }

              // Auto-open paper trade for every strategy signal
              console.log(`[AUTO-PAPER ATTEMPT] ${sig.ticker} ${sig.strategy} signal_id=${newSignalId}`);
              try {
                // Re-read the signal to get contract fields that were just updated
                const sigRow = await db.query(`SELECT * FROM lc_v3.signals WHERE signal_id = $1`, [newSignalId]);
                const s = sigRow.rows[0];
                if (s) {
                  await db.query(`
                    INSERT INTO lc_v3.paper_trades (
                      signal_id, ticker, direction, grade, strategy,
                      entry_stock_price, entry_contract_mid,
                      entry_t1, entry_t2, entry_t3, entry_stop,
                      position_size_pct,
                      entry_contract_symbol, entry_contract_strike, entry_contract_expiry,
                      entry_contract_delta, entry_contract_iv,
                      status, auto_traded
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'OPEN',TRUE)
                  `, [
                    newSignalId, sig.ticker, sig.direction, 'A', sig.strategy,
                    sig.entry_price,
                    s.contract_mid ? parseFloat(s.contract_mid) : null,
                    s.contract_t1 ? parseFloat(s.contract_t1) : null,
                    s.contract_t2 ? parseFloat(s.contract_t2) : null,
                    s.contract_t3 ? parseFloat(s.contract_t3) : null,
                    s.contract_stop ? parseFloat(s.contract_stop) : null,
                    s.position_size_pct ? parseFloat(s.position_size_pct) : null,
                    s.contract_symbol || null,
                    s.contract_strike ? parseFloat(s.contract_strike) : null,
                    s.contract_expiry || null,
                    s.contract_delta ? parseFloat(s.contract_delta) : null,
                    s.contract_iv ? parseFloat(s.contract_iv) : null,
                  ]);
                  console.log(`[AUTO-PAPER SUCCESS] ${sig.ticker} ${sig.strategy} signal_id=${newSignalId}`);
                } else {
                  console.warn(`[AUTO-PAPER FAILED] ${sig.ticker} — signal row not found after insert`);
                }
              } catch (paperErr) {
                console.error(`[AUTO-PAPER FAILED] ${sig.ticker} ${sig.strategy} error: ${paperErr.message}`);
              }
            }
          }

          if (allStratSignals.length > 0) {
            console.log(`[STRATEGY] ${allStratSignals.length} strategy signals fired`);
          }

          // Debug summary — always log so we know scanners ran
          console.log(`[POLL SUMMARY] checked=${Object.keys(stratSnapshots).length} prevCloses=${Object.keys(prevCloses).length} firstCandles=${Object.keys(firstCandles).length} stratSignals=${allStratSignals.length}`);
          if (allStratSignals.length > 0) {
            console.log(`[STRATEGY FIRED] ${allStratSignals.map(s => `${s.ticker}:${s.strategy}`).join(', ')}`);
          }
        } catch (stratErr) {
          console.error('[STRATEGY] Scanner error:', stratErr.message);
        }
      }

      // PRE-EARNINGS PUT SCANNER — disabled (strategy deleted, no validated edge)
      // Will be replaced when live scanners are rewritten for the 7 validated strategies.

      // Post-signal monitoring — check active signals for breakdowns
      await monitorActiveSignals(alpacaHdrs, dataUrl, profiles);

      // Options greeks monitoring on open paper trades
      try {
        await monitorOpenPositions(db);
      } catch (greeksErr) {
        console.error('[GREEKS] Monitor cycle error:', greeksErr.message);
      }

      // Continuation scoring — every 3rd cycle (~3 minutes) during market hours
      continuationCycle++;
      if (continuationCycle % 3 === 0 && session === 'REGULAR') {
        try {
          const openTrades = await db.query(`
            SELECT * FROM lc_v3.paper_trades
            WHERE status IN ('OPEN', 'WEAKENING')
              AND entry_contract_symbol IS NOT NULL
          `);
          for (const trade of openTrades.rows) {
            try {
              // Fetch recent 1-min bars for this ticker (last 30 bars)
              const barsRes = await axios.get(`${dataUrl}/v2/stocks/${trade.ticker}/bars`, {
                headers: alpacaHdrs,
                params: { timeframe: '1Min', limit: 30, feed: ALPACA_FEED },
                timeout: 5000,
              });
              const recentBars = (barsRes.data?.bars || []).map(b => ({
                open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
              }));

              // Market context: SPY change since this trade's entry
              const entrySpyPrice = parseFloat(trade.entry_stock_price) || 0;
              const currentSpySnap = allSnaps?.['SPY'];
              const spyNow = currentSpySnap?.latestTrade?.p || currentSpySnap?.dailyBar?.c || 0;
              const spyAtEntry = spyPct; // use today's SPY pct as proxy
              const mktCtx = {
                spyChangeSinceEntry: spyPct || 0,
                currentRegime: typeof currentRegime !== 'undefined' ? currentRegime : null,
              };

              // Update current stock price and unrealized P&L before scoring
              const currentStockPrice = recentBars.length > 0
                ? recentBars[recentBars.length - 1].close : 0;
              const entryStockPrice = parseFloat(trade.entry_stock_price) || 0;

              if (currentStockPrice > 0 && entryStockPrice > 0) {
                const dir = trade.direction === 'CALL' ? 1 : -1;
                const pnlPct = ((currentStockPrice - entryStockPrice) / entryStockPrice) * 100 * dir;
                const peakPnl = Math.max(parseFloat(trade.peak_pnl_pct) || 0, pnlPct);
                const maxAdverse = Math.min(parseFloat(trade.max_adverse_pnl_pct) || 0, pnlPct);

                // Check T1/T2/stop hits
                const t1 = parseFloat(trade.entry_t1) || 0;
                const t2 = parseFloat(trade.entry_t2) || 0;
                const stop = parseFloat(trade.entry_stop) || 0;
                const hitT1 = trade.hit_t1 || (t1 > 0 && ((dir === 1 && currentStockPrice >= t1) || (dir === -1 && currentStockPrice <= t1)));
                const hitT2 = trade.hit_t2 || (t2 > 0 && ((dir === 1 && currentStockPrice >= t2) || (dir === -1 && currentStockPrice <= t2)));
                const hitStop = trade.hit_stop || (stop > 0 && ((dir === 1 && currentStockPrice <= stop) || (dir === -1 && currentStockPrice >= stop)));

                await db.query(`
                  UPDATE lc_v3.paper_trades SET
                    current_stock_price = $1, unrealized_pnl_pct = $2,
                    peak_pnl_pct = $3, max_adverse_pnl_pct = $4,
                    hit_t1 = $5, hit_t2 = $6, hit_stop = $7,
                    last_updated = NOW()
                  WHERE paper_id = $8
                `, [currentStockPrice, pnlPct, peakPnl, maxAdverse,
                    hitT1, hitT2, hitStop, trade.paper_id]);

                // Patch the trade object so the scorer reads live values
                trade.current_stock_price = currentStockPrice;
                trade.unrealized_pnl_pct = pnlPct;
                trade.peak_pnl_pct = peakPnl;
                trade.hit_t1 = hitT1;
                trade.hit_t2 = hitT2;
                trade.hit_stop = hitStop;
              }

              const greeks = {
                delta: parseFloat(trade.current_delta) || 0,
                iv: parseFloat(trade.current_iv) || 0,
                spread: parseFloat(trade.current_spread) || 0,
                theta: parseFloat(trade.cumulative_theta) || 0,
              };

              await scoreContinuation(trade, recentBars, mktCtx, greeks, db);
            } catch (tradeErr) {
              console.warn(`[CONTINUATION] ${trade.ticker} error: ${tradeErr.message}`);
            }
          }
        } catch (contErr) {
          console.error('[CONTINUATION] Scorer error:', contErr.message);
        }
      }

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

        // 2) Any ACTIVE signal (except CONSEC_BOUNCE) with no human action and >15 min old → MISSED
        const missed = await db.query(`
          UPDATE lc_v3.signals SET status = 'MISSED',
            human_notes = COALESCE(human_notes, '') || ' | AUTO: NO_ACTION_15MIN'
          WHERE status = 'ACTIVE'
            AND human_taken IS NULL
            AND created_at < NOW() - INTERVAL '15 minutes'
            AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
            AND news_headline NOT LIKE '%strategy=CONSEC_BOUNCE%'
          RETURNING ticker
        `);
        for (const r of missed.rows) {
          console.log(`[AUTO] ${r.ticker} → MISSED (no action 15min)`);
        }

        // 2b) CONSEC_BOUNCE: ACTIVE for 2 trading days, then EXPIRED
        const consecExpired = await db.query(`
          UPDATE lc_v3.signals SET status = 'EXPIRED',
            human_notes = COALESCE(human_notes, '') || ' | AUTO: CONSEC_2DAY_EXPIRED'
          WHERE status = 'ACTIVE'
            AND human_taken IS NULL
            AND news_headline LIKE '%strategy=CONSEC_BOUNCE%'
            AND created_at < NOW() - INTERVAL '2 days'
          RETURNING ticker
        `);
        for (const r of consecExpired.rows) {
          console.log(`[AUTO] ${r.ticker} CONSEC_BOUNCE → EXPIRED (2 trading days)`);
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
  setInterval(poll, 15000);
  console.log('[LC v3] REST poller started — scoring every 15s');
}

// Strategy → minimum DTE for options contract selection
const STRATEGY_MIN_DTE = {
  // Income playbook (0DTE preferred)
  GAP_REVERSAL: 0,
  GAP_UP_REVERSAL: 0,
  SECTOR_ROTATION_BOUNCE: 0,
  BREAKDOWN_PUT: 0,
  RELATIVE_WEAKNESS_PUT: 0,
  OPENING_RANGE_BREAKOUT: 0,
  VWAP_RECLAIM: 0,
  // Alpha playbook
  CAPITULATION_BOUNCE: 1,
  CONSEC_BOUNCE: 3,
  PRE_EARNINGS_PUT: 7,
  POWER_HOUR: 0,             // 0DTE, expiring today
  CORRELATION_CASCADE: 1,    // cascade may take hours
  POST_MACRO: 1,             // post-macro trend runs all day
  FAILED_BREAKDOWN: 0,       // traps resolve fast
  // Disabled (spreads)
  VOL_DROP_PUT: 2,
  OVERNIGHT_CALENDAR: 1,
  CREDIT_SPREAD: 2,
};

// ── POST-SIGNAL MONITORING ────────────────────────────────────────────────────
async function monitorActiveSignals(alpacaHdrs, dataUrl, profiles) {
  try {
    const { monitorSignal } = await import('./src/scoring/intelligence.js');

    // Get all ACTIVE and WEAKENING signals from today
    const res = await db.query(`
      SELECT signal_id, ticker, direction, atr_multiple, grade, news_headline, contract_symbol
      FROM lc_v3.signals
      WHERE status IN ('ACTIVE','WEAKENING','PAPER_ONLY')
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

      // Refresh live contract quotes (bid/ask/mid/greeks) — NEVER touch t1/t2/t3/stop
      // Targets are locked at entry time. Only live market data updates here.
      try {
        if (signal.contract_symbol) {
          // Fetch live quote for the SAME contract that was selected at entry
          const quote = await fetchContractQuote(signal.contract_symbol);
          if (quote && quote.mid > 0) {
            await db.query(`
              UPDATE lc_v3.signals SET
                contract_bid = $1, contract_ask = $2, contract_mid = $3,
                contract_delta = $4, contract_iv = $5
              WHERE signal_id = $6
            `, [
              quote.bid, quote.ask, quote.mid,
              quote.delta, quote.iv,
              signal.signal_id,
            ]);
          }
        }
        // If no contract_symbol yet, skip — backfill handles initial selection
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
      SELECT signal_id, ticker, direction, grade, composite_raw, news_headline
      FROM lc_v3.signals
      WHERE contract_mid IS NULL
        AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
        AND status NOT IN ('TAKEN','SKIPPED')
    `);
    if (res.rows.length === 0) return;
    console.log(`[BACKFILL] ${res.rows.length} signals need contracts`);

    for (const row of res.rows) {
      try {
        const rowStrategy = ((row.news_headline || '').match(/strategy=(\w+)/) || [])[1] || '';
        const minDTE = STRATEGY_MIN_DTE[rowStrategy] ?? 0;
        const contract = await selectOptionsContract(row.ticker, row.direction, row.grade, 0, 0.025, { minDTE });
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

// ── GREEKS COLUMNS MIGRATION ─────────────────────────────────────────────────
(async () => {
  try {
    const greeksCols = [
      ['options_delta', 'NUMERIC'],
      ['options_gamma', 'NUMERIC'],
      ['options_theta', 'NUMERIC'],
      ['options_vega', 'NUMERIC'],
      ['options_iv', 'NUMERIC'],
      ['options_bid', 'NUMERIC'],
      ['options_ask', 'NUMERIC'],
      ['options_mid', 'NUMERIC'],
      ['options_volume', 'INTEGER'],
      ['options_open_interest', 'INTEGER'],
    ];
    for (const [col, type] of greeksCols) {
      await db.query(`ALTER TABLE lc_v3.signals ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
    console.log('[MIGRATE] Greeks columns ensured on lc_v3.signals');

    // Paper trades greeks monitoring columns
    const paperCols = [
      ['current_delta', 'NUMERIC'],
      ['current_iv', 'NUMERIC'],
      ['current_spread', 'NUMERIC'],
      ['cumulative_theta', 'NUMERIC'],
      ['greeks_updated_at', 'TIMESTAMPTZ'],
    ];
    for (const [col, type] of paperCols) {
      await db.query(`ALTER TABLE lc_v3.paper_trades ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
    console.log('[MIGRATE] Greeks monitor columns ensured on lc_v3.paper_trades');

    // Continuation scorer columns
    const contCols = [
      ['continuation_action', 'VARCHAR(20)'],
      ['continuation_reason', 'VARCHAR(40)'],
      ['continuation_details', 'JSONB'],
      ['continuation_scored_at', 'TIMESTAMPTZ'],
    ];
    for (const [col, type] of contCols) {
      await db.query(`ALTER TABLE lc_v3.paper_trades ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
    console.log('[MIGRATE] Continuation scorer columns ensured on lc_v3.paper_trades');

    // Strategy + auto-paper columns
    await db.query(`ALTER TABLE lc_v3.paper_trades ADD COLUMN IF NOT EXISTS strategy VARCHAR(50)`);
    await db.query(`ALTER TABLE lc_v3.paper_trades ADD COLUMN IF NOT EXISTS auto_traded BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE lc_v3.paper_trades ADD COLUMN IF NOT EXISTS position_size_pct NUMERIC`);
    console.log('[MIGRATE] strategy + auto_traded columns ensured on lc_v3.paper_trades');

    // bar_flow table for trade flow aggregation
    await db.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.bar_flow (
        ticker TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        buy_volume BIGINT NOT NULL DEFAULT 0,
        sell_volume BIGINT NOT NULL DEFAULT 0,
        total_trades INTEGER NOT NULL DEFAULT 0,
        buy_ratio NUMERIC,
        delta BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (ticker, ts)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_bar_flow_ts ON lc_v3.bar_flow(ts DESC)`);
    console.log('[MIGRATE] lc_v3.bar_flow table ensured');
  } catch (err) {
    console.error('[MIGRATE] Greeks columns error:', err.message);
  }
})();

// Run backfill 15s after startup, then every 5 min
setTimeout(backfillContracts, 15000);
setInterval(backfillContracts, 300000);
