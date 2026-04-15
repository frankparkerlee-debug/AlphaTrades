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
  // Geopolitical-focused feeds — added after Iran/Pakistan miss April 2026.
  // These cover Middle East + South Asia events that Bloomberg/Reuters/AP
  // often pick up only after the market has already moved.
  {
    slug: 'dawn',
    name: 'Dawn (Pakistan)',
    url: 'https://www.dawn.com/feeds/home',
  },
  {
    slug: 'bbc_mideast',
    name: 'BBC Middle East',
    url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',
  },
];

// Key terms that suggest a headline is market-moving enough to spend an LLM
// call on. Rest are still ingested but classified NULL (can be backfilled).
//
// IMPORTANT: This list must be broad. Missing a keyword = missing a market
// move (Iran/Pakistan delegation, blockade, negotiation breakdown all missed
// in the April 2026 incident because the terms weren't here).
const MARKET_KEYWORDS = [
  // Macro / econ
  'cpi', 'inflation', 'fed', 'fomc', 'powell', 'rate hike', 'rate cut',
  'jobs', 'payroll', 'unemployment', 'gdp', 'recession', 'ppi',
  'retail sales', 'consumer confidence', 'ism ', 'pmi', 'housing',
  'interest rate', 'monetary policy', 'fiscal', 'debt ceiling',
  'default', 'treasury', 'yield', 'inversion',
  // Geopolitics — countries & regions
  'iran', 'pakistan', 'india', 'russia', 'ukraine', 'china', 'taiwan',
  'israel', 'gaza', 'palestine', 'saudi', 'iraq', 'syria', 'yemen',
  'houthi', 'hezbollah', 'north korea', 'south korea', 'japan',
  'turkey', 'egypt', 'libya', 'venezuela', 'mexico', 'brazil',
  'islamabad', 'tehran', 'moscow', 'beijing', 'taipei', 'kyiv',
  'jerusalem', 'riyadh', 'pyongyang',
  // Geopolitics — actions & events
  'delegation', 'negotiation', 'talks', 'summit', 'diplomacy',
  'diplomatic', 'blockade', 'embargo', 'sanction', 'tariff', 'trade war',
  'ceasefire', 'truce', 'peace', 'war ', 'conflict', 'invasion',
  'escalat', 'de-escalat', 'tension', 'crisis', 'standoff',
  'strike', 'missile', 'drone', 'attack', 'bomb', 'shell',
  'strait', 'hormuz', 'suez', 'shipping', 'tanker', 'naval',
  'military', 'troops', 'deploy', 'nato', 'nuclear', 'uranium',
  'enrichment', 'weapons', 'defense', 'pentagon', 'state dept',
  'un security', 'united nations', 'iaea',
  // Energy / commodities
  'opec', 'oil', 'crude', 'brent', 'wti', 'natural gas', 'lng',
  'pipeline', 'refinery', 'energy', 'gold', 'copper', 'lithium',
  'rare earth', 'grain', 'wheat', 'commodity',
  // Markets / corporate
  'stocks', 'market', 'rally', 'crash', 'selloff', 'sell-off',
  'correction', 'bear market', 'bull market', 'volatility', 'vix',
  'bond', 'dollar', 'euro', 'yen', 'yuan', 'bitcoin', 'crypto',
  'earnings', 'guidance', 'buyback', 'dividend', 'merger',
  'acquisition', 'ipo', 'bankrupt', 'layoff', 'restructur',
  // Regulatory
  'sec ', 'doj', 'fda', 'ftc', 'antitrust', 'investigation',
  'lawsuit', 'subpoena', 'fine', 'settlement', 'regulation',
  // Political — US
  'white house', 'congress', 'senate', 'house of rep', 'executive order',
  'trump', 'biden', 'harris', 'yellen', 'president', 'veto',
  'shutdown', 'appropriation', 'bipartisan',
  // Supply chain / trade
  'supply chain', 'chip', 'semiconductor', 'export control', 'ban',
  'restrict', 'quota', 'port', 'freight', 'container',
];

// Sources that are already editorially filtered — classify ALL items from
// these feeds regardless of keyword match. They publish few items and the
// signal-to-noise ratio is high enough to justify the extra LLM cost.
const CLASSIFY_ALL_SOURCES = new Set(['aljazeera', 'afp', 'ft', 'bloomberg', 'dawn', 'bbc_mideast']);

function worthClassifying(title, description, sourceSlug) {
  // Editorially tight sources: always classify
  if (CLASSIFY_ALL_SOURCES.has(sourceSlug)) return true;
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
      if (worthClassifying(title, description, src.slug)) {
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
