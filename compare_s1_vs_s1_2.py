"""
Compare Strategy 1 (Momentum-Only) vs Strategy 1.2 (Event-Driven)
"""
import json
import pandas as pd
from pathlib import Path
from datetime import datetime, timedelta
from backtest_engine import Strategy1Backtest
from strategy1_2_backtest_engine import Strategy12Backtest

def run_comparison():
    """Run side-by-side comparison of S1 vs S1.2"""
    periods = [30, 45, 60, 75, 90, 120, 365]
    end_date = datetime.now()
    
    comparison_data = []
    
    print("\n" + "="*80)
    print("STRATEGY COMPARISON: S1 (Momentum) vs S1.2 (Event-Driven)")
    print("="*80)
    
    for days in periods:
        start_date = end_date - timedelta(days=days)
        
        print(f"\n{'='*80}")
        print(f"PERIOD: {days} days ({start_date.date()} to {end_date.date()})")
        print(f"{'='*80}")
        
        # Run Strategy 1
        print(f"\n🔵 Running Strategy 1 (Momentum-Only)...")
        bt1 = Strategy1Backtest(start_date, end_date)
        bt1.fetch_data()
        bt1.run_backtest()
        s1_results = bt1._generate_results()
        
        # Run Strategy 1.2
        print(f"\n🟢 Running Strategy 1.2 (Event-Driven)...")
        bt12 = Strategy12Backtest(start_date, end_date)
        bt12.data = bt1.data  # Reuse data
        s12_results = bt12.run_backtest()
        bt12.save_results()
        
        # Compare
        comparison = {
            'period': f"{days}d",
            'start_date': start_date.strftime('%Y-%m-%d'),
            'end_date': end_date.strftime('%Y-%m-%d'),
            's1': {
                'total_trades': s1_results['total_trades'],
                'win_rate': s1_results['win_rate'],
                'total_return': s1_results['total_return_pct'],
                'final_capital': s1_results['final_capital']
            },
            's1_2': {
                'total_trades': s12_results['total_trades'],
                'win_rate': s12_results['win_rate'],
                'total_return': s12_results['total_return_pct'],
                'final_capital': s12_results['final_capital'],
                'catalyst_performance': s12_results.get('catalyst_performance', {})
            },
            'improvements': {
                'return_diff': s12_results['total_return_pct'] - s1_results['total_return_pct'],
                'win_rate_diff': s12_results['win_rate'] - s1_results['win_rate'],
                'trade_count_diff': s12_results['total_trades'] - s1_results['total_trades']
            }
        }
        
        comparison_data.append(comparison)
        
        # Print summary
        print(f"\n📊 PERIOD SUMMARY: {days}d")
        print(f"{'Strategy':<20} {'Trades':<10} {'Win Rate':<12} {'Return':<12} {'Final $':<12}")
        print("-" * 80)
        print(f"{'S1 (Momentum)':<20} {s1_results['total_trades']:<10} "
              f"{s1_results['win_rate']:<11.2f}% {s1_results['total_return_pct']:<11.2f}% "
              f"${s1_results['final_capital']:<11.2f}")
        print(f"{'S1.2 (Events)':<20} {s12_results['total_trades']:<10} "
              f"{s12_results['win_rate']:<11.2f}% {s12_results['total_return_pct']:<11.2f}% "
              f"${s12_results['final_capital']:<11.2f}")
        print("-" * 80)
        print(f"{'IMPROVEMENT':<20} {comparison['improvements']['trade_count_diff']:<10} "
              f"{comparison['improvements']['win_rate_diff']:<11.2f}% "
              f"{comparison['improvements']['return_diff']:<11.2f}%")
        
        # Winner
        if comparison['improvements']['return_diff'] > 0:
            print(f"\n✅ WINNER: S1.2 (Event-Driven) by {comparison['improvements']['return_diff']:.2f}%")
        else:
            print(f"\n❌ WINNER: S1 (Momentum) by {abs(comparison['improvements']['return_diff']):.2f}%")
    
    # Save comparison
    output_file = Path('/tmp/AlphaTrades/backtest_data/s1_vs_s1_2_comparison.json')
    with open(output_file, 'w') as f:
        json.dump(comparison_data, f, indent=2)
    
    print(f"\n✓ Comparison saved to {output_file}")
    
    # Generate summary statistics
    generate_summary_report(comparison_data)
    
    return comparison_data


