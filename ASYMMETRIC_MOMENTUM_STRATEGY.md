# Asymmetric Momentum Strategy
## Goal: 50-100%+ Returns on 1-2 Day Options Trades

**Philosophy:** Find explosive momentum setups where multiple signals converge, indicating high probability of continuation. Use short-dated options to capture asymmetric risk/reward.

---

## Signal Components (100 Points Total)

### 1. Price Momentum (25 points) ✅ IMPLEMENTED
**What it measures:** Strength and direction of current move

**Scoring:**
- **25 pts:** Explosive move (>5% intraday)
- **20 pts:** Strong move (3-5%)
- **15 pts:** Moderate move (2-3%)
- **10 pts:** Small move (1-2%)
- **0 pts:** Weak (<1%)

**Why it works:** Large moves attract attention, create FOMO, and tend to continue intraday

**Current implementation:** ✅ Working in `scorer_convergence.py`

---

### 2. Volume Surge (20 points) ⚠️ NEEDS IMPLEMENTATION
**What it measures:** Unusual volume vs historical average

**Data needed:**
- Current volume vs 20-day average
- Volume distribution throughout the day
- Large block trades

**Scoring:**
- **20 pts:** Extreme volume surge (>300% of average)
- **16 pts:** High volume (200-300%)
- **12 pts:** Above average (150-200%)
- **8 pts:** Normal (100-150%)
- **4 pts:** Below average (<100%)
- **0 pts:** Very low (<50%)

**Why it works:** Volume confirms momentum. High volume = institutional interest = more fuel

**Implementation plan:**
```python
def _score_volume(self, ticker, quote_data):
    # Get 20-day average volume via Alpaca bars
    bars = alpaca.get_bars(ticker, timeframe='1Day', limit=20)
    avg_volume = sum(bar['v'] for bar in bars) / len(bars)
    current_volume = quote_data.get('v', 0)
    
    if avg_volume == 0:
        return {'score': 0, 'status': '⚠️', 'reason': 'No volume history'}
    
    volume_ratio = (current_volume / avg_volume) * 100
    
    if volume_ratio >= 300:
        score = 20
        reason = f"Extreme volume surge ({volume_ratio:.0f}% avg)"
    elif volume_ratio >= 200:
        score = 16
        reason = f"High volume ({volume_ratio:.0f}% avg)"
    # ... etc
```

---

### 3. Trend Analysis (20 points) ⚠️ NEW
**What it measures:** Is the stock in a strong trend?

**Data needed:**
- 9 EMA vs 21 EMA (fast trend)
- 50 SMA vs 200 SMA (long-term trend)
- ADX (trend strength indicator)
- Higher highs & higher lows pattern

**Scoring:**
- **20 pts:** Strong uptrend (9>21, 50>200, ADX>25, price above both EMAs)
- **16 pts:** Uptrend (9>21, price above 9 EMA)
- **12 pts:** Weak uptrend (choppy but positive bias)
- **8 pts:** Neutral (no clear trend)
- **4 pts:** Downtrend (inverse of uptrend)
- **0 pts:** Strong downtrend

**Why it works:** Momentum trades work best when aligned with the trend. Don't fight the tape.

**Implementation plan:**
```python
def _score_trend(self, ticker, quote_data):
    # Get 50 bars (1-hour timeframe) for EMAs
    bars = alpaca.get_bars(ticker, timeframe='1Hour', limit=50)
    
    closes = [bar['c'] for bar in bars]
    current_price = quote_data.get('c', 0)
    
    ema9 = calculate_ema(closes, 9)
    ema21 = calculate_ema(closes, 21)
    sma50 = calculate_sma(closes, 50)
    
    # ADX calculation (uses highs/lows/closes)
    adx = calculate_adx(bars, period=14)
    
    score = 0
    if ema9 > ema21 and current_price > ema9:
        score += 10  # Fast trend aligned
    if current_price > sma50:
        score += 5   # Above medium-term average
    if adx > 25:
        score += 5   # Strong trend (not choppy)
    
    # Check for higher highs pattern
    recent_highs = [bar['h'] for bar in bars[-5:]]
    if recent_highs[-1] > max(recent_highs[:-1]):
        score += 0  # Making new highs
```

---

### 4. Technical Indicators (15 points) ⚠️ NEW
**What it measures:** Oversold/overbought, momentum acceleration

**Data needed:**
- RSI (14-period)
- MACD histogram (momentum acceleration)
- Bollinger Bands (volatility expansion)

**Scoring:**
- **15 pts:** Perfect setup (RSI 50-70, MACD positive & rising, price at upper BB)
- **12 pts:** Good setup (RSI 40-80, MACD positive)
- **8 pts:** Okay setup (RSI neutral, MACD crossed up)
- **4 pts:** Weak setup (RSI extreme, MACD flat)
- **0 pts:** Poor setup (RSI overbought >80 or oversold <20)

**Why it works:** Confirms momentum isn't exhausted. Want RSI in the "sweet spot" (not too hot, not too cold).

**Implementation plan:**
```python
def _score_technicals(self, ticker, quote_data):
    # Get 50 bars for indicator calculations
    bars = alpaca.get_bars(ticker, timeframe='1Hour', limit=50)
    
    closes = [bar['c'] for bar in bars]
    highs = [bar['h'] for bar in bars]
    lows = [bar['l'] for bar in bars]
    
    rsi = calculate_rsi(closes, period=14)
    macd_line, signal_line, histogram = calculate_macd(closes)
    bb_upper, bb_middle, bb_lower = calculate_bollinger_bands(closes)
    
    current_price = quote_data.get('c', 0)
    
    score = 0
    
    # RSI scoring (want 50-70 for uptrend, 30-50 for reversal)
    if 50 <= rsi <= 70:
        score += 6  # Sweet spot
    elif 40 <= rsi < 50 or 70 < rsi <= 80:
        score += 4  # Acceptable
    elif rsi > 80 or rsi < 30:
        score += 0  # Extreme (overbought/oversold)
    
    # MACD scoring (want positive momentum)
    if histogram[-1] > 0 and histogram[-1] > histogram[-2]:
        score += 5  # Positive and accelerating
    elif histogram[-1] > 0:
        score += 3  # Positive but slowing
    
    # Bollinger Band scoring (volatility expansion)
    if current_price > bb_middle:
        score += 4  # Above middle (bullish)
```

