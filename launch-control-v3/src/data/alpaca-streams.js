import WebSocket from 'ws';
import dotenv from 'dotenv';
dotenv.config();

import {
  updateTickerBar, updateMarketEtf, addNewsEvent,
  setStreamStatus, initTicker,
} from './state.js';
import { classifyCatalyst } from '../scoring/news.js';
import { scoreTicker } from '../scoring/loop.js';
import logger from '../utils/logger.js';

const STREAM_URL  = process.env.ALPACA_STREAM_URL || 'wss://stream.data.alpaca.markets';
const API_KEY     = process.env.ALPACA_API_KEY;
const API_SECRET  = process.env.ALPACA_SECRET_KEY;

const REFERENCE_ETFS = ['SPY', 'QQQ', 'SMH', 'XLK', 'XLY', 'XLC', 'DIA'];

// Reconnection config
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

let stockWs  = null;
let newsWs   = null;
let stockRetry = 0;
let newsRetry  = 0;

let trackedTickers = [];
let onSignalCallback = null;

export function setTrackedTickers(tickers) {
  trackedTickers = [...tickers];
  tickers.forEach(t => initTicker(t));
}

export function onNewSignalReady(callback) {
  onSignalCallback = callback;
}

// ── STOCK BARS STREAM ──────────────────────────────────

export function connectStockStream() {
  if (stockWs && stockWs.readyState < 2) return;
  const url = `${STREAM_URL}/v2/${process.env.ALPACA_FEED || 'sip'}`;
  logger.info(`Connecting stock stream: ${url}`);
  setStreamStatus('bars', 'connecting');

  stockWs = new WebSocket(url);

  stockWs.on('open', () => {
    logger.info('Stock stream connected — authenticating...');
    stockWs.send(JSON.stringify({
      action: 'auth',
      key: API_KEY,
      secret: API_SECRET,
    }));
  });

  stockWs.on('message', (data) => {
    try {
      const messages = JSON.parse(data.toString());
      for (const msg of messages) {
        handleStockMessage(msg);
      }
    } catch (err) {
      logger.error('Stock stream parse error:', err.message);
    }
  });

  stockWs.on('close', (code) => {
    setStreamStatus('bars', 'disconnected');
    logger.warn(`Stock stream closed (${code}) — reconnecting in ${BACKOFF_MS[Math.min(stockRetry, 6)]}ms`);
    setTimeout(() => {
      stockRetry = Math.min(stockRetry + 1, 6);
      connectStockStream();
    }, BACKOFF_MS[Math.min(stockRetry, 6)]);
  });

  stockWs.on('error', (err) => {
    logger.error('Stock stream error:', err.message);
  });
}

function handleStockMessage(msg) {
  switch (msg.T) {
    case 'success':
      if (msg.msg === 'authenticated') {
        logger.info('Stock stream authenticated — subscribing...');
        stockRetry = 0;
        setStreamStatus('bars', 'connected');
        subscribeStockBars();
      }
      break;

    case 'subscription':
      logger.info(`Stock stream subscribed: ${JSON.stringify(msg)}`);
      break;

    case 'b': // bar
      if (REFERENCE_ETFS.includes(msg.S)) {
        updateMarketEtf(msg.S, msg);
      } else if (trackedTickers.includes(msg.S)) {
        updateTickerBar(msg.S, msg);
        console.log('[BAR]', msg.S, msg.c);
        // Score ticker directly
        scoreTicker(msg.S).catch(err => logger.error(`Score error ${msg.S}:`, err.message));
      }
      break;

    case 'error':
      logger.error('Stock stream error message:', msg);
      break;

    default:
      break;
  }
}

function subscribeStockBars() {
  const allSymbols = [...new Set([...trackedTickers, ...REFERENCE_ETFS])];
  stockWs.send(JSON.stringify({
    action: 'subscribe',
    bars: allSymbols,
    quotes: trackedTickers, // quotes for up/down volume ratio
  }));
  logger.info(`Subscribed to bars for ${allSymbols.length} symbols`);
}

// ── NEWS STREAM ────────────────────────────────────────

