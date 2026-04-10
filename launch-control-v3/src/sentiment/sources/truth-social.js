/**
 * Truth Social adapter.
 *
 * No official API. Primary path is trumpstruth.org -- a public mirror that
 * exposes Trump's Truth Social feed as RSS. Verified working 2026-04-09
 * at /feed endpoint (200, 170KB, valid RSS 2.0).
 *
 * Rationale for emphasis: Trump posts directly move SPY, XLE, defense names,
 * and macro risk sentiment with little lag. Post -> price often < 10 min.
 * Every post gets sent to Claude Haiku regardless of keyword filter because
 * the market-impact-per-post rate is very high.
 *
 * Fallbacks to consider later if trumpstruth.org goes dark:
 *   - rsshub.app/truthsocial/user/realDonaldTrump (self-host rsshub on Render)
 *   - truthbrush scraper (stanfordio/truthbrush, Python, ToS-adjacent)
 */
import axios from 'axios';
import { parseRSS } from '../rss-parser.js';
import { classifySentiment } from '../classifier.js';
import { upsertSentimentEvent } from '../store.js';

const FEED_URL = 'https://trumpstruth.org/feed';

async function fetchFeed() {
  try {
    const r = await axios.get(FEED_URL, {
      timeout: 12000,
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (AlphaTradesV3 sentiment ingestor)',
      },
      validateStatus: () => true,
      responseType: 'text',
    });
    if (r.status !== 200) return null;
    return r.data;
  } catch {
    return null;
  }
}

/**
 * Poll Truth Social feed once. Every post gets classified -- no keyword
 * filter -- because the base rate of market-relevant content is extremely high.
 */
export async function pollTruthSocial() {
  const xml = await fetchFeed();
  if (!xml) {
    return { fetched: 0, inserted: 0, classified: 0, error: 'fetch_failed' };
  }
  const items = parseRSS(xml);
  let inserted = 0;
  let classified = 0;

  for (const item of items) {
    const title = item.title || '';
    const description = item.description || '';
    const link = item.link || '';
    const pub = item.pubDate || new Date();
    const text = description || title;

    // Every post is classified. Trump posts are the whole point of this source.
    const classification = await classifySentiment({
      source: 'truth_social',
      title,
      text: text.slice(0, 600),
      author: item.author || 'realDonaldTrump',
    });
    classified++;

    const ok = await upsertSentimentEvent({
      source: 'truth_social',
      source_id: item.id || link || `truth:${title.slice(0, 80)}`,
      author: item.author || 'realDonaldTrump',
      url: link,
      title,
      text: text.slice(0, 2000),
      raw_ts: pub,
      classification,
    });
    if (ok) inserted++;
  }

  return { fetched: items.length, inserted, classified };
}
