/**
 * Scalp State Manager
 *
 * In-memory per-ticker state that persists across bars within a session.
 * Tracks FVG zones, order blocks, swing points, pattern history,
 * and session stats for the scalper pattern detector.
 *
 * Reset at market open each day via resetAllScalpSessions().
 */

const SCALP_TICKERS = ['SPY', 'QQQ', 'IWM'];
const MAX_PATTERN_HISTORY = 50;
const COOLDOWN_BARS = 3; // min bars between same pattern/ticker
const PATTERN_TTL_MS = 5 * 60 * 1000; // patterns expire after 5 min

// ── Per-ticker state ──────────────────────────────────────────────────────────

const tickerState = new Map();

function emptyTickerState(ticker) {
  return {
    ticker,
    activeFVGs: [],          // { top, bottom, direction, createdIdx, createdAt }
    activeIFVGs: [],         // { top, bottom, direction, width, filledIdx } — filled FVGs flipped
    activeOrderBlocks: [],   // { top, bottom, direction, impulseRange, createdIdx, createdAt }
    swingPoints: [],         // { price, type:'HIGH'|'LOW', barIdx, time }
    pendingSweeps: [],       // { direction, sweepLevel, consolHigh, consolLow, barIdx, time }
    patternHistory: [],      // PatternSignal[]
    sessionStats: {
      fired: 0,
      byPattern: {},
      byDirection: { CALL: 0, PUT: 0 },
    },
    lastSignalTime: {},      // pattern -> timestamp (cooldown)
    barCount: 0,             // total bars seen this session
  };
}

// ── Init / Reset ──────────────────────────────────────────────────────────────

export function initScalpSession(ticker) {
  tickerState.set(ticker, emptyTickerState(ticker));
}

export function resetAllScalpSessions() {
  for (const ticker of SCALP_TICKERS) {
    initScalpSession(ticker);
  }
  console.log(`[SCALPER] Sessions reset for ${SCALP_TICKERS.join(', ')}`);
}

// ── State Updates (called per bar) ────────────────────────────────────────────

/**
 * Update scalp state with new bar data.
 * Maintains FVG zones, order blocks, and swing points.
 */
