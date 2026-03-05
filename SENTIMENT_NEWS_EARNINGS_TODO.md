# TODO: Add Sentiment, News, and Earnings to Scoring

## Current Limitation

Strategy 1 currently scores based on:
- **Momentum:** Move from open (25 pts max)
- **Range:** Daily high-low % (15 pts max)
- **Volume:** Fixed 5 pts
- **Market:** SPY trend (0 or 10 pts)

**Missing:**
- ❌ Social sentiment (Twitter, Reddit, StockTwits)
- ❌ News events (breaking news, analyst ratings)
- ❌ Earnings reports (upcoming, recent beats/misses)
- ❌ Options flow (unusual activity)
- ❌ Institutional activity (whale trades)

## Proposed: Strategy 2 (Sentiment-Enhanced)

### New Components to Add

**1. News Sentiment (0-15 pts)**
- Finnhub News API: `/news?symbol={ticker}`
- Sentiment analysis of recent headlines (last 24h)
- Scoring:
  - Very positive (3+ positive articles): +15 pts
  - Positive (1-2 positive): +10 pts
  - Neutral: +5 pts
  - Negative: 0 pts

**2. Earnings Impact (0-10 pts)**
- Finnhub Earnings Calendar: `/calendar/earnings`
- Check if earnings is today/tomorrow
- Check if recent beat (last 3 days)
- Scoring:
  - Earnings beat in last 3 days: +10 pts
  - Earnings upcoming (today/tomorrow): +5 pts
  - No earnings: 0 pts

**3. Social Sentiment (0-10 pts)**
- Finnhub Social Sentiment: `/stock/social-sentiment?symbol={ticker}`
- Reddit + Twitter mentions/sentiment
- Scoring:
  - Very high positive sentiment: +10 pts
  - High positive: +7 pts
  - Moderate: +5 pts
  - Low/negative: 0 pts

### Updated Scoring

**Total: 100 points max (vs current 55)**

| Component | Current | Strategy 2 |
|-----------|---------|------------|
| Momentum | 25 | 25 |
| Range | 15 | 15 |
| Volume | 5 | 10 |
| Market | 10 | 10 |
| **News** | **0** | **15** |
| **Earnings** | **0** | **10** |
| **Social** | **0** | **10** |
| **Options Flow** | **0** | **5** |
| **Total** | **55** | **100** |

### New Grade Thresholds

**Strategy 2 Thresholds:**
- A+: 85-100 pts
- A: 75-84 pts
- A-: 70-74 pts
- B+: 65-69 pts
- B: 60-64 pts
- B-: 55-59 pts
- C+: 50-54 pts
- C: 45-49 pts
- C-: 40-44 pts
- D: <40 pts

## Implementation Plan

### Phase 1: Research APIs (1 day)
- [x] Finnhub has news sentiment API
- [x] Finnhub has earnings calendar API
- [x] Finnhub has social sentiment API
- [ ] Test API endpoints
- [ ] Verify rate limits (free tier)

### Phase 2: Build Sentiment Scorer (2 days)
- [ ] Create `sentiment_scorer.py`
- [ ] Add news sentiment analyzer
- [ ] Add earnings calendar checker
- [ ] Add social sentiment aggregator
- [ ] Test with sample data

### Phase 3: Integrate into Dashboard (1 day)
- [ ] Add sentiment components to card display
- [ ] Show news headlines on detail modal
- [ ] Show earnings date if upcoming
- [ ] Show social sentiment score

### Phase 4: Backtest Strategy 2 (1 day)
- [ ] Run backtest with sentiment data
- [ ] Compare Strategy 1 vs Strategy 2 results
- [ ] Validate sentiment adds value
- [ ] Adjust thresholds if needed

### Phase 5: Deploy (1 day)
- [ ] Add toggle: Strategy 1 vs Strategy 2
- [ ] Update worker to score both strategies
- [ ] Update dashboard to show both grades
- [ ] Monitor performance

## Finnhub API Endpoints

### News Sentiment
```
GET /news?symbol={ticker}&from={date}&to={date}
```
Returns: Array of news articles with:
- headline
- summary
- url
- datetime
- source
- sentiment (if available)

### Earnings Calendar
```
GET /calendar/earnings?from={date}&to={date}&symbol={ticker}
```
Returns:
- date
- epsActual
- epsEstimate
- revenueActual
- revenueEstimate

### Social Sentiment
```
GET /stock/social-sentiment?symbol={ticker}&from={date}&to={date}
```
Returns:
- reddit (mention, score, sentiment)
- twitter (mention, score, sentiment)
- atTime (timestamp)

## Example: Enhanced Card Display

**Before (Strategy 1):**
```
NVDA               $824.50
                   ▲ 1.20%
📈 CALL
      A+
Strike: $825 (7D)
Entry: $24.74/contract
Score: 55/55
```

**After (Strategy 2):**
```
NVDA               $824.50
                   ▲ 1.20%
📈 CALL
      A+          S2: A+
Strike: $825 (7D)
Entry: $24.74/contract
Score: 55/55 (S1) | 87/100 (S2)

📰 News: Positive (3 articles)
📊 Earnings: Beat 2 days ago (+8%)
💬 Social: High buzz (Reddit +12k)
```

## Considerations

### Rate Limits
- Free tier: 60 calls/min
- Current usage: 13 stocks × 6 updates/min = 78 calls/min (already over!)
- Adding news/social/earnings: +39 calls per update
- **Total:** 13 + 13 + 13 + 13 = 52 calls/update × 6/min = **312 calls/min**
- **Need:** Paid plan OR reduce update frequency to 1 min intervals

### Solution Options

**Option 1: Reduce Update Frequency**
- Update Strategy 1 every 10s (momentum/price)
- Update Strategy 2 every 60s (sentiment/news)
- Keeps free tier viable

**Option 2: Upgrade Finnhub**
- Starter plan: $7.99/mo = 300 calls/min
- Professional: $59.99/mo = 600 calls/min
- Enterprise: Custom pricing

**Option 3: Cache Sentiment Data**
- News/sentiment doesn't change every 10s
- Fetch once per minute, cache results
- Only momentum/price updates every 10s
- Reduces API calls significantly

### Recommended Approach

**Hybrid Model:**
1. **Fast updates (10s):** Strategy 1 only (momentum-based)
2. **Slow updates (60s):** Strategy 2 with sentiment/news
3. **Cache:** News/sentiment/earnings (5 min TTL)
4. **Display:** Show both strategies side-by-side

**Benefits:**
- Stays under free tier rate limit
- Best of both worlds (fast + comprehensive)
- User can choose which strategy to follow
- Validates if sentiment actually helps

## Next Steps

1. **User approval:** Does Parker want Strategy 2?
2. **API testing:** Verify Finnhub endpoints work
3. **Build prototype:** Test sentiment scoring on 1-2 stocks
4. **Backtest:** Does sentiment improve returns?
5. **Deploy:** Add as optional enhancement

---

**Priority:** Medium (Strategy 1 is profitable without sentiment)
**Effort:** ~5 days development + testing
**Value:** Potentially higher win rate + better entry timing
