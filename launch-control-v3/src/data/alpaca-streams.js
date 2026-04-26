import WebSocket from 'ws';
import dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import {
  updateTickerBar, updateMarketEtf, addNewsEvent,
  setStreamStatus, initTicker, getTickerState,
} from './state.js';
import { classifyCatalyst } from '../scoring/news.js';
import { query as dbQuery } from './db.js';
import logger from '../utils/logger.js';
import { detectScalpPatterns } from '../scalper/pattern-detector.js';
import { detectCompoundSignals } from '../scalper/compound-detector.js';
import {
  SCALP_TICKERS, updateScalpState, addDetectedPattern,
} from '../scalper/scalp-state.js';
import { selectCompoundScalpContract } from '../options/contract-selector.js';

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

// ── TRADE FLOW AGGREGATION ──────────────────────────────
// Subscribe to trades stream, aggregate into 1-minute buy/sell volume buckets.
// Flush to lc_v3.bar_flow at each minute boundary.

const flowBuckets = new Map(); // "TICKER:minuteTs" -> { buy: 0, sell: 0, trades: 0 }
const recentFlow = new Map();  // "TICKER" -> last 10 minutes of { buy, sell, trades, buyRatio }
let currentFlowMinute = null;

function getMinuteTs(tsStr) {
  const d = new Date(tsStr);
  d.setSeconds(0, 0);
  return d.toISOString();
}

function recordTrade(ticker, msg) {
  const ts = msg.t;
  if (!ts) return;
  const minuteTs = getMinuteTs(ts);
  const key = `${ticker}:${minuteTs}`;

  if (!flowBuckets.has(key)) {
    flowBuckets.set(key, { ticker, minuteTs, buy: 0, sell: 0, trades: 0 });
  }
  const bucket = flowBuckets.get(key);
  bucket.trades++;
  const side = msg.tks; // taker_side: 'B' or 'S' or undefined
  if (side === 'B') bucket.buy += msg.s || 0;
  else if (side === 'S') bucket.sell += msg.s || 0;
  // else: no side — counted in trades but not buy/sell

  // Check if minute rolled over
  if (currentFlowMinute && minuteTs !== currentFlowMinute) {
    flushFlowBuckets(currentFlowMinute);
  }
  currentFlowMinute = minuteTs;
}

