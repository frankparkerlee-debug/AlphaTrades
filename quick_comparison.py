"""
Quick comparison of S1 vs S1.2 for key periods
"""
import json
from pathlib import Path
from datetime import datetime, timedelta
from backtest_engine import Strategy1Backtest
from strategy1_2_backtest_engine import Strategy12Backtest

def run_quick_comparison():
    """Run quick comparison for 90d and 120d periods"""
    periods = [90, 120]
    end_date = datetime.now()
    
    results = []
    
    for days in periods:
        start_date = end_date - timedelta(days=days)
        
        print(f"\n{'='*80}")
        print(f"TESTING: {days} days ({start_date.date()} to {end_date.date()})")
        print(f"{'='*80}")
        
        # Strategy 1
        print(f"\n🔵 Strategy 1 (Momentum)...")
        bt1 = Strategy1Backtest(start_date, end_date)
        bt1.fetch_data()
        bt1.run_backtest()
        s1_res = bt1.generate_report()
        
        # Strategy 1.2 (reuse data)
        print(f"\n🟢 Strategy 1.2 (Event-Driven)...")
        bt12 = Strategy12Backtest(start_date, end_date)
        bt12.data = bt1.data
        s12_res = bt12.run_backtest()
        
        # Compare
        s1_return = s1_res.get('total_return_pct', 0)
        s1_trades = s1_res.get('total_trades', 0)
        s1_win_rate = s1_res.get('win_rate', 0)
        
        s12_return = s12_res.get('total_return_pct', 0)
        s12_trades = s12_res.get('total_trades', 0)
        s12_win_rate = s12_res.get('win_rate', 0)
        
        print(f"\n📊 RESULTS: {days}d")
        print(f"{'Strategy':<20} {'Trades':<10} {'Win Rate':<12} {'Return':<12}")
        print("-" * 70)
        print(f"{'S1 (Momentum)':<20} {s1_trades:<10} {s1_win_rate:<11.2f}% {s1_return:<11.2f}%")
        print(f"{'S1.2 (Events)':<20} {s12_trades:<10} {s12_win_rate:<11.2f}% {s12_return:<11.2f}%")
        
        improvement = s12_return - s1_return
        print(f"\nImprovement: {improvement:+.2f}%")
        
        results.append({
            'period': f"{days}d",
            's1': s1_res,
            's1_2': s12_res,
            'improvement': improvement
        })
    
    # Save
    output = Path('/tmp/AlphaTrades/backtest_data/quick_comparison.json')
    with open(output, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    print(f"\n✅ Results saved to {output}")
    
    return results

if __name__ == '__main__':
    run_quick_comparison()
