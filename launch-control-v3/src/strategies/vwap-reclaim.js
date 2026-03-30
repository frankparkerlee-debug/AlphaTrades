import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * VWAP Reclaim/Reject Strategy (INCOME playbook - single-leg options)
 *
 * VWAP is institutional fair value. When price crosses VWAP and holds,
 * continuation is likely. When price fails at VWAP, rejection predicts reversal.
 *
 * Two signal types:
 *   RECLAIM (CALL) - price crosses above VWAP from below and holds
 *   REJECT  (PUT)  - price tests VWAP from below but fails to hold above
 *
 * Time gate: 10:00 ET - 14:30 ET (need enough session for VWAP to be meaningful)
 *
 * @param {Object} snapshots        - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses       - { ticker: number }
 * @param {number} spyChange        - SPY intraday change as decimal (e.g. -0.008 = -0.8%)
 * @param {number} qqqChange        - QQQ intraday change as decimal
 * @param {Object} volumeBaselines  - { "TICKER:windowKey": number }
 * @param {Object} levelData        - { vwaps, intradayBars, ... }
 * @param {Object} profiles         - { ticker: { atr_20d, ... } }
 * @returns {Array} array of signal objects
 */
export function scanVwapReclaim(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}, profiles = {}) {
  const signals = [];

  // Time gate: 10:00 ET (600 min) to 14:30 ET (870 min)
  const etString = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);
  const etMinutes = etDate.getHours() * 60 + etDate.getMinutes();
  if (etMinutes < 600 || etMinutes > 870) return signals;

  const { vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const vwap = vwaps[ticker];
    const bars = intradayBars[ticker] || [];

    // Must have VWAP and enough bars for analysis
    if (!vwap || vwap <= 0) continue;
    if (bars.length < 10) continue;

    const atr = profiles[ticker]?.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Volume ratio
    const windowKey = snap.windowKey;
    const baseline = windowKey ? volumeBaselines[`${ticker}:${windowKey}`] : null;
    const volumeRatio = (baseline && baseline > 0) ? snap.volume / baseline : null;

    const gapPct = (currentPrice - todayOpen) / todayOpen;
    const recentBars = bars.slice(-10);

    // Determine signal type
    let signalType = null;
    let direction = null;

    // --- VWAP RECLAIM (CALL) ---
    if (currentPrice > vwap) {
      // Price was below VWAP within last 10 bars (crossed from below to above)
      const wasBelowRecently = recentBars.some(bar => bar.c < vwap);
      const currentBarAbove = recentBars[recentBars.length - 1]?.c > vwap;

      if (wasBelowRecently && currentBarAbove) {
        // VWAP distance: should be within 0.5% above VWAP (just reclaimed)
        const vwapDistancePct = (currentPrice - vwap) / vwap;
        if (vwapDistancePct > 0.005) continue; // too far above, not a fresh reclaim
        if (vwapDistancePct <= 0) continue;

        // Volume should not be collapsing
        if (volumeRatio !== null && volumeRatio < 0.8) continue;

        // Candle quality check on latest bar
        const lastBar = recentBars[recentBars.length - 1];
        const candleInfo = analyzeCandle(lastBar);
        if (candleInfo.bodyRatio <= 0.40) {
          console.log(`[VWAP_RECLAIM] ${ticker} skipped: weak candle (bodyRatio=${candleInfo.bodyRatio})`);
          continue;
        }

        // Confluence check
        const confluence = checkConfluence(bars, 'CALL', { vwap, volumeRatio, currentPrice }, { minFactors: 3 });
        if (!confluence.pass) {
          console.log(`[VWAP_RECLAIM] ${ticker} skipped: confluence fail (${confluence.summary})`);
          continue;
        }

        // Bullish engulfing check on last 2 bars
        const engulfing = detectBullishEngulfing(recentBars.slice(-2));

        // Stabilization: sellers gave up, buyers holding above VWAP
        const stabilization = detectFlushAndHold(bars, 'CALL');

        // Count VWAP tests (bars that touched or crossed VWAP)
        let vwapTests = 0;
        for (const bar of recentBars) {
          if ((bar.l <= vwap && bar.h >= vwap) || (bar.c <= vwap * 1.002 && bar.c >= vwap * 0.998)) {
            vwapTests++;
          }
        }

        // Clean cross check: current bar closed above VWAP with body (not just a wick)
        const cleanCross = lastBar && lastBar.o < lastBar.c && lastBar.c > vwap;

        // Closing strong: recent bars closing in upper portion of range
        let closingStrong = 0;
        const postCrossBars = recentBars.slice(-3);
        for (const bar of postCrossBars) {
          const range = bar.h - bar.l;
          if (range > 0 && (bar.c - bar.l) / range > 0.6) closingStrong++;
        }

        // Market alignment: SPY positive is favorable for calls
        const marketAligned = spyChange > 0;

        // Dynamic confidence scoring: base 72
        let confidence = 72;
        // Candle quality
        if (candleInfo.type === 'BULLISH_MARUBOZU') confidence += 6;
        else if (candleInfo.type === 'STRONG_BULLISH') confidence += 4;
        else confidence += 2;
        // Engulfing
        if (engulfing.detected) confidence += 4;
        // Stabilization
        if (stabilization.stabilized && stabilization.barsHeld >= 5) confidence += 5;
        else if (stabilization.stabilized) confidence += 3;
        // Volume
        if (volumeRatio !== null && volumeRatio >= 1.2) confidence += 3;
        // Market alignment
        if (marketAligned) confidence += 3;
        // VWAP tests (+2 per test, cap at +6)
        confidence += Math.min(6, vwapTests * 2);
        // Clean cross
        if (cleanCross) confidence += 2;
        // Closing strong
        if (closingStrong >= 2) confidence += 2;
        // Confluence adjustments (+2 per confirming, -2 per opposing)
        confidence += confluence.confirming * 2;
        confidence -= confluence.opposing * 2;
        // Clamp 60-95
        confidence = Math.max(60, Math.min(95, confidence));

        const stopPrice = +(vwap * 0.995).toFixed(2);
        const t1Target = +(currentPrice + 0.4 * atrDollar).toFixed(2);
        const t2Target = +(currentPrice + 0.8 * atrDollar).toFixed(2);

        signals.push({
          ticker,
          direction: 'CALL',
          strategy: 'VWAP_RECLAIM',
          entry_price: currentPrice,
          stop_price: stopPrice,
          t1_target: t1Target,
          t2_target: t2Target,
          confidence,
          exit_by: null,
          hold: 'STRUCTURAL',
          vwap_price: vwap,
          vwap_distance_pct: +(vwapDistancePct * 100).toFixed(2),
          signal_type: 'RECLAIM',
          gap_pct: +(gapPct * 100).toFixed(2),
          volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
          spy_change_pct: +(spyChange * 100).toFixed(2),
          qqq_change_pct: +(qqqChange * 100).toFixed(2),
          trend: stabilization.closingStrong ? 'RECOVERING' : 'NEUTRAL',
          trend_flags: [
            ...(stabilization.stabilized ? ['stabilized_above_vwap'] : ['no_stabilization']),
            ...(cleanCross ? ['clean_cross'] : []),
            ...(vwapTests >= 3 ? ['multi_test'] : []),
          ],
          stabilized: stabilization.stabilized,
          bars_held: stabilization.barsHeld,
          candle_type: candleInfo.type,
          engulfing: engulfing.detected,
          confluence: { pass: confluence.pass, confirming: confluence.confirming, opposing: confluence.opposing, summary: confluence.summary },
          note: `VWAP reclaim +${(vwapDistancePct * 100).toFixed(2)}% above ${vwap.toFixed(2)} | ${vwapTests} test(s) | vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x | SPY${(spyChange * 100).toFixed(1)}% | candle=${candleInfo.type} | ${engulfing.detected ? 'ENGULFING' : 'no engulfing'} | confluence=${confluence.confirming}/${Object.keys(confluence.factors).length}`,
        });

        console.log(`[VWAP_RECLAIM] ${ticker} reclaimed VWAP ${vwap.toFixed(2)} +${(vwapDistancePct * 100).toFixed(2)}% vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x tests=${vwapTests} candle=${candleInfo.type} engulf=${engulfing.detected} confluence=${confluence.summary} -> CALL conf=${confidence}`);
        continue; // one signal per ticker
      }
    }

    // --- VWAP REJECT (PUT) ---
    if (currentPrice < vwap) {
      // Price tested VWAP from below within last 10 bars but failed to hold above
      const testedVwap = recentBars.some(bar => bar.h >= vwap * 0.998);
      const currentBelowVwap = recentBars[recentBars.length - 1]?.c < vwap;

      if (testedVwap && currentBelowVwap) {
        // VWAP distance: should be within 0.8% below VWAP (just rejected)
        const vwapDistancePct = (currentPrice - vwap) / vwap; // negative
        if (vwapDistancePct < -0.008) continue; // too far below, already collapsed
        if (vwapDistancePct >= 0) continue;

        // Candle quality check on latest bar
        const lastBar = recentBars[recentBars.length - 1];
        const candleInfo = analyzeCandle(lastBar);
        if (candleInfo.bodyRatio <= 0.40) {
          console.log(`[VWAP_REJECT] ${ticker} skipped: weak candle (bodyRatio=${candleInfo.bodyRatio})`);
          continue;
        }

        // Confluence check
        const confluence = checkConfluence(bars, 'PUT', { vwap, volumeRatio, currentPrice }, { minFactors: 3 });
        if (!confluence.pass) {
          console.log(`[VWAP_REJECT] ${ticker} skipped: confluence fail (${confluence.summary})`);
          continue;
        }

        // Bearish engulfing check on last 2 bars
        const engulfing = detectBearishEngulfing(recentBars.slice(-2));

        // Stabilization: sellers holding below VWAP
        const stabilization = detectFlushAndHold(bars, 'PUT');

        // Count VWAP tests
        let vwapTests = 0;
        for (const bar of recentBars) {
          if (bar.h >= vwap * 0.998 && bar.c < vwap) {
            vwapTests++;
          }
        }

        // Clean reject: bar wicked above VWAP but closed below
        const cleanReject = lastBar && lastBar.h >= vwap * 0.998 && lastBar.c < vwap && lastBar.c < lastBar.o;

        // Closing weak: recent bars closing in lower portion of range
        let closingWeak = 0;
        const postRejectBars = recentBars.slice(-3);
        for (const bar of postRejectBars) {
          const range = bar.h - bar.l;
          if (range > 0 && (bar.h - bar.c) / range > 0.6) closingWeak++;
        }

        // Market alignment: SPY negative is favorable for puts
        const marketAligned = spyChange < 0;

        // Dynamic confidence scoring: base 72
        let confidence = 72;
        // Candle quality
        if (candleInfo.type === 'BEARISH_MARUBOZU') confidence += 6;
        else if (candleInfo.type === 'STRONG_BEARISH') confidence += 4;
        else confidence += 2;
        // Engulfing
        if (engulfing.detected) confidence += 4;
        // Stabilization
        if (stabilization.stabilized && stabilization.barsHeld >= 5) confidence += 5;
        else if (stabilization.stabilized) confidence += 3;
        // Volume
        if (volumeRatio !== null && volumeRatio >= 1.2) confidence += 3;
        // Market alignment
        if (marketAligned) confidence += 3;
        // VWAP tests (+2 per test, cap at +6)
        confidence += Math.min(6, vwapTests * 2);
        // Clean reject
        if (cleanReject) confidence += 2;
        // Closing weak
        if (closingWeak >= 2) confidence += 2;
        // Confluence adjustments (+2 per confirming, -2 per opposing)
        confidence += confluence.confirming * 2;
        confidence -= confluence.opposing * 2;
        // Clamp 60-95
        confidence = Math.max(60, Math.min(95, confidence));

        const stopPrice = +(vwap * 1.005).toFixed(2);
        const t1Target = +(currentPrice - 0.4 * atrDollar).toFixed(2);
        const t2Target = +(currentPrice - 0.8 * atrDollar).toFixed(2);

        signals.push({
          ticker,
          direction: 'PUT',
          strategy: 'VWAP_RECLAIM',
          entry_price: currentPrice,
          stop_price: stopPrice,
          t1_target: t1Target,
          t2_target: t2Target,
          confidence,
          exit_by: null,
          hold: 'STRUCTURAL',
          vwap_price: vwap,
          vwap_distance_pct: +(vwapDistancePct * 100).toFixed(2),
          signal_type: 'REJECT',
          gap_pct: +(gapPct * 100).toFixed(2),
          volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
          spy_change_pct: +(spyChange * 100).toFixed(2),
          qqq_change_pct: +(qqqChange * 100).toFixed(2),
          trend: stabilization.closingStrong ? 'WEAKENING' : 'NEUTRAL',
          trend_flags: [
            ...(stabilization.stabilized ? ['stabilized_below_vwap'] : ['no_stabilization']),
            ...(cleanReject ? ['clean_reject'] : []),
            ...(vwapTests >= 3 ? ['multi_test'] : []),
          ],
          stabilized: stabilization.stabilized,
          bars_held: stabilization.barsHeld,
          candle_type: candleInfo.type,
          engulfing: engulfing.detected,
          confluence: { pass: confluence.pass, confirming: confluence.confirming, opposing: confluence.opposing, summary: confluence.summary },
          note: `VWAP reject ${(vwapDistancePct * 100).toFixed(2)}% below ${vwap.toFixed(2)} | ${vwapTests} test(s) | vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x | SPY${(spyChange * 100).toFixed(1)}% | candle=${candleInfo.type} | ${engulfing.detected ? 'ENGULFING' : 'no engulfing'} | confluence=${confluence.confirming}/${Object.keys(confluence.factors).length}`,
        });

        console.log(`[VWAP_REJECT] ${ticker} rejected at VWAP ${vwap.toFixed(2)} ${(vwapDistancePct * 100).toFixed(2)}% vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x tests=${vwapTests} candle=${candleInfo.type} engulf=${engulfing.detected} confluence=${confluence.summary} -> PUT conf=${confidence}`);
      }
    }
  }

  // Cap at top 5 by confidence
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals.slice(0, 5);
}
