/**
 * Dynamic Correlation Engine — 1-Minute Resolution
 *
 * Computes trailing cross-correlations between individual stocks and
 * ETFs (SPY/QQQ) from 1-minute bar data. Everything operates at the
 * tick-by-tick level because the tradeable edge is in 1-5 minute lags.
 *
 * Built on 1-minute returns from trailing 5 trading days (~1,950 data
 * points per ticker). This gives:
 *
 *   1. Lead/lag at 1-minute precision: NVDA leads SPY by 3 min
 *   2. Impact from sharp bursts: 3-bar spike → what follows 1-10 min later?
 *   3. Reliability per-minute: hit rate at lag=2, lag=3, lag=5, etc.
 *   4. Conditional: AM vs PM, high-vol bars vs low-vol bars
 *   5. Real-time intraday correlation from today's accumulating bars
 *
 * Why 1-minute and not 15-minute:
 *   - A 15-min window smooths out the exact lag (e.g., 3 min becomes "0")
 *   - The actual cascade happens in 1-5 minutes for liquid names
 *   - 1-min gives ~390 samples/day * 5 days = ~1,950 paired observations
 *   - More than enough for stable Pearson estimates
 *
 * Computed per-day from trailing N-day minute bars. Cached per date.
 */

const TRAILING_DAYS    = 5;     // look back 5 trading days
const MAX_LAG_MINUTES  = 10;    // check lead/lag up to +-10 min (beyond that it's noise)
const BURST_WINDOW     = 3;     // detect "sharp moves" over 3 consecutive 1-min bars
const MIN_SAMPLES      = 30;    // need 30+ paired observations for reliable stats

// Impact detection thresholds (per 3-bar burst)
const MIN_TICKER_BURST_ATR = 0.3;  // ticker must move >= 0.3 ATR in 3 bars
const MIN_SPY_BURST_PCT    = 0.0008; // SPY must move >= 0.08% in 3 bars (~$0.35 on SPY $440)

// Follow-through lag buckets (minutes after trigger)
const FOLLOW_LAGS = [1, 2, 3, 5, 8, 10];

// Cache: date -> computed correlations
const cache = new Map();

/**
 * Compute dynamic correlations for a given date.
 *
 * @param {string} date - YYYY-MM-DD
 * @param {Object} minuteBars - { ticker: { minuteKey: bar } }
 * @param {Object} etfMinuteBars - { SPY: {...}, QQQ: {...} }
 * @param {string[]} tradingDays - sorted array of all trading days
 * @param {Object} profiles - { ticker: { atr_5d, ... } }
 * @returns {Object} { [ticker]: CorrelationProfile }
 */
export function computeDayCorrelations(date, minuteBars, etfMinuteBars, tradingDays, profiles) {
  if (cache.has(date)) return cache.get(date);

  const result = {};

  // Get trailing trading days (excludes current day — no look-ahead bias)
  const dateIdx = tradingDays.indexOf(date);
  if (dateIdx < 1) {
    cache.set(date, result);
    return result;
  }
  const trailStart = Math.max(0, dateIdx - TRAILING_DAYS);
  const trailDays = tradingDays.slice(trailStart, dateIdx);

  if (trailDays.length < 2) {
    cache.set(date, result);
    return result;
  }

  // Build 1-min return series for SPY/QQQ across trailing days
  const spyReturns = build1MinReturns(etfMinuteBars.SPY || {}, trailDays);
  const qqqReturns = build1MinReturns(etfMinuteBars.QQQ || {}, trailDays);

  if (spyReturns.length < MIN_SAMPLES) {
    cache.set(date, result);
    return result;
  }

  // Pre-build SPY/QQQ return maps for lead/lag (avoid recomputing per ticker)
  const spyRetMap = new Map(spyReturns.map(r => [r.time, r.ret]));
  const qqqRetMap = new Map(qqqReturns.map(r => [r.time, r.ret]));

  const tickers = Object.keys(minuteBars).filter(t => t !== 'SPY' && t !== 'QQQ');

  for (const ticker of tickers) {
    const tickerBars = minuteBars[ticker];
    if (!tickerBars) continue;

    const profile = profiles[ticker];
    if (!profile) continue;

    const atr = profile.atr_5d || profile.atr_20d || 0.025;
    const tickerReturns = build1MinReturns(tickerBars, trailDays);

    if (tickerReturns.length < MIN_SAMPLES) continue;

    const tickerRetMap = new Map(tickerReturns.map(r => [r.time, r.ret]));

    // 1. Contemporaneous 1-min correlation (lag=0)
    const spyCorr = pairedCorrelation(tickerRetMap, spyRetMap);
    const qqqCorr = pairedCorrelation(tickerRetMap, qqqRetMap);

    // 2. Lead/lag at 1-minute precision
    const spyLeadLag = computeLeadLag(tickerRetMap, spyRetMap, trailDays);
    const qqqLeadLag = computeLeadLag(tickerRetMap, qqqRetMap, trailDays);

    // 3. Burst impact: when ticker has a sharp 3-bar move, what happens to SPY?
    const tickerImpactOnSpy = computeBurstImpact(
      tickerBars, etfMinuteBars.SPY || {}, trailDays, atr, 'TICKER_TO_ETF'
    );

    // 4. Reverse: when SPY has a sharp burst, what happens to ticker?
    const spyImpactOnTicker = computeBurstImpact(
      etfMinuteBars.SPY || {}, tickerBars, trailDays, atr, 'ETF_TO_TICKER'
    );

    // 5. Conditional: AM vs PM, high-vol bars vs normal
    const conditional = computeConditional(tickerRetMap, spyRetMap, tickerReturns);

    result[ticker] = {
      ticker,
      spyCorrelation:    parseFloat(spyCorr.toFixed(4)),
      qqqCorrelation:    parseFloat(qqqCorr.toFixed(4)),
      spyLeadLag,
      qqqLeadLag,
      tickerImpactOnSpy,
      spyImpactOnTicker,
      conditional,
    };
  }

  cache.set(date, result);
  return result;
}

