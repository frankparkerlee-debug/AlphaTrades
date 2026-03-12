import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import { selectOptionsContract } from './src/options/contract-selector.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import cron from 'node-cron';
import { createServer } from 'http';

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
      first_seen_at:     s.first_seen_at?.toISOString()  || s.created_at?.toISOString(),
      last_confirmed_at: s.last_confirmed_at?.toISOString() || s.created_at?.toISOString(),
      confirmation_count: s.confirmation_count || 1,
      peak_composite:    Number(s.peak_composite) || Number(s.composite_raw) || 0,
      peak_grade:        s.peak_grade || s.grade,
      composite_history: s.composite_history || [],
      momentum_trend:    s.momentum_trend || null,
    }));
    res.json({ signals, count: signals.length });
  } catch (err) {
    console.error('Signals error:', err.message);
    res.json({ signals: [], error: err.message });
  }
});

// Debug — test contract selector on live server
app.get('/api/debug/contract/:ticker/:direction', async (req, res) => {
  const { ticker, direction } = req.params;
  try {
    const result = await selectOptionsContract(ticker, direction.toUpperCase(), 'B+', 100, 0.025);
    res.json({ ticker, direction, result });
  } catch (err) {
    res.json({ ticker, direction, error: err.message });
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

    res.json({ session, propagation: prop, streams, time: now.toISOString() });
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
// (no more pollerFired Set — dedup via DB lookup + UPSERT)

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

      console.log(`[POLL] ${Object.keys(allSnaps).length} snaps SPY=${(spyPct*100).toFixed(2)}% QQQ=${(qqqPct*100).toFixed(2)}%`);

      let written = 0, updated = 0;

      for (const [ticker, snap] of Object.entries(allSnaps)) {
        const price     = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
        const prevClose = snap.prevDailyBar?.c || 0;
        if (!price || !prevClose) continue;

        const changePct = (price - prevClose) / prevClose;
        const direction = changePct >= 0 ? 'CALL' : 'PUT';
        const absPct    = Math.abs(changePct);
        const atr       = parseFloat(profiles[ticker]?.atr_20d || 0.025);
        const atrMult   = atr > 0 ? absPct / atr : 0;

        const paScore  = Math.min(35, Math.round(atrMult * 15));
        const relVol   = snap.minuteBar?.v ? snap.minuteBar.v / 1000 : 1;
        const volScore = Math.min(30, Math.round(relVol));
        const spyOk    = direction === 'CALL' ? spyPct > 0 : spyPct < 0;
        const qqqOk    = direction === 'CALL' ? qqqPct > 0 : qqqPct < 0;
        const mktScore = (spyOk?7:0) + (qqqOk?7:0);
        const et2      = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
        const mins2    = et2.getHours()*60 + et2.getMinutes();
        const timScore = (mins2>=570 && mins2<960) ? 5 : 2;
        const composite = paScore + volScore + mktScore + timScore;

        let grade = toGrade(composite);
        if (!grade) continue;
        if (paScore < 17 || volScore < 14) continue;

        const isExt = session !== 'REGULAR';
        if (isExt && ['A+','A','A-'].includes(grade)) grade = 'B+';
        const sizePct = (POSITION_SZ[grade]||0.05) * (isExt?0.5:1.0);

        // Look up existing active signal for this ticker+direction today
        const existing = await db.query(
          `SELECT signal_id, composite_raw, peak_composite, peak_grade,
                  confirmation_count, composite_history, contract_mid,
                  human_taken
           FROM lc_v3.signals
           WHERE ticker=$1 AND direction=$2
             AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
             AND status NOT IN ('TAKEN','SKIPPED')
           ORDER BY created_at DESC LIMIT 1`,
          [ticker, direction]
        );

        // Get contract recommendation
        let contract = null;
        try {
          contract = await selectOptionsContract(ticker, direction, grade, price, atr);
        } catch (err) {
          console.error(`[contract] ${ticker}:`, err.message);
        }

        if (existing.rows.length > 0) {
          // ── UPDATE PATH (confirmation) ──
          const row = existing.rows[0];
          if (row.human_taken !== null) continue; // already acted on

          const oldPeak = row.peak_composite || row.composite_raw;
          const newPeak = Math.max(oldPeak, composite);
          const newPeakGrade = composite >= oldPeak ? grade : (row.peak_grade || grade);
          const count = (row.confirmation_count || 1) + 1;

          // Append to history (cap at 60)
          const history = Array.isArray(row.composite_history) ? [...row.composite_history] : [];
          history.push({ t: new Date().toISOString(), c: composite, g: grade });
          if (history.length > 60) history.splice(0, history.length - 60);

          // Compute trend from last 3
          let trend = 'STABLE';
          if (history.length >= 3) {
            const r3 = history.slice(-3).map(h => h.c);
            if (r3[2] > r3[0] + 2) trend = 'STRENGTHENING';
            else if (r3[2] < r3[0] - 2) trend = 'WEAKENING';
          }

          // Build contract update params if we have a better contract (or had none)
          const hasNewContract = contract && contract.mid > 0;
          const hadNoContract = !row.contract_mid || parseFloat(row.contract_mid) === 0;

          if (hasNewContract && hadNoContract) {
            // First time getting a real contract — include it
            await db.query(`
              UPDATE lc_v3.signals SET
                composite_raw=$1, grade=$2,
                score_price_action=$3, score_volume=$4, score_market=$5, score_timing=$6,
                peak_composite=$7, peak_grade=$8, confirmation_count=$9,
                composite_history=$10, momentum_trend=$11,
                last_confirmed_at=NOW(), expires_at=NOW()+INTERVAL '10 minutes',
                spy_change_pct=$12, qqq_change_pct=$13, relative_volume=$14, atr_multiple=$15,
                position_size_pct=$16, position_size_dollars=$17,
                contract_symbol=$18, contract_strike=$19, contract_expiry=$20, contract_expiry_label=$21,
                contract_bid=$22, contract_ask=$23, contract_mid=$24,
                contract_entry_lo=$25, contract_entry_hi=$26,
                contract_delta=$27, contract_iv=$28,
                contract_t1=$29, contract_t2=$30, contract_t3=$31, contract_stop=$32,
                contract_estimated=$33
              WHERE signal_id=$34
            `, [
              composite, grade, paScore, volScore, mktScore, timScore,
              newPeak, newPeakGrade, count, JSON.stringify(history), trend,
              spyPct, qqqPct, parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
              sizePct, Math.round(ACCOUNT_SIZE * sizePct),
              contract.symbol, contract.strike, contract.expiry, contract.expiry_label,
              contract.bid, contract.ask, contract.mid,
              contract.entry_lo, contract.entry_hi,
              contract.delta, contract.iv,
              contract.t1, contract.t2, contract.t3, contract.stop,
              contract.estimated || false,
              row.signal_id,
            ]);
          } else {
            // Update scores only, keep existing contract
            await db.query(`
              UPDATE lc_v3.signals SET
                composite_raw=$1, grade=$2,
                score_price_action=$3, score_volume=$4, score_market=$5, score_timing=$6,
                peak_composite=$7, peak_grade=$8, confirmation_count=$9,
                composite_history=$10, momentum_trend=$11,
                last_confirmed_at=NOW(), expires_at=NOW()+INTERVAL '10 minutes',
                spy_change_pct=$12, qqq_change_pct=$13, relative_volume=$14, atr_multiple=$15,
                position_size_pct=$16, position_size_dollars=$17
              WHERE signal_id=$18
            `, [
              composite, grade, paScore, volScore, mktScore, timScore,
              newPeak, newPeakGrade, count, JSON.stringify(history), trend,
              spyPct, qqqPct, parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
              sizePct, Math.round(ACCOUNT_SIZE * sizePct),
              row.signal_id,
            ]);
          }

          updated++;
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} (CONFIRM #${count}, peak=${newPeakGrade}/${newPeak}, ${trend})`);

        } else {
          // ── INSERT PATH (first sighting) ──
          const initHistory = JSON.stringify([{ t: new Date().toISOString(), c: composite, g: grade }]);
          await db.query(`
            INSERT INTO lc_v3.signals (
              ticker, direction, grade, status, composite_raw, signal_tier,
              score_price_action, score_volume, score_news, score_market, score_timing,
              position_size_pct, position_size_dollars,
              spy_change_pct, qqq_change_pct, relative_volume, atr_multiple,
              contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
              contract_bid, contract_ask, contract_mid,
              contract_entry_lo, contract_entry_hi,
              contract_delta, contract_iv,
              contract_t1, contract_t2, contract_t3, contract_stop,
              contract_estimated,
              first_seen_at, last_confirmed_at, confirmation_count,
              peak_composite, peak_grade, composite_history,
              expires_at, created_at
            ) VALUES ($1,$2,$3,'ACTIVE',$4,'primary',$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,
              $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
              NOW(), NOW(), 1, $4, $3, $31,
              NOW() + INTERVAL '10 minutes', NOW())
          `, [
            ticker, direction, grade, composite,
            paScore, volScore, mktScore, timScore,
            sizePct, Math.round(ACCOUNT_SIZE * sizePct),
            spyPct, qqqPct,
            parseFloat(relVol.toFixed(2)), parseFloat(atrMult.toFixed(2)),
            contract?.symbol || null, contract?.strike || null,
            contract?.expiry || null, contract?.expiry_label || null,
            contract?.bid || null, contract?.ask || null, contract?.mid || null,
            contract?.entry_lo || null, contract?.entry_hi || null,
            contract?.delta || null, contract?.iv || null,
            contract?.t1 || null, contract?.t2 || null, contract?.t3 || null,
            contract?.stop || null, contract?.estimated || false,
            initHistory,
          ]);

          written++;
          const cStr = contract ? ` | ${contract.label} mid=$${contract.mid}` : ' | no contract';
          console.log(`[SIGNAL] ${ticker} ${direction} ${grade} composite=${composite} (NEW)${cStr}`);
        }
      }

      if (written > 0 || updated > 0) console.log(`[POLL] ${written} new, ${updated} updated`);

    } catch(err) {
      console.error('[POLL] Error:', err.message);
    }
  }

  setTimeout(poll, 5000);
  setInterval(poll, 60000);
  console.log('[LC v3] REST poller started — scoring every 60s');
}
