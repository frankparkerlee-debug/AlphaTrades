/**
 * Market session classifier.
 * Replaces the binary isMarketOpen() gate with a nuanced
 * session type that adjusts scoring behavior after hours.
 *
 * Sessions:
 *   PRE_MARKET    4:00am - 9:30am ET  — light scoring, directional signals only
 *   REGULAR       9:30am - 4:00pm ET  — full scoring, all signal tiers
 *   POST_MARKET   4:00pm - 8:00pm ET  — light scoring, directional signals only
 *   OVERNIGHT     8:00pm - 4:00am ET  — monitoring only, no signals
 *   WEEKEND       Saturday/Sunday     — no signals
 */

import { nowET, toET } from '../utils/time.js';

export const SESSION = {
  PRE_MARKET:  'PRE_MARKET',
  REGULAR:     'REGULAR',
  POST_MARKET: 'POST_MARKET',
  OVERNIGHT:   'OVERNIGHT',
  WEEKEND:     'WEEKEND',
};

export function getMarketSession(date = new Date()) {
  const et = toET(date);
  const day = et.getDay();

  // Weekend
  if (day === 0 || day === 6) return SESSION.WEEKEND;

  const mins = et.getHours() * 60 + et.getMinutes();

  if (mins >= 240  && mins < 570)  return SESSION.PRE_MARKET;   // 4am - 9:30am
  if (mins >= 570  && mins < 960)  return SESSION.REGULAR;      // 9:30am - 4pm
  if (mins >= 960  && mins < 1200) return SESSION.POST_MARKET;  // 4pm - 8pm
  return SESSION.OVERNIGHT;                                       // 8pm - 4am
}

export function isScoreable(session) {
  return session === SESSION.REGULAR ||
         session === SESSION.PRE_MARKET ||
         session === SESSION.POST_MARKET;
}

/**
 * Session-specific scoring adjustments.
 * Extended hours have lower liquidity, wider spreads, more noise.
 * The system scores more conservatively outside regular hours.
 */
export function getSessionModifiers(session) {
  switch (session) {
    case SESSION.REGULAR:
      return {
        gradeCapOverride: null,     // no override — full scoring
        positionSizeMultiplier: 1.0,
        minGrade: 'B',
        signalLabel: '',
        scoreNote: null,
      };

    case SESSION.PRE_MARKET:
      return {
        gradeCapOverride: 'B+',     // cap at B+ — extended hours more volatile
        positionSizeMultiplier: 0.5, // half size — wider spreads
        minGrade: 'B+',
        signalLabel: '🌅 PRE-MKT',
        scoreNote: 'Extended hours — reduced sizing, B+ cap',
      };

    case SESSION.POST_MARKET:
      return {
        gradeCapOverride: 'B+',
        positionSizeMultiplier: 0.5,
        minGrade: 'B+',
        signalLabel: '🌆 POST-MKT',
        scoreNote: 'Extended hours — reduced sizing, B+ cap',
      };

    default:
      return null; // no trading
  }
}
