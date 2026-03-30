/**
 * Strategy Data Loader
 * Loads intelligence data from DB tables needed by all strategies.
 * Extends the bar data from data-fetcher-db.js with:
 *   - ticker_intelligence (IV rank, earnings, insider signals)
 *   - contagion_map (leader/follower relationships)
 *   - equity_profiles (extended fields)
 *   - sec_filings (8-K red flags)
 *   - iv_history (historical IV snapshots)
 */

import { query } from '../../src/data/db.js';

/**
 * Load all strategy-specific intelligence data.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {string[]} tickers - list of tickers
 * @returns {Object} { profiles, intelligence, contagionMap, secFilings, ivHistory, earningsCalendar }
 */
export async function loadStrategyData(startDate, endDate, tickers) {
  console.log(`[STRATEGY-DATA] Loading intelligence for ${tickers.length} tickers: ${startDate} -> ${endDate}`);

  const [profiles, intelligence, contagionMap, secFilings, ivHistory] = await Promise.all([
    loadProfiles(tickers),
    loadIntelligence(tickers),
    loadContagionMap(tickers),
    loadSecFilings(tickers, startDate, endDate),
    loadIVHistory(tickers, startDate, endDate),
  ]);

  // Build earnings calendar from intelligence data
  const earningsCalendar = buildEarningsCalendar(intelligence);

  console.log(`[STRATEGY-DATA] Profiles: ${Object.keys(profiles).length}, Intelligence: ${Object.keys(intelligence).length}`);
  console.log(`[STRATEGY-DATA] Contagion pairs: ${Object.keys(contagionMap).length}, IV history entries: ${Object.values(ivHistory).reduce((a, b) => a + b.length, 0)}`);

  return { profiles, intelligence, contagionMap, secFilings, ivHistory, earningsCalendar };
}

/**
 * Load extended equity profiles.
 */
async function loadProfiles(tickers) {
  const res = await query('SELECT * FROM lc_v3.equity_profiles');
  const profiles = {};
  for (const row of res.rows) {
    profiles[row.ticker] = {
      ticker:               row.ticker,
      atr_20d:              parseFloat(row.atr_20d || 0.025),
      atr_5d:               parseFloat(row.atr_5d || 0.025),
      avg_daily_range_pct:  parseFloat(row.avg_daily_range_pct || 0.03),
      beta_spy:             parseFloat(row.beta_spy || 1.0),
      beta_qqq:             parseFloat(row.beta_qqq || 1.0),
      sector_etf:           row.sector_etf || null,
      sector_etf_correlation: parseFloat(row.sector_etf_correlation || 0.5),
      exchange_etf_correlation: parseFloat(row.exchange_etf_correlation || 0.5),
      momentum_persistence: parseFloat(row.momentum_persistence || 0.5),
      mean_reversion_speed: parseFloat(row.mean_reversion_speed || 0.5),
      options_liquidity_score: parseFloat(row.options_liquidity_score || 0.5),
      opening_chop_minutes: parseInt(row.opening_chop_minutes || 15),
      best_windows:         row.best_windows || null,
      worst_windows:        row.worst_windows || null,
      post_fomc_quality:    parseFloat(row.post_fomc_quality || 0.5),
      post_cpi_quality:     parseFloat(row.post_cpi_quality || 0.5),
      alignment_followthru_rate: parseFloat(row.alignment_followthru_rate || 0.5),
      cluster_id:           row.cluster_id || null,
      cluster_role:         row.cluster_role || null,
      news_fade_rate:       parseFloat(row.news_fade_rate || 0.4),
      avg_vol_by_window:    row.avg_vol_by_window || null,
      vol_to_move_correlation: parseFloat(row.vol_to_move_correlation || 0.5),
      panic_vol_threshold:  parseFloat(row.panic_vol_threshold || 3.0),
    };
  }
  return profiles;
}

/**
 * Load ticker intelligence (IV rank, earnings, insider signals, etc.)
 */
