import dotenv from 'dotenv';
dotenv.config();

import { query } from '../data/db.js';
import { fetchRecentNews } from '../data/alpaca-rest.js';
import { classifyCatalyst } from '../scoring/news.js';
import logger from '../utils/logger.js';
import { todayStr } from '../utils/time.js';

// Macro event schedule (simplified — expand as needed)
const MACRO_EVENTS = {
  // These are checked against current date in a real impl
  // For now we check news headlines for FOMC/CPI/NFP mentions
};

export async function run() {
  logger.info('Starting pre-market intelligence scan...');

  const tickers = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const allTickers = tickers.rows.map(r => r.ticker);

  // Fetch overnight news (last 18 hours)
  const since = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
  const news = await fetchRecentNews(allTickers, since);

  logger.info(`Found ${news.length} news items since ${since}`);

  const flaggedTickers = [];
  const macroEvents    = [];
  let marketBias       = 'NEUTRAL';

  // Process each news item
  const tickerNews = {};
  for (const item of news) {
    const symbols = item.symbols || [];
    for (const ticker of symbols) {
      if (!allTickers.includes(ticker)) continue;
      if (!tickerNews[ticker]) tickerNews[ticker] = [];
      tickerNews[ticker].push(item);
    }

    // Detect macro events
    const headline = (item.headline || '').toLowerCase();
    if (headline.match(/fomc|federal reserve|powell|fed decision/)) {
      macroEvents.push({ type: 'FOMC', headline: item.headline, time: item.created_at });
    }
    if (headline.match(/cpi|inflation report|consumer price/)) {
      macroEvents.push({ type: 'CPI', headline: item.headline, time: item.created_at });
    }
    if (headline.match(/nonfarm payroll|jobs report|employment situation/)) {
      macroEvents.push({ type: 'NFP', headline: item.headline, time: item.created_at });
    }
  }

  // Determine market bias from broad macro news
  const bullishCount = news.filter(n =>
    (n.headline||'').toLowerCase().match(/rally|surge|gain|beat|strong|record|upgrade/)
  ).length;
  const bearishCount = news.filter(n =>
    (n.headline||'').toLowerCase().match(/fall|drop|miss|weak|concern|downgrade|restrict/)
  ).length;
  if (bullishCount > bearishCount * 1.5) marketBias = 'BULLISH';
  else if (bearishCount > bullishCount * 1.5) marketBias = 'BEARISH';

  // Classify catalysts for flagged tickers
  for (const [ticker, items] of Object.entries(tickerNews)) {
    const strongEvents = [];
    for (const item of items) {
      const catalyst = await classifyCatalyst(item.headline, ticker);
      if (catalyst.sensitivity >= 1.5) {
        strongEvents.push({
          headline: item.headline,
          catalyst,
          time: item.created_at,
          url: item.url,
        });
      }
    }

    if (strongEvents.length > 0) {
      flaggedTickers.push({
        ticker,
        events: strongEvents,
        eventCount: strongEvents.length,
        topCatalyst: strongEvents[0].catalyst.type,
        topSensitivity: strongEvents[0].catalyst.sensitivity,
      });
      logger.info(`  📰 ${ticker}: ${strongEvents.length} strong catalyst(s) — ${strongEvents[0].catalyst.type}`);
    }
  }

  // Sort by sensitivity
  flaggedTickers.sort((a, b) => b.topSensitivity - a.topSensitivity);

  // Write briefing to DB
  const today = todayStr();
  await query(`
    INSERT INTO lc_v3.premarket_briefing (date, flagged_tickers, macro_events, market_bias, notes)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (date) DO UPDATE SET
      flagged_tickers = EXCLUDED.flagged_tickers,
      macro_events    = EXCLUDED.macro_events,
      market_bias     = EXCLUDED.market_bias,
      created_at      = NOW()
  `, [
    today,
    JSON.stringify(flaggedTickers),
    JSON.stringify(macroEvents),
    marketBias,
    `${flaggedTickers.length} tickers flagged, ${macroEvents.length} macro events`,
  ]);

  logger.info(`\nPre-market scan complete:`);
  logger.info(`  Market bias:     ${marketBias}`);
  logger.info(`  Macro events:    ${macroEvents.length}`);
  logger.info(`  Flagged tickers: ${flaggedTickers.length}`);
  logger.info(`  Top setups:      ${flaggedTickers.slice(0, 5).map(t => t.ticker).join(', ')}`);

  return { flaggedTickers, macroEvents, marketBias };
}

// Run directly if called as script
if (process.argv[1] && process.argv[1].includes('premarket-scan')) {
  run().catch(err => {
    logger.error('Pre-market scan failed:', err);
    process.exit(1);
  });
}
