#!/usr/bin/env node
/**
 * Seed 0DTE options 1-minute bars from Alpaca historical data.
 *
 * For each trading day, determines the ATM strikes (nearest ± $2) for IWM,
 * fetches 1-min OHLCV bars for those 0DTE contracts, and stores them in
 * lc_v3.options_bars_1m on Render Postgres.
 *
 * This gives us real contract prices for backtesting instead of
 * simulated Greeks (delta/gamma/theta) which are unreliable on 0DTE.
 *
 * Usage: node scripts/seed-options-bars.js [startDate] [endDate] [--spy]
 *   Default: 18 months back from today, IWM only
 *   --spy: also seed SPY options
 */

import 'dotenv/config';
import axios from 'axios';
import { query } from '../src/data/db.js';

const DATA_URL = 'https://data.alpaca.markets';
const HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BATCH_SIZE = 500;
const STRIKE_RANGE = 2; // ATM ± $2 = 5 strikes × 2 (C+P) = 10 contracts/day

const flags = process.argv.filter(a => a.startsWith('--'));
const TICKERS = flags.includes('--spy') ? ['IWM', 'SPY'] : ['IWM'];

// ── DST helpers ─────────────────────────────────────────────────────────────

function isEDT(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const mar1Day = new Date(y, 2, 1).getDay();
  const secondSunMar = mar1Day === 0 ? 8 : (14 - mar1Day + 1);
  const nov1Day = new Date(y, 10, 1).getDay();
  const firstSunNov = nov1Day === 0 ? 1 : (7 - nov1Day + 1);
  const mmdd = m * 100 + d;
  return mmdd >= (300 + secondSunMar) && mmdd < (1100 + firstSunNov);
}

function getRTHBounds(dateStr) {
  return isEDT(dateStr)
    ? { startUTC: '13:30:00', endUTC: '20:00:00' }
    : { startUTC: '14:30:00', endUTC: '21:00:00' };
}

// ── OCC symbol builder ──────────────────────────────────────────────────────
//
// Format: IWM250417C00185000
//   root:   IWM (underlying ticker)
//   expiry: 250417 (YYMMDD)
//   type:   C or P
//   strike: 00185000 (strike * 1000, zero-padded to 8 digits)

function buildOCCSymbol(ticker, dateStr, optionType, strike) {
  const [y, m, d] = dateStr.split('-');
  const yy = y.slice(2);
  const mm = m.padStart(2, '0');
  const dd = d.padStart(2, '0');
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${ticker}${yy}${mm}${dd}${optionType}${strikePart}`;
}

function parseOCCSymbol(symbol) {
  // IWM250417C00185000
  // Find where digits start for the date portion
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, ticker, dateCode, optionType, strikeCode] = match;
  const yy = dateCode.slice(0, 2);
  const mm = dateCode.slice(2, 4);
  const dd = dateCode.slice(4, 6);
  const strike = parseInt(strikeCode) / 1000;
  return {
    ticker,
    expiry: `20${yy}-${mm}-${dd}`,
    optionType,
    strike,
  };
}

// ── Create table ────────────────────────────────────────────────────────────

async function createTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.options_bars_1m (
      symbol      TEXT NOT NULL,
      ticker      TEXT NOT NULL,
      ts          TIMESTAMPTZ NOT NULL,
      expiry      DATE NOT NULL,
      strike      NUMERIC(10,2) NOT NULL,
      option_type CHAR(1) NOT NULL,
      open        NUMERIC(10,4) NOT NULL,
      high        NUMERIC(10,4) NOT NULL,
      low         NUMERIC(10,4) NOT NULL,
      close       NUMERIC(10,4) NOT NULL,
      volume      BIGINT NOT NULL DEFAULT 0,
      trade_count INTEGER NOT NULL DEFAULT 0,
      vwap        NUMERIC(10,4),
      PRIMARY KEY (symbol, ts)
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_options_bars_1m_ticker_ts
    ON lc_v3.options_bars_1m (ticker, ts);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_options_bars_1m_expiry_strike
    ON lc_v3.options_bars_1m (ticker, expiry, strike, option_type);`);
  console.log('[SEED] Table lc_v3.options_bars_1m ready');
}

// ── Get stock opening price for each day ────────────────────────────────────

