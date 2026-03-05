"""
Generate Strategy 2 Backtest Report
Creates comprehensive markdown report comparing Strategy 1 vs Strategy 2
"""
import json
import pandas as pd
from pathlib import Path
from datetime import datetime

def generate_markdown_report():
    """Generate comprehensive markdown report"""
    
    base_path = Path('/tmp/AlphaTrades/backtest_data')
    
    # Load results
    with open(base_path / 'summary.json') as f:
        s1_results = json.load(f)
    
    with open(base_path / 'strategy2_summary.json') as f:
        s2_results = json.load(f)
    
    with open(base_path / 'comparison_summary.json') as f:
        comparison = json.load(f)
    
    # Start markdown
    md = []
    md.append("# Strategy 2 Backtest Report")
    md.append(f"**Generated:** {datetime.now().strftime('%B %d, %Y at %I:%M %p')}")
    md.append("")
    md.append("## Executive Summary")
    md.append("")
    
    # Get recommendation
    rec = comparison.get('recommendation', {})
    md.append(f"**Recommendation:** {rec.get('recommendation', 'N/A')}")
    md.append(f"**Confidence:** {rec.get('confidence', 'N/A')}")
    md.append(f"**Reasoning:** {rec.get('reasoning', 'N/A')}")
    md.append("")
    
    # Key findings
    md.append("### Key Findings")
    md.append("")
    md.append(f"- Strategy 2 outperformed in **{rec.get('s2_better_periods', 0)}/{rec.get('total_periods', 0)}** test periods")
    md.append(f"- Average return improvement: **{rec.get('avg_return_improvement', 0):+.2f}%**")
    md.append(f"- Average win rate improvement: **{rec.get('avg_winrate_improvement', 0):+.2f}%**")
    md.append("")
    
    # Performance comparison table
    md.append("## Performance Comparison")
    md.append("")
    md.append("### Returns by Period")
    md.append("")
    md.append("| Period | Strategy 1 | Strategy 2 | Improvement | Winner |")
    md.append("|--------|-----------|-----------|-------------|--------|")
    
    periods = comparison.get('period_comparisons', [])
    total_s1_return = 0
    total_s2_return = 0
    
    for p in periods:
        period = p['period']
        s1_ret = p['s1_return']
        s2_ret = p['s2_return']
        improvement = s2_ret - s1_ret
        winner = "**S2**" if s2_ret > s1_ret else "S1"
        
        md.append(f"| {period} | {s1_ret:.2f}% | {s2_ret:.2f}% | {improvement:+.2f}% | {winner} |")
        
        total_s1_return += s1_ret
        total_s2_return += s2_ret
    
    avg_s1 = total_s1_return / len(periods) if periods else 0
    avg_s2 = total_s2_return / len(periods) if periods else 0
    avg_improvement = avg_s2 - avg_s1
    
    md.append(f"| **AVERAGE** | **{avg_s1:.2f}%** | **{avg_s2:.2f}%** | **{avg_improvement:+.2f}%** | - |")
    md.append("")
    
    # Win rate comparison
    md.append("### Win Rate Comparison")
    md.append("")
    md.append("| Period | Strategy 1 | Strategy 2 | Improvement | Winner |")
    md.append("|--------|-----------|-----------|-------------|--------|")
    
    total_s1_wr = 0
    total_s2_wr = 0
    
    for p in periods:
        period = p['period']
        s1_wr = p['s1_win_rate']
        s2_wr = p['s2_win_rate']
        improvement = s2_wr - s1_wr
        winner = "**S2**" if s2_wr > s1_wr else "S1"
        
        md.append(f"| {period} | {s1_wr:.2f}% | {s2_wr:.2f}% | {improvement:+.2f}% | {winner} |")
        
        total_s1_wr += s1_wr
        total_s2_wr += s2_wr
    
    avg_s1_wr = total_s1_wr / len(periods) if periods else 0
    avg_s2_wr = total_s2_wr / len(periods) if periods else 0
    avg_wr_improvement = avg_s2_wr - avg_s1_wr
    
    md.append(f"| **AVERAGE** | **{avg_s1_wr:.2f}%** | **{avg_s2_wr:.2f}%** | **{avg_wr_improvement:+.2f}%** | - |")
    md.append("")
    
    # Risk metrics
    md.append("### Risk-Adjusted Metrics")
    md.append("")
    md.append("| Period | S1 Sharpe | S2 Sharpe | S1 Max DD | S2 Max DD |")
    md.append("|--------|-----------|-----------|-----------|-----------|")
    
    for p in periods:
        period = p['period']
        s1_sharpe = p.get('s1_sharpe', 0)
        s2_sharpe = p.get('s2_sharpe', 0)
        s1_dd = p.get('s1_max_dd', 0)
        s2_dd = p.get('s2_max_dd', 0)
        
        md.append(f"| {period} | {s1_sharpe:.2f} | {s2_sharpe:.2f} | {s1_dd:.2f}% | {s2_dd:.2f}% |")
    
    md.append("")
    
    # NFLX & AMZN analysis
    md.append("## NFLX & AMZN Deep Dive")
    md.append("")
    md.append("Parker mentioned 100%+ wins on NFLX and AMZN using sentiment. Here's what the data shows:")
    md.append("")
    
    # Analyze NFLX and AMZN trades
    for ticker in ['NFLX', 'AMZN']:
        md.append(f"### {ticker}")
        md.append("")
        md.append("| Period | Strategy | Trades | Win Rate | Avg Return | Best Trade |")
        md.append("|--------|---------|--------|----------|------------|-----------|")
        
        for period in ['30d', '45d', '60d', '75d', '90d', '120d', '365d']:
            s1_trades_path = base_path / f'trades_{period}.csv'
            s2_trades_path = base_path / f'strategy2_trades_{period}.csv'
            
            if s1_trades_path.exists():
                s1_trades = pd.read_csv(s1_trades_path)
                s1_ticker_trades = s1_trades[s1_trades['ticker'] == ticker]
                
                if len(s1_ticker_trades) > 0:
                    s1_count = len(s1_ticker_trades)
                    s1_wins = len(s1_ticker_trades[s1_ticker_trades['pnl'] > 0])
                    s1_wr = (s1_wins / s1_count * 100) if s1_count > 0 else 0
                    s1_avg = s1_ticker_trades['pnl_pct'].mean()
                    s1_best = s1_ticker_trades['pnl_pct'].max()
                    
                    md.append(f"| {period} | S1 | {s1_count} | {s1_wr:.1f}% | {s1_avg:+.2f}% | {s1_best:+.2f}% |")
            
            if s2_trades_path.exists():
                s2_trades = pd.read_csv(s2_trades_path)
                s2_ticker_trades = s2_trades[s2_trades['ticker'] == ticker]
                
                if len(s2_ticker_trades) > 0:
                    s2_count = len(s2_ticker_trades)
                    s2_wins = len(s2_ticker_trades[s2_ticker_trades['pnl'] > 0])
                    s2_wr = (s2_wins / s2_count * 100) if s2_count > 0 else 0
                    s2_avg = s2_ticker_trades['pnl_pct'].mean()
                    s2_best = s2_ticker_trades['pnl_pct'].max()
                    
                    md.append(f"| {period} | **S2** | {s2_count} | {s2_wr:.1f}% | {s2_avg:+.2f}% | **{s2_best:+.2f}%** |")
        
        md.append("")
    
    # Component value analysis
    md.append("## Component Value Analysis")
    md.append("")
    md.append("Which sentiment/news/earnings components add the most value?")
    md.append("")
    md.append("### Scoring Breakdown")
    md.append("")
    md.append("**Strategy 1 Components (55 points max):**")
    md.append("- Momentum: 0-25 pts")
    md.append("- Range: 0-15 pts")
    md.append("- Volume: 5 pts (fixed)")
    md.append("- Market: 0-10 pts")
    md.append("")
    md.append("**Strategy 2 Additional Components (45 points added):**")
    md.append("- News Sentiment: 0-20 pts (Finnhub News API)")
    md.append("- Earnings Impact: 0-10 pts (recent beats, upcoming)")
    md.append("- Social Sentiment: 0-10 pts (Reddit/Twitter)")
    md.append("- Volume: Enhanced to 10 pts")
    md.append("")
    md.append("**Total: 100 points** (vs Strategy 1's 55)")
    md.append("")
    
    # Grade threshold comparison
    md.append("### Grade Thresholds")
    md.append("")
    md.append("| Grade | Strategy 1 | Strategy 2 | Notes |")
    md.append("|-------|-----------|-----------|-------|")
    md.append("| A+ | 50+ | 85+ | Higher bar for S2 |")
    md.append("| A | 47-49 | 75-84 | |")
    md.append("| A- | 45-46 | 70-74 | |")
    md.append("| B+ | 41-44 | 65-69 | |")
    md.append("| B | 38-40 | 60-64 | |")
    md.append("| B- | 35-37 | 55-59 | |")
    md.append("")
    
    # Implementation notes
    md.append("## Implementation Notes")
    md.append("")
    
    if rec.get('recommendation') == 'DEPLOY STRATEGY 2':
        md.append("### ✅ Ready to Deploy")
        md.append("")
        md.append("**Next Steps:**")
        md.append("1. Update `app.py` to import `Strategy2Scorer` instead of `Scorer`")
        md.append("2. Set Finnhub API key in environment: `FINNHUB_API_KEY`")
        md.append("3. Monitor API usage (free tier = 60 calls/min)")
        md.append("4. Consider caching sentiment data for frequently checked tickers")
        md.append("5. Track component breakdown in dashboard for debugging")
        md.append("")
        md.append("**API Rate Limits:**")
        md.append("- Finnhub Free: 60 calls/minute")
        md.append("- With 12 tickers scanning every 2-3 minutes = ~240 calls/hour")
        md.append("- Well within limits, but cache aggressively")
        md.append("")
    elif rec.get('recommendation') == 'HYBRID APPROACH':
        md.append("### 🔀 Hybrid Approach Recommended")
        md.append("")
        md.append("**Suggested Hybrid Implementation:**")
        md.append("1. Use Strategy 1 for base scoring (momentum/range/volume/market)")
        md.append("2. For A-grade candidates only, fetch sentiment as bonus")
        md.append("3. Reduce sentiment weights to 10-15 points total")
        md.append("4. Use sentiment as tie-breaker when multiple A-grades appear")
        md.append("")
        md.append("This reduces API calls while still capturing sentiment value on best setups.")
        md.append("")
    else:
        md.append("### ⏸️ Continue with Strategy 1")
        md.append("")
        md.append("Strategy 2 did not show significant improvement. Recommendations:")
        md.append("")
        md.append("1. Continue using Strategy 1 (momentum-only)")
        md.append("2. Explore alternative data sources:")
        md.append("   - Options flow data (unusual activity)")
        md.append("   - Institutional ownership changes")
        md.append("   - Analyst rating changes")
        md.append("3. Focus on improving base signals (better momentum/range detection)")
        md.append("")
    
    # Technical details
    md.append("## Technical Implementation")
    md.append("")
    md.append("### Files Created")
    md.append("- `strategy2_scorer.py` - Enhanced scoring algorithm")
    md.append("- `strategy2_backtest_engine.py` - Backtesting framework")
    md.append("- `backtest_data/strategy2_*.csv` - Detailed trade logs")
    md.append("- `backtest_data/strategy2_summary.json` - Performance metrics")
    md.append("- `backtest_data/comparison_summary.json` - Side-by-side comparison")
    md.append("")
    md.append("### API Integration")
    md.append("**Finnhub Endpoints Used:**")
    md.append("1. `/company-news` - News sentiment (last 24h)")
    md.append("2. `/calendar/earnings` - Earnings beats and upcoming dates")
    md.append("3. `/stock/social-sentiment` - Reddit/Twitter buzz")
    md.append("")
    md.append("**Caching Strategy:**")
    md.append("- News: Cached by ticker + date")
    md.append("- Earnings: Cached by ticker + date")
    md.append("- Social: Cached by ticker + date")
    md.append("- Prevents duplicate API calls during backtesting")
    md.append("")
    
    # Conclusion
    md.append("## Conclusion")
    md.append("")
    md.append(f"After comprehensive backtesting across 7 time periods (30-365 days), Strategy 2 ")
    
    if rec.get('recommendation') == 'DEPLOY STRATEGY 2':
        md.append("**demonstrates clear value** in adding sentiment, news, and earnings data. ")
        md.append("The enhanced algorithm consistently outperforms the momentum-only approach, ")
        md.append("especially on high-profile stocks like NFLX and AMZN where news drives price action.")
    elif rec.get('recommendation') == 'HYBRID APPROACH':
        md.append("shows **moderate improvement** over Strategy 1. A hybrid approach is recommended ")
        md.append("to capture sentiment value without over-complicating the system or burning API limits.")
    else:
        md.append("does **not show sufficient improvement** to justify the added complexity and API costs. ")
        md.append("Strategy 1's pure momentum approach remains the recommended algorithm.")
    
    md.append("")
    md.append("---")
    md.append(f"*Report generated by Strategy 2 backtest engine on {datetime.now().strftime('%B %d, %Y')}*")
    
    # Write to file
    report_path = Path('/tmp/AlphaTrades/STRATEGY_2_BACKTEST.md')
    with open(report_path, 'w') as f:
        f.write('\n'.join(md))
    
    print(f"\n✓ Report generated: {report_path}")
    print(f"  {len(md)} lines")
    
    return report_path


if __name__ == '__main__':
    generate_markdown_report()
