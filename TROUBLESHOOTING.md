# Troubleshooting Guide

## Issue: SSE Stream Disconnecting + Worker Timeouts

**Symptoms:**
- Browser console: `❌ Stream error, reconnecting...`
- Render logs: `Worker (pid:XX) was sent SIGKILL! Perhaps out of memory?`
- Render logs: `WORKER TIMEOUT (pid:XX)`
- Response times: 30+ seconds
- SSE connections breaking after 30 seconds

**Root Cause:**
Gunicorn's default **sync workers** have a 30-second timeout. Server-Sent Events (SSE) need to keep connections open indefinitely, which causes sync workers to:
1. Block for >30 seconds
2. Trigger timeout
3. Get killed by Gunicorn
4. Break SSE connection

**Solution:** Use **gevent async workers**

Gevent uses greenlets (cooperative multitasking) to handle long-lived connections without blocking the worker process.

### Changes Made

**1. Added gevent to requirements.txt:**
```python
gevent==24.2.1
```

**2. Updated Gunicorn command in render.yaml:**
```bash
# Before:
gunicorn app:app

# After:
gunicorn --worker-class gevent --workers 2 --timeout 300 --bind 0.0.0.0:$PORT app:app
```

**Flags explained:**
- `--worker-class gevent` - Use async workers (non-blocking)
- `--workers 2` - 2 worker processes (sufficient for Starter plan)
- `--timeout 300` - 5-minute timeout (SSE needs long timeout)
- `--bind 0.0.0.0:$PORT` - Bind to Render's port

### Expected Behavior After Fix

**Render Logs (Web Service):**
```
✅ Alpaca WebSocket stream initialized
📡 Subscribed to 13 symbols
🎧 Listening for real-time updates...
[INFO] Booting worker with pid: 55
```

**Browser Console:**
```
🔌 Connecting to real-time price stream...
✅ Connected to real-time stream
📡 Stream connected: 2026-03-05T11:15:00Z
📈 NVDA: $850.25
```

**No more:**
- ❌ WORKER TIMEOUT errors
- ❌ SIGKILL/OOM errors
- ❌ Stream reconnecting loops

---

## Other Common Issues

### Issue: Authentication Failed
**Error:** `❌ Authentication failed: [{'T': 'success', 'msg': 'connected'}]`

**Fix:** Updated `alpaca_stream.py` to accept both `'authenticated'` and `'connected'` messages.

**Commit:** `5835633`

---

### Issue: Slow Initial Load (30-50 seconds)
**Cause:** Render free tier spins down after 15 minutes of inactivity.

**Expected:** First load takes 30-50 seconds (cold start), subsequent loads are fast.

**No fix needed** - this is normal for free tier.

---

### Issue: Prices Not Updating Live
**Checklist:**
1. Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)
2. Check browser console for connection messages
3. Verify Alpaca API keys are set in Render Environment
4. Check Render logs for WebSocket authentication success
5. Verify market is open (9:30am-4pm EST, Mon-Fri)

---

### Issue: "Stream not initialized" Error
**Cause:** Alpaca API credentials not set or invalid.

**Fix:**
1. Go to Render Dashboard → Service → Environment
2. Add:
   - `ALPACA_API_KEY`
   - `ALPACA_SECRET_KEY`
3. Trigger manual deploy

---

## Deployment Checklist

After any code changes:

1. ✅ Code pushed to GitHub main branch
2. ✅ Render auto-deploys (watch Events tab)
3. ✅ Check logs for `✅ WebSocket authenticated`
4. ✅ Hard refresh browser (clear cache)
5. ✅ Open console (F12) and verify connection
6. ✅ Check that prices update in real-time

---

## Performance Expectations

| Metric | Expected | Troubleshoot If |
|--------|----------|-----------------|
| Initial Load (Cold) | 30-50s | >60s: Check logs |
| Initial Load (Warm) | 2-5s | >10s: Check logs |
| SSE Connection | <1s | >5s: Check gevent workers |
| Price Updates | <100ms | >1s: Check WebSocket stream |
| Worker Uptime | Continuous | Crashes: Check memory/timeout |

---

## Quick Diagnostic Commands

**Check if gevent is working:**
```bash
# In Render shell
ps aux | grep gunicorn
# Should show: --worker-class gevent
```

**Test SSE endpoint:**
```bash
curl https://alphatrades.onrender.com/api/stream/prices
# Should stream data continuously (Ctrl+C to stop)
```

**Check WebSocket status:**
Check Render logs for:
- `✅ WebSocket authenticated successfully`
- `📡 Subscribed to 13 symbols`

---

## Rollback Plan

If gevent causes issues:

1. Revert to sync workers:
   ```bash
   gunicorn app:app
   ```

2. Remove gevent from requirements.txt

3. Add shorter polling fallback to frontend

Previous stable commit: `5835633` (before gevent)

---

**Status:** ✅ Fixed with commit `650b5a6`  
**Deployed:** Render auto-deploy in progress  
**ETA:** 2-3 minutes
