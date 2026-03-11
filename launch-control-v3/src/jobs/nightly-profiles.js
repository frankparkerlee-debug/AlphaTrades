import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { query } from '../data/db.js';
import { WINDOW_KEYS, tradingDaysAgo } from '../utils/time.js';
import { atr, beta, pearson, percentile, mean, pctChange } from '../utils/math.js';
import logger from '../utils/logger.js';

const ALPACA_DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const FEED = process.env.ALPACA_FEED || 'sip';

const headers = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

// ── ALPACA DATA FETCHERS ───────────────────────────────

async function fetchDailyBars(ticker, startDate, endDate) {
  try {
    const url = `${ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`;
    const params = {
      timeframe: '1Day',
      start: startDate,
      end: endDate,
      feed: FEED,
      adjustment: 'all',
      limit: 1000,
    };
    const res = await axios.get(url, { headers, params });
    return res.data.bars || [];
  } catch (err) {
    logger.warn(`fetchDailyBars failed for ${ticker}: ${err.message}`);
    return [];
  }
}

async function fetch15MinBars(ticker, startDate, endDate) {
  try {
    const url = `${ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`;
    const params = {
      timeframe: '15Min',
      start: startDate,
      end: endDate,
      feed: FEED,
      adjustment: 'all',
      limit: 10000,
    };
    const res = await axios.get(url, { headers, params });
    return res.data.bars || [];
  } catch (err) {
    logger.warn(`fetch15MinBars failed for ${ticker}: ${err.message}`);
    return [];
  }
}

// ── WINDOW KEY FROM TIMESTAMP ──────────────────────────

