/**
 * Migration: Create sentiment ingestion tables
 *
 * lc_v3.sentiment_events -- unified table for social + news sentiment from
 * every source (StockTwits, News RSS, Truth Social, future: Reddit/Grok/X).
 * Each row is one post/headline after LLM classification.
 *
 * Run: node scripts/migrate-sentiment.js
 */
import { query } from '../src/data/db.js';

console.log('Creating sentiment tables...');

await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.sentiment_events (
    event_id         BIGSERIAL PRIMARY KEY,
    source           TEXT NOT NULL,          -- stocktwits|reuters|ap|afp|aljazeera|bloomberg|ft|truth_social
    source_id        TEXT NOT NULL,          -- dedupe (msg id, url, guid)
    author           TEXT,
    author_followers INT,
    url              TEXT,
    title            TEXT,
    text             TEXT NOT NULL,
    raw_ts           TIMESTAMPTZ NOT NULL,
    ingested_at      TIMESTAMPTZ DEFAULT NOW(),
    engagement       NUMERIC,                -- upvotes, likes, RTs
    raw_sentiment    TEXT,                   -- user-declared tag from source (StockTwits Bullish/Bearish)
    -- LLM classification (written async; may be NULL while pending)
    sentiment        NUMERIC,                -- -2 to +2
    market_impact    TEXT,                   -- NONE|LOW|MEDIUM|HIGH
    direction        TEXT,                   -- UP|DOWN|NEUTRAL
    confidence       NUMERIC,                -- 0-1
    tickers          JSONB,                  -- ["SPY","XOM"]
    sectors          JSONB,                  -- ["energy","defense"]
    horizon_min      INT,
    rationale        TEXT,
    classified_at    TIMESTAMPTZ,
    UNIQUE (source, source_id)
  )
`);
console.log('OK  lc_v3.sentiment_events');

await query(`CREATE INDEX IF NOT EXISTS idx_sentiment_raw_ts ON lc_v3.sentiment_events (raw_ts DESC)`);
await query(`CREATE INDEX IF NOT EXISTS idx_sentiment_source_ts ON lc_v3.sentiment_events (source, raw_ts DESC)`);
await query(`CREATE INDEX IF NOT EXISTS idx_sentiment_impact ON lc_v3.sentiment_events (market_impact, raw_ts DESC) WHERE market_impact IN ('MEDIUM','HIGH')`);
await query(`CREATE INDEX IF NOT EXISTS idx_sentiment_tickers ON lc_v3.sentiment_events USING GIN (tickers)`);
await query(`CREATE INDEX IF NOT EXISTS idx_sentiment_unclassified ON lc_v3.sentiment_events (ingested_at) WHERE classified_at IS NULL`);
console.log('OK  indexes');

console.log('Migration complete.');
process.exit(0);
