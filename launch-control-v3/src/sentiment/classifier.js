/**
 * Sentiment classifier -- turns raw headlines / posts into structured
 * market-impact records via Claude Haiku, with optional narrative synthesis
 * via Sonnet for connecting related events into directional arcs.
 *
 * Two tiers:
 *   1. classifySentiment  — Haiku, per-event, ~$0.0004 each, ~1000/day
 *   2. synthesizeNarrative — Sonnet, periodic batch, ~$0.02 each, ~50/day
 *      Runs every 10 min. Reads the last 2h of classified events, detects
 *      emerging narrative arcs (e.g. "Iran delegation + blockade + breakdown"),
 *      and upserts a synthetic HIGH-impact event with the connected thesis.
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
 */
import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

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
 * Classify a single sentiment event via Claude Haiku (fast, cheap).
 *
 * @param {Object} ev
 * @param {string} ev.source
 * @param {string} [ev.title]
 * @param {string} ev.text
 * @param {string} [ev.author]
 * @param {number} [ev.followers]
 * @param {string[]} [ev.hint_tickers]
 */
export async function classifySentiment(ev) {
  const source = ev.source || 'unknown';
  const text = (ev.title ? ev.title + ' -- ' : '') + (ev.text || '');
  if (!text.trim()) return { ...NEUTRAL_RESULT };

  const key = cacheKey(source, text);
  if (CACHE.has(key)) return CACHE.get(key);

  if (!client) {
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
- Diplomatic arrivals, delegations, summits = de-escalation signal = risk-on unless context indicates otherwise.
- Blockades, negotiation breakdowns, military deployments = escalation signal = risk-off.
- Energy supply disruption (Strait of Hormuz, OPEC cuts, pipeline attacks) = oil UP, SPY DOWN.
- For general noise, chitchat, or off-topic, return sentiment:0 impact:NONE direction:NEUTRAL.
- Retail social (StockTwits) should be LOW impact unless author has >10K followers or describes breaking news.

Post${metaStr}:
"""${truncated}"""`;

  try {
    const resp = await client.messages.create({
      model: HAIKU,
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
    const fallback = { ...NEUTRAL_RESULT, rationale: `classifier_error: ${err.message?.slice(0, 100) || 'unknown'}` };
    if (ev.hint_tickers && ev.hint_tickers.length) fallback.tickers = ev.hint_tickers.slice(0, 10);
    return fallback;
  }
}

// ── NARRATIVE SYNTHESIS (Sonnet, periodic) ──────────────────────────────────
//
// Reads the last 2h of classified MEDIUM/HIGH events, detects narrative arcs
// that span multiple headlines, and emits a synthetic HIGH-impact event with
// the connected thesis. This is what catches "Iran delegation + blockade +
// breakdown = escalation arc = risk-off" across multiple sources.

/**
 * Synthesize a narrative from recent classified events.
 * Called every 10 min by the poller. Returns a synthetic classification
 * to be inserted as source='narrative_synthesis'.
 *
 * @param {Array} recentEvents - rows from sentiment_events (last 2h, MEDIUM+HIGH)
 * @returns {Object|null} - classification or null if no narrative detected
 */
export async function synthesizeNarrative(recentEvents) {
  if (!client) return null;
  if (!recentEvents || recentEvents.length < 3) return null;

  // Build a concise summary of recent classified events for Sonnet
  const eventSummary = recentEvents.slice(0, 40).map(e => {
    const ts = e.raw_ts ? new Date(e.raw_ts).toISOString().slice(11, 16) : '??:??';
    const tickers = Array.isArray(e.tickers) ? e.tickers.join(',') : '';
    return `[${ts}] [${e.source}] ${e.direction || 'NEU'} conf=${e.confidence || 0} | ${(e.title || e.text || '').slice(0, 120)} | tickers: ${tickers} | ${e.rationale || ''}`;
  }).join('\n');

  const prompt = `You are a geopolitical + macro analyst for an options trading desk. Below are the last 2 hours of classified sentiment events from news and social media.

Your job: detect if there is an EMERGING NARRATIVE ARC -- a coherent story developing across multiple headlines that the individual classifications miss. Examples:
- "Iran delegation to Islamabad" + "Iran blockade of Hormuz" + "Pakistan-Iran talks collapse" = ESCALATION ARC, strong risk-off
- "Ceasefire announced" + "Markets rally" + "Oil drops" = DE-ESCALATION ARC, risk-on
- "CPI misses high" + "Fed hawkish speech" + "Bond yields spike" = TIGHTENING ARC, risk-off for growth

If you detect a narrative arc, return a JSON object:
{
  "detected": true,
  "arc_name": <short name, e.g. "Iran-Pakistan escalation" or "Fed tightening cycle">,
  "sentiment": <-2..+2>,
  "market_impact": "HIGH",
  "direction": <"UP"|"DOWN">,
  "confidence": <0.0..1.0>,
  "tickers": <array of most affected ETFs/tickers>,
  "sectors": <array>,
  "horizon_min": <expected duration of market impact>,
  "rationale": <2-3 sentences connecting the dots across headlines, <=300 chars>,
  "headline_count": <how many of the events below contribute to this arc>
}

If there is NO coherent narrative arc (just isolated events), return:
{ "detected": false }

Do NOT force a narrative. Only flag genuine multi-event arcs where the connected story is materially different from any single headline's impact.

Recent events (${recentEvents.length} total):
${eventSummary}`;

  try {
    const resp = await client.messages.create({
      model: SONNET,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = resp.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.detected) return null;
    return coerceResult(parsed);
  } catch (err) {
    console.error(`[sentiment:narrative] synthesis error: ${err.message}`);
    return null;
  }
}
