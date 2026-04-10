/**
 * News RSS adapter.
 *
 * Six cited sources, all verified working 2026-04-09:
 *
 *   Reuters    -- via Google News RSS (Reuters killed their own feed)
 *                 https://news.google.com/rss/search?q=site:reuters.com+business
 *   AP         -- via Google News RSS (AP killed their own feed)
 *                 https://news.google.com/rss/search?q=site:apnews.com
 *   AFP        -- direct RSS: https://www.afp.com/en/rss.xml
 *   Al Jazeera -- direct RSS: https://www.aljazeera.com/xml/rss/all.xml
 *   Bloomberg  -- direct RSS: https://feeds.bloomberg.com/markets/news.rss
 *   FT         -- direct RSS: https://www.ft.com/rss/home
 *
 * Each feed is polled every 2 min. Headlines that pass the "worth classifying"
 * heuristic are sent to Claude Haiku; the rest are still stored so they can
 * be backfilled if we decide to reclassify with Sonnet later.
 */
import axios from 'axios';
import { parseRSS } from '../rss-parser.js';
import { classifySentiment } from '../classifier.js';
import { upsertSentimentEvent } from '../store.js';

// Source registry -- single source of truth for all RSS feeds we ingest.
// Tune the "worth classifying" threshold per-source in NOISE_FILTER below.
export const NEWS_SOURCES = [
  {
    slug: 'reuters',
    name: 'Reuters (via Google News)',
    url: 'https://news.google.com/rss/search?q=site%3Areuters.com+when%3A2d&hl=en-US&gl=US&ceid=US:en',
  },
  {
    slug: 'ap',
    name: 'Associated Press (via Google News)',
    url: 'https://news.google.com/rss/search?q=site%3Aapnews.com+when%3A2d&hl=en-US&gl=US&ceid=US:en',
  },
  {
    slug: 'afp',
    name: 'Agence France-Presse',
    url: 'https://www.afp.com/en/rss.xml',
  },
  {
    slug: 'aljazeera',
    name: 'Al Jazeera English',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
  },
  {
    slug: 'bloomberg',
    name: 'Bloomberg Markets',
    url: 'https://feeds.bloomberg.com/markets/news.rss',
  },
  {
    slug: 'ft',
    name: 'Financial Times Home',
    url: 'https://www.ft.com/rss/home',
  },
];

// Key terms that suggest a headline is market-moving enough to spend an LLM
// call on. Rest are still ingested but classified NULL (can be backfilled).
const MARKET_KEYWORDS = [
  // Macro / econ
  'cpi', 'inflation', 'fed', 'fomc', 'powell', 'rate hike', 'rate cut', 'jobs', 'payroll', 'unemployment', 'gdp', 'recession', 'ppi', 'retail sales',
  // Geopolitics
  'iran', 'russia', 'ukraine', 'china', 'taiwan', 'israel', 'gaza', 'opec', 'sanction', 'tariff', 'ceasefire', 'strike', 'missile', 'nato', 'nuclear',
  // Corporate / markets
  'stocks', 'market', 'bond', 'dollar', 'oil', 'crude', 'gold', 'bitcoin', 'earnings', 'guidance', 'buyback', 'merger', 'acquisition', 'ipo', 'bankrupt',
  // Regulatory
  'sec', 'doj', 'fda', 'antitrust', 'investigation', 'lawsuit', 'subpoena', 'fine', 'settlement',
  // Major political / Fed chair
  'yellen', 'treasury', 'white house', 'congress', 'senate', 'trump', 'biden', 'harris',
];

function worthClassifying(title, description) {
  const t = ((title || '') + ' ' + (description || '')).toLowerCase();
  if (!t.trim()) return false;
  return MARKET_KEYWORDS.some(kw => t.includes(kw));
}

async function fetchFeed(url) {
  try {
    const r = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (AlphaTradesV3 sentiment ingestor)',
      },
      validateStatus: () => true,
      responseType: 'text',
      maxRedirects: 5,
    });
    if (r.status !== 200) return null;
    return r.data;
  } catch {
    return null;
  }
}

/**
 * Poll all news RSS sources once.
 */
export async function pollNewsRSS() {
  let fetched = 0;
  let inserted = 0;
  let classified = 0;
  const bySource = {};

  for (const src of NEWS_SOURCES) {
    const xml = await fetchFeed(src.url);
    if (!xml) {
      bySource[src.slug] = { fetched: 0, inserted: 0, error: 'fetch_failed' };
      continue;
    }
    const items = parseRSS(xml);
    let srcInserted = 0;
    let srcClassified = 0;

    for (const item of items) {
      fetched++;
      const title = item.title || '';
      const description = item.description || '';
      const link = item.link || '';
      const pub = item.pubDate || new Date();

      let classification = null;
      if (worthClassifying(title, description)) {
        classification = await classifySentiment({
          source: src.slug,
          title,
          text: description.slice(0, 600),
          author: item.author || src.name,
        });
        classified++;
        srcClassified++;
      }

      const ok = await upsertSentimentEvent({
        source: src.slug,
        source_id: item.id || link || `${src.slug}:${title.slice(0, 80)}`,
        author: item.author || src.name,
        url: link,
        title,
        text: description.slice(0, 2000),
        raw_ts: pub,
        classification,
      });
      if (ok) {
        inserted++;
        srcInserted++;
      }
    }
    bySource[src.slug] = { fetched: items.length, inserted: srcInserted, classified: srcClassified };
  }

  return { fetched, inserted, classified, bySource };
}
