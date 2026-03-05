# Strategy 1: Correct Implementation

## Core Principle
**Strategy 1 is a MOMENTUM strategy** - we ride the direction of movement, not both sides.

## Fundamental Rules

### 1. **ONE Direction Per Stock**
- If stock is moving UP → Show CALL opportunity
- If stock is moving DOWN → Show PUT opportunity  
- **NEVER show both at the same time**

### 2. **Scoring Algorithm**

Based on scorer.py, the scoring is:

```python
# Step 1: Calculate absolute move from OPEN (not previous close)
move_from_open = abs((current - open_price) / open_price * 100)
range_pct = (high - low) / open_price * 100

# Step 2: Score components
momentum_score = score_momentum(move_from_open)  # 0-25 points
range_score = score_range(range_pct)              # 0-15 points
volume_score = 5                                   # Fixed 5 points
market_score = 10 if SPY_is_up else 0            # 0 or 10 points

total_score = momentum + range + volume + market  # Max 55 points

# Step 3: Determine direction
direction = 'CALL' if current > open_price else 'PUT'

# Step 4: Assign grade
if score >= 50: grade = 'A+'
if score >= 47: grade = 'A'
if score >= 45: grade = 'A-'
...
```

### 3. **Momentum Scoring Thresholds**
```
Absolute Move | Points
≥ 3.0%       | 25
≥ 2.0%       | 20
≥ 1.5%       | 15
≥ 1.0%       | 10
< 1.0%       | 0
```

### 4. **Range Scoring Thresholds**
```
Range %  | Points
≥ 3.0%   | 15
≥ 2.0%   | 10
≥ 1.5%   | 5
< 1.5%   | 0
```

### 5. **Market Component**
- Fetch SPY quote
- If SPY.current >= SPY.previous_close → 10 points
- If SPY.current < SPY.previous_close → 0 points

## Why Calls and Puts Can't Both Be A+

**Example Scenario:**
- NVDA opens at $800
- Currently at $824 (+3% move from open)

**Scoring:**
- Momentum: 25 points (3%+ absolute move)
- Range: 15 points (assume 3%+ range)
- Volume: 5 points
- Market: 10 points (SPY up)
- **Total: 55 points → A+ grade**

**Direction:** CALL (because $824 > $800)

**Why not PUT?**
The PUT opportunity is the OPPOSITE direction. If the stock is moving up strongly (A+ momentum), the PUT is AGAINST the momentum, which violates Strategy 1's core principle: "Ride the momentum."

**Result:** Show CALL A+ only. No PUT card.

---

**If stock was DOWN:**
- NVDA opens at $800
- Currently at $776 (-3% move from open)
- Same scoring: 55 points → A+
- Direction: PUT (because $776 < $800)
- **Result:** Show PUT A+ only. No CALL card.

## Dashboard Implementation

### Stock Card Display

**Each card shows:**
1. Ticker and current price
2. Price change from previous close (visual indicator)
3. **ONE opportunity badge** (📈 CALL or 📉 PUT)
4. Grade (A+ through D)
5. Strike price and DTE
6. Entry price per contract
7. Risk/Reward boxes (Stop -30%, Target +50%)

**Card border color:**
- Green border → CALL opportunity
- Red border → PUT opportunity

### Example Cards

**NVDA (Bullish Momentum):**
```
┌─────────────────────┐
│ NVDA       $824.50  │  ← Green border
│            ▲ 1.20%  │
├─────────────────────┤
│ 📈 CALL             │
│       A+            │
│ Strike: $825 (7D)   │
│ Entry: $24.74/cont. │
│ Score: 55/55        │
│                     │
│ STOP -30%│TARGET +50%│
│  $17.32  │  $37.11   │
└─────────────────────┘
```

**TSLA (Bearish Momentum):**
```
┌─────────────────────┐
│ TSLA       $198.30  │  ← Red border
│            ▼ 2.80%  │
├─────────────────────┤
│ 📉 PUT              │
│       B+            │
│ Strike: $200 (7D)   │
│ Entry: $5.95/cont.  │
│ Score: 42/55        │
│                     │
│ STOP -30%│TARGET +50%│
│  $4.17   │  $8.93    │
└─────────────────────┘
```

## What Was Wrong Before

### ❌ Previous Implementation
```javascript
// WRONG: Showed both call and put with same score
const callResult = scorer.calculate(quote, spyTrend);
const putResult = scorer.calculate(quote, spyTrend);

// Result: Both showed A+, A+ or B-, B- (impossible!)
```

### ✅ Correct Implementation
```javascript
// RIGHT: Calculate once, show one direction
const result = scorer.calculate(quote, spyTrend);

// Result.direction is 'CALL' or 'PUT' (one only)
// Show card with border color matching direction
```

## Trade Execution

When user clicks a card, they see:

1. **Direction confirmed:** 📈 CALL or 📉 PUT
2. **Scoring breakdown:**
   - Momentum: X/25 (from absolute move)
   - Range: X/15
   - Volume: 5/5
   - Market: X/10 (SPY trend)
   - Total: X/55 → Grade

3. **Execution details:**
   - Strike: ATM (at-the-money)
   - Entry price: Estimated per contract
   - Stop loss: -30% from entry
   - Target: +50% from entry
   - Expiry: Next Friday

4. **Strategy 1 rules reminder**

## Key Validation Points

### ✅ Correct Scoring
- [x] Uses open price (not previous close)
- [x] Absolute move for momentum scoring
- [x] Correct thresholds: 3%/2%/1.5%/1%
- [x] Range max: 15 points
- [x] Volume: 5 points fixed
- [x] Market: 10 points if SPY up
- [x] Max total: 55 points

### ✅ Correct Direction Logic
- [x] ONE direction per stock
- [x] CALL if current > open
- [x] PUT if current < open
- [x] Direction reflects momentum, not both sides

### ✅ Correct Display
- [x] Card shows one opportunity (not two)
- [x] Border color matches direction
- [x] Grade is for that specific direction
- [x] Trade details (entry/stop/target) shown
- [x] Risk/reward (1.67:1) visually prominent

## Testing Checklist

### Verify Strategy 1 Alignment
1. Load dashboard
2. Pick a stock moving up (e.g., NVDA +2%)
3. Should show: 📈 CALL card with green border
4. Should NOT show: PUT card
5. Click card → verify scoring uses open price
6. Check momentum score matches move from open

### Verify Opposite Direction
1. Pick a stock moving down (e.g., TSLA -2%)
2. Should show: 📉 PUT card with red border
3. Should NOT show: CALL card

### Verify Scoring Components
1. Click any card
2. Check momentum + range + volume + market = total score
3. Verify momentum uses absolute value
4. Verify market component reflects SPY trend

## Summary

**Strategy 1 = Momentum Strategy**
- ONE direction per stock (the direction of momentum)
- Score based on magnitude of move (absolute value)
- Direction determined by current vs open
- NEVER show both call and put with same high grade

**The fix:**
- Removed dual option display
- Calculate score once
- Show only the directional opportunity
- Made cards more compact (10-12 fit on screen)
- Fixed error handling (no error on every refresh)

---

**Status:** Correctly implemented and deployed
