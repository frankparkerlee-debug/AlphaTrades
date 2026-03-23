import { clamp } from '../utils/math.js';
import { floorTo15Min, minutesSinceOpen } from '../utils/time.js';

/**
 * Volume pillar — max 30 pts
 * CRITICAL: uses per-window baseline, NOT daily average
 *
 * Flow absorption: uses real buy/sell order flow data to detect
 * whether a move is being absorbed (buyers stepping into a drop)
 * or distributed (sellers dumping into a rally).
 */
export function computeVolumeScore(params) {
  const {
    direction,
    currentBarVolume,
    upVolRatio,           // 0-1 ratio of up volume
    avgVolByWindow,       // JSON object from equity_profiles
    volToMoveCorrelation = 0.60,
    currentTime,          // Date object
    flowData,             // { avgBuyRatio, totalBuy, totalSell, minutes } from getRecentFlow()
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

  // ── Flow Absorption Bonus/Penalty ────────────────────────────────────
  // Uses real buy/sell taker-side data from trade stream.
  // Answers: "Is anyone actually buying this dip?" (or selling this rally?)
  let absorptionAdj = 0;
  let absorptionSignal = null;

  if (flowData && flowData.avgBuyRatio !== null && flowData.minutes >= 3) {
    const buyRatio = flowData.avgBuyRatio;

    if (direction === 'CALL') {
      // CALL: we want buyers stepping in (high buy ratio = absorption)
      if (buyRatio >= 0.60) {
        absorptionAdj = 5;   // strong absorption — buyers in control
        absorptionSignal = 'STRONG_ABSORPTION';
      } else if (buyRatio >= 0.55) {
        absorptionAdj = 3;   // moderate absorption
        absorptionSignal = 'ABSORPTION';
      } else if (buyRatio <= 0.35) {
        absorptionAdj = -4;  // pure selling — nobody buying this dip
        absorptionSignal = 'NO_ABSORPTION';
        flags.push('no_absorption');
      } else if (buyRatio <= 0.40) {
        absorptionAdj = -2;  // weak buying
        absorptionSignal = 'WEAK_BUYING';
      }
    } else {
      // PUT: we want sellers in control (low buy ratio = distribution)
      if (buyRatio <= 0.35) {
        absorptionAdj = 5;   // strong distribution — sellers in control
        absorptionSignal = 'STRONG_DISTRIBUTION';
      } else if (buyRatio <= 0.40) {
        absorptionAdj = 3;   // moderate distribution
        absorptionSignal = 'DISTRIBUTION';
      } else if (buyRatio >= 0.65) {
        absorptionAdj = -4;  // buyers still dominant — don't short into buying
        absorptionSignal = 'BUYING_PRESSURE';
        flags.push('buying_pressure');
      } else if (buyRatio >= 0.60) {
        absorptionAdj = -2;
        absorptionSignal = 'MILD_BUYING';
      }
    }
  }

  const raw = base * dirMult * corrMult * timeAdj + absorptionAdj;
  const score = clamp(Math.round(raw), 0, 30);

  return {
    score,
    relativeVol: parseFloat(relativeVol.toFixed(2)),
    windowKey,
    windowAvg,
    absorptionSignal,
    absorptionAdj,
    flowBuyRatio: flowData?.avgBuyRatio ?? null,
    flags,
  };
}
