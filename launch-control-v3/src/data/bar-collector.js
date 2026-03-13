/**
 * Bar Collector — provides recent bar history for trend analysis.
 * Pulls from in-memory state (populated by WebSocket stream).
 */

import { getTickerState } from './state.js';

/**
 * Get the most recent N bars for a ticker.
 * @param {string} ticker
 * @param {number} count - number of bars (default 20)
 * @returns {Array} - [{o, h, l, c, v, t}, ...]
 */
export function getRecentBars(ticker, count = 20) {
  const state = getTickerState(ticker);
  if (!state || !state.bars || state.bars.length === 0) return [];
  return state.bars.slice(-count);
}
