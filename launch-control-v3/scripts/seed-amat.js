/**
 * One-off: reseed AMAT 1-min bars (failed during full seed due to connection timeout).
 * Run: node scripts/seed-amat.js
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
  if (mins >= 240 && mins < 570) return 'PRE_MARKET';
  if (mins >= 570 && mins < 960) return 'REGULAR';
  if (mins >= 960 && mins < 1200) return 'POST_MARKET';
  return null;
}

async function main() {
  const ticker = 'AMAT';
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 180);

  console.log(`[SEED] Reseeding ${ticker} from ${start.toISOString().split('T')[0]} → ${end.toISOString().split('T')[0]}`);

  const allBars = [];
  let pageToken = null;
  do {
    const params = {
      timeframe: '1Min', start: start.toISOString(), end: end.toISOString(),
      feed: FEED, adjustment: 'raw', limit: 10000,
    };
    if (pageToken) params.page_token = pageToken;
    const res = await axios.get(`${DATA_URL}/v2/stocks/${ticker}/bars`, {
      headers: HEADERS, params, timeout: 60000,
    });
    allBars.push(...(res.data?.bars || []));
    pageToken = res.data?.next_page_token || null;
  } while (pageToken);

  const tradeBars = allBars.filter(b => classifySession(b.t));
  console.log(`[SEED] ${ticker}: ${tradeBars.length} tradeable bars fetched`);

  for (let i = 0; i < tradeBars.length; i += 100) {
    const batch = tradeBars.slice(i, i + 100);
    const values = [];
    const params = [];
    let idx = 1;
    for (const b of batch) {
      const session = classifySession(b.t);
      const windowKey = toETWindowKey(b.t);
      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9})`);
      params.push(ticker, b.t, b.o, b.h, b.l, b.c, b.v || 0, b.vw || b.c, session, windowKey);
      idx += 10;
    }
    await query(`
      INSERT INTO lc_v3.bars (ticker, ts, open, high, low, close, volume, vwap, session, window_key)
      VALUES ${values.join(',')}
      ON CONFLICT (ticker, ts) DO NOTHING
    `, params);
  }

  console.log(`[SEED] ${ticker}: ${tradeBars.length} bars inserted`);

  // Update volume baselines for AMAT
  const blRes = await query(`
    INSERT INTO lc_v3.volume_baselines (ticker, window_key, avg_volume, median_volume, sample_count)
    SELECT ticker, window_key,
      ROUND(AVG(volume))::BIGINT,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY volume)::BIGINT,
      COUNT(DISTINCT DATE(ts))
    FROM lc_v3.bars
    WHERE ticker = $1 AND session = 'REGULAR' AND window_key IS NOT NULL
    GROUP BY ticker, window_key
    HAVING COUNT(*) >= 3
    ON CONFLICT (ticker, window_key) DO UPDATE SET
      avg_volume = EXCLUDED.avg_volume, median_volume = EXCLUDED.median_volume,
      sample_count = EXCLUDED.sample_count, last_updated = NOW()
    RETURNING window_key
  `, [ticker]);
  console.log(`[SEED] ${ticker}: ${blRes.rowCount} baseline windows updated`);
  process.exit(0);
}

main().catch(err => { console.error('[SEED] FATAL:', err.message); process.exit(1); });
