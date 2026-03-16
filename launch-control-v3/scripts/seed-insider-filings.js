/**
 * Seed insider transactions, SEC 8-K filings, and insider summary
 * For all tickers in equity_profiles + conviction_universe
 * Run: node scripts/seed-insider-filings.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import axios from 'axios';

const BASE_URL = 'https://financialmodelingprep.com/stable';
const API_KEY = process.env.FMP_API_KEY;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fmpGet(path, ticker) {
  try {
    const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}apikey=${API_KEY}`;
    await sleep(300);
    const res = await axios.get(url, { timeout: 15000 });
    return res.data || [];
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[INSIDER] ERROR ${ticker}: ${err.message}`);
    }
    return [];
  }
}

const RED_FLAG_KEYWORDS = /departure|resign|terminat|restate|investigation|subpoena|default|going concern/i;

async function main() {
  // ── CREATE TABLES ──────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.insider_transactions (
      ticker VARCHAR(10),
      filing_date DATE,
      reporting_name VARCHAR(100),
      title VARCHAR(100),
      transaction_type VARCHAR(20),
      shares_traded BIGINT,
      price DECIMAL(10,2),
      value DECIMAL(14,2),
      shares_owned_after BIGINT,
      PRIMARY KEY (ticker, filing_date, reporting_name, transaction_type)
    )
  `);
  console.log('[INSIDER] Table lc_v3.insider_transactions ready');

  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.sec_filings (
      ticker VARCHAR(10),
      filing_date DATE,
      form_type VARCHAR(20),
      description TEXT,
      filing_url TEXT,
      is_red_flag BOOLEAN DEFAULT FALSE,
      red_flag_reason TEXT,
      PRIMARY KEY (ticker, filing_date, form_type)
    )
  `);
  console.log('[INSIDER] Table lc_v3.sec_filings ready');

  // Add insider columns to ticker_intelligence
  await query(`ALTER TABLE lc_v3.ticker_intelligence ADD COLUMN IF NOT EXISTS insider_net_90d DECIMAL(14,2)`);
  await query(`ALTER TABLE lc_v3.ticker_intelligence ADD COLUMN IF NOT EXISTS insider_signal VARCHAR(10)`);
  console.log('[INSIDER] ticker_intelligence columns ready');

  // ── GET ALL TICKERS ────────────────────────────────────────────────────────
  const epRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const cuRes = await query('SELECT ticker FROM lc_v3.conviction_universe ORDER BY ticker');
  const allTickers = [...new Set([
    ...epRes.rows.map(r => r.ticker),
    ...cuRes.rows.map(r => r.ticker),
  ])].sort();
  console.log(`[INSIDER] ${allTickers.length} tickers to process`);

  let insiderRows = 0;
  let filingRows = 0;
  let redFlags = 0;

  // ── PROCESS IN BATCHES OF 5 ───────────────────────────────────────────────
  for (let i = 0; i < allTickers.length; i += 5) {
    const batch = allTickers.slice(i, i + 5);

    await Promise.all(batch.map(async (ticker) => {
      // 1) Insider transactions
      const insiders = await fmpGet(`/insider-trading?symbol=${ticker}&limit=20`, ticker);
      if (Array.isArray(insiders)) {
        for (const tx of insiders) {
          if (!tx.filingDate || !tx.reportingName || !tx.transactionType) continue;
          try {
            await query(`
              INSERT INTO lc_v3.insider_transactions
                (ticker, filing_date, reporting_name, title, transaction_type,
                 shares_traded, price, value, shares_owned_after)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
              ON CONFLICT (ticker, filing_date, reporting_name, transaction_type) DO NOTHING
            `, [
              ticker,
              tx.filingDate,
              (tx.reportingName || '').slice(0, 100),
              (tx.typeOfOwner || tx.reportingTitle || '').slice(0, 100),
              tx.transactionType,
              tx.securitiesTransacted || null,
              tx.price || null,
              tx.securitiesTransacted && tx.price
                ? Math.round(tx.securitiesTransacted * tx.price * 100) / 100
                : null,
              tx.securitiesOwned || null,
            ]);
            insiderRows++;
          } catch { /* dupe or constraint — skip */ }
        }
      }

      // 2) SEC 8-K filings
      const filings = await fmpGet(`/sec_filings?symbol=${ticker}&type=8-K&limit=10`, ticker);
      if (Array.isArray(filings)) {
        for (const f of filings) {
          if (!f.fillingDate && !f.filingDate) continue;
          const fDate = f.fillingDate || f.filingDate;
          const desc = f.description || f.title || '';
          const isRedFlag = RED_FLAG_KEYWORDS.test(desc);
          const reason = isRedFlag
            ? desc.match(RED_FLAG_KEYWORDS)?.[0] || 'keyword match'
            : null;

          try {
            await query(`
              INSERT INTO lc_v3.sec_filings
                (ticker, filing_date, form_type, description, filing_url, is_red_flag, red_flag_reason)
              VALUES ($1,$2,$3,$4,$5,$6,$7)
              ON CONFLICT (ticker, filing_date, form_type) DO UPDATE SET
                description = EXCLUDED.description,
                filing_url = EXCLUDED.filing_url,
                is_red_flag = EXCLUDED.is_red_flag,
                red_flag_reason = EXCLUDED.red_flag_reason
            `, [
              ticker,
              fDate,
              f.type || '8-K',
              desc.slice(0, 500),
              f.finalLink || f.link || null,
              isRedFlag,
              reason,
            ]);
            filingRows++;
            if (isRedFlag) redFlags++;
          } catch { /* skip */ }
        }
      }

      console.log(`[INSIDER] ${ticker} done`);
    }));

    if ((i + 5) % 50 === 0) {
      console.log(`[INSIDER] Progress: ${i + 5}/${allTickers.length} tickers, ${insiderRows} insider rows, ${filingRows} filings`);
    }
  }

  console.log(`\n[INSIDER] Insider transactions: ${insiderRows} rows`);
  console.log(`[INSIDER] SEC filings: ${filingRows} rows (${redFlags} red flags)`);

  // ── 3) COMPUTE INSIDER SUMMARY ────────────────────────────────────────────
  console.log('[INSIDER] Computing insider summary...');

  const summaryRes = await query(`
    SELECT ticker,
      COALESCE(SUM(CASE WHEN transaction_type IN ('S-Sale','P-Sale','S-Sale+OE') AND filing_date >= CURRENT_DATE - 90
        THEN ABS(value) ELSE 0 END), 0) as sell_total,
      COALESCE(SUM(CASE WHEN transaction_type IN ('P-Purchase','A-Award') AND filing_date >= CURRENT_DATE - 90
        THEN ABS(value) ELSE 0 END), 0) as buy_total
    FROM lc_v3.insider_transactions
    GROUP BY ticker
  `);

  let updated = 0;
  for (const row of summaryRes.rows) {
    const sell = parseFloat(row.sell_total);
    const buy = parseFloat(row.buy_total);
    const net = buy - sell;
    const signal = net < -100000 ? 'SELLING'
                 : net > 100000 ? 'BUYING'
                 : 'NEUTRAL';

    await query(`
      UPDATE lc_v3.ticker_intelligence
      SET insider_net_90d = $2, insider_signal = $3, last_updated = NOW()
      WHERE ticker = $1
    `, [row.ticker, net, signal]);
    updated++;
  }

  console.log(`[INSIDER] Updated ${updated} tickers in ticker_intelligence`);

  // Show top sellers and buyers
  const topSellers = await query(`
    SELECT ticker, insider_net_90d, insider_signal
    FROM lc_v3.ticker_intelligence
    WHERE insider_signal = 'SELLING'
    ORDER BY insider_net_90d ASC LIMIT 10
  `);
  if (topSellers.rows.length > 0) {
    console.log('\n[INSIDER] Top sellers (90d):');
    for (const r of topSellers.rows) {
      console.log(`  ${r.ticker.padEnd(8)} $${(parseFloat(r.insider_net_90d) / 1e6).toFixed(1)}M net`);
    }
  }

  const topBuyers = await query(`
    SELECT ticker, insider_net_90d, insider_signal
    FROM lc_v3.ticker_intelligence
    WHERE insider_signal = 'BUYING'
    ORDER BY insider_net_90d DESC LIMIT 10
  `);
  if (topBuyers.rows.length > 0) {
    console.log('\n[INSIDER] Top buyers (90d):');
    for (const r of topBuyers.rows) {
      console.log(`  ${r.ticker.padEnd(8)} +$${(parseFloat(r.insider_net_90d) / 1e6).toFixed(1)}M net`);
    }
  }

  console.log('\n[INSIDER] Done');
  process.exit(0);
}

main().catch(err => {
  console.error('[INSIDER] FATAL:', err.message);
  process.exit(1);
});
