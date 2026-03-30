/**
 * Candle Pattern Detection
 *
 * Detects actionable single-candle and multi-candle patterns
 * from bar arrays [{o, h, l, c, v}].
 *
 * Each pattern returns a confidence score (0-100) indicating
 * pattern quality. Higher = more textbook.
 */

// ── Single Candle Patterns ───────────────────────────────────────────────────

/**
 * Analyze a single bar for pattern characteristics.
 * @param {{o,h,l,c,v}} bar
 * @returns {object} pattern characteristics
 */
export function analyzeCandle(bar) {
  if (!bar || bar.h === bar.l) return { type: 'DOJI', bodyRatio: 0, quality: 0 };

  const range = bar.h - bar.l;
  const body = Math.abs(bar.c - bar.o);
  const bodyRatio = range > 0 ? body / range : 0;
  const upperWick = bar.h - Math.max(bar.o, bar.c);
  const lowerWick = Math.min(bar.o, bar.c) - bar.l;
  const upperWickRatio = range > 0 ? upperWick / range : 0;
  const lowerWickRatio = range > 0 ? lowerWick / range : 0;
  const bullish = bar.c > bar.o;
  const bearish = bar.c < bar.o;

  let type = 'INDECISIVE';
  let quality = 0;

  // Doji: body < 10% of range
  if (bodyRatio < 0.10) {
    type = 'DOJI';
    quality = Math.round((1 - bodyRatio) * 50); // smaller body = cleaner doji
  }
  // Hammer: small body at top, long lower wick (>= 2x body)
  else if (lowerWick >= body * 2 && upperWickRatio < 0.15 && bodyRatio < 0.35) {
    type = 'HAMMER';
    quality = Math.round(Math.min(100, (lowerWick / body) * 25));
  }
  // Inverted Hammer: small body at bottom, long upper wick
  else if (upperWick >= body * 2 && lowerWickRatio < 0.15 && bodyRatio < 0.35) {
    type = 'INVERTED_HAMMER';
    quality = Math.round(Math.min(100, (upperWick / body) * 25));
  }
  // Shooting Star: like inverted hammer but at top of move (context-dependent)
  // We classify it here, context checked by caller
  else if (upperWick >= body * 2 && lowerWickRatio < 0.15 && bearish) {
    type = 'SHOOTING_STAR';
    quality = Math.round(Math.min(100, (upperWick / body) * 25));
  }
  // Marubozu: strong body, minimal wicks (>= 85% body)
  else if (bodyRatio >= 0.85) {
    type = bullish ? 'BULLISH_MARUBOZU' : 'BEARISH_MARUBOZU';
    quality = Math.round(bodyRatio * 100);
  }
  // Strong candle: body >= 65% of range
  else if (bodyRatio >= 0.65) {
    type = bullish ? 'STRONG_BULLISH' : 'STRONG_BEARISH';
    quality = Math.round(bodyRatio * 80);
  }
  // Weak candle: lots of wicks
  else {
    type = bullish ? 'WEAK_BULLISH' : 'WEAK_BEARISH';
    quality = Math.round(bodyRatio * 50);
  }

  return {
    type,
    quality,
    bullish,
    bearish,
    bodyRatio: parseFloat(bodyRatio.toFixed(3)),
    upperWickRatio: parseFloat(upperWickRatio.toFixed(3)),
    lowerWickRatio: parseFloat(lowerWickRatio.toFixed(3)),
    range,
    body,
  };
}

// ── Multi-Candle Patterns ────────────────────────────────────────────────────

/**
 * Detect bullish engulfing pattern (current green candle engulfs prior red candle).
 * @param {{o,h,l,c}[]} bars - last 2+ bars
 * @returns {{ detected: boolean, quality: number }}
 */
export function detectBullishEngulfing(bars) {
  if (!bars || bars.length < 2) return { detected: false, quality: 0 };
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const prevBearish = prev.c < prev.o;
  const currBullish = curr.c > curr.o;
  const engulfs = curr.o <= prev.c && curr.c >= prev.o;

  if (!prevBearish || !currBullish || !engulfs) return { detected: false, quality: 0 };

  // Quality: how much bigger is the current body vs prior?
  const prevBody = Math.abs(prev.c - prev.o);
  const currBody = Math.abs(curr.c - curr.o);
  const ratio = prevBody > 0 ? currBody / prevBody : 2;
  const quality = Math.round(Math.min(100, ratio * 40 + 20));

  return { detected: true, quality };
}

