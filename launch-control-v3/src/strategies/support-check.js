/**
 * Trend Structure Analysis — Support & Resistance via Swing Points
 *
 * Instead of raw daily highs/lows, we detect actual swing points
 * (local extremes) and classify the trend:
 *
 *   Higher Highs + Higher Lows  → UPTREND   (bounce is buy-the-dip)
 *   Lower Highs  + Lower Lows  → DOWNTREND  (bounce is dead cat)
 *   Mixed                      → RANGE      (bounce is coin-flip)
 *
 * A CALL signal should only fire when:
 *   1. Price is near a swing low that's a HIGHER LOW (trend intact)
 *   2. Next swing high resistance is far enough to give the trade room
 *
 * A CALL signal should be blocked when:
 *   1. Swing lows are making LOWER LOWS (trend breaking down)
 *   2. Price is already at swing high resistance (upside capped)
 */

// ── Swing Point Detection ────────────────────────────────────────────────────

/**
 * Find swing lows from daily bars.
 * A swing low is a bar whose low is lower than both neighbors.
 * @param {Array} bars - [{ o, h, l, c, v, day }, ...] sorted by day asc
 * @returns {Array<{ day, price: number, index: number }>}
 */
export function findSwingLows(bars) {
  if (!bars || bars.length < 3) return [];
  const swings = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i].l < bars[i - 1].l && bars[i].l < bars[i + 1].l) {
      swings.push({ day: bars[i].day, price: bars[i].l, index: i });
    }
  }
  return swings;
}

/**
 * Find swing highs from daily bars.
 * A swing high is a bar whose high is higher than both neighbors.
 * @param {Array} bars - [{ o, h, l, c, v, day }, ...] sorted by day asc
 * @returns {Array<{ day, price: number, index: number }>}
 */
export function findSwingHighs(bars) {
  if (!bars || bars.length < 3) return [];
  const swings = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i].h > bars[i - 1].h && bars[i].h > bars[i + 1].h) {
      swings.push({ day: bars[i].day, price: bars[i].h, index: i });
    }
  }
  return swings;
}

// ── Trend Classification ─────────────────────────────────────────────────────

/**
 * Classify the trend from swing points.
 *
 * @param {Array} bars - daily bars sorted by day asc (need ~7-10 bars)
 * @returns {{
 *   trend: 'UPTREND'|'DOWNTREND'|'RANGE',
 *   swingLows: Array,
 *   swingHighs: Array,
 *   nearestSwingLow: number|null,
 *   nearestSwingHigh: number|null,
 *   confidence: number  // 0-1, how clean the trend is
 * }}
 */
export function classifyTrend(bars) {
  const empty = { trend: 'RANGE', swingLows: [], swingHighs: [], nearestSwingLow: null, nearestSwingHigh: null, confidence: 0 };
  if (!bars || bars.length < 5) return empty;

  const swingLows = findSwingLows(bars);
  const swingHighs = findSwingHighs(bars);

  // Need at least 2 swing points of each type to determine trend
  const hasLowTrend = swingLows.length >= 2;
  const hasHighTrend = swingHighs.length >= 2;

  let lowPattern = 'FLAT';  // HIGHER, LOWER, FLAT
  let highPattern = 'FLAT';

  if (hasLowTrend) {
    const last2Lows = swingLows.slice(-2);
    if (last2Lows[1].price > last2Lows[0].price) lowPattern = 'HIGHER';
    else if (last2Lows[1].price < last2Lows[0].price) lowPattern = 'LOWER';
  }

  if (hasHighTrend) {
    const last2Highs = swingHighs.slice(-2);
    if (last2Highs[1].price > last2Highs[0].price) highPattern = 'HIGHER';
    else if (last2Highs[1].price < last2Highs[0].price) highPattern = 'LOWER';
  }

  // Classify
  let trend = 'RANGE';
  let confidence = 0;

  if (lowPattern === 'HIGHER' && highPattern === 'HIGHER') {
    trend = 'UPTREND';
    confidence = 0.9;
  } else if (lowPattern === 'HIGHER' && highPattern === 'FLAT') {
    trend = 'UPTREND';
    confidence = 0.6;
  } else if (lowPattern === 'LOWER' && highPattern === 'LOWER') {
    trend = 'DOWNTREND';
    confidence = 0.9;
  } else if (lowPattern === 'LOWER' && highPattern === 'FLAT') {
    trend = 'DOWNTREND';
    confidence = 0.6;
  } else if (lowPattern === 'FLAT' && highPattern === 'LOWER') {
    trend = 'DOWNTREND';
    confidence = 0.5;
  } else if (lowPattern === 'FLAT' && highPattern === 'HIGHER') {
    trend = 'UPTREND';
    confidence = 0.5;
  } else {
    // Mixed (e.g. higher lows + lower highs = converging/range)
    trend = 'RANGE';
    confidence = 0.3;
  }

  // Nearest swing levels (most recent)
  const nearestSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : null;
  const nearestSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : null;

  return { trend, swingLows, swingHighs, nearestSwingLow, nearestSwingHigh, confidence };
}

