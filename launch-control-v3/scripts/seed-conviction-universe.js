/**
 * Seed conviction universe — mid-cap optionable stocks not in equity_profiles
 * Phase 1: FMP stock-list → filter clean symbols → FMP profile for market cap/sector
 * Phase 2: Alpaca options check (requires valid keys — works on Render)
 * Run: node scripts/seed-conviction-universe.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import axios from 'axios';

const FMP_KEY = process.env.FMP_API_KEY;
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_DATA = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fmpProfile(ticker) {
  try {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${FMP_KEY}`;
    await sleep(250);
    const res = await axios.get(url, { timeout: 10000 });
    const data = res.data;
    return Array.isArray(data) ? data[0] : data;
  } catch {
    return null;
  }
}

async function checkOptions(ticker) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await axios.get(`${ALPACA_DATA}/v2/options/contracts`, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
      params: { underlying_symbol: ticker, limit: 1, expiration_date_gte: today },
      timeout: 8000,
    });
    return Array.isArray(res.data?.option_contracts) && res.data.option_contracts.length > 0;
  } catch {
    return null; // null = couldn't check (keys expired, etc.)
  }
}

async function main() {
  // Create table
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.conviction_universe (
      ticker VARCHAR(10) PRIMARY KEY,
      company_name VARCHAR(100),
      market_cap BIGINT,
      sector VARCHAR(50),
      industry VARCHAR(100),
      exchange VARCHAR(10),
      has_options BOOLEAN,
      added_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[UNIVERSE] Table lc_v3.conviction_universe ready');

  // Get existing tickers to exclude
  const existingRes = await query('SELECT ticker FROM lc_v3.equity_profiles');
  const existingUniRes = await query('SELECT ticker FROM lc_v3.conviction_universe');
  const existing = new Set([
    ...existingRes.rows.map(r => r.ticker),
    ...existingUniRes.rows.map(r => r.ticker),
  ]);
  console.log(`[UNIVERSE] ${existing.size} tickers already tracked (will skip)`);

  // Phase 1: Get all FMP symbols
  console.log('[UNIVERSE] Fetching FMP stock list...');
  const listRes = await axios.get(
    `https://financialmodelingprep.com/stable/stock-list?apikey=${FMP_KEY}`,
    { timeout: 30000 }
  );
  const allSymbols = (listRes.data || [])
    .map(s => s.symbol)
    .filter(s => s && /^[A-Z]{1,5}$/.test(s) && !existing.has(s));
  console.log(`[UNIVERSE] ${allSymbols.length} clean symbols after filtering existing`);

  // Phase 2: Fetch profiles to filter by market cap + exchange
  // Process in batches to stay under rate limits
  let added = 0;
  let checked = 0;
  let skippedCap = 0;
  let skippedExchange = 0;
  let skippedOptions = 0;
  const TARGET = 500; // stop after finding 500 qualifying tickers

  for (let i = 0; i < allSymbols.length && added < TARGET; i += 5) {
    const batch = allSymbols.slice(i, i + 5);

    await Promise.all(batch.map(async (ticker) => {
      if (added >= TARGET) return;
      checked++;

      const profile = await fmpProfile(ticker);
      if (!profile) return;

      const mktCap = profile.marketCap;
      const exchange = profile.exchange || profile.exchangeShortName;

      // Filter: NYSE/NASDAQ, $500M–$50B market cap
      if (!exchange || !['NYSE', 'NASDAQ'].some(e => (exchange || '').toUpperCase().includes(e))) {
        skippedExchange++;
        return;
      }
      if (!mktCap || mktCap < 500_000_000 || mktCap > 50_000_000_000) {
        skippedCap++;
        return;
      }

      // Check options availability (may return null if Alpaca keys expired)
      const hasOpts = await checkOptions(ticker);
      if (hasOpts === false) {
        skippedOptions++;
        console.log(`[UNIVERSE] ${ticker} — skipped (no options)`);
        return;
      }

      await query(`
        INSERT INTO lc_v3.conviction_universe
          (ticker, company_name, market_cap, sector, industry, exchange, has_options)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (ticker) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          market_cap = EXCLUDED.market_cap,
          sector = EXCLUDED.sector,
          industry = EXCLUDED.industry,
          exchange = EXCLUDED.exchange,
          has_options = COALESCE(EXCLUDED.has_options, lc_v3.conviction_universe.has_options),
          added_at = NOW()
      `, [
        ticker,
        (profile.companyName || '').slice(0, 100),
        Math.round(mktCap),
        profile.sector || null,
        profile.industry || null,
        exchange.includes('NYSE') ? 'NYSE' : 'NASDAQ',
        hasOpts,
      ]);

      added++;
      const optLabel = hasOpts === true ? 'opts=YES' : hasOpts === null ? 'opts=UNKNOWN' : 'opts=NO';
      console.log(`[UNIVERSE] ${ticker} — added (${optLabel}, $${(mktCap / 1e9).toFixed(1)}B, ${profile.sector || '?'})`);
    }));

    if (checked % 100 === 0) {
      console.log(`[UNIVERSE] Progress: ${checked} checked, ${added} added, ${skippedCap} cap-filtered, ${skippedExchange} exchange-filtered`);
    }
  }

  console.log(`\n[UNIVERSE] Done — ${added} tickers added, ${checked} checked`);
  console.log(`[UNIVERSE] Skipped: ${skippedCap} market cap, ${skippedExchange} exchange, ${skippedOptions} no options`);

  const totalRes = await query('SELECT COUNT(*) as cnt FROM lc_v3.conviction_universe');
  console.log(`[UNIVERSE] Total in conviction_universe: ${totalRes.rows[0].cnt}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[UNIVERSE] FATAL:', err.message);
  process.exit(1);
});
