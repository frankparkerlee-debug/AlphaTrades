/**
 * Momentum Freshness Scorer
 * 
 * Core insight: we need to catch moves in bars 1-5, not bar 47.
 * Scores based on RECENT price acceleration, not cumulative daily move.
 * 
 * Outputs:
 *   momentumScore    — 0-35 (replaces PA score)
 *   freshness        — FRESH / DEVELOPING / EXTENDED / LATE / EXHAUSTED
 *   entryRisk        — LOW / MODERATE / HIGH / EXTREME
 *   barsInMove       — how many bars the move has been running
 *   moveFromOpen     — % move from session open (not prevClose)
 *   recentAccel      — % move in last 2 bars (the NOW signal)
 *   exhaustion       — true if showing reversal signals
 */

/**
 * Analyze bar history for momentum freshness
 * @param {Array} bars - last 20 bars [{o,h,l,c,v,t}]
 * @param {number} sessionOpen - price at session open
 * @param {number} prevClose - yesterday's close
 * @param {number} atr - 20-day ATR as decimal (e.g. 0.025 = 2.5%)
 * @param {string} direction - 'CALL' or 'PUT'
 */
export function analyzeMomentum(bars, sessionOpen, prevClose, atr, direction) {
  if (!bars || bars.length < 2) {
    return nullMomentum();
  }

  const latest     = bars[bars.length - 1];
  const prev1      = bars[bars.length - 2];
  const prev2      = bars.length >= 3 ? bars[bars.length - 3] : prev1;
  const currentBar = latest.c;
  const openRef    = sessionOpen || (bars[0]?.o) || prevClose;

  // Direction multiplier — PUT moves are negative price moves
  const mult = direction === 'CALL' ? 1 : -1;

  // ── MOVE FROM SESSION OPEN ──────────────────────────────
  const moveFromOpen = openRef > 0 ? ((currentBar - openRef) / openRef) * mult : 0;

  // ── RECENT ACCELERATION (last 2 bars) ──────────────────
  // This is the critical signal — is price moving NOW?
  const recentMove1 = prev1.c > 0 ? ((latest.c - prev1.c) / prev1.c) * mult : 0;
  const recentMove2 = prev2.c > 0 ? ((prev1.c - prev2.c) / prev2.c) * mult : 0;
  const recentAccel = (recentMove1 + recentMove2) / 2;

  // ── HOW MANY BARS HAS THIS MOVE BEEN RUNNING? ──────────
  let barsInMove = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    const barMove = bar.c > bar.o ? 1 : -1; // bullish or bearish bar
    const expectedMove = direction === 'CALL' ? 1 : -1;
    if (barMove === expectedMove) {
      barsInMove++;
    } else {
      break; // streak broken
    }
  }

  // ── VOLUME SURGE ANALYSIS ───────────────────────────────
  // Is current bar volume significantly above recent average?
  const recentVols = bars.slice(-5).map(b => b.v || 0);
  const avgRecentVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const latestVol = latest.v || 0;
  const volSurge = avgRecentVol > 0 ? latestVol / avgRecentVol : 1;

  // ── EXHAUSTION SIGNALS ──────────────────────────────────
  // Long upper wick on CALL = selling pressure at highs
  // Long lower wick on PUT = buying pressure at lows
  const barRange = latest.h - latest.l;
  const upperWick = latest.h - Math.max(latest.o, latest.c);
  const lowerWick = Math.min(latest.o, latest.c) - latest.l;
  const wickRatio = barRange > 0
    ? (direction === 'CALL' ? upperWick / barRange : lowerWick / barRange)
    : 0;
  const exhaustion = wickRatio > 0.6; // more than 60% wick = exhaustion signal

  // ── FRESHNESS CLASSIFICATION ────────────────────────────
  const atrPct = atr || 0.025;
  const moveInATRs = moveFromOpen / atrPct;

  let freshness;
  if (barsInMove <= 2 && recentAccel > 0 && moveInATRs < 1.0) {
    freshness = 'FRESH';       // move just starting — ideal entry
  } else if (barsInMove <= 4 && recentAccel > 0 && moveInATRs < 1.5) {
    freshness = 'DEVELOPING';  // move in progress — still good entry
  } else if (moveInATRs >= 1.5 && moveInATRs < 2.5 && recentAccel > 0) {
    freshness = 'EXTENDED';    // move mature but still moving — caution
  } else if (moveInATRs >= 2.5 || barsInMove > 8) {
    freshness = 'LATE';        // move well established — high reversal risk
  } else if (exhaustion || recentAccel < 0) {
    freshness = 'EXHAUSTED';   // showing reversal signals — skip
  } else {
    freshness = 'DEVELOPING';
  }

  // ── ENTRY RISK ──────────────────────────────────────────
  let entryRisk;
  if (freshness === 'FRESH' && !exhaustion) {
    entryRisk = 'LOW';
  } else if (freshness === 'DEVELOPING' && volSurge > 1.5) {
    entryRisk = 'LOW';
  } else if (freshness === 'DEVELOPING') {
    entryRisk = 'MODERATE';
  } else if (freshness === 'EXTENDED') {
    entryRisk = 'HIGH';
  } else {
    entryRisk = 'EXTREME';
  }

  // ── MOMENTUM SCORE (0-35) ───────────────────────────────
  // Rewards: freshness, acceleration, volume surge
  // Penalizes: late entries, exhaustion, fading momentum

  let score = 0;

  // Recent acceleration component (0-18)
  // This is the most important — is price moving RIGHT NOW?
  const accelScore = Math.min(18, Math.max(0, Math.round(recentAccel / atrPct * 20)));
  score += accelScore;

  // Freshness bonus/penalty (0-10)
  const freshnessMap = { FRESH: 10, DEVELOPING: 7, EXTENDED: 3, LATE: 0, EXHAUSTED: 0 };
  score += freshnessMap[freshness] || 0;

  // Volume surge bonus (0-7)
  const volBonus = Math.min(7, Math.max(0, Math.round((volSurge - 1) * 3.5)));
  score += volBonus;

  // Exhaustion penalty
  if (exhaustion) score = Math.max(0, score - 8);

  score = Math.min(35, Math.max(0, score));

  return {
    momentumScore: score,
    freshness,
    entryRisk,
    barsInMove,
    moveFromOpen: parseFloat((moveFromOpen * 100).toFixed(3)),
    recentAccel:  parseFloat((recentAccel * 100).toFixed(3)),
    volSurge:     parseFloat(volSurge.toFixed(2)),
    exhaustion,
    moveInATRs:   parseFloat(moveInATRs.toFixed(2)),
  };
}

function nullMomentum() {
  return {
    momentumScore: 0,
    freshness: 'UNKNOWN',
    entryRisk: 'EXTREME',
    barsInMove: 0,
    moveFromOpen: 0,
    recentAccel: 0,
    volSurge: 1,
    exhaustion: false,
    moveInATRs: 0,
  };
}

/**
 * Hard gates based on momentum freshness
 * Returns true if signal should be skipped entirely
 */
export function shouldSkipOnFreshness(freshness, entryRisk) {
  if (freshness === 'EXHAUSTED') return true;
  if (freshness === 'LATE' && entryRisk === 'EXTREME') return true;
  return false;
}
