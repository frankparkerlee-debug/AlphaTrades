import { checkBounceStructure } from './support-check.js';
import { classifyTrend, findSwingLows, findSwingHighs } from './support-check.js';

/**
 * Credit Spread Income Strategy
 *
 * Sells OTM credit spreads at structurally defended levels.
 * High confidence, 20-30% max gain, frequent (1-2 daily).
 *
 * Bull Put Credit Spread:
 *   - Stock holding ABOVE support (prev day low, swing low, VWAP)
 *   - Support has been tested and defended (at least 1 bounce)
 *   - Sell put spread BELOW that support level
 *   - Exit: structural breakdown (close below support) OR option expiry
 *
 * Bear Call Credit Spread:
 *   - Stock holding BELOW resistance (prev day high, swing high, VWAP)
 *   - Resistance has been tested and defended (at least 1 rejection)
 *   - Sell call spread ABOVE that resistance level
 *   - Exit: structural breakdown (close above resistance) OR option expiry
 *
 * Key edge: range-bound stocks with declining volume near defended levels
 * have very low probability of breaking through. Collect theta.
 *
 * @param {Object} snapshots      - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses     - { ticker: number }
 * @param {number} spyChange      - SPY intraday change as decimal
 * @param {number} qqqChange      - QQQ intraday change as decimal
 * @param {Object} volumeBaselines - { "TICKER:windowKey": number }
 * @param {Object} levelData      - { prevDayLows, prevDayHighs, todayLows, todayHighs, dailyBars, vwaps, intradayBars }
 * @param {Object} profiles       - equity_profiles keyed by ticker
 * @returns {Array} array of signal objects
 */
