/**
 * Compound Scalp Detector — High-frequency directional push detection
 *
 * Separate from the 18 structural patterns (pattern-detector.js).
 * Structural patterns = income layer (1-2/day, 10%+ targets, 60-80% WR).
 * This = compounding layer (3-5/day, 2-3% targets, quick in/out).
 *
 * 4 sub-detectors:
 *   1. ORB Breakout — trade the opening range breakout
 *   2. Trend Pullback — EMA9 bounce in an active trend
 *   3. Momentum Continuation — ride a strong impulse bar
 *   4. VWAP Reclaim/Rejection — conviction cross of VWAP
 *
 * Entry: detectCompoundSignals(ticker, bars, ctx) → CompoundSignal[]
 */

import { emaSeries } from '../indicators/technical.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function avgRange(bars) {
  if (!bars.length) return 0;
  return bars.reduce((s, b) => s + (b.h - b.l), 0) / bars.length;
}

function avgVolume(bars) {
  if (!bars.length) return 0;
  return bars.reduce((s, b) => s + (b.v || 0), 0) / bars.length;
}

function computeVWAP(bars) {
  let cumVol = 0, cumPV = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    const v = b.v || 0;
    cumVol += v;
    cumPV += tp * v;
  }
  return cumVol > 0 ? cumPV / cumVol : bars[bars.length - 1]?.c || 0;
}

function bodyRatio(bar) {
  const range = bar.h - bar.l;
  if (range <= 0) return 0;
  return Math.abs(bar.c - bar.o) / range;
}

function clamp(c) {
  return Math.max(50, Math.min(95, Math.round(c)));
}

function makeSignal(pattern, direction, confidence, bar, meta) {
  return {
    pattern,
    category: 'COMPOUND',
    direction,
    confidence: clamp(confidence),
    entry: bar.c,
    triggerBar: { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v },
    timestamp: new Date().toISOString(),
    metadata: meta || {},
  };
}

// ── 1. ORB Breakout ─────────────────────────────────────────────────────────
//
// After the opening range (first 5 bars) is set, trade the breakout of
// OR high or low. Most reliable directional signal of the day.
//
// Requirements:
//   - Fires after bar 5, before bar 30 (first 30 min of session)
//   - Price closes beyond OR boundary by at least 0.02%
//   - Volume on breakout bar > 1.3x avg of last 10 bars
//   - Body ratio > 0.5 (clean close, not a wick)
//   - OR width between 0.05% and 0.40% of price

function detectORBBreakout(ticker, bars, ctx) {
  const barsFromOpen = ctx.barsFromOpen || bars.length;
  if (barsFromOpen < 6 || barsFromOpen > 30) return null;
  if (!ctx.orHigh || !ctx.orLow) return null;

  const curr = bars[bars.length - 1];
  const price = curr.c;
  const orWidth = (ctx.orHigh - ctx.orLow) / price;

  if (orWidth < 0.0005 || orWidth > 0.004) return null;

  const recent10 = bars.slice(-10);
  const avgVol = avgVolume(recent10);
  const br = bodyRatio(curr);

  if (br < 0.5) return null;
  if ((curr.v || 0) < avgVol * 1.3) return null;

  // Bullish breakout
  if (price > ctx.orHigh * 1.0002 && curr.c > curr.o) {
    let conf = 70;
    if ((curr.v || 0) > avgVol * 2) conf += 10;
    if (orWidth >= 0.001 && orWidth <= 0.002) conf += 5; // sweet spot
    if (bars.length >= 2 && bars[bars.length - 2].c > bars[bars.length - 2].o) conf += 5; // prev bar also bullish
    if (ctx.ema9Slope > 0) conf += 5;
    return makeSignal('ORB_BREAKOUT', 'CALL', conf, curr, {
      orHigh: ctx.orHigh, orLow: ctx.orLow, orWidth: +(orWidth * 100).toFixed(3),
      breakDist: +((price - ctx.orHigh) / price * 100).toFixed(4),
    });
  }

  // Bearish breakout
  if (price < ctx.orLow * 0.9998 && curr.c < curr.o) {
    let conf = 70;
    if ((curr.v || 0) > avgVol * 2) conf += 10;
    if (orWidth >= 0.001 && orWidth <= 0.002) conf += 5;
    if (bars.length >= 2 && bars[bars.length - 2].c < bars[bars.length - 2].o) conf += 5;
    if (ctx.ema9Slope < 0) conf += 5;
    return makeSignal('ORB_BREAKOUT', 'PUT', conf, curr, {
      orHigh: ctx.orHigh, orLow: ctx.orLow, orWidth: +(orWidth * 100).toFixed(3),
      breakDist: +((ctx.orLow - price) / price * 100).toFixed(4),
    });
  }

  return null;
}

