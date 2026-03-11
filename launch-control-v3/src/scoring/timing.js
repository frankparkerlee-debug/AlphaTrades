import { minutesSinceOpen, floorTo15Min } from '../utils/time.js';

/**
 * Timing pillar — max 5 pts (gate function primarily)
 * Caps grade via B- on disqualifying windows
 */
export function computeTimingScore(params) {
  const {
    currentTime,
    openingChopMinutes = 15,
    vixCurrent = 18,
    isPostAnnouncement = false,
    minsSinceAnnouncement = 0,
    postFomcQuality = 0.75,
    postCpiQuality = 0.75,
    announcementType = null, // 'FOMC' | 'CPI' | 'NFP'
    bestWindows = [],
    worstWindows = [],
  } = params;

  const minsSinceOpen = minutesSinceOpen(currentTime);
  const windowKey = floorTo15Min(currentTime);

  // Hard disqualification — B- cap
  if (minsSinceOpen < openingChopMinutes) {
    return { score: 0, cap: 'B-', bonus: 0, reason: 'OPENING_CHOP' };
  }
  if (minsSinceOpen >= 390) { // 3:00pm ET
    return { score: 0, cap: 'B-', bonus: 0, reason: 'LATE_SESSION' };
  }
  if (vixCurrent > 35) {
    return { score: 0, cap: 'B-', bonus: 0, reason: 'VIX_SPIKE' };
  }
  // Lunch window 11:30am-1pm
  if (minsSinceOpen >= 120 && minsSinceOpen < 210) {
    return { score: 2, cap: 'B-', bonus: 0, reason: 'LUNCH_WINDOW' };
  }

  // Post-announcement window
  if (isPostAnnouncement) {
    if (minsSinceAnnouncement < 15) {
      return { score: 0, cap: 'B-', bonus: 0, reason: 'ANNOUNCEMENT_WINDOW_TOO_EARLY' };
    }
    if (minsSinceAnnouncement <= 90) {
      const qual = announcementType === 'FOMC' ? postFomcQuality : postCpiQuality;
      return {
        score: Math.round(5 * qual),
        cap: null,
        bonus: 10,
        reason: `POST_${announcementType || 'ANNOUNCEMENT'}_PRIME`,
      };
    }
  }

  // Standard prime window
  let score = 5;

  // Per-stock window adjustments
  const bw = Array.isArray(bestWindows) ? bestWindows : JSON.parse(bestWindows || '[]');
  const ww = Array.isArray(worstWindows) ? worstWindows : JSON.parse(worstWindows || '[]');
  if (bw.includes(windowKey)) score = Math.min(5, score + 1);
  if (ww.includes(windowKey)) score = Math.max(0, score - 2);

  return { score, cap: null, bonus: 0, reason: 'STANDARD' };
}
