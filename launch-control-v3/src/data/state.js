/**
 * In-memory state for all tracked tickers.
 * Updated by Alpaca WebSocket streams every bar.
 * Scoring engine reads from this — never hits the DB for live data.
 */

const state = {
  tickers: {},      // per-ticker market data
  market: {         // reference ETFs
    SPY: { changePct: 0, price: 0, prevClose: 0 },
    QQQ: { changePct: 0, price: 0, prevClose: 0 },
    SMH: { changePct: 0, price: 0, prevClose: 0 },
    XLK: { changePct: 0, price: 0, prevClose: 0 },
    XLY: { changePct: 0, price: 0, prevClose: 0 },
    XLC: { changePct: 0, price: 0, prevClose: 0 },
    DIA: { changePct: 0, price: 0, prevClose: 0 },
    VIX: { value: 18 },
  },
  news: {},         // per-ticker news events from today
  streamStatus: {
    bars: 'disconnected',
    news: 'disconnected',
    lastBarAt: null,
    lastNewsAt: null,
  },
};

// ── TICKER STATE ───────────────────────────────────────

export function initTicker(ticker) {
  if (!state.tickers[ticker]) {
    state.tickers[ticker] = {
      ticker,
      // Current bar
      open: 0, high: 0, low: 0, close: 0,
      volume: 0, vwap: 0,
      // Session data
      prevClose: 0,
      prevDayHigh: 0,
      prevDayLow: 0,
      sessionOpen: 0,
      sessionHigh: 0,
      sessionLow: 0,
      // Volume tracking
      upVolume: 0,
      downVolume: 0,
      upVolRatio: 0.5,
      // Bar history (last 20 bars for analysis)
      bars: [],
      // Last update
      lastBarAt: null,
      lastQuoteAt: null,
    };
  }
  return state.tickers[ticker];
}

export function updateTickerBar(ticker, bar) {
  const t = initTicker(ticker);

  // Track session open
  if (!t.sessionOpen && bar.o) t.sessionOpen = bar.o;

  // Update volume direction tracking
  const barBullish = bar.c >= bar.o;
  if (barBullish) t.upVolume += (bar.v || 0);
  else            t.downVolume += (bar.v || 0);

  const totalVol = t.upVolume + t.downVolume;
  t.upVolRatio = totalVol > 0 ? t.upVolume / totalVol : 0.5;

  // Session high/low
  if (bar.h > t.sessionHigh || t.sessionHigh === 0) t.sessionHigh = bar.h;
  if (bar.l < t.sessionLow  || t.sessionLow  === 0) t.sessionLow  = bar.l;

  // Current bar
  t.open   = bar.o;
  t.high   = bar.h;
  t.low    = bar.l;
  t.close  = bar.c;
  t.volume = bar.v;
  t.vwap   = bar.vw || bar.c; // Alpaca provides vwap as 'vw'
  t.lastBarAt = new Date();

  // Keep last 20 bars
  t.bars.push({ o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, t: bar.t });
  if (t.bars.length > 20) t.bars.shift();

  state.streamStatus.lastBarAt = new Date();
}

export function updateTickerPrevClose(ticker, prevClose, prevHigh, prevLow) {
  const t = initTicker(ticker);
  t.prevClose   = prevClose;
  t.prevDayHigh = prevHigh || prevClose * 1.01;
  t.prevDayLow  = prevLow  || prevClose * 0.99;
}

export function getTickerState(ticker) {
  return state.tickers[ticker] || null;
}

export function getAllTickers() {
  return Object.keys(state.tickers);
}

// ── MARKET / REFERENCE ETF STATE ──────────────────────

export function updateMarketEtf(symbol, bar) {
  if (state.market[symbol]) {
    state.market[symbol].price = bar.c;
    if (state.market[symbol].prevClose > 0) {
      state.market[symbol].changePct =
        (bar.c - state.market[symbol].prevClose) / state.market[symbol].prevClose;
    }
  }
}

export function setEtfPrevClose(symbol, prevClose) {
  if (state.market[symbol]) {
    state.market[symbol].prevClose = prevClose;
  }
}

export function getMarketData(sectorEtf, exchangeEtf) {
  return {
    spyPct:         state.market.SPY?.changePct || 0,
    qqqPct:         state.market.QQQ?.changePct || 0,
    sectorPct:      state.market[sectorEtf]?.changePct || 0,
    exchangeEtfPct: state.market[exchangeEtf]?.changePct || 0,
    vix:            state.market.VIX?.value || 18,
  };
}

export function setVix(value) {
  state.market.VIX.value = value;
}

// ── NEWS STATE ─────────────────────────────────────────

export function addNewsEvent(ticker, event) {
  if (!state.news[ticker]) state.news[ticker] = [];

  // Keep only events from last 8 hours
  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  state.news[ticker] = state.news[ticker].filter(
    e => new Date(e.timestamp) > cutoff
  );

  state.news[ticker].push(event);
  state.streamStatus.lastNewsAt = new Date();
}

export function getNewsEvents(ticker) {
  if (!state.news[ticker]) return [];
  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  return state.news[ticker].filter(e => new Date(e.timestamp) > cutoff);
}

export function clearDayNews() {
  state.news = {};
}

// ── STREAM STATUS ──────────────────────────────────────

export function setStreamStatus(stream, status) {
  state.streamStatus[stream] = status;
}

export function getStreamStatus() {
  return { ...state.streamStatus };
}

// ── ANNOUNCEMENT CONTEXT ───────────────────────────────

let announcementCtx = {
  isPostAnnouncement: false,
  minsSince: 0,
  type: null,
  firedAt: null,
};

export function setAnnouncementContext(type, firedAt = new Date()) {
  announcementCtx = { isPostAnnouncement: true, type, firedAt, minsSince: 0 };
}

export function getAnnouncementContext() {
  if (!announcementCtx.isPostAnnouncement) return announcementCtx;
  const minsSince = Math.round((Date.now() - announcementCtx.firedAt) / 60000);
  // Clear after 90 minutes
  if (minsSince > 90) {
    announcementCtx = { isPostAnnouncement: false, minsSince: 0, type: null, firedAt: null };
  } else {
    announcementCtx.minsSince = minsSince;
  }
  return announcementCtx;
}

export function clearAnnouncementContext() {
  announcementCtx = { isPostAnnouncement: false, minsSince: 0, type: null, firedAt: null };
}

export default state;
