import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Power Hour Continuation Strategy
 *
 * Between 14:30-15:30 ET, institutional closing flows accelerate the
 * intraday trend. Stocks with established momentum continue into close.
 * Time-gated to 14:30-15:15 ET for entry (gives time to work before 16:00).
 *
 * Entry criteria:
 *   1. Time gate: 14:30-15:15 ET only
 *   2. Established intraday trend: move from open >= 0.5 ATR (but <= 2.5 ATR)
 *   3. VWAP confirmation: price above VWAP for CALL, below for PUT
 *   4. Momentum persistence >= 0.3
 *   5. Volume at least average (>= 0.8x baseline)
 *   6. Market alignment: SPY not fighting the trade direction
 *   7. No reversal bars in last 5 bars of intraday data
 *
 * Targets: 0.3 ATR (T1), 0.6 ATR (T2) from entry
 * Stop: VWAP break (thesis is broken)
 * Exit: 16:00 market close (0DTE positioning)
 *
 * @param {Object} snapshots       - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses      - { ticker: number }
 * @param {number} spyChange       - SPY intraday change as decimal (e.g. -0.008 = -0.8%)
 * @param {number} qqqChange       - QQQ intraday change as decimal
 * @param {Object} volumeBaselines - { "TICKER:windowKey": number }
 * @param {Object} levelData       - { prevDayLows, prevDayHighs, todayLows, todayHighs, dailyBars, vwaps, intradayBars }
 * @param {Object} profiles        - { ticker: { atr_20d, momentum_persistence, ... } }
 * @returns {Array} array of signal objects
 */
