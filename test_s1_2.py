"""Quick test of Strategy 1.2"""
from datetime import datetime, timedelta
from strategy1_2_backtest_engine import Strategy12Backtest

# Test 30-day period
end_date = datetime.now()
start_date = end_date - timedelta(days=30)

print(f"Testing Strategy 1.2: {start_date.date()} to {end_date.date()}")

bt = Strategy12Backtest(start_date, end_date)
bt.fetch_data()
results = bt.run_backtest()

print(f"\n✅ TEST COMPLETE")
print(f"Total Trades: {results['total_trades']}")
print(f"Win Rate: {results['win_rate']:.2f}%")
print(f"Total Return: {results['total_return_pct']:.2f}%")
print(f"Final Capital: ${results['final_capital']:.2f}")

if results.get('catalyst_performance'):
    print(f"\n📊 Catalyst Performance:")
    for cat_type, perf in results['catalyst_performance'].items():
        print(f"  {cat_type}: {perf['trades']} trades, {perf['win_rate']:.1f}% win rate, {perf['avg_return']:.2f}% avg return")
