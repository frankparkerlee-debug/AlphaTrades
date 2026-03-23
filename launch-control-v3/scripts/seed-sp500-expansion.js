/**
 * Expand equity_profiles to ~200 tickers by adding S&P 500 names
 * that aren't already in the Nasdaq 100 seed.
 *
 * Fills gaps in: Financials, Healthcare, Energy, Industrials, Materials,
 * Real Estate, and high-options-volume names from other sectors.
 *
 * Run: node scripts/seed-sp500-expansion.js
 */

import 'dotenv/config';
import { query } from '../src/data/db.js';
import logger from '../src/utils/logger.js';

// ~90 high-options-volume S&P 500 names NOT in the Nasdaq 100 seed
const EXPANSION_TICKERS = [
  // ── Financials (biggest options volume sector after tech) ──
  { ticker: 'JPM',  sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'BAC',  sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'WFC',  sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'GS',   sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'MS',   sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'C',    sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'SCHW', sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'BLK',  sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'AXP',  sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'V',    sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'MA',   sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'COF',  sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'USB',  sector: 'XLF', exchange: 'NYSE' },

  // ── Healthcare / Biotech ──
  { ticker: 'UNH',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'JNJ',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'PFE',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'ABBV', sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'LLY',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'MRK',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'TMO',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'ABT',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'BMY',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'AMGN', sector: 'XLV', exchange: 'NASDAQ' },
  { ticker: 'CVS',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'HUM',  sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'CI',   sector: 'XLV', exchange: 'NYSE' },
  { ticker: 'ELV',  sector: 'XLV', exchange: 'NYSE' },

  // ── Energy ──
  { ticker: 'XOM',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'CVX',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'COP',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'SLB',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'EOG',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'MPC',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'OXY',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'VLO',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'PSX',  sector: 'XLE', exchange: 'NYSE' },
  { ticker: 'HAL',  sector: 'XLE', exchange: 'NYSE' },

  // ── Industrials ──
  { ticker: 'CAT',  sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'DE',   sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'BA',   sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'UPS',  sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'RTX',  sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'LMT',  sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'GE',   sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'MMM',  sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'FDX',  sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'WM',   sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'GD',   sector: 'XLI', exchange: 'NYSE' },
  { ticker: 'NOC',  sector: 'XLI', exchange: 'NYSE' },

  // ── Consumer Staples ──
  { ticker: 'WMT',  sector: 'XLP', exchange: 'NYSE' },
  { ticker: 'PG',   sector: 'XLP', exchange: 'NYSE' },
  { ticker: 'KO',   sector: 'XLP', exchange: 'NYSE' },
  { ticker: 'PM',   sector: 'XLP', exchange: 'NYSE' },
  { ticker: 'MO',   sector: 'XLP', exchange: 'NYSE' },
  { ticker: 'CL',   sector: 'XLP', exchange: 'NYSE' },
  { ticker: 'TGT',  sector: 'XLP', exchange: 'NYSE' },

  // ── Consumer Discretionary (not in Nasdaq seed) ──
  { ticker: 'HD',   sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'LOW',  sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'NKE',  sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'MCD',  sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'TJX',  sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'DASH', sector: 'XLY', exchange: 'NASDAQ' },
  { ticker: 'GM',   sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'F',    sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'CMG',  sector: 'XLY', exchange: 'NYSE' },

  // ── Communication ──
  { ticker: 'DIS',  sector: 'XLC', exchange: 'NYSE' },
  { ticker: 'CMCSA',sector: 'XLC', exchange: 'NASDAQ' },
  { ticker: 'T',    sector: 'XLC', exchange: 'NYSE' },
  { ticker: 'VZ',   sector: 'XLC', exchange: 'NYSE' },
  { ticker: 'SPOT', sector: 'XLC', exchange: 'NYSE' },

  // ── Materials ──
  { ticker: 'LIN',  sector: 'XLB', exchange: 'NYSE' },
  { ticker: 'FCX',  sector: 'XLB', exchange: 'NYSE' },
  { ticker: 'NEM',  sector: 'XLB', exchange: 'NYSE' },
  { ticker: 'DOW',  sector: 'XLB', exchange: 'NYSE' },
  { ticker: 'NUE',  sector: 'XLB', exchange: 'NYSE' },

  // ── Real Estate ──
  { ticker: 'AMT',  sector: 'XLRE', exchange: 'NYSE' },
  { ticker: 'PLD',  sector: 'XLRE', exchange: 'NYSE' },
  { ticker: 'CCI',  sector: 'XLRE', exchange: 'NYSE' },
  { ticker: 'SPG',  sector: 'XLRE', exchange: 'NYSE' },

  // ── Utilities ──
  { ticker: 'NEE',  sector: 'XLU', exchange: 'NYSE' },
  { ticker: 'DUK',  sector: 'XLU', exchange: 'NYSE' },
  { ticker: 'SO',   sector: 'XLU', exchange: 'NYSE' },

  // ── High-volume meme/retail favorites (heavy options flow) ──
  { ticker: 'SOFI', sector: 'XLF', exchange: 'NASDAQ' },
  { ticker: 'RIVN', sector: 'XLY', exchange: 'NASDAQ' },
  { ticker: 'LCID', sector: 'XLY', exchange: 'NASDAQ' },
  { ticker: 'COIN', sector: 'XLF', exchange: 'NASDAQ' },
  { ticker: 'MARA', sector: 'XLF', exchange: 'NASDAQ' },
  { ticker: 'ROKU', sector: 'XLC', exchange: 'NASDAQ' },
  { ticker: 'SQ',   sector: 'XLF', exchange: 'NYSE' },
  { ticker: 'SHOP', sector: 'XLK', exchange: 'NYSE' },
  { ticker: 'UBER', sector: 'XLY', exchange: 'NYSE' },
  { ticker: 'SNAP', sector: 'XLC', exchange: 'NYSE' },
];

async function seedExpansion() {
  // Get existing tickers to skip
  const existing = await query('SELECT ticker FROM lc_v3.equity_profiles');
  const existingSet = new Set(existing.rows.map(r => r.ticker));

  let inserted = 0, skipped = 0;

  for (const { ticker, sector, exchange } of EXPANSION_TICKERS) {
    if (existingSet.has(ticker)) {
      skipped++;
      continue;
    }

    const exchangeEtf = exchange === 'NYSE' ? 'DIA' : 'QQQ';

    await query(`
      INSERT INTO lc_v3.equity_profiles (
        ticker, exchange, exchange_etf, sector_etf,
        cluster_role,
        opening_chop_minutes, momentum_persistence,
        sens_hyperscaler_capex, sens_export_restriction,
        sens_memory_pricing, sens_earnings_beat,
        sens_analyst_upgrade, news_fade_rate,
        options_liquidity_score
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (ticker) DO NOTHING
    `, [
      ticker, exchange, exchangeEtf, sector,
      'STANDALONE',
      15, 0.70,
      1.0, 1.0,
      1.0, 1.0,
      1.0, 0.40,
      0.70,
    ]);

    inserted++;
    logger.info(`  + ${ticker} (${exchange} / ${sector})`);
  }

  // Report final count
  const total = await query('SELECT COUNT(*) as cnt FROM lc_v3.equity_profiles');
  logger.info(`\nExpansion complete: ${inserted} inserted, ${skipped} already existed`);
  logger.info(`Total equity_profiles: ${total.rows[0].cnt} tickers`);
  logger.info('Note: ATR and volume baselines will auto-populate over the next few trading days');
}

seedExpansion().then(() => process.exit(0)).catch(err => {
  logger.error('Seed failed:', err);
  process.exit(1);
});
