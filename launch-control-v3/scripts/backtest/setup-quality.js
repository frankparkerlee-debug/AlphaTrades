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
  ORB_BREAKOUT: {
    factors: [
      { name: 'range_width_pct', weight: 20, score: (m) => {
        const rw = m.range_width_pct || 0;
        if (rw >= 0.3 && rw <= 1.0) return 100;
        if (rw >= 0.2 && rw <= 1.5) return 70;
        return 30;
      }},
      { name: 'volume_ratio', weight: 25, score: (m) => {
        const vr = m.volume_ratio || 0;
        if (vr >= 1.5) return 100;
        if (vr >= 1.3) return 75;
        return 30;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'spy_aligned', weight: 15, score: (m) => m.spy_aligned ? 100 : 20 },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  VWAP_BOUNCE: {
    factors: [
      { name: 'vwap_distance_pct', weight: 25, score: (m) => {
        const dist = Math.abs(m.vwap_distance_pct || 0);
        if (dist >= 0.1 && dist <= 0.25) return 100;
        if (dist >= 0.05 && dist <= 0.3) return 70;
        return 30;
      }},
      { name: 'volume_declining', weight: 25, score: (m) => {
        const ratio = m.volume_decline_ratio || 1;
        if (ratio <= 0.6) return 100;
        if (ratio <= 0.8) return 75;
        return 30;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 10, score: (m) => scoreEngulfing(m.engulfing || m.is_hammer) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  FIRST_PULLBACK: {
    factors: [
      { name: 'move_from_open_atrs', weight: 20, score: (m) => {
        const move = m.move_from_open_atrs || 0;
        if (move >= 0.7 && move <= 1.5) return 100;
        if (move >= 0.5 && move <= 2.0) return 70;
        return 30;
      }},
      { name: 'pullback_bars', weight: 20, score: (m) => {
        const pb = m.pullback_bars || 0;
        if (pb >= 3 && pb <= 6) return 100;
        if (pb >= 2 && pb <= 8) return 70;
        return 30;
      }},
      { name: 'trigger_vol_ratio', weight: 20, score: (m) => {
        const vr = m.trigger_vol_ratio || 0;
        if (vr >= 1.5) return 100;
        if (vr >= 1.3) return 75;
        if (vr >= 1.0) return 50;
        return 25;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  GAP_FILL_REVERSION: {
    factors: [
      { name: 'gap_pct', weight: 25, score: (m) => {
        const absGap = Math.abs(m.gap_pct || 0);
        const logicType = m.logic_type;
        if (logicType === 'REVERSION') {
          if (absGap >= 0.3 && absGap <= 0.5) return 100;
          if (absGap >= 0.15 && absGap <= 0.6) return 70;
          return 30;
        } else {
          if (absGap >= 1.5) return 100;
          if (absGap >= 1.0) return 70;
          return 40;
        }
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 10, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'volume_ratio', weight: 20, score: (m) => {
        const vr = m.volume_ratio || 0;
        if (vr >= 1.5) return 100;
        if (vr >= 1.0) return 65;
        return 30;
      }},
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  POWER_HOUR_MOMENTUM: {
    factors: [
      { name: 'move_in_atrs', weight: 20, score: (m) => {
        const move = m.move_in_atrs || 0;
        if (move >= 0.5 && move <= 1.5) return 100;
        if (move >= 0.3 && move <= 2.0) return 70;
        return 30;
      }},
      { name: 'has_consolidation', weight: 20, score: (m) => m.has_consolidation ? 100 : 30 },
      { name: 'volume_trend', weight: 20, score: (m) => {
        const vt = m.volume_trend || 0;
        if (vt >= 1.3) return 100;
        if (vt >= 1.0) return 65;
        return 30;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  MACRO_REACTION: {
    factors: [
      { name: 'consensus_pct', weight: 25, score: (m) => {
        const cp = Math.abs(m.consensus_pct || 0);
        if (cp >= 0.5) return 100;
        if (cp >= 0.3) return 70;
        return 35;
      }},
      { name: 'beta', weight: 20, score: (m) => {
        const beta = m.beta || 0;
        if (beta >= 1.5) return 100;
        if (beta >= 1.2) return 70;
        if (beta >= 1.0) return 40;
        return 15;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 10, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'confluence', weight: 30, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  // ── New Day Trade Rubrics ───────────────────────────────────────────────

  EXTREME_REVERSAL: {
    factors: [
      { name: 'move_from_open_atrs', weight: 35, score: (m) => {
        const move = Math.abs(m.move_from_open_atrs || 0);
        if (move >= 2.5) return 100;
        if (move >= 2.0) return 75;
        return 30;
      }},
      { name: 'volume_ratio', weight: 25, score: (m) => {
        const vr = m.volume_ratio || 0;
        if (vr >= 1.0) return 100;
        if (vr >= 0.7) return 70;
        return 30;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 10, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  EOD_MEAN_REVERSION: {
    factors: [
      { name: 'intraday_return_pct', weight: 40, score: (m) => {
        const ret = Math.abs(m.intraday_return_pct || 0);
        if (ret >= 3) return 100;
        if (ret >= 2) return 80;
        if (ret >= 1) return 60;
        return 20;
      }},
      { name: 'candle_type', weight: 25, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 20, score: (m) => scoreEngulfing(m.engulfing) },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  HIGH_RVOL_BREAKOUT: {
    factors: [
      { name: 'rvol', weight: 30, score: (m) => {
        const rv = m.rvol || 0;
        if (rv >= 3.0) return 100;
        if (rv >= 2.5) return 80;
        if (rv >= 2.0) return 60;
        return 20;
      }},
      { name: 'move_from_open_atrs', weight: 20, score: (m) => {
        const move = m.move_from_open_atrs || 0;
        if (move >= 1.0) return 100;
        if (move >= 0.7) return 75;
        if (move >= 0.5) return 50;
        return 25;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'spy_aligned', weight: 10, score: (m) => m.spy_aligned ? 100 : 20 },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  // ── Swing Trade Rubrics ─────────────────────────────────────────────────

  PEAD_DRIFT: {
    factors: [
      { name: 'gap_pct', weight: 35, score: (m) => {
        const gap = Math.abs(m.gap_pct || 0);
        if (gap >= 5) return 100;
        if (gap >= 3) return 80;
        if (gap >= 2) return 60;
        return 30;
      }},
      { name: 'volume_ratio', weight: 30, score: (m) => {
        const vr = m.volume_ratio || 0;
        if (vr >= 3.0) return 100;
        if (vr >= 2.0) return 75;
        if (vr >= 1.5) return 50;
        return 25;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
      { name: 'engulfing', weight: 20, score: (m) => scoreEngulfing(m.engulfing) },
    ],
  },

  SECTOR_LAGGARD: {
    factors: [
      { name: 'lag_ratio', weight: 35, score: (m) => {
        const lag = m.lag_ratio || 0;
        if (lag < 0.1) return 100;
        if (lag < 0.3) return 75;
        if (lag < 0.5) return 50;
        return 20;
      }},
      { name: 'sector_return_pct', weight: 30, score: (m) => {
        const ret = Math.abs(m.sector_return_pct || 0);
        if (ret >= 1.5) return 100;
        if (ret >= 1.0) return 75;
        if (ret >= 0.5) return 50;
        return 20;
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  SHORT_SQUEEZE_MOMENTUM: {
    factors: [
      { name: 'short_pct', weight: 30, score: (m) => {
        const si = m.short_pct || 0;
        if (si >= 30) return 100;
        if (si >= 25) return 80;
        if (si >= 20) return 60;
        if (si >= 15) return 40;
        return 20;
      }},
      { name: 'volume_ratio', weight: 30, score: (m) => {
        const vr = m.volume_ratio || 0;
        if (vr >= 3.0) return 100;
        if (vr >= 2.5) return 80;
        if (vr >= 2.0) return 60;
        return 25;
      }},
      { name: 'move_from_open_pct', weight: 25, score: (m) => {
        const move = m.move_from_open_pct || 0;
        if (move >= 5) return 100;
        if (move >= 3) return 75;
        if (move >= 2) return 50;
        return 25;
      }},
      { name: 'candle_type', weight: 15, score: (m) => scoreCandle(m.candle_type) },
    ],
  },

  OPTIONS_FLOW: {
    factors: [
      { name: 'volume_vs_oi', weight: 40, score: (m) => {
        const ratio = m.volume_vs_oi || 0;
        if (ratio >= 5) return 100;
        if (ratio >= 4) return 80;
        if (ratio >= 3) return 60;
        return 25;
      }},
      { name: 'call_put_ratio', weight: 35, score: (m) => {
        const cpr = m.call_put_ratio || 1;
        if (cpr >= 3.0 || cpr <= 0.33) return 100;
        if (cpr >= 2.0 || cpr <= 0.5) return 75;
        return 30;
      }},
      { name: 'candle_type', weight: 25, score: (m) => scoreCandle(m.candle_type) },
    ],
  },

  ANALYST_DRIFT: {
    factors: [
      { name: 'analyst_direction', weight: 50, score: (m) => {
        if (m.analyst_direction === 'DOWNGRADE') return 100; // 4x more informative
        if (m.analyst_direction === 'UPGRADE') return 70;
        return 30;
      }},
      { name: 'candle_type', weight: 25, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  VIX_REVERSAL: {
    factors: [
      { name: 'vix_level', weight: 35, score: (m) => {
        const vix = m.vix_level || 0;
        if (vix >= 35) return 100;
        if (vix >= 30) return 80;
        if (vix >= 28) return 60;
        return 20;
      }},
      { name: 'beta', weight: 30, score: (m) => {
        const beta = m.beta || 0;
        if (beta >= 1.5) return 100;
        if (beta >= 1.3) return 75;
        if (beta >= 1.2) return 50;
        return 20;
      }},
      { name: 'candle_type', weight: 20, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 15, score: (m) => scoreConfluence(m.confluence) },
    ],
  },

  // ── Scalp Rubric ────────────────────────────────────────────────────────

  ZERO_DTE_SCALP: {
    factors: [
      { name: 'pattern', weight: 40, score: (m) => {
        if (m.pattern === 'LEVEL_BREAK') return 100;
        if (m.pattern === 'MOMENTUM_BURST') return 85;
        if (m.pattern === 'VWAP_TOUCH') return 70;
        return 30;
      }},
      { name: 'candle_type', weight: 35, score: (m) => scoreCandle(m.candle_type) },
      { name: 'confluence', weight: 25, score: (m) => scoreConfluence(m.confluence) },
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
