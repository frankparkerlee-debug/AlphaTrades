/**
 * Trend Structure Analysis — Support & Resistance via Swing Points + VWAP
 *
 * Instead of raw daily highs/lows, we detect actual swing points
 * (local extremes) and classify the trend:
 *
 *   Higher Highs + Higher Lows  → UPTREND   (bounce is buy-the-dip)
 *   Lower Highs  + Lower Lows  → DOWNTREND  (bounce is dead cat)
 *   Mixed                      → RANGE      (bounce is coin-flip)
 *
 * VWAP is used as a dynamic intraday support/resistance level.
 * Flush+Hold detection checks if price has stabilized after a drop.
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

// ── Flush + Hold Detection ───────────────────────────────────────────────────

/**
 * Detect if price has stabilized after a drop (flush+hold pattern).
 * For 0DTE: confirms the selling has stopped before entering.
 *
 * Checks last N intraday bars for:
 *   1. No new low in last 2-3 bars (floor found)
 *   2. Bar ranges tightening (volatility contracting)
 *   3. Bars closing in upper half (buyers stepping in at lows)
 *
 * @param {Array} bars - intraday 1-min bars [{o,h,l,c,v,t}] from state.js (last 20)
 * @param {string} direction - 'CALL' or 'PUT'
 * @returns {{ stabilized: boolean, barsHeld: number, rangeContracting: boolean, closingStrong: boolean }}
 */
export function detectFlushAndHold(bars, direction = 'CALL') {
  const result = { stabilized: false, barsHeld: 0, rangeContracting: false, closingStrong: false };
  if (!bars || bars.length < 5) return result;

  const recent = bars.slice(-10); // analyze last 10 bars
  if (recent.length < 5) return result;

  if (direction === 'CALL') {
    // Find the low point in the recent window
    let lowestIdx = 0;
    let lowestPrice = recent[0].l;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].l < lowestPrice) {
        lowestPrice = recent[i].l;
        lowestIdx = i;
      }
    }

    // Need at least 3 bars AFTER the low to confirm hold
    const barsAfterLow = recent.length - 1 - lowestIdx;
    if (barsAfterLow < 3) return result;

    // Check 1: No new low in bars after the low bar
    const holdBars = recent.slice(lowestIdx + 1);
    let newLowCount = 0;
    for (const bar of holdBars) {
      if (bar.l < lowestPrice) newLowCount++;
    }
    if (newLowCount > 0) return result; // still making new lows

    result.barsHeld = holdBars.length;

    // Check 2: Bar ranges tightening (last 3 bars vs low bar range)
    const lowBarRange = recent[lowestIdx].h - recent[lowestIdx].l;
    if (lowBarRange > 0) {
      const last3 = holdBars.slice(-3);
      const avgRecentRange = last3.reduce((sum, b) => sum + (b.h - b.l), 0) / last3.length;
      result.rangeContracting = avgRecentRange < lowBarRange * 0.7;
    }

    // Check 3: Bars closing in upper half of their range
    const last3 = holdBars.slice(-3);
    let upperCloseCount = 0;
    for (const bar of last3) {
      const range = bar.h - bar.l;
      if (range > 0 && (bar.c - bar.l) / range > 0.5) upperCloseCount++;
    }
    result.closingStrong = upperCloseCount >= 2;

    // Stabilized = held the low for 3+ bars
    // Stronger confirmation if ranges contracting AND closing strong
    result.stabilized = result.barsHeld >= 3;

  } else {
    // PUT direction: flush UP then hold (sellers stepping in at highs)
    let highestIdx = 0;
    let highestPrice = recent[0].h;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].h > highestPrice) {
        highestPrice = recent[i].h;
        highestIdx = i;
      }
    }

    const barsAfterHigh = recent.length - 1 - highestIdx;
    if (barsAfterHigh < 3) return result;

    const holdBars = recent.slice(highestIdx + 1);
    let newHighCount = 0;
    for (const bar of holdBars) {
      if (bar.h > highestPrice) newHighCount++;
    }
    if (newHighCount > 0) return result;

    result.barsHeld = holdBars.length;

    const highBarRange = recent[highestIdx].h - recent[highestIdx].l;
    if (highBarRange > 0) {
      const last3 = holdBars.slice(-3);
      const avgRecentRange = last3.reduce((sum, b) => sum + (b.h - b.l), 0) / last3.length;
      result.rangeContracting = avgRecentRange < highBarRange * 0.7;
    }

    const last3 = holdBars.slice(-3);
    let lowerCloseCount = 0;
    for (const bar of last3) {
      const range = bar.h - bar.l;
      if (range > 0 && (bar.h - bar.c) / range > 0.5) lowerCloseCount++;
    }
    result.closingStrong = lowerCloseCount >= 2;
    result.stabilized = result.barsHeld >= 3;
  }

  return result;
}

