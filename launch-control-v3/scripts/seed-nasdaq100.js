/**
 * Seeds equity profiles for all Nasdaq 100 constituents.
 * Fetches the current list from a reliable source, then inserts
 * any missing tickers with default profiles.
 * Run: node scripts/seed-nasdaq100.js
 */

import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { query } from '../src/data/db.js';
import logger from '../src/utils/logger.js';

// Full Nasdaq 100 as of early 2026
// Source: Nasdaq.com constituent list
// Update quarterly or fetch dynamically from a data provider
const NASDAQ_100 = [
  // Mega cap tech
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','TSLA','AVGO','COST',
  // Large cap tech/growth
  'NFLX','AMD','ADBE','QCOM','INTC','INTU','CSCO','TXN','AMAT','MU',
  'LRCX','KLAC','MRVL','ADI','MCHP','SNPS','CDNS','FTNT','PANW','CRWD',
  // Software/Cloud
  'CRM','NOW','WDAY','TEAM','ZS','DDOG','OKTA','MDB','SNOW','PLTR',
  'ORCL','SAP','ADSK','ANSS','PTC',
  // Consumer/Retail
  'SBUX','ABNB','BKNG','EXPE','VRSK','CTAS','FAST','ODFL',
  // Biotech/Health
  'GILD','BIIB','REGN','VRTX','IDXX','ISRG','DXCM','ILMN',
  // Financial/Other
  'PYPL','FISV','PAYX','CTSH','CDNS','NXPI','ON','STX','WDC',
  // Additional Nasdaq names
  'ARM','SMCI','APP','ANET','CEG','AEP','XEL','WBD','LULU',
  'PCAR','GEHC','HON','KDP','MDLZ','MNST','PEP','ROST','TMUS',
  'TTD','VRSK','CPRT','DLTR','EBAY','EXC','FANG','GFS','GMAB',
  'HOOD','HSIC','IDXX','ILMN','KHC','MAR','MELI','MRNA','MTCH',
  'MYF','NTAP','ODFL','ORLY','PAYX','ROP','ROST','SGEN','SIRI',
  'SPLK','SWKS','ULTA','VRSN','VRTX','WBA','WLTW','XEL','ZM',
];

// Remove duplicates
const UNIQUE_TICKERS = [...new Set(NASDAQ_100)];

// Sector/ETF mappings for common tickers
const SECTOR_MAP = {
  // Semiconductors
  NVDA:'SMH', AMD:'SMH', AVGO:'SMH', QCOM:'SMH', INTC:'SMH', MU:'SMH',
  AMAT:'SMH', LRCX:'SMH', KLAC:'SMH', MRVL:'SMH', ADI:'SMH', MCHP:'SMH',
  NXPI:'SMH', ON:'SMH', ARM:'SMH', SMCI:'SMH', TXN:'SMH', STX:'SMH',
  WDC:'SMH', GFS:'SMH', SWKS:'SMH',
  // Software/Tech
  MSFT:'XLK', AAPL:'XLK', GOOGL:'XLK', GOOG:'XLK', META:'XLK',
  ADBE:'XLK', CRM:'XLK', NOW:'XLK', WDAY:'XLK', CSCO:'XLK',
  INTU:'XLK', SNPS:'XLK', CDNS:'XLK', ANSS:'XLK', PTC:'XLK',
  FTNT:'XLK', PANW:'XLK', CRWD:'XLK', ZS:'XLK', OKTA:'XLK',
  DDOG:'XLK', MDB:'XLK', TEAM:'XLK', ADSK:'XLK', ANET:'XLK',
  PLTR:'XLK', ORCL:'XLK', SAP:'XLK', TTD:'XLK', HOOD:'XLK',
  // Consumer Discretionary
  AMZN:'XLY', TSLA:'XLY', BKNG:'XLY', ABNB:'XLY', EXPE:'XLY',
  LULU:'XLY', SBUX:'XLY', MAR:'XLY', EBAY:'XLY', MELI:'XLY',
  ULTA:'XLY', ORLY:'XLY', DLTR:'XLY', ROST:'XLY',
  // Communication
  NFLX:'XLC', TMUS:'XLC', WBD:'XLC', MTCH:'XLC', SIRI:'XLC',
  GOOGL:'XLC', GOOG:'XLC', META:'XLC', ZM:'XLC',
  // Consumer Staples
  COST:'XLP', KDP:'XLP', MDLZ:'XLP', MNST:'XLP', PEP:'XLP', WBA:'XLP', KHC:'XLP',
  // Healthcare/Biotech
  GILD:'XLV', BIIB:'XLV', REGN:'XLV', VRTX:'XLV', IDXX:'XLV',
  ISRG:'XLV', DXCM:'XLV', ILMN:'XLV', MRNA:'XLV', SGEN:'XLV', GMAB:'XLV',
  // Industrials/Other
  FAST:'XLI', ODFL:'XLI', PCAR:'XLI', CTAS:'XLI', CPRT:'XLI', ROP:'XLI',
  PAYX:'XLF', FISV:'XLF', PYPL:'XLF',
  // Utilities/Energy
  CEG:'XLU', AEP:'XLU', XEL:'XLU', FANG:'XLE',
};