async function flushFlowBuckets(minuteTs) {
  // Collect all buckets for the completed minute
  const rows = [];
  for (const [key, bucket] of flowBuckets.entries()) {
    if (bucket.minuteTs === minuteTs) {
      rows.push(bucket);
      flowBuckets.delete(key);
    }
  }
  if (rows.length === 0) return;

  // Build batch INSERT
  const values = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    const total = row.buy + row.sell;
    const buyRatio = total > 0 ? (row.buy / total) : null;
    const delta = row.buy - row.sell;
    values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6})`);
    params.push(row.ticker, row.minuteTs, row.buy, row.sell, row.trades, buyRatio, delta);
    idx += 7;
  }

  const buySellPairs = rows.filter(r => r.buy > 0 && r.sell > 0).length;
  logger.info(`[FLOW] batch ticker_count=${rows.length} buy_sell_pairs=${buySellPairs}`);

  // Update in-memory recent flow (last 10 minutes per ticker)
  for (const row of rows) {
    const total = row.buy + row.sell;
    const entry = { buy: row.buy, sell: row.sell, trades: row.trades, buyRatio: total > 0 ? row.buy / total : null, ts: row.minuteTs };
    if (!recentFlow.has(row.ticker)) recentFlow.set(row.ticker, []);
    const arr = recentFlow.get(row.ticker);
    arr.push(entry);
    if (arr.length > 10) arr.shift();
  }

  try {
    await dbQuery(`
      INSERT INTO lc_v3.bar_flow (ticker, ts, buy_volume, sell_volume, total_trades, buy_ratio, delta)
      VALUES ${values.join(',')}
      ON CONFLICT (ticker, ts) DO NOTHING
    `, params);
  } catch (err) {
    logger.error(`[FLOW] batch insert failed: ${err.message}`);
  }
}

/**
 * Get recent flow data for a ticker (last N minutes, in-memory).
 * @param {string} ticker
 * @param {number} minutes - how many minutes of data (default 5)
 * @returns {{ avgBuyRatio: number|null, totalBuy: number, totalSell: number, minutes: number }}
 */
export function getRecentFlow(ticker, minutes = 5) {
  const arr = recentFlow.get(ticker);
  if (!arr || arr.length === 0) return { avgBuyRatio: null, totalBuy: 0, totalSell: 0, minutes: 0 };
  const slice = arr.slice(-minutes);
  let totalBuy = 0, totalSell = 0, ratioSum = 0, ratioCount = 0;
  for (const entry of slice) {
    totalBuy += entry.buy;
    totalSell += entry.sell;
    if (entry.buyRatio !== null) { ratioSum += entry.buyRatio; ratioCount++; }
  }
  return {
    avgBuyRatio: ratioCount > 0 ? +(ratioSum / ratioCount).toFixed(3) : null,
    totalBuy,
    totalSell,
    minutes: slice.length,
  };
}

// ── CLAUDE HAIKU NEWS CLASSIFIER ─────────────────────────
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const haikuClient = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

// ── HYBRID CLASSIFIER: keywords first, Haiku only for ambiguous/high-impact ──
// Headlines that keywords can confidently classify skip the API call entirely.
// Cache prevents re-classifying duplicate headlines.

const classificationCache = new Map(); // headline -> result
const MAX_CACHE = 500;

// ── HAIKU CLASSIFICATION (ON-DEMAND ONLY) ────────────────────────────────────
// Stream uses keywords only (free). Haiku is called on-demand via
// classifyWithHaiku() only when PA/VOL gatekeepers pass.

// Keywords that signal high-impact news worth sending to Haiku
const HIGH_IMPACT_KEYWORDS = [
  'fda', 'sec ', 'doj', 'ftc', 'antitrust', 'investigation', 'subpoena',
  'merger', 'acqui', 'buyout', 'takeover', 'tender offer',
  'bankrupt', 'default', 'restat', 'fraud', 'recall',
  'halt', 'suspend', 'delist',
];

function needsHaiku(headline, keywordResult) {
  const hl = headline.toLowerCase();
  if (keywordResult.catalyst.type !== 'other') return false;
  return HIGH_IMPACT_KEYWORDS.some(kw => hl.includes(kw));
}


/**
 * Classify a headline using keywords only (free, instant).
 * Haiku is reserved for on-demand use when gatekeepers pass.
 */
async function classifyHeadline(headline, ticker) {
  const cacheKey = headline.slice(0, 120);
  if (classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey);
  }

  const kwResult = await classifyWithKeywords(headline, ticker);

  if (classificationCache.size >= MAX_CACHE) classificationCache.clear();
  classificationCache.set(cacheKey, kwResult);
  return kwResult;
}

/**
 * On-demand Haiku classification for a single headline.
 * Called only when PA/VOL gatekeepers pass and the headline is ambiguous.
 */
export async function classifyWithHaiku(headline, ticker) {
  const cacheKey = `haiku:${headline.slice(0, 120)}`;
  if (classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey);
  }

  const kwResult = await classifyWithKeywords(headline, ticker);
  if (!haikuClient || !needsHaiku(headline, kwResult)) {
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
    classificationCache.set(cacheKey, result);
    return result;
  } catch (err) {
    logger.error(`[HAIKU] Failed for ${ticker}: ${err.message} — using keywords`);
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
        // Run scalp pattern detection on ETFs that are scalp tickers
        if (SCALP_TICKERS.includes(msg.S)) {
          try { runScalpDetection(msg.S); } catch (e) { /* non-critical */ }
          // Compound scalp detection → writes signals for auto-trader
          if (msg.S === 'IWM') {
            runCompoundDetection(msg.S).catch(e => logger.error(`[COMPOUND] ${e.message}`));
          }
        }
      } else if (trackedTickers.includes(msg.S)) {
        updateTickerBar(msg.S, msg);
        persistBar(msg.S, msg);
        // Notify scoring loop that new bar is ready
        if (onSignalCallback) onSignalCallback(msg.S);
      }
      break;

    case 't': // trade
      if (trackedTickers.includes(msg.S)) {
        recordTrade(msg.S, msg);
      }
      break;

    case 'error':
      logger.error('Stock stream error message:', msg);
      break;

    default:
      break;
  }
}

// ── SCALP PATTERN DETECTION ─────────────────────────────
// Called on each new 1-min bar for SPY/QQQ/IWM.
// Detects patterns, stores in scalp-state for API consumption.

function runScalpDetection(ticker) {
  const ts = getTickerState(ticker);
  if (!ts || !ts.bars || ts.bars.length < 5) return;

  const rawCtx = {
    vwap: ts.vwap || 0,
    sessionOpen: ts.sessionOpen || 0,
    sessionHigh: ts.sessionHigh || 0,
    sessionLow: ts.sessionLow || 0,
    prevDayHigh: ts.prevDayHigh || 0,
    prevDayLow: ts.prevDayLow || 0,
    upVolRatio: ts.upVolRatio || 0.5,
    barsFromOpen: ts.bars.length,
  };

  // Update scalp state (FVGs, OBs, swings)
  updateScalpState(ticker, ts.bars, rawCtx);

  // Detect patterns
  const signals = detectScalpPatterns(ticker, ts.bars, rawCtx);

  // Record detected patterns
  for (const sig of signals) {
    addDetectedPattern(ticker, sig);
  }

  if (signals.length > 0) {
    logger.info(`[SCALPER] ${ticker}: ${signals.length} pattern(s) — ${signals.map(s => `${s.pattern}(${s.direction},${s.confidence})`).join(', ')}`);
  }
}

// ── COMPOUND SCALP SIGNAL WRITER ──────────────────────
// When compound detector fires on IWM, write high-confidence signals
// to lc_v3.signals for auto-trader pickup.

const compoundState = {
  lastSignalTime: {},   // ticker -> timestamp (cooldown)
  daySignals: {},       // ticker -> count
  dayDate: null,
  dayWins: 0,
  dayLosses: 0,
  circuitBroken: false,
};

function resetCompoundDay() {
  const today = new Date().toISOString().split('T')[0];
  if (compoundState.dayDate !== today) {
    compoundState.dayDate = today;
    compoundState.daySignals = {};
    compoundState.dayWins = 0;
    compoundState.dayLosses = 0;
    compoundState.circuitBroken = false;
    compoundState.lastSignalTime = {};
  }
}

async function runCompoundDetection(ticker) {
  const ts = getTickerState(ticker);
  if (!ts || !ts.bars || ts.bars.length < 15) return;

  resetCompoundDay();

  // Circuit breaker: 2 consecutive losses before a win → stop for the day
  if (compoundState.circuitBroken) return;

  // Max 7 signals/day
  const dayCount = compoundState.daySignals[ticker] || 0;
  if (dayCount >= 7) return;

  // 5-bar cooldown
  const now = Date.now();
  const lastTime = compoundState.lastSignalTime[ticker] || 0;
  if (now - lastTime < 5 * 60 * 1000) return; // 5 minutes

  // Build context from state
  const bars = ts.bars;
  const barsFromOpen = bars.length;
  const sessionOpen = ts.sessionOpen || bars[0]?.o || 0;

  // Compute VWAP from bars
  let cumVol = 0, cumPV = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumVol += (b.v || 0);
    cumPV += tp * (b.v || 0);
  }
  const vwap = cumVol > 0 ? cumPV / cumVol : bars[bars.length - 1]?.c || 0;

  // Compute OR (first 5 bars)
  let orHigh = 0, orLow = Infinity;
  for (let i = 0; i < Math.min(5, bars.length); i++) {
    if (bars[i].h > orHigh) orHigh = bars[i].h;
    if (bars[i].l < orLow) orLow = bars[i].l;
  }

  const ctx = {
    vwap,
    orHigh: barsFromOpen >= 5 ? orHigh : undefined,
    orLow: barsFromOpen >= 5 ? orLow : undefined,
    sessionHigh: ts.sessionHigh || 0,
    sessionLow: ts.sessionLow || Infinity,
    sessionOpen,
    barsFromOpen,
    prevDayHigh: ts.prevDayHigh || 0,
    prevDayLow: ts.prevDayLow || 0,
  };

  const signals = detectCompoundSignals(ticker, bars, ctx);
  if (signals.length === 0) return;

  // Session trend filter: CALLs need price > VWAP or > open; PUTs need < VWAP or < open
  const price = bars[bars.length - 1].c;
  const filteredSignals = signals.filter(sig => {
    if (sig.confidence < 65) return false;
    if (sig.direction === 'CALL') return price > vwap || price > sessionOpen;
    if (sig.direction === 'PUT') return price < vwap || price < sessionOpen;
    return false;
  });

  if (filteredSignals.length === 0) return;

  // Take highest confidence signal
  const best = filteredSignals.sort((a, b) => b.confidence - a.confidence)[0];

  // Select contract with ITM preference for puts
  let contract = null;
  try {
    contract = await selectCompoundScalpContract(ticker, best.direction, price);
  } catch (err) {
    logger.error(`[COMPOUND] Contract selection failed for ${ticker} ${best.direction}: ${err.message}`);
    return;
  }

  if (!contract) {
    logger.info(`[COMPOUND] No viable contract for ${ticker} ${best.direction}`);
    return;
  }

  // Write to lc_v3.signals
  try {
    await dbQuery(`
      INSERT INTO lc_v3.signals (
        expires_at, status, ticker, direction, signal_tier,
        composite_raw, grade, strategy,
        price_at_signal, vwap_at_signal,
        contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
        contract_bid, contract_ask, contract_mid,
        contract_delta, contract_iv,
        flags
      ) VALUES (
        NOW() + interval '60 seconds', 'ACTIVE', $1, $2, 'COMPOUND',
        $3, $4, 'COMPOUND_SCALP',
        $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15,
        $16
      )
    `, [
      ticker,
      best.direction,
      best.confidence,
      best.confidence >= 80 ? 'A+' : best.confidence >= 70 ? 'A' : 'B+',
      price,
      vwap,
      contract.symbol,
      contract.strike,
      contract.expiry,
      contract.expiry_label,
      contract.bid,
      contract.ask,
      contract.mid,
      contract.delta,
      contract.iv,
      JSON.stringify({ pattern: best.pattern, category: 'COMPOUND', metadata: best.metadata }),
    ]);

    compoundState.lastSignalTime[ticker] = now;
    compoundState.daySignals[ticker] = dayCount + 1;

    logger.info(
      `[COMPOUND] SIGNAL: ${ticker} ${best.direction} ${best.pattern} conf=${best.confidence} ` +
      `contract=${contract.symbol} mid=$${contract.mid.toFixed(2)} ` +
      `(day #${dayCount + 1})`
    );
  } catch (err) {
    logger.error(`[COMPOUND] Signal write failed: ${err.message}`);
  }
}