def generate_summary_report(comparison_data):
    """Generate comprehensive comparison report"""
    print("\n" + "="*80)
    print("OVERALL COMPARISON SUMMARY")
    print("="*80)
    
    df = pd.DataFrame(comparison_data)
    
    # Calculate averages
    s1_avg_return = df['s1'].apply(lambda x: x['total_return']).mean()
    s1_avg_win_rate = df['s1'].apply(lambda x: x['win_rate']).mean()
    s1_avg_trades = df['s1'].apply(lambda x: x['total_trades']).mean()
    
    s12_avg_return = df['s1_2'].apply(lambda x: x['total_return']).mean()
    s12_avg_win_rate = df['s1_2'].apply(lambda x: x['win_rate']).mean()
    s12_avg_trades = df['s1_2'].apply(lambda x: x['total_trades']).mean()
    
    print(f"\n📈 AVERAGE PERFORMANCE ACROSS ALL PERIODS:")
    print(f"{'Strategy':<20} {'Avg Trades':<15} {'Avg Win Rate':<15} {'Avg Return':<15}")
    print("-" * 80)
    print(f"{'S1 (Momentum)':<20} {s1_avg_trades:<14.1f} {s1_avg_win_rate:<14.2f}% {s1_avg_return:<14.2f}%")
    print(f"{'S1.2 (Events)':<20} {s12_avg_trades:<14.1f} {s12_avg_win_rate:<14.2f}% {s12_avg_return:<14.2f}%")
    print("-" * 80)
    print(f"{'IMPROVEMENT':<20} {s12_avg_trades - s1_avg_trades:<14.1f} "
          f"{s12_avg_win_rate - s1_avg_win_rate:<14.2f}% "
          f"{s12_avg_return - s1_avg_return:<14.2f}%")
    
    # Win count
    s12_wins = sum(1 for item in comparison_data if item['improvements']['return_diff'] > 0)
    s1_wins = len(comparison_data) - s12_wins
    
    print(f"\n🏆 PERIOD WINS:")
    print(f"  S1.2 (Event-Driven) won: {s12_wins}/{len(comparison_data)} periods")
    print(f"  S1 (Momentum) won: {s1_wins}/{len(comparison_data)} periods")
    
    # Recommendation
    print(f"\n" + "="*80)
    if s12_wins > s1_wins and s12_avg_return > s1_avg_return:
        print("✅ RECOMMENDATION: DEPLOY STRATEGY 1.2 (Event-Driven)")
        print(f"   Reasoning: S1.2 outperformed in {s12_wins}/{len(comparison_data)} periods")
        print(f"   Average return improvement: +{s12_avg_return - s1_avg_return:.2f}%")
    elif s12_avg_return > s1_avg_return * 1.1:  # 10% better
        print("✅ RECOMMENDATION: DEPLOY STRATEGY 1.2 (Event-Driven)")
        print(f"   Reasoning: Significant average return improvement (+{s12_avg_return - s1_avg_return:.2f}%)")
    else:
        print("⏸️ RECOMMENDATION: KEEP STRATEGY 1 (Momentum)")
        print(f"   Reasoning: S1.2 did not show sufficient improvement")
    print("="*80)


def analyze_catalyst_trades():
    """Analyze specific catalyst-driven trades (AMZN, NFLX examples)"""
    print("\n" + "="*80)
    print("CATALYST CASE STUDIES: AMZN & NFLX")
    print("="*80)
    
    # Load S1.2 trade data
    data_dir = Path('/tmp/AlphaTrades/backtest_data')
    
    catalyst_examples = {
        'amzn_openai': [],
        'nflx_capital_return': [],
        'other_catalysts': []
    }
    
    # Scan all S1.2 trade files
    for trade_file in data_dir.glob('strategy1_2_trades_*.csv'):
        try:
            df = pd.DataFrame(pd.read_csv(trade_file))
            
            # AMZN trades around Dec 4-10, 2024
            amzn_trades = df[
                (df['ticker'] == 'AMZN') &
                (df['entry_date'].str.contains('2024-12'))
            ]
            
            if len(amzn_trades) > 0:
                for _, trade in amzn_trades.iterrows():
                    catalyst_examples['amzn_openai'].append(trade.to_dict())
            
            # NFLX trades around Nov 15 or Dec 20, 2024
            nflx_trades = df[
                (df['ticker'] == 'NFLX') &
                ((df['entry_date'].str.contains('2024-11')) |
                 (df['entry_date'].str.contains('2024-12')))
            ]
            
            if len(nflx_trades) > 0:
                for _, trade in nflx_trades.iterrows():
                    catalyst_examples['nflx_capital_return'].append(trade.to_dict())
        
        except Exception as e:
            print(f"Warning: Could not read {trade_file}: {e}")
    
    # Save catalyst examples
    output_file = Path('/tmp/AlphaTrades/backtest_data/catalyst_examples.json')
    with open(output_file, 'w') as f:
        json.dump(catalyst_examples, f, indent=2)
    
    print(f"\n✓ Catalyst examples saved to {output_file}")
    
    # Print findings
    print(f"\n📊 CATALYST TRADE ANALYSIS:")
    print(f"  AMZN+OpenAI trades found: {len(catalyst_examples['amzn_openai'])}")
    print(f"  NFLX capital return trades found: {len(catalyst_examples['nflx_capital_return'])}")
    
    if catalyst_examples['amzn_openai']:
        print(f"\n  AMZN Example Trades:")
        for trade in catalyst_examples['amzn_openai'][:3]:
            print(f"    {trade.get('entry_date')} → {trade.get('exit_date')}: "
                  f"{trade.get('pnl_pct', 0):.2f}% ({trade.get('exit_reason', 'unknown')})")
    
    if catalyst_examples['nflx_capital_return']:
        print(f"\n  NFLX Example Trades:")
        for trade in catalyst_examples['nflx_capital_return'][:3]:
            print(f"    {trade.get('entry_date')} → {trade.get('exit_date')}: "
                  f"{trade.get('pnl_pct', 0):.2f}% ({trade.get('exit_reason', 'unknown')})")


if __name__ == '__main__':
    # Run comparison
    comparison_data = run_comparison()
    
    # Analyze specific catalyst trades
    analyze_catalyst_trades()
    
    print("\n" + "="*80)
    print("✅ COMPARISON COMPLETE")
    print("="*80)
