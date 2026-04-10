/**
 * Sentiment pipeline verification.
 *
 * Runs one poll of each source end-to-end against real DB so you can confirm:
 *  1. Network fetch works
 *  2. Parser extracts items
 *  3. Classifier returns structured output
 *  4. Rows land in lc_v3.sentiment_events
 *  5. Rollup query returns usable data
 *
 * Usage: node scripts/_check_sentiment.mjs
 */
import 'dotenv/config';
import { pollTruthSocial } from '../src/sentiment/sources/truth-social.js';
import { pollNewsRSS } from '../src/sentiment/sources/news-rss.js';
import { pollStockTwits } from '../src/sentiment/sources/stocktwits.js';
import { getRecentSentiment, getSentimentRollup, getIngestCounts } from '../src/sentiment/store.js';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section('TRUTH SOCIAL');
const t = await pollTruthSocial();
console.log(JSON.stringify(t, null, 2));

section('NEWS RSS');
const n = await pollNewsRSS();
console.log(`totals: fetched=${n.fetched} inserted=${n.inserted} classified=${n.classified}`);
console.log('bySource:', JSON.stringify(n.bySource, null, 2));

section('STOCKTWITS');
const s = await pollStockTwits();
console.log(JSON.stringify(s, null, 2));

section('INGEST COUNTS (last 60m)');
const counts = await getIngestCounts(60);
console.log(counts);

section('RECENT HIGH-IMPACT EVENTS');
const hi = await getRecentSentiment({ impact: ['MEDIUM', 'HIGH'], limit: 15 });
for (const e of hi) {
  console.log(`[${e.source}] ${e.raw_ts?.toISOString?.().slice(0, 16) || e.raw_ts} ${e.direction || '-'} ` +
              `conf=${e.confidence || 0} impact=${e.market_impact || '-'} ` +
              `tickers=${JSON.stringify(e.tickers || [])}`);
  console.log(`  title: ${(e.title || '').slice(0, 120)}`);
  if (e.rationale) console.log(`  why:   ${e.rationale.slice(0, 120)}`);
}

section('SPY ROLLUP (60m window)');
const spy = await getSentimentRollup('SPY', 60);
console.log(spy);

section('QQQ ROLLUP (60m window)');
const qqq = await getSentimentRollup('QQQ', 60);
console.log(qqq);

console.log('\nDone.');
process.exit(0);
