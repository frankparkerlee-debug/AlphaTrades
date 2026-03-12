/**
 * Market Intelligence Engine
 * 
 * Three responsibilities:
 * 1. Key level detection (multi-timeframe)
 * 2. Intraday trend analysis (20-bar)
 * 3. Market regime classification
 * 
 * Used by the scoring engine to classify signals and filter traps.
 */

// ── KEY LEVEL ANALYSIS ──────────────────────────────────────────────────────

/**
 * Classify where current price sits relative to key levels
 * Returns proximity risk and whether price is at a trap zone
 */
export function analyzeLevels(state, atr) {
  const {
    close, vwap, sessionHigh, sessionLow,
    prevDayHigh, prevDayLow, sessionOpen, bars,
  } = state;

  if (!close || !atr) return nullLevels();

  const levels = [];

  // Previous day high/low — most watched institutional levels
  if (prevDayHigh) levels.push({ price: prevDayHigh, name: 'PDH', weight: 3 });
  if (prevDayLow)  levels.push({ price: prevDayLow,  name: 'PDL', weight: 3 });

  // Session VWAP — institutional fair value
  if (vwap)        levels.push({ price: vwap,         name: 'VWAP', weight: 2 });

  // Session high/low — intraday range
  if (sessionHigh) levels.push({ price: sessionHigh,  name: 'HOD', weight: 2 });
  if (sessionLow)  levels.push({ price: sessionLow,   name: 'LOD', weight: 2 });

  // Session open
  if (sessionOpen) levels.push({ price: sessionOpen,  name: 'OPEN', weight: 1 });

  // Find nearest level above and below current price
  const above = levels.filter(l => l.price > close).sort((a, b) => a.price - b.price);
  const below = levels.filter(l => l.price < close).sort((a, b) => b.price - a.price);

  const nearestAbove = above[0] || null;
  const nearestBelow = below[0] || null;

  // Distance to nearest level in ATR units
  const distAboveATRs = nearestAbove ? (nearestAbove.price - close) / (atr * close) : 999;
  const distBelowATRs = nearestBelow ? (close - nearestBelow.price) / (atr * close) : 999;

  // VWAP distance — being far from VWAP means mean reversion risk
  const vwapDist = vwap ? Math.abs(close - vwap) / (atr * close) : 0;
  const vwapSide = vwap ? (close > vwap ? 'ABOVE' : 'BELOW') : 'UNKNOWN';

  // Level proximity risk
  // If price is within 0.3 ATR of a key level — it's in a trap zone
  const atLevelAbove = distAboveATRs < 0.3;
  const atLevelBelow = distBelowATRs < 0.3;

  // Overextension from VWAP
  const vwapOverextended = vwapDist > 1.5;

  // Check if price already tested session high/low today (trap risk)
  const prevHodTest = bars && bars.length >= 3
    ? bars.slice(-10).filter(b => Math.abs(b.h - sessionHigh) / sessionHigh < 0.001).length >= 2
    : false;
  const prevLodTest = bars && bars.length >= 3
    ? bars.slice(-10).filter(b => Math.abs(b.l - sessionLow) / sessionLow < 0.001).length >= 2
    : false;

  return {
    nearestAbove,
    nearestBelow,
    distAboveATRs: parseFloat(distAboveATRs.toFixed(2)),
    distBelowATRs: parseFloat(distBelowATRs.toFixed(2)),
    vwapDist:      parseFloat(vwapDist.toFixed(2)),
    vwapSide,
    vwapOverextended,
    atLevelAbove,
    atLevelBelow,
    prevHodTest,
    prevLodTest,
  };
}

function nullLevels() {
  return {
    nearestAbove: null, nearestBelow: null,
    distAboveATRs: 999, distBelowATRs: 999,
    vwapDist: 0, vwapSide: 'UNKNOWN',
    vwapOverextended: false,
    atLevelAbove: false, atLevelBelow: false,
    prevHodTest: false, prevLodTest: false,
  };
}

// ── INTRADAY TREND ANALYSIS ─────────────────────────────────────────────────

/**
 * Analyze the intraday trend from bar history
 * Uses linear regression slope and bar quality scoring
 */
