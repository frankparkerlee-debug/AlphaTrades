import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Failed Breakdown / Bear Trap Strategy
 *
 * High-conviction reversal pattern for cash accounts (single-leg options).
 *
 * When a stock breaks below a key support level but immediately recovers
 * (within 15-30 minutes), it traps shorts and creates a violent reversal
 * upward. The mirror applies for failed breakouts above resistance
 * (bull trap -> PUT).
 *
 * The "trap" creates forced buying/selling that accelerates the move.
 *
 * Failed Breakdown -> CALL (bear trap):
 *   1. Today's low broke below prev day low (the break happened)
 *   2. Current price recovered above prev day low (the break failed)
 *   3. Recovery is at least 0.2% above the level
 *   4. Break was recent (within last 30 intraday bars)
 *   5. detectFlushAndHold confirms stabilization above
 *   6. Volume ratio >= 1.0 on recovery
 *
 * Failed Breakout -> PUT (bull trap):
 *   1. Today's high broke above prev day high (the break happened)
 *   2. Current price fallen below prev day high (the break failed)
 *   3. Rejection is at least 0.2% below the level
 *   4. Break was recent (within last 30 intraday bars)
 *   5. detectFlushAndHold confirms stabilization below
 *   6. Volume ratio >= 1.0 on rejection
 *
 * @param {Object} snapshots        - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses       - { ticker: number }
 * @param {number} spyChange        - SPY intraday change as decimal (e.g. -0.008 = -0.8%)
 * @param {number} qqqChange        - QQQ intraday change as decimal
 * @param {Object} volumeBaselines  - { "TICKER:windowKey": number }
 * @param {Object} levelData        - { prevDayLows, prevDayHighs, todayLows, todayHighs, dailyBars, vwaps, intradayBars }
 * @param {Object} profiles         - { ticker: { atr_20d, ... } }
 * @returns {Array} array of signal objects
 */
