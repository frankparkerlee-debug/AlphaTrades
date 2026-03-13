/**
 * Historical Data Fetcher — DB-backed version
 * Reads from lc_v3.bars instead of Alpaca API.
 * Used when running backtest on Render where bars are already seeded.
 */
import { query } from '../../src/data/db.js';

/**
 * Fetch all data from the database for the given date range.
 * Returns the same structure as data-fetcher.js's fetchAllData().
 */
export async function fetchAllDataFromDB(config, tickers) {
  const { startDate, endDate } = config;

  // Need a few days before startDate for prevDailyBar
  const earlyStart = new Date(startDate);
  earlyStart.setDate(earlyStart.getDate() - 7);
  const earlyStartStr = earlyStart.toISOString().split('T')[0];

  console.log(`\n[DATA-DB] Fetching from database for ${tickers.length} tickers: ${startDate} → ${endDate}`);

  // 1. Get all minute bars from DB
  console.log('[DATA-DB] Fetching minute bars...');
  const barsRes = await query(`
    SELECT ticker, ts, open, high, low, close, volume, vwap, session
    FROM lc_v3.bars
    WHERE ts >= $1::date AND ts < ($2::date + interval '1 day')
    ORDER BY ticker, ts
  `, [earlyStartStr, endDate]);

  console.log(`[DATA-DB] ${barsRes.rows.length} total bars from DB`);

  // Index by ticker → minute key
  const minuteBars = {};
  const rawMinuteBars = {};
  const dailyByTicker = {};

  for (const row of barsRes.rows) {
    const ticker = row.ticker;
    const ts = new Date(row.ts);
    const dateStr = ts.toISOString().split('T')[0];
    const minuteKey = ts.toISOString().slice(0, 16);

    const bar = {
      t: ts.toISOString(),
      o: parseFloat(row.open),
      h: parseFloat(row.high),
      l: parseFloat(row.low),
      c: parseFloat(row.close),
      v: parseInt(row.volume),
      vw: row.vwap ? parseFloat(row.vwap) : null,
    };

    // Minute index
    if (!minuteBars[ticker]) minuteBars[ticker] = {};
    minuteBars[ticker][minuteKey] = bar;

    // Raw arrays for PnL simulator
    if (!rawMinuteBars[ticker]) rawMinuteBars[ticker] = [];
    rawMinuteBars[ticker].push(bar);

    // Daily aggregation
    if (!dailyByTicker[ticker]) dailyByTicker[ticker] = {};
    if (!dailyByTicker[ticker][dateStr]) {
      dailyByTicker[ticker][dateStr] = { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: 0 };
    }
    const daily = dailyByTicker[ticker][dateStr];
    daily.h = Math.max(daily.h, bar.h);
    daily.l = Math.min(daily.l, bar.l);
    daily.c = bar.c; // last close of the day
    daily.v += bar.v;
  }

  // Build daily bars indexed by date
  const dailyBars = {};
  for (const [ticker, dates] of Object.entries(dailyByTicker)) {
    dailyBars[ticker] = {};
    for (const [date, agg] of Object.entries(dates)) {
      dailyBars[ticker][date] = {
        t: `${date}T16:00:00Z`,
        o: agg.o,
        h: agg.h,
        l: agg.l,
        c: agg.c,
        v: agg.v,
      };
    }
  }

  // ETF minute bars (SPY/QQQ if they're in the bars table)
  const etfMinuteBars = {};
  for (const etf of ['SPY', 'QQQ']) {
    etfMinuteBars[etf] = minuteBars[etf] || {};
  }

  // If no SPY/QQQ in bars, fetch from Alpaca snapshots as daily approximation
  if (Object.keys(etfMinuteBars.SPY).length === 0) {
    console.log('[DATA-DB] No SPY/QQQ bars in DB — backtest will have limited market context');
  }

  // VIX — not in DB, use default
  const vixByTime = {};
  console.log('[DATA-DB] VIX not in DB — using default 18');

  // News — not in DB for backtest, will return empty
  const newsByTickerDate = {};

  // Trading days from available data
  const allDates = new Set();
  for (const ticker of tickers) {
    if (minuteBars[ticker]) {
      for (const key of Object.keys(minuteBars[ticker])) {
        const d = key.slice(0, 10);
        if (d >= startDate && d <= endDate) allDates.add(d);
      }
    }
  }
  const tradingDays = [...allDates].sort();

  console.log(`[DATA-DB] Trading days in range: ${tradingDays.length}`);
  console.log(`[DATA-DB] Tickers with data: ${Object.keys(minuteBars).length}`);
  console.log(`[DATA-DB] Data fetch complete.\n`);

  return {
    dailyBars,
    minuteBars,
    etfMinuteBars,
    vixByTime,
    newsByTickerDate,
    tradingDays,
    rawMinuteBars,
  };
}
