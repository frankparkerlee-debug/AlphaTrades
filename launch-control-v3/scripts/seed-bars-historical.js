/**
 * Seed historical 1-min bars for all tracked tickers (last 20 trading days)
 * and compute volume baselines per ticker per 15-min window.
 *
 * Run: node scripts/seed-bars-historical.js
 */
import 'dotenv/config';
import axios from 'axios';
import { query } from '../src/data/db.js';

const DATA_URL   = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const HEADERS    = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const FEED       = process.env.ALPACA_FEED || 'sip';
const BATCH_SIZE = 5;
const BATCH_DELAY = 500; // ms between batches

// ── Create tables if needed ──────────────────────────────────────────────────

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.bars (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      open NUMERIC NOT NULL,
      high NUMERIC NOT NULL,
      low NUMERIC NOT NULL,
      close NUMERIC NOT NULL,
      volume BIGINT NOT NULL,
      vwap NUMERIC,
      session TEXT DEFAULT 'REGULAR',
      window_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_bars_ticker_ts ON lc_v3.bars(ticker, ts)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bars_ticker_window ON lc_v3.bars(ticker, window_key)`);

  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.volume_baselines (
      ticker TEXT NOT NULL,
      window_key TEXT NOT NULL,
      avg_volume NUMERIC NOT NULL,
      sample_days INT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (ticker, window_key)
    )
  `);

  console.log('[SEED] Tables ready');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function floorTo15Min(date) {
  const h = date.getUTCHours().toString().padStart(2, '0');
  const m = (Math.floor(date.getUTCMinutes() / 15) * 15).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function toETWindowKey(isoTimestamp) {
  // Convert to ET and floor to 15 min
  const d = new Date(isoTimestamp);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours().toString().padStart(2, '0');
  const m = (Math.floor(et.getMinutes() / 15) * 15).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function isRegularHoursET(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30 - 16:00
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Fetch bars with pagination ───────────────────────────────────────────────

async function fetchBars(ticker, start, end) {
  const allBars = [];
  let pageToken = null;

  do {
    const params = {
      timeframe: '1Min',
      start: `${start}T00:00:00Z`,
      end: `${end}T23:59:59Z`,
      feed: FEED,
      limit: 10000,
    };
    if (pageToken) params.page_token = pageToken;

    const res = await axios.get(`${DATA_URL}/v2/stocks/${ticker}/bars`, {
      headers: HEADERS, params, timeout: 30000,
    });
    const bars = res.data?.bars || [];
    allBars.push(...bars);
    pageToken = res.data?.next_page_token || null;
  } while (pageToken);

  return allBars;
}

// ── Insert bars for a single ticker ──────────────────────────────────────────

async function seedTicker(ticker, start, end) {
  const bars = await fetchBars(ticker, start, end);

  // Filter to regular hours only
  const regularBars = bars.filter(b => isRegularHoursET(b.t));

  if (regularBars.length === 0) return 0;

  // Batch insert (100 at a time to avoid huge queries)
  for (let i = 0; i < regularBars.length; i += 100) {
    const batch = regularBars.slice(i, i + 100);
    const values = [];
    const params = [];
    let idx = 1;

    for (const b of batch) {
      const windowKey = toETWindowKey(b.t);
      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},'REGULAR',$${idx+8})`);
      params.push(ticker, b.t, b.o, b.h, b.l, b.c, b.v || 0, b.vw || b.c, windowKey);
      idx += 9;
    }

    await query(`
      INSERT INTO lc_v3.bars (ticker, ts, open, high, low, close, volume, vwap, session, window_key)
      VALUES ${values.join(',')}
      ON CONFLICT DO NOTHING
    `, params);
  }

  return regularBars.length;
}

// ── Compute volume baselines ─────────────────────────────────────────────────

async function computeBaselines() {
  const res = await query(`
    INSERT INTO lc_v3.volume_baselines (ticker, window_key, avg_volume, sample_days, updated_at)
    SELECT
      ticker,
      window_key,
      AVG(volume)::NUMERIC(12,2),
      COUNT(DISTINCT ts::date),
      NOW()
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
    GROUP BY ticker, window_key
    ON CONFLICT (ticker, window_key) DO UPDATE SET
      avg_volume = EXCLUDED.avg_volume,
      sample_days = EXCLUDED.sample_days,
      updated_at = NOW()
    RETURNING ticker, window_key
  `);
  return res.rowCount;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await migrate();

  // Get all tickers
  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = profileRes.rows.map(r => r.ticker);
  console.log(`[SEED] ${tickers.length} tickers to seed`);

  // Date range: 20 trading days ago ≈ 30 calendar days
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  const startDate = start.toISOString().split('T')[0];
  const endDate = end.toISOString().split('T')[0];
  console.log(`[SEED] Range: ${startDate} → ${endDate}`);

  let totalBars = 0;

  // Process in batches of 5
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (ticker) => {
      try {
        const count = await seedTicker(ticker, startDate, endDate);
        console.log(`[SEED] ${ticker} — ${count} bars inserted`);
        return count;
      } catch (err) {
        console.error(`[SEED] ${ticker} — FAILED: ${err.message}`);
        return 0;
      }
    }));
    totalBars += results.reduce((a, b) => a + b, 0);

    if (i + BATCH_SIZE < tickers.length) {
      await sleep(BATCH_DELAY);
    }
  }

  console.log(`\n[SEED] Total bars inserted: ${totalBars.toLocaleString()}`);

  // Compute volume baselines
  console.log('[SEED] Computing volume baselines...');
  const baselinePairs = await computeBaselines();
  console.log(`[SEED] Total baseline pairs computed: ${baselinePairs.toLocaleString()}`);

  process.exit(0);
}

main().catch(err => {
  console.error('[SEED] FATAL:', err.message);
  process.exit(1);
});
