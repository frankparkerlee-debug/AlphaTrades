/**
 * Strategy A5: VWAP Mean Reversion
 *
 * VWAP = institutional fair value for the day. When price deviates
 * significantly (>1.0 ATR) from VWAP, it tends to revert — especially
 * when the deviation shows deceleration or exhaustion.
 *
 * Key edge: VWAP is where big money transacts. Deviations without catalyst
 * create a "rubber band" back to VWAP. Profile.mean_reversion_speed
 * quantifies how fast each ticker reverts.
 *
 * Direction: OPPOSITE the deviation (fade toward VWAP).
 * Structure: Credit vertical spread (sell premium at inflated IV from deviation).
 * Hold: 60-120 min (let theta work while price gravitates back).
 *
 * Different from A3: A3 uses open-based overextension (ATR from open).
 * A5 uses VWAP deviation (dynamic fair value), catches intraday extremes
 * that aren't necessarily far from open.
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A5_VWAP_REVERSION';
const MIN_VWAP_ATR_DEVIATION = 1.0;  // must be >= 1.0 ATR from VWAP
const MIN_REVERSION_SPEED    = 0.3;  // profile.mean_reversion_speed minimum
const MIN_EARNINGS_DAYS      = 3;    // no entries within 3 days of earnings

/**
 * Generate A5 signals for a single trading day.
 */
export function generateA5Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles, intelligence, secFilings, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Trade window: 10:30 - 14:30 ET (need VWAP to have enough volume to be meaningful)
  const startMinute = `${date}T15:00`; // ~10:00 ET
  const endMinute   = `${date}T19:00`; // ~14:00 ET

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // Must have decent mean reversion speed
    if ((profile.mean_reversion_speed || 0) < MIN_REVERSION_SPEED) continue;

    // No recent earnings
    const intel = intelligence[ticker];
    if (intel && intel.earnings_days_away < MIN_EARNINGS_DAYS) continue;

    // No 8-K red flags
    const filings = secFilings[ticker] || [];
    const recentRedFlag = filings.some(f =>
      f.is_red_flag && daysDiff(f.filed_at, date) <= 3
    );
    if (recentRedFlag) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const atr = profile.atr_5d || profile.atr_20d || 0.025;

    const sessionOpen = findSessionOpen(tickerMinutes, date);
    if (!sessionOpen) continue;

    let recentBars = [];

    const minuteKeys = Object.keys(tickerMinutes)
      .filter(k => k >= startMinute && k <= endMinute)
      .sort();

    for (const minuteKey of minuteKeys) {
      const bar = tickerMinutes[minuteKey];
      recentBars.push(bar);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);
      if (recentBars.length < 5) continue;

      const currentPrice = bar.c;
      const vwap = bar.vw;
      if (!vwap || vwap <= 0) continue; // no VWAP data for this bar

      // Compute deviation from VWAP in ATRs
      const vwapDeviation = (currentPrice - vwap) / (atr * sessionOpen);
      const absDeviation = Math.abs(vwapDeviation);

      if (absDeviation < MIN_VWAP_ATR_DEVIATION) continue;

      // Direction: fade the deviation
      const deviatedUp = vwapDeviation > 0;
      const fadeDirection = deviatedUp ? 'PUT' : 'CALL';
      const key = `${ticker}:${fadeDirection}`;
      if (seen.has(key)) continue;

      // Momentum check: the deviation move should be losing steam
      const moveDirection = deviatedUp ? 'CALL' : 'PUT';
      const momentum = analyzeMomentum(
        recentBars, sessionOpen, sessionOpen, atr, moveDirection
      );

      // We WANT the move away from VWAP to be extended/exhausted
      if (momentum.freshness === 'FRESH' || momentum.freshness === 'DEVELOPING') continue;

      // Deceleration: current bar should be smaller or show exhaustion
      if (recentBars.length >= 3) {
        const prev = recentBars[recentBars.length - 2];
        const prevRange = prev.h - prev.l;
        const currRange = bar.h - bar.l;
        // Allow if decelerating OR exhaustion wick
        if (currRange > prevRange * 1.3 && !momentum.exhaustion) continue;
      }

      // Regime check
      const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, minuteKey);
      const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, minuteKey);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
      if (regime.regime === 'MARKET_BREAKDOWN') continue;
      // Don't fade moves aligned with fast market moves
      if (deviatedUp && regime.regime === 'FAST_MOVE_UP') continue;
      if (!deviatedUp && regime.regime === 'FAST_MOVE_DOWN') continue;

      // Build signal
      const spreadWidth = getSpreadWidth(currentPrice);
      const reversionSpeed = profile.mean_reversion_speed || 0.5;
      const grade = vwapToGrade(absDeviation, reversionSpeed, momentum.exhaustion);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      // Credit estimate: deviation = elevated IV
      const creditRatio = Math.min(0.38, 0.22 + (absDeviation - 1) * 0.06);

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: minuteKey,
        ticker,
        direction: fadeDirection,
        grade,
        entryPrice: currentPrice,
        atr,
        spreadType: 'CREDIT_VERTICAL',
        spreadWidth,
        entryCredit: spreadWidth * creditRatio,
        stopCondition:   { type: 'ATR', value: 0.6 },  // tighter than A3; VWAP trades have cleaner reversion
        targetCondition: { type: 'REVERSION', value: 0.5 }, // close at 50% credit
        maxHoldMinutes: 90,  // shorter than A3; VWAP reversion is faster than open-based
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'VWAP_REVERSION',
        composite: Math.round(absDeviation * 20 + reversionSpeed * 25),
        scores: {
          vwapDeviation: Math.round(absDeviation * 10),
          reversionSpeed: Math.round(reversionSpeed * 20),
          deceleration: momentum.exhaustion ? 10 : 5,
          regime: Math.round((regime.sizeMult || 1) * 5),
          noCatalyst: 10,
        },
        metadata: {
          vwapPrice: parseFloat(vwap.toFixed(2)),
          vwapDeviationATRs: parseFloat(vwapDeviation.toFixed(2)),
          deviationDirection: deviatedUp ? 'ABOVE' : 'BELOW',
          meanReversionSpeed: reversionSpeed,
          exhaustion: momentum.exhaustion,
        },
      });
    }
  }

  return signals;
}

// -- Helpers ------------------------------------------------------------------

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

function vwapToGrade(absDeviation, reversionSpeed, exhaustion) {
  let score = 0;
  score += Math.min(20, absDeviation * 12);     // more deviated = better
  score += reversionSpeed * 20;                   // faster reversion = better
  score += exhaustion ? 10 : 0;                   // exhaustion = bonus

  if (score >= 40) return 'A+';
  if (score >= 33) return 'A';
  if (score >= 26) return 'A-';
  if (score >= 19) return 'B+';
  return 'B';
}
