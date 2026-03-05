"""
Strategy Comparison Tool
Compares Strategy 1 (momentum-only) vs Strategy 2 (sentiment-enhanced)
"""
import json
import pandas as pd
from pathlib import Path

def load_results():
    """Load backtest results for both strategies"""
    base_path = Path('/tmp/AlphaTrades/backtest_data')
    
    # Load Strategy 1 results
    s1_path = base_path / 'summary.json'
    if not s1_path.exists():
        print("ERROR: Strategy 1 results not found")
        return None, None
    
    with open(s1_path) as f:
        s1_results = json.load(f)
    
    # Load Strategy 2 results
    s2_path = base_path / 'strategy2_summary.json'
    if not s2_path.exists():
        print("ERROR: Strategy 2 results not found")
        return s1_results, None
    
    with open(s2_path) as f:
        s2_results = json.load(f)
    
    return s1_results, s2_results


def compare_performance(s1_results, s2_results):
    """Generate comprehensive comparison report"""
    
    print("\n" + "="*80)
    print("STRATEGY 1 vs STRATEGY 2 PERFORMANCE COMPARISON")
    print("="*80 + "\n")
    
    # Period comparisons
    periods = ['30d', '45d', '60d', '75d', '90d', '120d', '365d']
    
    comparison_data = []
    
    for period in periods:
        if period not in s1_results or period not in s2_results:
            continue
        
        s1 = s1_results[period]
        s2 = s2_results[period]
        
        # Skip if either strategy has errors
        if 'error' in s1 or 'error' in s2:
            continue
        
        comparison_data.append({
            'period': period,
            's1_return': s1.get('total_return_pct', 0),
            's2_return': s2.get('total_return_pct', 0),
            's1_win_rate': s1.get('win_rate', 0),
            's2_win_rate': s2.get('win_rate', 0),
            's1_trades': s1.get('total_trades', 0),
            's2_trades': s2.get('total_trades', 0),
            's1_avg_pnl': s1.get('avg_pnl_pct', 0),
            's2_avg_pnl': s2.get('avg_pnl_pct', 0),
            's1_max_dd': s1.get('max_drawdown', 0),
            's2_max_dd': s2.get('max_drawdown', 0),
            's1_sharpe': s1.get('sharpe_ratio', 0),
            's2_sharpe': s2.get('sharpe_ratio', 0),
        })
    
    df = pd.DataFrame(comparison_data)
    
    # Print summary table
    print("OVERALL PERFORMANCE BY PERIOD")
    print("-" * 80)
    print(f"{'Period':<10} {'S1 Return':<12} {'S2 Return':<12} {'Improvement':<15} {'Winner':<10}")
    print("-" * 80)
    
    for _, row in df.iterrows():
        improvement = row['s2_return'] - row['s1_return']
        winner = 'S2' if row['s2_return'] > row['s1_return'] else 'S1'
        
        print(f"{row['period']:<10} "
              f"{row['s1_return']:>10.2f}%  "
              f"{row['s2_return']:>10.2f}%  "
              f"{improvement:>+12.2f}%  "
              f"{winner:<10}")
    
    print("-" * 80)
    print(f"{'AVERAGE':<10} "
          f"{df['s1_return'].mean():>10.2f}%  "
          f"{df['s2_return'].mean():>10.2f}%  "
          f"{(df['s2_return'] - df['s1_return']).mean():>+12.2f}%")
    print()
    
    # Win rate comparison
    print("\nWIN RATE COMPARISON")
    print("-" * 80)
    print(f"{'Period':<10} {'S1 Win%':<12} {'S2 Win%':<12} {'Improvement':<15} {'Winner':<10}")
    print("-" * 80)
    
    for _, row in df.iterrows():
        improvement = row['s2_win_rate'] - row['s1_win_rate']
        winner = 'S2' if row['s2_win_rate'] > row['s1_win_rate'] else 'S1'
        
        print(f"{row['period']:<10} "
              f"{row['s1_win_rate']:>10.2f}%  "
              f"{row['s2_win_rate']:>10.2f}%  "
              f"{improvement:>+12.2f}%  "
              f"{winner:<10}")
    
    print("-" * 80)
    print(f"{'AVERAGE':<10} "
          f"{df['s1_win_rate'].mean():>10.2f}%  "
          f"{df['s2_win_rate'].mean():>10.2f}%  "
          f"{(df['s2_win_rate'] - df['s1_win_rate']).mean():>+12.2f}%")
    print()
    
    # Average profit per trade
    print("\nAVERAGE PROFIT PER TRADE")
    print("-" * 80)
    print(f"{'Period':<10} {'S1 Avg%':<12} {'S2 Avg%':<12} {'Improvement':<15} {'Winner':<10}")
    print("-" * 80)
    
    for _, row in df.iterrows():
        improvement = row['s2_avg_pnl'] - row['s1_avg_pnl']
        winner = 'S2' if row['s2_avg_pnl'] > row['s1_avg_pnl'] else 'S1'
        
        print(f"{row['period']:<10} "
              f"{row['s1_avg_pnl']:>10.2f}%  "
              f"{row['s2_avg_pnl']:>10.2f}%  "
              f"{improvement:>+12.2f}%  "
              f"{winner:<10}")
    
    print("-" * 80)
    print(f"{'AVERAGE':<10} "
          f"{df['s1_avg_pnl'].mean():>10.2f}%  "
          f"{df['s2_avg_pnl'].mean():>10.2f}%  "
          f"{(df['s2_avg_pnl'] - df['s1_avg_pnl']).mean():>+12.2f}%")
    print()
    
    # Risk metrics
    print("\nRISK METRICS")
    print("-" * 80)
    print(f"{'Period':<10} {'S1 MaxDD':<12} {'S2 MaxDD':<12} {'S1 Sharpe':<12} {'S2 Sharpe':<12}")
    print("-" * 80)
    
    for _, row in df.iterrows():
        print(f"{row['period']:<10} "
              f"{row['s1_max_dd']:>10.2f}%  "
              f"{row['s2_max_dd']:>10.2f}%  "
              f"{row['s1_sharpe']:>10.2f}   "
              f"{row['s2_sharpe']:>10.2f}")
    
    print()
    
    return df


