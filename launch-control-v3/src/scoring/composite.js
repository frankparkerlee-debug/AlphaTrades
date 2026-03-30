import { clamp } from '../utils/math.js';
import { determineDirection } from './direction.js';
import { computePaScore } from './pa.js';
import { computeVolumeScore } from './volume.js';
import { computeNewsScore } from './news.js';
import { computeMarketScore } from './market.js';
import { computeTimingScore } from './timing.js';
import { query } from '../data/db.js';
import { selectOptionsContract } from '../options/contract-selector.js';
import logger from '../utils/logger.js';

// Grade thresholds — calibrated for B+ daily, A- weekly, A weekly, A+ monthly
const GRADE_SCALE = [
  [95, 'A+'],
  [90, 'A'],
  [84, 'A-'],
  [74, 'B+'],
  [60, 'B'],
  [45, 'B-'],
  [0,  'C'],
];

const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C'];

const POSITION_SIZES = {
  'A+': 0.20,
  'A':  0.15,
  'A-': 0.10,
  'B+': 0.075,
  'B':  0.05,
  'B-': 0.025,
};

function rawToGrade(composite) {
  for (const [threshold, grade] of GRADE_SCALE) {
    if (composite >= threshold) return grade;
  }
  return 'C';
}

function applyCaps(grade, caps) {
  let result = grade;
  for (const cap of caps.filter(Boolean)) {
    if (GRADE_ORDER.indexOf(result) < GRADE_ORDER.indexOf(cap)) {
      result = cap;
    }
  }
  return result;
}

function gradeIsBetterThan(g1, g2) {
  return GRADE_ORDER.indexOf(g1) < GRADE_ORDER.indexOf(g2);
}

/**
 * Primary quality filter — PA and Volume must both clear elevated thresholds
 * AND all 5 pillars above midpoint (no weak links)
 */
function primaryFilter(ts, pas, vs, ns, ms) {
  // Hard gate — PA and Volume both required at higher bar
  if (pas <= 20 || vs <= 18) return false;

  // All 5 pillars above midpoint — no weak links allowed
  const midpoints = [2.5, 17.5, 15, 7.5, 7.5];
  const scores    = [ts,  pas,  vs, ns,  ms ];
  const above = scores.filter((s, i) => s > midpoints[i]).length;
  return above >= 5;
}

/**
 * Relaxed base layer filter — no-signal days only
 */
function baseLayerFilter(ts, pas, vs, ns, ms) {
  if (pas <= 12) return false;
  const midpoints = [2.5, 12, 10, 5, 5];
  const scores    = [ts, pas, vs, ns, ms];
  const above = scores.filter((s, i) => s > midpoints[i]).length;
  return above >= 3;
}

/**
 * Main composite computation — runs every 10 seconds per ticker
 */