// ── Signal Flagging ──────────────────────────────────────────────────────────

/**
 * Analyze trend structure for a bounce signal. Never blocks — returns
 * flags so the signal carries its own risk context.
 *
 * Flags (array of strings, empty = clean setup):
 *   'downtrend'         — lower lows + lower highs, likely dead cat
 *   'not_near_support'  — price isn't near a swing low, intraday low, or VWAP
 *   'resistance_capped' — nearest resistance <0.5% above, upside limited
 *   'vwap_resistance'   — VWAP is close overhead, bounce may stall
 *   'no_stabilization'  — price hasn't held a level after the drop (still falling)
 *
 * @param {number} price - current price
 * @param {Array} dailyBars - daily OHLCV bars for this ticker
 * @param {Object} intraday - { todayLow, todayHigh, todayOpen, vwap, intradayBars } current session data
 * @param {'intraday'|'overnight'|'multiday'} horizon
 * @returns {{
 *   flags: string[],
 *   trend: string,
 *   nearestSupport: number|null,
 *   nearestResistance: number|null,
 *   resistanceRoom: number|null,
 *   trendConfidence: number,
 *   vwapSupport: boolean,
 *   stabilization: { stabilized: boolean, barsHeld: number, rangeContracting: boolean, closingStrong: boolean }
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
    vwapSupport: false,
    stabilization: { stabilized: false, barsHeld: 0, rangeContracting: false, closingStrong: false },
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

  // ── VWAP as dynamic intraday level ────────────────────────────────────
  const vwap = intraday.vwap;
  const vwapProximity = vwap > 0 ? (price - vwap) / vwap : null;

  // ── Support proximity check ────────────────────────────────────────────
  const supportLevels = [];
  if (intraday.todayLow > 0) supportLevels.push(intraday.todayLow);
  if (nearestSwingLow) supportLevels.push(nearestSwingLow);
  if ((horizon === 'overnight' || horizon === 'multiday') && intraday.todayOpen > 0) {
    supportLevels.push(intraday.todayOpen);
  }

  // VWAP as support: price within 0.3% of VWAP from above, or just reclaimed it
  if (vwap > 0 && vwapProximity !== null) {
    if (vwapProximity >= -0.003 && vwapProximity <= 0.003) {
      // Price is AT VWAP — strong institutional support for intraday
      supportLevels.push(vwap);
      result.vwapSupport = true;
    } else if (vwapProximity > 0.003 && vwapProximity <= 0.008) {
      // Price just reclaimed VWAP and holding above — bullish
      supportLevels.push(vwap);
      result.vwapSupport = true;
    }
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

  // VWAP as resistance: price below VWAP and VWAP is close overhead
  if (vwap > 0 && vwapProximity !== null && vwapProximity < -0.001 && vwapProximity > -0.008) {
    // Price is just below VWAP — it acts as resistance
    resistanceLevels.push(vwap);
  }

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

  // VWAP-specific resistance flag: price below VWAP with VWAP close overhead
  if (vwap > 0 && vwapProximity !== null && vwapProximity < -0.001 && vwapProximity > -0.005) {
    result.flags.push('vwap_resistance');
  }

  // ── Flush + Hold detection ─────────────────────────────────────────────
  const intradayBars = intraday.intradayBars;
  if (intradayBars && intradayBars.length >= 5) {
    const direction = horizon === 'intraday' ? 'CALL' : 'CALL'; // bounce plays are CALL
    result.stabilization = detectFlushAndHold(intradayBars, direction);
    if (!result.stabilization.stabilized) {
      result.flags.push('no_stabilization');
    }
  }

  return result;
}
