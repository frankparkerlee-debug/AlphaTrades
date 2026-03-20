"""
MCHP (Microchip Technology) Deep Dive — conviction put candidate analysis.

Fetches all available data and runs the conviction scorer logic in Python
(mirrors the JS scorer in src/strategies/conviction-scorer.js).

Run: python3 analysis/mchp_deep_dive.py
"""

import os
import sys
import json
import math
from datetime import datetime, timedelta
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('ERROR: DATABASE_URL not set in .env')
    sys.exit(1)

conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor(cursor_factory=RealDictCursor)

TICKER = 'MCHP'
print('=' * 70)
print(f'  MCHP (Microchip Technology) — CONVICTION PUT DEEP DIVE')
print('=' * 70)

# ═══════════════════════════════════════════════════════════════════════════════
# 1. FUNDAMENTALS
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '-' * 70)
print('1. FUNDAMENTALS (lc_v3.fundamentals)')
print('-' * 70)

cur.execute("""
    SELECT period, revenue, gross_profit, operating_income, net_income,
           free_cash_flow, gross_margin, operating_margin,
           accounts_receivable, inventory, total_debt, cash_and_equivalents,
           reported_at
    FROM lc_v3.fundamentals
    WHERE ticker = %s
    ORDER BY reported_at DESC
""", (TICKER,))
fund_rows = cur.fetchall()

if fund_rows:
    print(f'  Quarters available: {len(fund_rows)}')
    print(f'\n  {"Period":<12} {"Revenue":>14} {"GrossProf":>14} {"OpIncome":>14} {"NetIncome":>14} {"FCF":>14} {"GM%":>7} {"OM%":>7}')
    print(f'  {"─"*12} {"─"*14} {"─"*14} {"─"*14} {"─"*14} {"─"*14} {"─"*7} {"─"*7}')
    for r in fund_rows:
        rev = f"${float(r['revenue'])/1e9:.2f}B" if r['revenue'] else '—'
        gp = f"${float(r['gross_profit'])/1e9:.2f}B" if r['gross_profit'] else '—'
        oi = f"${float(r['operating_income'])/1e6:.0f}M" if r['operating_income'] else '—'
        ni = f"${float(r['net_income'])/1e6:.0f}M" if r['net_income'] else '—'
        fcf = f"${float(r['free_cash_flow'])/1e6:.0f}M" if r['free_cash_flow'] else '—'
        gm = f"{float(r['gross_margin'])*100:.1f}%" if r['gross_margin'] else '—'
        om = f"{float(r['operating_margin'])*100:.1f}%" if r['operating_margin'] else '—'
        print(f'  {r["period"] or "—":<12} {rev:>14} {gp:>14} {oi:>14} {ni:>14} {fcf:>14} {gm:>7} {om:>7}')

    # Revenue trend
    print(f'\n  Revenue Trend (most recent first):')
    revs = [(r['period'], float(r['revenue'])) for r in fund_rows if r['revenue']]
    declining_q = 0
    for i in range(len(revs) - 1):
        newer, older = revs[i][1], revs[i+1][1]
        change = (newer - older) / older * 100
        trend = 'DECLINE' if newer < older else 'GROWTH'
        if newer < older:
            declining_q += 1
        else:
            if i == 0:
                declining_q = 0  # reset if most recent is growth
            break
        print(f'    {revs[i][0]} vs {revs[i+1][0]}: {change:+.1f}% ({trend})')
    print(f'  Consecutive declining quarters: {declining_q}')

    # Balance sheet
    latest = fund_rows[0]
    print(f'\n  Balance Sheet (latest quarter {latest["period"]}):')
    if latest.get('accounts_receivable'):
        print(f'    Accounts Receivable: ${float(latest["accounts_receivable"])/1e6:.0f}M')
    if latest.get('inventory'):
        print(f'    Inventory:           ${float(latest["inventory"])/1e6:.0f}M')
    if latest.get('total_debt'):
        print(f'    Total Debt:          ${float(latest["total_debt"])/1e9:.2f}B')
    if latest.get('cash_and_equivalents'):
        print(f'    Cash & Equiv:        ${float(latest["cash_and_equivalents"])/1e6:.0f}M')
else:
    print('  No fundamental data found')
    declining_q = 0

# ═══════════════════════════════════════════════════════════════════════════════
# 2. INSIDER TRANSACTIONS
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '-' * 70)
print('2. INSIDER TRANSACTIONS (last 90 days)')
print('-' * 70)

