# Strategy 2 Backtest Report
**Generated:** March 05, 2026 at 08:59 AM

## Executive Summary

**Recommendation:** KEEP STRATEGY 1
**Confidence:** HIGH
**Reasoning:** Strategy 2 does not show improvement over Strategy 1. Additional sentiment data may not be worth the complexity.

### Key Findings

- Strategy 2 outperformed in **2/7** test periods
- Average return improvement: **-5.06%**
- Average win rate improvement: **-3.53%**

## Performance Comparison

### Returns by Period

| Period | Strategy 1 | Strategy 2 | Improvement | Winner |
|--------|-----------|-----------|-------------|--------|
| 30d | 52.89% | 48.24% | -4.65% | S1 |
| 45d | 44.42% | 40.57% | -3.85% | S1 |
| 60d | 42.04% | 41.78% | -0.26% | S1 |
| 75d | 45.20% | 50.55% | +5.35% | **S2** |
| 90d | 45.01% | 45.60% | +0.59% | **S2** |
| 120d | 38.74% | 37.48% | -1.26% | S1 |
| 365d | 61.61% | 30.24% | -31.37% | S1 |
| **AVERAGE** | **47.13%** | **42.07%** | **-5.06%** | - |

### Win Rate Comparison

| Period | Strategy 1 | Strategy 2 | Improvement | Winner |
|--------|-----------|-----------|-------------|--------|
| 30d | 60.00% | 40.00% | -20.00% | S1 |
| 45d | 47.62% | 44.44% | -3.18% | S1 |
| 60d | 48.15% | 50.00% | +1.85% | **S2** |
| 75d | 51.61% | 56.52% | +4.91% | **S2** |
| 90d | 51.35% | 50.00% | -1.35% | S1 |
| 120d | 46.15% | 45.45% | -0.70% | S1 |
| 365d | 53.21% | 47.00% | -6.21% | S1 |
| **AVERAGE** | **51.16%** | **47.63%** | **-3.53%** | - |

### Risk-Adjusted Metrics

| Period | S1 Sharpe | S2 Sharpe | S1 Max DD | S2 Max DD |
|--------|-----------|-----------|-----------|-----------|
| 30d | 0.00 | 0.00 | 0.00% | 0.00% |
| 45d | 0.00 | 0.00 | 0.00% | 0.00% |
| 60d | 0.00 | 0.00 | 0.00% | 0.00% |
| 75d | 0.00 | 0.00 | 0.00% | 0.00% |
| 90d | 0.00 | 0.00 | 0.00% | 0.00% |
| 120d | 0.00 | 0.00 | 0.00% | 0.00% |
| 365d | 0.00 | 0.00 | 0.00% | 0.00% |

## NFLX & AMZN Deep Dive

Parker mentioned 100%+ wins on NFLX and AMZN using sentiment. Here's what the data shows:

### NFLX

| Period | Strategy | Trades | Win Rate | Avg Return | Best Trade |
|--------|---------|--------|----------|------------|-----------|
| 45d | S1 | 1 | 0.0% | -3.95% | -3.95% |
| 45d | **S2** | 2 | 50.0% | -1.33% | **+1.29%** |
| 60d | S1 | 1 | 0.0% | -3.95% | -3.95% |
| 60d | **S2** | 2 | 50.0% | -1.33% | **+1.29%** |
| 75d | S1 | 2 | 0.0% | -2.78% | -1.61% |
| 75d | **S2** | 2 | 50.0% | +9.89% | **+23.72%** |
| 90d | S1 | 4 | 25.0% | -1.52% | +1.37% |
| 90d | **S2** | 4 | 75.0% | +3.60% | **+15.67%** |
| 120d | S1 | 4 | 25.0% | -1.52% | +1.37% |
| 120d | **S2** | 2 | 50.0% | -1.33% | **+1.29%** |
| 365d | S1 | 7 | 28.6% | -0.41% | +5.19% |
| 365d | **S2** | 6 | 50.0% | +3.02% | **+21.16%** |