// ── 2. Trend Pullback ───────────────────────────────────────────────────────
//
// When price is trending (EMA9 slope positive/negative), enter on a
// pullback to EMA9 that holds and bounces. This is the bread-and-butter
// scalp entry — ride the trend between pullbacks.
//
// Requirements:
//   - EMA9 slope > 0.02% over last 5 bars (confirmed trend)
//   - Current bar low touched or dipped below EMA9 (pullback)
//   - Current bar closes ABOVE EMA9 (held the level)
//   - Current bar is in the trend direction (bullish for uptrend)

function detectTrendPullback(ticker, bars, ctx) {
  if (bars.length < 20) return null;
  const curr = bars[bars.length - 1];
  const price = curr.c;

  // Require clean bar
  const br = bodyRatio(curr);
  if (br < 0.5) return null;

  // Compute EMA9 series
  const closes = bars.map(b => b.c);
  const ema9Arr = emaSeries(closes, 9);
  if (!ema9Arr || ema9Arr.length < 15) return null;

  const ema9Now = ema9Arr[ema9Arr.length - 1];
  const ema9_5ago = ema9Arr[ema9Arr.length - 6];
  if (!ema9Now || !ema9_5ago || ema9_5ago <= 0) return null;

  const slope = (ema9Now - ema9_5ago) / ema9_5ago;
  const avgVol = avgVolume(bars.slice(-15, -1));

  // Require volume confirmation on bounce bar
  if ((curr.v || 0) < avgVol * 1.2) return null;

  // Count trend-direction bars in last 7 (excluding current) — need majority
  let bullBars = 0, bearBars = 0;
  for (let i = bars.length - 8; i < bars.length - 1; i++) {
    if (i >= 0) {
      if (bars[i].c > bars[i].o) bullBars++;
      else if (bars[i].c < bars[i].o) bearBars++;
    }
  }

  // Bullish pullback — stronger slope requirement
  if (slope > 0.0005 && bullBars >= 4) { // 0.05% over 5 bars + majority bullish
    // Bar must dip INTO or BELOW EMA9 (real pullback, not just hovering near)
    if (curr.l <= ema9Now && curr.c > ema9Now && curr.c > curr.o) {
      // Don't chase at session high
      if (ctx.sessionHigh && (ctx.sessionHigh - price) / price < 0.001) return null;

      let conf = 72;
      if ((curr.v || 0) > avgVol * 2) conf += 10;
      if (br > 0.7) conf += 5;
      if (ctx.vwap && price > ctx.vwap) conf += 5; // above VWAP = bullish bias
      if (bullBars >= 5) conf += 5; // strong trend quality
      if (slope > 0.001) conf += 5; // strong slope

      return makeSignal('TREND_PULLBACK', 'CALL', conf, curr, {
        ema9: +ema9Now.toFixed(2), slope: +(slope * 10000).toFixed(2),
        trendBars: bullBars,
      });
    }
  }

  // Bearish pullback — stronger slope requirement
  if (slope < -0.0005 && bearBars >= 4) {
    if (curr.h >= ema9Now && curr.c < ema9Now && curr.c < curr.o) {
      if (ctx.sessionLow && (price - ctx.sessionLow) / price < 0.001) return null;

      let conf = 72;
      if ((curr.v || 0) > avgVol * 2) conf += 10;
      if (br > 0.7) conf += 5;
      if (ctx.vwap && price < ctx.vwap) conf += 5;
      if (bearBars >= 5) conf += 5;
      if (slope < -0.001) conf += 5;

      return makeSignal('TREND_PULLBACK', 'PUT', conf, curr, {
        ema9: +ema9Now.toFixed(2), slope: +(slope * 10000).toFixed(2),
        trendBars: bearBars,
      });
    }
  }

  return null;
}