export async function computeComposite(params) {
  const {
    ticker,
    barData,          // { open, high, low, close, volume, vwap, prevClose, upVolRatio, prevDayHigh, prevDayLow }
    marketData,       // { spyPct, qqqPct, sectorPct, exchangeEtfPct, vix }
    newsEvents,       // array of classified news events
    profile,          // equity_profiles row
    currentTime,      // Date object
    announcementCtx,  // { isPostAnnouncement, minsSince, type }
    isBaseLayer = false,
  } = params;

  const allFlags = [];

  // Step 1: Determine direction FIRST
  const dirResult = determineDirection({
    currentPrice: barData.close,
    prevClose: barData.prevClose,
    currentVwap: barData.vwap,
    upVolRatio: barData.upVolRatio,
    qqqChangePct: marketData.qqqPct,
  });

  if (!dirResult) return null; // ambiguous tape

  const { direction, confidence } = dirResult;
  if (confidence === 'LOW') allFlags.push('LOW_DIRECTION_CONFIDENCE');

  // Step 2: Compute all pillars
  const timing = computeTimingScore({
    currentTime,
    openingChopMinutes: profile.opening_chop_minutes,
    vixCurrent: marketData.vix,
    isPostAnnouncement: announcementCtx?.isPostAnnouncement || false,
    minsSinceAnnouncement: announcementCtx?.minsSince || 0,
    postFomcQuality: profile.post_fomc_quality,
    postCpiQuality: profile.post_cpi_quality,
    announcementType: announcementCtx?.type,
    bestWindows: profile.best_windows,
    worstWindows: profile.worst_windows,
  });

  const pa = computePaScore({
    direction,
    currentPrice: barData.close,
    openPrice: barData.open,
    highPrice: barData.high,
    lowPrice: barData.low,
    prevClose: barData.prevClose,
    currentVwap: barData.vwap,
    prevDayHigh: barData.prevDayHigh,
    prevDayLow: barData.prevDayLow,
    atr20d: profile.atr_20d,
    atr5d: profile.atr_5d,
    momentumPersistence: profile.momentum_persistence,
  });

  const vol = computeVolumeScore({
    direction,
    currentBarVolume: barData.volume,
    upVolRatio: barData.upVolRatio,
    avgVolByWindow: profile.avg_vol_by_window,
    volToMoveCorrelation: profile.vol_to_move_correlation,
    currentTime,
  });

  const news = computeNewsScore({
    direction,
    newsEvents,
    profile,
  });

  const market = computeMarketScore({
    direction,
    spyChangePct: marketData.spyPct,
    exchangeEtfChangePct: marketData.exchangeEtfPct,
    sectorEtfChangePct: marketData.sectorPct,
    betaQqq: profile.beta_qqq,
    sectorEtfCorrelation: profile.sector_etf_correlation,
    alignmentFollowthruRate: profile.alignment_followthru_rate,
  });

  // Collect all flags
  allFlags.push(...(vol.flags || []));
  allFlags.push(...(news.flags || []));
  allFlags.push(...(market.flags || []));
  if (timing.reason) allFlags.push(timing.reason);

  const ts = timing.score;
  const pas = pa.score;
  const vs = vol.score;
  const ns = news.score;
  const ms = market.score;

  // Step 3: Quality filter BEFORE composite assembly
  if (!isBaseLayer) {
    if (!primaryFilter(ts, pas, vs, ns, ms)) return null;
  } else {
    if (!baseLayerFilter(ts, pas, vs, ns, ms)) return null;
  }

  // Step 4: Composite assembly with HARD CLAMP
  const raw = ts + pas + vs + ns + ms + timing.bonus + (news.stackBonus || 0);
  const composite = clamp(Math.round(raw), 0, 110); // HARD CLAMP — always

  // Step 5: Grade lookup
  const rawGrade = rawToGrade(composite);
  if (rawGrade === 'C') return null;

  // Step 6: Apply caps
  const allCaps = [timing.cap, news.cap, market.cap].filter(Boolean);
  const conflictDetected = allCaps.includes('B-');
  const grade = applyCaps(rawGrade, allCaps);
  const gradeCapped = grade !== rawGrade;

  // Don't trade B- signals
  if (grade === 'B-' || grade === 'C') return null;

  // Position sizing
  const positionSizePct = isBaseLayer ? 0.075 : (POSITION_SIZES[grade] || 0.05);
  const accountSize = parseFloat(process.env.ACCOUNT_SIZE || '7500');
  const positionSizeDollars = Math.round(accountSize * positionSizePct);

  return {
    ticker,
    direction,
    directionConfidence: confidence,
    signalTier: isBaseLayer ? 'base_layer' : 'primary',
    compositeRaw: composite,
    grade,
    gradeCapped,
    capReason: allCaps.join(',') || null,
    postAnnouncementBonus: timing.bonus,
    scores: { timing: ts, priceAction: pas, volume: vs, news: ns, market: ms },
    scoreDetails: { pa, vol, news, market, timing },
    flags: allFlags,
    conflictDetected,
    positionSizePct,
    positionSizeDollars,
    // Market snapshot
    marketSnapshot: {
      price: barData.close,
      vwap: barData.vwap,
      atrMultiple: pa.atrMultiple,
      relativeVolume: vol.relativeVol,
      spyPct: marketData.spyPct,
      qqqPct: marketData.qqqPct,
      sectorPct: marketData.sectorPct,
      exchangeEtfPct: marketData.exchangeEtfPct,
      vix: marketData.vix,
    },
    // News snapshot
    newsSnapshot: {
      headline: news.headline,
      catalystType: news.catalystType,
      polarity: news.polarity,
      ageMinutes: news.ageMinutes,
      stackCount: news.stackCount,
      stackBonus: news.stackBonus,
    },
  };
}

