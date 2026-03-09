#!/usr/bin/env python3
"""
Full Historical Backtest: Momentum vs V5
Uses minute bar data from database (2024-01-01 to 2026-02-28)
Starting capital: $2500
"""

import os
os.environ['DATABASE_URL'] = os.getenv('DATABASE_URL', 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db')

from models import get_session, MinuteBar
from scorer_v5 import get_v5_scorer
from scorer_momentum import get_momentum_scorer
from datetime import datetime, timedelta, date
from sqlalchemy import func, and_
import pytz

# Backtest Configuration
STARTING_CAPITAL = 2500
POSITION_SIZE_PCT = 0.20  # 20% of capital per trade
MAX_POSITIONS = 3  # Max concurrent positions
STOP_LOSS_PCT = -30  # Option stop loss
PROFIT_TARGET_PCT = 50  # Option profit target
MAX_HOLD_DAYS = 3  # Max hold period

# Entry criteria
V5_MIN_SCORE = 80  # A- grade
MOMENTUM_MIN_SCORE = 60  # B grade

# Test period
START_DATE = date(2024, 1, 1)
END_DATE = date(2026, 2, 28)

# Tickers to backtest
TICKERS = ['AMD', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'AVGO', 
           'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM']

class BacktestEngine:
    def __init__(self, scorer, scorer_name, min_score, starting_capital):
        self.scorer = scorer
        self.scorer_name = scorer_name
        self.min_score = min_score
        self.capital = starting_capital
        self.starting_capital = starting_capital
        self.positions = []
        self.closed_trades = []
        self.daily_equity = []
        self.session = get_session()
        
    def get_daily_bars(self, ticker, target_date):
        """Get OHLCV for a specific day"""
        start_dt = datetime.combine(target_date, datetime.min.time()).replace(tzinfo=pytz.UTC)
        end_dt = start_dt + timedelta(days=1)
        
        bars = self.session.query(MinuteBar).filter(
            and_(
                MinuteBar.ticker == ticker,
                MinuteBar.timestamp >= start_dt,
                MinuteBar.timestamp < end_dt
            )
        ).order_by(MinuteBar.timestamp).all()
        
        if not bars:
            return None
        
        return {
            'open': float(bars[0].open),
            'high': max(float(b.high) for b in bars),
            'low': min(float(b.low) for b in bars),
            'close': float(bars[-1].close),
            'volume': sum(int(b.volume) for b in bars),
            'bars': bars
        }
    
    def get_volume_average(self, ticker, end_date, days=20):
        """Get 20-day average volume"""
        start_dt = datetime.combine(end_date - timedelta(days=days*2), datetime.min.time()).replace(tzinfo=pytz.UTC)
        end_dt = datetime.combine(end_date, datetime.max.time()).replace(tzinfo=pytz.UTC)
        
        # Get daily volumes
        daily_volumes = self.session.query(
            func.date(MinuteBar.timestamp).label('day'),
            func.sum(MinuteBar.volume).label('volume')
        ).filter(
            and_(
                MinuteBar.ticker == ticker,
                MinuteBar.timestamp >= start_dt,
                MinuteBar.timestamp < end_dt
            )
        ).group_by(func.date(MinuteBar.timestamp)).all()
        
        if len(daily_volumes) < days:
            return None
        
        # Take last 20 days
        recent_volumes = [float(v.volume) for v in daily_volumes[-days:]]
        return sum(recent_volumes) / len(recent_volumes)
    
    def calculate_option_pnl(self, stock_entry, stock_current, position_size, direction):
        """Calculate option P/L with delta model"""
        delta = 0.45  # ATM option delta
        
        stock_move_pct = ((stock_current - stock_entry) / stock_entry)
        
        # Adjust for direction
        if direction == 'PUT':
            stock_move_pct = -stock_move_pct
        
        # Option moves with delta
        option_move_pct = stock_move_pct * delta * 100
        
        # Calculate P/L
        pnl = position_size * (option_move_pct / 100)
        pnl = max(pnl, -position_size)  # Cap at -100%
        
        return pnl, option_move_pct
    
    def check_exits(self, current_date):
        """Check if any positions hit stops/targets or max hold"""
        for position in self.positions[:]:
            # Get current day bars
            day_bars = self.get_daily_bars(position['ticker'], current_date)
            if not day_bars:
                continue
            
            # Check intraday for stop/target
            for bar in day_bars['bars']:
                stock_price = float(bar.close)
                pnl, option_pct = self.calculate_option_pnl(
                    position['entry_price'],
                    stock_price,
                    position['size'],
                    position['direction']
                )
                
                # Check stop loss
                if option_pct <= STOP_LOSS_PCT:
                    self.close_position(position, stock_price, 'STOP', pnl)
                    break
                
                # Check profit target
                if option_pct >= PROFIT_TARGET_PCT:
                    self.close_position(position, stock_price, 'TARGET', pnl)
                    break
            
            # Check max hold days
            hold_days = (current_date - position['entry_date']).days
            if hold_days >= MAX_HOLD_DAYS and position in self.positions:
                # Exit at close
                stock_price = day_bars['close']
                pnl, _ = self.calculate_option_pnl(
                    position['entry_price'],
                    stock_price,
                    position['size'],
                    position['direction']
                )
                self.close_position(position, stock_price, 'MAX_HOLD', pnl)
    
    def close_position(self, position, exit_price, reason, pnl):
        """Close a position"""
        self.capital += pnl
        position['exit_price'] = exit_price
        position['exit_reason'] = reason
        position['pnl'] = pnl
        position['pnl_pct'] = (pnl / position['size']) * 100
        
        self.closed_trades.append(position)
        self.positions.remove(position)
    
    def run(self):
        """Run backtest"""
        print(f"\n🔄 Running {self.scorer_name} backtest...")
        print(f"   Period: {START_DATE} to {END_DATE}")
        print(f"   Starting capital: ${self.starting_capital:,.2f}")
        print(f"   Min score: {self.min_score}")
        
        current_date = START_DATE
        days_processed = 0
        signals_found = 0
        trades_taken = 0
        
        while current_date <= END_DATE:
            days_processed += 1
            
            # Progress indicator
            if days_processed % 50 == 0:
                print(f"   Progress: {current_date} | Capital: ${self.capital:,.2f} | Trades: {trades_taken}")
            
            # Check exits first
            self.check_exits(current_date)
            
            # Look for new signals (if have room for more positions)
            if len(self.positions) < MAX_POSITIONS:
                for ticker in TICKERS:
                    # Get today's data
                    day_bars = self.get_daily_bars(ticker, current_date)
                    if not day_bars:
                        continue
                    
                    # Get volume average
                    avg_volume = self.get_volume_average(ticker, current_date)
                    if not avg_volume:
                        continue
                    
                    # Build quote data
                    quote_data = {
                        'open': day_bars['open'],
                        'high': day_bars['high'],
                        'low': day_bars['low'],
                        'current': day_bars['close'],
                        'volume': day_bars['volume'],
                        'avg_volume': avg_volume
                    }
                    
                    # Score
                    result = self.scorer.score_ticker(ticker, quote_data, {'is_up': True, 'change_pct': 0})
                    
                    # Check if meets criteria
                    if result['score'] >= self.min_score:
                        signals_found += 1
                        
                        # Enter trade (next day at open)
                        next_date = current_date + timedelta(days=1)
                        next_bars = self.get_daily_bars(ticker, next_date)
                        
                        if next_bars and len(self.positions) < MAX_POSITIONS:
                            position_size = self.capital * POSITION_SIZE_PCT
                            
                            position = {
                                'ticker': ticker,
                                'entry_date': next_date,
                                'entry_price': next_bars['open'],
                                'direction': result.get('direction', 'CALL'),
                                'size': position_size,
                                'score': result['score'],
                                'grade': result['grade']
                            }
                            
                            self.positions.append(position)
                            trades_taken += 1
            
            # Record daily equity
            total_equity = self.capital
            for pos in self.positions:
                # Mark-to-market open positions
                day_bars = self.get_daily_bars(pos['ticker'], current_date)
                if day_bars:
                    pnl, _ = self.calculate_option_pnl(pos['entry_price'], day_bars['close'], pos['size'], pos['direction'])
                    total_equity += pnl
            
            self.daily_equity.append({
                'date': current_date,
                'equity': total_equity
            })
            
            current_date += timedelta(days=1)
        
        print(f"   ✅ Complete! Processed {days_processed} days")
        print(f"   Signals found: {signals_found}")
        print(f"   Trades taken: {trades_taken}")
        
    def get_results(self):
        """Calculate final results"""
        if not self.closed_trades:
            return None
        
        total_trades = len(self.closed_trades)
        wins = sum(1 for t in self.closed_trades if t['pnl'] > 0)
        losses = total_trades - wins
        
        total_pnl = sum(t['pnl'] for t in self.closed_trades)
        win_rate = (wins / total_trades) * 100 if total_trades > 0 else 0
        
        avg_win = sum(t['pnl'] for t in self.closed_trades if t['pnl'] > 0) / wins if wins > 0 else 0
        avg_loss = sum(t['pnl'] for t in self.closed_trades if t['pnl'] <= 0) / losses if losses > 0 else 0
        
        final_capital = self.capital
        total_return_pct = ((final_capital - self.starting_capital) / self.starting_capital) * 100
        
        # Max drawdown
        peak = self.starting_capital
        max_dd = 0
        for eq in self.daily_equity:
            if eq['equity'] > peak:
                peak = eq['equity']
            dd = ((eq['equity'] - peak) / peak) * 100
            if dd < max_dd:
                max_dd = dd
        
        return {
            'total_trades': total_trades,
            'wins': wins,
            'losses': losses,
            'win_rate': win_rate,
            'total_pnl': total_pnl,
            'avg_win': avg_win,
            'avg_loss': avg_loss,
            'final_capital': final_capital,
            'total_return_pct': total_return_pct,
            'max_drawdown': max_dd,
            'trades': self.closed_trades
        }

def main():
    print("="*80)
    print("💰 FULL HISTORICAL BACKTEST: Momentum vs V5")
    print("="*80)
    print(f"Starting Capital: ${STARTING_CAPITAL:,.2f}")
    print(f"Period: {START_DATE} to {END_DATE}")
    print(f"Position Size: {POSITION_SIZE_PCT*100:.0f}% per trade")
    print(f"Max Positions: {MAX_POSITIONS}")
    print(f"Stop Loss: {STOP_LOSS_PCT}% | Target: {PROFIT_TARGET_PCT}%")
    print()
    
    # Check if minute bar data exists
    session = get_session()
    bar_count = session.query(func.count(MinuteBar.id)).scalar()
    print(f"📊 Minute bars in database: {bar_count:,}")
    
    if bar_count < 100000:
        print()
        print("⚠️  WARNING: Limited minute bar data available!")
        print("   For best results, run minute data download first:")
        print("   python download_minute_data.py")
        print()
        response = input("Continue anyway? (y/n): ")
        if response.lower() != 'y':
            return
    
    session.close()
    
    # Run V5 backtest
    v5_engine = BacktestEngine(get_v5_scorer(), 'V5', V5_MIN_SCORE, STARTING_CAPITAL)
    v5_engine.run()
    v5_results = v5_engine.get_results()
    
    # Run Momentum backtest
    momentum_engine = BacktestEngine(get_momentum_scorer(), 'MOMENTUM', MOMENTUM_MIN_SCORE, STARTING_CAPITAL)
    momentum_engine.run()
    momentum_results = momentum_engine.get_results()
    
    # Display results
    print()
    print("="*80)
    print("📊 BACKTEST RESULTS")
    print("="*80)
    print()
    
    for name, results in [('V5 (Volume-Focused)', v5_results), ('MOMENTUM (Price-Focused)', momentum_results)]:
        print(f"{name}:")
        
        if not results:
            print("  ⚠️  NO TRADES TAKEN")
            print()
            continue
        
        print(f"  Starting Capital: ${STARTING_CAPITAL:,.2f}")
        print(f"  Final Capital:    ${results['final_capital']:,.2f}")
        print(f"  Total Return:     {results['total_return_pct']:+.2f}%")
        print(f"  Total P/L:        ${results['total_pnl']:+,.2f}")
        print()
        print(f"  Total Trades:     {results['total_trades']}")
        print(f"  Win Rate:         {results['win_rate']:.1f}% ({results['wins']}W / {results['losses']}L)")
        print(f"  Avg Win:          ${results['avg_win']:.2f}")
        print(f"  Avg Loss:         ${results['avg_loss']:.2f}")
        print(f"  Max Drawdown:     {results['max_drawdown']:.2f}%")
        print()
    
    # Comparison
    if v5_results and momentum_results:
        print("="*80)
        print("💡 COMPARISON")
        print("="*80)
        print()
        
        return_diff = momentum_results['total_return_pct'] - v5_results['total_return_pct']
        pnl_diff = momentum_results['total_pnl'] - v5_results['total_pnl']
        trade_diff = momentum_results['total_trades'] - v5_results['total_trades']
        wr_diff = momentum_results['win_rate'] - v5_results['win_rate']
        
        print(f"Return Difference:     {return_diff:+.2f}%")
        print(f"P/L Difference:        ${pnl_diff:+,.2f}")
        print(f"Trade Count Diff:      {trade_diff:+d} trades")
        print(f"Win Rate Difference:   {wr_diff:+.1f}%")
        print()
        
        if return_diff > 0:
            print(f"✅ MOMENTUM OUTPERFORMED by {return_diff:.2f}%")
        elif return_diff < 0:
            print(f"⚠️  V5 OUTPERFORMED by {abs(return_diff):.2f}%")
        else:
            print(f"⚪ EQUAL PERFORMANCE")
    
    print()
    print("="*80)

if __name__ == '__main__':
    main()
