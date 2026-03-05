# Render Deployment Instructions

**Status:** 🚀 Ready to Deploy  
**Latest Commit:** e1bdcc2 - Updated render.yaml with Alpaca credentials

---

## Auto-Deploy Status

Render should automatically deploy from GitHub push. Check deployment status:
👉 **https://dashboard.render.com/**

---

## Environment Variables Setup

You **MUST** set these manually in the Render Dashboard for both services (web + worker):

### Required Secrets (Set in Render Dashboard)

1. Go to https://dashboard.render.com/
2. Select **alphatrades-web** service
3. Go to **Environment** tab
4. Add these environment variables:

```
ALPACA_API_KEY=PKCF3BAQSFQEWDQRLG45SZIMMQ
ALPACA_SECRET_KEY=DFJXX1qz33tPgYxQdVAhhYt4QXmp4zFGHbiaFrCaiQkk
```

5. Repeat for **alphatrades-worker** service

### Pre-configured (in render.yaml)
These are already set automatically:
- ✅ `ALPACA_BASE_URL=https://paper-api.alpaca.markets`
- ✅ `ALPACA_DATA_URL=https://data.alpaca.markets`
- ✅ `TRADING_MODE=paper`
- ✅ `DATABASE_URL` (auto-linked to PostgreSQL)

---

## Deployment Checklist

### 1. Verify GitHub Push
- [x] Code pushed to main branch
- [x] render.yaml updated with Alpaca credentials
- [x] Latest commit: e1bdcc2

### 2. Render Dashboard
- [ ] Go to https://dashboard.render.com/
- [ ] Check **alphatrades-web** is deploying
- [ ] Check **alphatrades-worker** is deploying
- [ ] Add `ALPACA_API_KEY` to web service
- [ ] Add `ALPACA_SECRET_KEY` to web service
- [ ] Add `ALPACA_API_KEY` to worker service
- [ ] Add `ALPACA_SECRET_KEY` to worker service

### 3. Wait for Deployment
Render will:
- Install dependencies (`pip install -r requirements.txt`)
- Run database init (`python init_db.py`)
- Start web service (`gunicorn app:app`)
- Start worker service (`python worker.py`)

### 4. Verify Deployment
Once deployed:
- [ ] Visit https://alphatrades.onrender.com/
- [ ] Check if Stock Cards page loads
- [ ] Open browser console (F12)
- [ ] Look for "Connected to real-time stream" message
- [ ] Verify prices are updating live
- [ ] Check worker logs for "WebSocket stream initialized"

---

## Testing Real-Time Stream

### During Market Hours (9:30am-4pm EST)
1. Open Stock Cards page
2. Open browser console (F12)
3. Look for:
   ```
   📡 Stream connected: 2026-03-05T10:52:00Z
   📈 NVDA: $850.25
   📈 TSLA: $195.40
   ```
4. Prices should update **every second** (not every 15 seconds)
5. Status should show "Live • Real-Time"

### Outside Market Hours
- Dashboard should load but show last prices
- Worker will sleep and log "💤 Outside market hours"

---

## WebSocket Support

Render **supports WebSocket/SSE connections** on all plans.  
No special configuration needed.

---

## Database Migration

The database should auto-initialize on first deploy via `init_db.py`.  
If tables already exist, it will skip creation.

To manually reset database:
```bash
# SSH into Render shell (if needed)
python init_db.py
```

---

## Troubleshooting

### "Stream not initialized" error
- Check that `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` are set in Render dashboard
- Check worker logs for WebSocket connection errors
- Verify API keys are correct

### Prices not updating
- Open browser console (F12) and check for errors
- Verify EventSource connection to `/api/stream/prices`
- Check if market is open (9:30am-4pm EST, Mon-Fri)

### Worker not scoring
- Check worker logs in Render dashboard
- Verify WebSocket connection is established
- Look for "✅ WebSocket stream initialized" message

### Database errors
- Verify `DATABASE_URL` is correctly linked
- Check PostgreSQL is running (Render dashboard)
- Run `python init_db.py` manually if needed

---

## Performance Monitoring

### Expected Metrics
- **Update Latency:** <100ms (from trade to UI update)
- **WebSocket Uptime:** 99%+ (auto-reconnects)
- **Scoring Delay:** <1 second (event-driven)

### Check Logs
**Web Service:**
```
✅ Alpaca WebSocket stream initialized
📡 Subscribed to 13 symbols
```

**Worker Service:**
```
🚀 Market Monitor initialized
✅ WebSocket stream initialized
🎧 Listening for real-time updates...
```

---

## Rollback Plan

If issues occur:
1. Revert to previous commit (before WebSocket upgrade)
2. Restore Finnhub API key in Render dashboard
3. Deploy previous version

Previous stable commit: `745468e` (before real-time upgrade)

---

## Next Steps After Deployment

1. Monitor first market session (9:30am-4pm EST)
2. Verify alerts are generated in real-time
3. Check Options Feed for historical alerts
4. Add options Greeks streaming (next phase)

---

**Deployment URL:** https://alphatrades.onrender.com/  
**Render Dashboard:** https://dashboard.render.com/

🎯 **Ready for production with real-time WebSocket streaming!**
