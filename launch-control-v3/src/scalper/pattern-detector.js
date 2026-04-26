/**
 * Scalp Pattern Detector — 18 Price Action Patterns on 1-min Bars
 *
 * Categories:
 *   ICT / Smart Money (6): FVG, Liquidity Sweep, AMD, Order Block, Breaker, Displacement
 *   Volume (3): Climax Reversal, Dry-Up Breakout, Delta Divergence
 *   Classical (5): Engulfing@Level, Pin Bar, Inside Bar, 3-Bar Reversal, Double Top/Bottom
 *   Momentum (4): VWAP Snap, Opening Drive Fade, RSI Divergence, Break & Retest
 *
 * Each sub-detector returns PatternSignal | null.
 * Main entry: detectScalpPatterns(ticker, bars, context) → PatternSignal[]
 */

import {
  analyzeCandle, detectBullishEngulfing, detectBearishEngulfing,
} from '../indicators/candle-patterns.js';
import { computeRSI, ema } from '../indicators/technical.js';
import {
  shouldCooldown, getActiveFVGs, getActiveIFVGs, getActiveOrderBlocks, getSwingPoints,
  addPendingSweep, getPendingSweeps, expireSweep,
} from './scalp-state.js';

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

function clampConfidence(c) {
  return Math.max(50, Math.min(95, Math.round(c)));
}

