/**
 * News Scorer — Claude Haiku Classification
 * Classifies historical news headlines for polarity and catalyst type.
 * Results are cached to avoid re-calling Claude on reruns.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const CACHE_FILE = './backtest-results/news-cache.json';

function hashHeadline(headline) {
  return createHash('md5').update(headline).digest('hex');
}

function loadCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    } catch { return {}; }
  }
  return {};
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Classify all news headlines using Claude Haiku.
 * @param {Object} newsByTickerDate - { "NVDA:2026-02-15": [{ headline, created_at, ... }] }
 * @returns {Object} - same structure but with polarity, catalyst_type, relevance added
 */
export async function classifyAllNews(newsByTickerDate) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[NEWS] No ANTHROPIC_API_KEY — skipping news scoring (all news scores will be 0)');
    return {};
  }

  const client = new Anthropic({ apiKey });
  const cache = loadCache();

  // Collect all unique headlines that need classification
  const toClassify = [];
  for (const [key, items] of Object.entries(newsByTickerDate)) {
    const ticker = key.split(':')[0];
    for (const item of items) {
      const hash = hashHeadline(item.headline);
      if (!cache[hash]) {
        toClassify.push({ ticker, headline: item.headline, hash });
      }
    }
  }

  const cached = Object.keys(cache).length;
  console.log(`[NEWS] ${cached} headlines cached, ${toClassify.length} need classification`);

  if (toClassify.length === 0) {
    return buildScoredNews(newsByTickerDate, cache);
  }

  // Batch classify — send up to 5 at a time
  let classified = 0;
  for (let i = 0; i < toClassify.length; i += 5) {
    const batch = toClassify.slice(i, i + 5);
    const results = await Promise.all(batch.map(async ({ ticker, headline, hash }) => {
      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: `Classify this news headline about ${ticker} for options trading impact. Respond with ONLY a JSON object, no other text.

{
  "polarity": <integer -2 to +2, where -2=strongly bearish, -1=bearish, 0=neutral, 1=bullish, 2=strongly bullish>,
  "catalyst_type": <one of: "earnings", "analyst", "macro", "product", "regulatory", "partnership", "sector", "other">,
  "relevance": <float 0.0 to 1.0, how material is this to ${ticker}'s stock price?>
}

Headline: "${headline.replace(/"/g, '\\"')}"`,
          }],
        });

        const text = response.content[0]?.text || '';
        const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
        return {
          hash,
          result: {
            polarity:     Math.max(-2, Math.min(2, parseInt(json.polarity) || 0)),
            catalyst_type: json.catalyst_type || 'other',
            relevance:    Math.max(0, Math.min(1, parseFloat(json.relevance) || 0.5)),
          },
        };
      } catch (err) {
        return {
          hash,
          result: { polarity: 0, catalyst_type: 'other', relevance: 0.3 },
        };
      }
    }));

    for (const { hash, result } of results) {
      cache[hash] = result;
    }
    classified += batch.length;

    if (classified % 50 === 0 || classified === toClassify.length) {
      console.log(`[NEWS] Classified ${classified}/${toClassify.length} headlines`);
      saveCache(cache); // Periodic save
    }
  }

  saveCache(cache);
  console.log(`[NEWS] Classification complete. Cache now has ${Object.keys(cache).length} entries.`);

  return buildScoredNews(newsByTickerDate, cache);
}

/**
 * Build the scored news map used by bar-replay.
 */
function buildScoredNews(newsByTickerDate, cache) {
  const scored = {};

  for (const [key, items] of Object.entries(newsByTickerDate)) {
    scored[key] = items.map(item => {
      const hash = hashHeadline(item.headline);
      const cls = cache[hash] || { polarity: 0, catalyst_type: 'other', relevance: 0.5 };
      return {
        headline:     item.headline,
        created_at:   item.created_at,
        polarity:     cls.polarity,
        catalyst_type: cls.catalyst_type,
        relevance:    cls.relevance,
      };
    });
  }

  return scored;
}

/**
 * Compute news score for a ticker at a given time.
 * Matches the src/scoring/news.js pattern.
 */
export function computeNewsScore(scoredNews, ticker, date, currentTime, direction) {
  const key = `${ticker}:${date}`;
  const items = scoredNews[key] || [];

  if (items.length === 0) return { score: 0, stackBonus: 0, headline: null };

  const now = new Date(currentTime).getTime();
  const twoHoursAgo = now - 2 * 3600 * 1000;

  // Filter to headlines from last 2 hours
  const recent = items.filter(n => {
    const t = new Date(n.created_at).getTime();
    return t >= twoHoursAgo && t <= now;
  });

  if (recent.length === 0) return { score: 0, stackBonus: 0, headline: null };

  // Score the most relevant/recent headline
  const primary = recent.sort((a, b) => {
    // Most relevant first, then most recent
    if (Math.abs(b.polarity) !== Math.abs(a.polarity)) return Math.abs(b.polarity) - Math.abs(a.polarity);
    return new Date(b.created_at) - new Date(a.created_at);
  })[0];

  const dirPolarity = direction === 'CALL' ? primary.polarity : -primary.polarity;

  // Base score from polarity
  const base = dirPolarity >= 2  ? 15
             : dirPolarity === 1 ? 9
             : dirPolarity === 0 ? 4
             : dirPolarity === -1 ? 0
             : -8;

  // Recency decay
  const ageHours = (now - new Date(primary.created_at).getTime()) / 3600000;
  const isStrong = Math.abs(primary.polarity) >= 2;
  const decay = isStrong
    ? (ageHours <= 2 ? 1.0 : ageHours <= 6 ? 0.75 : 0.50)
    : (ageHours <= 0.5 ? 1.0 : ageHours <= 1 ? 0.85 : ageHours <= 2 ? 0.65 : 0.40);

  const score = Math.max(-8, Math.min(15, Math.round(base * decay * primary.relevance)));

  // Stack bonus from additional confirming headlines
  let stackBonus = 0;
  for (let i = 1; i < recent.length && i < 4; i++) {
    const n = recent[i];
    const dp = direction === 'CALL' ? n.polarity : -n.polarity;
    if (dp > 0) {
      const marginal = i === 1 ? 2 : i === 2 ? 1.5 : 1;
      stackBonus += marginal;
    }
  }
  stackBonus = Math.min(5, Math.round(stackBonus));

  return { score, stackBonus, headline: primary.headline };
}
