# Live Price Data - Technical Notes

## Current Implementation

### Data Source: Finnhub Quote API
- **Endpoint:** `https://finnhub.io/api/v1/quote?symbol={ticker}`
- **Update Frequency:** Every 5 seconds (client-side polling)
- **Data Fields:**
  - `c` - Current price (last trade)
  - `o` - Open price of the day
  - `h` - High price of the day
  - `l` - Low price of the day
  - `pc` - Previous close price
  - `t` - Timestamp (Unix seconds)

### Market Hours Coverage
- **Regular Trading:** 9:30 AM - 4:00 PM EST ✅ Real-time
- **Pre-market:** 4:00 AM - 9:30 AM EST ⚠️ May be delayed
- **After-hours:** 4:00 PM - 8:00 PM EST ⚠️ May be delayed
- **Closed:** Outside trading hours ❌ Shows previous close

## Price Discrepancy Example (AMZN)

**User Report:** AMZN showing 216.82 on dashboard, but premarket is 215.6

**Possible Causes:**

### 1. **Premarket Data Not Included**
Finnhub's `/quote` endpoint may not update during premarket hours on the free tier or basic API key.

**Solution Options:**
- Upgrade Finnhub subscription for premarket coverage
- Switch to `/stock/candle` endpoint with `1` minute resolution during premarket
- Add WebSocket connection for true real-time data

### 2. **Caching or Rate Limiting**
If hitting Finnhub's rate limit (60 calls/min free tier), the API might return cached data.

**Current Usage:**
- 12 stocks × 1 SPY = 13 calls per update
- Every 5 seconds = ~156 calls/minute
- **⚠️ EXCEEDS FREE TIER LIMIT**

**Solution:**
- Increase interval to 10 seconds (78 calls/min - still close)
- Increase interval to 15 seconds (52 calls/min - safe)
- Batch requests if API supports it
- Upgrade API plan

### 3. **Using Wrong Price Field**
The dashboard currently uses `quote.c` (current price), which should be correct.

**Verification:**
Added console logging: `${ticker}: Current=${data.c}, Open=${data.o}, PC=${data.pc}`

Check browser console to see which field Finnhub is returning.

## Improvements Made

### 1. ✅ **Fixed Grid Layout**
- Changed from `repeat(auto-fill, minmax(240px, 1fr))` to `repeat(3, 1fr)`
- Result: Exactly 4 rows × 3 columns = 12 cards

### 2. ✅ **Added Market Hours Warning**
```
⚠️ Market Hours: Prices update every 5 seconds during regular trading 
(9:30 AM - 4:00 PM EST). Pre-market and after-hours prices may not be reflected.
```

### 3. ✅ **Added Price Timestamp**
Each card now shows: `Updated: 8:15:23 AM`
- Uses Finnhub's timestamp (`t` field)
- Helps users verify data freshness

### 4. ✅ **Added Debug Logging**
Console logs each price fetch with current/open/previous close values
- Helps diagnose which field is being used
- Can verify if data is stale

## Recommended Solutions

### Short-term (Free Tier)
1. **Increase update interval to 15 seconds**
   - Stays under rate limit (52 calls/min vs 60 limit)
   - Still "near real-time" for momentum strategy
   
2. **Add rate limit handling**
   - Catch 429 errors
   - Back off gracefully
   - Show warning to user

3. **Display data staleness**
   - If timestamp is >1 minute old, show warning icon
   - Change card background to yellow if stale

### Medium-term (Better Coverage)
1. **Upgrade Finnhub API**
   - Premium plan includes premarket/after-hours
   - Higher rate limits (300-600 calls/min)
   - WebSocket support for true real-time

2. **Switch to WebSocket**
   - `wss://ws.finnhub.io`
   - True real-time updates (no polling)
   - More efficient (one connection for all stocks)
   - Free tier: 50 symbols/connection

3. **Hybrid Approach**
   - WebSocket for 12 stocks during market hours
   - Polling fallback when WebSocket unavailable
   - Best of both worlds

### Long-term (Production)
1. **Alpha Vantage** or **Polygon.io**
   - More reliable premarket data
   - Better rate limits
   - Historical data for backtesting

2. **Direct Exchange Feeds**
   - IEX Cloud (real-time)
   - NASDAQ Data Link
   - Most expensive but most reliable

## Implementation Plan

### Phase 1: Quick Fix (Today)
- [x] Fix grid to 4×3
- [x] Add market hours warning
- [x] Add timestamp to cards
- [x] Add debug logging
- [ ] Increase update interval to 15s (next commit)

### Phase 2: Rate Limit Safety (This Week)
- [ ] Implement exponential backoff on 429 errors
- [ ] Add visual indicator for stale data
- [ ] Log rate limit hits to understand pattern

### Phase 3: Real-Time Upgrade (Next Week)
- [ ] Test Finnhub WebSocket with 12 stocks
- [ ] Implement WebSocket fallback to polling
- [ ] Verify premarket/after-hours coverage
- [ ] Consider API upgrade if needed

## Testing

### Verify Live Prices
1. Open dashboard during market hours (9:30 AM - 4:00 PM EST)
2. Open browser console (F12)
3. Watch for: `AMZN: Current=215.6, Open=216.82, PC=216.50, Time=...`
4. Compare to real-time quote from Yahoo Finance or TradingView
5. If discrepancy >$0.50, investigate further

### Verify Update Frequency
1. Watch a volatile stock (e.g., TSLA, NVDA)
2. Should see price flash animation every 5 seconds
3. Timestamp should update every 5 seconds
4. If frozen >30 seconds, check console for errors

### Verify Grid Layout
1. Should see exactly 12 cards in 4 rows × 3 columns
2. No scrolling needed to see all cards
3. Cards should resize proportionally on window resize

## Current Status

✅ Grid layout fixed (4×3)
✅ Market hours warning added
✅ Timestamp display added
✅ Debug logging added

⚠️ Still polling (rate limit risk)
⚠️ Premarket data may be delayed
⚠️ No error handling for 429 responses

**Next Action:** Increase update interval to 15s and add rate limit handling.

---

**Note:** If AMZN continues showing 216.82 vs 215.6 during premarket tomorrow, we need to upgrade to Finnhub paid plan or switch to WebSocket for premarket coverage.
