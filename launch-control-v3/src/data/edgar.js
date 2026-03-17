import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const client = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

const UA = 'LaunchControlV3 parker@alphatrades.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CIK MAP (cached in memory, refreshed daily) ─────────────────────────────

let cikCache = null;
let cikCacheDate = null;

/**
 * Fetch SEC company_tickers.json and return Map<ticker, 10-digit CIK string>.
 * Cached in memory — only fetches once per calendar day.
 */
export async function getCIKMap() {
  const today = new Date().toISOString().slice(0, 10);
  if (cikCache && cikCacheDate === today) return cikCache;

  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': UA },
  });

  if (!res.ok) throw new Error(`SEC company_tickers fetch failed: ${res.status}`);

  const data = await res.json();
  const map = new Map();

  for (const entry of Object.values(data)) {
    const ticker = entry.ticker?.toUpperCase();
    const cik = String(entry.cik_str).padStart(10, '0');
    if (ticker) map.set(ticker, cik);
  }

  cikCache = map;
  cikCacheDate = today;
  console.log(`[EDGAR] CIK map loaded: ${map.size} tickers`);
  return map;
}

// ── 8-K FILING FETCHER ──────────────────────────────────────────────────────

/**
 * Fetch recent 8-K filings for a given CIK from EDGAR submissions.
 *
 * @param {string} cik       - 10-digit padded CIK string
 * @param {string} ticker    - ticker symbol (for logging)
 * @param {number} days      - look back this many days (default 90)
 * @returns {Array<Object>}  - array of { filing_date, accession_number, document_url, raw_text }
 */
export async function getRecentEightKs(cik, ticker, days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Fetch submissions index
  const subUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const subRes = await fetch(subUrl, { headers: { 'User-Agent': UA } });

  if (!subRes.ok) {
    console.warn(`[EDGAR] ${ticker} submissions fetch failed: ${subRes.status}`);
    return [];
  }

  const subData = await subRes.json();
  const recent = subData.filings?.recent;
  if (!recent) return [];

  const forms = recent.form || [];
  const dates = recent.filingDate || [];
  const accessions = recent.accessionNumber || [];
  const primaryDocs = recent.primaryDocument || [];

  // Find all 8-K filings within date range
  const eightKs = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== '8-K') continue;
    if (dates[i] < cutoffStr) continue;
    eightKs.push({
      filing_date: dates[i],
      accession_number: accessions[i],
      primary_document: primaryDocs[i] || null,
    });
  }

  if (eightKs.length === 0) return [];
  console.log(`[EDGAR] ${ticker} found ${eightKs.length} 8-K filings in last ${days} days`);

  // Fetch each 8-K's primary document directly (URL from submissions JSON)
  const cikNum = parseInt(cik, 10);
  const results = [];
  for (const filing of eightKs) {
    try {
      if (!filing.primary_document) {
        console.warn(`[EDGAR] ${ticker} no primaryDocument for ${filing.accession_number}`);
        continue;
      }

      await sleep(200);

      const accNoDashes = filing.accession_number.replace(/-/g, '');
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDashes}/${filing.primary_document}`;
      const docRes = await fetch(docUrl, { headers: { 'User-Agent': UA } });

      if (!docRes.ok) {
        console.warn(`[EDGAR] ${ticker} doc fetch failed for ${filing.accession_number}: ${docRes.status}`);
        continue;
      }

      // Read first 2000 characters
      const fullText = await docRes.text();
      const rawText = fullText.slice(0, 2000);

      results.push({
        filing_date: filing.filing_date,
        accession_number: filing.accession_number,
        document_url: docUrl,
        raw_text: rawText,
      });
    } catch (err) {
      console.warn(`[EDGAR] ${ticker} error fetching 8-K ${filing.accession_number}:`, err.message);
    }
  }

  return results;
}

// ── 8-K RED FLAG ANALYZER ───────────────────────────────────────────────────

/**
 * Analyze 8-K filing text for red flags using Claude Sonnet.
 *
 * @param {string} rawText  - first 2000 chars of the 8-K document
 * @param {string} ticker   - ticker symbol (for logging)
 * @returns {Object}        - { is_red_flag, red_flag_reason, severity, keywords_found }
 */
export async function analyzeEightKText(rawText, ticker) {
  const fallback = {
    is_red_flag: false,
    red_flag_reason: null,
    severity: null,
    keywords_found: [],
  };

  if (!client) {
    console.warn(`[EDGAR] No ANTHROPIC_API_KEY — skipping 8-K analysis for ${ticker}`);
    return fallback;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `You are analyzing an SEC 8-K filing for red flags. Given this filing text return JSON only with fields: is_red_flag (boolean), red_flag_reason (string or null), severity ("HIGH" or "MEDIUM" or "LOW" or null), keywords_found (array of strings). Red flags include: executive departure especially CEO CFO COO, earnings restatement, SEC investigation or subpoena, going concern, default or covenant breach, material weakness, significant litigation, regulatory action, guidance withdrawal, layoffs above 10 percent, plant closure, customer concentration loss. Text to analyze:\n\n${rawText}\n\nReturn JSON only.`,
        },
      ],
    });

    const text = response.content[0]?.text || '';
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[EDGAR] ${ticker} no JSON in Sonnet response`);
      return fallback;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      is_red_flag: !!parsed.is_red_flag,
      red_flag_reason: parsed.red_flag_reason || null,
      severity: parsed.severity || null,
      keywords_found: Array.isArray(parsed.keywords_found) ? parsed.keywords_found : [],
    };
  } catch (err) {
    console.warn(`[EDGAR] ${ticker} 8-K analysis error:`, err.message);
    return fallback;
  }
}
