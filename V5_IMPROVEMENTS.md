# V5 Improvements - March 7, 2026

## Issues Fixed:

### 1. Backtest Using Intraday Data
**Problem:** Original backtest used daily 1D bars, which missed intraday momentum moves
**Solution:** New `backtest_v5_intraday.py` uses 5-minute bars from Alpaca API
- Captures real intraday 2%+ moves that V5 strategy is designed for
- Tests last 30 trading days (limited by Alpaca intraday data availability)
- Realistic entry/exit simulation with proper timing

### 2. Stop Loss: 35%
**Added:** Fixed 35% stop loss on all positions
- Prevents catastrophic losses
- Stops out at -35% from entry price

### 3. Dynamic Trailing Stops
**Problem:** Static trailing stops leave money on the table
**Solution:** Momentum-based trailing stops that tighten as profit grows

**Trailing Stop Levels:**
- At +5% profit → trail at -30% from peak
- At +10% profit → trail at -20% from peak
- At +15% profit → trail at -15% from peak
- At +20% profit → trail at -10% from peak
- At +30% profit → trail at -5% from peak

**Result:** Locks in more profit as position moves in your favor

### 4. Proportional Scale-Out
**Problem:** All-or-nothing exits miss optimal profit taking
**Solution:** Scale out at key profit levels

**Scale-Out Levels:**
- At +15% profit → sell 1/3 of position
- At +30% profit → sell 1/2 of remaining position
- At +50% profit → sell all remaining

**Result:** Takes profits incrementally while letting winners run

### 5. Options Display Fix
**Problem:** Only Microsoft showed options recommendations
**Solution:** Updated `scorer_v5.py` to always calculate options for all tickers
- Fixed null check on current price
- Dynamic targets based on intraday range
- Proper ATM/OTM strike calculations for all price ranges

---

## New Backtest Features:

### Intraday Bar Testing
- Uses Alpaca 5-minute bars
- Tests last 30 trading days (Alpaca intraday limit)
- Real entry/exit timing (not EOD approximations)

### Exit Simulation
- Tracks price through every 5-min bar after entry
- Checks stops, scale-outs, trailing stops at each bar
- Realistic P&L calculation including partial exits

### Trading Rules Enforced
✅ No trading first 15 minutes (9:30-9:45 AM)
✅ No holding over earnings (±3 days)
✅ No same-day trading after fed announcements
✅ 35% stop loss
✅ Dynamic trailing stops
✅ Scale-out at profit targets
✅ Same-day exit (EOD close)

---

## Backtest Output:

### Metrics Tracked:
- Total trades
- Win rate
- Total P/L
- Profit factor
- Trades per day
- Average win/loss
- Per-ticker breakdown

### Sample Trade Data:
```
{
  "ticker": "AMD",
  "date": "2026-03-07",
  "entry_time": "10:15",
  "exit_time": "14:30",
  "exit_reason": "SCALE_OUT_COMPLETE",
  "score": 85,
  "grade": "A",
  "direction": "CALL",
  "entry": 142.50,
  "exit": 145.20,
  "max_price": 145.80,
  "pnl_pct": 1.89,
  "pnl": 18.95,
  "position_scaled": 1.0
}
```

---

## Running the Backtest:

```bash
cd /tmp/AlphaTrades
python3 backtest_v5_intraday.py
```

### Expected Output:
- Tests 5 tickers: AMD, NVDA, TSLA, AAPL, MSFT
- Tests 30 trading days
- Compares thresholds: B+ (75), A- (80), A (85)
- Generates `v5_intraday_results.json`

### Timeline:
- ~2-3 minutes to run (API rate limiting)
- Tests ~150 ticker-days (5 tickers × 30 days)

---

## Next Steps:

1. **Review backtest results** when complete
2. **If win rate ≥75% and profit factor ≥1.2:**
   - Deploy with confidence
   - Start paper trading Monday
   
3. **If results below target:**
   - Adjust score thresholds (try A- or A only)
   - Tweak trailing stop levels
   - Test different scale-out percentages

---

## File Changes:

- `backtest_v5_intraday.py` - NEW: Intraday backtest engine
- `scorer_v5.py` - UPDATED: 35% stops, dynamic targets, options fix
- `templates/v5_pro.html` - Already deployed (professional UI)

---

**Status:** Backtest running now, results in ~3 minutes