async function getStockDayPrices(ticker, startDate, endDate) {
  // Get daily OHLC from Alpaca stock bars
  const dayPrices = {};
  let pageToken = null;

  do {
    const params = {
      timeframe: '1Day',
      start: `${startDate}T00:00:00Z`,
      end: `${endDate}T23:59:59Z`,
      limit: 1000,
      adjustment: 'split',
    };
    if (pageToken) params.page_token = pageToken;

    try {
      const res = await axios.get(`${DATA_URL}/v2/stocks/${ticker}/bars`, {
        headers: HEADERS, params, timeout: 15000,
      });
      for (const bar of (res.data.bars || [])) {
        const date = bar.t.split('T')[0];
        dayPrices[date] = {
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
        };
      }
      pageToken = res.data.next_page_token || null;
    } catch (err) {
      console.error(`  Error fetching ${ticker} daily bars: ${err.message}`);
      break;
    }
  } while (pageToken);

  return dayPrices;
}

// ── Fetch options bars for a batch of symbols ───────────────────────────────

async function fetchOptionsBars(symbols, date) {
  const { startUTC, endUTC } = getRTHBounds(date);
  const start = `${date}T${startUTC}Z`;
  const end = `${date}T${endUTC}Z`;

  const allBars = {}; // symbol → bars[]
  let pageToken = null;
  let totalBars = 0;

  // Alpaca supports multi-symbol in a single request (comma-separated)
  const symbolStr = symbols.join(',');

  do {
    const params = {
      symbols: symbolStr,
      timeframe: '1Min',
      start,
      end,
      limit: 10000,
    };
    if (pageToken) params.page_token = pageToken;

    try {
      const res = await axios.get(`${DATA_URL}/v1beta1/options/bars`, {
        headers: HEADERS, params, timeout: 30000,
      });

      const barsData = res.data.bars || {};
      for (const [sym, bars] of Object.entries(barsData)) {
        if (!allBars[sym]) allBars[sym] = [];
        allBars[sym].push(...bars);
        totalBars += bars.length;
      }

      pageToken = res.data.next_page_token || null;
      if (pageToken) await sleep(300);
    } catch (err) {
      if (err.response?.status === 429) {
        console.log('    Rate limited, waiting 5s...');
        await sleep(5000);
        continue;
      }
      if (err.response?.status === 422) {
        // Symbol doesn't exist (no options on that date) — skip
        break;
      }
      console.error(`    API error: ${err.response?.status || err.message}`);
      break;
    }
  } while (pageToken);

  return { bars: allBars, totalBars };
}

// ── Insert bars into DB ─────────────────────────────────────────────────────

