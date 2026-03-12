import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const FEED = process.env.ALPACA_FEED || 'sip';

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  },
  timeout: 15000,
});

/**
 * Fetch latest snapshot for a ticker (prev close, prev day high/low)
 */
export async function fetchSnapshot(ticker) {
  try {
    const res = await client.get(`/v2/stocks/${ticker}/snapshot`, {
      params: { feed: FEED },
    });
    const snap = res.data;
    return {
      prevClose:   snap.prevDailyBar?.c || snap.dailyBar?.o || 0,
      prevHigh:    snap.prevDailyBar?.h || 0,
      prevLow:     snap.prevDailyBar?.l || 0,
      latestPrice: snap.latestTrade?.p || snap.latestQuote?.ap || 0,
    };
  } catch (err) {
    console.error('Snapshot error:', err.response?.status, err.response?.data || err.message);
    return { prevClose: 0, prevHigh: 0, prevLow: 0, latestPrice: 0 };
  }
}

/**
 * Fetch snapshots for multiple tickers at once
 */
export async function fetchSnapshots(tickers) {
  try {
    const res = await client.get('/v2/stocks/snapshots', {
      params: { symbols: tickers.join(','), feed: FEED },
    });
    const results = {};
    for (const [ticker, snap] of Object.entries(res.data)) {
      results[ticker] = {
        prevClose:   snap.prevDailyBar?.c || snap.dailyBar?.o || 0,
        prevHigh:    snap.prevDailyBar?.h || 0,
        prevLow:     snap.prevDailyBar?.l || 0,
        latestPrice: snap.latestTrade?.p || snap.latestQuote?.ap || 0,
      };
    }
    return results;
  } catch (err) {
    console.error('Snapshot error:', err.response?.status, err.response?.data || err.message);
    return {};
  }
}

/**
 * Fetch recent news for tickers (pre-market scan)
 */
export async function fetchRecentNews(tickers, since) {
  try {
    const res = await client.get('/v1beta1/news', {
      params: {
        symbols: tickers.join(','),
        start: since,
        limit: 50,
        sort: 'desc',
      },
    });
    return res.data.news || [];
  } catch (err) {
    return [];
  }
}

/**
 * Fetch latest VIX value
 */
export async function fetchVix() {
  try {
    const res = await client.get('/v2/stocks/VIX/bars/latest', {
      params: { feed: 'iex' }, // VIX uses IEX
    });
    return res.data.bar?.c || 18;
  } catch (err) {
    return 18; // default to normal volatility
  }
}

export default client;