export function scanCreditSpread(
  snapshots, prevCloses, spyChange, qqqChange,
  volumeBaselines, levelData = {}, profiles = {}
) {
  const signals = [];

  // Hard gate: no credit spreads during market crashes (>1.5% selloff)
  // or euphoric rips (>1.5% rally) — levels don't hold in trend days
  if (Math.abs(spyChange) > 0.015 || Math.abs(qqqChange) > 0.015) return signals;

  const {
    prevDayLows = {}, prevDayHighs = {},
    todayLows = {}, todayHighs = {},
    dailyBars = {}, vwaps = {}, intradayBars = {}
  } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const vwap = vwaps[ticker];
    const prevDayLow = prevDayLows[ticker];
    const prevDayHigh = prevDayHighs[ticker];
    const todayLow = todayLows[ticker];
    const todayHigh = todayHighs[ticker];
    const bars = intradayBars[ticker] || [];
    const daily = dailyBars[ticker] || [];
    const profile = profiles[ticker];

    // Need price levels to anchor the spread
    if (!prevDayLow || !prevDayHigh) continue;

    // ATR for range normalization
    const atr = profile?.atr_20d ? parseFloat(profile.atr_20d) : 0.025;
    const atrDollar = atr * currentPrice;
    if (atrDollar <= 0) continue;

    // Range-bound check: today's range must be < 1.2 ATR (not a trend day)
    if (todayHigh && todayLow && todayHigh > todayLow) {
      const todayRange = todayHigh - todayLow;
      if (todayRange > atrDollar * 1.2) continue;
    }

    // Intraday move check: can't be moving >0.8 ATR from open (too directional)
    const intradayMove = Math.abs(currentPrice - todayOpen);
    if (intradayMove > atrDollar * 0.8) continue;

    // Volume check: skip if volume is surging (breakout risk)
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
      }
    }
    if (volumeRatio && volumeRatio > 1.5) continue; // high volume = breakout risk

    // Trend classification from daily bars
    const trendData = classifyTrend(daily);

    // ── BULL PUT CREDIT SPREAD ──────────────────────────────────────────
    // Sell put spread below support when stock is holding above it
    const support = findBestSupport(currentPrice, prevDayLow, vwap, todayLow, daily, atrDollar);
    if (support) {
      const distToSupport = (currentPrice - support.price) / currentPrice;

      // Price must be 0.3%-2.5% above support (close enough to be relevant,
      // far enough that we're not already breaking)
      if (distToSupport >= 0.003 && distToSupport <= 0.025) {
        const defended = isLevelDefended(bars, support.price, atrDollar, 'support');

        if (defended.count >= 1) {
          let confidence = 74; // base — lands at B+ minimum

          // Level defense strength
          if (defended.count >= 3) confidence += 6;
          else if (defended.count >= 2) confidence += 4;
          else confidence += 2;

          // VWAP alignment: price above VWAP = institutional support
          if (vwap && currentPrice > vwap) confidence += 3;

          // Low volume = range-bound, good for credit spreads
          if (volumeRatio && volumeRatio < 0.8) confidence += 3;
          else if (volumeRatio && volumeRatio < 1.0) confidence += 1;

          // Healthy distance from support (not hugging it)
          if (distToSupport >= 0.01) confidence += 2;

          // Market alignment: green market = less likely to break support
          if (spyChange > 0.002) confidence += 2;
          else if (spyChange > 0) confidence += 1;

          // Trend: range or uptrend is ideal (support more likely to hold)
          if (trendData.trend === 'UPTREND') confidence += 3;
          else if (trendData.trend === 'RANGE') confidence += 1;
          else if (trendData.trend === 'DOWNTREND' && trendData.confidence >= 0.7) {
            confidence -= 5; // support less reliable in downtrend
          }

          // Multi-day support (tested on prior days too) is strongest
          if (support.source === 'swing_low') confidence += 2;

          confidence = Math.min(95, Math.max(60, confidence));

          // Structural stop: close below support = thesis broken
          const breakdownPrice = +(support.price * 0.997).toFixed(2);

          signals.push({
            ticker,
            direction: 'CALL', // bullish thesis (stock stays above support)
            strategy: 'CREDIT_SPREAD',
            spread_type: 'BULL_PUT',
            entry_price: currentPrice,
            stop_price: breakdownPrice,
            defended_level: +support.price.toFixed(2),
            level_source: support.source,
            credit_target_pct: 25,
            t1_target: null, // credit spread — no price target, collect decay
            t2_target: null,
            confidence,
            exit_by: null, // no time exit — expiry or structural breakdown
            hold: 'EXPIRY_OR_BREAKDOWN',
            gap_pct: +((currentPrice - todayOpen) / todayOpen * 100).toFixed(2),
            volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
            spy_change_pct: +(spyChange * 100).toFixed(2),
            qqq_change_pct: +(qqqChange * 100).toFixed(2),
            level_defended_count: defended.count,
            dist_to_level_pct: +(distToSupport * 100).toFixed(2),
            trend: trendData.trend,
            trend_flags: [],
            note: `bull put below ${support.price.toFixed(2)} (${support.source}, defended ${defended.count}x) | dist ${(distToSupport * 100).toFixed(1)}%`,
          });
        }
      }
    }

    // ── BEAR CALL CREDIT SPREAD ─────────────────────────────────────────
    // Sell call spread above resistance when stock is holding below it
    const resistance = findBestResistance(currentPrice, prevDayHigh, vwap, todayHigh, daily, atrDollar);
    if (resistance) {
      const distToResistance = (resistance.price - currentPrice) / currentPrice;

      if (distToResistance >= 0.003 && distToResistance <= 0.025) {
        const defended = isLevelDefended(bars, resistance.price, atrDollar, 'resistance');

        if (defended.count >= 1) {
          let confidence = 74;

          if (defended.count >= 3) confidence += 6;
          else if (defended.count >= 2) confidence += 4;
          else confidence += 2;

          // VWAP alignment: price below VWAP = institutional pressure
          if (vwap && currentPrice < vwap) confidence += 3;

          if (volumeRatio && volumeRatio < 0.8) confidence += 3;
          else if (volumeRatio && volumeRatio < 1.0) confidence += 1;

          if (distToResistance >= 0.01) confidence += 2;

          // Market alignment: red market = less likely to break resistance
          if (spyChange < -0.002) confidence += 2;
          else if (spyChange < 0) confidence += 1;

          if (trendData.trend === 'DOWNTREND') confidence += 3;
          else if (trendData.trend === 'RANGE') confidence += 1;
          else if (trendData.trend === 'UPTREND' && trendData.confidence >= 0.7) {
            confidence -= 5;
          }

          if (resistance.source === 'swing_high') confidence += 2;

          confidence = Math.min(95, Math.max(60, confidence));

          const breakdownPrice = +(resistance.price * 1.003).toFixed(2);

          signals.push({
            ticker,
            direction: 'PUT', // bearish thesis (stock stays below resistance)
            strategy: 'CREDIT_SPREAD',
            spread_type: 'BEAR_CALL',
            entry_price: currentPrice,
            stop_price: breakdownPrice,
            defended_level: +resistance.price.toFixed(2),
            level_source: resistance.source,
            credit_target_pct: 25,
            t1_target: null,
            t2_target: null,
            confidence,
            exit_by: null,
            hold: 'EXPIRY_OR_BREAKDOWN',
            gap_pct: +((currentPrice - todayOpen) / todayOpen * 100).toFixed(2),
            volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
            spy_change_pct: +(spyChange * 100).toFixed(2),
            qqq_change_pct: +(qqqChange * 100).toFixed(2),
            level_defended_count: defended.count,
            dist_to_level_pct: +(distToResistance * 100).toFixed(2),
            trend: trendData.trend,
            trend_flags: [],
            note: `bear call above ${resistance.price.toFixed(2)} (${resistance.source}, defended ${defended.count}x) | dist ${(distToResistance * 100).toFixed(1)}%`,
          });
        }
      }
    }
  }

  // Cap at top 5 by confidence
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals.slice(0, 5);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the strongest support level near the current price.
 * Prioritizes: swing low > prev day low > VWAP > today's low
 */