cur.execute("""
    SELECT reporting_name, title, transaction_type, filing_date,
           shares_traded, price, value, shares_owned_after
    FROM lc_v3.insider_transactions
    WHERE ticker = %s
      AND filing_date >= CURRENT_DATE - 90
    ORDER BY filing_date DESC
""", (TICKER,))
insider_rows = cur.fetchall()

if insider_rows:
    sells = [r for r in insider_rows if r['transaction_type'] == 'S-Sale']
    buys = [r for r in insider_rows if r['transaction_type'] in ('P-Purchase', 'A-Award')]
    print(f'  Total transactions: {len(insider_rows)}  (Sells: {len(sells)}, Buys/Awards: {len(buys)})')

    distinct_sellers = set()
    c_suite_sellers = set()
    total_sell_value = 0

    print(f'\n  {"Date":<12} {"Type":<10} {"Name":<25} {"Title":<20} {"Shares":>10} {"Price":>8} {"Value":>12}')
    print(f'  {"─"*12} {"─"*10} {"─"*25} {"─"*20} {"─"*10} {"─"*8} {"─"*12}')
    for r in insider_rows:
        name = (r['reporting_name'] or '')[:24]
        title = (r['title'] or '')[:19]
        shares = f"{int(r['shares_traded']):,}" if r['shares_traded'] else '—'
        price = f"${float(r['price']):.2f}" if r['price'] else '—'
        value = f"${float(r['value']):,.0f}" if r['value'] else '—'
        ttype = r['transaction_type'] or '—'
        date = str(r['filing_date'])[:10] if r['filing_date'] else '—'
        val = f"${float(r['value']):,.0f}" if r['value'] else '—'
        print(f'  {date:<12} {ttype:<10} {name:<25} {title:<20} {shares:>10} {price:>8} {val:>12}')

        if r['transaction_type'] == 'S-Sale':
            distinct_sellers.add(r['reporting_name'])
            if any(t in (r['title'] or '') for t in ['CEO', 'CFO', 'COO', 'CTO', 'President', 'Chief']):
                c_suite_sellers.add(r['reporting_name'])
            if r['value']:
                total_sell_value += abs(float(r['value']))

    print(f'\n  Summary:')
    print(f'    Distinct sellers: {len(distinct_sellers)}')
    print(f'    C-suite sellers:  {len(c_suite_sellers)}')
    print(f'    Total sell value: ${total_sell_value:,.0f}')
else:
    print('  No insider transactions in last 90 days')
    distinct_sellers = set()
    c_suite_sellers = set()
    total_sell_value = 0

# ═══════════════════════════════════════════════════════════════════════════════
# 3. TICKER INTELLIGENCE
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '-' * 70)
print('3. TICKER INTELLIGENCE (lc_v3.ticker_intelligence)')
print('-' * 70)

cur.execute("""
    SELECT *
    FROM lc_v3.ticker_intelligence
    WHERE ticker = %s
""", (TICKER,))
ti_rows = cur.fetchall()

iv_rank = None
earnings_date = None
days_to_earnings = None
analyst_target = None
beat_rate = None
avg_move = None

if ti_rows:
    ti = ti_rows[0]
    print(f'  Earnings date:        {ti.get("earnings_date") or "—"}')
    earnings_date = ti.get('earnings_date')
    if earnings_date:
        days_to_earnings = (datetime.strptime(str(earnings_date), '%Y-%m-%d') - datetime.now()).days
        print(f'  Days to earnings:     {days_to_earnings}')

    print(f'  Earnings avg move:    {float(ti["earnings_avg_move_pct"]):.1f}%' if ti.get('earnings_avg_move_pct') else '  Earnings avg move:    —')
    avg_move = float(ti['earnings_avg_move_pct']) if ti.get('earnings_avg_move_pct') else None

    print(f'  Earnings beat rate:   {float(ti["earnings_beat_rate"])*100:.0f}%' if ti.get('earnings_beat_rate') else '  Earnings beat rate:   —')
    beat_rate = float(ti['earnings_beat_rate']) if ti.get('earnings_beat_rate') else None

    print(f'  Analyst price target: ${float(ti["analyst_price_target"]):.2f}' if ti.get('analyst_price_target') else '  Analyst price target: —')
    analyst_target = float(ti['analyst_price_target']) if ti.get('analyst_price_target') else None

    print(f'  IV rank (30d):        {float(ti["iv_rank_30d"]):.0f}%' if ti.get('iv_rank_30d') else '  IV rank (30d):        —')
    iv_rank = float(ti['iv_rank_30d']) if ti.get('iv_rank_30d') else None

    print(f'  IV percentile:        {float(ti["iv_percentile"]):.0f}%' if ti.get('iv_percentile') else '  IV percentile:        —')
    print(f'  Insider signal:       {ti.get("insider_signal") or "—"}')
    print(f'  Beta (30d):           {float(ti["beta_30d"]):.2f}' if ti.get('beta_30d') else '  Beta (30d):           —')
    print(f'  Last updated:         {ti.get("last_updated") or "—"}')

    if ti.get('historical_earnings'):
        hist = ti['historical_earnings']
        if isinstance(hist, str):
            hist = json.loads(hist)
        print(f'\n  Historical earnings ({len(hist)} events):')
        print(f'  {"Date":<12} {"EPS":>8} {"Revenue":>14}')
        print(f'  {"─"*12} {"─"*8} {"─"*14}')
        for e in hist[:8]:
            eps = f"${e['eps_actual']:.2f}" if e.get('eps_actual') is not None else '—'
            rev = f"${e['revenue']/1e9:.2f}B" if e.get('revenue') else '—'
            print(f'  {e["date"]:<12} {eps:>8} {rev:>14}')