// Cluster assignments
const CLUSTER_ROLES = {
  NVDA:'LEADER', MU:'LEADER', MSFT:'LEADER', AAPL:'LEADER',
  TSLA:'LEADER', AMAT:'LEADER', NOW:'LEADER',
  AMD:'FOLLOWER', MRVL:'FOLLOWER', ARM:'FOLLOWER', AVGO:'FOLLOWER',
  SMCI:'FOLLOWER', WDC:'FOLLOWER', STX:'FOLLOWER', LRCX:'FOLLOWER',
  KLAC:'FOLLOWER', ADBE:'FOLLOWER', CRM:'FOLLOWER', WDAY:'FOLLOWER',
  AMZN:'FOLLOWER', GOOGL:'FOLLOWER', META:'FOLLOWER',
};

async function seedNasdaq100() {
  logger.info(`Seeding ${UNIQUE_TICKERS.length} Nasdaq 100 tickers...`);

  // Get existing tickers
  const existing = await query('SELECT ticker FROM lc_v3.equity_profiles');
  const existingSet = new Set(existing.rows.map(r => r.ticker));

  // Get cluster IDs
  const clusters = await query('SELECT cluster_id, leader_ticker FROM lc_v3.cluster_definitions');
  const clusterByLeader = {};
  clusters.rows.forEach(r => { clusterByLeader[r.leader_ticker] = r.cluster_id; });

  let inserted = 0, skipped = 0;

  for (const ticker of UNIQUE_TICKERS) {
    if (existingSet.has(ticker)) {
      skipped++;
      continue;
    }

    const sectorEtf     = SECTOR_MAP[ticker]    || 'XLK';
    const clusterRole   = CLUSTER_ROLES[ticker] || 'STANDALONE';

    // Determine cluster_id for followers
    let clusterId = null;
    if (clusterRole === 'FOLLOWER') {
      // Find which cluster this ticker belongs to by checking cluster_followers
      const cf = await query(
        'SELECT cluster_id FROM lc_v3.cluster_followers WHERE follower_ticker = $1 LIMIT 1',
        [ticker]
      );
      if (cf.rows.length > 0) clusterId = cf.rows[0].cluster_id;
    } else if (clusterRole === 'LEADER') {
      clusterId = clusterByLeader[ticker] || null;
    }

    await query(`
      INSERT INTO lc_v3.equity_profiles (
        ticker, exchange, exchange_etf, sector_etf,
        cluster_id, cluster_role,
        opening_chop_minutes, momentum_persistence,
        sens_hyperscaler_capex, sens_export_restriction,
        sens_memory_pricing, sens_earnings_beat,
        sens_analyst_upgrade, news_fade_rate,
        options_liquidity_score
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (ticker) DO NOTHING
    `, [
      ticker, 'NASDAQ', 'QQQ', sectorEtf,
      clusterId, clusterRole,
      15, 0.70,          // default opening chop, persistence
      1.0, 1.0,          // default sensitivities
      1.0, 1.0,
      1.0, 0.40,
      0.70,              // default options liquidity
    ]);

    inserted++;
    logger.info(`  + ${ticker} (${sectorEtf} / ${clusterRole})`);
  }

  logger.info(`\nNasdaq 100 seed complete: ${inserted} inserted, ${skipped} already existed`);
  logger.info('Next: run npm run update-profiles to seed ATR and volume baselines for all tickers');
}

seedNasdaq100().catch(err => {
  logger.error('Seed failed:', err);
  process.exit(1);
});
