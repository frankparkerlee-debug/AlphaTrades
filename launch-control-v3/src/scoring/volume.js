import { clamp } from '../utils/math.js';
import { floorTo15Min, minutesSinceOpen } from '../utils/time.js';

/**
 * Volume pillar — max 30 pts
 * CRITICAL: uses per-window baseline, NOT daily average
 */
export function computeVolumeScore(params) {
  const {
    direction,
    currentBarVolume,
    upVolRatio,           // 0-1 ratio of up volume
    avgVolByWindow,       // JSON object from equity_profiles
    volToMoveCorrelation = 0.60,
    currentTime,          // Date object
  } = params;

  const flags = [];

  // Per-window relative volume — CRITICAL FIX
  const windowKey = floorTo15Min(currentTime);
  const windowAvg = avgVolByWindow?.[windowKey] || 0;

  let relativeVol;
  if (!windowAvg || windowAvg === 0) {
    relativeVol = 1.0;
    flags.push(`VOLUME_BASELINE_MISSING — window ${windowKey} not seeded`);
  } else {
    relativeVol = currentBarVolume / windowAvg;
  }

  // Base score from relative volume
  let base = 0;
  if (relativeVol >= 3.0)      base = 30;
  else if (relativeVol >= 2.0) base = 22;
  else if (relativeVol >= 1.5) base = 14;
  else if (relativeVol >= 1.2) base = 7;
  else                          base = 0;

  // Directional alignment multiplier
  const dirScore = direction === 'CALL' ? upVolRatio : (1 - upVolRatio);
  let dirMult = 0.20;
  if (dirScore >= 0.70)      dirMult = 1.30;
  else if (dirScore >= 0.55) dirMult = 1.10;
  else if (dirScore >= 0.45) dirMult = 0.90;
  else if (dirScore >= 0.30) dirMult = 0.50;

  // Vol-to-move correlation multiplier
  let corrMult = 0.75;
  if (volToMoveCorrelation > 0.75)      corrMult = 1.20;
  else if (volToMoveCorrelation > 0.50) corrMult = 1.00;

  // Time-of-day adjustment
  const minsSinceOpen = minutesSinceOpen(currentTime);
  let timeAdj = 1.00;
  if (minsSinceOpen < 30)       timeAdj = 0.60; // opening vol is structural
  else if (minsSinceOpen < 120) timeAdj = 1.10;
  else if (minsSinceOpen < 210) timeAdj = 1.20; // lunch spike significant
  else if (minsSinceOpen < 330) timeAdj = 1.00;
  else                           timeAdj = 0.70;

  const raw = base * dirMult * corrMult * timeAdj;
  const score = clamp(Math.round(raw), 0, 30);

  return {
    score,
    relativeVol: parseFloat(relativeVol.toFixed(2)),
    windowKey,
    windowAvg,
    flags,
  };
}
