import { query } from '../data/db.js';
import {
  getTickerState, getMarketData, getNewsEvents,
  getAnnouncementContext,
} from '../data/state.js';
import { getRecentBars } from '../data/bar-collector.js';
import { computeComposite, writeSignal } from '../scoring/composite.js';
import { getMarketSession, getSessionModifiers, isScoreable } from '../utils/session.js';
import logger from '../utils/logger.js';
import { todayStr } from '../utils/time.js';

// Circuit breaker state
const circuitBreakers = {
  dailyLossHit:     false,
  consecutiveLosses: 0,
  sizeReduction:    false,
  vixSpike:         false,
  lockedIn:         false,
};

// Track signals fired today (prevent duplicate signals per ticker per session)
const signalsFiredToday = new Set();
let lastSignalDate = '';

// Account tracking (updated when human records trades)
let accountBalance = parseFloat(process.env.ACCOUNT_SIZE || '7500');

// Profile cache — reload every 30 minutes
let profileCache = {};
let profileCacheAt = 0;

async function getProfiles() {
  if (Date.now() - profileCacheAt > 30 * 60 * 1000) {
    const res = await query('SELECT * FROM lc_v3.equity_profiles');
    profileCache = {};
    res.rows.forEach(r => { profileCache[r.ticker] = r; });
    profileCacheAt = Date.now();
    logger.debug(`Profile cache refreshed: ${Object.keys(profileCache).length} tickers`);
  }
  return profileCache;
}

/**
 * Check circuit breakers before allowing a new signal
 */
export function checkCircuitBreakers() {
  if (circuitBreakers.dailyLossHit) {
    return { allowed: false, reason: 'DAILY_LOSS_LIMIT_HIT' };
  }
  if (circuitBreakers.lockedIn) {
    return { allowed: false, reason: 'DAILY_GAIN_LOCKED_IN' };
  }
  return { allowed: true, sizeReduction: circuitBreakers.sizeReduction };
}

export function updateCircuitBreakers(tradePnlPct, isWin) {
  if (!isWin) {
    circuitBreakers.consecutiveLosses++;
    if (circuitBreakers.consecutiveLosses >= 3) {
      circuitBreakers.sizeReduction = true;
      logger.warn('CIRCUIT BREAKER: 3 consecutive losses — reducing sizes to 50%');
    }
  } else {
    circuitBreakers.consecutiveLosses = 0;
    circuitBreakers.sizeReduction = false;
  }
}

export function setDailyLossHit() {
  circuitBreakers.dailyLossHit = true;
  logger.warn('CIRCUIT BREAKER: Daily loss limit hit — no new signals');
}

export function setLockedIn() {
  circuitBreakers.lockedIn = true;
  logger.info('CIRCUIT BREAKER: Daily gain locked in — operator chose to stop');
}

export function resetDailyCircuitBreakers() {
  circuitBreakers.dailyLossHit     = false;
  circuitBreakers.consecutiveLosses = 0;
  circuitBreakers.sizeReduction    = false;
  circuitBreakers.lockedIn         = false;
  signalsFiredToday.clear();
  lastSignalDate = todayStr();
  logger.info('Daily circuit breakers reset');
}

/**
 * Score a single ticker — called when a new bar arrives
 */
