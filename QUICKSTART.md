# Quick Start Guide - AlphaTrades

## ✅ Status

- [x] Code complete
- [x] Database initialized
- [x] Ready to push to GitHub
- [x] Database URL configured

## Your Database

**Internal URL (for Render services):**
```
postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db
```

**External URL (for local testing):**
```
postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db
```

**Status:** ✅ Connected and initialized with all tables

> **Note:** Use internal URL for deployed services (faster, more secure)

## Next Steps (5 minutes)

### 1. Push to GitHub

```bash
cd /tmp/AlphaTrades
git push origin main
```

You'll be prompted for GitHub credentials or token.

### 2. Get Finnhub API Key

1. Go to https://finnhub.io
2. Sign up (free)
3. Copy your API key (looks like: `d6k4j79r01qko8c3c750...`)

### 3. Deploy Web Service to Render

1. Go to https://dashboard.render.com
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo: `frankparkerlee-debug/AlphaTrades`
4. Configure:
   - **Name:** alphatrades-web
   - **Environment:** Python 3
   - **Branch:** main
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app`
   - **Plan:** Starter ($7/month)

5. **Environment Variables:**
   - `DATABASE_URL` = `postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db` (internal URL - faster)
   - `FINNHUB_API_KEY` = (paste your Finnhub key)
   - `TRADING_MODE` = `paper`

6. Click **"Create Web Service"**

### 4. Deploy Worker Service to Render

1. Click **"New +"** → **"Background Worker"**
2. Connect same GitHub repo
3. Configure:
   - **Name:** alphatrades-worker
   - **Environment:** Python 3
   - **Branch:** main
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python worker.py`
   - **Plan:** Starter ($7/month)

4. **Environment Variables:** (same as web service)
   - `DATABASE_URL` = `postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db` (internal URL)
   - `FINNHUB_API_KEY` = (paste your Finnhub key)
   - `TRADING_MODE` = `paper`

5. Click **"Create Background Worker"**

### 5. Verify Deployment

**Check Web Service:**
- Wait for deploy to complete (~2 minutes)
- Visit your URL: `https://alphatrades-web.onrender.com`
- Should see dashboard

**Check Worker Logs:**
- Render Dashboard → alphatrades-worker → Logs
- Should see: `🚀 Market Monitor initialized`
- If market hours: `📊 Scanning market...`
- If after hours: `💤 Outside market hours, sleeping...`

## What Happens Next

**During Market Hours (9:30am-4pm EST, Mon-Fri):**
- Worker scans 12 stocks every 5 seconds
- Generates alerts for Grade A+ through D
- Auto-enters trades on A+ and A grades
- Auto-exits per rules (Friday close, 5 days, stop loss, targets)
- Dashboard updates every 30 seconds

**After Market Close:**
- Worker sleeps until next market open
- Dashboard shows cumulative results
- Database preserves all alerts and trades

**First Week Goals:**
- Collect 50-100 alert samples
- Execute 5-10 paper trades
- Validate scoring accuracy
- Track win rate by grade

## Monitoring

**Dashboard:** `https://alphatrades-web.onrender.com`

**Shows:**
- Account value & P/L
- Win rate
- Open positions
- Recent alerts
- Closed trades

**Worker Logs to Watch For:**
```
🎯 ALERT: NVDA Grade A+ (Score: 55/55) | Move: 3.5% | Range: 4.2%
✅ ENTERED NVDA CALL $145.00 | Grade: A+ | Cost: $120.00
📈 EXITED NVDA CALL | Reason: friday_close | P/L: $60.00 (+50%) | Hold: 2d
```

## Troubleshooting

**If worker shows "❌ FINNHUB_API_KEY not set!"**
- Go to Render → alphatrades-worker → Environment
- Add `FINNHUB_API_KEY` variable
- Redeploy

**If dashboard shows database error:**
- Verify `DATABASE_URL` is set correctly
- Check database is running in Render dashboard

**If no alerts appearing:**
- Check if market is open (9:30am-4pm EST, Mon-Fri)
- Check worker logs for "Scanning market..."
- Verify Finnhub API key is valid

## Cost Summary

- Database: Already created (included in $7/month)
- Web Service: $7/month
- Worker Service: $7/month
- **Total: $14/month** (database already paid for)

## Next Phase: Optimization

After 2-4 weeks of data:
1. Analyze performance by grade (A+ vs A vs A-)
2. Adjust thresholds to optimize win rate
3. Add more stocks if needed
4. Consider Strategy 2 (index plays)

## Next Phase: Real Trading

Once paper trading proves profitable:
1. Get Schwab developer API credentials
2. Update `trader.py` with Schwab integration
3. Change `TRADING_MODE=paper` to `TRADING_MODE=live`
4. Start with small positions ($50-100)
5. Scale up as confidence grows

---

**Current Status:** Database initialized ✅  
**Next Step:** Push to GitHub and deploy services

**Ready to go! 🚀**
