/**
 * Seed fundamentals (income statement + cash flow) for all tracked tickers
 * Uses FMP /stable endpoints
 * Run: node scripts/seed-fundamentals.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import { sleep } from '../src/data/fmp.js';
import axios from 'axios';

const BASE_URL = 'https://financialmodelingprep.com/stable';
const API_KEY = process.env.FMP_API_KEY;

async function fmpGet(path, ticker) {
  try {
    const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}apikey=${API_KEY}`;
    await sleep(300);
    const res = await axios.get(url, { timeout: 15000 });
    return res.data || [];
  } catch (err) {
    console.error(`[FUND] ERROR ${ticker}: ${err.message}`);
    return [];
  }
}

async function main() {
  // Create table
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.fundamentals (
      ticker VARCHAR(10),
      period VARCHAR(10),
      revenue DECIMAL(18,2),
      gross_profit DECIMAL(18,2),
      operating_income DECIMAL(18,2),
      net_income DECIMAL(18,2),
      free_cash_flow DECIMAL(18,2),
      gross_margin DECIMAL(6,4),
      operating_margin DECIMAL(6,4),
      accounts_receivable DECIMAL(18,2),
      inventory DECIMAL(18,2),
      total_debt DECIMAL(18,2),
      cash_and_equivalents DECIMAL(18,2),
      reported_at DATE,
      PRIMARY KEY (ticker, period)
    )
  `);
  console.log('[FUND] Table lc_v3.fundamentals ready');

  // Get tickers
  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = profileRes.rows.map(r => r.ticker);
  console.log(`[FUND] ${tickers.length} tickers loaded`);

  let totalRows = 0;

  // Process in batches of 5
  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (ticker) => {
      const income = await fmpGet(`/income-statement?symbol=${ticker}&period=quarter&limit=8`, ticker);
      const cashflow = await fmpGet(`/cash-flow-statement?symbol=${ticker}&period=quarter&limit=8`, ticker);

      if (!Array.isArray(income) || income.length === 0) {
        console.log(`[FUND] ${ticker} — no income data`);
        return 0;
      }

      // Index cash flow by period for joining
      const cfMap = {};
      if (Array.isArray(cashflow)) {
        for (const cf of cashflow) {
          cfMap[cf.period] = cf;
        }
      }

      let inserted = 0;
      for (const q of income) {
        const period = q.period; // e.g. "Q1 2025"
        if (!period) continue;

        const cf = cfMap[period] || {};
        const grossMargin = q.revenue && q.revenue !== 0
          ? parseFloat((q.grossProfit / q.revenue).toFixed(4))
          : null;
        const opMargin = q.revenue && q.revenue !== 0
          ? parseFloat((q.operatingIncome / q.revenue).toFixed(4))
          : null;

        await query(`
          INSERT INTO lc_v3.fundamentals (
            ticker, period, revenue, gross_profit, operating_income, net_income,
            free_cash_flow, gross_margin, operating_margin,
            accounts_receivable, inventory, total_debt, cash_and_equivalents,
            reported_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (ticker, period) DO UPDATE SET
            revenue = EXCLUDED.revenue,
            gross_profit = EXCLUDED.gross_profit,
            operating_income = EXCLUDED.operating_income,
            net_income = EXCLUDED.net_income,
            free_cash_flow = EXCLUDED.free_cash_flow,
            gross_margin = EXCLUDED.gross_margin,
            operating_margin = EXCLUDED.operating_margin,
            accounts_receivable = EXCLUDED.accounts_receivable,
            inventory = EXCLUDED.inventory,
            total_debt = EXCLUDED.total_debt,
            cash_and_equivalents = EXCLUDED.cash_and_equivalents,
            reported_at = EXCLUDED.reported_at
        `, [
          ticker,
          period,
          q.revenue ?? null,
          q.grossProfit ?? null,
          q.operatingIncome ?? null,
          q.netIncome ?? null,
          cf.freeCashFlow ?? null,
          grossMargin,
          opMargin,
          cf.accountsReceivables ?? null,
          cf.inventory ?? null,
          cf.totalDebt ?? cf.netDebt ?? null,
          cf.cashAtEndOfPeriod ?? null,
          q.date || null,
        ]);
        inserted++;
      }

      console.log(`[FUND] ${ticker} — ${inserted} quarters inserted`);
      return inserted;
    }));

    totalRows += results.reduce((a, b) => a + b, 0);
  }

  console.log(`\n[FUND] Done — ${totalRows} total rows inserted`);
  process.exit(0);
}

main().catch(err => {
  console.error('[FUND] FATAL:', err.message);
  process.exit(1);
});
