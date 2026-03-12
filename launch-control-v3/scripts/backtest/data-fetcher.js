/**
 * Historical Data Fetcher
 * Fetches daily bars, minute bars, VIX, SPY/QQQ, and news from Alpaca.
 * Rate-limited to stay under 200 req/min.
 */

import axios from 'axios';

const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const HEADERS  = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

// ── Rate Limiter ──────────────────────────────────────────────────
let tokens = 150;
let lastRefill = Date.now();
const RATE = 150; // tokens per minute

async function waitForToken() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 60000; // minutes
  tokens = Math.min(RATE, tokens + elapsed * RATE);
  lastRefill = now;

  if (tokens < 1) {
    const waitMs = ((1 - tokens) / RATE) * 60000;
    await new Promise(r => setTimeout(r, waitMs + 100));
    tokens = 1;
  }
  tokens--;
}

async function alpacaGet(url, params, timeout = 15000) {
  await waitForToken();
  const res = await axios.get(url, { headers: HEADERS, params, timeout });
  return res.data;
}

// ── Paginated Bar Fetch ───────────────────────────────────────────
async function fetchBars(ticker, timeframe, start, end, feed) {
  const allBars = [];
  let pageToken = null;

  do {
    const params = {
      timeframe,
      start: `${start}T00:00:00Z`,
      end:   `${end}T23:59:59Z`,
      feed,
      adjustment: 'all',
      limit: 10000,
    };
    if (pageToken) params.page_token = pageToken;

    const data = await alpacaGet(`${DATA_URL}/v2/stocks/${ticker}/bars`, params);
    const bars = data.bars || [];
    allBars.push(...bars);
    pageToken = data.next_page_token || null;
  } while (pageToken);

  return allBars;
}

// ── News Fetch ────────────────────────────────────────────────────
async function fetchNews(ticker, start, end) {
  const allNews = [];
  let pageToken = null;

  do {
    const params = {
      symbols: ticker,
      start: `${start}T00:00:00Z`,
      end:   `${end}T23:59:59Z`,
      limit: 50,
      sort: 'desc',
    };
    if (pageToken) params.page_token = pageToken;

    const data = await alpacaGet(`${DATA_URL}/v1beta1/news`, params);
    const news = data.news || [];
    allNews.push(...news);
    pageToken = data.next_page_token || null;

    // Cap at 200 headlines per ticker per range to avoid excessive API calls
    if (allNews.length >= 200) break;
  } while (pageToken);

  return allNews;
}

// ── Batch Fetch with Concurrency ──────────────────────────────────
async function batchFetch(items, fn, maxConcurrent = 5) {
  const results = {};
  for (let i = 0; i < items.length; i += maxConcurrent) {
    const batch = items.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          return { key: item, data: await fn(item) };
        } catch (err) {
          console.error(`  [WARN] Failed to fetch ${item}: ${err.message}`);
          return { key: item, data: [] };
        }
      })
    );
    for (const { key, data } of batchResults) {
      results[key] = data;
    }
  }
  return results;
}

// ── Subtract Business Days ────────────────────────────────────────
function subtractBusinessDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  let count = 0;
  while (count < days) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d.toISOString().split('T')[0];
}

