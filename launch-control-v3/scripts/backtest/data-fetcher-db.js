/**
 * Historical Data Fetcher — DB-backed version
 * Reads from lc_v3.bars instead of Alpaca API.
 * Used when running backtest on Render where bars are already seeded.
 *
 * Falls back to Alpaca API for SPY/QQQ/VIX when not in DB
 * (critical for regime detection accuracy).
 */
import { query } from '../../src/data/db.js';
import axios from 'axios';

const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const API_HEADERS = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

/**
 * Fetch minute bars from Alpaca API for a single symbol.
 * Used as fallback for SPY/QQQ/VIX when they're missing from DB.
 */
async function fetchBarsFromAPI(symbol, timeframe, startDate, endDate, feed = 'sip') {
  const allBars = [];
  let pageToken = null;
  try {
    do {
      const params = {
        timeframe, start: `${startDate}T00:00:00Z`, end: `${endDate}T23:59:59Z`,
        feed, adjustment: 'all', limit: 10000,
      };
      if (pageToken) params.page_token = pageToken;
      const res = await axios.get(`${DATA_URL}/v2/stocks/${symbol}/bars`, {
        headers: API_HEADERS, params, timeout: 15000,
      });
      allBars.push(...(res.data.bars || []));
      pageToken = res.data.next_page_token || null;
    } while (pageToken);
    console.log(`[DATA-DB] Fetched ${allBars.length} ${timeframe} bars for ${symbol} from Alpaca API`);
  } catch (err) {
    console.warn(`[DATA-DB] API fetch failed for ${symbol}: ${err.message}`);
  }
  return allBars;
}

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

  // ETF minute bars (SPY/QQQ) — critical for regime detection
  // If not in DB, fetch from Alpaca API (real data >> synthetic flat bars)
  const etfMinuteBars = {};
  for (const etf of ['SPY', 'QQQ']) {
    etfMinuteBars[etf] = minuteBars[etf] || {};
  }

  if (Object.keys(etfMinuteBars.SPY).length === 0 && API_HEADERS['APCA-API-KEY-ID']) {
    console.log('[DATA-DB] No SPY/QQQ bars in DB — fetching from Alpaca API for accurate regime detection');
    for (const etf of ['SPY', 'QQQ']) {
      try {
        const apiBars = await fetchBarsFromAPI(etf, '1Min', startDate, endDate, 'sip');
        for (const bar of apiBars) {
          const ts = new Date(bar.t);
          const minuteKey = ts.toISOString().slice(0, 16);
          const dateStr = ts.toISOString().split('T')[0];
          const formatted = { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0, vw: bar.vw || null };
          etfMinuteBars[etf][minuteKey] = formatted;
          // Also add to daily aggregation
          if (!dailyBars[etf]) dailyBars[etf] = {};
          if (!dailyBars[etf][dateStr]) {
            dailyBars[etf][dateStr] = { t: `${dateStr}T16:00:00Z`, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: 0 };
          } else {
            const d = dailyBars[etf][dateStr];
            d.h = Math.max(d.h, bar.h);
            d.l = Math.min(d.l, bar.l);
            d.c = bar.c;
            d.v += (bar.v || 0);
          }
        }
      } catch (err) {
        console.warn(`[DATA-DB] Failed to fetch ${etf} from API: ${err.message}`);
      }
    }
    console.log(`[DATA-DB] SPY bars: ${Object.keys(etfMinuteBars.SPY).length}, QQQ bars: ${Object.keys(etfMinuteBars.QQQ).length}`);
  }

  // VIX — fetch from API for accurate volatility regime detection
  const vixByTime = {};
  if (API_HEADERS['APCA-API-KEY-ID']) {
    try {
      const vixBars = await fetchBarsFromAPI('VIX', '15Min', startDate, endDate, 'iex');
      for (const bar of vixBars) {
        const key = new Date(bar.t).toISOString().slice(0, 16);
        vixByTime[key] = bar.c;
      }
      console.log(`[DATA-DB] VIX: ${Object.keys(vixByTime).length} data points loaded`);
    } catch (err) {
      console.warn(`[DATA-DB] VIX fetch failed — using default 18: ${err.message}`);
    }
  } else {
    console.log('[DATA-DB] No Alpaca keys — VIX defaults to 18');
  }

  // News — not in DB for backtest, will return empty
  const newsByTickerDate = {};

  // Trading days from available data (use all tickers, not just SPY)
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
