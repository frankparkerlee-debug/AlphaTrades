import { getMarketData, getNewsEvents } from '../data/state.js';
import { pctChange } from '../utils/math.js';
import logger from '../utils/logger.js';

/**
 * Compute confluence score for a signal.
 * Confluence = multiple independent catalysts aligning on same stock.
 * Score 0-4. Score >= 3 triggers CONFLUENCE alert on dashboard.
 */
export function computeConfluenceScore(params) {
  const {
    ticker,
    direction,
    newsEvents,
    marketAlignedCount,   // from market.js result
    isLeaderSignal,       // is this a cluster leader firing?
    atrMultiple,          // from pa.js result
    relativeVolume,       // from volume.js result
    tickerState,
  } = params;

  let score    = 0;
  const factors = [];

  // Factor 1: Strong news catalyst present
  const strongNews = newsEvents.filter(e => Math.abs(e.polarity) >= 2);
  if (strongNews.length > 0) {
    score++;
    factors.push(`STRONG_NEWS: ${strongNews[0].catalyst?.type}`);
  }

  // Factor 2: All three market layers aligned
  if (marketAlignedCount === 3) {
    score++;
    factors.push('MARKET_TRIPLE_ALIGNED');
  }

  // Factor 3: Part of active cluster propagation OR leader signal
  if (isLeaderSignal) {
    score++;
    factors.push('CLUSTER_LEADER');
  }

  // Factor 4: Pre-market gap confirms direction (proxy: high ATR + session open gap)
  if (tickerState && tickerState.prevClose > 0) {
    const premarketGap = Math.abs(pctChange(tickerState.sessionOpen, tickerState.prevClose));
    const gapConfirms = (direction === 'CALL' && tickerState.sessionOpen > tickerState.prevClose) ||
                        (direction === 'PUT'  && tickerState.sessionOpen < tickerState.prevClose);
    if (premarketGap > 0.005 && gapConfirms) {
      score++;
      factors.push(`PREMARKET_GAP: ${(premarketGap * 100).toFixed(2)}%`);
    }
  }

  if (score >= 3) {
    logger.info(`CONFLUENCE ${score}: ${ticker} ${direction} — ${factors.join(' | ')}`);
  }

  return { score, factors };
}

/**
 * Confluence alert levels for dashboard display
 */
export function getConfluenceLevel(score) {
  if (score >= 4) return { level: 'FULL',   label: '⚡ FULL CONFLUENCE',   color: 'gold'   };
  if (score >= 3) return { level: 'HIGH',   label: '⚡ CONFLUENCE 3',      color: 'yellow' };
  if (score >= 2) return { level: 'MEDIUM', label: 'Confluence 2',         color: 'blue'   };
  return           { level: 'LOW',    label: '',                            color: 'none'   };
}
