/**
 * Strategy A3: Overextension Reversal
 *
 * Sells credit spreads INTO overextended moves, profiting from mean reversion.
 *
 * Key edge: Extreme intraday moves (>2 ATR) revert statistically.
 * The equity_profiles.mean_reversion_speed field quantifies how fast.
 *
 * Direction: OPPOSITE the overextension (contrarian).
 * Structure: Credit vertical spread (sell premium at inflated IV).
 * Hold: 10-30 minutes (short = minimal risk).
 *
 * Critical filter: Must NOT be catalyst-driven (earnings/news gaps trend, don't revert).
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { analyzeTrend, classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A3_OVEREXTENSION_REVERSAL';
const MIN_ATR_OVEREXTENSION = 1.5;    // must be >= 1.5 ATR from open (was 2.0 — too restrictive intraday)
const MIN_REVERSION_SPEED   = 0.4;    // profile.mean_reversion_speed minimum
const MIN_EARNINGS_DAYS     = 3;      // no entries within 3 days of earnings
const MAX_HOLD_MINUTES      = 30;

/**
 * Generate A3 signals for a single trading day.
 */
export function generateA3Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, intelligence, secFilings, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Trade window: 10:30 - 15:00 ET (need initial volatility to establish overextension)
  const startMinute = `${date}T15:00`; // ~10:00 ET
  const endMinute   = `${date}T19:30`; // ~14:30 ET (stop 30min before close)

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // Filter: must have decent mean reversion speed
    if ((profile.mean_reversion_speed || 0) < MIN_REVERSION_SPEED) continue;

    // Filter: no recent earnings
    const intel = intelligence[ticker];
    if (intel && intel.earnings_days_away < MIN_EARNINGS_DAYS) continue;

    // Filter: no 8-K red flags (these trend, don't revert)
    const filings = secFilings[ticker] || [];
    const recentRedFlag = filings.some(f =>
      f.is_red_flag && daysDiff(f.filed_at, date) <= 3
    );
    if (recentRedFlag) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = findSessionOpen(tickerMinutes, date);
    if (!sessionOpen) continue;

    const atr = profile.atr_5d || profile.atr_20d || 0.025;
    let recentBars = [];

    const minuteKeys = Object.keys(tickerMinutes)
      .filter(k => k >= startMinute && k <= endMinute)
      .sort();

    for (const minuteKey of minuteKeys) {
      const bar = tickerMinutes[minuteKey];
      recentBars.push(bar);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);
      if (recentBars.length < 5) continue; // need history for deceleration check

      const currentPrice = bar.c;
      const moveFromOpen = (currentPrice - sessionOpen) / sessionOpen;
      const moveInATRs = moveFromOpen / atr;
      const absATRs = Math.abs(moveInATRs);

      // Must be overextended
      if (absATRs < MIN_ATR_OVEREXTENSION) continue;

      // Direction of the OVEREXTENSION (we trade OPPOSITE)
      const overextendedUp = moveInATRs > 0;
      const reversionDirection = overextendedUp ? 'PUT' : 'CALL';
      const key = `${ticker}:${reversionDirection}`;
      if (seen.has(key)) continue;

      // Check freshness — want EXTENDED or EXHAUSTED (the move is mature)
      const moveDirection = overextendedUp ? 'CALL' : 'PUT';
      const momentum = analyzeMomentum(
        recentBars, sessionOpen, sessionOpen, atr, moveDirection
      );

      // We WANT the move to be extended/exhausted — that's our entry signal
      if (momentum.freshness === 'FRESH' || momentum.freshness === 'DEVELOPING') continue;

      // Deceleration check: current bar range should be smaller than previous
      // (move is losing steam)
      if (recentBars.length >= 3) {
        const prevRange = recentBars[recentBars.length - 2].h - recentBars[recentBars.length - 2].l;
        const currRange = bar.h - bar.l;
        // Allow if decelerating OR showing exhaustion wick
        if (currRange > prevRange * 1.2 && !momentum.exhaustion) continue;
      }

      // Regime check — don't fade moves during market breakdowns
      const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, minuteKey);
      const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, minuteKey);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));

      // Don't fade during breakdowns or fast moves in same direction as overextension
      if (regime.regime === 'MARKET_BREAKDOWN') continue;
      if (overextendedUp && regime.regime === 'FAST_MOVE_UP') continue;
      if (!overextendedUp && regime.regime === 'FAST_MOVE_DOWN') continue;

      // Build signal
      const spreadWidth = getSpreadWidth(currentPrice);
      const reversionSpeed = profile.mean_reversion_speed || 0.5;
      const grade = reversionToGrade(absATRs, reversionSpeed, momentum.exhaustion);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      // Credit estimate: overextension = elevated IV = richer credit
      // Estimate 30-40% of width based on how overextended
      const creditRatio = Math.min(0.40, 0.25 + (absATRs - 2) * 0.05);

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: minuteKey,
        ticker,
        direction: reversionDirection,
        grade,
        entryPrice: currentPrice,
        atr,
        spreadType: 'CREDIT_VERTICAL',
        spreadWidth,
        entryCredit: spreadWidth * creditRatio,
        stopCondition:   { type: 'ATR', value: 0.5 }, // another 0.5 ATR extension = stop
        targetCondition: { type: 'REVERSION', value: 0.5 }, // close at 50% credit
        maxHoldMinutes: MAX_HOLD_MINUTES,
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        // Metadata
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'OVEREXTENSION_REVERSAL',
        composite: Math.round(absATRs * 20 + reversionSpeed * 30),
        scores: {
          overextension: Math.round(absATRs * 10),
          reversionSpeed: Math.round(reversionSpeed * 20),
          deceleration: momentum.exhaustion ? 10 : 5,
          regime: Math.round((regime.sizeMult || 1) * 5),
          noNewsCatalyst: 10,
        },
        metadata: {
          moveInATRs: parseFloat(moveInATRs.toFixed(2)),
          meanReversionSpeed: reversionSpeed,
          exhaustion: momentum.exhaustion,
          overextendedDirection: overextendedUp ? 'UP' : 'DOWN',
        },
      });
    }
  }

  return signals;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function daysDiff(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return Math.abs(Math.round((b - a) / (1000 * 60 * 60 * 24)));
}

function reversionToGrade(absATRs, reversionSpeed, exhaustion) {
  let score = 0;
  score += Math.min(20, absATRs * 8);           // more overextended = higher score
  score += reversionSpeed * 25;                   // faster reversion = higher score
  score += exhaustion ? 10 : 0;                   // exhaustion signals = bonus

  if (score >= 45) return 'A+';
  if (score >= 38) return 'A';
  if (score >= 30) return 'A-';
  if (score >= 22) return 'B+';
  return 'B';
}