function findBestSupport(price, prevDayLow, vwap, todayLow, dailyBars, atrDollar) {
  const candidates = [];

  // Prev day low — institutional reference level
  if (prevDayLow && prevDayLow > 0 && prevDayLow < price) {
    candidates.push({ price: prevDayLow, source: 'prev_day_low', weight: 3 });
  }

  // Multi-day swing lows — strongest structural support
  const swingLows = findSwingLows(dailyBars);
  for (const sl of swingLows.slice(-3)) { // last 3 swing lows
    if (sl.price > 0 && sl.price < price && Math.abs(price - sl.price) < atrDollar * 2) {
      candidates.push({ price: sl.price, source: 'swing_low', weight: 5 });
    }
  }

  // VWAP — dynamic institutional level (only if below price = support)
  if (vwap && vwap > 0 && vwap < price && (price - vwap) / price < 0.03) {
    candidates.push({ price: vwap, source: 'vwap', weight: 2 });
  }

  // Today's low — weaker but relevant
  if (todayLow && todayLow > 0 && todayLow < price && todayLow !== prevDayLow) {
    candidates.push({ price: todayLow, source: 'today_low', weight: 1 });
  }

  if (candidates.length === 0) return null;

  // Pick the strongest level closest to current price
  candidates.sort((a, b) => {
    // Prefer closer levels, weighted by strength
    const aDist = (price - a.price) / price;
    const bDist = (price - b.price) / price;
    return (aDist / a.weight) - (bDist / b.weight);
  });

  return candidates[0];
}

/**
 * Find the strongest resistance level near the current price.
 */
function findBestResistance(price, prevDayHigh, vwap, todayHigh, dailyBars, atrDollar) {
  const candidates = [];

  if (prevDayHigh && prevDayHigh > 0 && prevDayHigh > price) {
    candidates.push({ price: prevDayHigh, source: 'prev_day_high', weight: 3 });
  }

  const swingHighs = findSwingHighs(dailyBars);
  for (const sh of swingHighs.slice(-3)) {
    if (sh.price > 0 && sh.price > price && Math.abs(sh.price - price) < atrDollar * 2) {
      candidates.push({ price: sh.price, source: 'swing_high', weight: 5 });
    }
  }

  if (vwap && vwap > 0 && vwap > price && (vwap - price) / price < 0.03) {
    candidates.push({ price: vwap, source: 'vwap', weight: 2 });
  }

  if (todayHigh && todayHigh > 0 && todayHigh > price && todayHigh !== prevDayHigh) {
    candidates.push({ price: todayHigh, source: 'today_high', weight: 1 });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aDist = (a.price - price) / price;
    const bDist = (b.price - price) / price;
    return (aDist / a.weight) - (bDist / b.weight);
  });

  return candidates[0];
}

/**
 * Check if a price level has been defended by looking at intraday bar touches.
 * A level is "defended" if price approached it and reversed away.
 *
 * @param {Array} bars - intraday bars
 * @param {number} level - the price level to check
 * @param {number} atrDollar - ATR in dollar terms (proximity threshold)
 * @param {'support'|'resistance'} type
 * @returns {{ count: number, lastBounceIdx: number }}
 */
function isLevelDefended(bars, level, atrDollar, type) {
  const result = { count: 0, lastBounceIdx: -1 };
  if (!bars || bars.length < 5) return result;

  // Proximity zone: within 0.2 ATR of the level
  const zone = atrDollar * 0.2;

  let inZone = false;
  let zoneEntryIdx = -1;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    if (type === 'support') {
      // Price approached support from above
      const nearLevel = bar.l <= level + zone && bar.l >= level - zone;

      if (nearLevel && !inZone) {
        inZone = true;
        zoneEntryIdx = i;
      } else if (inZone && bar.c > level + zone) {
        // Bounced away from support — level defended
        result.count++;
        result.lastBounceIdx = i;
        inZone = false;
      } else if (inZone && bar.c < level - zone) {
        // Broke through — level failed (reset)
        inZone = false;
      }
    } else {
      // Price approached resistance from below
      const nearLevel = bar.h >= level - zone && bar.h <= level + zone;

      if (nearLevel && !inZone) {
        inZone = true;
        zoneEntryIdx = i;
      } else if (inZone && bar.c < level - zone) {
        // Rejected from resistance — level defended
        result.count++;
        result.lastBounceIdx = i;
        inZone = false;
      } else if (inZone && bar.c > level + zone) {
        // Broke through — level failed (reset)
        inZone = false;
      }
    }
  }

  return result;
}
