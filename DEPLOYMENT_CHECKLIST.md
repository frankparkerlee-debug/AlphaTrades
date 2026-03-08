# Deployment Checklist - Worker Architecture Overhaul

## Status: ✅ Code Pushed (Commit 53ae454)

Render is auto-deploying now (~5 minutes).

---

## Required Steps After Deploy

### 1. Run Database Migration

**Option A: Via psql command line**

```bash
psql postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db < migrate_signals.sql
```

**Option B: Via Render Console**

1. Go to: https://dashboard.render.com/d/dpg-d6kak47kijhs73cat0o0-a
2. Click "Console" tab
3. Paste contents of `migrate_signals.sql`
4. Execute

**Option C: Via Python**

```python
python3 << 'EOF'
import os
os.environ['DATABASE_URL'] = 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db'

from models import get_db_engine, Base
engine = get_db_engine()
Base.metadata.create_all(engine)
print("✅ Database migration complete!")
EOF
```

---

### 2. Verify Worker Logs

Go to: https://dashboard.render.com/web/srv-YOUR-WORKER-ID

Look for:
```
🚀 Signal Worker initialized
   Tickers: NVDA, TSLA, AMD, AAPL, AMZN, META, MSFT, GOOGL, NFLX, AVGO, ORCL, ADBE
   Update interval: 60s
   Using: 7-signal ConvergenceScorer + OptionsSelector

📊 Starting signal update cycle
📈 SPY: $565.23 (+0.34%) - Market UP

✅ NVDA   | $142.50 (+2.34%) | Grade: A   | Score:  87/100 | Signals: 5/7
✅ TSLA   | $234.12 (-1.23%) | Grade: B+  | Score:  73/100 | Signals: 4/7
...
✅ Updated 12 signals | ❌ 0 errors
⏱️  Cycle took 18.3s | Sleeping 41.7s until next update
```

**If worker isn't running:**
- Click "Manual Deploy" → "Clear build cache & deploy"

---

### 3. Test Dashboard

Visit: https://alphatrades.onrender.com

**Expected behavior:**
- ✅ Page loads in <2 seconds
- ✅ All 12 cards show immediately
- ✅ Click card → modal opens instantly
- ✅ Console shows: `✅ Loaded 12 signals in batch`

**If you see errors:**
- "Signal not found" → Worker hasn't completed first cycle yet (wait 2 minutes)
- "Stale data" → Worker isn't running (check logs)
- Page still slow → Cache not working (check API response times)

---

### 4. Monitor Performance

**Check API response times:**

```bash
# Should be < 50ms (not 15-20 seconds!)
time curl https://alphatrades.onrender.com/api/signal/NVDA

# Batch endpoint (all 12 tickers)
time curl https://alphatrades.onrender.com/api/signals/all
```

**Check worker cycle time:**
- Should complete in 15-20 seconds
- Should sleep 40-45 seconds
- Total cycle: 60 seconds

---

## Performance Benchmarks

### Before (On-Demand Calculation):
- Page load: 20-30 seconds
- Modal open: 15-20 seconds
- API /api/signal: 15-20 seconds
- 12 parallel requests on page load

### After (Background Worker):
- Page load: <2 seconds
- Modal open: <100ms
- API /api/signal: <50ms
- 1 batch request on page load

**Target: 15-300x faster**

---

## Troubleshooting

### Issue: "Signal not found for NVDA"

**Cause:** Database empty (first run)  
**Fix:** Wait 2 minutes for worker to complete first cycle

### Issue: Dashboard still slow

**Cause:** Migration not run, API still using old code  
**Fix:** Run database migration, verify deploy completed

### Issue: Worker not logging

**Cause:** Worker service not started  
**Fix:** Restart worker via Render dashboard

### Issue: Stale data (age_seconds > 300)

**Cause:** Worker crashed or stuck  
**Fix:** Check worker logs for errors, restart if needed

---

## Rollback Plan

If something goes wrong:

```bash
cd /tmp/AlphaTrades
git revert 53ae454
git push origin main
```

This will restore the old on-demand calculation (slow but working).

---

## Success Criteria

✅ Worker logs show 60-second cycles  
✅ Dashboard loads in <2 seconds  
✅ Modal opens in <100ms  
✅ All 12 signals cached in database  
✅ No "Signal not found" errors  
✅ age_seconds < 60 for all signals  

**When all criteria met:** Architecture overhaul complete! 🎉

---

## Next Steps After Verification

1. Monitor for 24 hours (ensure stability)
2. Implement Priority 3 (Auto-trading agent)
3. Add WebSocket streaming (Phase 2)
4. Add Redis caching (Phase 3)

---

**Dashboard:** https://alphatrades.onrender.com  
**Render Dashboard:** https://dashboard.render.com  
**Commit:** 53ae454  
**Deployed:** 2026-03-05 10:25pm CST
