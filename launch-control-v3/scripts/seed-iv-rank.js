/**
 * Seed IV rank data from Alpaca options snapshots
 * Run during market hours for best results (greeks populate during trading)
 * Run: node scripts/seed-iv-rank.js
 */
import 'dotenv/config';
import axios from 'axios';
import { query } from '../src/data/db.js';

const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const HEADERS = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};
const BATCH_SIZE = 10;
const BATCH_DELAY = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseOCC(symbol) {
  const m = symbol.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, ticker, yy, mm, dd, type, strRaw] = m;
  const strike = parseInt(strRaw) / 1000;
  const expiry = `20${yy}-${mm}-${dd}`;
  return { ticker, expiry, type, strike };
}

/**
 * Estimate annualized IV from ATM option mid price using simplified BSM
 * C ≈ S * 0.4 * σ * √T  (ATM approximation)
 * So σ ≈ C / (S * 0.4 * √T)
 */
function estimateIV(mid, stockPrice, daysToExpiry) {
  if (!mid || mid <= 0 || !stockPrice || stockPrice <= 0 || !daysToExpiry || daysToExpiry <= 0) return 0;
  const T = daysToExpiry / 365;
  const sqrtT = Math.sqrt(T);
  if (sqrtT === 0) return 0;
  const iv = mid / (stockPrice * 0.4 * sqrtT);
  // Sanity check: IV should be between 0.05 (5%) and 5.0 (500%)
  if (iv < 0.05 || iv > 5.0) return 0;
  return iv;
}

async function getStockPrices(tickers) {
  const prices = {};
  for (let i = 0; i < tickers.length; i += 50) {
    const batch = tickers.slice(i, i + 50);
    try {
      const res = await axios.get(`${DATA_URL}/v2/stocks/snapshots`, {
        headers: HEADERS,
        params: { symbols: batch.join(','), feed: 'sip' },
        timeout: 10000,
      });
      for (const [sym, snap] of Object.entries(res.data || {})) {
        prices[sym] = snap.latestTrade?.p || snap.dailyBar?.c || 0;
      }
    } catch (err) {
      console.error(`[IV] Stock price fetch error: ${err.message}`);
    }
  }
  return prices;
}

async function fetchOptionSnapshots(tickers) {
  const allSnapshots = {};

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    console.log(`[IV] Fetching options batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(tickers.length / BATCH_SIZE)}: ${batch.join(',')}`);

    await Promise.all(batch.map(async (ticker) => {
      try {
        allSnapshots[ticker] = [];
        let pageToken = null;
        let pages = 0;

        // Paginate — Alpaca caps at 100 per page
        do {
          const params = { type: 'call', limit: 100 };
          if (pageToken) params.page_token = pageToken;

          const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
            headers: HEADERS,
            params,
            timeout: 15000,
          });

          const snapshots = res.data?.snapshots || {};

          // Debug: log first contract's greeks for first ticker
          if (i === 0 && pages === 0 && batch.indexOf(ticker) === 0) {
            const firstKey = Object.keys(snapshots)[0];
            if (firstKey) {
              const sample = snapshots[firstKey];
              console.log(`[IV] DEBUG ${ticker} sample greeks:`, JSON.stringify(sample?.greeks || 'none').slice(0, 200));
              console.log(`[IV] DEBUG ${ticker} sample quote:`, JSON.stringify(sample?.latestQuote || 'none').slice(0, 200));
            }
          }

          for (const [sym, snap] of Object.entries(snapshots)) {
            const parsed = parseOCC(sym);
            if (!parsed) continue;
            allSnapshots[ticker].push({
              symbol: sym,
              ...parsed,
              iv: snap.greeks?.impliedVolatility || 0,
              delta: Math.abs(snap.greeks?.delta || 0),
              bid: snap.latestQuote?.bp || 0,
              ask: snap.latestQuote?.ap || 0,
            });
          }

          pageToken = res.data?.next_page_token || null;
          pages++;
        } while (pageToken && pages < 3);

      } catch (err) {
        console.error(`[IV] Options fetch error for ${ticker}: ${err.message}`);
      }
    }));

    if (i + BATCH_SIZE < tickers.length) {
      await sleep(BATCH_DELAY);
    }
  }

  return allSnapshots;
}

