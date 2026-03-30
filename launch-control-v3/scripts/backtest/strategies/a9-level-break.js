/**
 * Strategy A9: Prior Day Level Break
 *
 * Prior day high (PDH) and prior day low (PDL) are institutional levels.
 * When price breaks through with volume confirmation and VWAP alignment,
 * continuation in the breakout direction is likely.
 *
 * Key edge: PDH/PDL represent the previous session's accepted value range.
 * Breaking these levels means new institutional intent — especially when
 * confirmed by volume and VWAP position.
 *
 * Bear: Break below PDL + below VWAP + volume > 1.3x = continuation down.
 * Bull: Break above PDH + above VWAP + volume > 1.3x = continuation up.
 *
 * Direction: Same as break direction (institutional continuation).
 * Structure: Debit vertical spread.
 * Hold: 60-120 min (level breaks need follow-through time).
 *
 * Critical filter: Must be a clean break (not just a wick), confirmed
 * by closing price, not just intrabar touch.
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { analyzeTrend, classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A9_LEVEL_BREAK';
const MIN_VOL_SURGE       = 1.3;   // breakout volume must be 1.3x recent avg
const BREAK_MARGIN_ATR    = 0.1;   // must exceed level by 0.1 ATR (not just touch)
const MIN_HOLD_AT_LEVEL   = 3;     // price must have been near level for 3+ bars before break

/**
 * Generate A9 signals for a single trading day.
 */
export function generateA9Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Scan window: 10:00 - 15:00 ET
  const scanStart = `${date}T14:30`;
  const scanEnd   = `${date}T19:30`;

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // Get prior day high/low
    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;

    const pdh = prevBar.h;
    const pdl = prevBar.l;
    if (!pdh || !pdl || pdh <= pdl) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const atr = profile.atr_5d || profile.atr_20d || 0.025;
    const atrDollar = atr * (prevBar.c || pdh);

    const allKeys = Object.keys(tickerMinutes)
      .filter(k => k >= scanStart && k <= scanEnd).sort();
    if (allKeys.length < 10) continue;

    const sessionOpen = findSessionOpen(tickerMinutes, date);
    if (!sessionOpen) continue;

    let recentBars = [];
    let recentVols = [];
    let barsNearPDH = 0;  // bars within 0.3 ATR of PDH
    let barsNearPDL = 0;  // bars within 0.3 ATR of PDL

    for (const minuteKey of allKeys) {
      const bar = tickerMinutes[minuteKey];
      recentBars.push(bar);
      if (bar.v > 0) recentVols.push(bar.v);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);
      if (recentVols.length > 10) recentVols = recentVols.slice(-10);
      if (recentBars.length < 5) continue;

      const currentPrice = bar.c;
      const vwap = bar.vw || currentPrice;

      // Track bars near levels (price coiling before break)
      if (Math.abs(currentPrice - pdh) < atrDollar * 0.3) barsNearPDH++;
      if (Math.abs(currentPrice - pdl) < atrDollar * 0.3) barsNearPDL++;

      // Volume
      const avgVol = recentVols.length > 2
        ? recentVols.slice(0, -1).reduce((a, b) => a + b, 0) / (recentVols.length - 1) : 0;
      const volSurge = avgVol > 0 ? bar.v / avgVol : 1;

      // ── Check for PDH break (bullish) ─────────────────────────
      const pdhBreak = currentPrice > pdh + atrDollar * BREAK_MARGIN_ATR;
      if (pdhBreak && !seen.has(`${ticker}:CALL`)) {
        // VWAP must be above (or near) to confirm bullish
        if (currentPrice < vwap) continue; // below VWAP = not confirmed

        // Volume confirmation
        if (volSurge < MIN_VOL_SURGE) continue;

        // Price should have been near PDH before breaking (not just gapped over)
        if (barsNearPDH < MIN_HOLD_AT_LEVEL) {
          // Allow gap-through if gap was small and we're early in session
          const gapOverPDH = sessionOpen > pdh;
          if (!gapOverPDH) continue;
        }

        const signal = buildBreakSignal(
          'CALL', ticker, date, minuteKey, bar, profile,
          sessionOpen, atr, pdh, pdl, vwap, volSurge, barsNearPDH,
          recentBars, etfMinuteBars
        );
        if (signal) {
          seen.add(`${ticker}:CALL`);
          signals.push(signal);
        }
      }

      // ── Check for PDL break (bearish) ─────────────────────────
      const pdlBreak = currentPrice < pdl - atrDollar * BREAK_MARGIN_ATR;
      if (pdlBreak && !seen.has(`${ticker}:PUT`)) {
        // VWAP must be below (or near) to confirm bearish
        if (currentPrice > vwap) continue; // above VWAP = not confirmed

        // Volume confirmation
        if (volSurge < MIN_VOL_SURGE) continue;

        // Price should have been near PDL before breaking
        if (barsNearPDL < MIN_HOLD_AT_LEVEL) {
          const gapBelowPDL = sessionOpen < pdl;
          if (!gapBelowPDL) continue;
        }

        const signal = buildBreakSignal(
          'PUT', ticker, date, minuteKey, bar, profile,
          sessionOpen, atr, pdh, pdl, vwap, volSurge, barsNearPDL,
          recentBars, etfMinuteBars
        );
        if (signal) {
          seen.add(`${ticker}:PUT`);
          signals.push(signal);
        }
      }
    }
  }

  return signals;
}