// ── 3. Momentum Continuation ────────────────────────────────────────────────
//
// A strong impulse bar (range > 1.5x avg, body > 70%) just happened.
// The next bar opens near the impulse close and continues. Ride it.
//
// Requirements:
//   - bars[-2] is the impulse: range > 1.5x avgRange, body > 70%
//   - bars[-1] (current) opens within top/bottom 30% of impulse range
//   - Current bar continues in the impulse direction

function detectMomentumCont(ticker, bars, ctx) {
  if (bars.length < 12) return null;
  const impulse = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const avgR = avgRange(bars.slice(-20, -2));
  if (avgR <= 0) return null;

  const impulseRange = impulse.h - impulse.l;
  const impBR = bodyRatio(impulse);

  if (impulseRange < avgR * 1.5) return null;
  if (impBR < 0.70) return null;

  const avgVol = avgVolume(bars.slice(-15, -2));

  // Bullish impulse + continuation
  if (impulse.c > impulse.o) {
    // Current bar opens in top 30% of impulse range
    const threshold30 = impulse.l + impulseRange * 0.7;
    if (curr.o >= threshold30 && curr.c > impulse.c) {
      let conf = 68;
      if ((impulse.v || 0) > avgVol * 2) conf += 10;
      if (impulseRange > avgR * 2) conf += 5;
      if (ctx.ema9Slope > 0) conf += 5;
      if (curr.c > curr.o) conf += 5; // continuation bar is also bullish

      return makeSignal('MOMENTUM_CONT', 'CALL', conf, curr, {
        impulseRange: +impulseRange.toFixed(3),
        impulsePct: +((impulse.c - impulse.o) / impulse.o * 100).toFixed(4),
        avgRange: +avgR.toFixed(3),
      });
    }
  }

  // Bearish impulse + continuation
  if (impulse.c < impulse.o) {
    const threshold30 = impulse.h - impulseRange * 0.7;
    if (curr.o <= threshold30 && curr.c < impulse.c) {
      let conf = 68;
      if ((impulse.v || 0) > avgVol * 2) conf += 10;
      if (impulseRange > avgR * 2) conf += 5;
      if (ctx.ema9Slope < 0) conf += 5;
      if (curr.c < curr.o) conf += 5;

      return makeSignal('MOMENTUM_CONT', 'PUT', conf, curr, {
        impulseRange: +impulseRange.toFixed(3),
        impulsePct: +((impulse.o - impulse.c) / impulse.o * 100).toFixed(4),
        avgRange: +avgR.toFixed(3),
      });
    }
  }

  return null;
}

// ── 4. VWAP Reclaim / Rejection ─────────────────────────────────────────────
//
// VWAP is the institutional anchor. When price crosses VWAP with conviction,
// it signals a shift in control. Two modes:
//   Reclaim: was below, crosses above → CALL
//   Rejection: approached from below, failed → PUT (and vice versa)
//
// Requirements:
//   - bars[-3] was on one side of VWAP
//   - bars[-1] is on the other side (or rejected)
//   - Volume > 1.2x avg on the cross bar
//   - Body > 0.5