else:
    print('  No ticker intelligence data')

# ═══════════════════════════════════════════════════════════════════════════════
# 4. SEC FILINGS
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '-' * 70)
print('4. SEC FILINGS (last 5)')
print('-' * 70)

cur.execute("""
    SELECT form_type, filing_date, description, is_red_flag, red_flag_reason
    FROM lc_v3.sec_filings
    WHERE ticker = %s
    ORDER BY filing_date DESC
    LIMIT 5
""", (TICKER,))
sec_rows = cur.fetchall()

red_flag_count = 0
if sec_rows:
    print(f'  {"Date":<12} {"Type":<10} {"RedFlag":>8} {"Description"}')
    print(f'  {"─"*12} {"─"*10} {"─"*8} {"─"*40}')
    for r in sec_rows:
        rf = 'YES' if r['is_red_flag'] else 'no'
        if r['is_red_flag']:
            red_flag_count += 1
        desc = (r['description'] or '')[:60]
        print(f'  {str(r["filing_date"])[:10]:<12} {r["form_type"] or "—":<10} {rf:>8} {desc}')
else:
    print('  No SEC filings found')

# ═══════════════════════════════════════════════════════════════════════════════
# 5. PRICE DATA
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '-' * 70)
print('5. PRICE DATA')
print('-' * 70)

cur.execute("""
    SELECT close as last_close,
           DATE(ts AT TIME ZONE 'America/New_York') as last_date
    FROM lc_v3.bars
    WHERE ticker = %s AND session = 'REGULAR'
    ORDER BY ts DESC LIMIT 1
""", (TICKER,))
price_row = cur.fetchone()

cur.execute("""
    SELECT MAX(high) as high_52w, MIN(low) as low_52w
    FROM lc_v3.bars
    WHERE ticker = %s AND session = 'REGULAR'
      AND ts >= NOW() - INTERVAL '52 weeks'
""", (TICKER,))
range_row = cur.fetchone()

current_price = float(price_row['last_close']) if price_row else None
high_52w = float(range_row['high_52w']) if range_row and range_row['high_52w'] else None
low_52w = float(range_row['low_52w']) if range_row and range_row['low_52w'] else None

if current_price:
    print(f'  Current price:  ${current_price:.2f} (as of {price_row["last_date"]})')
if high_52w:
    pct_from_high = (current_price - high_52w) / high_52w * 100
    print(f'  52-week high:   ${high_52w:.2f}  ({pct_from_high:+.1f}% from high)')
if low_52w:
    pct_from_low = (current_price - low_52w) / low_52w * 100
    print(f'  52-week low:    ${low_52w:.2f}  ({pct_from_low:+.1f}% from low)')
if analyst_target and current_price:
    upside = (analyst_target - current_price) / current_price * 100
    print(f'  Analyst target: ${analyst_target:.2f}  ({upside:+.1f}% upside implied)')

# Options volume from equity_profiles
cur.execute("SELECT * FROM lc_v3.equity_profiles WHERE ticker = %s", (TICKER,))
ep_row = cur.fetchone()
if ep_row:
    print(f'\n  Equity profile:')
    for key in ['atr_20d', 'sector_etf']:
        if ep_row.get(key):
            label = key.replace('_', ' ').title()
            print(f'    {label}: {ep_row[key]}')

conn.close()

# ═══════════════════════════════════════════════════════════════════════════════
# 6. CONVICTION SCORER (Python replica)
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('CONVICTION SCORE BREAKDOWN')
print('=' * 70)

score = 0
breakdown = {}
risk_factors = []

# Revenue decline
if declining_q >= 3:
    score += 25
    breakdown['revenue_decline'] = 25
    risk_factors.append(f'Revenue declining {declining_q} consecutive quarters')
