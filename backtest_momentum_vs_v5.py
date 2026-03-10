#!/usr/bin/env python3
"""
Full P/L Backtest: Momentum Scorer vs V5 Scorer
Simulates actual trades and calculates profitability
"""

import os
os.environ['DATABASE_URL'] = os.getenv('DATABASE_URL', 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db')

from datetime import datetime, timedelta
from alpaca_client import AlpacaClient
from scorer_v5 import get_v5_scorer
from scorer_momentum import get_momentum_scorer
import time

# Backtest parameters
TICKERS = ['AMD', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'AVGO']
POSITION_SIZE = 120  # $120 per trade (20% of $600)
STOP_LOSS_PCT = -30  # -30% on option
PROFIT_TARGET_PCT = 50  # +50% on option

# Grade thresholds for entry
V5_MIN_GRADE = ['A+', 'A', 'A-', 'B+']  # V5 rarely hits these with current logic
MOMENTUM_MIN_GRADE = ['A+', 'A', 'A-', 'B+', 'B']  # More trades with momentum

def simulate_option_trade(stock_move_pct, position_size, direction='call'):
    """
    Simulate option P/L based on stock movement
    Delta-adjusted: assume 0.45 delta for ATM options
    """
    delta = 0.45
    
    # Option moves ~45% of stock move (delta effect)
    option_move_pct = stock_move_pct * delta * 100  # Convert to % for option
    
    # Check if hit stop or target
    if option_move_pct <= STOP_LOSS_PCT:
        # Hit stop loss
        pnl = position_size * (STOP_LOSS_PCT / 100)
        exit_reason = 'STOP'
    elif option_move_pct >= PROFIT_TARGET_PCT:
        # Hit profit target
        pnl = position_size * (PROFIT_TARGET_PCT / 100)
        exit_reason = 'TARGET'
    else:
        # Held to expiration (next day close)
        pnl = position_size * (option_move_pct / 100)
        exit_reason = 'EXPIRE'
    
    # Cap losses at -100% (options can't go below 0)
    pnl = max(pnl, -position_size)
    
    return pnl, exit_reason

def run_backtest_day(scorer, min_grades, scorer_name):
    """
    Run backtest for one day with given scorer
    Returns: list of trades
    """
    alpaca = AlpacaClient()
    trades = []
    
    # Get SPY
    try:
        spy_quote = alpaca.get_snapshot('SPY')
        spy_current = spy_quote.get('c', 0)
        spy_prev = spy_quote.get('pc', spy_current)
        market_data = {
            'is_up': spy_current >= spy_prev,
            'change_pct': ((spy_current - spy_prev) / spy_prev * 100) if spy_prev else 0
        }
    except:
        market_data = {'is_up': True, 'change_pct': 0}
    
    for ticker in TICKERS:
        try:
            # Get current quote
            quote = alpaca.get_snapshot(ticker)
            stock_price = quote.get('c', 0)
            open_price = quote.get('o', 0)
            high = quote.get('h', 0)
            low = quote.get('l', 0)
            volume = quote.get('v', 0)
            prev_close = quote.get('pc', stock_price)
            
            if not stock_price:
                continue
            
            # Get volume average
            bars_response = alpaca.get_bars(ticker, timeframe='1Day', limit=20)
            bars = bars_response.get('bars', []) if bars_response else []
            avg_volume = sum(bar['v'] for bar in bars) / len(bars) if bars else volume
            
            quote_data = {
                'open': open_price,
                'high': high,
                'low': low,
                'current': stock_price,
                'volume': volume,
                'avg_volume': avg_volume
            }
            
            # Score with algorithm
            result = scorer.score_ticker(ticker, quote_data, market_data)
            
            # Check if meets entry criteria
            if result['grade'] not in min_grades:
                continue
            
            # ENTER TRADE
            direction = result.get('direction', 'CALL')
            entry_price = stock_price
            
            # Simulate next-day outcome (use intraday as proxy for "next day move")
            # In real backtest would fetch T+1 data
            # For now, assume move = current day's close vs open
            day_move_pct = ((stock_price - open_price) / open_price) if open_price > 0 else 0
            
            # Simulate option P/L
            pnl, exit_reason = simulate_option_trade(day_move_pct, POSITION_SIZE, direction)
            
            trades.append({
                'ticker': ticker,
                'scorer': scorer_name,
                'entry_price': entry_price,
                'grade': result['grade'],
                'score': result['score'],
                'direction': direction,
                'pnl': pnl,
                'pnl_pct': (pnl / POSITION_SIZE) * 100,
                'exit_reason': exit_reason
            })
            
        except Exception as e:
            print(f"Error processing {ticker}: {e}")
            continue
    
    return trades

def main():
    print("="*80)
    print("💰 PROFITABILITY BACKTEST: Momentum vs V5")
    print("="*80)
    print()
    print(f"Position Size: ${POSITION_SIZE}")
    print(f"Stop Loss: {STOP_LOSS_PCT}%")
    print(f"Profit Target: {PROFIT_TARGET_PCT}%")
    print(f"Testing: {len(TICKERS)} tickers on TODAY's data")
    print()
    
    # Run V5 backtest
    print("Running V5 backtest...")
    v5_scorer = get_v5_scorer()
    v5_trades = run_backtest_day(v5_scorer, V5_MIN_GRADE, 'V5')
    
    # Run Momentum backtest
    print("Running Momentum backtest...")
    momentum_scorer = get_momentum_scorer()
    momentum_trades = run_backtest_day(momentum_scorer, MOMENTUM_MIN_GRADE, 'MOMENTUM')
    
    print()
    print("="*80)
    print("📊 BACKTEST RESULTS")
    print("="*80)
    print()
    
    # V5 Results
    print("V5 SCORER (Volume-Focused):")
    print(f"  Trades taken: {len(v5_trades)}")
    print(f"  Min grade required: {', '.join(V5_MIN_GRADE)}")
    
    if v5_trades:
        v5_total_pnl = sum(t['pnl'] for t in v5_trades)
        v5_wins = sum(1 for t in v5_trades if t['pnl'] > 0)
        v5_losses = sum(1 for t in v5_trades if t['pnl'] <= 0)
        v5_win_rate = (v5_wins / len(v5_trades)) * 100 if v5_trades else 0
        v5_avg_win = sum(t['pnl'] for t in v5_trades if t['pnl'] > 0) / v5_wins if v5_wins > 0 else 0
        v5_avg_loss = sum(t['pnl'] for t in v5_trades if t['pnl'] <= 0) / v5_losses if v5_losses > 0 else 0
        
        print(f"  Total P/L: ${v5_total_pnl:.2f}")
        print(f"  Win Rate: {v5_win_rate:.1f}% ({v5_wins}W / {v5_losses}L)")
        print(f"  Avg Win: ${v5_avg_win:.2f}")
        print(f"  Avg Loss: ${v5_avg_loss:.2f}")
        
        print(f"\n  Trades:")
        for t in v5_trades:
            result_symbol = "✅" if t['pnl'] > 0 else "❌"
            print(f"    {result_symbol} {t['ticker']:6s} {t['grade']:3s} ({t['score']:3d}) → ${t['pnl']:+7.2f} ({t['pnl_pct']:+6.1f}%)")
    else:
        print(f"  ⚠️  NO TRADES TAKEN (no signals met minimum grade)")
    
    print()
    
    # Momentum Results
    print("MOMENTUM SCORER (Price-Focused):")
    print(f"  Trades taken: {len(momentum_trades)}")
    print(f"  Min grade required: {', '.join(MOMENTUM_MIN_GRADE)}")
    
    if momentum_trades:
        mom_total_pnl = sum(t['pnl'] for t in momentum_trades)
        mom_wins = sum(1 for t in momentum_trades if t['pnl'] > 0)
        mom_losses = sum(1 for t in momentum_trades if t['pnl'] <= 0)
        mom_win_rate = (mom_wins / len(momentum_trades)) * 100 if momentum_trades else 0
        mom_avg_win = sum(t['pnl'] for t in momentum_trades if t['pnl'] > 0) / mom_wins if mom_wins > 0 else 0
        mom_avg_loss = sum(t['pnl'] for t in momentum_trades if t['pnl'] <= 0) / mom_losses if mom_losses > 0 else 0
        
        print(f"  Total P/L: ${mom_total_pnl:.2f}")
        print(f"  Win Rate: {mom_win_rate:.1f}% ({mom_wins}W / {mom_losses}L)")
        print(f"  Avg Win: ${mom_avg_win:.2f}")
        print(f"  Avg Loss: ${mom_avg_loss:.2f}")
        
        print(f"\n  Trades:")
        for t in momentum_trades:
            result_symbol = "✅" if t['pnl'] > 0 else "❌"
            print(f"    {result_symbol} {t['ticker']:6s} {t['grade']:3s} ({t['score']:3d}) → ${t['pnl']:+7.2f} ({t['pnl_pct']:+6.1f}%)")
    else:
        print(f"  ⚠️  NO TRADES TAKEN (no signals met minimum grade)")
    
    print()
    print("="*80)
    print("💡 COMPARISON")
    print("="*80)
    print()
    
    if v5_trades and momentum_trades:
        pnl_diff = mom_total_pnl - v5_total_pnl
        trade_diff = len(momentum_trades) - len(v5_trades)
        
        print(f"Trade Count: Momentum took {abs(trade_diff)} {'MORE' if trade_diff > 0 else 'FEWER'} trades")
        print(f"Total P/L: Momentum made ${pnl_diff:+.2f} {'more' if pnl_diff > 0 else 'less'}")
        print(f"Win Rate: {mom_win_rate - v5_win_rate:+.1f}% difference")
    elif not v5_trades and momentum_trades:
        print(f"✅ MOMENTUM FOUND {len(momentum_trades)} SIGNALS (V5 found ZERO)")
        print(f"   Momentum P/L: ${mom_total_pnl:.2f}")
    elif v5_trades and not momentum_trades:
        print(f"⚠️  V5 found {len(v5_trades)} signals, Momentum found zero")
    else:
        print("⚠️  Neither algorithm found tradeable signals today")
    
    print()
    print("="*80)
    print("🔍 LIMITATIONS OF THIS BACKTEST")
    print("="*80)
    print()
    print("⚠️  This uses TODAY's data only (single-day sample)")
    print("⚠️  Real backtest needs 6+ months of historical data")
    print("⚠️  Entry/exit simulation is simplified (same-day proxy)")
    print("⚠️  Options pricing uses delta model (not real option bars)")
    print()
    print("To properly evaluate, need to:")
    print("  1. Run on 2024-2025 historical data (500+ days)")
    print("  2. Simulate T+1 entries (enter next day at open)")
    print("  3. Track intraday for stop/target hits")
    print("  4. Use real option chain data where available")
    print()

if __name__ == '__main__':
    main()
