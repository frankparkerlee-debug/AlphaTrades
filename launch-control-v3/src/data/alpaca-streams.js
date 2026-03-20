import WebSocket from 'ws';
import dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import {
  updateTickerBar, updateMarketEtf, addNewsEvent,
  setStreamStatus, initTicker,
} from './state.js';
import { classifyCatalyst } from '../scoring/news.js';
import { query as dbQuery } from './db.js';
import logger from '../utils/logger.js';

// ── BAR PERSISTENCE ─────────────────────────────────────
function getBarSession(tsStr) {
  const et = new Date(new Date(tsStr).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 570 && mins < 960) return 'REGULAR';
  if (mins >= 240 && mins < 570) return 'PRE_MARKET';
  if (mins >= 960 && mins < 1200) return 'POST_MARKET';
  return 'OVERNIGHT';
}

function getWindowKey(tsStr) {
  const et = new Date(new Date(tsStr).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const totalMins = et.getHours() * 60 + et.getMinutes();
  const floored = Math.floor(totalMins / 15) * 15;
  return `${Math.floor(floored / 60).toString().padStart(2, '0')}:${(floored % 60).toString().padStart(2, '0')}`;
}

function persistBar(ticker, msg) {
  const ts = msg.t;
  if (!ts) return;
  dbQuery(`
    INSERT INTO lc_v3.bars (ticker, ts, open, high, low, close, volume, vwap, session, window_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (ticker, ts) DO NOTHING
  `, [ticker, ts, msg.o, msg.h, msg.l, msg.c, msg.v, msg.vw || null, getBarSession(ts), getWindowKey(ts)])
    .catch(err => logger.error(`[BAR-PERSIST] ${ticker} write failed: ${err.message}`));
}

// ── CLAUDE HAIKU NEWS CLASSIFIER ─────────────────────────
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const haikuClient = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

// ── HYBRID CLASSIFIER: keywords first, Haiku only for ambiguous/high-impact ──
// Headlines that keywords can confidently classify skip the API call entirely.
// Cache prevents re-classifying duplicate headlines.

const classificationCache = new Map(); // headline -> result
const MAX_CACHE = 500;

// Keywords that signal high-impact news worth sending to Haiku
const HIGH_IMPACT_KEYWORDS = [
  'fda', 'sec ', 'doj', 'ftc', 'antitrust', 'investigation', 'subpoena',
  'merger', 'acqui', 'buyout', 'takeover', 'tender offer',
  'bankrupt', 'default', 'restat', 'fraud', 'recall',
  'guidance', 'outlook', 'raises', 'lowers', 'cuts forecast',
  'beat', 'miss', 'surpris', 'warn', 'profit warning',
  'layoff', 'restructur', 'ceo ', 'cfo ', 'depart', 'resign',
  'halt', 'suspend', 'delist',
];

function needsHaiku(headline, keywordResult) {
  const hl = headline.toLowerCase();
  // If keywords matched a specific catalyst (not "other"), trust them
  if (keywordResult.catalyst.type !== 'other') return false;
  // Check if headline contains high-impact language that keywords missed
  return HIGH_IMPACT_KEYWORDS.some(kw => hl.includes(kw));
}

/**
 * Classify a headline using hybrid approach:
 * 1. Check cache
 * 2. Run keyword classifier
 * 3. Only call Haiku if keywords returned "other" AND headline has high-impact language
 */
async function classifyWithHaiku(headline, ticker) {
  // Cache check
  const cacheKey = headline.slice(0, 120);
  if (classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey);
  }

  // Always run keywords first (free)
  const kwResult = await classifyWithKeywords(headline, ticker);

  // Only escalate to Haiku if keywords can't handle it
  if (!haikuClient || !needsHaiku(headline, kwResult)) {
    if (classificationCache.size >= MAX_CACHE) classificationCache.clear();
    classificationCache.set(cacheKey, kwResult);
    return kwResult;
  }

  try {
    const response = await haikuClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Classify this news headline about ${ticker} for options trading impact. Respond with ONLY a JSON object, no other text.

{
  "polarity": <integer -2 to +2, where -2=strongly bearish, -1=bearish, 0=neutral, 1=bullish, 2=strongly bullish>,
  "catalyst_type": <one of: "earnings_beat", "earnings_miss", "analyst_upgrade", "analyst_downgrade", "regulatory", "macro_rate_cut", "macro_rate_hike", "ai_capex", "product", "partnership", "sector", "other">,
  "relevance": <float 0.0 to 1.0, how material is this to ${ticker}'s stock price?>
}

Headline: "${headline.replace(/"/g, '\\"')}"`,
      }],
    });

    const text = response.content[0]?.text || '';
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const polarity = Math.max(-2, Math.min(2, parseInt(json.polarity) || 0));
    const catalystType = json.catalyst_type || 'other';
    const relevance = Math.max(0, Math.min(1, parseFloat(json.relevance) || 0.5));

    logger.info(`[HAIKU] ${ticker}: polarity=${polarity} catalyst=${catalystType} relevance=${relevance}`);

    const result = {
      polarity,
      catalyst: { type: catalystType, sensitivity: relevance >= 0.7 ? 1.2 : 1.0, affectsCluster: false, decayHours: Math.abs(polarity) >= 2 ? 8 : 4 },
    };
    if (classificationCache.size >= MAX_CACHE) classificationCache.clear();
    classificationCache.set(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`[HAIKU] Classification failed for ${ticker}: ${err.message} — falling back to keywords`);
    classificationCache.set(cacheKey, kwResult);
    return kwResult;
  }
}

async function classifyWithKeywords(headline, ticker) {
  const catalyst = await classifyCatalyst(headline, ticker);
  const POLARITY_MAP = {
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
  return { polarity: POLARITY_MAP[catalyst.type] ?? 0, catalyst };
}

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
  const url = `${STREAM_URL}/v2/sip`;
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
        persistBar(msg.S, msg);
      } else if (trackedTickers.includes(msg.S)) {
        updateTickerBar(msg.S, msg);
        persistBar(msg.S, msg);
        // Notify scoring loop that new bar is ready
        if (onSignalCallback) onSignalCallback(msg.S);
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
      // Classify with Claude Haiku (falls back to keywords if no API key)
      const { polarity, catalyst } = await classifyWithHaiku(headline, ticker);

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