function findATMContract(contracts, stockPrice) {
  if (!contracts || contracts.length === 0 || !stockPrice) return null;

  const today = new Date().toISOString().split('T')[0];

  // Get unique expiries >= today, pick nearest
  const expiries = [...new Set(contracts.map(c => c.expiry).filter(e => e >= today))].sort();
  if (expiries.length === 0) return null;
  const nearestExpiry = expiries[0];
  const daysToExpiry = Math.round((new Date(nearestExpiry) - new Date(today)) / 86400000);

  // Filter to nearest expiry calls with IV or bid/ask for estimation
  let expiryContracts = contracts.filter(c => c.expiry === nearestExpiry && c.type === 'C');
  if (expiryContracts.length === 0) return null;

  // Find closest strike to stock price
  expiryContracts.sort((a, b) => Math.abs(a.strike - stockPrice) - Math.abs(b.strike - stockPrice));
  const atm = expiryContracts[0];

  // If greeks IV is available, use it
  if (atm.iv > 0) return { ...atm, source: 'greeks' };

  // Fallback: estimate IV from mid price
  const mid = (atm.bid > 0 && atm.ask > 0) ? (atm.bid + atm.ask) / 2 : 0;
  const estimatedIV = estimateIV(mid, stockPrice, Math.max(daysToExpiry, 1));
  if (estimatedIV > 0) {
    return { ...atm, iv: estimatedIV, source: 'estimated' };
  }

  return null;
}

async function main() {
  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = profileRes.rows.map(r => r.ticker);
  console.log(`[IV] ${tickers.length} tickers to process`);

  // Get current stock prices
  console.log('[IV] Fetching stock prices...');
  const prices = await getStockPrices(tickers);
  console.log(`[IV] Got prices for ${Object.keys(prices).length} tickers`);

  // Fetch all option snapshots
  console.log('[IV] Fetching options snapshots...');
  const optionData = await fetchOptionSnapshots(tickers);
  console.log(`[IV] Got options data for ${Object.keys(optionData).length} tickers`);

  let count = 0;
  let ivCount = 0;
  let estimatedCount = 0;

  for (const ticker of tickers) {
    const stockPrice = prices[ticker];
    const contracts = optionData[ticker] || [];
    const atm = findATMContract(contracts, stockPrice);

    if (!atm || atm.iv <= 0) {
      console.log(`[IV] ${ticker} — no ATM IV available (${contracts.length} contracts, price=$${stockPrice || '?'})`);
      count++;
      continue;
    }

    const ivAtm = parseFloat((atm.iv * 100).toFixed(2)); // as percentage
    const sourceLabel = atm.source === 'estimated' ? ' (est)' : '';
    if (atm.source === 'estimated') estimatedCount++;

    // Store in iv_history
    await query(`
      INSERT INTO lc_v3.iv_history (ticker, captured_at, iv_atm)
      VALUES ($1, NOW(), $2)
      ON CONFLICT (ticker, captured_at) DO UPDATE SET iv_atm = EXCLUDED.iv_atm
    `, [ticker, ivAtm]);

    // Compute IV rank: percentile of today's IV vs all history
    const histRes = await query(`
      SELECT iv_atm FROM lc_v3.iv_history
      WHERE ticker = $1 AND iv_atm IS NOT NULL
      ORDER BY iv_atm
    `, [ticker]);

    let ivRank = null;
    if (histRes.rows.length > 0) {
      const allIVs = histRes.rows.map(r => parseFloat(r.iv_atm));
      const below = allIVs.filter(v => v < ivAtm).length;
      ivRank = parseFloat(((below / allIVs.length) * 100).toFixed(1));
    }

    // Upsert into ticker_intelligence
    await query(`
      INSERT INTO lc_v3.ticker_intelligence (ticker, iv_rank_30d, iv_percentile, last_updated)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (ticker) DO UPDATE SET
        iv_rank_30d = EXCLUDED.iv_rank_30d,
        iv_percentile = EXCLUDED.iv_percentile,
        last_updated = NOW()
    `, [ticker, ivAtm, ivRank]);

    console.log(`[IV] ${ticker} — ATM IV: ${ivAtm}%${sourceLabel} rank: ${ivRank != null ? ivRank + 'th pctl' : '—'} (strike $${atm.strike}, ${atm.expiry})`);
    ivCount++;
    count++;
  }

  console.log(`\n[IV] Done — ${count} tickers processed, ${ivCount} with IV data (${estimatedCount} estimated)`);
  process.exit(0);
}

main().catch(err => {
  console.error('[IV] FATAL:', err.message);
  process.exit(1);
});