async function insertOptionsBars(allBars) {
  const rows = [];
  for (const [symbol, bars] of Object.entries(allBars)) {
    const parsed = parseOCCSymbol(symbol);
    if (!parsed) continue;

    for (const bar of bars) {
      rows.push({
        symbol,
        ticker: parsed.ticker,
        ts: bar.t,
        expiry: parsed.expiry,
        strike: parsed.strike,
        optionType: parsed.optionType,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v || 0,
        n: bar.n || 0,
        vw: bar.vw || null,
      });
    }
  }

  if (rows.length === 0) return 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of batch) {
      values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, $${paramIdx+8}, $${paramIdx+9}, $${paramIdx+10}, $${paramIdx+11}, $${paramIdx+12})`);
      params.push(
        row.symbol, row.ticker, row.ts, row.expiry, row.strike, row.optionType,
        row.o, row.h, row.l, row.c, row.v, row.n, row.vw
      );
      paramIdx += 13;
    }

    await query(`
      INSERT INTO lc_v3.options_bars_1m
        (symbol, ticker, ts, expiry, strike, option_type, open, high, low, close, volume, trade_count, vwap)
      VALUES ${values.join(', ')}
      ON CONFLICT (symbol, ts) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
        volume = EXCLUDED.volume, trade_count = EXCLUDED.trade_count, vwap = EXCLUDED.vwap
    `, params);
  }

  return rows.length;
}

// ── Generate trading days ───────────────────────────────────────────────────

function getTradingDays(start, end) {
  const days = [];
  const d = new Date(start);
  const endD = new Date(end);
  while (d <= endD) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(d.toISOString().split('T')[0]);
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Check existing data ─────────────────────────────────────────────────────

async function getExistingDays(ticker) {
  const r = await query(`
    SELECT DISTINCT expiry::date as d
    FROM lc_v3.options_bars_1m
    WHERE ticker = $1
    ORDER BY d
  `, [ticker]);
  return new Set(r.rows.map(r => r.d.toISOString().split('T')[0]));
}

// ── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const endDate = args[1] || new Date().toISOString().split('T')[0];
const startDate = args[0] || (() => {
  const d = new Date();
  d.setMonth(d.getMonth() - 18);
  return d.toISOString().split('T')[0];
})();

console.log(`\n${'='.repeat(70)}`);
console.log(`  SEED 0DTE OPTIONS 1-MINUTE BARS`);
console.log(`  Tickers: ${TICKERS.join(', ')}`);
console.log(`  Range: ${startDate} → ${endDate}`);
console.log(`  Strikes: ATM ± $${STRIKE_RANGE} (${(STRIKE_RANGE * 2 + 1) * 2} contracts/day)`);
console.log(`${'='.repeat(70)}\n`);

await createTable();

const allDays = getTradingDays(startDate, endDate);

let grandTotalBars = 0;
let grandTotalDays = 0;
let grandTotalContracts = 0;
const startTime = Date.now();

for (const ticker of TICKERS) {
  console.log(`\n[${ticker}] Fetching daily stock prices to determine ATM strikes...`);
  const dayPrices = await getStockDayPrices(ticker, startDate, endDate);
  console.log(`[${ticker}] ${Object.keys(dayPrices).length} days of stock data`);

  const existingDays = await getExistingDays(ticker);
  const daysToFetch = allDays.filter(d => dayPrices[d] && !existingDays.has(d));

  console.log(`[${ticker}] ${allDays.length} trading days in range`);
  console.log(`[${ticker}] ${existingDays.size} days already seeded`);
  console.log(`[${ticker}] ${daysToFetch.length} days to fetch\n`);

  let tickerBars = 0;
  let tickerContracts = 0;

  for (let i = 0; i < daysToFetch.length; i++) {
    const date = daysToFetch[i];
    const pct = ((i / daysToFetch.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const rate = i > 0 ? ((Date.now() - startTime) / i / 1000).toFixed(1) : '?';
    const eta = i > 0 ? (((daysToFetch.length - i) * (Date.now() - startTime) / i) / 1000 / 60).toFixed(1) : '?';

    const prices = dayPrices[date];
    if (!prices) {
      continue; // no stock data for this day (holiday)
    }

    // Determine ATM strike based on opening price
    const atmStrike = Math.round(prices.open);
    const strikes = [];
    for (let s = atmStrike - STRIKE_RANGE; s <= atmStrike + STRIKE_RANGE; s++) {
      strikes.push(s);
    }

    // Build OCC symbols for calls and puts at each strike
    const symbols = [];
    for (const strike of strikes) {
      symbols.push(buildOCCSymbol(ticker, date, 'C', strike));
      symbols.push(buildOCCSymbol(ticker, date, 'P', strike));
    }

    process.stdout.write(`  [${pct}%] ${date} ${ticker}@$${prices.open.toFixed(0)} strikes ${strikes[0]}-${strikes[strikes.length-1]} (${symbols.length} contracts)  ${elapsed}m elapsed, ~${eta}m remaining  `);

    try {
      const { bars, totalBars } = await fetchOptionsBars(symbols, date);

      if (totalBars === 0) {
        console.log('— no options data (holiday?)');
        continue;
      }

      const inserted = await insertOptionsBars(bars);
      const contractsWithData = Object.keys(bars).filter(k => bars[k].length > 0).length;

      tickerBars += inserted;
      tickerContracts += contractsWithData;
      grandTotalBars += inserted;
      grandTotalContracts += contractsWithData;
      grandTotalDays++;

      console.log(`${inserted} bars across ${contractsWithData} contracts`);

      // Rate limit between days
      await sleep(200);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  console.log(`\n[${ticker}] Done: ${tickerBars.toLocaleString()} bars, ${tickerContracts} contracts`);
}

const totalMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

console.log(`\n${'='.repeat(70)}`);
console.log(`  SEED COMPLETE`);
console.log(`  Days: ${grandTotalDays} fetched`);
console.log(`  Bars: ${grandTotalBars.toLocaleString()} options 1-min bars inserted`);
console.log(`  Contracts: ${grandTotalContracts.toLocaleString()} unique contracts`);
console.log(`  Time: ${totalMinutes} minutes`);
console.log(`${'='.repeat(70)}\n`);

// Verify
for (const ticker of TICKERS) {
  const verify = await query(`
    SELECT COUNT(*) as bars,
           COUNT(DISTINCT symbol) as contracts,
           COUNT(DISTINCT expiry) as days,
           MIN(ts) as earliest,
           MAX(ts) as latest
    FROM lc_v3.options_bars_1m WHERE ticker = $1
  `, [ticker]);
  const r = verify.rows[0];
  console.log(`[VERIFY ${ticker}] ${r.bars} bars, ${r.contracts} contracts, ${r.days} days`);
  console.log(`[VERIFY ${ticker}] ${r.earliest?.toISOString().slice(0,10)} → ${r.latest?.toISOString().slice(0,10)}`);
}

process.exit(0);
