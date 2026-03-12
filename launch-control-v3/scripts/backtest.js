#!/usr/bin/env node
/**
 * Launch Control v3 — Backtest Engine (CLI)
 *
 * Usage:
 *   node scripts/backtest.js --start 2026-02-01 --end 2026-03-01
 *   node scripts/backtest.js --start 2026-02-01 --end 2026-03-01 --tickers NVDA,AMD,TSLA
 *   node scripts/backtest.js --start 2026-02-01 --end 2026-03-01 --account 10000
 */

import 'dotenv/config';
import { parseConfig } from './backtest/config.js';
import { runBacktest } from './backtest/run.js';
import { generateReport } from './backtest/reporter.js';

async function main() {
  const startTime = Date.now();
  const config = parseConfig(process.argv);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         LAUNCH CONTROL v3 — BACKTEST ENGINE                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Range:   ${config.startDate} → ${config.endDate}`);
  console.log(`  Account: $${config.accountSize.toLocaleString()}`);

  const results = await runBacktest(config.startDate, config.endDate, config.accountSize, config.tickers);

  if (results.summary.totalSignals === 0) {
    console.log('\nNo signals generated. Check your date range and ticker list.');
    process.exit(0);
  }

  // Print console report
  generateReport(results.signals || [], config);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Completed in ${elapsed}s\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
