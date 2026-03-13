/**
 * Seed IV rank data from Alpaca options snapshots
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

    // Fetch per-ticker (Alpaca's working endpoint)
    await Promise.all(batch.map(async (ticker) => {
      try {
        const res = await axios.get(`${DATA_URL}/v1beta1/options/snapshots/${ticker}`, {
          headers: HEADERS,
          params: { limit: 250 },
          timeout: 15000,
        });

        const snapshots = res.data?.snapshots || {};
        allSnapshots[ticker] = [];
        // Debug: log first contract's structure for first ticker
        if (i === 0 && batch.indexOf(ticker) === 0) {
          const firstKey = Object.keys(snapshots)[0];
          if (firstKey) console.log(`[IV] DEBUG ${ticker} sample:`, JSON.stringify(snapshots[firstKey]?.greeks || 'no greeks').slice(0, 200));
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

  // Filter to nearest expiry, calls only (more liquid for ATM IV)
  const expiryContracts = contracts.filter(c => c.expiry === nearestExpiry && c.type === 'C' && c.iv > 0);
  if (expiryContracts.length === 0) {
    // Try puts
    const puts = contracts.filter(c => c.expiry === nearestExpiry && c.type === 'P' && c.iv > 0);
    if (puts.length === 0) return null;
    puts.sort((a, b) => Math.abs(a.strike - stockPrice) - Math.abs(b.strike - stockPrice));
    return puts[0];
  }

  // Find closest strike to stock price
  expiryContracts.sort((a, b) => Math.abs(a.strike - stockPrice) - Math.abs(b.strike - stockPrice));
  return expiryContracts[0];
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

  for (const ticker of tickers) {
    const stockPrice = prices[ticker];
    const contracts = optionData[ticker] || [];
    const atm = findATMContract(contracts, stockPrice);

    if (!atm || atm.iv <= 0) {
      console.log(`[IV] ${ticker} — no ATM IV available (${contracts.length} contracts)`);
      count++;
      continue;
    }

    const ivAtm = parseFloat((atm.iv * 100).toFixed(2)); // as percentage

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

    console.log(`[IV] ${ticker} — ATM IV: ${ivAtm}% rank: ${ivRank != null ? ivRank + 'th percentile' : '—'} (strike $${atm.strike}, ${atm.expiry})`);
    ivCount++;
    count++;
  }

  console.log(`\n[IV] Done — ${count} tickers processed, ${ivCount} with IV data`);
  process.exit(0);
}

main().catch(err => {
  console.error('[IV] FATAL:', err.message);
  process.exit(1);
});
