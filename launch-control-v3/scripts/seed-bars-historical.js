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
const BATCH_DELAY = 300; // ms between batches

// ── Create / migrate tables ─────────────────────────────────────────────────

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
  // Unique constraint to prevent duplicate bars
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bars_ticker_ts_uniq ON lc_v3.bars(ticker, ts)`);

  // Volume baselines — updated schema with median + sample_count
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.volume_baselines (
      ticker TEXT NOT NULL,
      window_key TEXT NOT NULL,
      avg_volume BIGINT NOT NULL DEFAULT 0,
      median_volume BIGINT NOT NULL DEFAULT 0,
      sample_count INT NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (ticker, window_key)
    )
  `);

  // Migrate from old schema — drop deprecated columns, add new ones
  await query(`ALTER TABLE lc_v3.volume_baselines ADD COLUMN IF NOT EXISTS median_volume BIGINT NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE lc_v3.volume_baselines ADD COLUMN IF NOT EXISTS sample_count INT NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE lc_v3.volume_baselines ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ DEFAULT NOW()`);
  await query(`ALTER TABLE lc_v3.volume_baselines DROP COLUMN IF EXISTS sample_days`);
  await query(`ALTER TABLE lc_v3.volume_baselines DROP COLUMN IF EXISTS updated_at`);
  // Ensure avg_volume is BIGINT (old schema used NUMERIC)
  await query(`ALTER TABLE lc_v3.volume_baselines ALTER COLUMN avg_volume TYPE BIGINT USING avg_volume::BIGINT`);

  console.log('[SEED] Tables ready');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toETWindowKey(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours().toString().padStart(2, '0');
  const m = (Math.floor(et.getMinutes() / 15) * 15).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function classifySession(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 240 && mins < 570)  return 'PRE_MARKET';   // 04:00-09:30
  if (mins >= 570 && mins < 960)  return 'REGULAR';       // 09:30-16:00
  if (mins >= 960 && mins < 1200) return 'POST_MARKET';   // 16:00-20:00
  return null; // outside tradeable hours — skip
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Fetch bars with pagination ───────────────────────────────────────────────

async function fetchBars(ticker, start, end) {
  const allBars = [];
  let pageToken = null;

  do {
    const params = {
      timeframe: '1Min',
      start,
      end,
      feed: FEED,
      adjustment: 'raw',
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

  // Classify session and filter to tradeable hours only
  const tradeBars = [];
  for (const b of bars) {
    const session = classifySession(b.t);
    if (session) tradeBars.push({ ...b, session });
  }

  if (tradeBars.length === 0) return 0;

  // Batch insert (100 at a time)
  for (let i = 0; i < tradeBars.length; i += 100) {
    const batch = tradeBars.slice(i, i + 100);
    const values = [];
    const params = [];
    let idx = 1;

    for (const b of batch) {
      const windowKey = toETWindowKey(b.t);
      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9})`);
      params.push(ticker, b.t, b.o, b.h, b.l, b.c, b.v || 0, b.vw || b.c, b.session, windowKey);
      idx += 10;
    }

    await query(`
      INSERT INTO lc_v3.bars (ticker, ts, open, high, low, close, volume, vwap, session, window_key)
      VALUES ${values.join(',')}
      ON CONFLICT (ticker, ts) DO NOTHING
    `, params);
  }

  return tradeBars.length;
}

// ── Compute volume baselines ─────────────────────────────────────────────────

async function computeBaselines() {
  const res = await query(`
    INSERT INTO lc_v3.volume_baselines (ticker, window_key, avg_volume, median_volume, sample_count)
    SELECT
      ticker,
      window_key,
      ROUND(AVG(volume))::BIGINT,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY volume)::BIGINT,
      COUNT(DISTINCT DATE(ts))
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
      AND window_key IS NOT NULL
    GROUP BY ticker, window_key
    HAVING COUNT(*) >= 3
    ON CONFLICT (ticker, window_key) DO UPDATE SET
      avg_volume = EXCLUDED.avg_volume,
      median_volume = EXCLUDED.median_volume,
      sample_count = EXCLUDED.sample_count,
      last_updated = NOW()
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
  const startDate = start.toISOString();
  const endDate = end.toISOString();
  console.log(`[SEED] Range: ${startDate.split('T')[0]} → ${endDate.split('T')[0]}`);

  // Clear old bars to avoid bloat on re-runs
  const delRes = await query(`DELETE FROM lc_v3.bars WHERE ts < NOW() - INTERVAL '31 days'`);
  if (delRes.rowCount > 0) console.log(`[SEED] Cleaned ${delRes.rowCount} old bars`);

  let totalBars = 0;

  // Process in batches of 5
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (ticker) => {
      try {
        const count = await seedTicker(ticker, startDate, endDate);
        console.log(`[SEED] ${ticker} — ${count} bars`);
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
