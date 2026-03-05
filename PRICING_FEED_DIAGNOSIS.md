# Pricing Feed Diagnosis & Solutions

## Problem Identified

**Symptom:** Stock prices not updating on dashboard

**Root Cause:** Finnhub API rate limit exceeded

**Proof:**
```bash
$ curl "https://finnhub.io/api/v1/quote?symbol=AMZN&token=..."
{"error":"API limit reached. Please try again later. Remaining Limit: 0"}
```

## Why This Happened

**Finnhub Free Tier Limits:**
- 60 API calls per minute
- 250,000 calls per month

**Our Usage (before fix):**
- 13 API calls per update (12 stocks + SPY)
- Updates every 10 seconds = 6 updates/minute
- **78 calls/minute** = 30% OVER LIMIT
- **112,320 calls/day** = 43% of monthly limit in ONE DAY

**Result:** Rate limited to zero, all requests rejected

## Immediate Fix Applied

**Changed update interval:**
- FROM: 10 seconds (78 calls/min) ❌
- TO: 15 seconds (52 calls/min) ✅

**New calculation:**
- 13 calls × 4 updates/min = 52 calls/minute
- **13% under limit** - safe buffer for variability

**Also added:**
- Rate limit error detection
- User-facing error messages
- Console warnings when limit hit

## Long-term Solutions

### Option 1: WebSocket (RECOMMENDED)

**Finnhub WebSocket Free Tier:**
- Endpoint: `wss://ws.finnhub.io`
- **50 symbols** supported on free tier (we only need 13)
- **True real-time** tick-by-tick updates
- **No polling** = no rate limit issues
- **Latency:** <100ms vs 10-15 seconds

**Implementation:**
```javascript
const socket = new WebSocket(`wss://ws.finnhub.io?token=${API_KEY}`);

// Subscribe to all 13 stocks
['NVDA', 'TSLA', 'AMD', ...].forEach(ticker => {
    socket.send(JSON.stringify({type: 'subscribe', symbol: ticker}));
});

// Receive real-time updates
socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'trade') {
        updateStockCard(data.s, data.p); // symbol, price
    }
};
```

**Benefits:**
- ✅ Real-time updates (not delayed 15 seconds)
- ✅ No rate limit issues
- ✅ Free tier sufficient
- ✅ Lower latency
- ✅ True momentum capture

**Effort:** 1-2 hours to implement

### Option 2: Upgrade Finnhub API

**Starter Plan: $7.99/month**
- 300 calls/minute (5× free tier)
- Real-time data
- Extended hours coverage (premarket/after-hours)
- 15,000,000 calls/month

**Professional Plan: $59.99/month**
- 600 calls/minute (10× free tier)
- Full market depth
- Websocket + REST
- Premium support

**Benefits:**
- ✅ Immediate fix (no code changes)
- ✅ Premarket/after-hours data
- ✅ Higher reliability
- ❌ Costs money ($8-60/mo)

### Option 3: Alternative Data Providers

**Alpha Vantage (Free)**
- 500 requests/day
- 5 calls/minute
- ❌ Too restrictive for our use case

**Polygon.io**
- Free: 5 calls/minute (too low)
- Basic: $199/month for real-time
- ✅ Excellent data quality
- ❌ Expensive

**IEX Cloud**
- Free: 50,000 messages/month
- Paid: $9/month for 500k messages
- ✅ Affordable
- ✅ Good coverage
- ⚠️ Delayed data on free tier (15 min)

**Yahoo Finance (yfinance)**
- ✅ Free, unlimited
- ✅ No API key needed
- ❌ Unofficial API (could break)
- ❌ Rate limits exist but undocumented
- ⚠️ Terms of service gray area

### Option 4: Hybrid Approach

**Strategy:**
- Use WebSocket for 12 core stocks (real-time, free)
- Use REST API for SPY only (1 call per 15s)
- Total: 4 calls/min (90% under limit)

**Benefits:**
- ✅ Best of both worlds
- ✅ Free tier sufficient
- ✅ Real-time where it matters
- ✅ Fallback to polling if WebSocket fails

## Recommendation: WebSocket Implementation

**Why:**
1. **Free** - no monthly cost
2. **Real-time** - captures momentum immediately
3. **Reliable** - designed for streaming data
4. **Scalable** - can add more stocks if needed
5. **Better UX** - prices update instantly, not every 15s

**Implementation Plan:**

### Phase 1: Basic WebSocket (Week 1)
- [ ] Connect to Finnhub WebSocket
- [ ] Subscribe to 12 stocks + SPY
- [ ] Update card prices on each tick
- [ ] Test during market hours

### Phase 2: Error Handling (Week 1)
- [ ] Reconnect on disconnect
- [ ] Fallback to REST if WebSocket unavailable
- [ ] Rate limit backoff
- [ ] User notification on connection issues

### Phase 3: Optimization (Week 2)
- [ ] Throttle UI updates (max 1 per second per stock)
- [ ] Buffer rapid price changes
- [ ] Add latency monitoring
- [ ] Performance metrics

## Current Status (Temporary Fix)

**Deployed:**
- ✅ Update interval: 15 seconds
- ✅ Rate limit detection
- ✅ Error messages
- ✅ Console logging

**Limitations:**
- ⚠️ Still polling (not real-time)
- ⚠️ 15 second delay
- ⚠️ No premarket/after-hours
- ⚠️ Close to rate limit (52/60 calls)

**Works for now, but WebSocket is strongly recommended.**

## Testing

### Verify Current Fix
```bash
# Wait 1 minute for rate limit to reset, then:
curl "https://finnhub.io/api/v1/quote?symbol=AMZN&token=..."

# Should return:
# {"c":215.6,"d":...} instead of {"error":"API limit reached..."}
```

### Monitor Dashboard
1. Open dashboard: `https://alphatrades.onrender.com`
2. Open console (F12)
3. Watch for:
   - `[HH:MM:SS] Starting update #X...`
   - Price logs every 15 seconds
   - NO "RATE LIMIT HIT" errors

### Verify Rate Limit Math
- 13 calls per update
- 4 updates per minute (15s interval)
- 52 calls/minute
- 60 limit - 52 actual = **8 call buffer** ✅

## Next Steps

### This Week
- [x] Deploy 15 second interval fix
- [ ] Monitor rate limit during market hours
- [ ] Verify no more "Remaining: 0" errors
- [ ] Document WebSocket implementation plan

### Next Week
- [ ] Implement WebSocket connection
- [ ] Test with 1-2 stocks first
- [ ] Rollout to all 13 stocks
- [ ] Remove polling fallback once stable

### Future Enhancements
- [ ] Add connection status indicator
- [ ] Show last tick timestamp
- [ ] Display WebSocket latency
- [ ] Add quality metrics (ticks/sec, avg latency)

## Summary

**Problem:** Exceeded Finnhub free tier rate limit (78/60 calls per minute)

**Temporary Fix:** Reduced update interval to 15 seconds (52/60 calls per minute)

**Permanent Solution:** Migrate to WebSocket for true real-time, no rate limits

**Timeline:** WebSocket implementation ~1-2 days work

**Cost:** $0 (stays on free tier)

---

**Deployed:** 2026-03-05 09:00 CST
**Status:** Temporary fix live, WebSocket planned for next week