elif declining_q == 2:
    score += 15
    breakdown['revenue_decline'] = 15
    risk_factors.append('Revenue declining 2 consecutive quarters')
elif declining_q == 1:
    score += 5
    breakdown['revenue_decline'] = 5
else:
    breakdown['revenue_decline'] = 0

# Gross margin trend
if fund_rows and len(fund_rows) >= 2:
    latest_gm = float(fund_rows[0]['gross_margin']) if fund_rows[0].get('gross_margin') else None
    oldest_gm = float(fund_rows[-1]['gross_margin']) if fund_rows[-1].get('gross_margin') else None
    if latest_gm is not None and oldest_gm is not None:
        margin_trend = latest_gm - oldest_gm
        if margin_trend < 0:
            score += 10
            breakdown['margin_declining'] = 10
            risk_factors.append(f'Gross margin contracted {margin_trend*100:.1f}pp over {len(fund_rows)} quarters')
        else:
            breakdown['margin_declining'] = 0
    else:
        breakdown['margin_declining'] = 0
        margin_trend = None
else:
    breakdown['margin_declining'] = 0
    margin_trend = None

# FCF negative
is_fcf_negative = False
if fund_rows and fund_rows[0].get('free_cash_flow'):
    is_fcf_negative = float(fund_rows[0]['free_cash_flow']) < 0
if is_fcf_negative:
    score += 15
    breakdown['fcf_negative'] = 15
    risk_factors.append('Free cash flow negative (latest quarter)')
else:
    breakdown['fcf_negative'] = 0

# Insider selling
insider_score = 0
n_sellers = len(distinct_sellers)
if n_sellers >= 6:
    insider_score += 25
    risk_factors.append(f'{n_sellers} distinct insiders selling (90d)')
elif n_sellers >= 4:
    insider_score += 15
    risk_factors.append(f'{n_sellers} distinct insiders selling (90d)')

has_ceo = any('CEO' in s or 'Chief Executive' in s for s in [r.get('title', '') for r in insider_rows if r.get('transaction_type') == 'S-Sale'])
has_cfo = any('CFO' in s or 'Chief Financial' in s for s in [r.get('title', '') for r in insider_rows if r.get('transaction_type') == 'S-Sale'])
if has_ceo and has_cfo:
    insider_score += 25
    risk_factors.append('Both CEO and CFO selling')
elif has_ceo:
    insider_score += 10
    risk_factors.append('CEO selling')
elif has_cfo:
    insider_score += 10
    risk_factors.append('CFO selling')

score += insider_score
breakdown['insider_selling'] = insider_score

# SEC red flags
if red_flag_count > 0:
    score += 15
    breakdown['red_flag_filings'] = 15
    risk_factors.append(f'{red_flag_count} red-flag 8-K filing(s) in last 90 days')
else:
    breakdown['red_flag_filings'] = 0

# EDGAR 8-K (can't run live from Python — mark as 0)
breakdown['edgar_8k'] = 0

# M&A (not applicable for MCHP based on available data)
breakdown['ma_deal_risk'] = 0

# IV rank
if iv_rank is not None and iv_rank < 20:
    score += 15
    breakdown['iv_rank_low'] = 15
    risk_factors.append(f'IV rank very low ({iv_rank:.0f}%) — options cheap')
elif iv_rank is not None and iv_rank < 30:
    score += 10
    breakdown['iv_rank_low'] = 10
    risk_factors.append(f'IV rank low ({iv_rank:.0f}%) — options relatively cheap')
else:
    breakdown['iv_rank_low'] = 0

# Earnings proximity
if days_to_earnings is not None and days_to_earnings > 0:
    if days_to_earnings <= 14:
        score += 15
        breakdown['earnings_near'] = 15
        risk_factors.append(f'Earnings in {days_to_earnings} days — catalyst imminent')
    elif days_to_earnings <= 30:
        score += 10
        breakdown['earnings_near'] = 10
        risk_factors.append(f'Earnings in {days_to_earnings} days')
    else:
        breakdown['earnings_near'] = 0
else:
    breakdown['earnings_near'] = 0

# Near 52w high
if current_price and high_52w and high_52w > 0:
    if current_price >= high_52w * 0.90:
        score += 10
        breakdown['near_52w_high'] = 10
        risk_factors.append(f'Stock within 10% of 52-week high')
    else:
        breakdown['near_52w_high'] = 0
else:
    breakdown['near_52w_high'] = 0

score = min(score, 100)

recommendation = 'STRONG_PUT' if score >= 70 else 'MONITOR' if score >= 50 else 'PASS'

