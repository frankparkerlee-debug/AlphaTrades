# Deployment Guide for Render

## Pre-Deployment Checklist

1. ✅ GitHub repo created: https://github.com/frankparkerlee-debug/AlphaTrades.git
2. ✅ Code pushed to repo
3. ⚠️ Finnhub API key (get free at https://finnhub.io)
4. ⚠️ Render account connected to GitHub

## Step 1: Push Code to GitHub

```bash
cd /tmp/AlphaTrades
git init
git add .
git commit -m "Initial commit - Auto-trading system"
git remote add origin https://github.com/frankparkerlee-debug/AlphaTrades.git
git branch -M main
git push -u origin main
```

## Step 2: Deploy to Render

### Option A: Auto-Deploy via render.yaml (Recommended)

1. Go to https://dashboard.render.com
2. Click "New +" → "Blueprint"
3. Connect your GitHub repo: `frankparkerlee-debug/AlphaTrades`
4. Render will automatically detect `render.yaml` and create:
   - PostgreSQL database
   - Web service (dashboard)
   - Worker service (market monitor)

### Option B: Manual Setup

If auto-deploy doesn't work:

**1. Create Database:**
- New + → PostgreSQL
- Name: `alphatrades-db`
- Plan: Starter ($7/month)
- Create Database

**2. Create Web Service:**
- New + → Web Service
- Connect GitHub repo
- Name: `alphatrades-web`
- Environment: Python 3
- Build Command: `pip install -r requirements.txt && python init_db.py`
- Start Command: `gunicorn app:app`
- Plan: Starter ($7/month)
- Add Environment Variables:
  - `DATABASE_URL` → Link to database
  - `FINNHUB_API_KEY` → Your key
  - `TRADING_MODE` → `paper`

**3. Create Worker Service:**
- New + → Background Worker
- Connect same GitHub repo
- Name: `alphatrades-worker`
- Build Command: `pip install -r requirements.txt`
- Start Command: `python worker.py`
- Plan: Starter ($7/month)
- Add same environment variables

## Step 3: Set Environment Variables

In Render dashboard, for BOTH services:

```
DATABASE_URL = (auto-linked from database)
FINNHUB_API_KEY = your_finnhub_key_here
TRADING_MODE = paper
```

## Step 4: Deploy & Verify

1. Click "Manual Deploy" or push to GitHub (triggers auto-deploy)
2. Wait for build to complete (~2-3 minutes)
3. Check logs for both services:
   - Web: Should show "Booting Gunicorn..."
   - Worker: Should show "Market Monitor initialized"

## Step 5: Access Dashboard

Your dashboard will be at:
```
https://alphatrades-web.onrender.com
```

(Render assigns this URL automatically)

## Monitoring

### View Logs

**Web Service:**
- Render Dashboard → alphatrades-web → Logs
- Shows API requests and errors

**Worker Service:**
- Render Dashboard → alphatrades-worker → Logs
- Shows market scans, alerts, and trades

**Database:**
- Render Dashboard → alphatrades-db → Connect
- Get connection string to query directly

### Key Log Messages

**Worker (good):**
```
🚀 Market Monitor initialized
📊 Scanning market...
🎯 ALERT: NVDA Grade A+ (Score: 55/55)
✅ ENTERED NVDA CALL $145.00 | Grade: A+ | Cost: $120.00
```

**Worker (off hours):**
```
💤 Outside market hours, sleeping...
```

**Web (healthy):**
```
GET / 200
GET /api/alerts 200
```

## Troubleshooting

### Database Connection Failed

**Error:** `DATABASE_URL environment variable not set`

**Fix:** 
1. Render Dashboard → Services → Your Service → Environment
2. Add `DATABASE_URL` linked to your database
3. Redeploy

### Finnhub API Error

**Error:** `FINNHUB_API_KEY not set!`

**Fix:**
1. Get free API key at https://finnhub.io
2. Add to environment variables in Render
3. Redeploy

### Worker Not Scanning

**Check:**
1. Is it market hours? (9:30am-4pm EST, Mon-Fri)
2. Check worker logs for errors
3. Restart worker service

### No Trades Executing

**Check:**
1. Are there any A+ or A alerts? (Check dashboard)
2. Is `TRADING_MODE=paper` set?
3. Check worker logs for "ENTERED" messages
4. Verify database has `model_config` with `auto_trade_grades`

## Cost Breakdown

- PostgreSQL Database: $7/month
- Web Service: $7/month
- Worker Service: $7/month
- **Total: $21/month**

## Scaling Up

### Add More Stocks

Edit `worker.py`:
```python
TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 
           'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE',
           'INTC', 'QCOM', 'CSCO', 'PYPL']  # Add more here
```

### Optimize Thresholds

Use API to update configuration:
```bash
curl -X POST https://your-app.onrender.com/api/config \
  -H "Content-Type: application/json" \
  -d '{"threshold_a_plus": 48}'  # Lower to catch more A+ alerts
```

### Add Schwab Integration (Phase 2)

See `SCHWAB-INTEGRATION.md` (coming soon)

## Support

If you encounter issues:
1. Check logs first (Render Dashboard → Logs)
2. Verify environment variables are set
3. Check if market is open (9:30am-4pm EST)
4. Review `README.md` for architecture details

---

**Ready to trade! 🚀**
