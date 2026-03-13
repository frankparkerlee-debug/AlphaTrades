/**
 * Bar Replay Engine
 * Replays the exact REST poller scoring logic from server.js
 * minute-by-minute against historical data.
 */

import { classifyRegime, analyzeLevels, analyzeTrend, gateSignal } from '../../src/scoring/intelligence.js';
import { computeNewsScore } from './news-scorer.js';

// ── Constants (mirrored from server.js) ──────────────────────────
const GRADE_SCALE  = [[83,'A+'],[73,'A'],[63,'A-'],[53,'B+'],[43,'B']];
const POSITION_SZ  = {'A+':0.20,'A':0.15,'A-':0.10,'B+':0.075,'B':0.05};

function toGrade(score) {
  for (const [t, g] of GRADE_SCALE) if (score >= t) return g;
  return null;
}

// ── Time Helpers ──────────────────────────────────────────────────
function toET(isoStr) {
  return new Date(new Date(isoStr).toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function minutesSinceMktOpen(isoStr) {
  const et = toET(isoStr);
  return et.getHours() * 60 + et.getMinutes() - 570; // 9:30 = 570
}

function timingScore(isoStr) {
  const et = toET(isoStr);
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 570 && mins < 660) return 5; // first 90 min
  if (mins >= 660 && mins < 720) return 4; // mid morning
  if (mins >= 720 && mins < 780) return 1; // lunch
  if (mins >= 780 && mins < 960) return 3; // afternoon
  return 2;
}

function isMarketHour(isoStr) {
  const et = toET(isoStr);
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 571 && mins < 960; // 9:31 - 3:59 (need prevBar so start at 9:31)
}

// ── VIX Lookup ────────────────────────────────────────────────────
function getVix(vixByTime, barTime) {
  // Find nearest 15-min VIX bar at or before this time
  const t = new Date(barTime);
  // Round down to nearest 15 min
  t.setMinutes(Math.floor(t.getMinutes() / 15) * 15);
  t.setSeconds(0);

  for (let i = 0; i < 8; i++) { // Look back up to 2 hours
    const key = t.toISOString().slice(0, 16);
    if (vixByTime[key]) return vixByTime[key];
    t.setMinutes(t.getMinutes() - 15);
  }
  return 18; // default
}

// ── Get Sorted Minute Keys for a Ticker on a Date ─────────────────
function getMinuteKeysForDate(minuteIndex, date) {
  return Object.keys(minuteIndex)
    .filter(k => k.startsWith(date))
    .sort();
}

// ── Main Replay ──────────────────────────────────────────────────
export function replayAllDays(data, profiles, config, scoredNews) {
  const { tradingDays, minuteBars, etfMinuteBars, dailyBars, vixByTime } = data;
  const allSignals = [];

  for (const day of tradingDays) {
    const daySignals = replayDay(day, data, profiles, config, scoredNews);
    allSignals.push(...daySignals);
  }

  return allSignals;
}

function replayDay(day, data, profiles, config, scoredNews) {
  const { minuteBars, etfMinuteBars, dailyBars, vixByTime } = data;
  const tickers = Object.keys(profiles).filter(t => minuteBars[t]);
  const signals = [];
  const firedToday = new Set(); // one signal per ticker+direction per day

  // Get SPY/QQQ prevClose for this day
  const spyDaily = dailyBars.SPY || {};
  const qqqDaily = dailyBars.QQQ || {};

  // Find previous trading day for prevClose
  const dayIndex = data.tradingDays.indexOf(day);
  const prevDay = dayIndex > 0 ? data.tradingDays[dayIndex - 1] : null;
  const spyPrevClose = prevDay && spyDaily[prevDay] ? spyDaily[prevDay].c : spyDaily[day]?.o || 0;
  const qqqPrevClose = prevDay && qqqDaily[prevDay] ? qqqDaily[prevDay].c : qqqDaily[day]?.o || 0;

  // Get sorted minute keys for SPY to iterate through time
  const spyKeys = getMinuteKeysForDate(etfMinuteBars.SPY || {}, day);

  if (spyKeys.length === 0) return signals;

  // Session state per ticker
  const sessionState = {};
  for (const ticker of tickers) {
    const prevDayBar = prevDay ? (dailyBars[ticker] || {})[prevDay] : null;
    const todayDailyBar = (dailyBars[ticker] || {})[day];
    sessionState[ticker] = {
      prevClose:   prevDayBar?.c || todayDailyBar?.o || 0,
      prevDayHigh: prevDayBar?.h || 0,
      prevDayLow:  prevDayBar?.l || 0,
      prevDayVol:  prevDayBar?.v || 1,
      openPrice:   todayDailyBar?.o || 0,
      sessionHigh: todayDailyBar?.o || 0,
      sessionLow:  todayDailyBar?.o || Infinity,
      cumVolume:   0,
      barCount:    0,
      prevBar:     null,
    };
  }

  // Classify regime once per iteration (updates with SPY data)
  let prevSpyBars = [];

  for (const timeKey of spyKeys) {
    if (!isMarketHour(timeKey + ':00Z')) continue;

    const spyBar = etfMinuteBars.SPY?.[timeKey];
    const qqqBar = etfMinuteBars.QQQ?.[timeKey];
    if (!spyBar || !qqqBar) continue;

    const spyPct = spyPrevClose > 0 ? (spyBar.c - spyPrevClose) / spyPrevClose : 0;
    const qqqPct = qqqPrevClose > 0 ? (qqqBar.c - qqqPrevClose) / qqqPrevClose : 0;

    // Track SPY bars for regime detection
    prevSpyBars.push({ o: spyBar.o, h: spyBar.h, l: spyBar.l, c: spyBar.c });
    if (prevSpyBars.length > 3) prevSpyBars = prevSpyBars.slice(-3);

    const vix = getVix(vixByTime, timeKey + ':00Z');
    const regime = classifyRegime({ spyPct, qqqPct }, vix, prevSpyBars);

    const minsOpen = minutesSinceMktOpen(timeKey + ':00Z');

    // Score each ticker at this minute
    for (const ticker of tickers) {
      const bar = minuteBars[ticker]?.[timeKey];
      if (!bar) continue;

      const ss = sessionState[ticker];
      if (!ss.prevClose || ss.prevClose === 0) continue;

      // Update session state
      ss.sessionHigh = Math.max(ss.sessionHigh, bar.h);
      ss.sessionLow  = Math.min(ss.sessionLow, bar.l);
      ss.cumVolume  += bar.v || 0;
      ss.barCount++;

      if (!ss.openPrice || ss.openPrice === 0) ss.openPrice = bar.o;

      const price = bar.c;
      const prevBar = ss.prevBar;
      ss.prevBar = bar;

      if (!prevBar) continue; // Need at least 2 bars

      // ── Scoring (mirrors corrected server.js) ──
      const atr = parseFloat(profiles[ticker]?.atr_20d || 0.025);

      // Session move from open (not minute-to-minute)
      const sessionMove = ss.openPrice > 0 ? (price - ss.openPrice) / ss.openPrice : 0;
      const direction   = sessionMove >= 0 ? 'CALL' : 'PUT';
      const mult        = direction === 'CALL' ? 1 : -1;
      const moveInATRs  = atr > 0 ? Math.abs(sessionMove) / atr : 0;

      // Gate: minimum session move
      if (moveInATRs < 0.1) continue;

      // Freshness
      const freshness = moveInATRs < 0.5  ? 'FRESH'
                      : moveInATRs < 1.0  ? 'DEVELOPING'
                      : moveInATRs < 1.5  ? 'EXTENDED'
                      : moveInATRs < 2.0  ? 'LATE'
                      : 'EXHAUSTED';

      // Intelligence gating
      const vwap = bar.vw || price;
      const mockState = {
        close: price, vwap,
        sessionHigh: ss.sessionHigh, sessionLow: ss.sessionLow,
        prevDayHigh: ss.prevDayHigh, prevDayLow: ss.prevDayLow,
        sessionOpen: ss.openPrice,
        bars: [prevBar, bar].map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 })),
      };

      const levels = analyzeLevels(mockState, atr);
      const trend  = analyzeTrend(
        [prevBar, bar].map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 })),
        direction
      );
      const gate = gateSignal(direction, trend, levels, regime, freshness);

      if (!gate.allow) continue;

      // ── Pillar Scores ──
      const freshnessPenalty = moveInATRs > 1.5 ? 0.5 : moveInATRs > 1.0 ? 0.75 : 1.0;
      const paScore  = Math.min(35, Math.round(moveInATRs * 35 * freshnessPenalty));

      // Volume: projected daily pace vs previous day
      const prevDayVol = ss.prevDayVol || 1;
      const fractionOfDay = Math.min(1, minsOpen / 390);
      const projectedVol = fractionOfDay > 0 ? ss.cumVolume / fractionOfDay : ss.cumVolume;
      const relVol    = prevDayVol > 0 ? projectedVol / prevDayVol : 1;
      const volScore  = Math.min(30, Math.round(relVol * 12));

      const spyOk    = direction === 'CALL' ? spyPct > 0 : spyPct < 0;
      const qqqOk    = direction === 'CALL' ? qqqPct > 0 : qqqPct < 0;
      const mktScore = (spyOk ? 7 : 0) + (qqqOk ? 7 : 0);

      const timScore = timingScore(timeKey + ':00Z');

      // News score
      const news = computeNewsScore(scoredNews, ticker, day, timeKey + ':00Z', direction);
      const newsScore = news.score + news.stackBonus;

      const composite = paScore + volScore + mktScore + timScore + newsScore;

      // Grade
      let grade = toGrade(composite);
      if (!grade) continue;
      if (paScore < 15 || volScore < 12) continue;

      // Extended hours cap (shouldn't happen in backtest since we filter to market hours)
      const baseSizePct = (POSITION_SZ[grade] || 0.05);
      const sizePct     = baseSizePct * (gate.adjustedSizeMult || 1.0);

      // Dedup
      const key = `${ticker}-${direction}`;
      if (firedToday.has(key)) continue;
      firedToday.add(key);

      signals.push({
        date:        day,
        time:        timeKey,
        ticker,
        direction,
        grade,
        composite,
        scores: {
          pa:     paScore,
          vol:    volScore,
          mkt:    mktScore,
          tim:    timScore,
          news:   newsScore,
        },
        freshness,
        regime:      regime.regime,
        signalType:  gate.signalType,
        entryPrice:  price,
        atr,
        sizePct,
        sizeDollars: Math.round(config.accountSize * sizePct),
        newsHeadline: news.headline,
        relVol:      parseFloat(relVol.toFixed(2)),
        spyPct:      parseFloat((spyPct * 100).toFixed(2)),
        qqqPct:      parseFloat((qqqPct * 100).toFixed(2)),
        vix,
      });

      // Don't log every signal — too noisy for large backtests
    }
  }

  if (signals.length > 0) {
    console.log(`[REPLAY] ${day}: ${signals.length} signals (${[...new Set(signals.map(s => s.ticker))].join(', ')})`);
  }

  return signals;
}
