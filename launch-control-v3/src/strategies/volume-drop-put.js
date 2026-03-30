/**
 * Volume Drop Put Strategy
 *
 * Based on data analysis finding: 3%+ intraday drops on normal volume
 * (<1.5x baseline) continue down 57% of the time with average -0.38%
 * next day. Low volume selling = distribution, not capitulation.
 *
 * Multi-factor confluence validation added to improve signal quality.
 * Dynamic confidence scoring replaces static 57% baseline.
 *
 * @param {Object} snapshots - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses - { ticker: number }
 * @param {Object} volumeBaselines - { "TICKER:windowKey": number }
 * @param {Object} levelData - { intradayBars, vwaps, ... }
 * @returns {Array} array of signal objects
 */
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle } from '../indicators/candle-patterns.js';

export function scanVolumeDropPut(snapshots, prevCloses, volumeBaselines, levelData = {}) {
  const signals = [];

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    if (!snap || !snap.open || !snap.price || !snap.volume) continue;

    const todayOpen = snap.open;
    const currentPrice = snap.price;
    const intradayDrop = (currentPrice - todayOpen) / todayOpen;

    if (intradayDrop > -0.03) continue;

    const windowKey = snap.windowKey;
    if (!windowKey) continue;

    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    if (!baseline || baseline <= 0) continue;

    const volumeRatio = snap.volume / baseline;
    if (volumeRatio >= 1.5) continue;

    // ── Candle quality check on latest intraday bar ─────────────────────
    const bars = (levelData.intradayBars || {})[ticker] || [];
    let candle = null;
    let candleType = 'UNKNOWN';

    if (bars.length > 0) {
      candle = analyzeCandle(bars[bars.length - 1]);
      candleType = candle.type;

      // Require body > 40% and bearish candle for distribution signal
      if (candle.bodyRatio <= 0.40 || !candle.bearish) continue;
    }

    // ── Confluence check ────────────────────────────────────────────────
    let confluence = null;

    if (bars.length >= 10) {
      confluence = checkConfluence(bars, 'PUT', {
        vwap: (levelData.vwaps || {})[ticker],
        volumeRatio,
        currentPrice,
      }, { minFactors: 2 });

      // Skip if confluence fails with too much opposition
      if (!confluence.pass && confluence.opposing > 1) continue;
    }

    // ── Dynamic confidence scoring ──────────────────────────────────────
    let confidence = 62; // base

    // Candle quality bonus
    if (candle) {
      if (candle.type === 'BEARISH_MARUBOZU') confidence += 6;
      else if (candle.type === 'STRONG_BEARISH') confidence += 4;
      else confidence += 2;
    }

    // Drop size bonus
    const dropPct = Math.abs(intradayDrop * 100);
    if (dropPct > 4) confidence += 4;
    else if (dropPct > 3.5) confidence += 2;

    // Truly low volume = more distributional
    if (volumeRatio < 0.8) confidence += 3;

    // Confluence adjustment
    if (confluence) {
      confidence += confluence.confirming * 2;
      confidence -= confluence.opposing * 2;
    }

    // Clamp 55-85
    confidence = Math.max(55, Math.min(85, confidence));

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'VOL_DROP_PUT',
      entry_price: currentPrice,
      intraday_drop_pct: +(intradayDrop * 100).toFixed(2),
      volume_ratio: +volumeRatio.toFixed(2),
      confidence: +confidence.toFixed(1),
      candle_type: candleType,
      confluence: confluence
        ? { pass: confluence.pass, confirming: confluence.confirming, opposing: confluence.opposing, summary: confluence.summary }
        : null,
      hold: 'OVERNIGHT',
      exit_at: 'NEXT_OPEN',
      note: 'LOW_VOLUME_DISTRIBUTION',
    });
  }

  return signals;
}
