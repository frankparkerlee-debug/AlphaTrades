import dotenv from 'dotenv';
dotenv.config();

import db from '../src/data/db.js';
import { scoreConvictionSetup } from '../src/strategies/conviction-scorer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('[CONVICTION SCAN] Starting...');

  const tickerRes = await db.query(`
    SELECT ticker FROM lc_v3.equity_profiles
    UNION
    SELECT ticker FROM lc_v3.conviction_universe
  `);
  const tickers = tickerRes.rows.map((r) => r.ticker);
  console.log(`[CONVICTION SCAN] ${tickers.length} tickers to score\n`);

  const qualifying = [];

  // Process in batches of 3
  for (let i = 0; i < tickers.length; i += 3) {
    const batch = tickers.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map((ticker) => scoreConvictionSetup(ticker, db))
    );

    for (let j = 0; j < results.length; j++) {
      const ticker = batch[j];
      const r = results[j];
      if (r.status === 'rejected') {
        console.warn(`[CONVICTION] ${ticker} ERROR: ${r.reason?.message || r.reason}`);
        continue;
      }
      const result = r.value;
      if (result.recommendation === 'STRONG_PUT' || result.recommendation === 'MONITOR') {
        const rfCount = result.eight_k_red_flags?.length || 0;
        console.log(
          `[CONVICTION] ${result.ticker} score=${result.conviction_score} rec=${result.recommendation} factors=${result.top_risk_factors.length} red_flags=${rfCount}`
        );
        qualifying.push(result);
      }
    }

    if (i + 3 < tickers.length) await sleep(500);
  }

  // Sort by score descending
  qualifying.sort((a, b) => b.conviction_score - a.conviction_score);

  // Summary table
  const top20 = qualifying.slice(0, 20);
  console.log(`\n${'='.repeat(110)}`);
  console.log(`CONVICTION SCAN COMPLETE — ${qualifying.length} qualifying out of ${tickers.length} scanned`);
  console.log(`${'='.repeat(110)}`);
  console.log(
    'TICKER'.padEnd(8) +
    'SCORE'.padStart(6) +
    '  ' + 'REC'.padEnd(12) +
    'EARN'.padStart(6) +
    'IV_RK'.padStart(7) +
    'RF_8K'.padStart(7) +
    '  TOP RISK FACTOR'
  );
  console.log('-'.repeat(110));

  for (const r of top20) {
    const earn = r.days_to_earnings != null ? `${r.days_to_earnings}d` : '--';
    const iv = r.iv_rank_30d != null ? `${r.iv_rank_30d.toFixed(0)}%` : '--';
    const rfCount = r.eight_k_red_flags?.length || 0;
    const topFactor = r.top_risk_factors[0] || '--';
    console.log(
      r.ticker.padEnd(8) +
      String(r.conviction_score).padStart(6) +
      '  ' + r.recommendation.padEnd(12) +
      earn.padStart(6) +
      iv.padStart(7) +
      String(rfCount).padStart(7) +
      '  ' + topFactor.slice(0, 60)
    );
  }

  console.log(`${'='.repeat(110)}\n`);
  await db.end();
}

main().catch((err) => {
  console.error('[CONVICTION SCAN] Fatal error:', err);
  process.exit(1);
});