def analyze_nflx_amzn(s1_results, s2_results):
    """Deep dive on NFLX and AMZN trades"""
    
    print("\n" + "="*80)
    print("NFLX & AMZN DETAILED ANALYSIS")
    print("="*80 + "\n")
    
    base_path = Path('/tmp/AlphaTrades/backtest_data')
    
    # Analyze across all periods
    for period in ['30d', '45d', '60d', '75d', '90d', '120d', '365d']:
        
        print(f"\n{period.upper()} PERIOD")
        print("-" * 80)
        
        # Load trade data
        s1_trades_path = base_path / f'trades_{period}.csv'
        s2_trades_path = base_path / f'strategy2_trades_{period}.csv'
        
        if not s1_trades_path.exists() or not s2_trades_path.exists():
            continue
        
        s1_trades = pd.read_csv(s1_trades_path)
        s2_trades = pd.read_csv(s2_trades_path)
        
        for ticker in ['NFLX', 'AMZN']:
            s1_ticker = s1_trades[s1_trades['ticker'] == ticker]
            s2_ticker = s2_trades[s2_trades['ticker'] == ticker]
            
            if len(s1_ticker) == 0 and len(s2_ticker) == 0:
                continue
            
            print(f"\n{ticker}:")
            
            if len(s1_ticker) > 0:
                s1_wins = len(s1_ticker[s1_ticker['pnl'] > 0])
                s1_wr = (s1_wins / len(s1_ticker) * 100) if len(s1_ticker) > 0 else 0
                s1_avg = s1_ticker['pnl_pct'].mean()
                print(f"  Strategy 1: {len(s1_ticker)} trades, {s1_wr:.1f}% win rate, {s1_avg:+.2f}% avg")
            else:
                print(f"  Strategy 1: No trades")
            
            if len(s2_ticker) > 0:
                s2_wins = len(s2_ticker[s2_ticker['pnl'] > 0])
                s2_wr = (s2_wins / len(s2_ticker) * 100) if len(s2_ticker) > 0 else 0
                s2_avg = s2_ticker['pnl_pct'].mean()
                print(f"  Strategy 2: {len(s2_ticker)} trades, {s2_wr:.1f}% win rate, {s2_avg:+.2f}% avg")
                
                # Show best S2 trade
                if len(s2_ticker) > 0:
                    best = s2_ticker.loc[s2_ticker['pnl_pct'].idxmax()]
                    print(f"    Best trade: {best['entry_date']} → {best['exit_date']}, "
                          f"{best['pnl_pct']:+.2f}% ({best['grade']})")
            else:
                print(f"  Strategy 2: No trades")


