import { clamp, pctChange } from '../utils/math.js';

/**
 * Price Action pillar — max 35 pts
 * ATR-normalized move required. Direction penalty for counter-trend.
 */
export function computePaScore(params) {
  const {
    direction,
    currentPrice,
    openPrice,
    highPrice,
    lowPrice,
    prevClose,
    currentVwap,
    prevDayHigh,
    prevDayLow,
    atr20d,       // as decimal e.g. 0.038
    atr5d,        // as decimal
    momentumPersistence = 0.70,
  } = params;

  // Use 5d ATR if significantly different from 20d (regime change)
  const atrDiverge = Math.abs(atr5d - atr20d) / atr20d;
  const activeAtr = atrDiverge > 0.30 ? atr5d : atr20d;

  // ATR-normalized move
  const movePct = Math.abs(pctChange(currentPrice, prevClose));
  const atrMultiple = activeAtr > 0 ? movePct / activeAtr : 0;

  // ATR tier base score (v2 tightened tiers)
  let base = 0;
  if (atrMultiple >= 1.7)      base = 35;
  else if (atrMultiple >= 1.1) base = 24;
  else if (atrMultiple >= 0.7) base = 12;
  else                          base = 0;

  // Direction penalty — counter-trend move
  const actualMove = pctChange(currentPrice, prevClose);
  if (direction === 'CALL' && actualMove < 0) base = Math.round(base * 0.3);
  if (direction === 'PUT'  && actualMove > 0) base = Math.round(base * 0.3);

  // Level break quality
  const levelBreak = classifyLevelBreak(currentPrice, direction, {
    prevDayHigh, prevDayLow, vwap: currentVwap,
    openHigh: highPrice, openLow: lowPrice,
  });
  const levelMult = { clean: 1.0, extend: 0.85, chase: 0.60, none: 0.70 }[levelBreak];

  // Candle body quality
  const bodyPct  = Math.abs(currentPrice - openPrice);
  const rangePct = highPrice - lowPrice;
  const bodyRatio = rangePct > 0 ? bodyPct / rangePct : 0;
  let candleMult = 0.65;
  if (bodyRatio >= 0.75)      candleMult = 1.10;
  else if (bodyRatio >= 0.50) candleMult = 1.00;
  else if (bodyRatio >= 0.30) candleMult = 0.85;

  // VWAP position bonus
  const aboveVwap = currentPrice > currentVwap;
  const vwapBonus = ((direction === 'CALL' && aboveVwap) ||
                     (direction === 'PUT'  && !aboveVwap)) ? 2 : -2;

  // Momentum persistence adjustment
  const persistAdj = (momentumPersistence - 0.70) * 10;

  const raw = (base * levelMult * candleMult) + vwapBonus + persistAdj;
  const score = clamp(Math.round(raw), 0, 35);

  return {
    score,
    atrMultiple: parseFloat(atrMultiple.toFixed(3)),
    levelBreak,
    bodyRatio: parseFloat(bodyRatio.toFixed(2)),
  };
}

function classifyLevelBreak(price, direction, levels) {
  const { prevDayHigh, prevDayLow, vwap } = levels;
  const keyLevels = [prevDayHigh, prevDayLow, vwap].filter(Boolean);

  for (const level of keyLevels) {
    const dist = Math.abs(price - level) / level;
    if (dist < 0.001) {
      // Price is right at a key level — clean break
      return 'clean';
    }
    if (direction === 'CALL' && price > level && dist < 0.005) return 'extend';
    if (direction === 'PUT'  && price < level && dist < 0.005) return 'extend';
    if (direction === 'CALL' && price > level && dist > 0.010) return 'chase';
    if (direction === 'PUT'  && price < level && dist > 0.010) return 'chase';
  }
  return 'none';
}
