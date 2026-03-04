# 🚀 AlphaTrades - READY TO DEPLOY

## ✅ Completed

- [x] All code written (15 files)
- [x] Database initialized
- [x] Default configuration loaded ($600 starting capital)
- [x] Connection tested
- [x] Documentation complete
- [x] Git commits ready

## 📊 Database Status

**Internal URL (for Render):**
```
postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db
```

✅ Tables created: alerts, trades, daily_performance, model_config, account_state  
✅ Starting capital: $600  
✅ Auto-trade grades: A+, A  
✅ Trading mode: Paper  

## 🎯 Deploy in 3 Steps (10 minutes total)

### Step 1: Push to GitHub (2 minutes)

```bash
cd /tmp/AlphaTrades
git push origin main
```

If prompted for authentication, use:
- **Username:** frankparkerlee-debug
- **Password:** Use GitHub Personal Access Token (not your password)

Generate token at: https://github.com/settings/tokens

### Step 2: Get Finnhub API Key (2 minutes)

1. Go to https://finnhub.io
2. Click "Get free API key"
3. Sign up with email
4. Copy your API key (format: `abc123def456...`)

### Step 3: Deploy on Render (6 minutes)

#### Deploy Web Service:

1. Go to https://dashboard.render.com
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect a repository"** or select existing GitHub connection
4. Select: `frankparkerlee-debug/AlphaTrades`
5. Click **"Connect"**

6. Configure:
   - **Name:** `alphatrades-web`
   - **Environment:** `Python 3`
   - **Branch:** `main`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app`
   - **Instance Type:** `Starter` ($7/month)

7. Click **"Advanced"** → **"Add Environment Variable"**

   Add these 3 variables:
   
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | `postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db` |
   | `FINNHUB_API_KEY` | `your_key_here` (paste from Step 2) |
   | `TRADING_MODE` | `paper` |

8. Click **"Create Web Service"**

Wait 2-3 minutes for deployment...

#### Deploy Worker Service:

1. Click **"New +"** → **"Background Worker"**
2. Select same repository: `frankparkerlee-debug/AlphaTrades`
3. Click **"Connect"**

4. Configure:
   - **Name:** `alphatrades-worker`
   - **Environment:** `Python 3`
   - **Branch:** `main`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python worker.py`
   - **Instance Type:** `Starter` ($7/month)

5. Add same 3 environment variables:
   
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | `postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db` |
   | `FINNHUB_API_KEY` | `your_key_here` |
   | `TRADING_MODE` | `paper` |

6. Click **"Create Background Worker"**

## ✅ Verify Deployment

### Check Web Service (Dashboard):

1. Render Dashboard → `alphatrades-web` → Logs
2. Should see: `Booting worker with pid: ...`
3. Click the URL at top (e.g., `https://alphatrades-web.onrender.com`)
4. Dashboard should load showing:
   - Account Value: $600.00
   - Total P/L: $0.00
   - Win Rate: 0%
   - Open Positions: 0

### Check Worker Service (Trading Bot):

1. Render Dashboard → `alphatrades-worker` → Logs
2. Should see:
   ```
   🚀 Market Monitor initialized
      Mode: paper
      Auto-trade grades: ['A+', 'A']
      Watching: NVDA, TSLA, AMD, AAPL, AMZN, META, MSFT, GOOGL, NFLX, AVGO, ORCL, ADBE
   ```

3. **If market is open** (9:30am-4pm EST, Mon-Fri):
   ```
   📊 Scanning market...
   🎯 ALERT: NVDA Grade A+ (Score: 55/55) | Move: 3.5% | Range: 4.2%
   ✅ ENTERED NVDA CALL $145.00 | Grade: A+ | Cost: $120.00
   ```

4. **If market is closed:**
   ```
   💤 Outside market hours, sleeping...
   ```

## 🎉 Success!

Once both services show as "Live" and logs look good, your system is running!

**What happens next:**
- Worker scans 12 stocks every 5 seconds during market hours
- Generates alerts for grades A+ through D
- Auto-enters trades on A+ and A grades only
- Auto-exits based on rules (Friday close, 5 days, stop loss, targets)
- Dashboard updates every 30 seconds

**First week goals:**
- Collect 50-100 alerts
- Execute 5-10 paper trades
- Validate scoring accuracy
- Track win rate by grade

## 📱 Monitoring

### Dashboard
**URL:** `https://alphatrades-web.onrender.com` (Render will show your actual URL)

**Check daily:**
- Account value
- Win rate
- Open positions
- Recent alerts

### Worker Logs
**Where:** Render Dashboard → alphatrades-worker → Logs

**Watch for:**
- `🎯 ALERT` - New trade opportunities
- `✅ ENTERED` - Trades executed
- `📈 EXITED` - Trades closed with P/L

### Example Log Output (Success):
```
🎯 ALERT: AMD Grade A+ (Score: 55/55) | Move: 5.18% | Range: 6.55%
✅ ENTERED AMD CALL $195.00 | Grade: A+ | Cost: $120.00
📈 EXITED AMD CALL | Reason: target_hit | P/L: $60.00 (+50%) | Hold: 2d 6h
```

## 🛠 Troubleshooting

### "❌ FINNHUB_API_KEY not set!"
- Render Dashboard → Your Service → Environment
- Add the variable
- Manual Deploy

### "Database connection failed"
- Check DATABASE_URL is set correctly
- Verify internal URL (no `.oregon-postgres.render.com`)

### "No alerts appearing"
- Check if market is open (9:30am-4pm EST, Mon-Fri)
- Verify Finnhub API key is valid
- Check worker logs for errors

### Worker not starting
- Check logs for Python errors
- Verify requirements.txt installed
- Restart service manually

## 💰 Costs

- Web Service: $7/month
- Worker Service: $7/month
- Database: Already created (included)
- **Total: $14/month**

## 📈 Next Steps

**After 2 weeks:**
1. Review performance by grade
2. Adjust thresholds if needed
3. Add more stocks if desired

**After 4 weeks (if profitable):**
1. Get Schwab developer API
2. Switch to live trading
3. Start with small positions
4. Scale up gradually

---

## 🚀 Ready to Launch!

**Current location:** `/tmp/AlphaTrades/`  
**Next command:** `git push origin main`

**Time to live:** 10 minutes from now! 🎯
