/**
 * REST Polling Scorer — fallback when WebSocket isn't triggering scoring
 * Polls Alpaca snapshots every 60 seconds, scores all tickers, writes signals
 * Run: node scripts/poll-and-score.js
 */

import 'dotenv/config';
import { Pool } from 'pg';
import axios from 'axios';

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const alpaca = axios.create({
  baseURL: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
  headers: {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  },
  timeout: 15000,
});

const FEED = process.env.ALPACA_FEED || 'iex';
const ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || '7500');

const GRADE_SCALE = [[83,'A+'],[73,'A'],[63,'A-'],[53,'B+'],[43,'B']];
const POSITION_SIZE = {'A+':0.20,'A':0.15,'A-':0.10,'B+':0.075,'B':0.05};

function toGrade(score) {
  for (const [threshold, grade] of GRADE_SCALE) {
    if (score >= threshold) return grade;
  }
  return null;
}

// Market session check
function isMarketOpen() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 240 && mins < 1200; // 4am-8pm ET (includes extended hours)
}

function getSession() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return 'WEEKEND';
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 240  && mins < 570)  return 'PRE_MARKET';
  if (mins >= 570  && mins < 960)  return 'REGULAR';
  if (mins >= 960  && mins < 1200) return 'POST_MARKET';
  return 'OVERNIGHT';
}

// Simple but effective scoring
function scoreSnapshot(ticker, snap, marketSnap, profile) {
  const price     = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
  const prevClose = snap.prevDailyBar?.c || 0;

  if (!price || !prevClose) return null;

  const changePct = (price - prevClose) / prevClose;
  const direction = changePct >= 0 ? 'CALL' : 'PUT';
  const absPct    = Math.abs(changePct);

  // Price Action score (0-35)
  const atr = profile?.atr_20d || 0.025;
  const atrMultiple = absPct / atr;
  let paScore = Math.min(35, Math.round(atrMultiple * 15));

  // Volume score (0-30)
  const currentVol = snap.minuteBar?.v || 0;
  const avgVol     = profile?.avg_vol_by_window
    ? Object.values(profile.avg_vol_by_window).reduce((a,b)=>a+b,0) / 26
    : 0;
  const relVol = avgVol > 0 ? currentVol / (avgVol / 60) : 1;
  let volScore = Math.min(30, Math.round(relVol * 10));

  // Market score (0-15)
  const spySnap = marketSnap['SPY'];
  const qqqSnap = marketSnap['QQQ'];
  const spyPct  = spySnap ? ((spySnap.latestTrade?.p || 0) - (spySnap.prevDailyBar?.c || 0)) / (spySnap.prevDailyBar?.c || 1) : 0;
  const qqqPct  = qqqSnap ? ((qqqSnap.latestTrade?.p || 0) - (qqqSnap.prevDailyBar?.c || 0)) / (qqqSnap.prevDailyBar?.c || 1) : 0;

  const spyAligned = direction === 'CALL' ? spyPct > 0 : spyPct < 0;
  const qqqAligned = direction === 'CALL' ? qqqPct > 0 : qqqPct < 0;
  let mktScore = (spyAligned ? 6 : 0) + (qqqAligned ? 6 : 0);

  // Timing score (0-5)
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  let timScore = 5;
  if (mins < 570 || mins > 930) timScore = 2; // extended hours
  if (mins >= 720 && mins <= 780) timScore = 2; // lunch chop

  const composite = paScore + volScore + mktScore + timScore;
  const grade = toGrade(composite);

  if (!grade) return null;

  // Asymmetry gate
  if (paScore < 17.5 || volScore < 15) return null;

  const session = getSession();
  const isExtended = session !== 'REGULAR';
  const finalGrade = isExtended && ['A+','A','A-'].includes(grade) ? 'B+' : grade;
  const sizeMult   = isExtended ? 0.5 : 1.0;
  const sizePct    = (POSITION_SIZE[finalGrade] || 0.05) * sizeMult;

  return {
    ticker, direction, grade: finalGrade,
    composite_raw: composite,
    score_price_action: paScore,
    score_volume: volScore,
    score_news: 0,
    score_market: mktScore,
    score_timing: timScore,
    position_size_pct: sizePct,
    position_size_dollars: Math.round(ACCOUNT_SIZE * sizePct),
    spy_change_pct: spyPct,
    qqq_change_pct: qqqPct,
    relative_volume: parseFloat(relVol.toFixed(2)),
    atr_multiple: parseFloat(atrMultiple.toFixed(2)),
    price_at_signal: price,
    signal_tier: 'primary',
  };
}

// Track signals fired to avoid duplicates
const firedToday = new Set();

async function pollAndScore() {
  if (!isMarketOpen()) {
    console.log(`[POLL] Market closed — session=${getSession()}`);
    return;
  }

  console.log(`[POLL] Fetching snapshots...`);

  try {
    // Load profiles
    const profileRes = await db.query('SELECT * FROM lc_v3.equity_profiles');
    const profiles   = {};
    profileRes.rows.forEach(p => { profiles[p.ticker] = p; });
    const tickers    = Object.keys(profiles);

    // Fetch all snapshots in one call
    const batchSize = 50;
    const allSnaps  = {};

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const res   = await alpaca.get('/v2/stocks/snapshots', {
        params: { symbols: batch.join(','), feed: FEED },
      });
      Object.assign(allSnaps, res.data);
    }

    // Fetch market ETF snapshots
    const etfRes  = await alpaca.get('/v2/stocks/snapshots', {
      params: { symbols: 'SPY,QQQ,SMH,XLK', feed: FEED },
    });
    const mktSnap = etfRes.data;

    console.log(`[POLL] Got ${Object.keys(allSnaps).length} snapshots`);

    let signalsWritten = 0;

    for (const [ticker, snap] of Object.entries(allSnaps)) {
      const profile = profiles[ticker];
      if (!profile) continue;

      // Skip if already fired today
      const today = new Date().toISOString().split('T')[0];
      const key   = `${today}-${ticker}`;
      if (firedToday.has(key)) continue;

      const signal = scoreSnapshot(ticker, snap, mktSnap, profile);
      if (!signal) continue;

      try {
        await db.query(`
          INSERT INTO lc_v3.signals (
            ticker, direction, grade, status,
            composite_raw, signal_tier,
            score_price_action, score_volume, score_news, score_market, score_timing,
            position_size_pct, position_size_dollars,
            spy_change_pct, qqq_change_pct, relative_volume, atr_multiple,
            expires_at, created_at
          ) VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            NOW() + INTERVAL '5 minutes', NOW())
          ON CONFLICT DO NOTHING
        `, [
          signal.ticker, signal.direction, signal.grade,
          signal.composite_raw, signal.signal_tier,
          signal.score_price_action, signal.score_volume,
          signal.score_news, signal.score_market, signal.score_timing,
          signal.position_size_pct, signal.position_size_dollars,
          signal.spy_change_pct, signal.qqq_change_pct,
          signal.relative_volume, signal.atr_multiple,
        ]);

        firedToday.add(key);
        signalsWritten++;
        console.log(`[SIGNAL] ${signal.ticker} ${signal.direction} ${signal.grade} composite=${signal.composite_raw}`);
      } catch (err) {
        console.error(`[ERROR] Failed to write signal for ${signal.ticker}:`, err.message);
      }
    }

    console.log(`[POLL] Done — ${signalsWritten} signals written`);

  } catch (err) {
    console.error('[POLL] Error:', err.message);
  }
}

// Run immediately then every 60 seconds
console.log('[POLL] REST polling scorer started');
pollAndScore();
setInterval(pollAndScore, 60 * 1000);
