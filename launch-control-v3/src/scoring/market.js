import { clamp } from '../utils/math.js';

/**
 * Market Alignment pillar — max 15 pts, min -5 pts
 * Three-layer: SPY (broad) + exchange ETF + sector ETF
 */
export function computeMarketScore(params) {
  const {
    direction,
    spyChangePct,
    exchangeEtfChangePct,  // QQQ for Nasdaq, DIA for NYSE
    sectorEtfChangePct,    // XLK, SMH, XLY, XLC etc
    betaQqq = 1.0,
    sectorEtfCorrelation = 0.70,
    alignmentFollowthruRate = 0.65,
  } = params;

  const flags = [];
  let cap = null;

  // Thresholds for alignment
  const QT = 0.0015; // broad market threshold
  const ET = 0.0018; // exchange ETF threshold
  const ST = 0.0020; // sector ETF threshold

  // Each layer: aligned, opposing, or neutral
  const spyAligned  = (direction === 'CALL' && spyChangePct > QT)  ||
                      (direction === 'PUT'  && spyChangePct < -QT);
  const spyOpposing = (direction === 'CALL' && spyChangePct < -QT) ||
                      (direction === 'PUT'  && spyChangePct > QT);

  const exchAligned  = (direction === 'CALL' && exchangeEtfChangePct > ET)  ||
                       (direction === 'PUT'  && exchangeEtfChangePct < -ET);
  const exchOpposing = (direction === 'CALL' && exchangeEtfChangePct < -ET) ||
                       (direction === 'PUT'  && exchangeEtfChangePct > ET);

  const secAligned  = (direction === 'CALL' && sectorEtfChangePct > ST)  ||
                      (direction === 'PUT'  && sectorEtfChangePct < -ST);
  const secOpposing = (direction === 'CALL' && sectorEtfChangePct < -ST) ||
                      (direction === 'PUT'  && sectorEtfChangePct > ST);

  const alignedCount  = [spyAligned,  exchAligned,  secAligned ].filter(Boolean).length;
  const opposingCount = [spyOpposing, exchOpposing, secOpposing].filter(Boolean).length;

  // Base score by alignment count
  let base = 0;
  if (alignedCount === 3) {
    base = 15;
  } else if (alignedCount === 2) {
    base = 11;
  } else if (alignedCount === 1 && opposingCount === 0) {
    base = 6;
  } else if (opposingCount === 0) {
    base = 3; // all neutral
  } else if (opposingCount === 1) {
    base = 0;
    flags.push('MARKET_HEADWIND — one layer opposing');
  } else if (opposingCount === 2) {
    base = -3;
    flags.push('MARKET_CONFLICT — two layers opposing');
    cap = 'B-';
  } else {
    base = -5;
    flags.push('MARKET_STRONGLY_OPPOSING — all three layers against direction');
    cap = 'B-';
  }

  // Beta and correlation weighting
  const betaWeight   = clamp(betaQqq / 1.30, 0.70, 1.40);
  const sectorWeight = clamp(sectorEtfCorrelation / 0.75, 0.70, 1.30);
  const followthruAdj = ((alignmentFollowthruRate ?? 0.65) - 0.65) * 20;

  const raw = (base * (betaWeight + sectorWeight) / 2) + followthruAdj;
  const score = clamp(Math.round(raw), -5, 15);

  return {
    score,
    cap,
    flags,
    alignedCount,
    opposingCount,
    layers: { spyAligned, exchAligned, secAligned },
  };
}
