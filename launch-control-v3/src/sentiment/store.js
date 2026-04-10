/**
 * Sentiment event store -- upserts + rollup queries for lc_v3.sentiment_events.
 *
 * All sources (stocktwits, news-rss, truth-social, future: reddit/grok) land
 * here via upsertSentimentEvent. Downstream consumers (signal grade veto,
 * research dashboard, active position monitor) read via the query helpers.
 */
import { query } from '../data/db.js';

/**
 * Upsert one classified sentiment event. Dedupes on (source, source_id).
 * Returns true if inserted, false if it was a duplicate.
 *
 * @param {Object} ev
 * @param {string} ev.source
 * @param {string} ev.source_id
 * @param {string} [ev.author]
 * @param {number} [ev.author_followers]
 * @param {string} [ev.url]
 * @param {string} [ev.title]
 * @param {string} ev.text
 * @param {Date}   ev.raw_ts
 * @param {number} [ev.engagement]
 * @param {string} [ev.raw_sentiment]
 * @param {Object} [ev.classification]  -- output from classifier.classifySentiment
 */
export async function upsertSentimentEvent(ev) {
  const c = ev.classification || {};
  const res = await query(`
    INSERT INTO lc_v3.sentiment_events
      (source, source_id, author, author_followers, url, title, text, raw_ts,
       engagement, raw_sentiment,
       sentiment, market_impact, direction, confidence,
       tickers, sectors, horizon_min, rationale, classified_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10,
       $11, $12, $13, $14,
       $15::jsonb, $16::jsonb, $17, $18, $19)
    ON CONFLICT (source, source_id) DO NOTHING
    RETURNING event_id
  `, [
    ev.source,
    ev.source_id,
    ev.author || null,
    ev.author_followers || null,
    ev.url || null,
    ev.title || null,
    ev.text || '',
    ev.raw_ts,
    ev.engagement || null,
    ev.raw_sentiment || null,
    c.sentiment ?? null,
    c.market_impact ?? null,
    c.direction ?? null,
    c.confidence ?? null,
    JSON.stringify(c.tickers || []),
    JSON.stringify(c.sectors || []),
    c.horizon_min ?? null,
    c.rationale ?? null,
    c.market_impact != null ? new Date() : null,
  ]);
  return res.rows.length > 0;
}

/**
 * Get recent sentiment events, optionally filtered.
 */
export async function getRecentSentiment({ source, ticker, since, impact, limit = 50 } = {}) {
  const wheres = [];
  const params = [];
  if (source) {
    params.push(source);
    wheres.push(`source = $${params.length}`);
  }
  if (ticker) {
    params.push(ticker.toUpperCase());
    wheres.push(`tickers @> to_jsonb($${params.length}::text[]) OR tickers ? $${params.length}`);
  }
  if (since) {
    params.push(since);
    wheres.push(`raw_ts >= $${params.length}`);
  }
  if (impact && impact.length) {
    params.push(impact);
    wheres.push(`market_impact = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const r = await query(`
    SELECT event_id, source, source_id, author, author_followers, url, title,
           text, raw_ts, engagement, raw_sentiment,
           sentiment, market_impact, direction, confidence, tickers, sectors,
           horizon_min, rationale, classified_at
    FROM lc_v3.sentiment_events
    ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''}
    ORDER BY raw_ts DESC
    LIMIT $${params.length}
  `, params);
  return r.rows;
}

/**
 * Rollup sentiment for a given ticker over the last N minutes.
 * Returns aggregate stats the signal grade gate can use as a veto input.
 */
export async function getSentimentRollup(ticker, windowMin = 60) {
  const r = await query(`
    SELECT
      COUNT(*)                                                     AS n,
      COUNT(*) FILTER (WHERE market_impact IN ('MEDIUM','HIGH'))   AS high_impact_n,
      AVG(sentiment)                                               AS avg_sentiment,
      MAX(confidence) FILTER (WHERE direction = 'UP'
                              AND market_impact IN ('MEDIUM','HIGH'))   AS max_up_conf,
      MAX(confidence) FILTER (WHERE direction = 'DOWN'
                              AND market_impact IN ('MEDIUM','HIGH'))   AS max_down_conf,
      COUNT(*) FILTER (WHERE direction = 'UP')                     AS up_n,
      COUNT(*) FILTER (WHERE direction = 'DOWN')                   AS down_n
    FROM lc_v3.sentiment_events
    WHERE (tickers @> to_jsonb(ARRAY[$1::text]) OR tickers ? $1)
      AND raw_ts >= NOW() - ($2 || ' minutes')::interval
  `, [ticker.toUpperCase(), String(windowMin)]);
  return r.rows[0] || {};
}

/**
 * Count rows by source for the last N minutes (health check).
 */
export async function getIngestCounts(windowMin = 60) {
  const r = await query(`
    SELECT source, COUNT(*) as n, MAX(raw_ts) as newest
    FROM lc_v3.sentiment_events
    WHERE raw_ts >= NOW() - ($1 || ' minutes')::interval
    GROUP BY source
    ORDER BY source
  `, [String(windowMin)]);
  return r.rows;
}
