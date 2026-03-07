# V5 Dashboard Deployment Plan
## Remote Access via Render

**URL:** https://alphatrades.onrender.com/v5  
**Goal:** 30+ trades/month with 15 tech stocks using V5 scoring

---

## Phase 1: Initial Deployment (Today)

### Step 1: Create V5 Route & Template
- New route: `/v5` → V5 dashboard
- Template: `templates/v5_dashboard.html`
- API: `/api/v5/score/{ticker}` → V5 scoring endpoint

### Step 2: V5 Scoring System (100 points)
1. Catalyst (0-30): News/earnings detection
2. Volume (0-20): Surge vs 20-day average
3. Direction (0-20): Directional dominance
4. Range (0-15): Intraday range %
5. Timing (0-10): Best entry windows
6. Calendar (0-5): FOMC/event penalties
7. Alignment (0-5): SPY correlation
8. RSI (0-10): Momentum confirmation

### Step 3: 15 Tech Tickers
AMD, NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, NFLX, AVGO, ORCL, ADBE, CRM, INTC, QCOM

### Step 4: Push to Render
- Commit to GitHub
- Render auto-deploys
- Available at /v5 route

---

## Deployment Steps

1. ✅ Pull latest from GitHub
2. ⏳ Create v5_dashboard.html template  
3. ⏳ Add /v5 route to app.py
4. ⏳ Create V5 scoring API endpoint
5. ⏳ Test locally
6. ⏳ Commit & push to GitHub
7. ⏳ Verify Render deployment

---

Starting now...