function buildBreakSignal(
  direction, ticker, date, minuteKey, bar, profile,
  sessionOpen, atr, pdh, pdl, vwap, volSurge, barsNearLevel,
  recentBars, etfMinuteBars
) {
  const currentPrice = bar.c;

  // Trend check: want alignment (breaking PDH in an uptrend is stronger)
  const trend = analyzeTrend(recentBars, direction);
  if (trend.signalType === 'COUNTER_TREND_STRONG') return null;

  // Momentum check
  const momentum = analyzeMomentum(
    recentBars, sessionOpen, sessionOpen, atr, direction
  );
  if (momentum.freshness === 'EXHAUSTED') return null;
  if (momentum.freshness === 'LATE' && !trend.trendAligned) return null;

  // Regime check
  const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, minuteKey);
  const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, minuteKey);
  const spyPct = spyBars.length >= 2
    ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
  const qqqPct = qqqBars.length >= 2
    ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

  const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
  if (regime.sizeMult === 0) return null;
  if (direction === 'CALL' && !regime.callsAllowed) return null;
  if (direction === 'PUT' && !regime.putsAllowed) return null;

  // Break distance from level
  const level = direction === 'CALL' ? pdh : pdl;
  const breakDistance = Math.abs(currentPrice - level) / (atr * sessionOpen);

  const spreadWidth = getSpreadWidth(currentPrice);
  const grade = levelBreakToGrade(volSurge, barsNearLevel, trend, breakDistance);
  const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

  return {
    strategy: STRATEGY,
    date,
    time: minuteKey,
    ticker,
    direction,
    grade,
    entryPrice: currentPrice,
    atr,
    spreadType: 'DEBIT_VERTICAL',
    spreadWidth,
    entryDebit: spreadWidth * 0.45,
    stopCondition:   { type: 'ATR', value: 0.5 },  // stop below the broken level
    targetCondition: { type: 'ATR', value: 0.8 },  // level breaks can run
    maxHoldMinutes: 90,
    holdDays: 0,
    sizePct,
    oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
    freshness: momentum.freshness,
    regime: regime.regime,
    signalType: 'LEVEL_BREAK',
    composite: Math.round(volSurge * 10 + barsNearLevel * 3 + breakDistance * 15 + (trend.trendAligned ? 10 : 0)),
    scores: {
      volumeConfirm: Math.round(Math.min(10, volSurge * 5)),
      levelCoil: Math.round(Math.min(10, barsNearLevel * 2)),
      breakStrength: Math.round(breakDistance * 15),
      trendAlignment: trend.trendAligned ? 10 : 0,
      regime: Math.round((regime.sizeMult || 1) * 5),
    },
    metadata: {
      levelBroken: direction === 'CALL' ? 'PDH' : 'PDL',
      levelPrice: level,
      breakDistanceATRs: parseFloat(breakDistance.toFixed(3)),
      barsNearLevel,
      volSurge: parseFloat(volSurge.toFixed(2)),
      vwapPrice: parseFloat(vwap.toFixed(2)),
      vwapConfirms: direction === 'CALL' ? currentPrice > vwap : currentPrice < vwap,
      trendAligned: trend.trendAligned,
    },
  };
}

// -- Helpers ------------------------------------------------------------------

function findPrevDayBar(dailyBars, ticker, date) {
  const dates = Object.keys(dailyBars[ticker] || {}).sort();
  const idx = dates.indexOf(date);
  if (idx > 0) return dailyBars[ticker][dates[idx - 1]];
  if (dates.length > 0 && dates[dates.length - 1] < date) {
    return dailyBars[ticker][dates[dates.length - 1]];
  }
  return null;
}

function findSessionOpen(tickerMinutes, date) {
  const keys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
  return keys.length > 0 ? tickerMinutes[keys[0]]?.o : null;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function levelBreakToGrade(volSurge, barsNearLevel, trend, breakDistance) {
  let score = 0;

  // Volume confirmation (most important)
  score += Math.min(15, (volSurge - 1) * 15);

  // Price coiled near level before break (consolidation = energy)
  score += Math.min(10, barsNearLevel * 2);

  // Trend alignment
  if (trend.trendAligned && trend.trendStrength === 'STRONG') score += 10;
  else if (trend.trendAligned) score += 7;
  else score += 2;

  // Clean break distance (not too far = chasing, not too close = false break)
  if (breakDistance >= 0.1 && breakDistance <= 0.5) score += 8;
  else if (breakDistance < 0.1) score += 3; // barely through
  else score += 5; // already extended past level

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}
