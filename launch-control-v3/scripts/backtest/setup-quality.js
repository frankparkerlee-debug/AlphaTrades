/**
 * Setup Quality Scorer
 *
 * Scores each signal 0-100 on how "textbook" the setup was before entry.
 * Each strategy has its own rubric of factors with weights.
 *
 * A high setup quality score means the entry conditions were ideal.
 * Correlation between setup quality and trade outcome validates the rubric.
 */

// ── Factor Scoring Helpers ───────────────────────────────────────────────────

function scoreCandle(candleType) {
  if (!candleType) return 30;
  if (candleType.includes('MARUBOZU')) return 100;
  if (candleType.includes('STRONG')) return 75;
  if (candleType === 'HAMMER' || candleType === 'INVERTED_HAMMER') return 70;
  if (candleType === 'DOJI') return 40;
  return 50;
}

function scoreEngulfing(engulfing) {
  return engulfing ? 100 : 0;
}

function scoreStabilized(stabilized) {
  return stabilized ? 100 : 0;
}

function scoreConfluence(confluenceCount) {
  if (confluenceCount == null) return 0;
  if (confluenceCount >= 5) return 100;
  if (confluenceCount >= 4) return 85;
  if (confluenceCount >= 3) return 65;
  if (confluenceCount >= 2) return 40;
  return 20;
}

function scoreTrendBullish(trend) {
  if (!trend) return 50;
  if (trend === 'UPTREND') return 90;
  if (trend === 'RANGE') return 60;
  if (trend === 'DOWNTREND') return 20;
  return 50;
}

