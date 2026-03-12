/**
 * Backtest Configuration
 * Parses CLI args and provides defaults.
 */

export function parseConfig(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] || true;
      i++;
    }
  }

  if (!args.start || !args.end) {
    console.error('Usage: node scripts/backtest.js --start 2026-02-01 --end 2026-03-01 [--tickers NVDA,AMD] [--account 7500]');
    process.exit(1);
  }

  // Validate date format
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(args.start) || !dateRe.test(args.end)) {
    console.error('Dates must be YYYY-MM-DD format');
    process.exit(1);
  }

  return {
    startDate:   args.start,
    endDate:     args.end,
    tickers:     args.tickers ? args.tickers.split(',').map(t => t.trim().toUpperCase()) : null, // null = all from DB
    accountSize: parseFloat(args.account || '7500'),
    outputDir:   './backtest-results',
    outputFile:  `./backtest-results/${args.start}_to_${args.end}.json`,
    feed:        process.env.ALPACA_FEED || 'sip',
    maxConcurrent: parseInt(args.concurrent || '5'),
  };
}