def analyze_component_value(s2_results):
    """Analyze which components add most value in Strategy 2"""
    
    print("\n" + "="*80)
    print("STRATEGY 2 COMPONENT VALUE ANALYSIS")
    print("="*80 + "\n")
    
    base_path = Path('/tmp/AlphaTrades/backtest_data')
    
    # Aggregate component scores across all trades
    all_components = []
    
    for period in ['30d', '45d', '60d', '75d', '90d', '120d', '365d']:
        trades_path = base_path / f'strategy2_trades_{period}.csv'
        
        if not trades_path.exists():
            continue
        
        trades = pd.read_csv(trades_path)
        
        # Load detailed trade data (includes components)
        for _, trade in trades.iterrows():
            if 'components' in trade and pd.notna(trade.get('components')):
                try:
                    components = eval(trade['components']) if isinstance(trade['components'], str) else trade['components']
                    all_components.append({
                        'ticker': trade['ticker'],
                        'grade': trade['grade'],
                        'pnl_pct': trade['pnl_pct'],
                        'won': trade['pnl'] > 0,
                        **components
                    })
                except:
                    pass
    
    if all_components:
        df = pd.DataFrame(all_components)
        
        print("AVERAGE COMPONENT SCORES BY OUTCOME")
        print("-" * 80)
        
        winners = df[df['won'] == True]
        losers = df[df['won'] == False]
        
        components = ['momentum', 'range', 'volume', 'market', 'news_sentiment', 'earnings', 'social']
        
        print(f"{'Component':<20} {'Winners Avg':<15} {'Losers Avg':<15} {'Difference':<15}")
        print("-" * 80)
        
        for comp in components:
            if comp in df.columns:
                win_avg = winners[comp].mean() if len(winners) > 0 else 0
                lose_avg = losers[comp].mean() if len(losers) > 0 else 0
                diff = win_avg - lose_avg
                
                print(f"{comp:<20} {win_avg:>13.2f}  {lose_avg:>13.2f}  {diff:>+13.2f}")
        
        print()
        
        print("COMPONENT CORRELATION WITH WIN RATE")
        print("-" * 80)
        
        for comp in ['news_sentiment', 'earnings', 'social']:
            if comp in df.columns:
                # Group by component score ranges
                df[f'{comp}_bucket'] = pd.cut(df[comp], bins=5, labels=['Very Low', 'Low', 'Medium', 'High', 'Very High'])
                grouped = df.groupby(f'{comp}_bucket')['won'].agg(['sum', 'count'])
                grouped['win_rate'] = (grouped['sum'] / grouped['count'] * 100).round(2)
                
                print(f"\n{comp.replace('_', ' ').title()}:")
                print(grouped[['count', 'win_rate']])


