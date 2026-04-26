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

  // 1. Get minute bars from DB (filter to requested tickers if small set)
  console.log('[DATA-DB] Fetching minute bars...');
  const filterTickers = tickers.length <= 10;
  const barsRes = filterTickers
    ? await query(`
        SELECT ticker, ts, open, high, low, close, volume, vwap, session
        FROM lc_v3.bars
        WHERE ts >= $1::date AND ts < ($2::date + interval '1 day')
          AND ticker = ANY($3)
        ORDER BY ticker, ts
      `, [earlyStartStr, endDate, tickers])
    : await query(`
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
  for (const etf of ['SPY', 'QQQ', 'IWM']) {
    etfMinuteBars[etf] = minuteBars[etf] || {};
  }

  // Always fetch from Alpaca API if DB coverage is incomplete for the date range.
  // DB may have partial data (e.g. 164 days vs 353 in range). Alpaca fills the gaps.
  const expectedDays = Math.round((new Date(endDate) - new Date(startDate)) / 86400000 * 5 / 7); // rough estimate
  const spyDBDays = Object.keys(etfMinuteBars.SPY).length > 0
    ? new Set(Object.keys(etfMinuteBars.SPY).map(k => k.slice(0, 10))).size : 0;
  const needAPIFill = spyDBDays < expectedDays * 0.8; // fetch if DB has <80% of expected days

  if (needAPIFill && API_HEADERS['APCA-API-KEY-ID']) {
    console.log(`[DATA-DB] DB has ${spyDBDays} SPY days vs ~${expectedDays} expected — fetching from Alpaca API to fill gaps`);
    for (const etf of ['SPY', 'QQQ', 'IWM']) {
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
    console.log(`[DATA-DB] SPY bars: ${Object.keys(etfMinuteBars.SPY).length}, QQQ bars: ${Object.keys(etfMinuteBars.QQQ).length}, IWM bars: ${Object.keys(etfMinuteBars.IWM || {}).length}`);
  }

  // Sentiment ETFs — HYG (high yield bonds, risk-on/off) and TLT (treasuries, rate/fear)
  // Used for directional confirmation: IWM up + HYG up = confirmed risk-on
  const sentimentBars = {};
  if (API_HEADERS['APCA-API-KEY-ID']) {
    for (const etf of ['HYG', 'TLT']) {
      try {
        const apiBars = await fetchBarsFromAPI(etf, '5Min', startDate, endDate, 'sip');
        sentimentBars[etf] = {};
        for (const bar of apiBars) {
          const key = new Date(bar.t).toISOString().slice(0, 16);
          sentimentBars[etf][key] = { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 };
        }
        console.log(`[DATA-DB] Sentiment (${etf}): ${Object.keys(sentimentBars[etf]).length} bars loaded`);
      } catch (err) {
        console.warn(`[DATA-DB] ${etf} fetch failed: ${err.message}`);
      }
    }
  }

  // VIX — try VIXY ETF as proxy (VIX index not available via /v2/stocks)
  // VIXY tracks VIX short-term futures; we convert its price to approximate VIX level
  const vixByTime = {};
  if (API_HEADERS['APCA-API-KEY-ID']) {
    // Try VIXY (ProShares VIX Short-Term Futures ETF) as VIX proxy
    const vixProxies = ['VIXY', 'UVXY'];
    let loaded = false;
    for (const proxy of vixProxies) {
      if (loaded) break;
      try {
        const proxyBars = await fetchBarsFromAPI(proxy, '15Min', startDate, endDate, 'sip');
        if (proxyBars.length > 0) {
          // Use VIXY price as relative VIX proxy: VIXY ~$15-25 when VIX ~15-25
          // Not exact but captures regime changes (spikes/calms)
          for (const bar of proxyBars) {
            const key = new Date(bar.t).toISOString().slice(0, 16);
            vixByTime[key] = bar.c; // VIXY price roughly tracks VIX level
          }
          console.log(`[DATA-DB] VIX proxy (${proxy}): ${Object.keys(vixByTime).length} data points loaded`);
          loaded = true;
        }
      } catch (err) {
        console.warn(`[DATA-DB] ${proxy} fetch failed: ${err.message}`);
      }
    }
    if (!loaded) {
      console.log('[DATA-DB] No VIX proxy data — defaults to 18');
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
    sentimentBars,
    vixByTime,
    newsByTickerDate,
    tradingDays,
    rawMinuteBars,
  };
}
