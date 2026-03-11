import { pctChange } from '../utils/math.js';

/**
 * Determines CALL or PUT from price action before any scoring runs.
 * Returns null if direction is ambiguous — no signal fired.
 */
export function determineDirection(params) {
  const {
    currentPrice,
    prevClose,
    currentVwap,
    upVolRatio,      // 0-1, ratio of up volume to total volume
    qqqChangePct,    // QQQ % change on the day
  } = params;

  // Step 1: Primary direction from price vs prior close
  const movePct = pctChange(currentPrice, prevClose);
  if (movePct === 0) return null;
  const rawDirection = movePct > 0 ? 'CALL' : 'PUT';

  // Step 2: VWAP confirmation
  const aboveVwap = currentPrice > currentVwap;
  const vwapConfirms = (rawDirection === 'CALL' && aboveVwap) ||
                       (rawDirection === 'PUT'  && !aboveVwap);

  // Step 3: Volume directional confirmation
  const volConfirms = (rawDirection === 'CALL' && upVolRatio > 0.55) ||
                      (rawDirection === 'PUT'  && upVolRatio < 0.45);

  // Step 4: Confidence gate — both must confirm for HIGH confidence
  if (!vwapConfirms && !volConfirms) return null; // ambiguous tape

  const confidence = (vwapConfirms && volConfirms) ? 'HIGH' : 'LOW';

  // Step 5: If LOW confidence AND market strongly opposes — discard
  const marketOpposing = (rawDirection === 'CALL' && qqqChangePct < -0.003) ||
                         (rawDirection === 'PUT'  && qqqChangePct >  0.003);

  if (confidence === 'LOW' && marketOpposing) return null;

  return {
    direction: rawDirection,
    confidence,
    vwapConfirms,
    volConfirms,
    movePct,
  };
}
