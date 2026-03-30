import { checkBounceStructure } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle } from '../indicators/candle-patterns.js';

/**
 * Consecutive Drop Bounce Strategy
 *
 * 2 consecutive days down 3%+ -> 64.3% bounce. 3 consecutive days -> 100%
 * bounce historically. Trend structure flags attached — consecutive drops
 * into a higher low zone flagged clean, extending lower lows flagged 'downtrend'.
 *
 * Horizon: MULTIDAY (exit within 3 days)
 */
export function scanConsecutiveDrop(tickers, dailyBars, levelData = {}) {
  const signals = [];
  const { currentPrices = {}, todayLows = {}, todayHighs = {} } = levelData;

  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);

  for (const ticker of tickers) {
    const bars = dailyBars[ticker];
    if (!bars || bars.length < 3) continue;

    const n = bars.length;
    const c0 = bars[n - 3].c;
    const c1 = bars[n - 2].c;
    const c2 = bars[n - 1].c;

    if (!c0 || !c1 || !c2) continue;

    const drop1 = (c1 - c0) / c0;
    const drop2 = (c2 - c1) / c1;

    if (drop1 > -0.03 || drop2 > -0.03) continue;

    let consecutiveDays = 2;
    let totalDrop = (c2 - c0) / c0;

    if (bars.length >= 4) {
      const c_prev = bars[n - 4].c;
      if (c_prev) {
        const drop0 = (c0 - c_prev) / c_prev;
        if (drop0 <= -0.03) {
          consecutiveDays = 3;
          totalDrop = (c2 - c_prev) / c_prev;
        }
      }
    }

    // Trend structure analysis — flags, never blocks
    const price = currentPrices[ticker];
    let structure = { flags: [], trend: 'UNKNOWN', nearestSupport: null, nearestResistance: null, resistanceRoom: null, trendConfidence: 0 };
    if (price) {
      structure = checkBounceStructure(price, bars, {
        todayLow: todayLows[ticker], todayHigh: todayHighs[ticker],
      }, 'multiday');

      if (structure.flags.length > 0) {
        console.log(`[CONSEC] ${ticker} ${consecutiveDays}-day drop ${(totalDrop*100).toFixed(1)}% — flagged: ${structure.flags.join(', ')} (trend=${structure.trend})`);
      }
    }

    // ── Confluence check (daily bars, relaxed threshold) ─────────────
    let confluenceResult = null;
    if (bars.length >= 15) {
      confluenceResult = checkConfluence(bars, 'CALL', { currentPrice: price }, { minFactors: 2 });
      if (confluenceResult.opposing > 2) continue;
    }

    // ── Candle quality on latest daily bar ──────────────────────────
    const candleResult = analyzeCandle(bars[bars.length - 1]);

    // ── Dynamic confidence scoring ──────────────────────────────────
    let confidence = consecutiveDays >= 3 ? 78 : 68;

    // Candle quality bonus
    if (candleResult) {
      if (candleResult.pattern === 'HAMMER') confidence += 6;
      else if (candleResult.strength === 'STRONG' && candleResult.direction === 'BULL') confidence += 4;
      else if (candleResult.pattern === 'DOJI') confidence += 2;
    }

    // Confluence scoring
    if (confluenceResult) {
      confidence += (confluenceResult.confirming || 0) * 2;
      confidence -= (confluenceResult.opposing || 0) * 2;
    }

    // Structure bonus/penalty
    if (structure.trend === 'UPTREND' || structure.trend === 'RANGE') confidence += 2;
    else if (structure.trend === 'DOWNTREND') confidence -= 3;

    // Clamp
    confidence = Math.max(60, Math.min(95, confidence));

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'CONSEC_BOUNCE',
      entry_price: price || c2,
      consecutive_days: consecutiveDays,
      total_drop_pct: +(totalDrop * 100).toFixed(2),
      confidence,
      hold: 'MULTIDAY',
      exit_within_days: 3,
      dedup_key: `${ticker}-W${weekNum}`,
      trend: structure.trend,
      trend_flags: structure.flags,
      support_at: structure.nearestSupport,
      resistance_at: structure.nearestResistance,
      resistance_room: structure.resistanceRoom,
      candle_type: candleResult ? candleResult.pattern : null,
      confluence: confluenceResult ? { confirming: confluenceResult.confirming, opposing: confluenceResult.opposing, factors: confluenceResult.factors } : null,
    });
  }

  return signals;
}
