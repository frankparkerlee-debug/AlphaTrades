"""Test Strategy 1.2 with 90-day period"""
from datetime import datetime, timedelta
from strategy1_2_backtest_engine import Strategy12Backtest

# Test 90-day period to catch earnings and news events
end_date = datetime.now()
start_date = end_date - timedelta(days=90)

print(f"Testing Strategy 1.2: {start_date.date()} to {end_date.date()}")
print(f"This period should capture Q1 2026 earnings season")

bt = Strategy12Backtest(start_date, end_date)
bt.fetch_data()
results = bt.run_backtest()
bt.save_results()

print(f"\n{'='*60}")
print(f"✅ 90-DAY TEST COMPLETE")
print(f"{'='*60}")
print(f"Total Trades: {results['total_trades']}")
print(f"Win Rate: {results['win_rate']:.2f}%")
print(f"Total Return: {results['total_return_pct']:.2f}%")
print(f"Final Capital: ${results['final_capital']:.2f}")

if results.get('catalyst_performance'):
    print(f"\n📊 Catalyst Performance:")
    for cat_type, perf in results['catalyst_performance'].items():
        print(f"  {cat_type.upper()}: {perf['trades']} trades, {perf['win_rate']:.1f}% win rate, {perf['avg_return']:.2f}% avg")

if results['total_trades'] > 0:
    print(f"\n📋 Sample Trades:")
    for trade in results['trades'][:5]:
        print(f"  {trade['ticker']} ({trade['catalyst_type']}): {trade['entry_date']} → {trade['exit_date']}, "
              f"{trade['pnl_pct']:.2f}% ({trade['exit_reason']})")