function getWindowKey(timestamp) {
  // timestamp is ISO string e.g. "2024-10-15T14:15:00Z"
  // Convert to ET
  const et = new Date(new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours();
  const m = Math.floor(et.getMinutes() / 15) * 15;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── PROFILE CALCULATOR ─────────────────────────────────

async function updateProfile(ticker, refBars) {
  logger.info(`Updating profile: ${ticker}`);

  const startDate = tradingDaysAgo(65); // extra buffer
  const endDate = tradingDaysAgo(1);

  // 1. Daily bars for ATR and beta
  const dailyBars = await fetchDailyBars(ticker, startDate, endDate);
  if (dailyBars.length < 10) {
    logger.warn(`${ticker}: insufficient daily bars (${dailyBars.length}), skipping`);
    return;
  }

  // 2. ATR
  const last20 = dailyBars.slice(-20).map(b => ({
    high: b.h, low: b.l, close: b.c
  }));
  const last5 = dailyBars.slice(-5).map(b => ({
    high: b.h, low: b.l, close: b.c
  }));
  const lastClose = dailyBars[dailyBars.length - 1].c;
  const atr20d = atr(last20) / lastClose;
  const atr5d = atr(last5) / lastClose;

  // 3. Beta to QQQ and SPY
  const last30Daily = dailyBars.slice(-30);
  const stockReturns30 = last30Daily.slice(1).map((b, i) =>
    pctChange(b.c, last30Daily[i].c)
  );

  let betaQQQ = 1.0, betaSPY = 1.0;
  if (refBars.qqq && refBars.qqq.length >= 30) {
    const qqqRets = refBars.qqq.slice(-30).slice(1).map((b, i) =>
      pctChange(b.c, refBars.qqq.slice(-30)[i].c)
    );
    if (qqqRets.length === stockReturns30.length) {
      betaQQQ = beta(stockReturns30, qqqRets);
    }
  }
  if (refBars.spy && refBars.spy.length >= 30) {
    const spyRets = refBars.spy.slice(-30).slice(1).map((b, i) =>
      pctChange(b.c, refBars.spy.slice(-30)[i].c)
    );
    if (spyRets.length === stockReturns30.length) {
      betaSPY = beta(stockReturns30, spyRets);
    }
  }

  // 4. Sector and exchange ETF correlation
  const profile = await query(
    'SELECT sector_etf, exchange_etf FROM lc_v3.equity_profiles WHERE ticker = $1',
    [ticker]
  );
  let sectorCorr = 0.70, exchangeCorr = 0.80;

  if (profile.rows.length > 0) {
    const { sector_etf, exchange_etf } = profile.rows[0];
    if (refBars[sector_etf] && refBars[sector_etf].length >= 30) {
      const sectorRets = refBars[sector_etf].slice(-30).slice(1).map((b, i) =>
        pctChange(b.c, refBars[sector_etf].slice(-30)[i].c)
      );
      if (sectorRets.length === stockReturns30.length) {
        sectorCorr = pearson(stockReturns30, sectorRets);
      }
    }
    if (refBars[exchange_etf] && refBars[exchange_etf].length >= 30) {
      const exchRets = refBars[exchange_etf].slice(-30).slice(1).map((b, i) =>
        pctChange(b.c, refBars[exchange_etf].slice(-30)[i].c)
      );
      if (exchRets.length === stockReturns30.length) {
        exchangeCorr = pearson(stockReturns30, exchRets);
      }
    }
  }

  // 5. 15-min window baselines
  const bars15m = await fetch15MinBars(ticker, startDate, endDate);
  const windowGroups = {};
  WINDOW_KEYS.forEach(k => { windowGroups[k] = []; });

  bars15m.forEach(bar => {
    const wk = getWindowKey(bar.t);
    if (windowGroups[wk] !== undefined) {
      windowGroups[wk].push(bar.v || 0);
    }
  });

  const avgVolByWindow = {};
  WINDOW_KEYS.forEach(wk => {
    const vols = windowGroups[wk];
    avgVolByWindow[wk] = vols.length > 0 ? Math.round(mean(vols)) : 0;
  });

  // 6. Panic volume threshold (90th percentile relative volume)
  const allRelVols = [];
  bars15m.forEach(bar => {
    const wk = getWindowKey(bar.t);
    const avg = avgVolByWindow[wk];
    if (avg > 0 && bar.v > 0) {
      allRelVols.push(bar.v / avg);
    }
  });
  const panicVolThreshold = allRelVols.length > 0
    ? parseFloat(percentile(allRelVols, 90).toFixed(2))
    : 3.0;

  // 7. Opening chop minutes
  // Look at first bar ATR vs avg of bars 2-5
  const firstBarVols = windowGroups['09:30'] || [];
  const laterBarVols = [
    ...(windowGroups['09:45'] || []),
    ...(windowGroups['10:00'] || []),
    ...(windowGroups['10:15'] || []),
  ];
  let openingChopMinutes = 15;
  if (firstBarVols.length > 0 && laterBarVols.length > 0) {
    const firstAvg = mean(firstBarVols);
    const laterAvg = mean(laterBarVols);
    if (firstAvg > laterAvg * 1.8) {
      openingChopMinutes = 22; // high opening volatility
    }
  }
  // Override for known high-chop tickers
  if (ticker === 'NVDA') openingChopMinutes = Math.max(openingChopMinutes, 22);
  if (ticker === 'TSLA') openingChopMinutes = Math.max(openingChopMinutes, 28);

  // 8. Momentum persistence
  // What % of time does a strong bar continue in same direction for next 2 bars?
  let persistCount = 0, persistTotal = 0;
  for (let i = 1; i < bars15m.length - 2; i++) {
    const curr = bars15m[i];
    const wk = getWindowKey(curr.t);
    const avg = avgVolByWindow[wk];
    if (!avg || avg === 0) continue;
    const relVol = curr.v / avg;
    if (relVol < 1.5) continue; // only count high-volume bars
    const move = pctChange(curr.c, curr.o);
    const next1 = pctChange(bars15m[i+1].c, bars15m[i+1].o);
    const next2 = pctChange(bars15m[i+2].c, bars15m[i+2].o);
    const continues = (move > 0 && next1 > 0) || (move < 0 && next1 < 0);
    if (continues) persistCount++;
    persistTotal++;
  }
  const momentumPersistence = persistTotal > 10
    ? parseFloat((persistCount / persistTotal).toFixed(3))
    : 0.70;

  // 9. Vol to move correlation
  const barMoves = bars15m.map(b => Math.abs(pctChange(b.c, b.o)));
  const barVols = bars15m.map(b => {
    const wk = getWindowKey(b.t);
    const avg = avgVolByWindow[wk];
    return avg > 0 ? b.v / avg : 1;
  });
  const volToMoveCorr = barMoves.length > 20
    ? parseFloat(pearson(barMoves, barVols).toFixed(3))
    : 0.60;

  // 10. Write to DB
  await query(`
    UPDATE lc_v3.equity_profiles SET
      atr_20d = $1,
      atr_5d = $2,
      avg_vol_by_window = $3,
      panic_vol_threshold = $4,
      beta_qqq = $5,
      beta_spy = $6,
      sector_etf_correlation = $7,
      exchange_etf_correlation = $8,
      opening_chop_minutes = $9,
      momentum_persistence = $10,
      vol_to_move_correlation = $11,
      last_updated = NOW()
    WHERE ticker = $12
  `, [
    parseFloat(atr20d.toFixed(4)),
    parseFloat(atr5d.toFixed(4)),
    JSON.stringify(avgVolByWindow),
    panicVolThreshold,
    parseFloat(betaQQQ.toFixed(3)),
    parseFloat(betaSPY.toFixed(3)),
    parseFloat(sectorCorr.toFixed(3)),
    parseFloat(exchangeCorr.toFixed(3)),
    openingChopMinutes,
    momentumPersistence,
    parseFloat(volToMoveCorr.toFixed(3)),
    ticker,
  ]);

  const windowsSeeded = Object.values(avgVolByWindow).filter(v => v > 0).length;
  logger.info(`✓ ${ticker} — ATR=${(atr20d*100).toFixed(2)}% beta=${betaQQQ.toFixed(2)} windows=${windowsSeeded}/26 persist=${momentumPersistence}`);
}

// ── MAIN RUN FUNCTION ──────────────────────────────────

export async function run() {
  logger.info('Starting nightly profile update...');

  const startDate = tradingDaysAgo(65);
  const endDate = tradingDaysAgo(1);

  // Pre-fetch all reference ETFs once
  logger.info('Fetching reference ETF bars (QQQ, SPY, SMH, XLK, XLY, XLC)...');
  const refTickers = ['QQQ', 'SPY', 'SMH', 'XLK', 'XLY', 'XLC', 'DIA'];
  const refBars = {};
  for (const ref of refTickers) {
    refBars[ref] = await fetchDailyBars(ref, startDate, endDate);
    logger.info(`  ${ref}: ${refBars[ref].length} daily bars`);
    await sleep(300); // rate limit courtesy pause
  }

  // Get all tickers to update
  const result = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = result.rows.map(r => r.ticker);
  logger.info(`Updating ${tickers.length} equity profiles...`);

  let success = 0, failed = 0;
  for (const ticker of tickers) {
    try {
      await updateProfile(ticker, refBars);
      success++;
      await sleep(400); // rate limit — Alpaca allows ~200 req/min on Algo Trader Plus
    } catch (err) {
      logger.error(`Failed to update ${ticker}: ${err.message}`);
      failed++;
    }
  }

  logger.info(`\nNightly profile update complete: ${success} updated, ${failed} failed`);

  // Verification check
  const check = await query(`
    SELECT ticker,
      CASE WHEN avg_vol_by_window::text = '{}' THEN 0
           ELSE (SELECT COUNT(*) FROM jsonb_each(avg_vol_by_window))
      END as window_count,
      atr_20d,
      last_updated
    FROM lc_v3.equity_profiles
    WHERE last_updated > NOW() - INTERVAL '2 hours'
    ORDER BY ticker
  `);

  logger.info(`\nVerification — profiles updated in last 2 hours:`);
  check.rows.forEach(r => {
    const status = r.window_count >= 26 ? '✓' : '⚠';
    logger.info(`  ${status} ${r.ticker}: ${r.window_count} windows, ATR=${r.atr_20d}`);
  });

  const missing = check.rows.filter(r => r.window_count < 26);
  if (missing.length > 0) {
    logger.warn(`\n⚠ ${missing.length} profiles have incomplete window baselines:`);
    missing.forEach(r => logger.warn(`  - ${r.ticker}: ${r.window_count}/26 windows`));
  } else {
    logger.info('\n✅ All profiles have complete window baselines');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run directly if called as script
if (process.argv[1] && process.argv[1].includes('nightly-profiles')) {
  run().catch(err => {
    logger.error('Nightly profile update failed:', err);
    process.exit(1);
  });
}