function subscribeStockBars() {
  const allSymbols = [...new Set([...trackedTickers, ...REFERENCE_ETFS])];
  stockWs.send(JSON.stringify({
    action: 'subscribe',
    bars: allSymbols,
    trades: trackedTickers, // trades for buy/sell flow aggregation
    quotes: trackedTickers, // quotes for up/down volume ratio
  }));
  logger.info(`Subscribed to bars+trades for ${allSymbols.length} symbols`);
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
      // Keywords only on stream — Haiku reserved for gatekeeper-passed signals
      const { polarity, catalyst } = await classifyHeadline(headline, ticker);

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

/**
 * Record a compound scalp trade result (called by auto-trader on exit).
 * Updates the circuit breaker state.
 */
export function recordCompoundResult(isWin) {
  if (isWin) {
    compoundState.dayWins++;
    compoundState.dayLosses = 0;
  } else {
    compoundState.dayLosses++;
    // Circuit breaker: 2 consecutive losses before any win → stop for the day
    if (compoundState.dayLosses >= 2 && compoundState.dayWins === 0) {
      compoundState.circuitBroken = true;
      logger.info('[COMPOUND] Circuit breaker tripped: 2 losses before a win');
    }
  }
}

export function getConnectionHealth() {
  return {
    stockWs:  stockWs  ? stockWs.readyState  : -1,
    newsWs:   newsWs   ? newsWs.readyState   : -1,
  };
}