// ── Main Export ───────────────────────────────────────────────────
export async function fetchAllData(config, tickers) {
  const { startDate, endDate, feed, maxConcurrent } = config;
  const earlyStart = subtractBusinessDays(startDate, 5); // for prevDailyBar

  console.log(`\n[DATA] Fetching historical data for ${tickers.length} tickers: ${startDate} → ${endDate}`);
  console.log(`[DATA] Feed: ${feed}, Rate limit: ${RATE} req/min, Concurrency: ${maxConcurrent}`);

  // 1. Daily bars for all tickers
  console.log(`[DATA] Fetching daily bars...`);
  const dailyBars = await batchFetch(tickers, (t) => fetchBars(t, '1Day', earlyStart, endDate, feed), maxConcurrent);
  console.log(`[DATA] Daily bars: ${Object.keys(dailyBars).length} tickers`);

  // 2. Minute bars for all tickers
  console.log(`[DATA] Fetching minute bars (this may take a few minutes)...`);
  const minuteBars = await batchFetch(tickers, (t) => fetchBars(t, '1Min', startDate, endDate, feed), maxConcurrent);
  const totalMinBars = Object.values(minuteBars).reduce((a, b) => a + b.length, 0);
  console.log(`[DATA] Minute bars: ${totalMinBars.toLocaleString()} total across ${Object.keys(minuteBars).length} tickers`);

  // 3. SPY + QQQ minute bars
  console.log(`[DATA] Fetching SPY/QQQ minute bars...`);
  const etfBars = {};
  for (const etf of ['SPY', 'QQQ']) {
    try {
      etfBars[etf] = await fetchBars(etf, '1Min', startDate, endDate, feed);
      console.log(`[DATA] ${etf}: ${etfBars[etf].length} minute bars`);
    } catch (err) {
      console.error(`[DATA] Failed to fetch ${etf}: ${err.message}`);
      etfBars[etf] = [];
    }
  }

  // 4. SPY + QQQ daily bars (for prevClose)
  for (const etf of ['SPY', 'QQQ']) {
    if (!dailyBars[etf]) {
      try {
        dailyBars[etf] = await fetchBars(etf, '1Day', earlyStart, endDate, feed);
      } catch (err) {
        dailyBars[etf] = [];
      }
    }
  }

  // 5. VIX 15-min bars
  console.log(`[DATA] Fetching VIX 15-min bars...`);
  let vixBars = [];
  try {
    vixBars = await fetchBars('VIX', '15Min', startDate, endDate, 'iex');
    console.log(`[DATA] VIX: ${vixBars.length} 15-min bars`);
  } catch (err) {
    console.error(`[DATA] VIX fetch failed (will default to 18): ${err.message}`);
  }

  // 6. Historical news for all tickers
  console.log(`[DATA] Fetching historical news...`);
  const allNews = await batchFetch(tickers, (t) => fetchNews(t, startDate, endDate), maxConcurrent);
  const totalNews = Object.values(allNews).reduce((a, b) => a + b.length, 0);
  console.log(`[DATA] News: ${totalNews} headlines across ${Object.keys(allNews).length} tickers`);

  // ── Build indexed data structures ──

  // Index minute bars by date+time for O(1) lookup
  function indexByMinute(bars) {
    const idx = {};
    for (const bar of bars) {
      const t = new Date(bar.t);
      const key = t.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
      idx[key] = bar;
    }
    return idx;
  }

  // Index daily bars by date
  function indexByDate(bars) {
    const idx = {};
    for (const bar of bars) {
      const d = new Date(bar.t).toISOString().split('T')[0];
      idx[d] = bar;
    }
    return idx;
  }

  // Index VIX by 15-min windows → nearest lookup
  const vixByTime = {};
  for (const bar of vixBars) {
    const t = new Date(bar.t);
    const key = t.toISOString().slice(0, 16);
    vixByTime[key] = bar.c;
  }

  // Index news by ticker+date
  const newsByTickerDate = {};
  for (const [ticker, items] of Object.entries(allNews)) {
    for (const item of items) {
      const d = new Date(item.created_at).toISOString().split('T')[0];
      const key = `${ticker}:${d}`;
      if (!newsByTickerDate[key]) newsByTickerDate[key] = [];
      newsByTickerDate[key].push({
        headline:   item.headline,
        source:     item.source,
        created_at: item.created_at,
        symbols:    item.symbols || [],
      });
    }
  }

  // Get sorted list of trading days from SPY minute bars
  const tradingDays = [...new Set(
    (etfBars.SPY || []).map(b => new Date(b.t).toISOString().split('T')[0])
  )].sort();

  console.log(`[DATA] Trading days in range: ${tradingDays.length}`);
  console.log(`[DATA] Data fetch complete.\n`);

  return {
    dailyBars:    Object.fromEntries(Object.entries(dailyBars).map(([k, v]) => [k, indexByDate(v)])),
    minuteBars:   Object.fromEntries(Object.entries(minuteBars).map(([k, v]) => [k, indexByMinute(v)])),
    etfMinuteBars: Object.fromEntries(Object.entries(etfBars).map(([k, v]) => [k, indexByMinute(v)])),
    vixByTime,
    newsByTickerDate,
    tradingDays,
    rawMinuteBars: minuteBars, // keep raw arrays for forward-scanning in PnL sim
  };
}