/**
 * Compute INTRADAY correlation from today's accumulating bars.
 * Called during the trading session for real-time correlation updates.
 *
 * @param {Object} tickerBars - this ticker's bars for today
 * @param {Object} etfBars - SPY bars for today
 * @param {string} uptoKey - current minute key (don't look ahead)
 * @param {string} date - YYYY-MM-DD
 * @returns {{ correlation: number, samples: number }}
 */
export function computeIntradayCorrelation(tickerBars, etfBars, uptoKey, date) {
  const tKeys = Object.keys(tickerBars).filter(k => k.startsWith(date) && k <= uptoKey).sort();
  const eKeys = Object.keys(etfBars).filter(k => k.startsWith(date) && k <= uptoKey).sort();

  if (tKeys.length < 10 || eKeys.length < 10) {
    return { correlation: 0, samples: 0 };
  }

  // Build 1-min returns for today only
  const tRets = new Map();
  for (let i = 1; i < tKeys.length; i++) {
    const curr = tickerBars[tKeys[i]];
    const prev = tickerBars[tKeys[i - 1]];
    if (curr?.c && prev?.c && prev.c > 0) {
      tRets.set(tKeys[i], (curr.c - prev.c) / prev.c);
    }
  }

  const eRets = new Map();
  for (let i = 1; i < eKeys.length; i++) {
    const curr = etfBars[eKeys[i]];
    const prev = etfBars[eKeys[i - 1]];
    if (curr?.c && prev?.c && prev.c > 0) {
      eRets.set(eKeys[i], (curr.c - prev.c) / prev.c);
    }
  }

  const corr = pairedCorrelation(tRets, eRets);
  const samples = Math.min(tRets.size, eRets.size);
  return { correlation: parseFloat(corr.toFixed(4)), samples };
}

/**
 * Clear cache (call between backtest runs).
 */
export function clearCorrelationCache() {
  cache.clear();
}

// ── 1-Minute Return Series ───────────────────────────────────────────────────

/**
 * Build bar-over-bar 1-minute returns for a set of trailing days.
 * ~390 bars/day * 5 days = ~1,950 data points.
 */
function build1MinReturns(bars, days) {
  const series = [];
  const allKeys = Object.keys(bars).sort();

  for (const day of days) {
    const dayKeys = allKeys.filter(k => k.startsWith(day));

    for (let i = 1; i < dayKeys.length; i++) {
      const curr = bars[dayKeys[i]];
      const prev = bars[dayKeys[i - 1]];
      if (!curr?.c || !prev?.c || prev.c === 0) continue;

      series.push({
        time: dayKeys[i],
        ret: (curr.c - prev.c) / prev.c,
        vol: curr.v || 0,
      });
    }
  }

  return series;
}

// ── Paired Correlation ───────────────────────────────────────────────────────

/**
 * Pearson correlation between two return maps (aligned by time key).
 */
function pairedCorrelation(mapA, mapB) {
  const xs = [];
  const ys = [];

  for (const [time, retA] of mapA) {
    const retB = mapB.get(time);
    if (retB !== undefined) {
      xs.push(retA);
      ys.push(retB);
    }
  }

  if (xs.length < MIN_SAMPLES) return 0;
  return pearson(xs, ys);
}

// ── Lead/Lag at 1-Minute Precision ───────────────────────────────────────────