// ── Signal Flagging ──────────────────────────────────────────────────────────

/**
 * Analyze trend structure for a bounce signal. Never blocks — returns
 * flags so the signal carries its own risk context.
 *
 * Flags (array of strings, empty = clean setup):
 *   'downtrend'         — lower lows + lower highs, likely dead cat
 *   'not_near_support'  — price isn't near a swing low or intraday low
 *   'resistance_capped' — nearest resistance <0.5% above, upside limited
 *
 * @param {number} price - current price
 * @param {Array} dailyBars - daily OHLCV bars for this ticker
 * @param {Object} intraday - { todayLow, todayHigh, todayOpen } current session data
 * @param {'intraday'|'overnight'|'multiday'} horizon
 * @returns {{
 *   flags: string[],
 *   trend: string,
 *   nearestSupport: number|null,
 *   nearestResistance: number|null,
 *   resistanceRoom: number|null,
 *   trendConfidence: number
 * }}
 */
export function checkBounceStructure(price, dailyBars, intraday = {}, horizon = 'intraday') {
  const result = {
    flags: [],
    trend: 'UNKNOWN',
    nearestSupport: null,
    nearestResistance: null,
    resistanceRoom: null,
    trendConfidence: 0,
  };

  if (!price || price <= 0) return result;

  const trendData = classifyTrend(dailyBars);
  const { trend, nearestSwingLow, nearestSwingHigh, confidence: trendConfidence } = trendData;
  result.trend = trend;
  result.trendConfidence = trendConfidence;

  // ── Flag: confirmed downtrend (lower lows + lower highs) ───────────────
  if (trend === 'DOWNTREND' && trendConfidence >= 0.7) {
    result.flags.push('downtrend');
  }

  // ── Support proximity check ────────────────────────────────────────────
  const supportLevels = [];
  if (intraday.todayLow > 0) supportLevels.push(intraday.todayLow);
  if (nearestSwingLow) supportLevels.push(nearestSwingLow);
  if ((horizon === 'overnight' || horizon === 'multiday') && intraday.todayOpen > 0) {
    supportLevels.push(intraday.todayOpen);
  }

  let nearestSupportDist = Infinity;
  for (const lvl of supportLevels) {
    const dist = (price - lvl) / lvl;
    if (dist >= -0.005 && dist < nearestSupportDist) {
      nearestSupportDist = dist;
      result.nearestSupport = lvl;
    }
  }

  const supportThreshold = horizon === 'intraday' ? 0.008 : horizon === 'overnight' ? 0.010 : 0.012;
  if (result.nearestSupport === null || nearestSupportDist > supportThreshold) {
    result.flags.push('not_near_support');
  }

  // ── Resistance room check ──────────────────────────────────────────────
  const resistanceLevels = [];
  if (intraday.todayHigh > 0 && intraday.todayHigh > price) resistanceLevels.push(intraday.todayHigh);
  if (nearestSwingHigh && nearestSwingHigh > price) resistanceLevels.push(nearestSwingHigh);

  for (const lvl of resistanceLevels) {
    const room = (lvl - price) / price;
    if (result.nearestResistance === null || lvl < result.nearestResistance) {
      result.nearestResistance = lvl;
      result.resistanceRoom = +(room * 100).toFixed(2);
    }
  }

  if (result.nearestResistance && result.resistanceRoom < 0.5) {
    result.flags.push('resistance_capped');
  }

  return result;
}
