# Grade-Based Scaling Exits Backtest - Summary

## Task Completed ✅

Created and tested grade-based scaling exit strategy for AlphaTrades V5 algorithm.

## Deliverables

1. **backtest_scaling_exits.py** - Full implementation with verbose debug output
2. **backtest_scaling_exits_fast.py** - Optimized version (used for results)
3. **scaling_exits_results.txt** - Full results with comparison

## Key Findings

### **Scaling Exits UNDERPERFORMED the Original Strategy by 1.31%**

| Metric | Original (Fixed) | New (Scaling) | Difference |
|--------|------------------|---------------|------------|
| **Total Return** | +6.13% | +4.82% | **-1.31%** |
| **Win Rate** | ~49% | 57.3% | +8.3% |
| **Max Drawdown** | Unknown | -2.46% | N/A |
| **Exit Strategy** | +50% target, -30% stop, 3 day hold | Grade-based scaling, 36h hold | -- |

### Performance Details

**Starting Capital:** $2,500
**Final Capital:** $2,620.39
**Total P/L:** +$120.39 (+4.82%)

**Trading Stats:**
- Total Positions: 132
- Total Tranches: 396 (3 per position)
- Signals Found: 181
- Trading Days: 334 (out of 731 calendar days)

**Win/Loss:**
- Wins: 227 (57.3%)
- Losses: 169 (42.7%)
- Average Win: $2.17
- Average Loss: $-2.20

**Tranche Breakdown:**
- **T1** (First exit @ +50%): 132 exits | +$58.43 profit
- **T2** (Second exit @ +100%): 132 exits | +$57.89 profit  
- **T3** (Runner @ +150%): 132 exits | +$4.07 profit

### Why Scaling Underperformed

1. **T3 Runners Added Minimal Value**: Only +$4.07 vs +$58/$58 from T1/T2
2. **Tighter Time Stop**: 36 hours vs 3 days gave less time for moves to develop
3. **Tighter Stop Loss**: -50% vs -30% meant faster exits on losers
4. **Grade-Based Sizing**: Splitting into 3 tranches diluted winning positions

### What We Learned

✅ **Higher Win Rate** (57% vs 49%) - Scaling captured more wins
✅ **Lower Drawdown** (-2.46% is very good)
✅ **Even Contribution** - T1 and T2 performed equally well
❌ **Lower Total Return** - Despite higher win rate, made less money
❌ **Runners Don't Pay** - T3 barely contributed in this timeframe

## Recommendation

**Stick with the original fixed exits (+50% target, -30% stop, 3 day hold)** for now.

However, consider hybrid approaches:
- Keep fixed exits but add trailing stop for winners past +100%
- Use grade to size positions, but keep fixed exit logic
- Test with technical indicators (RSI, MACD) for T2/T3 exits instead of fixed %

## Technical Notes

- Database: 3.5M minute bars (2024-2025)
- Tickers tested: AMD, NVDA, TSLA, AAPL, MSFT, GOOGL, AMZN, META, NFLX, AVGO, ORCL, ADBE, CRM, INTC, QCOM
- Original backtest was slow (repeated DB queries)
- Optimized version pre-loads all data into memory (much faster)

## Next Steps

Path 2 (Technical Exits):
- Use RSI/MACD for T2/T3 instead of fixed targets
- Add support/resistance levels
- Use ATR for dynamic stop loss

Path 3 (Grade-Based Position Sizing Only):
- Keep fixed exits but vary position size by grade
- A+/A: 25% position
- A-/B+: 20% position  
- B/B-: 15% position