/**
 * Cross-correlate at lags from -MAX_LAG to +MAX_LAG minutes.
 * Positive bestLag = ticker return at time T correlates with ETF at T+lag
 *   → ticker LEADS the ETF by lag minutes.
 * Negative bestLag = ETF leads ticker.
 */
function computeLeadLag(tickerRetMap, etfRetMap, trailDays) {
  let bestLag = 0;
  let bestCorr = 0;
  const lagProfile = [];

  for (let lag = -MAX_LAG_MINUTES; lag <= MAX_LAG_MINUTES; lag++) {
    const xs = [];
    const ys = [];

    for (const [time, tickerRet] of tickerRetMap) {
      const shiftedTime = shiftMinuteKey(time, lag);
      if (!shiftedTime) continue;
      // Only compare within same day (don't cross day boundaries)
      if (shiftedTime.slice(0, 10) !== time.slice(0, 10)) continue;

      const etfRet = etfRetMap.get(shiftedTime);
      if (etfRet !== undefined) {
        xs.push(tickerRet);
        ys.push(etfRet);
      }
    }

    if (xs.length < MIN_SAMPLES) continue;

    const corr = pearson(xs, ys);
    lagProfile.push({ lag, corr: parseFloat(corr.toFixed(4)), samples: xs.length });

    if (Math.abs(corr) > Math.abs(bestCorr)) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // Sort lag profile by absolute correlation (strongest first)
  lagProfile.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));

  return {
    bestLag,
    bestCorr: parseFloat(bestCorr.toFixed(4)),
    tickerLeads: bestLag > 0,
    etfLeads: bestLag < 0,
    lagMinutes: Math.abs(bestLag),
    // Top 5 lags for the strategy to evaluate
    lagProfile: lagProfile.slice(0, 5),
  };
}

// ── Burst Impact Analysis ────────────────────────────────────────────────────

/**
 * Detect sharp N-bar bursts in the source, then measure what happens
 * to the target at each follow-through lag (1, 2, 3, 5, 8, 10 min).
 *
 * Returns per-lag hit rates and impact magnitudes — the strategy picks
 * the lag with the best edge.
 */
function computeBurstImpact(sourceBars, targetBars, days, atr, mode) {
  const sourceKeys = Object.keys(sourceBars).sort();
  const events = [];

  // Threshold depends on whether source is a ticker or ETF
  const isTicker = mode === 'TICKER_TO_ETF';

  for (const day of days) {
    const dayKeys = sourceKeys.filter(k => k.startsWith(day));
    if (dayKeys.length < BURST_WINDOW + MAX_LAG_MINUTES) continue;

    for (let i = BURST_WINDOW; i < dayKeys.length - MAX_LAG_MINUTES; i++) {
      const curr = sourceBars[dayKeys[i]];
      const prior = sourceBars[dayKeys[i - BURST_WINDOW]];
      if (!curr?.c || !prior?.c || prior.c === 0) continue;

      const burstPct = (curr.c - prior.c) / prior.c;
      const burstAbs = Math.abs(burstPct);

      // Apply threshold based on source type
      if (isTicker && burstAbs / atr < MIN_TICKER_BURST_ATR) continue;
      if (!isTicker && burstAbs < MIN_SPY_BURST_PCT) continue;

      const burstDir = burstPct > 0 ? 1 : -1;
      const triggerTime = dayKeys[i];

      // Measure target response at each lag
      for (const lagMin of FOLLOW_LAGS) {
        const futureTime = shiftMinuteKey(triggerTime, lagMin);
        if (!futureTime) continue;

        const targetNow = targetBars[triggerTime];
        const targetFuture = targetBars[futureTime];
        if (!targetNow?.c || !targetFuture?.c || targetNow.c === 0) continue;

        const targetMove = (targetFuture.c - targetNow.c) / targetNow.c;
        const sameDirection = Math.sign(targetMove) === burstDir;
        const amplification = burstAbs > 0 ? Math.abs(targetMove) / burstAbs : 0;

        events.push({
          day,
          triggerTime,
          burstPct: burstPct * 100,
          burstATRs: burstAbs / atr,
          targetMovePct: targetMove * 100,
          sameDirection,
          amplification,
          lagMinutes: lagMin,
        });
      }
    }
  }

  if (events.length < 10) {
    return {
      hitRate: 0, avgAmplification: 1, bestLagMinutes: 0,
      bestLagHitRate: 0, sampleCount: 0, perLag: {},
    };
  }

  // Aggregate per-lag statistics
  const perLag = {};
  for (const lagMin of FOLLOW_LAGS) {
    const lagEvents = events.filter(e => e.lagMinutes === lagMin);
    if (lagEvents.length === 0) continue;

    const sameDirCount = lagEvents.filter(e => e.sameDirection).length;
    const sameDirEvents = lagEvents.filter(e => e.sameDirection);
    const avgAmp = sameDirEvents.length > 0
      ? sameDirEvents.reduce((a, e) => a + e.amplification, 0) / sameDirEvents.length : 0;
    const avgTargetMove = lagEvents.reduce((a, e) => a + Math.abs(e.targetMovePct), 0) / lagEvents.length;

    perLag[lagMin] = {
      hitRate: parseFloat((sameDirCount / lagEvents.length).toFixed(3)),
      avgAmplification: parseFloat(avgAmp.toFixed(3)),
      avgTargetMovePct: parseFloat(avgTargetMove.toFixed(4)),
      samples: lagEvents.length,
    };
  }

  // Overall stats
  const totalSameDir = events.filter(e => e.sameDirection).length;
  const overallHitRate = totalSameDir / events.length;

  // Best lag: highest hit rate
  let bestLagMin = 3;
  let bestLagHitRate = 0;
  for (const [lag, stats] of Object.entries(perLag)) {
    if (stats.hitRate > bestLagHitRate && stats.samples >= 5) {
      bestLagHitRate = stats.hitRate;
      bestLagMin = parseInt(lag);
    }
  }

  const sameDirEvents = events.filter(e => e.sameDirection);
  const avgAmp = sameDirEvents.length > 0
    ? sameDirEvents.reduce((a, e) => a + e.amplification, 0) / sameDirEvents.length : 1;

  return {
    hitRate: parseFloat(overallHitRate.toFixed(3)),
    avgAmplification: parseFloat(avgAmp.toFixed(3)),
    bestLagMinutes: bestLagMin,
    bestLagHitRate: parseFloat(bestLagHitRate.toFixed(3)),
    sampleCount: events.length,
    perLag,
  };
}

