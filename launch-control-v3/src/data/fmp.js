/**
 * FMP (Financial Modeling Prep) API client — uses /stable endpoints
 */
import axios from 'axios';

const BASE_URL = 'https://financialmodelingprep.com/stable';
const API_KEY  = process.env.FMP_API_KEY;

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fmpGet(path, ticker) {
  try {
    const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}apikey=${API_KEY}`;
    await sleep(200);
    const res = await axios.get(url, { timeout: 10000 });
    return res.data || [];
  } catch (err) {
    console.error(`[FMP] ERROR ${ticker || 'unknown'}: ${err.message}`);
    return [];
  }
}

export async function getEarningsCalendar(from, to) {
  return fmpGet(`/earnings-calendar?from=${from}&to=${to}`, 'calendar');
}

export async function getHistoricalEarnings(ticker) {
  // Use past earnings from calendar (last 2 years)
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const from = twoYearsAgo.toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];
  const all = await fmpGet(`/earnings-calendar?from=${from}&to=${to}`, ticker);
  if (!Array.isArray(all)) return [];
  return all.filter(e => e.symbol === ticker && e.epsActual != null);
}

export async function getInsiderTransactions(ticker) {
  return fmpGet(`/insider-trading?symbol=${ticker}&limit=20`, ticker);
}

export async function getAnalystEstimates(ticker) {
  return fmpGet(`/analyst-estimates?symbol=${ticker}&period=annual&limit=2`, ticker);
}

export async function getPriceTargetConsensus(ticker) {
  return fmpGet(`/price-target-consensus?symbol=${ticker}`, ticker);
}