export function connectNewsStream() {
  if (newsWs && newsWs.readyState < 2) return;
  const url = `${STREAM_URL}/v1beta1/news`;
  logger.info(`Connecting news stream: ${url}`);
  setStreamStatus('news', 'connecting');

  newsWs = new WebSocket(url);

  newsWs.on('open', () => {
    logger.info('News stream connected — authenticating...');
    newsWs.send(JSON.stringify({
      action: 'auth',
      key: API_KEY,
      secret: API_SECRET,
    }));
  });

  newsWs.on('message', async (data) => {
    try {
      const messages = JSON.parse(data.toString());
      for (const msg of messages) {
        await handleNewsMessage(msg);
      }
    } catch (err) {
      logger.error('News stream parse error:', err.message);
    }
  });

  newsWs.on('close', (code) => {
    setStreamStatus('news', 'disconnected');
    logger.warn(`News stream closed (${code}) — reconnecting in ${BACKOFF_MS[Math.min(newsRetry, 6)]}ms`);
    setTimeout(() => {
      newsRetry = Math.min(newsRetry + 1, 6);
      connectNewsStream();
    }, BACKOFF_MS[Math.min(newsRetry, 6)]);
  });

  newsWs.on('error', (err) => {
    logger.error('News stream error:', err.message);
  });
}

async function handleNewsMessage(msg) {
  switch (msg.T) {
    case 'success':
      if (msg.msg === 'authenticated') {
        logger.info('News stream authenticated — subscribing...');
        newsRetry = 0;
        setStreamStatus('news', 'connected');
        newsWs.send(JSON.stringify({
          action: 'subscribe',
          news: ['*'], // all symbols
        }));
        logger.info('Subscribed to all news');
      }
      break;

    case 'n': // news item
      await processNewsItem(msg);
      break;

    case 'error':
      logger.error('News stream error message:', msg);
      break;

    default:
      break;
  }
}

async function processNewsItem(item) {
  const symbols = item.symbols || [];
  const headline = item.headline || '';
  const timestamp = item.created_at || new Date().toISOString();

  // Filter to tracked tickers only
  const relevant = symbols.filter(s => trackedTickers.includes(s));
  if (relevant.length === 0) return;

  for (const ticker of relevant) {
    try {
      const catalyst = await classifyCatalyst(headline, ticker);

      // Get polarity from catalyst type
      const polarityMap = {
        earnings_beat: 2, earnings_miss: -2,
        analyst_upgrade: 2, analyst_downgrade: -2,
        hyperscaler_capex: 2, ai_chip_export_restriction: -2,
        ai_model_release: 1, memory_pricing: 1, hbm_demand: 2,
        delivery_numbers: 1, elon_event: 1, fsd_update: 1,
        ai_accelerator: 2, cpu_share_gain: 1, iphone_cycle: 1,
        services_growth: 1, ad_revenue: 1, ai_capex: 1,
        azure_growth: 2, openai_news: 1, search_revenue: 1,
        cloud_growth: 2, fab_capex: 2,
        macro_rate_cut: 1, macro_rate_hike: -1,
        macro_cpi: 0, macro_fomc: 0,
        regulatory: -2, other: 0,
      };

      const polarity = polarityMap[catalyst.type] ?? 0;

      addNewsEvent(ticker, {
        headline,
        catalyst,
        polarity,
        timestamp,
        symbols,
        url: item.url,
        source: item.source,
      });

      logger.info(`NEWS ${ticker}: [${catalyst.type}] polarity=${polarity} "${headline.slice(0, 80)}..."`);
    } catch (err) {
      logger.error(`Failed to process news for ${ticker}:`, err.message);
    }
  }
}

// ── CONNECTION MANAGEMENT ──────────────────────────────

export function connectAll() {
  connectStockStream();
  connectNewsStream();
}

export function disconnectAll() {
  if (stockWs) { stockWs.removeAllListeners(); stockWs.close(); }
  if (newsWs)  { newsWs.removeAllListeners();  newsWs.close();  }
  setStreamStatus('bars', 'disconnected');
  setStreamStatus('news', 'disconnected');
  logger.info('All streams disconnected');
}

export function getConnectionHealth() {
  return {
    stockWs:  stockWs  ? stockWs.readyState  : -1,
    newsWs:   newsWs   ? newsWs.readyState   : -1,
  };
}