print(f'\n  TOTAL SCORE: {score}/100 → {recommendation}')
print(f'\n  Score Breakdown:')
for k, v in breakdown.items():
    label = k.replace('_', ' ').title()
    bar = '█' * v + '░' * (25 - v)
    print(f'    {label:<25} {v:>3}  {bar}')

print(f'\n  Risk Factors:')
for i, rf in enumerate(risk_factors, 1):
    print(f'    {i}. {rf}')

# ═══════════════════════════════════════════════════════════════════════════════
# 7. PUT OPTION ESTIMATE
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('PUT OPTION ESTIMATE')
print('=' * 70)

if current_price and iv_rank is not None:
    strike = round(current_price * 0.90, 2)  # 10% OTM
    # Expiry May 15 — compute DTE from today
    today = datetime.now()
    expiry = datetime(2026, 5, 15)
    dte = (expiry - today).days

    # Black-Scholes approximation for OTM put
    # Use IV rank to estimate actual IV: if rank=X%, IV ~ 30% + rank_adjustment
    # MCHP historical IV range roughly 25-55%, so:
    est_iv = 0.30 + (iv_rank / 100) * 0.25  # rough estimate
    # If we have avg earnings move, use that as a better proxy
    if avg_move:
        est_iv = max(est_iv, avg_move / 100 * 2)  # earnings move implies annualized vol

    # Simple Black-Scholes put approximation
    # For OTM put: P ≈ S * N(-d2) * e^(-rT) - K * e^(-rT) * N(-d1)
    # Simplified: P ≈ S * IV * sqrt(T) * pdf(d) where d = ln(S/K)/(IV*sqrt(T))
    T = dte / 365
    S = current_price
    K = strike
    sigma = est_iv
    r = 0.04  # risk-free rate

    d1 = (math.log(S / K) + (r + sigma**2 / 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    # Normal CDF approximation
    def norm_cdf(x):
        return 0.5 * (1 + math.erf(x / math.sqrt(2)))

    put_price = K * math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1)

    print(f'  Current price:     ${current_price:.2f}')
    print(f'  Strike (10% OTM):  ${strike:.2f}')
    print(f'  Expiry:            May 15, 2026 ({dte} DTE)')
    print(f'  Est. IV:           {est_iv*100:.0f}%')
    print(f'  IV Rank:           {iv_rank:.0f}%')
    print(f'  Est. put price:    ${put_price:.2f}')
    print(f'  Cost per contract: ${put_price * 100:.0f}')
    print(f'  Breakeven at exp:  ${strike - put_price:.2f} ({(strike - put_price - current_price) / current_price * 100:+.1f}%)')

    # Risk/reward
    if put_price > 0:
        # If stock drops 20% from here
        drop_20_price = current_price * 0.80
        intrinsic_20 = max(0, strike - drop_20_price)
        profit_20 = intrinsic_20 - put_price
        print(f'\n  Scenario Analysis:')
        print(f'    Stock drops 10% (${current_price*0.90:.2f}): at-the-money, ~${max(0, put_price * 0.5):.2f} value')
        print(f'    Stock drops 20% (${drop_20_price:.2f}): intrinsic ${intrinsic_20:.2f}, profit ${profit_20:+.2f} ({profit_20/put_price*100:+.0f}%)')
        print(f'    Stock drops 30% (${current_price*0.70:.2f}): intrinsic ${max(0, strike - current_price*0.70):.2f}, profit ${max(0, strike - current_price*0.70) - put_price:+.2f}')
        print(f'    Max loss: ${put_price:.2f} per share (${put_price*100:.0f} per contract)')
else:
    print('  Insufficient data for option pricing')

# ═══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('MCHP CONVICTION SUMMARY')
print('=' * 70)
print(f'  Score:        {score}/100 ({recommendation})')
print(f'  Price:        ${current_price:.2f}' if current_price else '')
print(f'  From 52w hi:  {pct_from_high:+.1f}%' if current_price and high_52w else '')
print(f'  Rev decline:  {declining_q} consecutive quarters')
print(f'  FCF:          {"NEGATIVE" if is_fcf_negative else "POSITIVE"}')
print(f'  Margin trend: {margin_trend*100:+.1f}pp' if margin_trend is not None else '  Margin trend: —')
print(f'  Insiders:     {len(distinct_sellers)} sellers, ${total_sell_value:,.0f} value')
print(f'  Earnings:     {earnings_date} ({days_to_earnings}d away)' if earnings_date else '  Earnings:     —')
print(f'  IV rank:      {iv_rank:.0f}%' if iv_rank is not None else '  IV rank:      —')
print()