def generate_recommendations(df_comparison, s1_results, s2_results):
    """Generate deployment recommendations"""
    
    print("\n" + "="*80)
    print("DEPLOYMENT RECOMMENDATIONS")
    print("="*80 + "\n")
    
    # Calculate key metrics
    s2_better_return = (df_comparison['s2_return'] > df_comparison['s1_return']).sum()
    s2_better_winrate = (df_comparison['s2_win_rate'] > df_comparison['s1_win_rate']).sum()
    total_periods = len(df_comparison)
    
    avg_return_improvement = (df_comparison['s2_return'] - df_comparison['s1_return']).mean()
    avg_winrate_improvement = (df_comparison['s2_win_rate'] - df_comparison['s1_win_rate']).mean()
    
    print("SUMMARY:")
    print(f"  • Strategy 2 had better returns in {s2_better_return}/{total_periods} periods")
    print(f"  • Strategy 2 had better win rate in {s2_better_winrate}/{total_periods} periods")
    print(f"  • Average return improvement: {avg_return_improvement:+.2f}%")
    print(f"  • Average win rate improvement: {avg_winrate_improvement:+.2f}%")
    print()
    
    # Decision logic
    if s2_better_return >= total_periods * 0.6 and avg_return_improvement > 5:
        recommendation = "DEPLOY STRATEGY 2"
        confidence = "HIGH"
        reasoning = "Strategy 2 shows consistent improvement across most periods with meaningful return gains."
    elif s2_better_return >= total_periods * 0.5 and avg_return_improvement > 2:
        recommendation = "DEPLOY STRATEGY 2"
        confidence = "MEDIUM"
        reasoning = "Strategy 2 shows moderate improvement. Consider hybrid approach or further testing."
    elif avg_return_improvement > 0:
        recommendation = "HYBRID APPROACH"
        confidence = "MEDIUM"
        reasoning = "Strategy 2 shows some improvement but not consistent. Use sentiment as tie-breaker or filter."
    else:
        recommendation = "KEEP STRATEGY 1"
        confidence = "HIGH"
        reasoning = "Strategy 2 does not show improvement over Strategy 1. Additional sentiment data may not be worth the complexity."
    
    print(f"RECOMMENDATION: {recommendation}")
    print(f"CONFIDENCE: {confidence}")
    print(f"\nREASONING: {reasoning}")
    print()
    
    if recommendation == "DEPLOY STRATEGY 2":
        print("IMPLEMENTATION NOTES:")
        print("  • Update dashboard to use strategy2_scorer.py")
        print("  • Monitor API rate limits (Finnhub free tier = 60 calls/min)")
        print("  • Consider caching sentiment data to reduce API calls")
        print("  • Track which components (news/earnings/social) contribute most")
    elif recommendation == "HYBRID APPROACH":
        print("HYBRID IMPLEMENTATION:")
        print("  • Use Strategy 1 for base scoring")
        print("  • Add sentiment as bonus points or tie-breaker")
        print("  • Only fetch sentiment for A-grade candidates (reduce API calls)")
        print("  • Weight adjustment: Lower sentiment weights to 10-15 points total")
    else:
        print("NEXT STEPS:")
        print("  • Continue using Strategy 1")
        print("  • Consider alternative data sources (options flow, institutional activity)")
        print("  • Focus on improving base momentum/range signals")
    
    print()
    
    return {
        'recommendation': recommendation,
        'confidence': confidence,
        'reasoning': reasoning,
        's2_better_periods': s2_better_return,
        'total_periods': total_periods,
        'avg_return_improvement': avg_return_improvement,
        'avg_winrate_improvement': avg_winrate_improvement
    }


def save_comparison_report(df_comparison, recommendation):
    """Save detailed comparison to JSON"""
    
    output_path = Path('/tmp/AlphaTrades/backtest_data/comparison_summary.json')
    
    # Convert numpy types to native Python
    def convert_types(obj):
        if isinstance(obj, dict):
            return {k: convert_types(v) for k, v in obj.items()}
        elif isinstance(obj, (np.integer, np.int64)):
            return int(obj)
        elif isinstance(obj, (np.floating, np.float64)):
            return float(obj)
        else:
            return obj
    
    report = {
        'generated_at': pd.Timestamp.now().isoformat(),
        'recommendation': convert_types(recommendation),
        'period_comparisons': json.loads(df_comparison.to_json(orient='records'))
    }
    
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)
    
    print(f"\n✓ Comparison summary saved to: {output_path}")


if __name__ == '__main__':
    # Load results
    s1_results, s2_results = load_results()
    
    if not s1_results or not s2_results:
        print("ERROR: Cannot load results for both strategies")
        exit(1)
    
    # Run comparisons
    df_comparison = compare_performance(s1_results, s2_results)
    analyze_nflx_amzn(s1_results, s2_results)
    analyze_component_value(s2_results)
    recommendation = generate_recommendations(df_comparison, s1_results, s2_results)
    
    # Save report
    save_comparison_report(df_comparison, recommendation)
    
    print("\n" + "="*80)
    print("COMPARISON COMPLETE")
    print("="*80 + "\n")