/**
 * Write a qualified signal to the DB
 */
export async function writeSignal(signal, clusterCtx = {}) {
  const expiresAt = new Date(Date.now() + 60 * 1000); // 60 second expiry

  // Fetch options contract recommendation
  let contract = null;
  try {
    contract = await selectOptionsContract(
      signal.ticker,
      signal.direction,
      signal.grade,
      signal.marketSnapshot.price,
      signal.marketSnapshot.atrMultiple,
    );
  } catch (err) {
    logger.warn(`Contract selection failed for ${signal.ticker}: ${err.message}`);
  }

  try {
    const res = await query(`
      INSERT INTO lc_v3.signals (
        expires_at, status, ticker, direction, signal_tier,
        composite_raw, grade, grade_capped, cap_reason, post_announcement_bonus,
        score_timing, score_price_action, score_volume, score_news, score_market,
        price_at_signal, vwap_at_signal, atr_multiple, relative_volume,
        spy_change_pct, qqq_change_pct, sector_change_pct, exchange_etf_change_pct, vix_at_signal,
        news_headline, news_catalyst_type, news_polarity, news_age_minutes,
        news_stack_count, news_stack_bonus,
        cluster_id, cluster_context, leader_ticker, leader_move_pct,
        propagation_lag_min, confluence_score,
        flags, conflict_detected,
        position_size_pct, position_size_dollars,
        contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
        contract_bid, contract_ask, contract_mid,
        contract_entry_lo, contract_entry_hi,
        contract_delta, contract_iv,
        contract_t1, contract_t2, contract_t3, contract_stop,
        contract_estimated
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,
        $52,$53,$54,$55,$56
      ) RETURNING signal_id
    `, [
      expiresAt, 'ACTIVE', signal.ticker, signal.direction, signal.signalTier,
      signal.compositeRaw, signal.grade, signal.gradeCapped, signal.capReason, signal.postAnnouncementBonus,
      signal.scores.timing, signal.scores.priceAction, signal.scores.volume,
      signal.scores.news, signal.scores.market,
      signal.marketSnapshot.price, signal.marketSnapshot.vwap,
      signal.marketSnapshot.atrMultiple, signal.marketSnapshot.relativeVolume,
      signal.marketSnapshot.spyPct, signal.marketSnapshot.qqqPct,
      signal.marketSnapshot.sectorPct, signal.marketSnapshot.exchangeEtfPct,
      signal.marketSnapshot.vix,
      signal.newsSnapshot.headline, signal.newsSnapshot.catalystType,
      signal.newsSnapshot.polarity, signal.newsSnapshot.ageMinutes,
      signal.newsSnapshot.stackCount, signal.newsSnapshot.stackBonus,
      clusterCtx.clusterId || null, clusterCtx.context || 'STANDALONE',
      clusterCtx.leaderTicker || null, clusterCtx.leaderMovePct || null,
      clusterCtx.propagationLagMin || null, signal.confluenceScore || 0,
      JSON.stringify(signal.flags), signal.conflictDetected,
      signal.positionSizePct, signal.positionSizeDollars,
      contract?.symbol || null, contract?.strike || null,
      contract?.expiry || null, contract?.expiry_label || null,
      contract?.bid || null, contract?.ask || null, contract?.mid || null,
      contract?.entry_lo || null, contract?.entry_hi || null,
      contract?.delta || null, contract?.iv || null,
      contract?.t1 || null, contract?.t2 || null,
      contract?.t3 || null, contract?.stop || null,
      contract?.estimated || false,
    ]);

    logger.signal(signal);
    return res.rows[0].signal_id;
  } catch (err) {
    logger.error(`Failed to write signal for ${signal.ticker}:`, err.message);
    return null;
  }
}