// ── Conditional Analysis ─────────────────────────────────────────────────────

/**
 * Slice correlation by time-of-day and volume regime.
 * AM = before 12:00 ET (~17:00 UTC), PM = after.
 * High-vol = bars where volume > median volume.
 */
function computeConditional(tickerRetMap, etfRetMap, tickerReturns) {
  // Compute median volume for high/low vol split
  const vols = tickerReturns.map(r => r.vol).filter(v => v > 0).sort((a, b) => a - b);
  const medianVol = vols.length > 0 ? vols[Math.floor(vols.length / 2)] : 0;
  const volLookup = new Map(tickerReturns.map(r => [r.time, r.vol]));

  const amXs = [], amYs = [];
  const pmXs = [], pmYs = [];
  const hiVolXs = [], hiVolYs = [];
  const loVolXs = [], loVolYs = [];

  for (const [time, tRet] of tickerRetMap) {
    const eRet = etfRetMap.get(time);
    if (eRet === undefined) continue;

    const hour = parseInt(time.slice(11, 13));
    if (hour < 17) { amXs.push(tRet); amYs.push(eRet); }
    else           { pmXs.push(tRet); pmYs.push(eRet); }

    const vol = volLookup.get(time) || 0;
    if (medianVol > 0 && vol > medianVol) { hiVolXs.push(tRet); hiVolYs.push(eRet); }
    else                                  { loVolXs.push(tRet); loVolYs.push(eRet); }
  }

  return {
    amCorrelation: amXs.length >= MIN_SAMPLES
      ? parseFloat(pearson(amXs, amYs).toFixed(4)) : null,
    pmCorrelation: pmXs.length >= MIN_SAMPLES
      ? parseFloat(pearson(pmXs, pmYs).toFixed(4)) : null,
    highVolCorrelation: hiVolXs.length >= MIN_SAMPLES
      ? parseFloat(pearson(hiVolXs, hiVolYs).toFixed(4)) : null,
    lowVolCorrelation: loVolXs.length >= MIN_SAMPLES
      ? parseFloat(pearson(loVolXs, loVolYs).toFixed(4)) : null,
    amSamples: amXs.length,
    pmSamples: pmXs.length,
    highVolSamples: hiVolXs.length,
    lowVolSamples: loVolXs.length,
  };
}

// ── Math Utilities ───────────────────────────────────────────────────────────

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
    sumY2 += ys[i] * ys[i];
  }

  const denom = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Shift a minute key (YYYY-MM-DDTHH:MM) by N minutes.
 * Returns empty string if it would cross day boundaries.
 */
function shiftMinuteKey(key, minutes) {
  const [datePart, timePart] = key.split('T');
  if (!timePart) return '';
  const [h, m] = timePart.split(':').map(Number);
  const totalMin = h * 60 + m + minutes;
  if (totalMin < 0 || totalMin >= 24 * 60) return '';
  const newH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const newM = String(totalMin % 60).padStart(2, '0');
  return `${datePart}T${newH}:${newM}`;
}