---

### 5. News & Catalysts (15 points) ✅ IMPLEMENTED
**What it measures:** Breaking news, announcements, catalysts

**Current implementation:** Already working in `scorer_convergence.py`

**Scoring:**
- **15 pts:** Breaking news <2h ago with catalyst keywords
- **12 pts:** Recent news <6h with multiple articles
- **8 pts:** News <24h
- **4 pts:** Older news
- **0 pts:** No news

**Why it works:** News creates volatility and directional moves. Fresh catalysts = explosive moves.

---

### 6. Sentiment (10 points) ✅ IMPLEMENTED
**What it measures:** Social sentiment from StockTwits

**Current implementation:** Already working

**Scoring:**
- **10 pts:** Very bullish (>70%)
- **8 pts:** Bullish (60-70%)
- **5 pts:** Slightly bullish (50-60%)
- **2 pts:** Mixed or bearish

**Why it works:** Social sentiment correlates with retail flow, which can drive short-term moves.

---

### 7. Market Alignment (10 points) ✅ IMPLEMENTED
**What it measures:** Outperformance vs SPY

**Current implementation:** Already working

**Scoring:**
- **10 pts:** Strong outperformance (+3% vs SPY)
- **7 pts:** Outperformance (+1-3%)
- **5 pts:** Slight outperformance (0-1%)
- **2 pts:** Underperformance

**Why it works:** Relative strength = smart money accumulation. Best trades outperform the market.

---

## Convergence Scoring

**Total Possible:** 100 points

**Grading Scale:**
- **A+ (90-100):** STRONG BUY - All signals aligned, extremely high probability
- **A (85-89):** BUY - Most signals aligned
- **A- (80-84):** BUY - Strong setup
- **B+ (75-79):** CONSIDER - Good setup, moderate conviction
- **B (70-74):** CONSIDER - Decent setup
- **B- (65-69):** WATCH - Some signals, lower conviction
- **C+ (60-64):** WATCH - Mixed signals
- **Below 60:** PASS - Not enough convergence

**Auto-trade threshold:** A- or better (80+) AND 4+ signals converged

---

## Options Selection Strategy

**Goal:** Maximize asymmetric returns (risk $1 to make $2-5)

**Contract Selection Criteria:**
1. **DTE:** 1-3 days (short duration = less theta decay, captures immediate move)
2. **Strike:** 2-5% OTM (not too far, not ATM - sweet spot for leverage)
3. **Delta:** 0.40-0.60 (good leverage without being lottery ticket)
4. **IV Percentile:** 25-80% (not too low = cheap, not too high = expensive)
5. **Open Interest:** >100 contracts (liquidity)
6. **Volume:** >10 contracts today (active)
7. **Bid/Ask Spread:** <15% (tight spread = fair pricing)

**Already implemented in `options_selector.py`** ✅

---

## Risk Management

**Entry:**
- Only trade A-/A/A+ grades (80+ score)
- Only trade when 4+ signals converged
- Position size: 20% of capital per trade

**Exit Rules:**
1. **Time-based:** Close at end of Day 2 (no overnight risk past 2 days)
2. **Profit target:** +50% (take profits, let winners run to +100%)
3. **Stop loss:** -30% (cut losers fast)
4. **Market close:** Close all positions by 3:45pm on Friday

---

## Backtest Targets

**Win Rate:** 50-60% (high enough for asymmetric R:R)
**Average Win:** +60-80% per contract
**Average Loss:** -25-30% per contract
**R:R Ratio:** 2:1 minimum
**Expected Value:** Positive over 100+ trades

---

## Implementation Priority

### Phase 1: Complete Signal Scoring (THIS WEEK)
1. ✅ Momentum (done)
2. ⚠️ Volume surge (implement)
3. ⚠️ Trend analysis (implement)
4. ⚠️ Technical indicators (implement RSI, MACD, Bollinger Bands)
5. ✅ News (done)
6. ✅ Sentiment (done)
7. ✅ Market alignment (done)

### Phase 2: Backtest & Tune (NEXT WEEK)
- Run strategy on historical data (last 6 months)
- Optimize thresholds for each signal
- Validate 50%+ win rate and 2:1 R:R
- Adjust scoring weights if needed

### Phase 3: Auto-Trading (WEEK 3)
- Build paper trading agent
- Execute A+/A/A- signals automatically
- Track performance vs manual
- Go live with real money when validated

---

## Why This Works

**Multiple Confirmation:** Single indicators fail. Multiple signals converging = high conviction.

**Asymmetric Structure:** Options give 3-5x leverage. A 5% stock move = 30-50% option gain.

**Short Duration:** 1-2 day holds avoid overnight gaps and earnings surprises.

**Momentum + Catalysts:** Momentum without news = fades. News without momentum = ignored. Together = explosive.

**Data-Driven:** Every signal is measurable, backtestable, and optimizable.

---

## Next Steps

1. Implement volume surge detection
2. Implement trend analysis (EMAs, ADX)
3. Implement technical indicators (RSI, MACD, BB)
4. Update convergence scorer with new signals
5. Backtest on historical data
6. Tune thresholds for asymmetric returns
7. Deploy to production
