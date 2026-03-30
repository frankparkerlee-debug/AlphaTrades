/**
 * Strategy A6: Gap Fade
 *
 * Overnight gaps of 1.5-3.5% that aren't catalyst-driven tend to fill
 * intraday. The live system shows 83.9% recovery for 2-3% gap-downs
 * with a green first candle, and 90% when the broad market is green.
 *
 * Key edge: Gaps represent overnight order imbalances from thinner
 * pre/post-market. Regular session liquidity corrects these.
 *
 * Direction: OPPOSITE the gap (fade back toward previous close).
 * Structure: Debit vertical spread (buy the fill).
 * Hold: 60-180 min (gap fills are gradual; needs patience).
 *
 * Critical filter: NO catalyst gaps (earnings, 8-K, FDA, etc.).
 * Those trend, they don't fill.
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A6_GAP_FADE';
const MIN_GAP_PCT    = 0.015;  // minimum 1.5% gap
const MAX_GAP_PCT    = 0.035;  // maximum 3.5% gap (>3.5% may be catalyst-driven)
const MIN_EARNINGS_DAYS = 5;   // no entries within 5 days of earnings (wider than usual)
const CONFIRMATION_BARS = 5;   // need 5 bars to confirm gap is stabilizing/reversing

/**
 * Generate A6 signals for a single trading day.
 */
export function generateA6Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, intelligence, secFilings, tickers } = context;
  const signals = [];
  const seen = new Set();

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // Need previous day close for gap calculation
    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;

    const prevClose = prevBar.c;
    if (!prevClose || prevClose <= 0) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const allKeys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
    if (allKeys.length < CONFIRMATION_BARS + 3) continue;

    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Calculate gap
    const gapPct = (sessionOpen - prevClose) / prevClose;
    const absGap = Math.abs(gapPct);

    if (absGap < MIN_GAP_PCT || absGap > MAX_GAP_PCT) continue;

    const gappedUp = gapPct > 0;
    const fadeDirection = gappedUp ? 'PUT' : 'CALL';
    const key = `${ticker}:${fadeDirection}`;
    if (seen.has(key)) continue;

    // Catalyst filter: no earnings
    const intel = intelligence[ticker];
    if (intel && intel.earnings_days_away < MIN_EARNINGS_DAYS) continue;

    // No 8-K red flags
    const filings = secFilings[ticker] || [];
    const recentRedFlag = filings.some(f =>
      f.is_red_flag && daysDiff(f.filed_at, date) <= 5
    );
    if (recentRedFlag) continue;

    const atr = profile.atr_5d || profile.atr_20d || 0.025;

    // Confirmation: wait for the first N bars to see if gap is filling
    // Entry window: 9:45 - 11:00 ET (15:15 - 15:30 UTC)
    const entryStart = `${date}T14:45`; // ~9:45 ET
    const entryEnd   = `${date}T16:00`; // ~11:00 ET

    const confirmBars = [];
    for (const k of allKeys) {
      if (k < entryStart) continue;
      if (k > entryEnd) break;
      confirmBars.push({ key: k, bar: tickerMinutes[k] });
    }
    if (confirmBars.length < CONFIRMATION_BARS) continue;

    // Check first candle: is it already reversing the gap?
    const firstCandle = tickerMinutes[allKeys[0]];
    const gapDownGreenCandle = !gappedUp && firstCandle.c > firstCandle.o;
    const gapUpRedCandle = gappedUp && firstCandle.c < firstCandle.o;
    const firstCandleConfirms = gapDownGreenCandle || gapUpRedCandle;

    // Scan confirmation bars for entry point
    let recentBars = [];
    for (const { key: mKey, bar } of confirmBars) {
      recentBars.push(bar);
      if (recentBars.length < CONFIRMATION_BARS) continue;
      if (recentBars.length > 15) recentBars = recentBars.slice(-15);

      const currentPrice = bar.c;

      // Gap is starting to fill? Price should be moving TOWARD prev close
      const fillProgress = gappedUp
        ? (sessionOpen - currentPrice) / (sessionOpen - prevClose)
        : (currentPrice - sessionOpen) / (prevClose - sessionOpen);

      // Need some fill progress (5-50%) — too early = no confirmation, too late = missed it
      if (fillProgress < 0.05 || fillProgress > 0.50) continue;

      // Momentum of the gap-fill direction should be fresh/developing
      const momentum = analyzeMomentum(
        recentBars, sessionOpen, prevClose, atr, fadeDirection
      );
      // For gap fades, we want the FILL move to be fresh, not the gap itself
      if (momentum.freshness === 'EXHAUSTED' || momentum.freshness === 'LATE') continue;

      // Regime check
      const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, mKey);
      const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, mKey);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
      if (regime.sizeMult === 0) continue;
      if (fadeDirection === 'CALL' && !regime.callsAllowed) continue;
      if (fadeDirection === 'PUT' && !regime.putsAllowed) continue;

      // Green market boost: gap-down fades work much better on green market days
      const greenMarket = spyPct > 0.003 && qqqPct > 0.003;

      // Build signal
      const spreadWidth = getSpreadWidth(currentPrice);
      const grade = gapToGrade(absGap, fillProgress, firstCandleConfirms, greenMarket);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: mKey,
        ticker,
        direction: fadeDirection,
        grade,
        entryPrice: currentPrice,
        atr,
        spreadType: 'DEBIT_VERTICAL',
        spreadWidth,
        entryDebit: spreadWidth * 0.45,
        stopCondition:   { type: 'ATR', value: 0.6 },  // gap can wiggle; give room
        targetCondition: { type: 'ATR', value: 0.7 },  // target ~70% of ATR favorable
        maxHoldMinutes: 150, // gap fills are gradual; patience
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'GAP_FADE',
        composite: Math.round(absGap * 1500 + (firstCandleConfirms ? 15 : 0) + (greenMarket ? 10 : 0)),
        scores: {
          gapSize: Math.round(absGap * 500),
          fillProgress: Math.round(fillProgress * 20),
          firstCandle: firstCandleConfirms ? 10 : 0,
          greenMarket: greenMarket ? 10 : 0,
          regime: Math.round((regime.sizeMult || 1) * 5),
        },
        metadata: {
          gapPct: parseFloat((gapPct * 100).toFixed(2)),
          gapDirection: gappedUp ? 'UP' : 'DOWN',
          prevClose,
          sessionOpen,
          fillProgress: parseFloat(fillProgress.toFixed(3)),
          firstCandleConfirms,
          greenMarket,
        },
      });

      break; // one entry per ticker per direction
    }
  }

  return signals;
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

function gapToGrade(absGap, fillProgress, firstCandleConfirms, greenMarket) {
  let score = 0;

  // Gap size: 2-3% is the sweet spot
  if (absGap >= 0.02 && absGap <= 0.03) score += 15;
  else if (absGap >= 0.015) score += 10;
  else score += 5;

  // Fill progress: 10-30% means confirmation without missing the move
  if (fillProgress >= 0.10 && fillProgress <= 0.30) score += 10;
  else score += 5;

  // First candle reversal
  if (firstCandleConfirms) score += 10;

  // Green market (for gap-down fades)
  if (greenMarket) score += 10;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}
