/**
 * Strategy A1: Fresh Momentum
 *
 * Trades FRESH moves only (bars 1-2, < 1.0 ATR from open).
 * Uses debit vertical spreads for defined risk.
 *
 * Key edge: Freshness classification predicts win rate.
 *   FRESH: ~64% WR → only trade these
 *   EXTENDED/LATE: ~28-42% WR → skip
 *
 * Hold: 15-45 minutes max.
 * Stop: 0.5 ATR adverse underlying move.
 * Target: 1.0 ATR favorable move (single target, no partials).
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { analyzeTrend, classifyRegime, analyzeLevels, gateSignal } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A1_FRESH_MOMENTUM';

/**
 * Generate A1 signals for a single trading day.
 *
 * @param {string} date - YYYY-MM-DD
 * @param {Object} dayData - { minuteBars, etfMinuteBars, dailyBars, vixByTime }
 * @param {Object} context - { profiles, intelligence, tickers }
 * @returns {Array} signals
 */
export function generateA1Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set(); // dedup: one per ticker+direction per day

  // Market hours: 10:00 - 15:00 ET (skip first 30min chop)
  // Convert to UTC: ET+5 in winter, ET+4 in summer
  // Use 14:30 - 20:00 UTC as safe window (covers both DST states)
  const startMinute = `${date}T14:30`;
  const endMinute   = `${date}T19:00`;

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const prevDayBar = findPrevDayBar(dailyBars, ticker, date);
    const sessionOpen = findSessionOpen(tickerMinutes, date);
    if (!sessionOpen) continue;

    const atr = profile.atr_5d || profile.atr_20d || 0.025;
    let recentBars = [];

    // Scan each minute
    const minuteKeys = Object.keys(tickerMinutes).filter(k => k >= startMinute && k <= endMinute).sort();

    for (const minuteKey of minuteKeys) {
      const bar = tickerMinutes[minuteKey];
      recentBars.push(bar);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);
      if (recentBars.length < 3) continue;

      const currentPrice = bar.c;

      // Determine direction from move
      const moveFromOpen = (currentPrice - sessionOpen) / sessionOpen;
      const direction = moveFromOpen > 0 ? 'CALL' : 'PUT';
      const key = `${ticker}:${direction}`;
      if (seen.has(key)) continue;

      // ── Freshness check ────────────────────────────────────
      const momentum = analyzeMomentum(
        recentBars, sessionOpen, prevDayBar?.c || sessionOpen, atr, direction
      );

      // CRITICAL FILTER: Only FRESH or early DEVELOPING moves
      if (momentum.freshness !== 'FRESH' && momentum.freshness !== 'DEVELOPING') continue;
      if (momentum.entryRisk === 'HIGH' || momentum.entryRisk === 'EXTREME') continue;
      if (momentum.volSurge < 1.1) continue; // need volume confirmation

      // ── Minimum move gate ──────────────────────────────────
      if (momentum.moveInATRs < 0.1) continue; // too small

      // ── Trend check ────────────────────────────────────────
      const trend = analyzeTrend(recentBars, direction);
      if (trend.signalType === 'COUNTER_TREND_STRONG') continue;
      if (trend.signalType === 'REVERSAL_RISK') continue;

      // ── Regime check ───────────────────────────────────────
      const spyBars = getETFBarsUpto(etfMinuteBars.SPY, minuteKey);
      const qqqBars = getETFBarsUpto(etfMinuteBars.QQQ, minuteKey);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
      if (regime.sizeMult === 0) continue;
      if (direction === 'CALL' && !regime.callsAllowed) continue;
      if (direction === 'PUT' && !regime.putsAllowed) continue;

      // ── Level check ────────────────────────────────────────
      const sessionHigh = Math.max(...recentBars.map(b => b.h));
      const sessionLow = Math.min(...recentBars.map(b => b.l));
      const levels = analyzeLevels({
        close: currentPrice,
        vwap: bar.vw || currentPrice,
        sessionHigh, sessionLow,
        prevDayHigh: prevDayBar?.h,
        prevDayLow: prevDayBar?.l,
        sessionOpen,
        bars: recentBars,
      }, atr);

      // Final gate
      const gate = gateSignal(direction, trend, levels, regime, momentum.freshness);
      if (!gate.allow) continue;

      // ── Build signal ───────────────────────────────────────
      const spreadWidth = getSpreadWidth(currentPrice);
      const grade = scoreToGrade(momentum.momentumScore, trend, regime);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * gate.adjustedSizeMult;

      seen.add(key);
      signals.push({
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
        entryDebit: spreadWidth * 0.45, // pay ~45% of width
        stopCondition:   { type: 'ATR', value: 0.5 },
        targetCondition: { type: 'ATR', value: 1.0 },
        maxHoldMinutes: 45,
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        // Metadata for analysis
        freshness: momentum.freshness,
        barsInMove: momentum.barsInMove,
        moveInATRs: momentum.moveInATRs,
        volSurge: momentum.volSurge,
        regime: regime.regime,
        signalType: trend.signalType,
        composite: momentum.momentumScore,
        scores: {
          momentum: momentum.momentumScore,
          trend: trend.trendAligned ? 5 : 0,
          regime: regime.sizeMult * 5,
          volume: Math.min(10, momentum.volSurge * 3),
          levels: levels.vwapOverextended ? 0 : 5,
        },
      });
    }
  }

  return signals;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  if (keys.length === 0) return null;
  return tickerMinutes[keys[0]]?.o || null;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function scoreToGrade(momentumScore, trend, regime) {
  let score = momentumScore; // 0-35
  if (trend.trendAligned) score += 10;
  if (trend.volExpanding) score += 5;
  if (regime.regime === 'RISK_ON') score += 5;

  if (score >= 40) return 'A+';
  if (score >= 33) return 'A';
  if (score >= 26) return 'A-';
  if (score >= 20) return 'B+';
  return 'B';
}