export function analyzeTrend(bars, direction) {
  if (!bars || bars.length < 5) return nullTrend();

  const recent = bars.slice(-15); // last 15 bars
  const n = recent.length;

  // Linear regression slope on close prices
  const closes = recent.map(b => b.c);
  const xMean  = (n - 1) / 2;
  const yMean  = closes.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (closes[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const slopePct = yMean > 0 ? slope / yMean : 0; // slope as % per bar

  // Bar quality — what % of last 10 bars are bullish vs bearish
  const last10 = bars.slice(-10);
  const bullBars = last10.filter(b => b.c >= b.o).length;
  const bearBars = last10.filter(b => b.c < b.o).length;
  const bullRatio = bullBars / last10.length;
  const bearRatio = bearBars / last10.length;

  // Trend direction and strength
  const trendDir = slopePct > 0.0002 ? 'UP'
                 : slopePct < -0.0002 ? 'DOWN'
                 : 'FLAT';

  const trendStrength = Math.abs(slopePct) > 0.001 ? 'STRONG'
                      : Math.abs(slopePct) > 0.0004 ? 'MODERATE'
                      : 'WEAK';

  // Alignment with signal direction
  const signalDir = direction === 'CALL' ? 'UP' : 'DOWN';
  const trendAligned    = trendDir === signalDir;
  const trendNeutral    = trendDir === 'FLAT';
  const trendOpposed    = !trendAligned && !trendNeutral;

  // Higher highs / lower lows structure
  const recentHighs = recent.map(b => b.h);
  const recentLows  = recent.map(b => b.l);
  const higherHighs = recentHighs[n-1] > recentHighs[Math.floor(n/2)];
  const lowerLows   = recentLows[n-1] < recentLows[Math.floor(n/2)];
  const higherLows  = recentLows[n-1] > recentLows[Math.floor(n/2)];
  const lowerHighs  = recentHighs[n-1] < recentHighs[Math.floor(n/2)];

  // Healthy uptrend: higher highs + higher lows
  // Healthy downtrend: lower lows + lower highs
  const healthyUptrend   = higherHighs && higherLows;
  const healthyDowntrend = lowerLows   && lowerHighs;

  // Reversal warning signals
  const uptrendBreaking   = trendDir === 'UP'   && lowerHighs; // uptrend but making lower highs
  const downtrendBreaking = trendDir === 'DOWN'  && higherLows; // downtrend but making higher lows

  // Volume trend — is volume increasing into the move?
  const recentVols  = recent.map(b => b.v || 0);
  const earlyVol    = recentVols.slice(0, Math.floor(n/2)).reduce((a,b) => a+b, 0) / Math.floor(n/2);
  const lateVol     = recentVols.slice(Math.floor(n/2)).reduce((a,b) => a+b, 0) / Math.ceil(n/2);
  const volTrend    = earlyVol > 0 ? lateVol / earlyVol : 1;
  const volExpanding = volTrend > 1.2;  // volume growing into move = healthy
  const volContracting = volTrend < 0.8; // volume shrinking = move losing steam

  // Signal type classification
  let signalType;
  if (trendAligned && (healthyUptrend || healthyDowntrend) && volExpanding) {
    signalType = 'TREND_CONTINUATION';
  } else if (trendAligned && trendStrength === 'STRONG' && !uptrendBreaking && !downtrendBreaking) {
    signalType = 'TREND_CONTINUATION';
  } else if (trendNeutral && volExpanding) {
    signalType = 'BREAKOUT';
  } else if (trendOpposed && trendStrength === 'WEAK') {
    signalType = 'COUNTER_TREND';
  } else if (trendOpposed && trendStrength !== 'WEAK') {
    signalType = 'COUNTER_TREND_STRONG'; // fighting a strong trend — high risk
  } else if (uptrendBreaking || downtrendBreaking) {
    signalType = 'REVERSAL_RISK';
  } else if (volContracting && trendAligned) {
    signalType = 'FADING_MOMENTUM';
  } else {
    signalType = 'NEUTRAL';
  }

  return {
    trendDir,
    trendStrength,
    trendAligned,
    trendOpposed,
    signalType,
    bullRatio:       parseFloat(bullRatio.toFixed(2)),
    bearRatio:       parseFloat(bearRatio.toFixed(2)),
    slopePct:        parseFloat((slopePct * 100).toFixed(4)),
    healthyUptrend,
    healthyDowntrend,
    uptrendBreaking,
    downtrendBreaking,
    volExpanding,
    volContracting,
    volTrend:        parseFloat(volTrend.toFixed(2)),
  };
}

function nullTrend() {
  return {
    trendDir: 'UNKNOWN', trendStrength: 'WEAK',
    trendAligned: false, trendOpposed: false,
    signalType: 'NEUTRAL',
    bullRatio: 0.5, bearRatio: 0.5, slopePct: 0,
    healthyUptrend: false, healthyDowntrend: false,
    uptrendBreaking: false, downtrendBreaking: false,
    volExpanding: false, volContracting: false, volTrend: 1,
  };
}

// ── MARKET REGIME ───────────────────────────────────────────────────────────

/**
 * Classify current market regime from ETF data
 * Used to halt or reduce signals during adverse conditions
 */
export function classifyRegime(marketData, vix, spyBars) {
  const { spyPct, qqqPct } = marketData;

  // VIX level classification
  const vixRegime = vix < 15 ? 'LOW'
                  : vix < 20 ? 'NORMAL'
                  : vix < 30 ? 'ELEVATED'
                  : 'EXTREME';

  // Market direction
  const bothDown  = spyPct < -0.005 && qqqPct < -0.005;
  const bothUp    = spyPct >  0.005 && qqqPct >  0.005;
  const diverging = Math.abs(spyPct - qqqPct) > 0.008;

  // Rapid decline detection from SPY bars (last 3 bars)
  let rapidDecline = false;
  let rapidRally   = false;
  if (spyBars && spyBars.length >= 3) {
    const last3 = spyBars.slice(-3);
    const moveOver3Bars = last3.length > 0
      ? (last3[last3.length-1].c - last3[0].o) / last3[0].o
      : 0;
    rapidDecline = moveOver3Bars < -0.005; // -0.5% in 3 bars = fast move
    rapidRally   = moveOver3Bars >  0.005;
  }

  // Regime classification
  let regime;
  let callsAllowed  = true;
  let putsAllowed   = true;
  let sizeMult      = 1.0;
  let regimeNote    = '';

  if (vixRegime === 'EXTREME' || (bothDown && rapidDecline)) {
    regime       = 'MARKET_BREAKDOWN';
    callsAllowed = false;
    sizeMult     = 0;
    regimeNote   = 'Market breakdown — all signals paused';
  } else if (vixRegime === 'ELEVATED' && bothDown) {
    regime       = 'RISK_OFF';
    callsAllowed = false;
    sizeMult     = 0.5;
    regimeNote   = 'Risk-off conditions — calls paused, puts reduced';
  } else if (rapidDecline) {
    regime       = 'FAST_MOVE_DOWN';
    callsAllowed = false;
    sizeMult     = 0.75;
    regimeNote   = 'Rapid decline — calls paused';
  } else if (rapidRally && vixRegime !== 'LOW') {
    regime       = 'FAST_MOVE_UP';
    putsAllowed  = false;
    sizeMult     = 0.75;
    regimeNote   = 'Rapid rally — puts paused';
  } else if (diverging) {
    regime       = 'DIVERGING';
    sizeMult     = 0.75;
    regimeNote   = 'SPY/QQQ diverging — reduced sizing';
  } else if (bothUp) {
    regime       = 'RISK_ON';
    sizeMult     = 1.0;
    regimeNote   = '';
  } else if (bothDown) {
    regime       = 'RISK_OFF_MILD';
    callsAllowed = true; // allow but reduced
    sizeMult     = 0.75;
    regimeNote   = 'Mild risk-off — reduced sizing';
  } else {
    regime       = 'NEUTRAL';
    sizeMult     = 1.0;
    regimeNote   = '';
  }

  return {
    regime,
    callsAllowed,
    putsAllowed,
    sizeMult,
    regimeNote,
    vixRegime,
    rapidDecline,
    rapidRally,
    bothUp,
    bothDown,
  };
}

// ── POST-SIGNAL MONITORING ──────────────────────────────────────────────────

/**
 * Evaluate an active signal against current price action
 * Called every 30 seconds for each ACTIVE signal
 * Returns updated status and reason
 */
export function monitorSignal(signal, currentState, atr) {
  const { direction, price_at_signal } = signal;
  const currentPrice = currentState.close;
  const currentVwap  = currentState.vwap;
  const bars         = currentState.bars || [];

  if (!currentPrice || !price_at_signal || !atr) {
    return { status: 'ACTIVE', note: null };
  }

  const mult       = direction === 'CALL' ? 1 : -1;
  const moveFromEntry = ((currentPrice - price_at_signal) / price_at_signal) * mult;
  const atrFromEntry  = moveFromEntry / atr;

  // Check for consecutive adverse bars
  const last3 = bars.slice(-3);
  const adverseBars = last3.filter(b => {
    const barDir = b.c >= b.o ? 1 : -1;
    return barDir !== mult;
  }).length;

  // VWAP cross — if CALL signal and price crosses below VWAP, trend changed
  const vwapBreak = direction === 'CALL'
    ? (currentVwap && currentPrice < currentVwap && price_at_signal > currentVwap)
    : (currentVwap && currentPrice > currentVwap && price_at_signal < currentVwap);

  // Classify signal health
  if (atrFromEntry <= -1.0) {
    return {
      status: 'BREAKDOWN',
      note: `Price moved ${(Math.abs(moveFromEntry)*100).toFixed(2)}% against signal — exit`,
    };
  }

  if (vwapBreak) {
    return {
      status: 'BREAKDOWN',
      note: 'VWAP crossed — trend reversed',
    };
  }

  if (atrFromEntry <= -0.5 || adverseBars >= 3) {
    return {
      status: 'WEAKENING',
      note: adverseBars >= 3
        ? '3 consecutive adverse bars'
        : `Price ${(Math.abs(moveFromEntry)*100).toFixed(2)}% against signal`,
    };
  }

  if (atrFromEntry >= 1.5) {
    return {
      status: 'TARGET_ZONE',
      note: `Up ${(moveFromEntry*100).toFixed(2)}% from entry — near T1`,
    };
  }

  return { status: 'ACTIVE', note: null };
}

// ── COMBINED SIGNAL GATE ────────────────────────────────────────────────────

/**
 * Final gate before writing a signal
 * Returns { allow, reason, adjustedSizeMult }
 */
export function gateSignal(direction, trend, levels, regime, freshness) {

  // Regime gates
  if (regime.regime === 'MARKET_BREAKDOWN') {
    return { allow: false, reason: 'Market breakdown — all signals halted' };
  }
  if (direction === 'CALL' && !regime.callsAllowed) {
    return { allow: false, reason: `Calls paused — ${regime.regimeNote}` };
  }
  if (direction === 'PUT' && !regime.putsAllowed) {
    return { allow: false, reason: `Puts paused — ${regime.regimeNote}` };
  }

  // Trend gates
  if (trend.signalType === 'COUNTER_TREND_STRONG') {
    return { allow: false, reason: 'Fighting strong trend — signal rejected' };
  }
  if (trend.uptrendBreaking && direction === 'CALL') {
    return { allow: false, reason: 'Uptrend structure breaking — call rejected' };
  }
  if (trend.downtrendBreaking && direction === 'PUT') {
    return { allow: false, reason: 'Downtrend structure breaking — put rejected' };
  }

  // Level gates
  if (levels.vwapOverextended && freshness !== 'FRESH') {
    return { allow: false, reason: 'Overextended from VWAP — mean reversion risk' };
  }
  if (direction === 'CALL' && levels.atLevelAbove && levels.prevHodTest) {
    return { allow: false, reason: 'Second test of HOD — liquidity grab risk' };
  }
  if (direction === 'PUT' && levels.atLevelBelow && levels.prevLodTest) {
    return { allow: false, reason: 'Second test of LOD — liquidity grab risk' };
  }

  // Freshness gates
  if (freshness === 'EXHAUSTED' || freshness === 'LATE') {
    return { allow: false, reason: `Move too mature — ${freshness}` };
  }

  // Compute size multiplier from all factors
  let sizeMult = regime.sizeMult;
  if (trend.signalType === 'COUNTER_TREND') sizeMult *= 0.5;
  if (trend.signalType === 'FADING_MOMENTUM') sizeMult *= 0.75;
  if (levels.vwapOverextended) sizeMult *= 0.75;
  if (freshness === 'EXTENDED') sizeMult *= 0.75;
  if (trend.volContracting) sizeMult *= 0.75;

  return {
    allow: true,
    reason: null,
    adjustedSizeMult: parseFloat(sizeMult.toFixed(2)),
    signalType: trend.signalType,
    regimeNote: regime.regimeNote,
  };
}