function detectVWAPReclaim(ticker, bars, ctx) {
  if (bars.length < 15 || !ctx.vwap) return null;
  const curr = bars[bars.length - 1];
  const prev1 = bars[bars.length - 2];
  const prev2 = bars[bars.length - 3];

  const vwap = ctx.vwap;
  const avgVol = avgVolume(bars.slice(-15, -1));
  const br = bodyRatio(curr);

  if (br < 0.5) return null;
  if ((curr.v || 0) < avgVol * 1.2) return null;

  // VWAP Reclaim CALL: was below, now above
  if (prev2.c < vwap && prev1.c < vwap && curr.c > vwap * 1.0001 && curr.c > curr.o) {
    // Confirm price was below for at least 3 bars (real cross, not noise)
    let belowCount = 0;
    for (let i = bars.length - 6; i < bars.length - 1; i++) {
      if (i >= 0 && bars[i].c < vwap) belowCount++;
    }
    if (belowCount < 3) return null;

    let conf = 70;
    if ((curr.v || 0) > avgVol * 2) conf += 10;
    if (br > 0.7) conf += 5;
    if (belowCount >= 4) conf += 5; // longer below = stronger reclaim
    if (ctx.ema9Slope > 0) conf += 5;

    return makeSignal('VWAP_RECLAIM', 'CALL', conf, curr, {
      vwap: +vwap.toFixed(2), belowBars: belowCount,
      crossDist: +((curr.c - vwap) / vwap * 100).toFixed(4),
    });
  }

  // VWAP Reclaim PUT: was above, now below
  if (prev2.c > vwap && prev1.c > vwap && curr.c < vwap * 0.9999 && curr.c < curr.o) {
    let aboveCount = 0;
    for (let i = bars.length - 6; i < bars.length - 1; i++) {
      if (i >= 0 && bars[i].c > vwap) aboveCount++;
    }
    if (aboveCount < 3) return null;

    let conf = 70;
    if ((curr.v || 0) > avgVol * 2) conf += 10;
    if (br > 0.7) conf += 5;
    if (aboveCount >= 4) conf += 5;
    if (ctx.ema9Slope < 0) conf += 5;

    return makeSignal('VWAP_RECLAIM', 'PUT', conf, curr, {
      vwap: +vwap.toFixed(2), aboveBars: aboveCount,
      crossDist: +((vwap - curr.c) / vwap * 100).toFixed(4),
    });
  }

  return null;
}

// ── Level Detection ─────────────────────────────────────────────────────────
//
// Build intraday price structure from bars: swing highs/lows, FVG zones.
// Used by "room to run" filter — don't buy calls into resistance,
// don't buy puts into support.

function findSwingPoints(bars) {
  const swings = [];
  if (bars.length < 5) return swings;
  const atr = avgRange(bars);
  const minSwingSize = atr * 0.5; // only significant swings

  // 3-bar swing detection — only keep swings with meaningful reversal
  for (let i = 2; i < bars.length - 2; i++) {
    const prev2 = bars[i - 2], prev1 = bars[i - 1], curr = bars[i], next1 = bars[i + 1], next2 = bars[i + 2];
    // Swing high: curr high is highest of 5-bar window
    if (curr.h > prev1.h && curr.h > prev2.h && curr.h > next1.h && curr.h > next2.h) {
      // Must have meaningful reversal after it
      const reversal = curr.h - Math.min(next1.l, next2.l);
      if (reversal >= minSwingSize) {
        swings.push({ price: curr.h, type: 'HIGH' });
      }
    }
    // Swing low
    if (curr.l < prev1.l && curr.l < prev2.l && curr.l < next1.l && curr.l < next2.l) {
      const reversal = Math.max(next1.h, next2.h) - curr.l;
      if (reversal >= minSwingSize) {
        swings.push({ price: curr.l, type: 'LOW' });
      }
    }
  }
  return swings;
}

function findFVGZones(bars) {
  const zones = [];
  if (bars.length < 3) return zones;
  for (let i = 0; i < bars.length - 2; i++) {
    const b0 = bars[i], b1 = bars[i + 1], b2 = bars[i + 2];
    const br = (b1.h - b1.l) > 0 ? Math.abs(b1.c - b1.o) / (b1.h - b1.l) : 0;
    if (br < 0.5) continue;
    // Bullish FVG (gap up): acts as support
    if (b0.h < b2.l) {
      zones.push({ top: b2.l, bottom: b0.h, type: 'SUPPORT' });
    }
    // Bearish FVG (gap down): acts as resistance
    if (b0.l > b2.h) {
      zones.push({ top: b0.l, bottom: b2.h, type: 'RESISTANCE' });
    }
  }
  return zones;
}

/**
 * Check if a signal has room to run to its target.
 * Returns { blocked: bool, level: string|null, distance: number }
 */
