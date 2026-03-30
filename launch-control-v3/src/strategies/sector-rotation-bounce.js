import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Sector Rotation Bounce Strategy — MULTI-FACTOR CONFLUENCE
 *
 * Based on data analysis finding: on green market days (SPY >+0.3% AND QQQ >+0.3%),
 * tickers gapping down 2-3% at open bounce 90% of the time with an
 * average +2.22% intraday recovery. Requiring both SPY and QQQ green confirms
 * broad market + tech participation — the green market IS the confirmation.
 *
 * Multi-factor validation:
 *   1. Gap trigger: 2-3% gap down on green market day (SPY+QQQ both >0.3%)
 *   2. Candle confirmation: first candle must be strong green (body > 50%) or bullish pattern
 *   3. Confluence: at least 3 of 6 technical factors confirming CALL direction
 *   4. Dynamic confidence: starts at 72, earned through candle quality + confluence + structure
 *
 * Horizon: INTRADAY — structural exit (new low = thesis broken)
 *
 * @param {Object} snapshots    - { ticker: { open, price, volume } }
 * @param {Object} prevCloses   - { ticker: number }
 * @param {number} spyChange    - SPY intraday change as decimal (e.g. 0.008 = +0.8%)
 * @param {Object} firstCandles - { ticker: { open, close, high, low } }
 * @param {number} qqqChange    - QQQ intraday change as decimal
 * @param {Object} levelData    - { vwaps, intradayBars, todayLows, todayHighs, dailyBars }
 * @returns {Array} array of signal objects
 */
export function scanSectorRotationBounce(snapshots, prevCloses, spyChange, firstCandles, qqqChange = 0, levelData = {}) {
  const signals = [];

  // Require BOTH SPY and QQQ up 0.3%+ for broad market confirmation
  if (spyChange <= 0.003 || qqqChange <= 0.003) return signals;

  const { todayLows = {}, todayHighs = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    const candle = firstCandles ? firstCandles[ticker] : null;

    if (!snap || !prevClose) continue;

    const todayOpen = snap.open;
    if (!todayOpen || !prevClose) continue;

    // -- Trigger: gap down 2-3% on green market day --------------------------
    const gap = (todayOpen - prevClose) / prevClose;
    if (gap < -0.03 || gap > -0.02) continue;

    const currentPrice = snap.price || todayOpen;
    const vwap = vwaps[ticker] || 0;
    const bars = intradayBars[ticker] || [];

    // -- Candle Quality: must be a STRONG green candle or bullish pattern -----
    let candleAnalysis = null;
    let candlePass = false;

    if (candle) {
      const isGreen = candle.close > candle.open;
      if (!isGreen) {
        console.log(`[SECTOR SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% -- red candle`);
        continue;
      }

      candleAnalysis = analyzeCandle(candle);

      // Need body > 50% of range (strong conviction buying) OR bullish pattern detected
      if (candleAnalysis.bodyRatio >= 0.50) {
        candlePass = true;
      }
    }

    // Check for bullish engulfing as alternative candle confirmation
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = detectBullishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
      if (engulfing) candlePass = true;
    }

    // If we have candle data but it fails quality check, skip
    if (candle && !candlePass) {
      const bodyPct = candleAnalysis ? (candleAnalysis.bodyRatio * 100).toFixed(0) : '?';
      console.log(`[SECTOR SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% -- weak candle (body=${bodyPct}%, no engulfing)`);
      continue;
    }

    // -- Multi-Factor Confluence ----------------------------------------------
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, 'CALL', {
        vwap,
        volumeRatio: null,
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[SECTOR SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% -- confluence fail: ${confluenceResult.summary} [${confluenceResult.details.join(', ')}]`);
        continue;
      }
    }

    // -- Stabilization Check --------------------------------------------------
    let stabilized = false;
    let barsHeld = 0;
    if (bars.length >= 3) {
      // Simple stabilization: price holding above recent low
      const recentLows = bars.slice(-3).map(b => b.l);
      const lowestRecent = Math.min(...recentLows);
      stabilized = currentPrice > lowestRecent;
      if (stabilized) {
        barsHeld = bars.length >= 5 ? 5 : bars.length;
      }
    }

    // -- Dynamic Confidence ---------------------------------------------------
    let confidence = 72; // base — must earn it through confluence

    // Candle quality
    if (candleAnalysis) {
      if (candleAnalysis.type === 'BULLISH_MARUBOZU') confidence += 6;
      else if (candleAnalysis.type === 'STRONG_BULLISH') confidence += 4;
      else confidence += 2; // minimum for passing the body ratio check
    }

    // Confluence score
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
    }

    // Stabilization
    if (stabilized && barsHeld >= 5) confidence += 4;
    else if (stabilized) confidence += 2;

    // Engulfing pattern
    if (engulfing) confidence += 4;

    // VWAP support
    if (vwap > 0 && currentPrice > vwap) confidence += 2;

    // Trend: green market is strong tailwind
    const marketStrength = spyChange + qqqChange;
    if (marketStrength >= 0.015) confidence += 3; // both up 0.75%+
    else if (marketStrength >= 0.01) confidence += 1;

    confidence = Math.min(95, Math.max(60, confidence));

    // -- Targets --------------------------------------------------------------
    const gapAmount = prevClose - todayOpen;
    const t1 = +(todayOpen + gapAmount * 0.40).toFixed(2);
    const t2 = +(prevClose).toFixed(2);

    // -- Structural Stop: today's low -----------------------------------------
    const todayLow = todayLows[ticker] || (candle ? candle.low : null) || todayOpen;
    const stopPrice = +(todayLow * 0.998).toFixed(2);

    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';

    const candleTypeNote = candleAnalysis ? candleAnalysis.type : 'no_candle';
    const candleBodyPct = candleAnalysis ? Math.round(candleAnalysis.bodyRatio * 100) : null;

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'SECTOR_ROTATION_BOUNCE',
      entry_price: currentPrice,
      stop_price: stopPrice,
      gap_pct: +(gap * 100).toFixed(2),
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      t1_target: t1,
      t2_target: t2,
      confidence,
      exit_by: null,       // structural exit, not time-based
      hold: 'STRUCTURAL',
      candle_type: candleTypeNote,
      candle_body_pct: candleBodyPct,
      engulfing,
      stabilized,
      bars_held: barsHeld,
      confluence: confluenceResult ? {
        confirming: confluenceResult.confirming,
        opposing: confluenceResult.opposing,
        factors: Object.fromEntries(
          Object.entries(confluenceResult.factors).map(([k, v]) => [k, v.confirm])
        ),
      } : null,
      note: `down ${Math.abs(gap * 100).toFixed(1)}% on green market day SPY+${(spyChange * 100).toFixed(1)}% QQQ+${(qqqChange * 100).toFixed(1)}% | ${candleTypeNote}${candleBodyPct != null ? ` body=${candleBodyPct}%` : ''} | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''}${stabilized ? ` | stabilized ${barsHeld}bars` : ''}`,
    });

    console.log(`[SECTOR] ${ticker} gap ${(gap*100).toFixed(1)}% on green day | ${candleTypeNote} | ${confluenceNote} | conf=${confidence}`);
  }

  return signals;
}