### AMZN

| Period | Strategy | Trades | Win Rate | Avg Return | Best Trade |
|--------|---------|--------|----------|------------|-----------|
| 30d | S1 | 2 | 50.0% | -1.98% | +0.91% |
| 30d | **S2** | 1 | 0.0% | -4.87% | **-4.87%** |
| 45d | S1 | 2 | 50.0% | -1.98% | +0.91% |
| 45d | **S2** | 2 | 50.0% | -1.98% | **+0.91%** |
| 60d | S1 | 2 | 50.0% | -1.98% | +0.91% |
| 60d | **S2** | 1 | 0.0% | -4.87% | **-4.87%** |
| 75d | S1 | 2 | 50.0% | -1.98% | +0.91% |
| 75d | **S2** | 3 | 66.7% | -0.24% | **+3.24%** |
| 90d | S1 | 2 | 50.0% | -1.98% | +0.91% |
| 90d | **S2** | 1 | 100.0% | +3.24% | **+3.24%** |
| 120d | S1 | 2 | 50.0% | -1.98% | +0.91% |
| 120d | **S2** | 2 | 50.0% | -1.98% | **+0.91%** |
| 365d | S1 | 3 | 33.3% | -1.91% | +0.91% |
| 365d | **S2** | 3 | 33.3% | -1.43% | **+0.76%** |

## Component Value Analysis

Which sentiment/news/earnings components add the most value?

### Scoring Breakdown

**Strategy 1 Components (55 points max):**
- Momentum: 0-25 pts
- Range: 0-15 pts
- Volume: 5 pts (fixed)
- Market: 0-10 pts

**Strategy 2 Additional Components (45 points added):**
- News Sentiment: 0-20 pts (Finnhub News API)
- Earnings Impact: 0-10 pts (recent beats, upcoming)
- Social Sentiment: 0-10 pts (Reddit/Twitter)
- Volume: Enhanced to 10 pts

**Total: 100 points** (vs Strategy 1's 55)

### Grade Thresholds

| Grade | Strategy 1 | Strategy 2 | Notes |
|-------|-----------|-----------|-------|
| A+ | 50+ | 85+ | Higher bar for S2 |
| A | 47-49 | 75-84 | |
| A- | 45-46 | 70-74 | |
| B+ | 41-44 | 65-69 | |
| B | 38-40 | 60-64 | |
| B- | 35-37 | 55-59 | |

## Implementation Notes

### ⏸️ Continue with Strategy 1

Strategy 2 did not show significant improvement. Recommendations:

1. Continue using Strategy 1 (momentum-only)
2. Explore alternative data sources:
   - Options flow data (unusual activity)
   - Institutional ownership changes
   - Analyst rating changes
3. Focus on improving base signals (better momentum/range detection)

## Technical Implementation

### Files Created
- `strategy2_scorer.py` - Enhanced scoring algorithm
- `strategy2_backtest_engine.py` - Backtesting framework
- `backtest_data/strategy2_*.csv` - Detailed trade logs
- `backtest_data/strategy2_summary.json` - Performance metrics
- `backtest_data/comparison_summary.json` - Side-by-side comparison

### API Integration
**Finnhub Endpoints Used:**
1. `/company-news` - News sentiment (last 24h)
2. `/calendar/earnings` - Earnings beats and upcoming dates
3. `/stock/social-sentiment` - Reddit/Twitter buzz

**Caching Strategy:**
- News: Cached by ticker + date
- Earnings: Cached by ticker + date
- Social: Cached by ticker + date
- Prevents duplicate API calls during backtesting

## Conclusion

After comprehensive backtesting across 7 time periods (30-365 days), Strategy 2 
does **not show sufficient improvement** to justify the added complexity and API costs. 
Strategy 1's pure momentum approach remains the recommended algorithm.

---
*Report generated by Strategy 2 backtest engine on March 05, 2026*