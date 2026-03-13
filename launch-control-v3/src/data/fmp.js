/**
 * FMP (Financial Modeling Prep) API client
 */
import axios from 'axios';

const BASE_URL = 'https://financialmodelingprep.com/api/v3';
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
  return fmpGet(`/earning_calendar?from=${from}&to=${to}`, 'calendar');
}

export async function getHistoricalEarnings(ticker) {
  return fmpGet(`/historical/earning_calendar/${ticker}?limit=8`, ticker);
}

export async function getInsiderTransactions(ticker) {
  return fmpGet(`/insider-trading?symbol=${ticker}&limit=20`, ticker);
}

export async function getAnalystEstimates(ticker) {
  return fmpGet(`/analyst-estimates/${ticker}?limit=2`, ticker);
}
