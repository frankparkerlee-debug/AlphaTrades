/**
 * Seed insider transactions (SEC EDGAR Form 4) and 8-K filings
 * For all tickers in equity_profiles + conviction_universe
 * Uses SEC EDGAR APIs (free, no key needed)
 * Run: node scripts/seed-insider-filings.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import axios from 'axios';

const EDGAR_UA = 'AlphaTrades research@alphatrades.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── CIK LOOKUP ──────────────────────────────────────────────────────────────
let tickerToCik = null;
async function loadCikMap() {
  if (tickerToCik) return;
  const res = await axios.get('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': EDGAR_UA }, timeout: 15000,
  });
  tickerToCik = {};
  for (const entry of Object.values(res.data)) {
    tickerToCik[entry.ticker] = String(entry.cik_str).padStart(10, '0');
  }
  console.log(`[INSIDER] CIK map loaded: ${Object.keys(tickerToCik).length} tickers`);
}

// ── PARSE FORM 4 XML ────────────────────────────────────────────────────────
function parseForm4Xml(xml, ticker) {
  const txns = [];
  const ownerMatch = xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/);
  const ownerName = ownerMatch ? ownerMatch[1].trim() : 'Unknown';

  // Check if officer or director
  const isOfficer = /<isOfficer>1<\/isOfficer>/.test(xml);
  const isDirector = /<isDirector>1<\/isDirector>/.test(xml);
  const titleMatch = xml.match(/<officerTitle>(.*?)<\/officerTitle>/);
  const title = titleMatch ? titleMatch[1].trim()
    : isDirector ? 'Director'
    : isOfficer ? 'Officer' : '';

  // Parse non-derivative transactions (actual stock buys/sells)
  const ndRegex = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let match;
  while ((match = ndRegex.exec(xml)) !== null) {
    const block = match[1];
    const dateM = block.match(/<transactionDate>[\s\S]*?<value>([\d-]+)<\/value>/);
    const codeM = block.match(/<transactionCode>(\w)<\/transactionCode>/);
    const sharesM = block.match(/<transactionShares>[\s\S]*?<value>([\d.]+)<\/value>/);
    const priceM = block.match(/<transactionPricePerShare>[\s\S]*?<value>([\d.]+)<\/value>/);
    const ownedM = block.match(/<sharesOwnedFollowingTransaction>[\s\S]*?<value>([\d.]+)<\/value>/);
    const dispM = block.match(/<transactionAcquiredDisposedCode>[\s\S]*?<value>(\w)<\/value>/);

    if (!dateM || !codeM) continue;

    const code = codeM[1]; // P=purchase, S=sale, A=award, etc.
    const disp = dispM ? dispM[1] : ''; // A=acquired, D=disposed
    const shares = sharesM ? Math.round(parseFloat(sharesM[1])) : 0;
    const price = priceM ? parseFloat(priceM[1]) : 0;

    let txType;
    if (code === 'P') txType = 'P-Purchase';
    else if (code === 'S') txType = 'S-Sale';
    else if (code === 'A') txType = 'A-Award';
    else if (code === 'M') txType = 'M-Exercise';
    else if (code === 'F') txType = 'F-Tax';
    else if (code === 'G') txType = 'G-Gift';
    else txType = `${code}-Other`;

    txns.push({
      ticker,
      filing_date: dateM[1],
      reporting_name: ownerName.slice(0, 100),
      title: title.slice(0, 100),
      transaction_type: txType,
      shares_traded: disp === 'D' ? -shares : shares,
      price,
      value: Math.round(shares * price * 100) / 100,
      shares_owned_after: ownedM ? Math.round(parseFloat(ownedM[1])) : null,
    });
  }

  return txns;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  // Create tables
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.insider_transactions (
      ticker VARCHAR(10),
      filing_date DATE,
      reporting_name VARCHAR(100),
      title VARCHAR(100),
      transaction_type VARCHAR(20),
      shares_traded BIGINT,
      price DECIMAL(10,2),
      value DECIMAL(14,2),
      shares_owned_after BIGINT,
      PRIMARY KEY (ticker, filing_date, reporting_name, transaction_type)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.sec_filings (
      ticker VARCHAR(10),
      filing_date DATE,
      form_type VARCHAR(20),
      description TEXT,
      filing_url TEXT,
      is_red_flag BOOLEAN DEFAULT FALSE,
      red_flag_reason TEXT,
      PRIMARY KEY (ticker, filing_date, form_type)
    )
  `);
  await query(`ALTER TABLE lc_v3.ticker_intelligence ADD COLUMN IF NOT EXISTS insider_net_90d DECIMAL(14,2)`);
  await query(`ALTER TABLE lc_v3.ticker_intelligence ADD COLUMN IF NOT EXISTS insider_signal VARCHAR(10)`);
  console.log('[INSIDER] Tables ready');

  // Load CIK mapping
  await loadCikMap();

  // Get all tickers
  const epRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const cuRes = await query('SELECT ticker FROM lc_v3.conviction_universe ORDER BY ticker');
  const allTickers = [...new Set([
    ...epRes.rows.map(r => r.ticker),
    ...cuRes.rows.map(r => r.ticker),
  ])].sort();
  console.log(`[INSIDER] ${allTickers.length} tickers to process`);

  let insiderRows = 0;
  let filingRows = 0;
  let redFlags = 0;
  let noMatch = 0;

  const RED_FLAGS = /departure|resign|terminat|restate|investigation|subpoena|default|going concern/i;

  for (let i = 0; i < allTickers.length; i++) {
    const ticker = allTickers[i];
    const cik = tickerToCik[ticker];
    if (!cik) {
      noMatch++;
      continue;
    }

    try {
      // SEC EDGAR rate limit: 10 req/sec — be conservative
      await sleep(150);

      // Fetch company submissions
      const subRes = await axios.get(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        { headers: { 'User-Agent': EDGAR_UA }, timeout: 15000 }
      );
      const recent = subRes.data?.filings?.recent || {};
      const forms = recent.form || [];
      const dates = recent.filingDate || [];
      const docs = recent.primaryDocument || [];
      const accessions = recent.accessionNumber || [];
      const descriptions = recent.primaryDocDescription || [];

      // ── 8-K FILINGS ─────────────────────────────────────────────────────
      let fCount = 0;
      for (let j = 0; j < forms.length && fCount < 10; j++) {
        if (forms[j] !== '8-K') continue;
        fCount++;

        const desc = descriptions[j] || '';
        const isRedFlag = RED_FLAGS.test(desc);
        const accClean = accessions[j].replace(/-/g, '');
        const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accClean}/${docs[j]}`;

        try {
          await query(`
            INSERT INTO lc_v3.sec_filings (ticker, filing_date, form_type, description, filing_url, is_red_flag, red_flag_reason)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (ticker, filing_date, form_type) DO UPDATE SET
              description = EXCLUDED.description, filing_url = EXCLUDED.filing_url,
              is_red_flag = EXCLUDED.is_red_flag, red_flag_reason = EXCLUDED.red_flag_reason
          `, [ticker, dates[j], '8-K', desc.slice(0, 500), url, isRedFlag, isRedFlag ? desc.match(RED_FLAGS)?.[0] : null]);
          filingRows++;
          if (isRedFlag) redFlags++;
        } catch { /* skip dupes */ }
      }

      // ── FORM 4 (INSIDER TRANSACTIONS) ────────────────────────────────────
      // Fetch up to 10 most recent Form 4 XMLs
      let form4Count = 0;
      for (let j = 0; j < forms.length && form4Count < 10; j++) {
        if (forms[j] !== '4') continue;
        form4Count++;

        try {
          await sleep(120);
          const accClean = accessions[j].replace(/-/g, '');
          const ownerCik = parseInt(cik); // issuer CIK
          // The primaryDocument has xslF345X05/ prefix for display — get the raw XML
          const rawDoc = docs[j].replace('xslF345X05/', '');
          const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${ownerCik}/${accClean}/${rawDoc}`;

          const xmlRes = await axios.get(xmlUrl, {
            headers: { 'User-Agent': EDGAR_UA }, timeout: 10000,
            responseType: 'text',
          });
          const txns = parseForm4Xml(xmlRes.data, ticker);

          for (const tx of txns) {
            try {
              await query(`
                INSERT INTO lc_v3.insider_transactions
                  (ticker, filing_date, reporting_name, title, transaction_type,
                   shares_traded, price, value, shares_owned_after)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (ticker, filing_date, reporting_name, transaction_type) DO NOTHING
              `, [
                tx.ticker, tx.filing_date, tx.reporting_name, tx.title,
                tx.transaction_type, tx.shares_traded, tx.price, tx.value,
                tx.shares_owned_after,
              ]);
              insiderRows++;
            } catch { /* skip constraint violations */ }
          }
        } catch { /* skip failed XML fetches */ }
      }

      console.log(`[INSIDER] ${ticker} — ${form4Count} form4s, ${fCount} 8-Ks`);
    } catch (err) {
      console.error(`[INSIDER] ${ticker} error: ${err.message}`);
    }

    if ((i + 1) % 50 === 0) {
      console.log(`[INSIDER] Progress: ${i + 1}/${allTickers.length}, ${insiderRows} insider rows, ${filingRows} filings`);
    }
  }

  console.log(`\n[INSIDER] Insider transactions: ${insiderRows} rows`);
  console.log(`[INSIDER] SEC 8-K filings: ${filingRows} rows (${redFlags} red flags)`);
  console.log(`[INSIDER] No CIK match: ${noMatch} tickers`);

  // ── INSIDER SUMMARY ────────────────────────────────────────────────────────
  console.log('[INSIDER] Computing insider summary...');

  const summaryRes = await query(`
    SELECT ticker,
      COALESCE(SUM(CASE WHEN transaction_type = 'S-Sale' AND filing_date >= CURRENT_DATE - 90
        THEN ABS(value) ELSE 0 END), 0) as sell_total,
      COALESCE(SUM(CASE WHEN transaction_type = 'P-Purchase' AND filing_date >= CURRENT_DATE - 90
        THEN ABS(value) ELSE 0 END), 0) as buy_total
    FROM lc_v3.insider_transactions
    GROUP BY ticker
  `);

  let updated = 0;
  for (const row of summaryRes.rows) {
    const sell = parseFloat(row.sell_total);
    const buy = parseFloat(row.buy_total);
    const net = buy - sell;
    const signal = net < -100000 ? 'SELLING'
                 : net > 100000 ? 'BUYING'
                 : 'NEUTRAL';

    await query(`
      UPDATE lc_v3.ticker_intelligence SET insider_net_90d = $2, insider_signal = $3, last_updated = NOW()
      WHERE ticker = $1
    `, [row.ticker, net, signal]);
    updated++;
  }
  console.log(`[INSIDER] Updated ${updated} tickers in ticker_intelligence`);

  // Top sellers/buyers
  const topSellers = await query(`
    SELECT ticker, insider_net_90d FROM lc_v3.ticker_intelligence
    WHERE insider_signal = 'SELLING' ORDER BY insider_net_90d ASC LIMIT 10
  `);
  if (topSellers.rows.length > 0) {
    console.log('\n[INSIDER] Top sellers (90d):');
    for (const r of topSellers.rows) {
      console.log(`  ${r.ticker.padEnd(8)} $${(parseFloat(r.insider_net_90d) / 1e6).toFixed(2)}M net`);
    }
  }
  const topBuyers = await query(`
    SELECT ticker, insider_net_90d FROM lc_v3.ticker_intelligence
    WHERE insider_signal = 'BUYING' ORDER BY insider_net_90d DESC LIMIT 10
  `);
  if (topBuyers.rows.length > 0) {
    console.log('\n[INSIDER] Top buyers (90d):');
    for (const r of topBuyers.rows) {
      console.log(`  ${r.ticker.padEnd(8)} +$${(parseFloat(r.insider_net_90d) / 1e6).toFixed(2)}M net`);
    }
  }

  console.log('\n[INSIDER] Done');
  process.exit(0);
}

main().catch(err => {
  console.error('[INSIDER] FATAL:', err.message);
  process.exit(1);
});