export function updateScalpState(ticker, bars, context) {
  let ts = tickerState.get(ticker);
  if (!ts) {
    initScalpSession(ticker);
    ts = tickerState.get(ticker);
  }
  ts.barCount++;
  const barIdx = ts.barCount;

  // ── Update swing points (simple 3-bar swing detection)
  if (bars.length >= 3) {
    const b1 = bars[bars.length - 3];
    const b2 = bars[bars.length - 2];
    const b3 = bars[bars.length - 1];

    // Swing high: middle bar's high > both neighbors
    if (b2.h > b1.h && b2.h > b3.h) {
      ts.swingPoints.push({ price: b2.h, type: 'HIGH', barIdx: barIdx - 1, time: b2.t });
    }
    // Swing low: middle bar's low < both neighbors
    if (b2.l < b1.l && b2.l < b3.l) {
      ts.swingPoints.push({ price: b2.l, type: 'LOW', barIdx: barIdx - 1, time: b2.t });
    }
    // Keep last 20 swing points
    if (ts.swingPoints.length > 20) ts.swingPoints = ts.swingPoints.slice(-20);
  }

  // ── Detect new FVGs (3-candle imbalance)
  if (bars.length >= 3) {
    const b0 = bars[bars.length - 3];
    const b1 = bars[bars.length - 2];
    const b2 = bars[bars.length - 1];
    const price = b2.c;
    const midBodyRatio = (b1.h - b1.l) > 0 ? Math.abs(b1.c - b1.o) / (b1.h - b1.l) : 0;

    // Bullish FVG: bar[0].high < bar[2].low (gap up)
    if (b0.h < b2.l && midBodyRatio > 0.5) {
      const width = b2.l - b0.h;
      if (price > 0 && width / price >= 0.0002) { // min 0.02% gap
        ts.activeFVGs.push({
          top: b2.l, bottom: b0.h, direction: 'CALL',
          width, createdIdx: barIdx, createdAt: Date.now(),
        });
      }
    }
    // Bearish FVG: bar[0].low > bar[2].high (gap down)
    if (b0.l > b2.h && midBodyRatio > 0.5) {
      const width = b0.l - b2.h;
      if (price > 0 && width / price >= 0.0002) {
        ts.activeFVGs.push({
          top: b0.l, bottom: b2.h, direction: 'PUT',
          width, createdIdx: barIdx, createdAt: Date.now(),
        });
      }
    }
  }

  // ── Detect new order blocks (last opposing candle before impulse)
  if (bars.length >= 5) {
    const recent = bars.slice(-5);
    const avgRange = recent.reduce((s, b) => s + (b.h - b.l), 0) / recent.length;

    // Check if last 3 bars form an impulse (all same direction, combined range > 1.5x avg)
    const last3 = bars.slice(-3);
    const allBullish = last3.every(b => b.c > b.o);
    const allBearish = last3.every(b => b.c < b.o);
    const impulseRange = last3[last3.length - 1].c - last3[0].o;

    if (allBullish && Math.abs(impulseRange) > 1.5 * avgRange && bars.length >= 4) {
      const obCandle = bars[bars.length - 4];
      if (obCandle.c < obCandle.o) { // must be opposing (bearish before bullish impulse)
        ts.activeOrderBlocks.push({
          top: Math.max(obCandle.o, obCandle.c),
          bottom: Math.min(obCandle.o, obCandle.c),
          direction: 'CALL', // bullish OB = support
          impulseRange: Math.abs(impulseRange),
          createdIdx: barIdx,
          createdAt: Date.now(),
        });
      }
    }
    if (allBearish && Math.abs(impulseRange) > 1.5 * avgRange && bars.length >= 4) {
      const obCandle = bars[bars.length - 4];
      if (obCandle.c > obCandle.o) { // opposing (bullish before bearish impulse)
        ts.activeOrderBlocks.push({
          top: Math.max(obCandle.o, obCandle.c),
          bottom: Math.min(obCandle.o, obCandle.c),
          direction: 'PUT', // bearish OB = resistance
          impulseRange: Math.abs(impulseRange),
          createdIdx: barIdx,
          createdAt: Date.now(),
        });
      }
    }
  }

  // ── Expire old FVGs (>15 bars old or filled → promote filled to IFVG)
  const price = bars.length > 0 ? bars[bars.length - 1].c : 0;
  ts.activeFVGs = ts.activeFVGs.filter(fvg => {
    if (barIdx - fvg.createdIdx > 30) return false; // too old
    // Check if filled (price passed through) → becomes IFVG
    const filled =
      (fvg.direction === 'CALL' && price < fvg.bottom) ||
      (fvg.direction === 'PUT' && price > fvg.top);
    if (filled) {
      // Flip direction: bullish FVG that got filled = bearish IFVG (now resistance)
      ts.activeIFVGs.push({
        top: fvg.top,
        bottom: fvg.bottom,
        direction: fvg.direction === 'CALL' ? 'PUT' : 'CALL',
        width: fvg.width,
        filledIdx: barIdx,
      });
      return false; // remove from active FVGs
    }
    return true;
  });

  // ── Expire old IFVGs (>120 bars / 2 hours after fill)
  ts.activeIFVGs = ts.activeIFVGs.filter(ifvg => barIdx - ifvg.filledIdx <= 120);

  // ── Expire old OBs (>20 bars old)
  ts.activeOrderBlocks = ts.activeOrderBlocks.filter(ob => barIdx - ob.createdIdx <= 20);

  // ── Expire old patterns
  const now = Date.now();
  ts.patternHistory = ts.patternHistory.filter(p =>
    now - new Date(p.timestamp).getTime() < PATTERN_TTL_MS
  );
}

// ── Pattern Recording ─────────────────────────────────────────────────────────

export function addDetectedPattern(ticker, signal) {
  const ts = tickerState.get(ticker);
  if (!ts) return;

  ts.patternHistory.push(signal);
  if (ts.patternHistory.length > MAX_PATTERN_HISTORY) {
    ts.patternHistory = ts.patternHistory.slice(-MAX_PATTERN_HISTORY);
  }

  ts.sessionStats.fired++;
  ts.sessionStats.byPattern[signal.pattern] = (ts.sessionStats.byPattern[signal.pattern] || 0) + 1;
  ts.sessionStats.byDirection[signal.direction] = (ts.sessionStats.byDirection[signal.direction] || 0) + 1;

  ts.lastSignalTime[signal.pattern] = ts.barCount;
}