function scoreTrendBearish(trend) {
  if (!trend) return 50;
  if (trend === 'DOWNTREND') return 90;
  if (trend === 'RANGE') return 60;
  if (trend === 'UPTREND') return 20;
  return 50;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

// ── Per-Strategy Rubrics ─────────────────────────────────────────────────────

export const SETUP_RUBRICS = {
  GAP_REVERSAL: {
    factors: [
      { name: 'gap_pct', weight: 20, score: (m) => {
        const absGap = Math.abs(m.gap_pct || 0);
        if (absGap >= 2.5 && absGap <= 3.0) return 100;
        if (absGap >= 2.0) return 75;
        return 40;
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'stabilized', weight: 15, score: (m) => scoreStabilized(m.stabilized) },
      { name: 'trend', weight: 15, score: (m) => scoreTrendBullish(m.trend) },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  GAP_UP_REVERSAL: {
    factors: [
      { name: 'gap_pct', weight: 20, score: (m) => {
        const absGap = Math.abs(m.gap_pct || 0);
        if (absGap >= 2.5 && absGap <= 3.0) return 100;
        if (absGap >= 2.0) return 75;
        return 40;
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'stabilized', weight: 15, score: (m) => scoreStabilized(m.stabilized) },
      { name: 'trend', weight: 15, score: (m) => scoreTrendBearish(m.trend) },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  VWAP_RECLAIM: {
    factors: [
      { name: 'vwap_distance', weight: 25, score: (m) => {
        const dist = Math.abs(m.vwap_distance_pct || 0);
        if (dist >= 0.1 && dist <= 0.4) return 100;
        if (dist <= 0.5) return 75;
        return 40;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'vwap_tests', weight: 20, score: (m) => {
        const tests = m.vwap_tests || 0;
        if (tests >= 3) return 100;
        if (tests >= 2) return 70;
        if (tests >= 1) return 40;
        return 10;
      }},
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  OPENING_RANGE_BREAKOUT: {
    factors: [
      { name: 'range_width_atr', weight: 25, score: (m) => {
        const rw = m.range_width_atr || 0;
        if (rw >= 0.3 && rw <= 0.8) return 100;
        if (rw >= 0.2 && rw <= 1.0) return 70;
        return 30;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 10, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'market_aligned', weight: 20, score: (m) => m.market_aligned ? 100 : 20 },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
      { name: 'break_distance', weight: 15, score: (m) => {
        const rw = m.range_width_atr || 0;
        if (rw >= 0.3 && rw <= 0.5) return 100;
        if (rw <= 0.8) return 70;
        return 40;
      }},
    ],
  },

  POWER_HOUR: {
    factors: [
      { name: 'trend_quality', weight: 25, score: (m) => {
        const move = Math.abs(m.move_in_atrs || 0);
        if (move >= 0.8 && move <= 1.5) return 100;
        if (move >= 0.5 && move <= 2.0) return 70;
        return 35;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'clean_trend', weight: 20, score: (m) => m.clean_trend ? 100 : 20 },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  CORRELATION_CASCADE: {
    factors: [
      { name: 'lag_quality', weight: 30, score: (m) => {
        const ratio = m.catchup_ratio || 0;
        if (ratio >= 0 && ratio < 0.2) return 100;
        if (ratio >= 0.2 && ratio < 0.4) return 70;
        if (ratio >= 0.4 && ratio < 0.6) return 40;
        return 15;
      }},
      { name: 'beta', weight: 15, score: (m) => {
        const beta = m.beta || 0;
        if (beta >= 1.5) return 100;
        if (beta >= 1.0) return 70;
        if (beta >= 0.5) return 40;
        return 15;
      }},
      { name: 'market_move', weight: 25, score: (m) => {
        const spy = Math.abs(m.spy_change_pct || 0);
        if (spy >= 1.0) return 100;
        if (spy >= 0.7) return 75;
        if (spy >= 0.5) return 50;
        return 25;
      }},
      { name: 'confluence', weight: 30, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  POST_MACRO: {
    factors: [
      { name: 'market_consensus', weight: 25, score: (m) => {
        const spy = Math.abs(m.spy_change_pct || 0);
        const qqq = Math.abs(m.qqq_change_pct || 0);
        const avg = (spy + qqq) / 2;
        if (avg >= 0.8) return 100;
        if (avg >= 0.5) return 70;
        return 40;
      }},
      { name: 'beta', weight: 20, score: (m) => {
        const beta = m.beta || 0;
        if (beta >= 1.5) return 100;
        if (beta >= 1.2) return 70;
        if (beta >= 1.0) return 40;
        return 15;
      }},
      { name: 'momentum_persistence', weight: 25, score: (m) => {
        const mp = m.momentum_persistence || 0;
        if (mp >= 0.7) return 100;
        if (mp >= 0.5) return 60;
        return 25;
      }},
      { name: 'confluence', weight: 30, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  FAILED_BREAKDOWN: {
    factors: [
      { name: 'trap_quality', weight: 25, score: (m) => {
        const recovery = Math.abs(m.recovery_pct || m.rejection_pct || 0);
        if (recovery >= 0.5) return 100;
        if (recovery >= 0.3) return 70;
        if (recovery >= 0.2) return 40;
        return 20;
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'stabilized', weight: 15, score: (m) => scoreStabilized(m.stabilized) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  CAPITULATION_BOUNCE: {
    factors: [
      { name: 'drop_pct', weight: 20, score: (m) => {
        const drop = Math.abs(m.intraday_drop_pct || 0);
        if (drop >= 4.0) return 100;
        if (drop >= 3.5) return 80;
        if (drop >= 3.0) return 60;
        return 30;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'stabilized', weight: 15, score: (m) => scoreStabilized(m.stabilized) },
      { name: 'bars_held', weight: 10, score: (m) => {
        const bh = m.bars_held || 0;
        if (bh >= 5) return 100;
        if (bh >= 3) return 60;
        return 20;
      }},
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  SECTOR_ROTATION_BOUNCE: {
    factors: [
      { name: 'gap_pct', weight: 20, score: (m) => {
        const absGap = Math.abs(m.gap_pct || 0);
        if (absGap >= 2.5 && absGap <= 3.0) return 100;
        if (absGap >= 2.0) return 75;
        return 40;
      }},
      { name: 'market_strength', weight: 25, score: (m) => {
        const spy = m.spy_change_pct || 0;
        const qqq = m.qqq_change_pct || 0;
        const avg = (spy + qqq) / 2;
        if (avg >= 1.0) return 100;
        if (avg >= 0.5) return 70;
        return 35;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  BREAKDOWN_PUT: {
    factors: [
      { name: 'breakdown_quality', weight: 25, score: (m) => {
        const vwapDist = Math.abs(m.vwap_distance_pct || 0);
        let score = 50;
        if (m.below_prev_low) score += 25;
        if (vwapDist >= 0.5) score += 25;
        return clamp(score);
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'market_align', weight: 20, score: (m) => {
        const spy = m.spy_change_pct || 0;
        if (spy <= -0.5) return 100;
        if (spy <= -0.3) return 70;
        return 30;
      }},
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  RELATIVE_WEAKNESS_PUT: {
    factors: [
      { name: 'relative_weakness', weight: 30, score: (m) => {
        const rw = Math.abs(m.relative_weakness_pct || 0);
        if (rw >= 2.5) return 100;
        if (rw >= 2.0) return 80;
        if (rw >= 1.5) return 55;
        return 25;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 15, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'vwap_distance', weight: 15, score: (m) => {
        const dist = Math.abs(m.vwap_distance_pct || 0);
        if (dist >= 1.0) return 100;
        if (dist >= 0.5) return 65;
        return 30;
      }},
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  CONSEC_BOUNCE: {
    factors: [
      { name: 'consec_days', weight: 30, score: (m) => {
        const days = m.consecutive_days || 0;
        if (days >= 3) return 100;
        if (days >= 2) return 60;
        return 20;
      }},
      { name: 'drop_pct', weight: 20, score: (m) => {
        const drop = Math.abs(m.total_drop_pct || 0);
        if (drop >= 9) return 100;
        if (drop >= 7) return 80;
        if (drop >= 6) return 60;
        return 35;
      }},
      { name: 'trend', weight: 15, score: (m) => scoreTrendBullish(m.trend) },
      { name: 'candle_type', weight: 10, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  VOL_DROP_PUT: {
    factors: [
      { name: 'drop_pct', weight: 25, score: (m) => {
        const drop = Math.abs(m.intraday_drop_pct || 0);
        if (drop >= 4.0) return 100;
        if (drop >= 3.5) return 75;
        if (drop >= 3.0) return 50;
        return 25;
      }},
      { name: 'volume_ratio', weight: 30, score: (m) => {
        const vr = m.volume_ratio || 1;
        if (vr <= 0.6) return 100;
        if (vr <= 0.8) return 80;
        if (vr <= 1.0) return 60;
        if (vr <= 1.2) return 40;
        return 15;
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  PRE_EARNINGS_PUT: {
    factors: [
      { name: 'iv_rank', weight: 25, score: (m) => {
        const iv = m.iv_rank ?? 50;
        if (iv <= 15) return 100;
        if (iv <= 25) return 75;
        if (iv <= 35) return 50;
        return 20;
      }},
      { name: 'days_to_earnings', weight: 20, score: (m) => {
        const dte = m.days_to_earnings || 0;
        if (dte >= 10 && dte <= 18) return 100;
        if (dte >= 7 && dte <= 21) return 70;
        return 30;
      }},
      { name: 'pct_from_high', weight: 25, score: (m) => {
        const pct = Math.abs(m.pct_from_high || 0);
        if (pct >= 20 && pct <= 30) return 100;
        if (pct >= 15 && pct <= 35) return 70;
        return 30;
      }},
      { name: 'confluence', weight: 30, score: (m) => scoreConfluence(m.confluence) },
    ],
  },
};

// Fallback rubric for strategies not explicitly defined
const DEFAULT_RUBRIC = {
  factors: [
    { name: 'candle_type', weight: 25, score: (m) => scoreCandle(m.candle_type) },
    { name: 'engulfing', weight: 20, score: (m) => scoreEngulfing(m.engulfing) },
    { name: 'confluence', weight: 30, score: (m) => scoreConfluence(m.confluence) },
    { name: 'stabilized', weight: 25, score: (m) => scoreStabilized(m.stabilized) },
  ],
};

/**
 * Score setup quality for a single signal.
 *
 * @param {Object} signal - Signal with strategy, metadata, scores properties
 * @returns {Object} { score, factors: { name: { raw, scored, weight } } }
 */
export function scoreSetupQuality(signal) {
  const strategy = signal.strategy;
  const metadata = signal.metadata || {};
  const m = { ...metadata, confluence: metadata.confluence ?? signal.scores?.confluence ?? 0 };

  const rubric = SETUP_RUBRICS[strategy] || DEFAULT_RUBRIC;
  const factorResults = {};
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const factor of rubric.factors) {
    const raw = m[factor.name];
    const scored = clamp(factor.score(m));
    totalWeightedScore += scored * (factor.weight / 100);
    totalWeight += factor.weight;

    factorResults[factor.name] = {
      raw: raw !== undefined ? raw : null,
      scored,
      weight: factor.weight,
    };
  }

  const normalizedScore = totalWeight > 0 ? Math.round((totalWeightedScore / totalWeight) * 100) : 0;

  return {
    score: clamp(normalizedScore),
    factors: factorResults,
  };
}