function checkRoomToRun(signal, bars, ctx) {
  const price = signal.entry;
  const isCall = signal.direction === 'CALL';
  // Minimum room needed: 0.10% stock move ≈ 10% contract move
  // This is the floor — if there's a proven level within 0.10%, no room to run
  const minRoomPct = 0.001;

  const swings = findSwingPoints(bars);
  const fvgs = findFVGZones(bars);

  // Collect blocking levels — only structural levels that actually hold
  // NOT session high/low (running extremes, not tested levels)
  const blockers = [];

  if (isCall) {
    // Resistance above: only real structural levels
    if (ctx.prevDayHigh && ctx.prevDayHigh > price) {
      blockers.push({ price: ctx.prevDayHigh, label: 'PREV_DAY_HIGH' });
    }
    // OR high: only matters if not yet broken (approaching from below)
    if (ctx.orHigh && ctx.orHigh > price && ctx.barsFromOpen > 10) {
      blockers.push({ price: ctx.orHigh, label: 'OR_HIGH' });
    }
  } else {
    // Support below: only real structural levels
    if (ctx.prevDayLow && ctx.prevDayLow > 0 && ctx.prevDayLow < price) {
      blockers.push({ price: ctx.prevDayLow, label: 'PREV_DAY_LOW' });
    }
    if (ctx.orLow && ctx.orLow < price && ctx.barsFromOpen > 10) {
      blockers.push({ price: ctx.orLow, label: 'OR_LOW' });
    }
  }

  if (blockers.length === 0) return { blocked: false, level: null, distance: Infinity };

  // Find the NEAREST blocking level
  let nearest = null;
  let nearestDist = Infinity;
  for (const b of blockers) {
    const dist = Math.abs(b.price - price) / price;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = b;
    }
  }

  // Block if nearest level is within minimum room
  const blocked = nearestDist < minRoomPct;
  return { blocked, level: nearest?.label, distance: nearestDist };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Detect compound scalp signals on a single bar update.
 *
 * @param {string} ticker - 'IWM'
 * @param {Object[]} bars - rolling 1-min bars (at least 20)
 * @param {Object} ctx - { vwap, orHigh, orLow, sessionHigh, sessionLow,
 *                          sessionOpen, ema9Slope, barsFromOpen,
 *                          prevDayHigh, prevDayLow }
 * @returns {CompoundSignal[]}
 */
export function detectCompoundSignals(ticker, bars, ctx) {
  if (!bars || bars.length < 10) return [];

  // Compute context if not provided
  if (!ctx.vwap) ctx.vwap = computeVWAP(bars);
  if (ctx.ema9Slope === undefined) {
    const closes = bars.map(b => b.c);
    const ema9Arr = emaSeries(closes, 9);
    if (ema9Arr && ema9Arr.length >= 15) {
      const now = ema9Arr[ema9Arr.length - 1];
      const ago = ema9Arr[ema9Arr.length - 6];
      ctx.ema9Slope = (now && ago && ago > 0) ? (now - ago) / ago : 0;
    } else {
      ctx.ema9Slope = 0;
    }
  }

  const rawSignals = [];

  // Priority order: best performers first (MOMENTUM > ORB > VWAP > TREND)
  const momentum = detectMomentumCont(ticker, bars, ctx);
  if (momentum) rawSignals.push(momentum);

  const orb = detectORBBreakout(ticker, bars, ctx);
  if (orb) rawSignals.push(orb);

  const vwap = detectVWAPReclaim(ticker, bars, ctx);
  if (vwap) rawSignals.push(vwap);

  const pullback = detectTrendPullback(ticker, bars, ctx);
  if (pullback) rawSignals.push(pullback);

  // Level awareness: block signals running into prev day high/low only
  // At 1-min scalp timescale, micro swing points and FVGs are noise.
  // The real structural levels (VWAP, session trend) are already in the
  // directional filter. Only prev day extremes are hard enough to block.
  const signals = [];
  for (const sig of rawSignals) {
    const room = checkRoomToRun(sig, bars, ctx);
    if (room.blocked && (room.level === 'PREV_DAY_HIGH' || room.level === 'PREV_DAY_LOW')) {
      sig.metadata.blockedBy = room.level;
      continue;
    }
    signals.push(sig);
  }

  return signals;
}