/**
 * Detect bearish engulfing pattern.
 * @param {{o,h,l,c}[]} bars - last 2+ bars
 * @returns {{ detected: boolean, quality: number }}
 */
export function detectBearishEngulfing(bars) {
  if (!bars || bars.length < 2) return { detected: false, quality: 0 };
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const prevBullish = prev.c > prev.o;
  const currBearish = curr.c < curr.o;
  const engulfs = curr.o >= prev.c && curr.c <= prev.o;

  if (!prevBullish || !currBearish || !engulfs) return { detected: false, quality: 0 };

  const prevBody = Math.abs(prev.c - prev.o);
  const currBody = Math.abs(curr.c - curr.o);
  const ratio = prevBody > 0 ? currBody / prevBody : 2;
  const quality = Math.round(Math.min(100, ratio * 40 + 20));

  return { detected: true, quality };
}

/**
 * Detect morning star pattern (3-bar bullish reversal).
 * Bar 1: strong bearish, Bar 2: small body (indecision), Bar 3: strong bullish
 * @param {{o,h,l,c}[]} bars - last 3+ bars
 * @returns {{ detected: boolean, quality: number }}
 */
export function detectMorningStar(bars) {
  if (!bars || bars.length < 3) return { detected: false, quality: 0 };
  const b1 = bars[bars.length - 3];
  const b2 = bars[bars.length - 2];
  const b3 = bars[bars.length - 1];

  const b1Range = b1.h - b1.l;
  const b2Range = b2.h - b2.l;
  const b3Range = b3.h - b3.l;

  const b1Bearish = b1.c < b1.o;
  const b1BodyRatio = b1Range > 0 ? Math.abs(b1.c - b1.o) / b1Range : 0;
  const b2SmallBody = b2Range > 0 ? Math.abs(b2.c - b2.o) / b2Range < 0.35 : false;
  const b3Bullish = b3.c > b3.o;
  const b3BodyRatio = b3Range > 0 ? Math.abs(b3.c - b3.o) / b3Range : 0;

  // Bar 1 must be strong bearish, bar 2 small, bar 3 strong bullish
  if (!b1Bearish || b1BodyRatio < 0.5) return { detected: false, quality: 0 };
  if (!b2SmallBody) return { detected: false, quality: 0 };
  if (!b3Bullish || b3BodyRatio < 0.5) return { detected: false, quality: 0 };

  // Bar 3 should close above midpoint of bar 1
  const b1Mid = (b1.o + b1.c) / 2;
  if (b3.c < b1Mid) return { detected: false, quality: 0 };

  const quality = Math.round(Math.min(100, (b1BodyRatio + b3BodyRatio) * 50));
  return { detected: true, quality };
}

/**
 * Detect evening star pattern (3-bar bearish reversal).
 * @param {{o,h,l,c}[]} bars - last 3+ bars
 * @returns {{ detected: boolean, quality: number }}
 */
export function detectEveningStar(bars) {
  if (!bars || bars.length < 3) return { detected: false, quality: 0 };
  const b1 = bars[bars.length - 3];
  const b2 = bars[bars.length - 2];
  const b3 = bars[bars.length - 1];

  const b1Range = b1.h - b1.l;
  const b2Range = b2.h - b2.l;
  const b3Range = b3.h - b3.l;

  const b1Bullish = b1.c > b1.o;
  const b1BodyRatio = b1Range > 0 ? Math.abs(b1.c - b1.o) / b1Range : 0;
  const b2SmallBody = b2Range > 0 ? Math.abs(b2.c - b2.o) / b2Range < 0.35 : false;
  const b3Bearish = b3.c < b3.o;
  const b3BodyRatio = b3Range > 0 ? Math.abs(b3.c - b3.o) / b3Range : 0;

  if (!b1Bullish || b1BodyRatio < 0.5) return { detected: false, quality: 0 };
  if (!b2SmallBody) return { detected: false, quality: 0 };
  if (!b3Bearish || b3BodyRatio < 0.5) return { detected: false, quality: 0 };

  const b1Mid = (b1.o + b1.c) / 2;
  if (b3.c > b1Mid) return { detected: false, quality: 0 };

  const quality = Math.round(Math.min(100, (b1BodyRatio + b3BodyRatio) * 50));
  return { detected: true, quality };
}