function makeSignal(pattern, category, direction, confidence, entry, stop, target, bar, keyLevel, meta) {
  const rr = Math.abs(stop - entry) > 0 ? Math.abs(target - entry) / Math.abs(stop - entry) : 0;
  return {
    pattern, category, direction,
    confidence: clampConfidence(confidence),
    entry: +entry.toFixed(2),
    stop: +stop.toFixed(2),
    target: +target.toFixed(2),
    riskReward: +rr.toFixed(2),
    triggerBar: bar ? { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v } : null,
    keyLevel: keyLevel != null ? +keyLevel.toFixed(2) : null,
    metadata: meta || {},
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build key levels from context.
 */
function getKeyLevels(ctx) {
  const levels = [];
  if (ctx.vwap) levels.push({ price: ctx.vwap, label: 'VWAP' });
  if (ctx.sessionHigh) levels.push({ price: ctx.sessionHigh, label: 'SESSION_HIGH' });
  if (ctx.sessionLow) levels.push({ price: ctx.sessionLow, label: 'SESSION_LOW' });
  if (ctx.prevDayHigh) levels.push({ price: ctx.prevDayHigh, label: 'PREV_DAY_HIGH' });
  if (ctx.prevDayLow) levels.push({ price: ctx.prevDayLow, label: 'PREV_DAY_LOW' });
  if (ctx.orHigh) levels.push({ price: ctx.orHigh, label: 'OR_HIGH' });
  if (ctx.orLow) levels.push({ price: ctx.orLow, label: 'OR_LOW' });
  if (ctx.sessionOpen) levels.push({ price: ctx.sessionOpen, label: 'SESSION_OPEN' });
  return levels;
}

function nearLevel(price, levels, tolerance) {
  for (const lvl of levels) {
    if (Math.abs(price - lvl.price) / price <= tolerance) return lvl;
  }
  return null;
}

// ── Sub-Detectors ─────────────────────────────────────────────────────────────

// 1. FVG Retest
function detectFVGRetest(ticker, bars, ctx) {
  const curr = bars[bars.length - 1];
  const fvgs = getActiveFVGs(ticker);
  if (!fvgs.length) return null;

  for (const fvg of fvgs) {
    if (fvg.direction === 'CALL') {
      // Bullish FVG: price retrace into gap + close holds above bottom
      if (curr.l <= fvg.top && curr.c >= fvg.bottom && curr.c > curr.o) {
        let conf = 65 + (fvg.width / ctx.atrDollar) * 5;
        if (curr.v > ctx.avgVol * 1.3) conf += 5;
        if (ctx.ema9Slope > 0) conf += 5;
        const stop = fvg.bottom - 0.01 * ctx.atrDollar;
        const target = curr.c + fvg.width * 1.5;
        return makeSignal('FVG_RETEST', 'ICT', 'CALL', conf, curr.c, stop, target, curr, fvg.bottom, { fvgWidth: fvg.width });
      }
    } else {
      if (curr.h >= fvg.bottom && curr.c <= fvg.top && curr.c < curr.o) {
        let conf = 65 + (fvg.width / ctx.atrDollar) * 5;
        if (curr.v > ctx.avgVol * 1.3) conf += 5;
        if (ctx.ema9Slope < 0) conf += 5;
        const stop = fvg.top + 0.01 * ctx.atrDollar;
        const target = curr.c - fvg.width * 1.5;
        return makeSignal('FVG_RETEST', 'ICT', 'PUT', conf, curr.c, stop, target, curr, fvg.top, { fvgWidth: fvg.width });
      }
    }
  }
  return null;
}

// 1b. Inverse FVG (IFVG) — filled FVG acts as level from opposite side
//
// When a bullish FVG gets filled (price drops through it), the zone flips
// to resistance. Price rallying back into that zone and getting rejected = PUT.
// Vice versa for bearish FVGs that get filled and flip to support.
//
// Detection: price touches or enters the IFVG zone (with tolerance) and the
// current bar closes with rejection (wick into zone, body outside).
function detectIFVGRetest(ticker, bars, ctx) {
  if (bars.length < 2) return null;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const ifvgs = getActiveIFVGs(ticker);
  if (!ifvgs.length) return null;

  // Tolerance: allow price to come within 0.3% of zone edge
  const tol = curr.c * 0.003;

  for (const ifvg of ifvgs) {
    if (ifvg.direction === 'CALL') {
      // Flipped to support: price dips into/near zone and current bar closes above
      const wickNearZone = curr.l <= ifvg.top + tol;
      // Rejection: close above the zone (don't require candle color)
      const closesAbove = curr.c > ifvg.top;

      if (wickNearZone && closesAbove) {
        let conf = 65;
        if (ifvg.width / ctx.atrDollar > 0.3) conf += 5;
        if (curr.v > ctx.avgVol * 1.3) conf += 5;
        if (ctx.ema9Slope > 0) conf += 5;
        if (curr.c > curr.o) conf += 3; // green candle bonus
        const candle = analyzeCandle(curr);
        if (candle.bodyRatio > 0.6) conf += 5;
        const lvl = nearLevel(curr.c, getKeyLevels(ctx), 0.001);
        if (lvl) conf += 8;
        const stop = ifvg.bottom - 0.5 * ctx.atrDollar;
        const target = curr.c + ifvg.width * 2;
        return makeSignal('IFVG_RETEST', 'ICT', 'CALL', conf, curr.c, stop, target, curr, ifvg.top,
          { ifvgWidth: ifvg.width, originalDir: 'PUT' });
      }
    } else {
      // Flipped to resistance: price rallies into/near zone and current bar closes below
      const wickNearZone = curr.h >= ifvg.bottom - tol;
      const closesBelow = curr.c < ifvg.bottom;

      if (wickNearZone && closesBelow) {
        let conf = 65;
        if (ifvg.width / ctx.atrDollar > 0.3) conf += 5;
        if (curr.v > ctx.avgVol * 1.3) conf += 5;
        if (ctx.ema9Slope < 0) conf += 5;
        if (curr.c < curr.o) conf += 3; // red candle bonus
        const candle = analyzeCandle(curr);
        if (candle.bodyRatio > 0.6) conf += 5;
        const lvl = nearLevel(curr.c, getKeyLevels(ctx), 0.001);
        if (lvl) conf += 8;
        const stop = ifvg.top + 0.5 * ctx.atrDollar;
        const target = curr.c - ifvg.width * 2;
        return makeSignal('IFVG_RETEST', 'ICT', 'PUT', conf, curr.c, stop, target, curr, ifvg.bottom,
          { ifvgWidth: ifvg.width, originalDir: 'CALL' });
      }
    }
  }
  return null;
}

// 2. Original Liquidity Sweep (standalone — kept for A/B testing)
function detectLiquiditySweep(ticker, bars, ctx) {
  if (bars.length < 3) return null;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const price = curr.c;
  const levels = getKeyLevels(ctx);
  const swings = getSwingPoints(ticker);
  for (const sp of swings.slice(-6)) {
    levels.push({ price: sp.price, label: `SWING_${sp.type}` });
  }
  for (const lvl of levels) {
    if (prev.h > lvl.price * 1.0001 && price < lvl.price) {
      const overshoot = (prev.h - lvl.price) / lvl.price;
      if (overshoot > 0.0001 && overshoot < 0.003 && curr.c < curr.o) {
        let conf = 70;
        if (lvl.label.includes('SESSION') || lvl.label.includes('PREV_DAY')) conf += 10;
        if (curr.v > ctx.avgVol * 1.5) conf += 5;
        const candle = analyzeCandle(curr);
        if (candle.bodyRatio > 0.6) conf += 5;
        const stop = prev.h + 0.5 * ctx.atrDollar;
        const target = price - (prev.h - price) * 2;
        return makeSignal('LIQUIDITY_SWEEP', 'ICT', 'PUT', conf, price, stop, target, curr, lvl.price, { level: lvl.label, overshoot: +(overshoot * 100).toFixed(3) });
      }
    }
    if (prev.l < lvl.price * 0.9999 && price > lvl.price) {
      const overshoot = (lvl.price - prev.l) / lvl.price;
      if (overshoot > 0.0001 && overshoot < 0.003 && curr.c > curr.o) {
        let conf = 70;
        if (lvl.label.includes('SESSION') || lvl.label.includes('PREV_DAY')) conf += 10;
        if (curr.v > ctx.avgVol * 1.5) conf += 5;
        const candle = analyzeCandle(curr);
        if (candle.bodyRatio > 0.6) conf += 5;
        const stop = prev.l - 0.5 * ctx.atrDollar;
        const target = price + (price - prev.l) * 2;
        return makeSignal('LIQUIDITY_SWEEP', 'ICT', 'CALL', conf, price, stop, target, curr, lvl.price, { level: lvl.label, overshoot: +(overshoot * 100).toFixed(3) });
      }
    }
  }
  return null;
}

// 2a. Liquidity Sweep Setup (Phase 1: detect consolidation + sweep, store in state)
//     Does NOT return a signal — records a pending sweep for Phase 2 confirmation.
function detectSweepSetup(ticker, bars, ctx) {
  if (bars.length < 10) return null;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const price = curr.c;

  // ── Step 1: Find consolidation in lookback (bars[-10] to bars[-3])
  const consolBars = bars.slice(-10, -2);
  if (consolBars.length < 4) return null;
  const consolHigh = Math.max(...consolBars.map(b => b.h));
  const consolLow = Math.min(...consolBars.map(b => b.l));
  const rangeWidth = (consolHigh - consolLow) / price;

  // Consolidation must be reasonably tight (< 0.5% of price)
  if (rangeWidth > 0.005) return null;

  // ── Step 2: Did we just sweep beyond the consolidation range?
  const levels = getKeyLevels(ctx);
  const swings = getSwingPoints(ticker);
  for (const sp of swings.slice(-6)) {
    levels.push({ price: sp.price, label: `SWING_${sp.type}` });
  }

  // Bearish sweep: price poked above consolidation high (stop hunt), now reversing
  if (prev.h > consolHigh * 1.0001) {
    const overshoot = (prev.h - consolHigh) / consolHigh;
    if (overshoot > 0.0001 && overshoot < 0.005 && curr.c <= consolHigh) {
      // Find if a key level was near the sweep
      const nearLvl = nearLevel(prev.h, levels, 0.002);
      addPendingSweep(ticker, {
        direction: 'PUT',    // sweep above = bearish setup
        sweepLevel: prev.h,
        consolHigh,
        consolLow,
        rangeWidth,
        overshoot: +(overshoot * 100).toFixed(3),
        nearLevel: nearLvl?.label || null,
        time: curr.t,
      });
    }
  }

  // Bullish sweep: price poked below consolidation low (stop hunt), now reversing
  if (prev.l < consolLow * 0.9999) {
    const overshoot = (consolLow - prev.l) / consolLow;
    if (overshoot > 0.0001 && overshoot < 0.005 && curr.c >= consolLow) {
      const nearLvl = nearLevel(prev.l, levels, 0.002);
      addPendingSweep(ticker, {
        direction: 'CALL',   // sweep below = bullish setup
        sweepLevel: prev.l,
        consolHigh,
        consolLow,
        rangeWidth,
        overshoot: +(overshoot * 100).toFixed(3),
        nearLevel: nearLvl?.label || null,
        time: curr.t,
      });
    }
  }

  return null; // never returns a signal directly
}

// 2b. Sweep Confirmed Entry (Phase 2: pending sweep + confirmation candle)
function detectSweepEntry(ticker, bars, ctx) {
  if (bars.length < 3) return null;
  const curr = bars[bars.length - 1];
  const price = curr.c;
  const candle = analyzeCandle(curr);
  const pending = getPendingSweeps(ticker);
  if (pending.length === 0) return null;

  for (const sweep of pending) {
    if (sweep.direction === 'CALL') {
      // Bullish confirmation: strong close back above consolidation low
      const confirmed =
        (candle.bullish && candle.bodyRatio > 0.5 && price > sweep.consolLow) ||
        (candle.type === 'HAMMER' && price > sweep.consolLow) ||
        (detectBullishEngulfing(bars).detected && price > sweep.consolLow);

      if (!confirmed) continue;

      let conf = 70;
      if (sweep.nearLevel) conf += 10;   // swept a key level
      if (curr.v > ctx.avgVol * 1.3) conf += 5;
      if (candle.bodyRatio > 0.7) conf += 5;
      if (ctx.ema9Slope > 0) conf += 5;
      if (sweep.rangeWidth < 0.002) conf += 5; // tighter consolidation = better

      const stop = sweep.sweepLevel - 0.3 * ctx.atrDollar;
      const target = sweep.consolHigh + (sweep.consolHigh - sweep.consolLow);
      expireSweep(ticker, sweep);

      return makeSignal('SWEEP_ENTRY', 'ICT', 'CALL', conf, price, stop, target, curr,
        sweep.consolLow,
        { phase: 'confirmed', sweepLevel: sweep.sweepLevel, overshoot: sweep.overshoot,
          consolRange: +(sweep.rangeWidth * 100).toFixed(3), nearLevel: sweep.nearLevel });
    }

    if (sweep.direction === 'PUT') {
      // Bearish confirmation: strong close back below consolidation high
      const confirmed =
        (candle.bearish && candle.bodyRatio > 0.5 && price < sweep.consolHigh) ||
        (candle.type === 'SHOOTING_STAR' && price < sweep.consolHigh) ||
        (detectBearishEngulfing(bars).detected && price < sweep.consolHigh);

      if (!confirmed) continue;

      let conf = 70;
      if (sweep.nearLevel) conf += 10;
      if (curr.v > ctx.avgVol * 1.3) conf += 5;
      if (candle.bodyRatio > 0.7) conf += 5;
      if (ctx.ema9Slope < 0) conf += 5;
      if (sweep.rangeWidth < 0.002) conf += 5;

      const stop = sweep.sweepLevel + 0.3 * ctx.atrDollar;
      const target = sweep.consolLow - (sweep.consolHigh - sweep.consolLow);
      expireSweep(ticker, sweep);

      return makeSignal('SWEEP_ENTRY', 'ICT', 'PUT', conf, price, stop, target, curr,
        sweep.consolHigh,
        { phase: 'confirmed', sweepLevel: sweep.sweepLevel, overshoot: sweep.overshoot,
          consolRange: +(sweep.rangeWidth * 100).toFixed(3), nearLevel: sweep.nearLevel });
    }
  }
  return null;
}

// 3. AMD (Accumulation-Manipulation-Distribution)
function detectAMD(ticker, bars, ctx) {
  if (bars.length < 10) return null;
  const curr = bars[bars.length - 1];
  const price = curr.c;

  // Find tight range in bars[-10] to bars[-4]
  const accBars = bars.slice(-10, -3);
  if (accBars.length < 4) return null;
  const accHigh = Math.max(...accBars.map(b => b.h));
  const accLow = Math.min(...accBars.map(b => b.l));
  const rangeWidth = (accHigh - accLow) / price;

  if (rangeWidth > 0.0015) return null; // range too wide

  // Manipulation: bars[-3] or bars[-2] broke the range
  const manipBar = bars[bars.length - 2];
  const brokeHigh = manipBar.h > accHigh * 1.0002;
  const brokeLow = manipBar.l < accLow * 0.9998;

  if (!brokeHigh && !brokeLow) return null;

  // Distribution: current bar reverses through the range
  if (brokeHigh && curr.c < accLow && curr.c < curr.o) {
    // False breakout up, real move down
    let conf = 70;
    if (accBars.length >= 5) conf += 5;
    if (manipBar.v > ctx.avgVol * 1.5) conf += 5;
    if (analyzeCandle(curr).bodyRatio > 0.5) conf += 5;
    if (ctx.ema9Slope < 0) conf += 5;
    const stop = manipBar.h + 0.3 * ctx.atrDollar;
    const target = price - (accHigh - accLow);
    return makeSignal('AMD', 'ICT', 'PUT', conf, price, stop, target, curr, accLow, { rangeWidth: +(rangeWidth * 100).toFixed(3), accBars: accBars.length });
  }
  if (brokeLow && curr.c > accHigh && curr.c > curr.o) {
    let conf = 70;
    if (accBars.length >= 5) conf += 5;
    if (manipBar.v > ctx.avgVol * 1.5) conf += 5;
    if (analyzeCandle(curr).bodyRatio > 0.5) conf += 5;
    if (ctx.ema9Slope > 0) conf += 5;
    const stop = manipBar.l - 0.3 * ctx.atrDollar;
    const target = price + (accHigh - accLow);
    return makeSignal('AMD', 'ICT', 'CALL', conf, price, stop, target, curr, accHigh, { rangeWidth: +(rangeWidth * 100).toFixed(3), accBars: accBars.length });
  }
  return null;
}

// 4. Order Block Retest
function detectOrderBlockRetest(ticker, bars, ctx) {
  const curr = bars[bars.length - 1];
  const obs = getActiveOrderBlocks(ticker);
  if (!obs.length) return null;

  for (const ob of obs) {
    if (ob.direction === 'CALL') {
      // Bullish OB: price retests zone from above, holds
      if (curr.l <= ob.top && curr.c >= ob.bottom && curr.c > curr.o) {
        let conf = 65;
        if (ob.impulseRange > 2 * ctx.atrDollar) conf += 5;
        if (curr.v > ctx.avgVol * 1.2) conf += 5;
        if (analyzeCandle(curr).bodyRatio > 0.5) conf += 5;
        const lvl = nearLevel(ob.bottom, getKeyLevels(ctx), 0.001);
        if (lvl) conf += 5;
        const stop = ob.bottom - 0.3 * ctx.atrDollar;
        const target = curr.c + ob.impulseRange * 0.6;
        return makeSignal('ORDER_BLOCK', 'ICT', 'CALL', conf, curr.c, stop, target, curr, ob.bottom, { obType: 'bullish' });
      }
    } else {
      if (curr.h >= ob.bottom && curr.c <= ob.top && curr.c < curr.o) {
        let conf = 65;
        if (ob.impulseRange > 2 * ctx.atrDollar) conf += 5;
        if (curr.v > ctx.avgVol * 1.2) conf += 5;
        if (analyzeCandle(curr).bodyRatio > 0.5) conf += 5;
        const lvl = nearLevel(ob.top, getKeyLevels(ctx), 0.001);
        if (lvl) conf += 5;
        const stop = ob.top + 0.3 * ctx.atrDollar;
        const target = curr.c - ob.impulseRange * 0.6;
        return makeSignal('ORDER_BLOCK', 'ICT', 'PUT', conf, curr.c, stop, target, curr, ob.top, { obType: 'bearish' });
      }
    }
  }
  return null;
}

// 5. Breaker Block
function detectBreakerBlock(ticker, bars, ctx) {
  const curr = bars[bars.length - 1];
  const obs = getActiveOrderBlocks(ticker);
  if (!obs.length || bars.length < 5) return null;

  // Check if any OB was broken through in recent bars
  for (const ob of obs) {
    let broken = false;
    let breakBar = null;
    for (let i = bars.length - 5; i < bars.length - 1; i++) {
      if (i < 0) continue;
      if (ob.direction === 'CALL' && bars[i].c < ob.bottom) { broken = true; breakBar = bars[i]; break; }
      if (ob.direction === 'PUT' && bars[i].c > ob.top) { broken = true; breakBar = bars[i]; break; }
    }
    if (!broken || !breakBar) continue;

    // Retest the broken OB from the other side
    if (ob.direction === 'CALL') {
      // Was bullish OB, now broken = becomes resistance (bearish breaker)
      if (curr.h >= ob.bottom && curr.c <= ob.top && curr.c < curr.o) {
        let conf = 60;
        if (analyzeCandle(curr).bodyRatio > 0.5) conf += 5;
        if (curr.v > ctx.avgVol * 1.2) conf += 5;
        if (ctx.ema9Slope < 0) conf += 5;
        const stop = ob.top + 0.3 * ctx.atrDollar;
        const target = curr.c - (ob.top - ob.bottom) * 2;
        return makeSignal('BREAKER_BLOCK', 'ICT', 'PUT', conf, curr.c, stop, target, curr, ob.top, { originalOB: 'CALL' });
      }
    } else {
      if (curr.l <= ob.top && curr.c >= ob.bottom && curr.c > curr.o) {
        let conf = 60;
        if (analyzeCandle(curr).bodyRatio > 0.5) conf += 5;
        if (curr.v > ctx.avgVol * 1.2) conf += 5;
        if (ctx.ema9Slope > 0) conf += 5;
        const stop = ob.bottom - 0.3 * ctx.atrDollar;
        const target = curr.c + (ob.top - ob.bottom) * 2;
        return makeSignal('BREAKER_BLOCK', 'ICT', 'CALL', conf, curr.c, stop, target, curr, ob.bottom, { originalOB: 'PUT' });
      }
    }
  }
  return null;
}

// 6. Displacement Entry
function detectDisplacement(ticker, bars, ctx) {
  if (bars.length < 6) return null;
  const curr = bars[bars.length - 1];
  const avgR = avgRange(bars.slice(-15, -2));
  if (avgR <= 0) return null;

  // Scan bars[-5] to bars[-2] for displacement candle
  for (let i = bars.length - 5; i <= bars.length - 2; i++) {
    if (i < 0) continue;
    const disp = bars[i];
    const dRange = disp.h - disp.l;
    const candle = analyzeCandle(disp);
    if (dRange < 2 * avgR || candle.bodyRatio < 0.7) continue;
    if ((disp.v || 0) < ctx.avgVol * 1.3) continue;

    const mid = (disp.h + disp.l) / 2;
    const bullish = disp.c > disp.o;

    if (bullish && curr.l <= mid && curr.c >= mid) {
      let conf = 65;
      if (dRange > 3 * avgR) conf += 10;
      if (disp.v > ctx.avgVol * 2) conf += 5;
      if (ctx.ema9Slope > 0) conf += 5;
      const stop = disp.l - 0.2 * ctx.atrDollar;
      const target = disp.h + dRange * 0.5;
      return makeSignal('DISPLACEMENT', 'ICT', 'CALL', conf, curr.c, stop, target, curr, mid, { dispRange: +dRange.toFixed(2) });
    }
    if (!bullish && curr.h >= mid && curr.c <= mid) {
      let conf = 65;
      if (dRange > 3 * avgR) conf += 10;
      if (disp.v > ctx.avgVol * 2) conf += 5;
      if (ctx.ema9Slope < 0) conf += 5;
      const stop = disp.h + 0.2 * ctx.atrDollar;
      const target = disp.l - dRange * 0.5;
      return makeSignal('DISPLACEMENT', 'ICT', 'PUT', conf, curr.c, stop, target, curr, mid, { dispRange: +dRange.toFixed(2) });
    }
  }
  return null;
}

// 7. Volume Climax Reversal
function detectVolumeClimax(ticker, bars, ctx) {
  if (bars.length < 15) return null;
  const curr = bars[bars.length - 1];
  const recent15 = bars.slice(-15);
  const maxVol = Math.max(...recent15.slice(0, -1).map(b => b.v || 0));

  if ((curr.v || 0) < maxVol) return null; // must be highest volume
  if ((curr.v || 0) < ctx.avgVol * 2) return null; // must be 2x avg

  const candle = analyzeCandle(curr);
  const levels = getKeyLevels(ctx);

  // Reversal candle: body < 50% (showing rejection), significant wick
  if (candle.bodyRatio >= 0.5) return null;

  let conf = 70;
  if (curr.v > ctx.avgVol * 3) conf += 5;
  if (ctx.rsi && (ctx.rsi > 70 || ctx.rsi < 30)) conf += 5;
  if (candle.quality > 50) conf += 5;
  const lvl = nearLevel(curr.c, levels, 0.001);
  if (lvl) conf += 10;

  if (candle.lowerWickRatio > 0.4) {
    // Long lower wick = bullish reversal
    const stop = curr.l - 0.2 * ctx.atrDollar;
    const target = ctx.vwap || curr.c + ctx.atrDollar;
    return makeSignal('VOLUME_CLIMAX', 'VOLUME', 'CALL', conf, curr.c, stop, target, curr, lvl?.price, { vol: curr.v, avgVol: Math.round(ctx.avgVol) });
  }
  if (candle.upperWickRatio > 0.4) {
    const stop = curr.h + 0.2 * ctx.atrDollar;
    const target = ctx.vwap || curr.c - ctx.atrDollar;
    return makeSignal('VOLUME_CLIMAX', 'VOLUME', 'PUT', conf, curr.c, stop, target, curr, lvl?.price, { vol: curr.v, avgVol: Math.round(ctx.avgVol) });
  }
  return null;
}

// 8. Volume Dry-Up Breakout
function detectVolumeDryUp(ticker, bars, ctx) {
  if (bars.length < 7) return null;
  const curr = bars[bars.length - 1];
  const dryBars = bars.slice(-6, -1);

  // Check declining volume over 3-5 bars
  let declining = 0;
  for (let i = 1; i < dryBars.length; i++) {
    if ((dryBars[i].v || 0) <= (dryBars[i - 1].v || 0)) declining++;
  }
  if (declining < 3) return null; // need at least 3 declining

  const dryAvgVol = avgVolume(dryBars);
  if ((curr.v || 0) < dryAvgVol * 1.5) return null; // expansion needed

  const dryHigh = Math.max(...dryBars.map(b => b.h));
  const dryLow = Math.min(...dryBars.map(b => b.l));
  const candle = analyzeCandle(curr);
  if (candle.bodyRatio < 0.6) return null;

  let conf = 65;
  if (declining >= 4) conf += 5;
  if (curr.v > dryAvgVol * 2) conf += 5;
  if (candle.bodyRatio > 0.7) conf += 5;
  if (ctx.ema9Slope !== 0) conf += 5;

  if (curr.c > dryHigh && curr.c > curr.o) {
    const stop = dryLow;
    const target = curr.c + (dryHigh - dryLow) * 1.5;
    return makeSignal('VOLUME_DRYUP', 'VOLUME', 'CALL', conf, curr.c, stop, target, curr, dryHigh, { dryBars: dryBars.length, expansion: +(curr.v / dryAvgVol).toFixed(2) });
  }
  if (curr.c < dryLow && curr.c < curr.o) {
    const stop = dryHigh;
    const target = curr.c - (dryHigh - dryLow) * 1.5;
    return makeSignal('VOLUME_DRYUP', 'VOLUME', 'PUT', conf, curr.c, stop, target, curr, dryLow, { dryBars: dryBars.length, expansion: +(curr.v / dryAvgVol).toFixed(2) });
  }
  return null;
}

// 9. Delta Divergence
function detectDeltaDivergence(ticker, bars, ctx) {
  if (bars.length < 10) return null;
  const curr = bars[bars.length - 1];
  const recent10 = bars.slice(-10);

  // Find highest high and its index
  let hhIdx = 0, llIdx = 0;
  for (let i = 1; i < recent10.length - 1; i++) {
    if (recent10[i].h > recent10[hhIdx].h) hhIdx = i;
    if (recent10[i].l < recent10[llIdx].l) llIdx = i;
  }

  // Current bar makes new high
  if (curr.h >= recent10[hhIdx].h && hhIdx < recent10.length - 3) {
    // Check delta divergence: use close-position-in-range as proxy for buying pressure
    const prevDelta = (recent10[hhIdx].c - recent10[hhIdx].l) / Math.max(0.01, recent10[hhIdx].h - recent10[hhIdx].l);
    const currDelta = (curr.c - curr.l) / Math.max(0.01, curr.h - curr.l);
    if (prevDelta - currDelta >= 0.15) { // significant divergence
      let conf = 60;
      if (prevDelta - currDelta >= 0.25) conf += 10;
      if (ctx.rsi && ctx.rsi > 70) conf += 10;
      if (analyzeCandle(curr).upperWickRatio > 0.3) conf += 5;
      const stop = curr.h + 0.3 * ctx.atrDollar;
      const target = ctx.ema9 || curr.c - ctx.atrDollar;
      return makeSignal('DELTA_DIVERGENCE', 'VOLUME', 'PUT', conf, curr.c, stop, target, curr, null, { prevDelta: +prevDelta.toFixed(2), currDelta: +currDelta.toFixed(2) });
    }
  }

  // Current bar makes new low
  if (curr.l <= recent10[llIdx].l && llIdx < recent10.length - 3) {
    const prevDelta = (recent10[llIdx].h - recent10[llIdx].c) / Math.max(0.01, recent10[llIdx].h - recent10[llIdx].l);
    const currDelta = (curr.h - curr.c) / Math.max(0.01, curr.h - curr.l);
    if (prevDelta - currDelta >= 0.15) {
      let conf = 60;
      if (prevDelta - currDelta >= 0.25) conf += 10;
      if (ctx.rsi && ctx.rsi < 30) conf += 10;
      if (analyzeCandle(curr).lowerWickRatio > 0.3) conf += 5;
      const stop = curr.l - 0.3 * ctx.atrDollar;
      const target = ctx.ema9 || curr.c + ctx.atrDollar;
      return makeSignal('DELTA_DIVERGENCE', 'VOLUME', 'CALL', conf, curr.c, stop, target, curr, null, { prevDelta: +prevDelta.toFixed(2), currDelta: +currDelta.toFixed(2) });
    }
  }
  return null;
}

// 10. Engulfing at Level
function detectEngulfingAtLevel(ticker, bars, ctx) {
  if (bars.length < 5) return null;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const levels = getKeyLevels(ctx);
  const candle = analyzeCandle(curr);

  // ── Conviction gates (regime-robust) ──
  // Shape alone is noise. Require: volume surge + strong body + level defended.
  // Volume must be 2x avg (not 1.3x) — proves real participation, not chop.
  // Engulfing body must be >= 60% of range — weak bodies = indecision, not conviction.
  if ((curr.v || 0) < ctx.avgVol * 2) return null; // mandatory volume surge
  if (candle.bodyRatio < 0.6) return null; // strong body = conviction

  // Level must have been tested before (at least 1 prior bar touched within 0.1%)
  // A level that was only visited once has no memory — it's not a real level.
  function levelDefended(lvlPrice, direction) {
    let touches = 0;
    const lookback = bars.slice(-20, -1);
    for (const b of lookback) {
      if (direction === 'CALL' && Math.abs(b.l - lvlPrice) / lvlPrice < 0.001) touches++;
      if (direction === 'PUT' && Math.abs(b.h - lvlPrice) / lvlPrice < 0.001) touches++;
    }
    return touches >= 1;
  }

  const bullEng = detectBullishEngulfing(bars);
  if (bullEng.detected) {
    const lvl = nearLevel(curr.c, levels, 0.001);
    if (lvl && levelDefended(lvl.price, 'CALL')) {
      let conf = 70 + bullEng.quality / 5;
      conf += 5; // volume already confirmed >= 2x
      if (ctx.ema9Slope > 0) conf += 5;
      if (curr.v > ctx.avgVol * 3) conf += 5; // extra volume bonus
      const stop = curr.l - 0.1 * ctx.atrDollar;
      const target = curr.c + (curr.c - curr.l) * 2;
      return makeSignal('ENGULFING_LEVEL', 'CLASSICAL', 'CALL', conf, curr.c, stop, target, curr, lvl.price, { level: lvl.label, engulfQuality: bullEng.quality });
    }
  }

  const bearEng = detectBearishEngulfing(bars);
  if (bearEng.detected) {
    const lvl = nearLevel(curr.c, levels, 0.001);
    if (lvl && levelDefended(lvl.price, 'PUT')) {
      let conf = 70 + bearEng.quality / 5;
      conf += 5;
      if (ctx.ema9Slope < 0) conf += 5;
      if (curr.v > ctx.avgVol * 3) conf += 5;
      const stop = curr.h + 0.1 * ctx.atrDollar;
      const target = curr.c - (curr.h - curr.c) * 2;
      return makeSignal('ENGULFING_LEVEL', 'CLASSICAL', 'PUT', conf, curr.c, stop, target, curr, lvl.price, { level: lvl.label, engulfQuality: bearEng.quality });
    }
  }
  return null;
}

// 11. Pin Bar Rejection
function detectPinBar(ticker, bars, ctx) {
  if (bars.length < 2) return null;
  const curr = bars[bars.length - 1];
  const candle = analyzeCandle(curr);
  const levels = getKeyLevels(ctx);

  if (candle.type === 'HAMMER') {
    const lvl = nearLevel(curr.l, levels, 0.001);
    if (lvl) {
      let conf = 70 + candle.quality / 5;
      if (curr.v > ctx.avgVol * 1.3) conf += 5;
      const stop = curr.l - 0.1 * ctx.atrDollar;
      const target = curr.c + (curr.c - curr.l);
      return makeSignal('PIN_BAR', 'CLASSICAL', 'CALL', conf, curr.c, stop, target, curr, lvl.price, { level: lvl.label, candleType: 'HAMMER' });
    }
  }

  if (candle.type === 'SHOOTING_STAR' || (candle.type === 'INVERTED_HAMMER' && candle.bearish)) {
    const lvl = nearLevel(curr.h, levels, 0.001);
    if (lvl) {
      let conf = 70 + candle.quality / 5;
      if (curr.v > ctx.avgVol * 1.3) conf += 5;
      const stop = curr.h + 0.1 * ctx.atrDollar;
      const target = curr.c - (curr.h - curr.c);
      return makeSignal('PIN_BAR', 'CLASSICAL', 'PUT', conf, curr.c, stop, target, curr, lvl.price, { level: lvl.label, candleType: candle.type });
    }
  }
  return null;
}

// 12. Inside Bar Breakout
function detectInsideBar(ticker, bars, ctx) {
  if (bars.length < 3) return null;
  const mother = bars[bars.length - 3];
  const inside = bars[bars.length - 2];
  const breakout = bars[bars.length - 1];
  const motherRange = mother.h - mother.l;

  if (motherRange < 0.5 * ctx.atrDollar) return null; // mother too small
  if (inside.h > mother.h || inside.l < mother.l) return null; // not inside
  if ((inside.h - inside.l) > motherRange * 0.75) return null; // not tight enough

  const candle = analyzeCandle(breakout);
  if (candle.bodyRatio < 0.6) return null;

  let conf = 65;
  if ((inside.h - inside.l) < motherRange * 0.5) conf += 5;
  if ((breakout.v || 0) > (inside.v || 1)) conf += 10;
  if (ctx.ema9Slope !== 0) conf += 5;

  if (breakout.c > mother.h && breakout.c > breakout.o) {
    const stop = mother.l;
    const target = breakout.c + motherRange;
    return makeSignal('INSIDE_BAR', 'CLASSICAL', 'CALL', conf, breakout.c, stop, target, breakout, mother.h, {});
  }
  if (breakout.c < mother.l && breakout.c < breakout.o) {
    const stop = mother.h;
    const target = breakout.c - motherRange;
    return makeSignal('INSIDE_BAR', 'CLASSICAL', 'PUT', conf, breakout.c, stop, target, breakout, mother.l, {});
  }
  return null;
}

// 13. Three Bar Reversal
// Psychology: exhaustion at a swing extreme → indecision → conviction reversal.
// Previous version only checked 8-bar lookback (8 minutes = meaningless swing).
// Fix: 15-bar lookback, b1 must be a REAL extreme (range >= 1.5x ATR), b3 must
// have volume conviction (> b2 vol), and reversal distance must be meaningful.
function detectThreeBarReversal(ticker, bars, ctx) {
  if (bars.length < 15) return null; // need 15 bars of context (was 8)
  const b1 = bars[bars.length - 3];
  const b2 = bars[bars.length - 2];
  const b3 = bars[bars.length - 1];
  const recent = bars.slice(-15, -3); // 12 bars of lookback context

  const b1Candle = analyzeCandle(b1);
  const b2Candle = analyzeCandle(b2);
  const b3Candle = analyzeCandle(b3);

  // ── Conviction gates (regime-robust) ──
  // b1 must be a meaningful extreme — range >= 1x ATR (was: any bar that's highest in 8)
  const b1Range = b1.h - b1.l;
  if (b1Range < ctx.atrDollar * 1.0) return null; // b1 must be a real swing bar

  // b3 must have volume conviction — more volume than b2 (proves reversal has participation)
  if ((b3.v || 0) <= (b2.v || 1)) return null; // reversal bar must outpace indecision bar

  // b3 must have strong body (already checked bodyRatio > 0.5, keep)
  // Reversal magnitude: b3 close must be at least 0.5 ATR from b1 extreme
  // (filters out tiny reversals that look like the shape but have no substance)

  // Bearish reversal: b1 makes highest high, b2 small, b3 closes below b2
  const isHighest = recent.every(b => b1.h >= b.h);
  const bearRevDist = b1.h - b3.c;
  if (isHighest && b2Candle.bodyRatio < 0.35 && b3.c < b2.l && b3Candle.bearish && b3Candle.bodyRatio > 0.5
      && bearRevDist >= ctx.atrDollar * 0.5) {
    let conf = 65;
    if (b2Candle.type === 'DOJI') conf += 5;
    if ((b3.v || 0) > ctx.avgVol * 1.5) conf += 5; // raised from 1.2x
    if (ctx.rsi && ctx.rsi > 65) conf += 5;
    const lvl = nearLevel(b1.h, getKeyLevels(ctx), 0.001);
    if (lvl) conf += 10; // key level at extreme = much stronger (was +5)
    const stop = b1.h + 0.2 * ctx.atrDollar;
    const target = b3.c - (b1.h - b3.c);
    return makeSignal('THREE_BAR_REVERSAL', 'CLASSICAL', 'PUT', conf, b3.c, stop, target, b3, b1.h, {});
  }

  // Bullish reversal: b1 makes lowest low, b2 small, b3 closes above b2
  const isLowest = recent.every(b => b1.l <= b.l);
  const bullRevDist = b3.c - b1.l;
  if (isLowest && b2Candle.bodyRatio < 0.35 && b3.c > b2.h && b3Candle.bullish && b3Candle.bodyRatio > 0.5
      && bullRevDist >= ctx.atrDollar * 0.5) {
    let conf = 65;
    if (b2Candle.type === 'DOJI') conf += 5;
    if ((b3.v || 0) > ctx.avgVol * 1.5) conf += 5;
    if (ctx.rsi && ctx.rsi < 35) conf += 5;
    const lvl = nearLevel(b1.l, getKeyLevels(ctx), 0.001);
    if (lvl) conf += 10;
    const stop = b1.l - 0.2 * ctx.atrDollar;
    const target = b3.c + (b3.c - b1.l);
    return makeSignal('THREE_BAR_REVERSAL', 'CLASSICAL', 'CALL', conf, b3.c, stop, target, b3, b1.l, {});
  }
  return null;
}

// 14. Micro Double Top/Bottom
// Psychology: price tests a level twice and fails both times → trapped traders fuel reversal.
// Previous version: 10-bar lookback, 3-bar min spacing, 2+ conviction factors.
// Fix: require 5+ bar spacing (so the two tests are separate price rotations, not
// oscillation noise), require a meaningful trough/peak between the two tests (>= 0.15%
// from level — proves price actually LEFT the level and came back), raise conviction
// to 3+ factors, and require volume >= 1.5x avg (not 1.3x).
function detectMicroDoubleTop(ticker, bars, ctx) {
  if (bars.length < 8) return null;
  const curr = bars[bars.length - 1];
  const price = curr.c;
  const recent = bars.slice(-15); // wider lookback for better swings
  const candle = analyzeCandle(curr);
  const levels = getKeyLevels(ctx);

  for (let i = 0; i < recent.length - 5; i++) { // min 5-bar spacing (was 3)
    for (let j = i + 5; j < recent.length - 1; j++) {
      const tolerance = recent[i].h * 0.0005;

      // Double top
      if (Math.abs(recent[i].h - recent[j].h) <= tolerance) {
        const dtLevel = (recent[i].h + recent[j].h) / 2;
        if (Math.abs(curr.h - dtLevel) / dtLevel < 0.0003 && curr.c < curr.o) {
          // Trough between the two tops must be meaningful — price actually left the level
          const trough = Math.min(...recent.slice(i, j + 1).map(b => b.l));
          const troughDepth = (dtLevel - trough) / dtLevel;
          if (troughDepth < 0.0015) continue; // need >= 0.15% pullback between tests

          const hasRejectionWick = candle.upperWickRatio > 0.4;
          const hasVolume = (curr.v || 0) > ctx.avgVol * 1.5; // raised from 1.3x
          const nearKeyLevel = nearLevel(dtLevel, levels, 0.001);
          const emaConfirms = ctx.ema9Slope <= 0;
          const hasBearEngulf = detectBearishEngulfing(bars).detected;

          const convictionCount = [hasRejectionWick, hasVolume, !!nearKeyLevel, emaConfirms, hasBearEngulf]
            .filter(Boolean).length;
          if (convictionCount < 3) continue; // raised from 2+ to 3+ factors

          let conf = 60;
          if (Math.abs(recent[i].h - recent[j].h) / dtLevel < 0.0002) conf += 5;
          if (hasRejectionWick) conf += 10;
          if (hasVolume) conf += 5;
          if (nearKeyLevel) conf += 10;
          if (hasBearEngulf) conf += 5;
          if (emaConfirms) conf += 5;

          const stop = dtLevel + 0.3 * ctx.atrDollar;
          const target = price - (dtLevel - trough);
          return makeSignal('DOUBLE_TOP', 'CLASSICAL', 'PUT', conf, price, stop, target, curr, dtLevel,
            { conviction: convictionCount, nearLevel: nearKeyLevel?.label || null, troughDepth: +(troughDepth * 100).toFixed(2) });
        }
      }

      // Double bottom
      if (Math.abs(recent[i].l - recent[j].l) <= tolerance) {
        const dbLevel = (recent[i].l + recent[j].l) / 2;
        if (Math.abs(curr.l - dbLevel) / dbLevel < 0.0003 && curr.c > curr.o) {
          // Peak between the two bottoms must be meaningful
          const peak = Math.max(...recent.slice(i, j + 1).map(b => b.h));
          const peakHeight = (peak - dbLevel) / dbLevel;
          if (peakHeight < 0.0015) continue; // need >= 0.15% bounce between tests

          const hasRejectionWick = candle.lowerWickRatio > 0.4;
          const hasVolume = (curr.v || 0) > ctx.avgVol * 1.5;
          const nearKeyLevel = nearLevel(dbLevel, levels, 0.001);
          const emaConfirms = ctx.ema9Slope >= 0;
          const hasBullEngulf = detectBullishEngulfing(bars).detected;

          const convictionCount = [hasRejectionWick, hasVolume, !!nearKeyLevel, emaConfirms, hasBullEngulf]
            .filter(Boolean).length;
          if (convictionCount < 3) continue;

          let conf = 60;
          if (Math.abs(recent[i].l - recent[j].l) / dbLevel < 0.0002) conf += 5;
          if (hasRejectionWick) conf += 10;
          if (hasVolume) conf += 5;
          if (nearKeyLevel) conf += 10;
          if (hasBullEngulf) conf += 5;
          if (emaConfirms) conf += 5;

          const stop = dbLevel - 0.3 * ctx.atrDollar;
          const target = price + (peak - dbLevel);
          return makeSignal('DOUBLE_BOTTOM', 'CLASSICAL', 'CALL', conf, price, stop, target, curr, dbLevel,
            { conviction: convictionCount, nearLevel: nearKeyLevel?.label || null, peakHeight: +(peakHeight * 100).toFixed(2) });
        }
      }
    }
  }
  return null;
}

// 15. VWAP Deviation Snap
function detectVWAPSnap(ticker, bars, ctx) {
  if (!ctx.vwap || bars.length < 5) return null;
  const curr = bars[bars.length - 1];
  const deviation = Math.abs(curr.c - ctx.vwap);

  if (deviation < 1.5 * ctx.atrDollar) return null; // not extended enough

  const candle = analyzeCandle(curr);

  // Extended above VWAP + bearish reversal candle
  if (curr.c > ctx.vwap && (candle.type === 'SHOOTING_STAR' || candle.upperWickRatio > 0.4 || candle.bearish)) {
    let conf = 65;
    if (deviation > 2 * ctx.atrDollar) conf += 10;
    if (ctx.rsi && ctx.rsi > 70) conf += 10;
    if (candle.quality > 50) conf += 5;
    const stop = curr.h + 0.3 * ctx.atrDollar;
    const target = ctx.vwap + (curr.c - ctx.vwap) * 0.3; // target 70% of distance to VWAP
    return makeSignal('VWAP_SNAP', 'MOMENTUM', 'PUT', conf, curr.c, stop, target, curr, ctx.vwap, { deviation: +deviation.toFixed(2) });
  }

  // Extended below VWAP + bullish reversal candle
  if (curr.c < ctx.vwap && (candle.type === 'HAMMER' || candle.lowerWickRatio > 0.4 || candle.bullish)) {
    let conf = 65;
    if (deviation > 2 * ctx.atrDollar) conf += 10;
    if (ctx.rsi && ctx.rsi < 30) conf += 10;
    if (candle.quality > 50) conf += 5;
    const stop = curr.l - 0.3 * ctx.atrDollar;
    const target = ctx.vwap - (ctx.vwap - curr.c) * 0.3;
    return makeSignal('VWAP_SNAP', 'MOMENTUM', 'CALL', conf, curr.c, stop, target, curr, ctx.vwap, { deviation: +deviation.toFixed(2) });
  }
  return null;
}

// 16. Opening Drive Fade
function detectOpeningDriveFade(ticker, bars, ctx) {
  if (!ctx.barsFromOpen || ctx.barsFromOpen < 5 || ctx.barsFromOpen > 15) return null;
  if (bars.length < 6) return null;

  const curr = bars[bars.length - 1];
  const openBars = bars.slice(0, Math.min(5, bars.length - 1));
  if (openBars.length < 3) return null;

  const driveStart = openBars[0].o;
  const driveEnd = openBars[openBars.length - 1].c;
  const drivePct = (driveEnd - driveStart) / driveStart;

  if (Math.abs(drivePct) < 0.0015) return null; // drive too small (< 0.15%)

  const candle = analyzeCandle(curr);

  // Bullish drive + bearish reversal
  if (drivePct > 0 && candle.bearish && candle.bodyRatio > 0.5) {
    let conf = 65;
    if (drivePct > 0.003) conf += 5;
    if (candle.type.includes('ENGULFING') || candle.bodyRatio > 0.7) conf += 10;
    if ((curr.v || 0) > ctx.avgVol * 1.2) conf += 5;
    const stop = Math.max(curr.h, driveEnd) + 0.3 * ctx.atrDollar;
    const target = ctx.sessionOpen || driveStart;
    return makeSignal('OPENING_FADE', 'MOMENTUM', 'PUT', conf, curr.c, stop, target, curr, driveEnd, { drivePct: +(drivePct * 100).toFixed(2) });
  }

  // Bearish drive + bullish reversal
  if (drivePct < 0 && candle.bullish && candle.bodyRatio > 0.5) {
    let conf = 65;
    if (drivePct < -0.003) conf += 5;
    if (candle.bodyRatio > 0.7) conf += 10;
    if ((curr.v || 0) > ctx.avgVol * 1.2) conf += 5;
    const stop = Math.min(curr.l, driveEnd) - 0.3 * ctx.atrDollar;
    const target = ctx.sessionOpen || driveStart;
    return makeSignal('OPENING_FADE', 'MOMENTUM', 'CALL', conf, curr.c, stop, target, curr, driveEnd, { drivePct: +(drivePct * 100).toFixed(2) });
  }
  return null;
}

// 17. Momentum Divergence (RSI)
function detectMomentumDivergence(ticker, bars, ctx) {
  if (bars.length < 15) return null;
  const closes = bars.map(b => b.c);
  const curr = bars[bars.length - 1];

  // Compute RSI series using period 10 for faster signal
  const rsiSeries = [];
  for (let i = 11; i <= closes.length; i++) {
    const r = computeRSI(closes.slice(0, i), 10);
    rsiSeries.push(r.rsi);
  }
  if (rsiSeries.length < 5) return null;

  // Align rsiSeries with bars (rsiSeries[0] corresponds to bars[11-1] = bars[10])
  const offset = closes.length - rsiSeries.length;

  // Find swing highs in price
  for (let i = rsiSeries.length - 5; i >= 1; i--) {
    const bi = i + offset;
    const bCurr = bars.length - 1;
    if (bi >= bCurr - 2) continue;

    // Bearish divergence: price HH but RSI LH
    if (bars[bCurr].h > bars[bi].h && rsiSeries[rsiSeries.length - 1] < rsiSeries[i]) {
      const rsiDiff = rsiSeries[i] - rsiSeries[rsiSeries.length - 1];
      if (rsiDiff >= 3 && bCurr - bi >= 3) {
        let conf = 60;
        if (rsiDiff > 8) conf += 10;
        if (ctx.rsi && ctx.rsi > 65) conf += 5;
        if (analyzeCandle(curr).bearish) conf += 5;
        const stop = curr.h + 0.2 * ctx.atrDollar;
        const target = ctx.ema9 || curr.c - ctx.atrDollar;
        return makeSignal('RSI_DIVERGENCE', 'MOMENTUM', 'PUT', conf, curr.c, stop, target, curr, null, { rsiDiff: +rsiDiff.toFixed(1) });
      }
    }

    // Bullish divergence: price LL but RSI HL
    if (bars[bCurr].l < bars[bi].l && rsiSeries[rsiSeries.length - 1] > rsiSeries[i]) {
      const rsiDiff = rsiSeries[rsiSeries.length - 1] - rsiSeries[i];
      if (rsiDiff >= 3 && bCurr - bi >= 3) {
        let conf = 60;
        if (rsiDiff > 8) conf += 10;
        if (ctx.rsi && ctx.rsi < 35) conf += 5;
        if (analyzeCandle(curr).bullish) conf += 5;
        const stop = curr.l - 0.2 * ctx.atrDollar;
        const target = ctx.ema9 || curr.c + ctx.atrDollar;
        return makeSignal('RSI_DIVERGENCE', 'MOMENTUM', 'CALL', conf, curr.c, stop, target, curr, null, { rsiDiff: +rsiDiff.toFixed(1) });
      }
    }
    break; // only check most recent swing
  }
  return null;
}

// 18. Break and Retest
function detectBreakAndRetest(ticker, bars, ctx) {
  if (bars.length < 8) return null;
  const curr = bars[bars.length - 1];
  const levels = getKeyLevels(ctx);

  for (const lvl of levels) {
    // Check for break in bars[-8] to bars[-3]
    let brokeAbove = false, brokeBelow = false;
    for (let i = bars.length - 8; i <= bars.length - 3; i++) {
      if (i < 0) continue;
      if (bars[i].c > lvl.price && i > 0 && bars[i - 1].c <= lvl.price) brokeAbove = true;
      if (bars[i].c < lvl.price && i > 0 && bars[i - 1].c >= lvl.price) brokeBelow = true;
    }

    // Retest from above (broke above, pulled back to level, continues up)
    if (brokeAbove && Math.abs(curr.l - lvl.price) / lvl.price < 0.001) {
      if (curr.c > lvl.price && curr.c > curr.o && (curr.v || 0) > ctx.avgVol * 1.2) {
        let conf = 70;
        if (lvl.label.includes('SESSION') || lvl.label.includes('PREV_DAY')) conf += 10;
        if (analyzeCandle(curr).bodyRatio > 0.6) conf += 5;
        const stop = lvl.price - 0.3 * ctx.atrDollar;
        const target = curr.c + (curr.c - lvl.price) * 2;
        return makeSignal('BREAK_RETEST', 'MOMENTUM', 'CALL', conf, curr.c, stop, target, curr, lvl.price, { level: lvl.label });
      }
    }

    // Retest from below (broke below, pulled back to level, continues down)
    if (brokeBelow && Math.abs(curr.h - lvl.price) / lvl.price < 0.001) {
      if (curr.c < lvl.price && curr.c < curr.o && (curr.v || 0) > ctx.avgVol * 1.2) {
        let conf = 70;
        if (lvl.label.includes('SESSION') || lvl.label.includes('PREV_DAY')) conf += 10;
        if (analyzeCandle(curr).bodyRatio > 0.6) conf += 5;
        const stop = lvl.price + 0.3 * ctx.atrDollar;
        const target = curr.c - (lvl.price - curr.c) * 2;
        return makeSignal('BREAK_RETEST', 'MOMENTUM', 'PUT', conf, curr.c, stop, target, curr, lvl.price, { level: lvl.label });
      }
    }
  }
  return null;
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

// Patterns disabled after 15.5-month backtest (Jan 2025 - Apr 2026, 896 trades, real IWM options).
// Keep detector code intact for future re-testing.
export let DISABLED_PATTERNS = new Set([
  'FVG_RETEST',        // collapsed in loose exit model
  'IFVG_RETEST',       // regime-dependent, -59% with filters
  'RSI_DIVERGENCE',    // negative PF
  'DELTA_DIVERGENCE',  // negative PF
  'SWEEP_SETUP',       // subsumed by LIQUIDITY_SWEEP
  'SWEEP_ENTRY',       // subsumed by LIQUIDITY_SWEEP
  'LIQUIDITY_SWEEP',   // +0.69% over 897 trades, 49.6% WR — collapsed -299% in choppy regime
  'PIN_BAR',           // -5.14%, fakeout-prone in both trending + choppy periods
  'DISPLACEMENT',      // -45.2%, only 3 trades, reversal-after-profit losses
]);

// Allow backtest to override disabled patterns for A/B testing
export function setDisabledPatterns(patterns) {
  DISABLED_PATTERNS = new Set(patterns);
}

const ALL_DETECTORS = [
  { name: 'FVG_RETEST',           fn: detectFVGRetest },
  { name: 'IFVG_RETEST',          fn: detectIFVGRetest },       // Inverse FVG: filled gap flips, TTL 120 bars
  { name: 'LIQUIDITY_SWEEP',      fn: detectLiquiditySweep },   // Original standalone (for A/B testing)
  { name: 'SWEEP_SETUP',          fn: detectSweepSetup },       // Phase 1: stores pending sweep (never signals)
  { name: 'SWEEP_ENTRY',          fn: detectSweepEntry },       // Phase 2: confirmation after sweep
  { name: 'AMD',                   fn: detectAMD },
  { name: 'ORDER_BLOCK',          fn: detectOrderBlockRetest },
  { name: 'BREAKER_BLOCK',        fn: detectBreakerBlock },
  { name: 'DISPLACEMENT',         fn: detectDisplacement },
  { name: 'VOLUME_CLIMAX',        fn: detectVolumeClimax },
  { name: 'VOLUME_DRYUP',         fn: detectVolumeDryUp },
  { name: 'DELTA_DIVERGENCE',     fn: detectDeltaDivergence },
  { name: 'ENGULFING_LEVEL',      fn: detectEngulfingAtLevel },
  { name: 'PIN_BAR',              fn: detectPinBar },
  { name: 'INSIDE_BAR',           fn: detectInsideBar },
  { name: 'THREE_BAR_REVERSAL',   fn: detectThreeBarReversal },
  { name: 'DOUBLE_TOP',           fn: detectMicroDoubleTop },
  { name: 'VWAP_SNAP',            fn: detectVWAPSnap },
  { name: 'OPENING_FADE',         fn: detectOpeningDriveFade },
  { name: 'RSI_DIVERGENCE',       fn: detectMomentumDivergence },
  { name: 'BREAK_RETEST',         fn: detectBreakAndRetest },
];

// Default ATR values for common scalp tickers (in dollars)
const DEFAULT_ATR = { SPY: 3.50, QQQ: 4.00, IWM: 2.50 };

/**
 * Detect all scalp patterns on the latest bar.
 *
 * @param {string} ticker
 * @param {Array<{o,h,l,c,v,t}>} bars - rolling bar window (20-30 bars)
 * @param {object} rawCtx - { vwap, sessionOpen, sessionHigh, sessionLow,
 *     prevDayHigh, prevDayLow, orHigh, orLow, atr, upVolRatio, barsFromOpen }
 * @returns {PatternSignal[]}
 */
export function detectScalpPatterns(ticker, bars, rawCtx = {}) {
  if (!bars || bars.length < 5) return [];

  // ── Build enriched context (compute once, share across detectors)
  const closes = bars.map(b => b.c);
  const atrDollar = rawCtx.atr
    ? rawCtx.atr * closes[closes.length - 1]
    : (DEFAULT_ATR[ticker] || 3.0);

  const rsiResult = computeRSI(closes, Math.min(10, closes.length - 1));
  const ema9Val = ema(closes, Math.min(9, closes.length));
  const prevEma9 = closes.length > 2 ? ema(closes.slice(0, -1), Math.min(9, closes.length - 1)) : ema9Val;
  const ema9Slope = (ema9Val && prevEma9) ? (ema9Val > prevEma9 ? 1 : ema9Val < prevEma9 ? -1 : 0) : 0;

  const ctx = {
    ...rawCtx,
    atrDollar,
    avgVol: avgVolume(bars.slice(0, -1)),
    vwap: rawCtx.vwap || computeVWAP(bars),
    rsi: rsiResult.rsi,
    ema9: ema9Val,
    ema9Slope,
  };

  // ── Run all detectors
  const signals = [];
  for (const { name, fn } of ALL_DETECTORS) {
    if (DISABLED_PATTERNS.has(name)) continue;
    if (shouldCooldown(ticker, name)) continue;
    try {
      const sig = fn(ticker, bars, ctx);
      if (sig && sig.confidence >= 60) {
        sig.ticker = ticker;
        signals.push(sig);
      }
    } catch (err) {
      // Individual detector failure shouldn't crash the engine
      console.error(`[SCALPER] ${name} detector error for ${ticker}:`, err.message);
    }
  }

  return signals;
}
