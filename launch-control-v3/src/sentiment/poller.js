/**
 * Sentiment poller -- orchestrates StockTwits, News RSS, and Truth Social
 * on independent intervals. Called from server.js on startup.
 *
 * Intervals:
 *   - Truth Social:  60s   (highest-priority, Trump posts move price fast)
 *   - News RSS:     120s
 *   - StockTwits:   120s
 *
 * Each run is wrapped so a crash in one source never blocks the others.
 */
import { pollStockTwits } from './sources/stocktwits.js';
import { pollNewsRSS } from './sources/news-rss.js';
import { pollTruthSocial } from './sources/truth-social.js';

const INTERVALS = {
  truth_social: 60 * 1000,
  news_rss: 120 * 1000,
  stocktwits: 120 * 1000,
};

let running = { truth_social: false, news_rss: false, stocktwits: false };
let stats = {
  truth_social: { last_run: null, last_inserted: 0, last_classified: 0, total_inserted: 0, errors: 0 },
  news_rss:     { last_run: null, last_inserted: 0, last_classified: 0, total_inserted: 0, errors: 0 },
  stocktwits:   { last_run: null, last_inserted: 0, last_classified: 0, total_inserted: 0, errors: 0 },
};

function log(tag, msg) {
  console.log(`[sentiment:${tag}] ${msg}`);
}

async function safeRun(name, fn) {
  if (running[name]) {
    log(name, 'skipped (previous run still in progress)');
    return;
  }
  running[name] = true;
  const t0 = Date.now();
  try {
    const r = await fn();
    stats[name].last_run = new Date();
    stats[name].last_inserted = r.inserted || 0;
    stats[name].last_classified = r.classified || 0;
    stats[name].total_inserted += r.inserted || 0;
    log(name, `fetched=${r.fetched || 0} inserted=${r.inserted || 0} classified=${r.classified || 0} took=${Date.now() - t0}ms`);
  } catch (err) {
    stats[name].errors++;
    log(name, `ERROR ${err.message}`);
  } finally {
    running[name] = false;
  }
}

/**
 * Start all three pollers. Idempotent -- safe to call once at server startup.
 */
export function startSentimentPoller() {
  log('main', 'starting sentiment pollers (truth_social 60s, news_rss 120s, stocktwits 120s)');

  // Kick off an initial run of each so we have data immediately
  setTimeout(() => safeRun('truth_social', pollTruthSocial), 2000);
  setTimeout(() => safeRun('news_rss', pollNewsRSS), 4000);
  setTimeout(() => safeRun('stocktwits', pollStockTwits), 6000);

  // Then schedule ongoing polls
  setInterval(() => safeRun('truth_social', pollTruthSocial), INTERVALS.truth_social);
  setInterval(() => safeRun('news_rss', pollNewsRSS), INTERVALS.news_rss);
  setInterval(() => safeRun('stocktwits', pollStockTwits), INTERVALS.stocktwits);
}

export function getSentimentPollerStats() {
  return { running: { ...running }, stats: { ...stats } };
}
