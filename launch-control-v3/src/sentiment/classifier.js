/**
 * Sentiment classifier -- turns raw headlines / posts into structured
 * market-impact records via Claude Haiku. Used by all sentiment sources
 * (StockTwits, News RSS, Truth Social).
 *
 * Output shape:
 *   {
 *     sentiment:     -2..2,
 *     market_impact: NONE|LOW|MEDIUM|HIGH,
 *     direction:     UP|DOWN|NEUTRAL,
 *     confidence:    0..1,
 *     tickers:       string[],
 *     sectors:       string[],
 *     horizon_min:   int,
 *     rationale:     string,
 *   }
 *
 * Cost model (single-tier Haiku):
 *   ~100 tokens in, ~150 out per event
 *   ~$0.0004 per event
 *   1000 events/day -> ~$12/mo
 */
import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;
const MODEL = 'claude-haiku-4-5-20251001';

const CACHE = new Map();
const MAX_CACHE = 2000;

const NEUTRAL_RESULT = {
  sentiment: 0,
  market_impact: 'NONE',
  direction: 'NEUTRAL',
  confidence: 0,
  tickers: [],
  sectors: [],
  horizon_min: 0,
  rationale: '',
};

function cacheKey(source, text) {
  return `${source}:${(text || '').slice(0, 200)}`;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function coerceResult(raw) {
  if (!raw || typeof raw !== 'object') return { ...NEUTRAL_RESULT };
  return {
    sentiment: clamp(Number(raw.sentiment) || 0, -2, 2),
    market_impact: ['NONE', 'LOW', 'MEDIUM', 'HIGH'].includes(raw.market_impact) ? raw.market_impact : 'NONE',
    direction: ['UP', 'DOWN', 'NEUTRAL'].includes(raw.direction) ? raw.direction : 'NEUTRAL',
    confidence: clamp(Number(raw.confidence) || 0, 0, 1),
    tickers: Array.isArray(raw.tickers) ? raw.tickers.filter(t => typeof t === 'string' && t.length <= 10).map(t => t.toUpperCase()).slice(0, 10) : [],
    sectors: Array.isArray(raw.sectors) ? raw.sectors.filter(s => typeof s === 'string').map(s => s.toLowerCase()).slice(0, 5) : [],
    horizon_min: clamp(Number(raw.horizon_min) || 0, 0, 1440),
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 400) : '',
  };
}

/**
 * Classify a sentiment event via Claude Haiku.
 * Returns structured result, or neutral fallback if Claude is unavailable.
 *
 * @param {Object} ev
 * @param {string} ev.source       - stocktwits|reuters|ap|...|truth_social
 * @param {string} [ev.title]      - headline or post title
 * @param {string} ev.text         - body (truncated to first 600 chars when sent)
 * @param {string} [ev.author]     - author handle / username
 * @param {number} [ev.followers]  - author follower count (signals weight)
 * @param {string[]} [ev.hint_tickers] - tickers already known (e.g. StockTwits symbols array)
 */
export async function classifySentiment(ev) {
  const source = ev.source || 'unknown';
  const text = (ev.title ? ev.title + ' -- ' : '') + (ev.text || '');
  if (!text.trim()) return { ...NEUTRAL_RESULT };

  const key = cacheKey(source, text);
  if (CACHE.has(key)) return CACHE.get(key);

  if (!client) {
    // Anthropic key missing -- fall back to neutral so the pipeline still stores
    // raw events (they can be classified later once key is set).
    const fallback = { ...NEUTRAL_RESULT };
    if (ev.hint_tickers && ev.hint_tickers.length) fallback.tickers = ev.hint_tickers.slice(0, 10);
    return fallback;
  }

  const truncated = text.slice(0, 600);
  const meta = [];
  if (ev.author) meta.push(`author: ${ev.author}`);
  if (ev.followers) meta.push(`followers: ${ev.followers}`);
  if (ev.hint_tickers && ev.hint_tickers.length) meta.push(`mentioned_tickers: ${ev.hint_tickers.join(',')}`);
  const metaStr = meta.length ? ` (${meta.join(', ')})` : '';

  const prompt = `You are classifying a ${source} post for options-trading impact on US equity markets.

Return ONLY a JSON object with these exact fields:
{
  "sentiment":     <integer -2..+2; -2 strong bearish, +2 strong bullish>,
  "market_impact": <"NONE"|"LOW"|"MEDIUM"|"HIGH">,
  "direction":     <"UP"|"DOWN"|"NEUTRAL">,
  "confidence":    <float 0.0..1.0 of your directional call>,
  "tickers":       <array of affected tickers, use ETFs (SPY/QQQ/IWM/DIA/XLE/XLK etc) for macro/sector news>,
  "sectors":       <array from: energy, tech, financials, healthcare, industrials, defense, consumer_discretionary, consumer_staples, utilities, real_estate, materials, communication_services>,
  "horizon_min":   <integer minutes the impact is expected to last>,
  "rationale":     <one sentence, <=200 chars>
}

Rules:
- Sentiment is neutral-by-default. Use MEDIUM/HIGH impact sparingly -- only for news that moves real price (macro, geopolitics, earnings, M&A, regulatory, major political).
- Geopolitical de-escalation = risk-on = UP for SPY/QQQ. Escalation = risk-off = DOWN.
- For general noise, chitchat, or off-topic, return sentiment:0 impact:NONE direction:NEUTRAL.
- Retail social (StockTwits) should be LOW impact unless author has >10K followers or describes breaking news.

Post${metaStr}:
"""${truncated}"""`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = resp.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...NEUTRAL_RESULT };
    const parsed = JSON.parse(jsonMatch[0]);
    const result = coerceResult(parsed);
    if (CACHE.size >= MAX_CACHE) CACHE.clear();
    CACHE.set(key, result);
    return result;
  } catch (err) {
    // Don't let classifier failures kill ingestion -- return neutral and keep going
    const fallback = { ...NEUTRAL_RESULT, rationale: `classifier_error: ${err.message?.slice(0, 100) || 'unknown'}` };
    if (ev.hint_tickers && ev.hint_tickers.length) fallback.tickers = ev.hint_tickers.slice(0, 10);
    return fallback;
  }
}