export async function scoreTicker(ticker) {
  const session = getMarketSession();

  if (!isScoreable(session)) {
    console.log(`[SKIP] ${ticker} session=${session}`);
    return;
  }

  const sessionMods = getSessionModifiers(session);

  // Reset daily tracking on new day
  const today = todayStr();
  if (today !== lastSignalDate) {
    resetDailyCircuitBreakers();
  }

  // Check circuit breakers
  const cbCheck = checkCircuitBreakers();
  if (!cbCheck.allowed) {
    console.log(`[SKIP] ${ticker} circuit breaker: ${cbCheck.reason}`);
    return;
  }

  // Get ticker state
  const tickerState = getTickerState(ticker);
  console.log(`[SCORE] ${ticker} close=${tickerState?.close} prevClose=${tickerState?.prevClose} session=${session}`);
  if (!tickerState || !tickerState.close || !tickerState.prevClose) {
    console.log(`[SKIP] ${ticker} missing state`);
    return;
  }

  // Get profile
  const profiles = await getProfiles();
  const profile = profiles[ticker];
  if (!profile) return;

  // Check if already fired a signal for this ticker today
  const signalKey = `${today}-${ticker}`;
  if (signalsFiredToday.has(signalKey)) return;

  // Get market data for this ticker's ETFs
  const marketData = getMarketData(
    profile.sector_etf,
    profile.exchange_etf
  );

  // Get news events
  const newsEvents = getNewsEvents(ticker);

  // Get announcement context
  const announcementCtx = getAnnouncementContext();

  // Build bar data with real bar history for trend analysis
  const bars = getRecentBars(ticker, 20);
  const barData = {
    open:        tickerState.open,
    high:        tickerState.sessionHigh,
    low:         tickerState.sessionLow,
    close:       tickerState.close,
    volume:      tickerState.volume,
    vwap:        tickerState.vwap,
    prevClose:   tickerState.prevClose,
    upVolRatio:  tickerState.upVolRatio,
    prevDayHigh: tickerState.prevDayHigh,
    prevDayLow:  tickerState.prevDayLow,
    bars,
  };

  // Run composite scoring
  const signal = await computeComposite({
    ticker,
    barData,
    marketData,
    newsEvents,
    profile,
    currentTime: new Date(),
    announcementCtx,
    isBaseLayer: false,
  });

  if (!signal) return;

  // Apply session modifiers — extended hours grade cap + half sizing
  if (sessionMods.gradeCapOverride) {
    const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C'];
    const capIdx = GRADE_ORDER.indexOf(sessionMods.gradeCapOverride);
    const gradeIdx = GRADE_ORDER.indexOf(signal.grade);
    if (gradeIdx < capIdx) {
      signal.grade = sessionMods.gradeCapOverride;
      signal.gradeCapped = true;
      signal.flags.push(`SESSION_CAP_${sessionMods.gradeCapOverride}`);
    }
    signal.positionSizePct    *= sessionMods.positionSizeMultiplier;
    signal.positionSizeDollars = Math.round(accountBalance * signal.positionSizePct);
    if (sessionMods.signalLabel) signal.flags.push(sessionMods.signalLabel);
  }

  // Apply size reduction if circuit breaker active
  if (cbCheck.sizeReduction) {
    signal.positionSizePct    *= 0.5;
    signal.positionSizeDollars = Math.round(accountBalance * signal.positionSizePct);
    signal.flags.push('SIZE_REDUCED_CONSECUTIVE_LOSSES');
  }

  // Compute confluence score
  signal.confluenceScore = computeConfluence(signal, newsEvents, marketData);

  // Write to DB
  const signalId = await writeSignal(signal, {
    context: 'STANDALONE',
  });

  if (signalId) {
    signalsFiredToday.add(signalKey);
    logger.info(`Signal written: ${signalId} — ${ticker} ${signal.direction} ${signal.grade} composite=${signal.compositeRaw}`);
  }
}

/**
 * Confluence score — how many independent catalysts align
 */
function computeConfluence(signal, newsEvents, marketData) {
  let score = 0;
  // Strong news present
  if (newsEvents.some(e => Math.abs(e.polarity) >= 2)) score++;
  // All three market layers aligned
  if (signal.scoreDetails?.market?.alignedCount === 3) score++;
  // Pre-market gap confirms direction
  // (checked via high ATR multiple at open — proxy for gap)
  if (signal.scoreDetails?.pa?.atrMultiple > 1.5) score++;
  return score;
}

/**
 * Base layer scan — runs at 10:30am if no primary signals today
 */
export async function runBaseLayerScan() {
  const session = getMarketSession();
  if (session !== 'REGULAR') return; // base layer only during regular hours

  const today = todayStr();
  const primaryToday = await query(`
    SELECT COUNT(*) FROM lc_v3.signals
    WHERE DATE(created_at AT TIME ZONE 'America/New_York') = $1
    AND signal_tier = 'primary'
  `, [today]);

  if (parseInt(primaryToday.rows[0]?.count || 0) > 0) return; // primary signals exist

  logger.info('Base layer scan: no primary signals today — scanning for best B+ setup');

  const profiles = await getProfiles();
  const candidates = [];

  for (const ticker of Object.keys(profiles)) {
    const tickerState = getTickerState(ticker);
    if (!tickerState?.close || !tickerState?.prevClose) continue;

    const profile = profiles[ticker];
    const marketData = getMarketData(profile.sector_etf, profile.exchange_etf);
    const newsEvents = getNewsEvents(ticker);
    const announcementCtx = getAnnouncementContext();

    const bars = getRecentBars(ticker, 20);
    const barData = {
      open: tickerState.open, high: tickerState.sessionHigh,
      low: tickerState.sessionLow, close: tickerState.close,
      volume: tickerState.volume, vwap: tickerState.vwap,
      prevClose: tickerState.prevClose, upVolRatio: tickerState.upVolRatio,
      prevDayHigh: tickerState.prevDayHigh, prevDayLow: tickerState.prevDayLow,
      bars,
    };

    const signal = await computeComposite({
      ticker, barData, marketData, newsEvents, profile,
      currentTime: new Date(), announcementCtx, isBaseLayer: true,
    });

    if (signal && ['B+', 'B'].includes(signal.grade) && !signal.conflictDetected) {
      candidates.push(signal);
    }
  }

  if (candidates.length === 0) {
    logger.info('Base layer scan: no qualifying candidates found');
    return;
  }

  // Pick the highest composite score
  const best = candidates.reduce((a, b) => a.compositeRaw > b.compositeRaw ? a : b);
  best.signalTier = 'base_layer';
  best.positionSizePct = 0.075;
  best.positionSizeDollars = Math.round(accountBalance * 0.075);

  const signalId = await writeSignal(best, { context: 'STANDALONE' });
  if (signalId) {
    logger.info(`Base layer signal: ${best.ticker} ${best.direction} ${best.grade} composite=${best.compositeRaw}`);
  }
}
