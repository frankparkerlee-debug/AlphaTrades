/**
 * StockTwits adapter.
 *
 * Pulls from the public unauthenticated REST API. Verified working 2026-04-09
 * at ~7-8 msgs/min on SPY with full metadata (body, user, followers, sentiment,
 * symbols, timestamps, cursor pagination).
 *
 * Endpoints used:
 *   - /api/2/streams/symbol/{TICKER}.json   (per-ticker stream)
 *   - /api/2/streams/trending.json          (cross-ticker trending)
 *
 * Rate limit is ~200 req/hour unauthenticated. Default polling schedule
 * stays well under: 4 ETFs + trending every 2 min = 150 req/hour.
 */
import axios from 'axios';
import { classifySentiment } from '../classifier.js';
import { upsertSentimentEvent } from '../store.js';

const BASE = 'https://api.stocktwits.com/api/2';

// ETFs + high-interest names. Keep tight to respect rate limits.
// Tune this list later by reading from lc_v3.equity_profiles watchlist.
const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Only classify messages from users with this many followers OR with a
// user-declared Bullish/Bearish tag. Avoids wasting LLM budget on pure noise.
const CLASSIFY_MIN_FOLLOWERS = 500;

function mapRawSentiment(msg) {
  const s = msg.entities?.sentiment?.basic;
  if (s === 'Bullish' || s === 'Bearish') return s;
  return null;
}

function shouldClassify(msg) {
  const followers = msg.user?.followers || 0;
  if (followers >= CLASSIFY_MIN_FOLLOWERS) return true;
  if (mapRawSentiment(msg)) return true; // user-declared sentiment means user is engaging actively
  // Link-bearing or news-shaped posts are worth a look
  const body = (msg.body || '').toLowerCase();
  if (body.includes('breaking') || body.includes('http')) return true;
  return false;
}

async function fetchStream(url) {
  const r = await axios.get(url, {
    timeout: 10000,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (AlphaTradesV3 sentiment ingestor)',
    },
    validateStatus: () => true,
  });
  if (r.status !== 200 || !r.data?.messages) {
    return { ok: false, status: r.status, messages: [] };
  }
  return { ok: true, status: 200, messages: r.data.messages };
}

/**
 * Fetch + ingest messages for a set of tickers + the trending stream.
 * @returns {Promise<{fetched:number, inserted:number, classified:number}>}
 */
export async function pollStockTwits(tickers = DEFAULT_TICKERS) {
  let fetched = 0;
  let inserted = 0;
  let classified = 0;

  const urls = [
    ...tickers.map(t => ({ url: `${BASE}/streams/symbol/${encodeURIComponent(t)}.json`, hint: [t] })),
    { url: `${BASE}/streams/trending.json`, hint: null },
  ];

  for (const { url, hint } of urls) {
    try {
      const r = await fetchStream(url);
      if (!r.ok) continue;
      for (const msg of r.messages) {
        fetched++;
        const symbols = (msg.symbols || []).map(s => s.symbol).filter(Boolean);
        const hintTickers = hint || symbols;

        // Classify only if the message passes the noise filter -- otherwise
        // store the raw event unclassified (still ingested, can be backfilled)
        let classification = null;
        if (shouldClassify(msg)) {
          classification = await classifySentiment({
            source: 'stocktwits',
            text: msg.body || '',
            author: msg.user?.username,
            followers: msg.user?.followers,
            hint_tickers: hintTickers,
          });
          classified++;
        }

        const ok = await upsertSentimentEvent({
          source: 'stocktwits',
          source_id: String(msg.id),
          author: msg.user?.username || null,
          author_followers: msg.user?.followers || null,
          url: `https://stocktwits.com/${msg.user?.username || ''}/message/${msg.id}`,
          text: msg.body || '',
          raw_ts: new Date(msg.created_at),
          engagement: msg.likes?.total || 0,
          raw_sentiment: mapRawSentiment(msg),
          classification,
        });
        if (ok) inserted++;
      }
    } catch (err) {
      // Never throw out of the poller -- log and keep going
      console.error(`[stocktwits] ${url}: ${err.message}`);
    }
  }

  return { fetched, inserted, classified };
}
