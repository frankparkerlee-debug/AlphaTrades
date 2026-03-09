# Live Data Fix Plan - March 9, 2026

## Current Problems

### Backend (Worker)
1. **Fetching ENTIRE options chains** (~1000+ contracts per ticker)
2. Takes 2-5 seconds PER ticker = 30-75 seconds for 15 tickers
3. Worker can't complete full cycle in 2 seconds (falls behind)
4. Big stocks (TSLA, AAPL, MSFT) have HUGE chains → timeout/fail

### Frontend (Dashboard)
1. Full DOM re-render every update (causes flicker)
2. No smooth transitions
3. All cards rebuild from scratch vs. updating values in-place

---

## Solution: Smart Contract Selection + In-Place Updates

### Backend Fix (Worker)

**OLD approach:**
1. Score ticker → get direction
2. Fetch ENTIRE options chain (slow!)
3. Filter 1000+ contracts to find best one
4. Store result

**NEW approach:**
1. Score ticker → get direction (CALL/PUT)
2. Calculate target strike: stock_price ± (0-5%)
3. Calculate target expiration: tomorrow or T+1 (1 DTE preferred)
4. **Fetch ONLY that ONE contract** via Alpaca's specific contract endpoint
5. Store result

**API Efficiency:**
- Old: `GET /v1/options/contracts?underlying=AAPL` (1000+ contracts)
- New: `GET /v1/options/contracts/AAPL260314C00150000` (1 contract)
- 1000x faster, no filtering needed

**Code changes:**
```python
# In worker.py - replace get_options_chain with get_target_contract

def get_target_contract(ticker, stock_price, direction, dte_preference=1):
    """
    Fetch ONE specific contract based on algorithm output
    
    Args:
        ticker: Stock symbol
        stock_price: Current price
        direction: 'CALL' or 'PUT' from V5 scorer
        dte_preference: Days to expiration (1 = default)
    
    Returns:
        Single contract dict or None
    """
    # Calculate ATM strike (round to nearest $5 for most stocks)
    strike_increment = 5 if stock_price > 50 else 1
    target_strike = round(stock_price / strike_increment) * strike_increment
    
    # Calculate expiration (next trading day + dte_preference)
    target_expiration = get_next_trading_day(days_out=dte_preference)
    
    # Build OCC symbol: AAPL260314C00150000
    option_type = 'C' if direction == 'CALL' else 'P'
    occ_symbol = build_occ_symbol(ticker, target_expiration, option_type, target_strike)
    
    # Fetch JUST THIS ONE CONTRACT
    return alpaca.get_option_contract(occ_symbol)
```

---

### Frontend Fix (Dashboard)

**OLD approach:**
```javascript
// Re-render ALL cards on every update
function renderCards() {
    grid.innerHTML = filtered.map(ticker => createCard(ticker, data)).join('');
}
```

**NEW approach:**
```javascript
// Update values IN-PLACE, smooth transitions
function updateCards() {
    filtered.forEach(ticker => {
        const data = scoresCache[ticker];
        const card = document.getElementById(`card-${ticker}`);
        
        if (!card) {
            // Card doesn't exist, create it
            grid.appendChild(createCard(ticker, data));
        } else {
            // Card exists, update values smoothly
            updateCardValues(card, data);
        }
    });
}

function updateCardValues(card, data) {
    // Update price with transition
    const priceEl = card.querySelector('.stock-price');
    if (priceEl.textContent !== `$${data.current_price}`) {
        priceEl.classList.add('updating');
        priceEl.textContent = `$${data.current_price}`;
        setTimeout(() => priceEl.classList.remove('updating'), 300);
    }
    
    // Update score, grade, option price - same pattern
    // Only touch DOM if value actually changed
}
```

**CSS for smooth updates:**
```css
.updating {
    animation: pulse 0.3s ease-in-out;
    color: #00ff00; /* Flash green on update */
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
}
```

---

## Implementation Priority

### Phase 1: Backend (15 min)
1. Create `get_target_contract()` function
2. Replace `get_options_chain()` calls in worker
3. Test with 3 tickers (NVDA, AAPL, TSLA)
4. Deploy

**Expected result:** Worker completes all 15 tickers in < 5 seconds

### Phase 2: Frontend (10 min)
1. Change `renderCards()` to `updateCards()` (in-place updates)
2. Add CSS transitions
3. Only update changed values
4. Deploy

**Expected result:** Smooth updates like Robinhood, no flicker

---

## Success Metrics

- ✅ Worker cycle time: < 5 seconds (vs current 30-75s)
- ✅ All 15 tickers updating every 2 seconds
- ✅ No DOM flicker or re-render jank
- ✅ Smooth price transitions
- ✅ Big stocks (TSLA, AAPL) work reliably

---

## Rollout Plan

1. Code Phase 1 changes
2. Test locally
3. Deploy to GitHub
4. Monitor worker logs (should see faster cycles)
5. Code Phase 2 changes
6. Test frontend in browser
7. Deploy
8. Verify smooth updates on production dashboard