/**
 * Detect consecutive green/red bars (trend confirmation).
 * @param {{o,h,l,c}[]} bars
 * @param {number} count - minimum consecutive bars (default 3)
 * @returns {{ bullishStreak: number, bearishStreak: number, confirming: string|null }}
 */
export function detectConsecutive(bars, count = 3) {
  if (!bars || bars.length < count) return { bullishStreak: 0, bearishStreak: 0, confirming: null };

  let bullStreak = 0;
  let bearStreak = 0;

  // Count from end
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].c > bars[i].o) {
      if (bearStreak > 0) break;
      bullStreak++;
    } else if (bars[i].c < bars[i].o) {
      if (bullStreak > 0) break;
      bearStreak++;
    } else {
      break; // doji breaks the streak
    }
  }

  let confirming = null;
  if (bullStreak >= count) confirming = 'BULLISH';
  if (bearStreak >= count) confirming = 'BEARISH';

  return { bullishStreak: bullStreak, bearishStreak: bearStreak, confirming };
}

// ── Higher-Level Pattern Analysis ────────────────────────────────────────────

/**
 * Comprehensive candle pattern scan for the last few bars.
 * Returns all detected patterns with quality scores.
 *
 * @param {{o,h,l,c,v}[]} bars - last 5-10 bars minimum
 * @returns {object} all detected patterns
 */
export function scanCandlePatterns(bars) {
  if (!bars || bars.length < 3) {
    return { patterns: [], strongestBullish: null, strongestBearish: null, confluenceCount: 0 };
  }

  const patterns = [];
  const latest = analyzeCandle(bars[bars.length - 1]);

  // Single candle patterns on latest bar
  if (latest.type === 'HAMMER') {
    patterns.push({ name: 'HAMMER', direction: 'BULLISH', quality: latest.quality });
  }
  if (latest.type === 'SHOOTING_STAR' || latest.type === 'INVERTED_HAMMER') {
    patterns.push({ name: latest.type, direction: 'BEARISH', quality: latest.quality });
  }
  if (latest.type === 'BULLISH_MARUBOZU' || latest.type === 'STRONG_BULLISH') {
    patterns.push({ name: latest.type, direction: 'BULLISH', quality: latest.quality });
  }
  if (latest.type === 'BEARISH_MARUBOZU' || latest.type === 'STRONG_BEARISH') {
    patterns.push({ name: latest.type, direction: 'BEARISH', quality: latest.quality });
  }
  if (latest.type === 'DOJI') {
    patterns.push({ name: 'DOJI', direction: 'NEUTRAL', quality: latest.quality });
  }

  // Multi-candle patterns
  const bullEngulf = detectBullishEngulfing(bars);
  if (bullEngulf.detected) {
    patterns.push({ name: 'BULLISH_ENGULFING', direction: 'BULLISH', quality: bullEngulf.quality });
  }

  const bearEngulf = detectBearishEngulfing(bars);
  if (bearEngulf.detected) {
    patterns.push({ name: 'BEARISH_ENGULFING', direction: 'BEARISH', quality: bearEngulf.quality });
  }

  const morningStar = detectMorningStar(bars);
  if (morningStar.detected) {
    patterns.push({ name: 'MORNING_STAR', direction: 'BULLISH', quality: morningStar.quality });
  }

  const eveningStar = detectEveningStar(bars);
  if (eveningStar.detected) {
    patterns.push({ name: 'EVENING_STAR', direction: 'BEARISH', quality: eveningStar.quality });
  }

  const consecutive = detectConsecutive(bars);
  if (consecutive.confirming === 'BULLISH') {
    patterns.push({ name: `CONSECUTIVE_GREEN_${consecutive.bullishStreak}`, direction: 'BULLISH', quality: Math.min(90, consecutive.bullishStreak * 20) });
  }
  if (consecutive.confirming === 'BEARISH') {
    patterns.push({ name: `CONSECUTIVE_RED_${consecutive.bearishStreak}`, direction: 'BEARISH', quality: Math.min(90, consecutive.bearishStreak * 20) });
  }

  // Find strongest per direction
  const bullish = patterns.filter(p => p.direction === 'BULLISH').sort((a, b) => b.quality - a.quality);
  const bearish = patterns.filter(p => p.direction === 'BEARISH').sort((a, b) => b.quality - a.quality);

  return {
    patterns,
    latestCandle: latest,
    strongestBullish: bullish[0] || null,
    strongestBearish: bearish[0] || null,
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    confluenceCount: patterns.length,
  };
}