export function scanFailedBreakdown(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}, profiles = {}) {
  const signals = [];

  const {
    prevDayLows = {},
    prevDayHighs = {},
    todayLows = {},
    todayHighs = {},
    dailyBars = {},
    vwaps = {},
    intradayBars = {},
  } = levelData;

  // Time gate helper: 10:00 - 14:30 ET
  // Need enough session history to detect the failed break, but not too late in day.
  const now = new Date();
  const etHour = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const etMinute = now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
  const hourNum = parseInt(etHour, 10);
  const minuteNum = parseInt(etMinute, 10);
  const etTimeMinutes = hourNum * 60 + minuteNum;

  if (etTimeMinutes < 600 || etTimeMinutes > 870) return signals; // before 10:00 or after 14:30

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const prevDayLow = prevDayLows[ticker];
    const prevDayHigh = prevDayHighs[ticker];
    const vwap = vwaps[ticker];
    const bars = intradayBars[ticker] || [];
    const todayLow = todayLows[ticker];
    const todayHigh = todayHighs[ticker];

    const atr = profiles[ticker]?.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    const intradayChange = (currentPrice - todayOpen) / todayOpen;

    // Volume ratio
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
      }
    }

    // Trend structure for flags
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow, todayHigh, todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // ── Check for Failed Breakdown -> CALL (bear trap) ──────────────────
    let bearTrapSignal = null;

    if (prevDayLow && prevDayLow > 0 && todayLow && todayLow > 0) {
      const brokeBelowPrevLow = todayLow < prevDayLow;
      const recoveredAbove = currentPrice > prevDayLow;
      const recoveryPct = (currentPrice - prevDayLow) / prevDayLow;
      const breakDepthPct = (prevDayLow - todayLow) / prevDayLow;

      if (brokeBelowPrevLow && recoveredAbove && recoveryPct >= 0.002) {
        // Check recency: break below must have occurred within last 30 bars
        const recentBars = bars.slice(-30);
        const recentBreak = recentBars.some(bar => bar.l < prevDayLow);

        if (recentBreak) {
          // Volume on recovery must be decent
          if (volumeRatio === null || volumeRatio >= 1.0) {
            // ── Candle quality check ──
            const candleInfo = analyzeCandle(bars[bars.length - 1]);
            // Skip if bearish marubozu (strong counter-signal)
            if (candleInfo.type === 'BEARISH_MARUBOZU') continue;

            // ── Confluence check ──
            let confluence = null;
            if (bars.length >= 10) {
              confluence = checkConfluence(bars, 'CALL', { vwap, volumeRatio, currentPrice }, { minFactors: 3 });
              if (!confluence.pass) continue;
            }

            // ── Bullish engulfing check ──
            const engulfing = detectBullishEngulfing(bars);

            // Stabilization above the level
            const stabilization = bars.length >= 5
              ? detectFlushAndHold(bars, 'CALL')
              : { stabilized: false, barsHeld: 0 };

            // Build confidence (base 72)
            let confidence = 72;

            // Candle quality
            if (candleInfo.type === 'BULLISH_MARUBOZU') confidence += 6;
            else if (candleInfo.type === 'STRONG_BULLISH') confidence += 4;
            else confidence += 2;

            // Engulfing pattern
            if (engulfing.detected) confidence += 4;

            // Recovery strength: reclaimed > 0.5% from the level
            if (recoveryPct > 0.005) confidence += 4;

            // Volume on recovery
            if (volumeRatio !== null) {
              if (volumeRatio >= 1.5) confidence += 4;
              else if (volumeRatio >= 1.2) confidence += 2;
            }

            // Stabilization confirmed
            if (stabilization.stabilized) confidence += 4;

            // VWAP aligned: CALL should be above VWAP
            const aboveVwap = vwap && vwap > 0 && currentPrice > vwap;
            if (aboveVwap) confidence += 3;

            // Market not fighting you (SPY positive or flat for CALL)
            if (spyChange >= 0) confidence += 2;

            // Deep trap: broke > 0.1 ATR past the level
            if (atrDollar > 0 && (prevDayLow - todayLow) > 0.1 * atrDollar) confidence += 2;

            // Confluence factor adjustment
            if (confluence) {
              confidence += confluence.confirming * 2;
              confidence -= confluence.opposing * 2;
            }

            confidence = Math.max(60, Math.min(95, confidence));

            // Targets
            const stopPrice = +(todayLow * 0.998).toFixed(2);
            const t1Target = +(currentPrice + 0.5 * atrDollar).toFixed(2);
            const t2Target = +(currentPrice + 1.0 * atrDollar).toFixed(2);

            // Trend flags
            const trend_flags = [...(structure.flags || [])];
            if (!stabilization.stabilized && bars.length >= 5) trend_flags.push('no_stabilization');

            bearTrapSignal = {
              ticker,
              direction: 'CALL',
              strategy: 'FAILED_BREAKDOWN',
              entry_price: currentPrice,
              stop_price: stopPrice,
              t1_target: t1Target,
              t2_target: t2Target,
              confidence,
              exit_by: null,
              hold: 'STRUCTURAL',
              trap_type: 'BEAR_TRAP',
              level_broken: prevDayLow,
              break_depth_pct: +(breakDepthPct * 100).toFixed(2),
              recovery_pct: +(recoveryPct * 100).toFixed(2),
              gap_pct: +(intradayChange * 100).toFixed(2),
              volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
              spy_change_pct: +(spyChange * 100).toFixed(2),
              qqq_change_pct: +(qqqChange * 100).toFixed(2),
              trend: structure.trend,
              trend_flags,
              stabilized: stabilization.stabilized,
              bars_held: stabilization.barsHeld,
              candle_type: candleInfo.type,
              engulfing: engulfing.detected,
              confluence: confluence ? { pass: confluence.pass, confirming: confluence.confirming, opposing: confluence.opposing, summary: confluence.summary } : null,
              note: `BEAR TRAP: broke below prev day low ${prevDayLow.toFixed(2)} by ${(breakDepthPct * 100).toFixed(2)}%, recovered ${(recoveryPct * 100).toFixed(2)}% above | candle=${candleInfo.type} engulf=${engulfing.detected} confluence=${confluence ? confluence.summary : 'N/A'} vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x trend=${structure.trend} SPY${(spyChange * 100).toFixed(1)}% QQQ${(qqqChange * 100).toFixed(1)}%`,
            };
          }
        }
      }
    }

    // ── Check for Failed Breakout -> PUT (bull trap) ────────────────────
    let bullTrapSignal = null;

    if (prevDayHigh && prevDayHigh > 0 && todayHigh && todayHigh > 0) {
      const brokeAbovePrevHigh = todayHigh > prevDayHigh;
      const rejectedBelow = currentPrice < prevDayHigh;
      const rejectionPct = (prevDayHigh - currentPrice) / prevDayHigh;
      const breakDepthPct = (todayHigh - prevDayHigh) / prevDayHigh;

      if (brokeAbovePrevHigh && rejectedBelow && rejectionPct >= 0.002) {
        // Check recency: break above must have occurred within last 30 bars
        const recentBars = bars.slice(-30);
        const recentBreak = recentBars.some(bar => bar.h > prevDayHigh);

        if (recentBreak) {
          // Volume on rejection must be decent
          if (volumeRatio === null || volumeRatio >= 1.0) {
            // ── Candle quality check ──
            const candleInfo = analyzeCandle(bars[bars.length - 1]);
            // Skip if bullish marubozu (strong counter-signal)
            if (candleInfo.type === 'BULLISH_MARUBOZU') continue;

            // ── Confluence check ──
            let confluence = null;
            if (bars.length >= 10) {
              confluence = checkConfluence(bars, 'PUT', { vwap, volumeRatio, currentPrice }, { minFactors: 3 });
              if (!confluence.pass) continue;
            }

            // ── Bearish engulfing check ──
            const engulfing = detectBearishEngulfing(bars);

            // Stabilization below the level
            const stabilization = bars.length >= 5
              ? detectFlushAndHold(bars, 'PUT')
              : { stabilized: false, barsHeld: 0 };

            // Build confidence (base 72)
            let confidence = 72;

            // Candle quality
            if (candleInfo.type === 'BEARISH_MARUBOZU') confidence += 6;
            else if (candleInfo.type === 'STRONG_BEARISH') confidence += 4;
            else confidence += 2;

            // Engulfing pattern
            if (engulfing.detected) confidence += 4;

            // Rejection strength: fell > 0.5% from the level
            if (rejectionPct > 0.005) confidence += 4;

            // Volume on rejection
            if (volumeRatio !== null) {
              if (volumeRatio >= 1.5) confidence += 4;
              else if (volumeRatio >= 1.2) confidence += 2;
            }

            // Stabilization confirmed
            if (stabilization.stabilized) confidence += 4;

            // VWAP aligned: PUT should be below VWAP
            const belowVwap = vwap && vwap > 0 && currentPrice < vwap;
            if (belowVwap) confidence += 3;

            // Market not fighting you (SPY negative or flat for PUT)
            if (spyChange <= 0) confidence += 2;

            // Deep trap: broke > 0.1 ATR past the level
            if (atrDollar > 0 && (todayHigh - prevDayHigh) > 0.1 * atrDollar) confidence += 2;

            // Confluence factor adjustment
            if (confluence) {
              confidence += confluence.confirming * 2;
              confidence -= confluence.opposing * 2;
            }

            confidence = Math.max(60, Math.min(95, confidence));

            // Targets
            const stopPrice = +(todayHigh * 1.002).toFixed(2);
            const t1Target = +(currentPrice - 0.5 * atrDollar).toFixed(2);
            const t2Target = +(currentPrice - 1.0 * atrDollar).toFixed(2);

            // Trend flags
            const trend_flags = [...(structure.flags || [])];
            if (!stabilization.stabilized && bars.length >= 5) trend_flags.push('no_stabilization');

            bullTrapSignal = {
              ticker,
              direction: 'PUT',
              strategy: 'FAILED_BREAKDOWN',
              entry_price: currentPrice,
              stop_price: stopPrice,
              t1_target: t1Target,
              t2_target: t2Target,
              confidence,
              exit_by: null,
              hold: 'STRUCTURAL',
              trap_type: 'BULL_TRAP',
              level_broken: prevDayHigh,
              break_depth_pct: +(breakDepthPct * 100).toFixed(2),
              recovery_pct: +(rejectionPct * 100).toFixed(2),
              gap_pct: +(intradayChange * 100).toFixed(2),
              volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
              spy_change_pct: +(spyChange * 100).toFixed(2),
              qqq_change_pct: +(qqqChange * 100).toFixed(2),
              trend: structure.trend,
              trend_flags,
              stabilized: stabilization.stabilized,
              bars_held: stabilization.barsHeld,
              candle_type: candleInfo.type,
              engulfing: engulfing.detected,
              confluence: confluence ? { pass: confluence.pass, confirming: confluence.confirming, opposing: confluence.opposing, summary: confluence.summary } : null,
              note: `BULL TRAP: broke above prev day high ${prevDayHigh.toFixed(2)} by ${(breakDepthPct * 100).toFixed(2)}%, rejected ${(rejectionPct * 100).toFixed(2)}% below | candle=${candleInfo.type} engulf=${engulfing.detected} confluence=${confluence ? confluence.summary : 'N/A'} vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x trend=${structure.trend} SPY${(spyChange * 100).toFixed(1)}% QQQ${(qqqChange * 100).toFixed(1)}%`,
            };
          }
        }
      }
    }

    // Push the higher-confidence trap signal for this ticker (or both if both qualify)
    if (bearTrapSignal) {
      signals.push(bearTrapSignal);
      console.log(`[FAILED_BREAKDOWN] ${ticker} BEAR TRAP: broke below ${bearTrapSignal.level_broken.toFixed(2)}, recovered ${bearTrapSignal.recovery_pct}% above | conf=${bearTrapSignal.confidence} vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x trend=${structure.trend} -> CALL`);
    }

    if (bullTrapSignal) {
      signals.push(bullTrapSignal);
      console.log(`[FAILED_BREAKDOWN] ${ticker} BULL TRAP: broke above ${bullTrapSignal.level_broken.toFixed(2)}, rejected ${bullTrapSignal.recovery_pct}% below | conf=${bullTrapSignal.confidence} vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x trend=${structure.trend} -> PUT`);
    }
  }

  // Cap at top 3 signals — traps are rare and high-conviction
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals.slice(0, 3);
}