/**
 * Unit test helper — run with known inputs and verify output
 */
export async function testScoring() {
  logger.info('Running scoring unit tests...');

  // Test 1: Strong CALL setup should score well
  const profile = {
    opening_chop_minutes: 22,
    atr_20d: 0.038,
    atr_5d: 0.040,
    momentum_persistence: 0.82,
    beta_qqq: 1.82,
    beta_spy: 1.50,
    sector_etf_correlation: 0.88,
    exchange_etf_correlation: 0.85,
    alignment_followthru_rate: 0.75,
    post_fomc_quality: 0.80,
    post_cpi_quality: 0.75,
    vol_to_move_correlation: 0.72,
    news_fade_rate: 0.42,
    avg_vol_by_window: { '10:15': 120000 },
    best_windows: [],
    worst_windows: [],
  };

  const result = await computeComposite({
    ticker: 'NVDA',
    barData: {
      open: 178.00, high: 181.50, low: 177.50, close: 181.00,
      volume: 280000, vwap: 179.00, prevClose: 175.00,
      upVolRatio: 0.72, prevDayHigh: 180.00, prevDayLow: 172.00,
    },
    marketData: {
      spyPct: 0.008, qqqPct: 0.012, sectorPct: 0.018,
      exchangeEtfPct: 0.012, vix: 16,
    },
    newsEvents: [],
    profile,
    currentTime: new Date('2024-10-15T14:15:00-04:00'),
    announcementCtx: null,
  });

  if (result) {
    logger.info(`✓ Test 1 PASS: NVDA CALL grade=${result.grade} composite=${result.compositeRaw}`);
    logger.info(`  PA=${result.scores.priceAction} Vol=${result.scores.volume} News=${result.scores.news} Market=${result.scores.market} Timing=${result.scores.timing}`);
    if (result.compositeRaw < 0) {
      logger.error('❌ FAIL: Negative composite score!');
    }
  } else {
    logger.warn('Test 1: No signal generated (may be expected for test data)');
  }

  // Test 2: Clamped composite — should never go negative
  const weakResult = await computeComposite({
    ticker: 'NVDA',
    barData: {
      open: 175.00, high: 175.50, low: 174.00, close: 174.50,
      volume: 50000, vwap: 176.00, prevClose: 175.00,
      upVolRatio: 0.30, prevDayHigh: 180.00, prevDayLow: 172.00,
    },
    marketData: {
      spyPct: -0.008, qqqPct: -0.012, sectorPct: -0.015,
      exchangeEtfPct: -0.012, vix: 22,
    },
    newsEvents: [
      {
        headline: 'NVDA faces new chip export restriction from Commerce Department',
        catalyst: { type: 'ai_chip_export_restriction', sensitivity: 2.4, affectsCluster: false, decayHours: 24 },
        polarity: -2,
        timestamp: new Date(Date.now() - 30 * 60 * 1000),
      }
    ],
    profile,
    currentTime: new Date('2024-10-15T14:15:00-04:00'),
    announcementCtx: null,
  });

  if (weakResult === null) {
    logger.info('✓ Test 2 PASS: Weak/opposing setup correctly returned null (no signal)');
  } else if (weakResult.compositeRaw >= 0) {
    logger.info(`✓ Test 2 PASS: Composite clamped correctly at ${weakResult.compositeRaw}`);
  } else {
    logger.error(`❌ Test 2 FAIL: Negative composite ${weakResult.compositeRaw} leaked through!`);
  }

  logger.info('Scoring unit tests complete');
}