async function loadIntelligence(tickers) {
  const res = await query('SELECT * FROM lc_v3.ticker_intelligence');
  const intel = {};
  for (const row of res.rows) {
    intel[row.ticker] = {
      ticker:               row.ticker,
      iv_rank_30d:          parseFloat(row.iv_rank_30d || 50),
      iv_percentile:        parseFloat(row.iv_percentile || 50),
      put_call_skew:        parseFloat(row.put_call_skew || 1.0),
      earnings_date:        row.earnings_date || null,
      earnings_days_away:   parseInt(row.earnings_days_away || 999),
      earnings_avg_move_pct: parseFloat(row.earnings_avg_move_pct || 3.0),
      earnings_beat_rate:   parseFloat(row.earnings_beat_rate || 0.5),
      historical_earnings:  row.historical_earnings || null,
      short_interest_pct:   parseFloat(row.short_interest_pct || 0),
      insider_net_90d:      parseFloat(row.insider_net_90d || 0),
      insider_signal:       row.insider_signal || 'NEUTRAL',
      analyst_consensus:    row.analyst_consensus || null,
      analyst_price_target: parseFloat(row.analyst_price_target || 0),
      upside_to_target_pct: parseFloat(row.upside_to_target_pct || 0),
      beta_30d:             parseFloat(row.beta_30d || 1.0),
    };
  }
  return intel;
}

/**
 * Load contagion map (leader/follower relationships).
 * Indexed by leader_ticker -> array of followers.
 */
async function loadContagionMap(tickers) {
  const res = await query('SELECT * FROM lc_v3.contagion_map WHERE sample_count >= 20');
  const map = {};
  for (const row of res.rows) {
    const leader = row.leader_ticker;
    if (!map[leader]) map[leader] = [];
    map[leader].push({
      follower:       row.follower_ticker,
      follow_rate:    parseFloat(row.follow_rate || 0),
      avg_magnitude:  parseFloat(row.avg_magnitude || 0),
      avg_lag_minutes: parseFloat(row.avg_lag_minutes || 15),
      divergence_rate: parseFloat(row.divergence_rate || 0),
      sample_count:   parseInt(row.sample_count || 0),
    });
  }
  return map;
}

/**
 * Load SEC filings with red flag detection.
 */
async function loadSecFilings(tickers, startDate, endDate) {
  let res;
  try {
    res = await query(`
      SELECT ticker, filed_at, form_type, description, is_red_flag, red_flag_reason
      FROM lc_v3.sec_filings
      WHERE filed_at >= $1::date - interval '30 days'
        AND filed_at <= $2::date + interval '7 days'
      ORDER BY filed_at DESC
    `, [startDate, endDate]);
  } catch {
    // Table may not exist
    return {};
  }

  const filings = {};
  for (const row of res.rows) {
    if (!filings[row.ticker]) filings[row.ticker] = [];
    filings[row.ticker].push({
      filed_at:       row.filed_at,
      form_type:      row.form_type,
      description:    row.description,
      is_red_flag:    row.is_red_flag,
      red_flag_reason: row.red_flag_reason,
    });
  }
  return filings;
}

/**
 * Load IV history for the backtest window.
 * Indexed by ticker -> array of { date, iv_rank, iv_atm, put_call_skew }.
 */
async function loadIVHistory(tickers, startDate, endDate) {
  let res;
  try {
    res = await query(`
      SELECT ticker, captured_at, iv_atm, iv_rank, put_call_skew
      FROM lc_v3.iv_history
      WHERE captured_at >= $1::date AND captured_at <= $2::date + interval '1 day'
      ORDER BY ticker, captured_at
    `, [startDate, endDate]);
  } catch {
    return {};
  }

  const history = {};
  for (const row of res.rows) {
    if (!history[row.ticker]) history[row.ticker] = [];
    history[row.ticker].push({
      date:           new Date(row.captured_at).toISOString().split('T')[0],
      iv_rank:        parseFloat(row.iv_rank || 50),
      iv_atm:         parseFloat(row.iv_atm || 0.30),
      put_call_skew:  parseFloat(row.put_call_skew || 1.0),
    });
  }
  return history;
}

/**
 * Build an earnings calendar from intelligence data.
 * Returns { 'YYYY-MM-DD': ['AAPL', 'MSFT'] } for quick date lookup.
 */
function buildEarningsCalendar(intelligence) {
  const cal = {};
  for (const [ticker, intel] of Object.entries(intelligence)) {
    if (intel.earnings_date) {
      const dateStr = new Date(intel.earnings_date).toISOString().split('T')[0];
      if (!cal[dateStr]) cal[dateStr] = [];
      cal[dateStr].push(ticker);
    }
  }
  return cal;
}