export function scanPowerHour(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}, profiles = {}) {
  const signals = [];

  // Time gate: only fire between 14:30 and 15:15 ET
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = et.getHours() * 60 + et.getMinutes();
  if (etMins < 870 || etMins > 915) return signals;

  const { prevDayLows = {}, prevDayHighs = {}, todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const vwap = vwaps[ticker];
    const profile = profiles[ticker] || {};

    // ATR for sizing thresholds
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Intraday move from open
    const intradayMove = (currentPrice - todayOpen) / todayOpen;
    const moveInATRs = Math.abs(intradayMove) / atr;

    // Need established trend: at least 0.5 ATR move from open
    if (moveInATRs < 0.5) continue;

    // Don't chase exhausted moves: skip if already > 2.5 ATR
    if (moveInATRs > 2.5) continue;

    // Direction: same as intraday trend
    const direction = intradayMove > 0 ? 'CALL' : 'PUT';

    // VWAP confirmation
    if (!vwap || vwap <= 0) continue;
    if (direction === 'CALL' && currentPrice <= vwap) continue;
    if (direction === 'PUT' && currentPrice >= vwap) continue;
    const vwapDistance = (currentPrice - vwap) / vwap;

    // Momentum persistence check
    const momentumPersistence = profile.momentum_persistence || 0.5;
    if (momentumPersistence < 0.3) continue;

    // Volume check: at least average (0.8x baseline)
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
        if (volumeRatio < 0.8) continue;
      }
    }

    // Market alignment: SPY should not fight the trade direction
    if (direction === 'CALL' && spyChange <= -0.002) continue;
    if (direction === 'PUT' && spyChange >= 0.002) continue;

    // Intraday bars reversal check
    const bars = intradayBars[ticker] || [];
    const recentBars = bars.slice(-15);
    const lastFive = recentBars.slice(-5);
    const reversalThreshold = 0.2 * atrDollar;
    let hasReversal = false;

    for (const bar of lastFive) {
      if (!bar || bar.close == null || bar.open == null) continue;
      const barMove = bar.close - bar.open;
      if (direction === 'CALL' && barMove < -reversalThreshold) { hasReversal = true; break; }
      if (direction === 'PUT' && barMove > reversalThreshold) { hasReversal = true; break; }
    }
    if (hasReversal) continue;

    // ── Candle quality gate ──────────────────────────────────────────────
    const latestBar = bars.length > 0 ? bars[bars.length - 1] : null;
    const candleAnalysis = latestBar ? analyzeCandle(latestBar) : null;

    if (candleAnalysis) {
      if (direction === 'CALL') {
        // For CALL: body > 40%, not bearish type
        if (candleAnalysis.bodyRatio <= 0.4 || candleAnalysis.type.startsWith('BEARISH') || candleAnalysis.type === 'SHOOTING_STAR') {
          console.log(`[POWER_HOUR SKIP] ${ticker} — weak candle for CALL: ${candleAnalysis.type} body=${(candleAnalysis.bodyRatio * 100).toFixed(0)}%`);
          continue;
        }
      } else {
        // For PUT: body > 40%, not bullish type
        if (candleAnalysis.bodyRatio <= 0.4 || candleAnalysis.type.startsWith('BULLISH') || candleAnalysis.type === 'HAMMER') {
          console.log(`[POWER_HOUR SKIP] ${ticker} — weak candle for PUT: ${candleAnalysis.type} body=${(candleAnalysis.bodyRatio * 100).toFixed(0)}%`);
          continue;
        }
      }
    }

    // ── Confluence check ─────────────────────────────────────────────────
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, direction, {
        vwap,
        volumeRatio,
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[POWER_HOUR SKIP] ${ticker} — confluence fail: ${confluenceResult.summary}`);
        continue;
      }
    }

    // ── Engulfing check ──────────────────────────────────────────────────
    const engulfingResult = bars.length >= 2
      ? (direction === 'CALL' ? detectBullishEngulfing(bars) : detectBearishEngulfing(bars))
      : { detected: false, quality: 0 };

    // Check last 10 bars for reversal (used in confidence scoring)
    const lastTen = recentBars.slice(-10);
    let reversalInLastTen = false;
    for (const bar of lastTen) {
      if (!bar || bar.close == null || bar.open == null) continue;
      const barMove = bar.close - bar.open;
      if (direction === 'CALL' && barMove < -reversalThreshold) { reversalInLastTen = true; break; }
      if (direction === 'PUT' && barMove > reversalThreshold) { reversalInLastTen = true; break; }
    }

    // Check for clean trend (no major whipsaws in all 15 bars)
    let majorWhipsaws = 0;
    const whipsawThreshold = 0.5 * atrDollar;
    for (let i = 1; i < recentBars.length; i++) {
      const prev = recentBars[i - 1];
      const curr = recentBars[i];
      if (!prev || !curr || prev.close == null || curr.close == null) continue;
      const prevMove = prev.close - prev.open;
      const currMove = curr.close - curr.open;
      if (direction === 'CALL' && prevMove > whipsawThreshold && currMove < -whipsawThreshold) majorWhipsaws++;
      if (direction === 'PUT' && prevMove < -whipsawThreshold && currMove > whipsawThreshold) majorWhipsaws++;
    }
    const cleanTrend = majorWhipsaws === 0;

    // Confidence scoring: base 72
    let confidence = 72;

    // Candle quality
    if (candleAnalysis) {
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.startsWith('STRONG')) confidence += 4;
      else confidence += 2;
    }

    // Engulfing pattern
    if (engulfingResult.detected) confidence += 4;

    // Move from open 0.8-1.5 ATR sweet spot
    if (moveInATRs >= 0.8 && moveInATRs <= 1.5) confidence += 4;

    // Momentum persistence
    if (momentumPersistence >= 0.6) confidence += 4;
    else if (momentumPersistence >= 0.4) confidence += 2;

    // Market strongly aligned (SPY > 0.3% same direction)
    if (direction === 'CALL' && spyChange > 0.003) confidence += 3;
    if (direction === 'PUT' && spyChange < -0.003) confidence += 3;

    // VWAP distance in favor
    if (direction === 'CALL' && vwapDistance > 0.003) confidence += 2;
    if (direction === 'PUT' && vwapDistance < -0.003) confidence += 2;

    // Volume above average (>= 1.2x)
    if (volumeRatio && volumeRatio >= 1.2) confidence += 2;

    // No reversal bars in last 10
    if (!reversalInLastTen) confidence += 2;

    // Clean trend (no major whipsaws)
    if (cleanTrend) confidence += 2;

    // Confluence: +2 per confirming, -2 per opposing
    if (confluenceResult) {
      confidence += confluenceResult.confirming * 2;
      confidence -= confluenceResult.opposing * 2;
    }

    // Clamp 60-95
    confidence = Math.min(95, Math.max(60, confidence));

    // Stop: VWAP break (thesis broken if VWAP gives way)
    const stopPrice = direction === 'CALL'
      ? +(vwap * 0.998).toFixed(2)
      : +(vwap * 1.002).toFixed(2);

    // Targets: quick moves into close
    const t1Target = direction === 'CALL'
      ? +(currentPrice + 0.3 * atrDollar).toFixed(2)
      : +(currentPrice - 0.3 * atrDollar).toFixed(2);

    const t2Target = direction === 'CALL'
      ? +(currentPrice + 0.6 * atrDollar).toFixed(2)
      : +(currentPrice - 0.6 * atrDollar).toFixed(2);

    const gapPct = +((currentPrice - prevClose) / prevClose * 100).toFixed(2);

    // Flush+hold for context
    const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, direction) : { stabilized: false, barsHeld: 0 };

    // Build trend flags
    const trend_flags = [];
    if (moveInATRs >= 0.8 && moveInATRs <= 1.5) trend_flags.push('sweet_spot_move');
    if (moveInATRs > 1.5) trend_flags.push('extended_move');
    if (cleanTrend) trend_flags.push('clean_trend');
    if (!cleanTrend) trend_flags.push('whipsaw_present');
    if (stabilization.stabilized) trend_flags.push('flush_and_hold');
    if (momentumPersistence >= 0.6) trend_flags.push('strong_persistence');

    const trendLabel = direction === 'CALL' ? 'UPTREND' : 'DOWNTREND';

    signals.push({
      ticker,
      direction,
      strategy: 'POWER_HOUR',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: t1Target,
      t2_target: t2Target,
      confidence,
      exit_by: '16:00',
      hold: 'CLOSE_OR_STRUCTURAL',
      move_from_open_pct: +(intradayMove * 100).toFixed(2),
      move_in_atrs: +moveInATRs.toFixed(2),
      momentum_persistence: +momentumPersistence.toFixed(2),
      gap_pct: gapPct,
      volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      trend: trendLabel,
      trend_flags,
      candle_type: candleAnalysis ? candleAnalysis.type : null,
      engulfing: engulfingResult.detected ? { detected: true, quality: engulfingResult.quality } : null,
      confluence: confluenceResult ? { pass: confluenceResult.pass, confirming: confluenceResult.confirming, opposing: confluenceResult.opposing, summary: confluenceResult.summary } : null,
      note: `Power hour ${direction} -- ${(intradayMove * 100).toFixed(1)}% from open (${moveInATRs.toFixed(1)} ATR), VWAP ${vwapDistance > 0 ? '+' : ''}${(vwapDistance * 100).toFixed(1)}%, momentum ${momentumPersistence.toFixed(2)}, candle ${candleAnalysis ? candleAnalysis.type : 'N/A'}${engulfingResult.detected ? ' +engulfing' : ''}, confluence ${confluenceResult ? confluenceResult.summary : 'N/A'}, SPY ${(spyChange * 100).toFixed(1)}%`,
    });

    console.log(`[POWER_HOUR] ${ticker} ${direction} ${(intradayMove * 100).toFixed(1)}% from open (${moveInATRs.toFixed(1)} ATR) VWAP ${(vwapDistance * 100).toFixed(1)}% vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x persistence=${momentumPersistence.toFixed(2)} conf=${confidence}`);
  }

  // Cap at top 5 by confidence
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals.slice(0, 5);
}
