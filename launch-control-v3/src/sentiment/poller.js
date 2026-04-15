/**
 * Sentiment poller -- orchestrates StockTwits, News RSS, Truth Social,
 * and narrative synthesis on independent intervals. Called from server.js
 * on startup.
 *
 * Intervals:
 *   - Truth Social:        60s   (Trump posts move price fast)
 *   - News RSS:           120s   (8 sources incl Dawn, BBC ME)
 *   - StockTwits:         120s
 *   - Narrative synthesis: 600s   (Sonnet connects headline arcs every 10m)
 *
 * Each run is wrapped so a crash in one source never blocks the others.
 */
import { pollStockTwits } from './sources/stocktwits.js';
import { pollNewsRSS } from './sources/news-rss.js';
import { pollTruthSocial } from './sources/truth-social.js';
import { synthesizeNarrative } from './classifier.js';
import { getRecentSentiment, upsertSentimentEvent } from './store.js';

const INTERVALS = {
  truth_social: 60 * 1000,
  news_rss: 120 * 1000,
  stocktwits: 120 * 1000,
  narrative: 600 * 1000,
};

let running = { truth_social: false, news_rss: false, stocktwits: false, narrative: false };
let stats = {
  truth_social: { last_run: null, last_inserted: 0, last_classified: 0, total_inserted: 0, errors: 0 },
  news_rss:     { last_run: null, last_inserted: 0, last_classified: 0, total_inserted: 0, errors: 0 },
  stocktwits:   { last_run: null, last_inserted: 0, last_classified: 0, total_inserted: 0, errors: 0 },
  narrative:    { last_run: null, last_arc: null, total_arcs: 0, errors: 0 },
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
    if (r.inserted !== undefined) {
      stats[name].last_inserted = r.inserted || 0;
      stats[name].last_classified = r.classified || 0;
      stats[name].total_inserted += r.inserted || 0;
    }
    log(name, `fetched=${r.fetched || 0} inserted=${r.inserted || 0} classified=${r.classified || 0} took=${Date.now() - t0}ms`);
  } catch (err) {
    stats[name].errors++;
    log(name, `ERROR ${err.message}`);
  } finally {
    running[name] = false;
  }
}

/**
 * Run narrative synthesis -- reads recent MEDIUM/HIGH events from all
 * sources, sends to Sonnet to detect emerging narrative arcs, and
 * stores the result as a synthetic event.
 */
async function runNarrativeSynthesis() {
  if (running.narrative) {
    log('narrative', 'skipped (previous run still in progress)');
    return;
  }
  running.narrative = true;
  const t0 = Date.now();
  try {
    // Get events classified as MEDIUM or HIGH in the last 2 hours
    const events = await getRecentSentiment({
      impact: ['MEDIUM', 'HIGH'],
      since: new Date(Date.now() - 2 * 60 * 60 * 1000),
      limit: 50,
    });

    if (events.length < 3) {
      log('narrative', `only ${events.length} MEDIUM/HIGH events in 2h window, skipping`);
      stats.narrative.last_run = new Date();
      return;
    }

    const result = await synthesizeNarrative(events);
    stats.narrative.last_run = new Date();

    if (!result) {
      log('narrative', `no arc detected from ${events.length} events (took ${Date.now() - t0}ms)`);
      return;
    }

    // Store as a synthetic event so it shows up in the dashboard feed
    // and can be used by the signal veto gate
    const arcId = `narrative_${Date.now()}`;
    const inserted = await upsertSentimentEvent({
      source: 'narrative_synthesis',
      source_id: arcId,
      author: 'sonnet_synthesis',
      title: `NARRATIVE ARC: ${result.rationale?.slice(0, 80) || 'unnamed'}`,
      text: result.rationale || '',
      raw_ts: new Date(),
      classification: result,
    });

    stats.narrative.last_arc = result.rationale?.slice(0, 100);
    stats.narrative.total_arcs++;
    log('narrative', `ARC DETECTED: ${result.direction} conf=${result.confidence} tickers=${(result.tickers || []).join(',')} | ${result.rationale?.slice(0, 120)} (took ${Date.now() - t0}ms)`);
  } catch (err) {
    stats.narrative.errors++;
    log('narrative', `ERROR ${err.message}`);
  } finally {
    running.narrative = false;
  }
}

/**
 * Start all pollers. Idempotent -- safe to call once at server startup.
 */
export function startSentimentPoller() {
  log('main', 'starting sentiment pollers (truth_social 60s, news_rss 120s, stocktwits 120s, narrative 600s)');

  // Kick off initial runs staggered so we don't hit everything at once
  setTimeout(() => safeRun('truth_social', pollTruthSocial), 2000);
  setTimeout(() => safeRun('news_rss', pollNewsRSS), 4000);
  setTimeout(() => safeRun('stocktwits', pollStockTwits), 6000);
  // Narrative synthesis waits 90s so the first round of events is ingested
  setTimeout(() => runNarrativeSynthesis(), 90000);

  // Ongoing polls
  setInterval(() => safeRun('truth_social', pollTruthSocial), INTERVALS.truth_social);
  setInterval(() => safeRun('news_rss', pollNewsRSS), INTERVALS.news_rss);
  setInterval(() => safeRun('stocktwits', pollStockTwits), INTERVALS.stocktwits);
  setInterval(() => runNarrativeSynthesis(), INTERVALS.narrative);
}

export function getSentimentPollerStats() {
  return { running: { ...running }, stats: { ...stats } };
}