/**
 * Check if a pattern should be cooled down (same pattern fired too recently).
 */
export function shouldCooldown(ticker, pattern) {
  const ts = tickerState.get(ticker);
  if (!ts) return false;
  const lastBar = ts.lastSignalTime[pattern];
  if (lastBar == null) return false;
  return (ts.barCount - lastBar) < COOLDOWN_BARS;
}

// ── Sweep Events ─────────────────────────────────────────────────────────────

const SWEEP_TTL_BARS = 3; // confirmation must come within 3 bars of sweep

export function addPendingSweep(ticker, sweep) {
  const ts = tickerState.get(ticker);
  if (!ts) return;
  ts.pendingSweeps.push({ ...sweep, barIdx: ts.barCount });
  // Keep only last 5
  if (ts.pendingSweeps.length > 5) ts.pendingSweeps = ts.pendingSweeps.slice(-5);
}

export function getPendingSweeps(ticker) {
  const ts = tickerState.get(ticker);
  if (!ts) return [];
  // Return non-expired sweeps (within TTL bars)
  return ts.pendingSweeps.filter(s => ts.barCount - s.barIdx <= SWEEP_TTL_BARS);
}

export function expireSweep(ticker, sweep) {
  const ts = tickerState.get(ticker);
  if (!ts) return;
  ts.pendingSweeps = ts.pendingSweeps.filter(s => s !== sweep);
}

// ── Getters ──────────────────────────────────────────────────────────────────

export function getActiveFVGs(ticker) {
  return tickerState.get(ticker)?.activeFVGs || [];
}

export function getActiveIFVGs(ticker) {
  return tickerState.get(ticker)?.activeIFVGs || [];
}

export function getActiveOrderBlocks(ticker) {
  return tickerState.get(ticker)?.activeOrderBlocks || [];
}

export function getSwingPoints(ticker) {
  return tickerState.get(ticker)?.swingPoints || [];
}

/**
 * Get all active (non-expired) pattern signals across all scalp tickers.
 */
export function getActiveScalpPatterns() {
  const now = Date.now();
  const all = [];
  for (const ticker of SCALP_TICKERS) {
    const ts = tickerState.get(ticker);
    if (!ts) continue;
    for (const p of ts.patternHistory) {
      if (now - new Date(p.timestamp).getTime() < PATTERN_TTL_MS) {
        all.push(p);
      }
    }
  }
  return all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Get aggregated session stats.
 */
export function getScalpSessionStats() {
  const stats = {
    totalFired: 0,
    byPattern: {},
    byTicker: {},
    byDirection: { CALL: 0, PUT: 0 },
    activeFVGs: 0,
    activeOBs: 0,
  };

  for (const ticker of SCALP_TICKERS) {
    const ts = tickerState.get(ticker);
    if (!ts) continue;
    stats.totalFired += ts.sessionStats.fired;
    stats.byTicker[ticker] = ts.sessionStats.fired;
    stats.byDirection.CALL += ts.sessionStats.byDirection.CALL;
    stats.byDirection.PUT += ts.sessionStats.byDirection.PUT;
    stats.activeFVGs += ts.activeFVGs.length;
    stats.activeOBs += ts.activeOrderBlocks.length;

    for (const [pattern, count] of Object.entries(ts.sessionStats.byPattern)) {
      stats.byPattern[pattern] = (stats.byPattern[pattern] || 0) + count;
    }
  }

  return stats;
}

/**
 * Get levels and zones for a specific ticker (for scanner display).
 */
export function getScalpLevels(ticker) {
  const ts = tickerState.get(ticker);
  if (!ts) return { fvgs: [], orderBlocks: [], swingPoints: [] };
  return {
    fvgs: ts.activeFVGs,
    orderBlocks: ts.activeOrderBlocks,
    swingPoints: ts.swingPoints.slice(-10),
  };
}

export { SCALP_TICKERS };
