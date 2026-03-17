import { getCIKMap, getRecentEightKs, analyzeEightKText, analyzeMAndA } from '../data/edgar.js';

/**
 * Conviction Scorer — scores tickers for put setups based on
 * fundamental deterioration, insider selling, SEC red flags,
 * and options positioning signals.
 *
 * @param {string} ticker
 * @param {import('pg').Pool} db
 * @returns {Promise<Object>} scored profile
 */
export async function scoreConvictionSetup(ticker, db) {
  const breakdown = {};
  const riskFactors = [];
  let score = 0;

  // ── FUNDAMENTALS (last 4 quarters) ───────────────────────────────────────
  const fundRes = await db.query(
    `SELECT revenue, gross_margin, free_cash_flow
     FROM lc_v3.fundamentals
     WHERE ticker = $1
     ORDER BY reported_at DESC
     LIMIT 4`,
    [ticker]
  );
  const quarters = fundRes.rows;

  let revDecliningQ = 0;
  let marginTrend = null;
  let isFcfNegative = false;

  if (quarters.length >= 2) {
    // Count consecutive declining revenue quarters (most recent first)
    for (let i = 0; i < quarters.length - 1; i++) {
      const newer = quarters[i].revenue;
      const older = quarters[i + 1].revenue;
      if (newer != null && older != null && parseFloat(newer) < parseFloat(older)) {
        revDecliningQ++;
      } else {
        break;
      }
    }

    // Margin trend: latest minus oldest
    const latestGM = quarters[0].gross_margin;
    const oldestGM = quarters[quarters.length - 1].gross_margin;
    if (latestGM != null && oldestGM != null) {
      marginTrend = parseFloat(latestGM) - parseFloat(oldestGM);
    }
  }

  if (quarters.length > 0 && quarters[0].free_cash_flow != null) {
    isFcfNegative = parseFloat(quarters[0].free_cash_flow) < 0;
  }

  // Score: revenue decline
  if (revDecliningQ >= 3) {
    score += 25;
    breakdown.revenue_decline = 25;
    riskFactors.push(`Revenue declining ${revDecliningQ} consecutive quarters`);
  } else if (revDecliningQ === 2) {
    score += 15;
    breakdown.revenue_decline = 15;
    riskFactors.push('Revenue declining 2 consecutive quarters');
  } else if (revDecliningQ === 1) {
    score += 5;
    breakdown.revenue_decline = 5;
  } else {
    breakdown.revenue_decline = 0;
  }

  // Score: gross margin declining
  if (marginTrend != null && marginTrend < 0) {
    score += 10;
    breakdown.margin_declining = 10;
    riskFactors.push(`Gross margin contracted ${(marginTrend * 100).toFixed(1)}pp over 4 quarters`);
  } else {
    breakdown.margin_declining = 0;
  }

  // Score: FCF negative
  if (isFcfNegative) {
    score += 15;
    breakdown.fcf_negative = 15;
    riskFactors.push('Free cash flow negative (latest quarter)');
  } else {
    breakdown.fcf_negative = 0;
  }

  // ── INSIDER TRANSACTIONS (last 90 days) — breadth & seniority ─────────────
  const insiderRes = await db.query(
    `SELECT DISTINCT reporting_name, title
     FROM lc_v3.insider_transactions
     WHERE ticker = $1
       AND transaction_type = 'S-Sale'
       AND filing_date >= CURRENT_DATE - 90`,
    [ticker]
  );

  const sellers = insiderRes.rows;
  const distinctSellers = sellers.length;
  const C_SUITE = /CEO|CFO|COO|CTO|President|Chief/i;
  const hasCeoSelling = sellers.some(s => /CEO|Chief Executive/i.test(s.title || ''));
  const hasCfoSelling = sellers.some(s => /CFO|Chief Financial/i.test(s.title || ''));
  const cSuiteSellers = sellers.filter(s => C_SUITE.test(s.title || '')).length;

  // Also compute net discretionary value for the return object
  const valRes = await db.query(
    `SELECT COALESCE(SUM(ABS(value)), 0) as total
     FROM lc_v3.insider_transactions
     WHERE ticker = $1
       AND transaction_type = 'S-Sale'
       AND filing_date >= CURRENT_DATE - 90`,
    [ticker]
  );
  const netDiscretionary = parseFloat(valRes.rows[0].total);

  // Score: breadth of selling
  let insiderScore = 0;
  if (distinctSellers >= 6) {
    insiderScore += 25;
    riskFactors.push(`${distinctSellers} distinct insiders selling (90d)`);
  } else if (distinctSellers >= 4) {
    insiderScore += 15;
    riskFactors.push(`${distinctSellers} distinct insiders selling (90d)`);
  }

  // Score: CEO + CFO selling (25 if both, 10 each individually)
  if (hasCeoSelling && hasCfoSelling) {
    insiderScore += 25;
    riskFactors.push('Both CEO and CFO selling');
  } else if (hasCeoSelling) {
    insiderScore += 10;
    riskFactors.push('CEO selling');
  } else if (hasCfoSelling) {
    insiderScore += 10;
    riskFactors.push('CFO selling');
  }

  score += insiderScore;
  breakdown.insider_selling = insiderScore;

  // ── SEC RED FLAG FILINGS ─────────────────────────────────────────────────
  const redFlagRes = await db.query(
    `SELECT COUNT(*) as cnt FROM lc_v3.sec_filings
     WHERE ticker = $1 AND is_red_flag = TRUE AND filing_date >= CURRENT_DATE - 90`,
    [ticker]
  );
  const redFlagCount = parseInt(redFlagRes.rows[0].cnt);

  if (redFlagCount > 0) {
    score += 15;
    breakdown.red_flag_filings = 15;
    riskFactors.push(`${redFlagCount} red-flag 8-K filing(s) in last 90 days`);
  } else {
    breakdown.red_flag_filings = 0;
  }

  // ── EDGAR 8-K LIVE ANALYSIS (via SEC EDGAR + Claude) ───────────────────
  const eightKRedFlags = [];
  let edgarScore = 0;
  try {
    const cikMap = await getCIKMap();
    const cik = cikMap.get(ticker.toUpperCase());
    if (cik) {
      const filings = await getRecentEightKs(cik, ticker, 90);
      for (const filing of filings) {
        const analysis = await analyzeEightKText(filing.raw_text, ticker);
        if (analysis.is_red_flag) {
          eightKRedFlags.push({
            filing_date: filing.filing_date,
            accession_number: filing.accession_number,
            document_url: filing.document_url,
            severity: analysis.severity,
            reason: analysis.red_flag_reason,
            keywords: analysis.keywords_found,
          });
          const sevPoints = analysis.severity === 'HIGH' ? 25
                          : analysis.severity === 'MEDIUM' ? 15
                          : 5;
          edgarScore += sevPoints;
          riskFactors.push(`8-K ${filing.filing_date}: ${analysis.red_flag_reason}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[CONVICTION] EDGAR 8-K analysis failed for ${ticker}:`, err.message);
  }
  score += edgarScore;
  breakdown.edgar_8k = edgarScore;

  // ── M&A DEAL ANALYSIS ─────────────────────────────────────────────────────
  let maStatus = null;   // null | 'MA_ABOVE_OFFER' | 'MA_AT_OFFER' | 'MA_DEAL_UNCERTAINTY'
  let maDetails = null;
  try {
    const cikMap = await getCIKMap();
    const cik = cikMap.get(ticker.toUpperCase());
    if (cik) {
      const filings = await getRecentEightKs(cik, ticker, 180);
      for (const filing of filings) {
        const ma = await analyzeMAndA(filing.raw_text, ticker);
        if (!ma.is_ma) continue;

        // Found M&A activity — get current price
        let currentPrice = null;
        try {
          const priceRes = await db.query(
            `SELECT price FROM lc_v3.equity_profiles WHERE ticker = $1`,
            [ticker]
          );
          if (priceRes.rows[0]?.price) currentPrice = parseFloat(priceRes.rows[0].price);
        } catch { /* ignore */ }

        const offerPrice = ma.offer_price;
        const dealDate = ma.deal_date ? new Date(ma.deal_date) : new Date(filing.filing_date);
        const daysSinceDeal = Math.round((new Date() - dealDate) / 86400000);

        maDetails = {
          acquirer: ma.acquirer,
          offer_price: offerPrice,
          deal_type: ma.deal_type,
          deal_date: ma.deal_date || filing.filing_date,
          days_since_deal: daysSinceDeal,
          current_price: currentPrice,
          summary: ma.summary,
          filing_date: filing.filing_date,
          document_url: filing.document_url,
        };

        if (offerPrice && currentPrice) {
          const premium = (currentPrice - offerPrice) / offerPrice;
          maDetails.price_vs_offer_pct = +(premium * 100).toFixed(2);

          if (premium > 0.05) {
            // Stock trading >5% above offer — deal may fall through
            maStatus = 'MA_ABOVE_OFFER';
            score += 30;
            breakdown.ma_deal_risk = 30;
            riskFactors.push(`Trading ${(premium * 100).toFixed(1)}% ABOVE M&A offer ($${currentPrice.toFixed(2)} vs $${offerPrice.toFixed(2)}) — deal break risk`);
            console.log(`[CONVICTION] ${ticker} M&A ABOVE OFFER: $${currentPrice.toFixed(2)} vs offer $${offerPrice.toFixed(2)} (+${(premium * 100).toFixed(1)}%)`);
          } else if (premium >= -0.05) {
            // Within 5% of offer — limited downside, skip
            maStatus = 'MA_AT_OFFER';
            breakdown.ma_deal_risk = 0;
            console.log(`[CONVICTION] ${ticker} M&A AT OFFER: $${currentPrice.toFixed(2)} vs offer $${offerPrice.toFixed(2)} — skipping`);
          }
        }

        // Deal dragging >60 days without close
        if (!maStatus && daysSinceDeal > 60) {
          maStatus = 'MA_DEAL_UNCERTAINTY';
          score += 25;
          breakdown.ma_deal_risk = 25;
          riskFactors.push(`M&A deal announced ${daysSinceDeal}d ago, not yet closed — deal uncertainty rising`);
          console.log(`[CONVICTION] ${ticker} M&A DEAL UNCERTAINTY: ${daysSinceDeal} days since announcement`);
        }

        // Only process the most recent M&A filing
        break;
      }
    }
  } catch (err) {
    console.warn(`[CONVICTION] M&A analysis failed for ${ticker}:`, err.message);
  }
  if (!maDetails) breakdown.ma_deal_risk = 0;

  // ── TICKER INTELLIGENCE ──────────────────────────────────────────────────
  const tiRes = await db.query(
    `SELECT earnings_date, iv_rank_30d, insider_signal
     FROM lc_v3.ticker_intelligence
     WHERE ticker = $1`,
    [ticker]
  );
  const ti = tiRes.rows[0] || {};

  const earningsDate = ti.earnings_date || null;
  const ivRank = ti.iv_rank_30d != null ? parseFloat(ti.iv_rank_30d) : null;
  let daysToEarnings = null;

  if (earningsDate) {
    const ed = new Date(earningsDate);
    daysToEarnings = Math.round((ed - new Date()) / 86400000);
    if (daysToEarnings < 0) daysToEarnings = null; // past earnings, ignore
  }

  // Score: IV rank
  if (ivRank != null && ivRank < 20) {
    score += 15;
    breakdown.iv_rank_low = 15;
    riskFactors.push(`IV rank very low (${ivRank.toFixed(0)}%) — options cheap`);
  } else if (ivRank != null && ivRank < 30) {
    score += 10;
    breakdown.iv_rank_low = 10;
    riskFactors.push(`IV rank low (${ivRank.toFixed(0)}%) — options relatively cheap`);
  } else {
    breakdown.iv_rank_low = 0;
  }

  // Score: earnings proximity
  if (daysToEarnings != null && daysToEarnings <= 14) {
    score += 15;
    breakdown.earnings_near = 15;
    riskFactors.push(`Earnings in ${daysToEarnings} days — catalyst imminent`);
  } else if (daysToEarnings != null && daysToEarnings <= 30) {
    score += 10;
    breakdown.earnings_near = 10;
    riskFactors.push(`Earnings in ${daysToEarnings} days`);
  } else {
    breakdown.earnings_near = 0;
  }

  // Score: analyst consensus (query from equity_profiles or intelligence)
  // Check if analyst_consensus column exists in ticker_intelligence
  let analystConsensus = null;
  let analystPriceTarget = null;
  try {
    const analystRes = await db.query(
      `SELECT analyst_price_target FROM lc_v3.ticker_intelligence WHERE ticker = $1`,
      [ticker]
    );
    analystPriceTarget = analystRes.rows[0]?.analyst_price_target
      ? parseFloat(analystRes.rows[0].analyst_price_target) : null;
  } catch { /* column may not exist */ }

  // Analyst consensus not stored as text yet — skip for now
  breakdown.analyst_consensus = 0;

  // Score: near 52-week high (proxy: check if current price data available)
  // Use equity_profiles or snapshot data if available
  let near52wHigh = false;
  try {
    const priceRes = await db.query(
      `SELECT price, year_high FROM lc_v3.equity_profiles WHERE ticker = $1`,
      [ticker]
    );
    if (priceRes.rows[0]?.price && priceRes.rows[0]?.year_high) {
      const price = parseFloat(priceRes.rows[0].price);
      const high = parseFloat(priceRes.rows[0].year_high);
      if (high > 0 && price >= high * 0.90) {
        near52wHigh = true;
        score += 10;
        breakdown.near_52w_high = 10;
        riskFactors.push(`Stock within 10% of 52-week high ($${price.toFixed(2)} vs $${high.toFixed(2)})`);
      }
    }
  } catch { /* column may not exist */ }
  if (!near52wHigh) breakdown.near_52w_high = 0;

  // Cap at 100
  score = Math.min(score, 100);

  // M&A-aware recommendation logic
  let recommendation;
  if (maStatus === 'MA_AT_OFFER') {
    recommendation = 'PASS';  // Limited downside, skip entirely
  } else if (maStatus === 'MA_ABOVE_OFFER' || maStatus === 'MA_DEAL_UNCERTAINTY') {
    recommendation = 'DEAL_RISK_PUT';
  } else {
    recommendation = score >= 70 ? 'STRONG_PUT'
                   : score >= 50 ? 'MONITOR'
                   : 'PASS';
  }

  return {
    ticker,
    conviction_score: score,
    score_breakdown: breakdown,
    recommendation,
    thesis: maStatus ? 'DEAL_FAILURE' : 'FUNDAMENTAL_DETERIORATION',
    ma_status: maStatus,
    ma_details: maDetails,
    earnings_date: earningsDate,
    iv_rank_30d: ivRank,
    days_to_earnings: daysToEarnings,
    net_discretionary_selling: netDiscretionary,
    revenue_declining_quarters: revDecliningQ,
    is_fcf_negative: isFcfNegative,
    margin_trend: marginTrend,
    red_flag_count: redFlagCount,
    insider_signal: ti.insider_signal || null,
    analyst_price_target: analystPriceTarget,
    eight_k_red_flags: eightKRedFlags,
    top_risk_factors: riskFactors,
  };
}
