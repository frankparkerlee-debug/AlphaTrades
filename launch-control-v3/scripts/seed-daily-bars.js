/**
 * Seed 2 years of daily OHLCV bars from Alpaca for all tracked tickers + SPY/QQQ/IWM.
 * Stores in lc_v3.daily_bars.
 *
 * Run: node scripts/seed-daily-bars.js
 */
import 'dotenv/config';
import axios from 'axios';
import { query } from '../src/data/db.js';

const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const FEED = process.env.ALPACA_FEED || 'sip';
const BATCH_SIZE = 5;
const BATCH_DELAY = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.daily_bars (
      ticker VARCHAR(10) NOT NULL,
      trade_date DATE NOT NULL,
      open DECIMAL(12,4) NOT NULL,
      high DECIMAL(12,4) NOT NULL,
      low DECIMAL(12,4) NOT NULL,
      close DECIMAL(12,4) NOT NULL,
      volume BIGINT NOT NULL,
      vwap DECIMAL(12,4),
      PRIMARY KEY (ticker, trade_date)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_daily_bars_ticker ON lc_v3.daily_bars(ticker, trade_date DESC)`);
  console.log('[DAILY] Table ready');
}

async function fetchDailyBars(ticker, start, end) {
  const allBars = [];
  let pageToken = null;

  do {
    const params = {
      timeframe: '1Day',
      start,
      end,
      feed: FEED,
      adjustment: 'split',
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

async function seedTicker(ticker, start, end) {
  const bars = await fetchDailyBars(ticker, start, end);
  if (bars.length === 0) return 0;

  for (let i = 0; i < bars.length; i += 100) {
    const batch = bars.slice(i, i + 100);
    const values = [];
    const params = [];
    let idx = 1;

    for (const b of batch) {
      const tradeDate = b.t.split('T')[0];
      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7})`);
      params.push(ticker, tradeDate, b.o, b.h, b.l, b.c, b.v || 0, b.vw || null);
      idx += 8;
    }

    await query(`
      INSERT INTO lc_v3.daily_bars (ticker, trade_date, open, high, low, close, volume, vwap)
      VALUES ${values.join(',')}
      ON CONFLICT (ticker, trade_date) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
        close = EXCLUDED.close, volume = EXCLUDED.volume, vwap = EXCLUDED.vwap
    `, params);
  }

  return bars.length;
}

async function main() {
  await migrate();

  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = [...profileRes.rows.map(r => r.ticker)];

  // Add index ETFs if not already in equity_profiles
  for (const etf of ['SPY', 'QQQ', 'IWM']) {
    if (!tickers.includes(etf)) tickers.push(etf);
  }
  console.log(`[DAILY] ${tickers.length} tickers to seed`);

  // 2 years back
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  const startDate = start.toISOString().split('T')[0];
  const endDate = end.toISOString().split('T')[0];
  console.log(`[DAILY] Range: ${startDate} → ${endDate}`);

  let totalBars = 0;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (ticker) => {
      try {
        const count = await seedTicker(ticker, startDate, endDate);
        console.log(`[DAILY] ${ticker} — ${count} days`);
        return count;
      } catch (err) {
        console.error(`[DAILY] ${ticker} — FAILED: ${err.message}`);
        return 0;
      }
    }));
    totalBars += results.reduce((a, b) => a + b, 0);

    if (i + BATCH_SIZE < tickers.length) {
      await sleep(BATCH_DELAY);
    }
  }

  console.log(`\n[DAILY] Total daily bars inserted: ${totalBars.toLocaleString()}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[DAILY] FATAL:', err.message);
  process.exit(1);
});
