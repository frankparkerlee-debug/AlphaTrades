#!/usr/bin/env python3
"""
Grade-Based Scaling Exits Backtest - OPTIMIZED VERSION
Pre-loads data to avoid slow database queries
Starting capital: $2500
"""

import os
os.environ['DATABASE_URL'] = os.getenv('DATABASE_URL', 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db')

from models import get_session, MinuteBar
from scorer_v5 import get_v5_scorer
from datetime import datetime, timedelta, date
from sqlalchemy import func, and_
import pytz
from collections import defaultdict

# Backtest Configuration
STARTING_CAPITAL = 2500
POSITION_SIZE_PCT = 0.20  # 20% of capital per trade
MAX_POSITIONS = 3  # Max concurrent positions
STOP_LOSS_PCT = -50  # Option stop loss (full position)
MAX_HOLD_HOURS = 36  # Max hold period in hours

# Exit targets (simplified - no technical indicators)
T1_TARGET = 50   # +50% option gain
T2_TARGET = 100  # +100% option gain
T3_TARGET = 150  # +150% option gain
T3_TRAILING_STOP_PCT = -25  # -25% from peak for T3 runner

# Entry criteria
V5_MIN_SCORE = 80  # A- grade

# Test period
START_DATE = date(2024, 1, 1)
END_DATE = date(2025, 12, 31)

# Tickers to backtest
TICKERS = ['AMD', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'AVGO', 
           'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM']

# Grade-based tranche sizing
TRANCHE_SIZES = {
    'A+': {'t1': 0.25, 't2': 0.35, 't3': 0.40},
    'A':  {'t1': 0.25, 't2': 0.35, 't3': 0.40},
    'A-': {'t1': 0.33, 't2': 0.33, 't3': 0.34},
    'B+': {'t1': 0.33, 't2': 0.33, 't3': 0.34},
    'B':  {'t1': 0.50, 't2': 0.50, 't3': 0.00},
    'B-': {'t1': 0.50, 't2': 0.50, 't3': 0.00},
}

def load_all_data(session, tickers, start_date, end_date):
    """Pre-load all minute bar data into memory"""
    print("📥 Loading minute bar data into memory...", flush=True)
    
    start_dt = datetime.combine(start_date, datetime.min.time()).replace(tzinfo=pytz.UTC)
    end_dt = datetime.combine(end_date, datetime.max.time()).replace(tzinfo=pytz.UTC)
    
    # Query all bars at once
    bars = session.query(MinuteBar).filter(
        and_(
            MinuteBar.ticker.in_(tickers),
            MinuteBar.timestamp >= start_dt,
            MinuteBar.timestamp < end_dt
        )
    ).order_by(MinuteBar.ticker, MinuteBar.timestamp).all()
    
    print(f"   Loaded {len(bars):,} minute bars", flush=True)
    
    # Organize by ticker and date
    data = defaultdict(lambda: defaultdict(list))
    
    for bar in bars:
        ticker = bar.ticker
        day = bar.timestamp.date()
        data[ticker][day].append({
            'timestamp': bar.timestamp,
            'open': float(bar.open),
            'high': float(bar.high),
            'low': float(bar.low),
            'close': float(bar.close),
            'volume': int(bar.volume)
        })
    
    # Calculate daily OHLCV
    daily_bars = defaultdict(dict)
    for ticker in data:
        for day in data[ticker]:
            bars_list = data[ticker][day]
            if bars_list:
                daily_bars[ticker][day] = {
                    'open': bars_list[0]['open'],
                    'high': max(b['high'] for b in bars_list),
                    'low': min(b['low'] for b in bars_list),
                    'close': bars_list[-1]['close'],
                    'volume': sum(b['volume'] for b in bars_list),
                    'bars': bars_list
                }
    
    # Calculate 20-day volume averages
    volume_avgs = defaultdict(dict)
    for ticker in daily_bars:
        sorted_dates = sorted(daily_bars[ticker].keys())
        for i, day in enumerate(sorted_dates):
            if i >= 20:
                recent_volumes = [daily_bars[ticker][d]['volume'] for d in sorted_dates[i-20:i]]
                volume_avgs[ticker][day] = sum(recent_volumes) / len(recent_volumes)
    
    print(f"   Processed {len(daily_bars)} tickers", flush=True)
    print(f"   ✅ Data loaded successfully\n", flush=True)
    
    return daily_bars, volume_avgs

class BacktestEngine:
    def __init__(self, scorer, scorer_name, min_score, starting_capital, daily_bars, volume_avgs):
        self.scorer = scorer
        self.scorer_name = scorer_name
        self.min_score = min_score
        self.capital = starting_capital
        self.starting_capital = starting_capital
        self.positions = []
        self.closed_trades = []
        self.daily_equity = []
        self.daily_bars = daily_bars
        self.volume_avgs = volume_avgs
        
    def debug(self, msg):
        """Print debug message"""
        print(f"[DEBUG] {msg}", flush=True)
        
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
    
    def get_tranche_sizes(self, grade):
        """Get tranche sizing based on grade"""
        # Normalize grade to lookup key
        if grade in TRANCHE_SIZES:
            return TRANCHE_SIZES[grade]
        
        # Default to B sizing if grade not found
        self.debug(f"Grade {grade} not in TRANCHE_SIZES, using B sizing")
        return TRANCHE_SIZES['B']
    
    def check_exits(self, current_date):
        """Check if any tranches hit targets/stops"""
        for position in self.positions[:]:
            # Get current day bars
            ticker = position['ticker']
            day_bars = self.daily_bars[ticker].get(current_date)
            
            if not day_bars:
                continue
            
            # Calculate hours held
            entry_dt = datetime.combine(position['entry_date'], datetime.min.time())
            current_dt = datetime.combine(current_date, datetime.min.time())
            hours_held = (current_dt - entry_dt).total_seconds() / 3600
            
            # Check intraday for stop/target
            for bar in day_bars['bars']:
                stock_price = bar['close']
                
                # Check each active tranche
                for tranche_name in ['t1', 't2', 't3']:
                    tranche = position['tranches'][tranche_name]
                    
                    if tranche['size'] == 0 or tranche['exited']:
                        continue
                    
                    pnl, option_pct = self.calculate_option_pnl(
                        position['entry_price'],
                        stock_price,
                        tranche['size'],
                        position['direction']
                    )
                    
                    # Update peak for trailing stop (T3 only)
                    if tranche_name == 't3' and option_pct > tranche['peak_pct']:
                        tranche['peak_pct'] = option_pct
                    
                    # Check stop loss (full position stop)
                    if option_pct <= STOP_LOSS_PCT:
                        self.debug(f"STOP HIT: {position['ticker']} {tranche_name} @ {option_pct:.1f}%")
                        self.close_tranche(position, tranche_name, stock_price, 'STOP', pnl)
                        continue
                    
                    # Check targets
                    if tranche_name == 't1' and option_pct >= T1_TARGET:
                        self.debug(f"T1 TARGET: {position['ticker']} @ {option_pct:.1f}%")
                        self.close_tranche(position, tranche_name, stock_price, 'T1_TARGET', pnl)
                        continue
                    
                    if tranche_name == 't2' and option_pct >= T2_TARGET:
                        self.debug(f"T2 TARGET: {position['ticker']} @ {option_pct:.1f}%")
                        self.close_tranche(position, tranche_name, stock_price, 'T2_TARGET', pnl)
                        continue
                    
                    if tranche_name == 't3' and option_pct >= T3_TARGET:
                        self.debug(f"T3 TARGET: {position['ticker']} @ {option_pct:.1f}%")
                        self.close_tranche(position, tranche_name, stock_price, 'T3_TARGET', pnl)
                        continue
                    
                    # Check trailing stop for T3
                    if tranche_name == 't3' and tranche['peak_pct'] > 0:
                        drawdown_from_peak = ((option_pct - tranche['peak_pct']) / tranche['peak_pct']) * 100
                        if drawdown_from_peak <= T3_TRAILING_STOP_PCT:
                            self.debug(f"T3 TRAILING STOP: {position['ticker']} @ {option_pct:.1f}% (peak: {tranche['peak_pct']:.1f}%)")
                            self.close_tranche(position, tranche_name, stock_price, 'T3_TRAILING', pnl)
                            continue
            
            # Check max hold time
            if hours_held >= MAX_HOLD_HOURS:
                self.debug(f"MAX HOLD: {position['ticker']} @ {hours_held:.1f} hours")
                # Close all remaining tranches
                stock_price = day_bars['close']
                for tranche_name in ['t1', 't2', 't3']:
                    tranche = position['tranches'][tranche_name]
                    if tranche['size'] > 0 and not tranche['exited']:
                        pnl, _ = self.calculate_option_pnl(
                            position['entry_price'],
                            stock_price,
                            tranche['size'],
                            position['direction']
                        )
                        self.close_tranche(position, tranche_name, stock_price, 'MAX_HOLD', pnl)
            
            # Remove position if all tranches closed
            if all(position['tranches'][t]['exited'] for t in ['t1', 't2', 't3']):
                if position in self.positions:
                    self.positions.remove(position)
                    self.debug(f"POSITION CLOSED: {position['ticker']} (all tranches exited)")
    
    def close_tranche(self, position, tranche_name, exit_price, reason, pnl):
        """Close a single tranche"""
        tranche = position['tranches'][tranche_name]
        
        self.capital += pnl
        tranche['exit_price'] = exit_price
        tranche['exit_reason'] = reason
        tranche['pnl'] = pnl
        tranche['pnl_pct'] = (pnl / tranche['size']) * 100 if tranche['size'] > 0 else 0
        tranche['exited'] = True
        
        # Record closed trade
        self.closed_trades.append({
            'ticker': position['ticker'],
            'entry_date': position['entry_date'],
            'entry_price': position['entry_price'],
            'exit_price': exit_price,
            'direction': position['direction'],
            'score': position['score'],
            'grade': position['grade'],
            'tranche': tranche_name,
            'size': tranche['size'],
            'pnl': pnl,
            'pnl_pct': tranche['pnl_pct'],
            'exit_reason': reason
        })
    
    def run(self):
        """Run backtest"""
        print(f"\n🔄 Running {self.scorer_name} backtest with SCALING EXITS...", flush=True)
        print(f"   Period: {START_DATE} to {END_DATE}", flush=True)
        print(f"   Starting capital: ${self.starting_capital:,.2f}", flush=True)
        print(f"   Min score: {self.min_score}", flush=True)
        print(f"   Stop Loss: {STOP_LOSS_PCT}%", flush=True)
        print(f"   Targets: T1={T1_TARGET}%, T2={T2_TARGET}%, T3={T3_TARGET}% (trailing {T3_TRAILING_STOP_PCT}%)", flush=True)
        print(f"   Max Hold: {MAX_HOLD_HOURS} hours", flush=True)
        print()
        
        current_date = START_DATE
        days_processed = 0
        trading_days = 0
        signals_found = 0
        trades_taken = 0
        
        while current_date <= END_DATE:
            days_processed += 1
            
            # Check if we have market data for this day
            has_data = any(current_date in self.daily_bars[ticker] for ticker in TICKERS[:3])
            
            if has_data:
                trading_days += 1
                
                # Progress indicator every 10 trading days
                if trading_days % 10 == 0:
                    open_positions = len(self.positions)
                    print(f"   📅 Trading Day {trading_days} ({current_date}) | Capital: ${self.capital:,.2f} | Open: {open_positions} | Trades: {trades_taken}", flush=True)
            
            # Check exits first
            self.check_exits(current_date)
            
            # Look for new signals (if have room for more positions)
            if len(self.positions) < MAX_POSITIONS:
                for ticker in TICKERS:
                    # Get today's data
                    day_bars = self.daily_bars[ticker].get(current_date)
                    if not day_bars:
                        continue
                    
                    # Get volume average
                    avg_volume = self.volume_avgs[ticker].get(current_date)
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
                        next_bars = self.daily_bars[ticker].get(next_date)
                        
                        if next_bars and len(self.positions) < MAX_POSITIONS:
                            position_size = self.capital * POSITION_SIZE_PCT
                            
                            # Get tranche sizes based on grade
                            grade = result['grade']
                            tranche_pcts = self.get_tranche_sizes(grade)
                            
                            self.debug(f"ENTRY: {ticker} | Grade: {grade} | Score: {result['score']} | Size: ${position_size:.2f}")
                            self.debug(f"  Tranches: T1={tranche_pcts['t1']*100:.0f}%, T2={tranche_pcts['t2']*100:.0f}%, T3={tranche_pcts['t3']*100:.0f}%")
                            
                            position = {
                                'ticker': ticker,
                                'entry_date': next_date,
                                'entry_price': next_bars['open'],
                                'direction': result.get('direction', 'CALL'),
                                'score': result['score'],
                                'grade': grade,
                                'tranches': {
                                    't1': {
                                        'size': position_size * tranche_pcts['t1'],
                                        'exited': False,
                                        'peak_pct': 0,
                                        'pnl': 0,
                                        'exit_price': 0,
                                        'exit_reason': ''
                                    },
                                    't2': {
                                        'size': position_size * tranche_pcts['t2'],
                                        'exited': False,
                                        'peak_pct': 0,
                                        'pnl': 0,
                                        'exit_price': 0,
                                        'exit_reason': ''
                                    },
                                    't3': {
                                        'size': position_size * tranche_pcts['t3'],
                                        'exited': False,
                                        'peak_pct': 0,
                                        'pnl': 0,
                                        'exit_price': 0,
                                        'exit_reason': ''
                                    }
                                }
                            }
                            
                            self.positions.append(position)
                            trades_taken += 1
            
            # Record daily equity
            total_equity = self.capital
            for pos in self.positions:
                # Mark-to-market open positions
                day_bars = self.daily_bars[pos['ticker']].get(current_date)
                if day_bars:
                    for tranche_name in ['t1', 't2', 't3']:
                        tranche = pos['tranches'][tranche_name]
                        if tranche['size'] > 0 and not tranche['exited']:
                            pnl, _ = self.calculate_option_pnl(pos['entry_price'], day_bars['close'], tranche['size'], pos['direction'])
                            total_equity += pnl
            
            self.daily_equity.append({
                'date': current_date,
                'equity': total_equity
            })
            
            current_date += timedelta(days=1)
        
        print(f"\n   ✅ Complete! Processed {days_processed} calendar days ({trading_days} trading days)", flush=True)
        print(f"   Signals found: {signals_found}", flush=True)
        print(f"   Trades taken: {trades_taken} (positions with tranches)", flush=True)
        
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
        
        # Breakdown by tranche
        t1_trades = [t for t in self.closed_trades if t['tranche'] == 't1']
        t2_trades = [t for t in self.closed_trades if t['tranche'] == 't2']
        t3_trades = [t for t in self.closed_trades if t['tranche'] == 't3']
        
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
            'trades': self.closed_trades,
            't1_count': len(t1_trades),
            't2_count': len(t2_trades),
            't3_count': len(t3_trades),
            't1_pnl': sum(t['pnl'] for t in t1_trades),
            't2_pnl': sum(t['pnl'] for t in t2_trades),
            't3_pnl': sum(t['pnl'] for t in t3_trades)
        }

def main():
    print("🚀 Starting SCALING EXITS backtest (OPTIMIZED)...", flush=True)
    print("="*80)
    print("💰 GRADE-BASED SCALING EXITS BACKTEST")
    print("="*80)
    print(f"Starting Capital: ${STARTING_CAPITAL:,.2f}")
    print(f"Period: {START_DATE} to {END_DATE}")
    print(f"Position Size: {POSITION_SIZE_PCT*100:.0f}% per trade")
    print(f"Max Positions: {MAX_POSITIONS}")
    print(f"Stop Loss: {STOP_LOSS_PCT}% | Max Hold: {MAX_HOLD_HOURS} hours")
    print()
    print("Exit Targets:")
    print(f"  T1: {T1_TARGET}%")
    print(f"  T2: {T2_TARGET}%")
    print(f"  T3: {T3_TARGET}% (or trailing stop {T3_TRAILING_STOP_PCT}%)")
    print()
    print("Tranche Sizing by Grade:")
    for grade, sizes in TRANCHE_SIZES.items():
        print(f"  {grade:3s}: T1={sizes['t1']*100:>4.0f}% | T2={sizes['t2']*100:>4.0f}% | T3={sizes['t3']*100:>4.0f}%")
    print()
    
    # Load all data
    session = get_session()
    daily_bars, volume_avgs = load_all_data(session, TICKERS, START_DATE, END_DATE)
    session.close()
    
    # Run V5 backtest only
    v5_engine = BacktestEngine(get_v5_scorer(), 'V5', V5_MIN_SCORE, STARTING_CAPITAL, daily_bars, volume_avgs)
    v5_engine.run()
    v5_results = v5_engine.get_results()
    
    # Display results
    print()
    print("="*80)
    print("📊 BACKTEST RESULTS")
    print("="*80)
    print()
    
    if not v5_results:
        print("  ⚠️  NO TRADES TAKEN")
        print()
        return
    
    print(f"V5 Algorithm (Scaling Exits):")
    print(f"  Starting Capital: ${STARTING_CAPITAL:,.2f}")
    print(f"  Final Capital:    ${v5_results['final_capital']:,.2f}")
    print(f"  Total Return:     {v5_results['total_return_pct']:+.2f}%")
    print(f"  Total P/L:        ${v5_results['total_pnl']:+,.2f}")
    print()
    print(f"  Total Trades:     {v5_results['total_trades']} (tranches)")
    print(f"  Win Rate:         {v5_results['win_rate']:.1f}% ({v5_results['wins']}W / {v5_results['losses']}L)")
    print(f"  Avg Win:          ${v5_results['avg_win']:.2f}")
    print(f"  Avg Loss:         ${v5_results['avg_loss']:.2f}")
    print(f"  Max Drawdown:     {v5_results['max_drawdown']:.2f}%")
    print()
    print(f"  Tranche Breakdown:")
    print(f"    T1: {v5_results['t1_count']} exits | ${v5_results['t1_pnl']:+.2f}")
    print(f"    T2: {v5_results['t2_count']} exits | ${v5_results['t2_pnl']:+.2f}")
    print(f"    T3: {v5_results['t3_count']} exits | ${v5_results['t3_pnl']:+.2f}")
    print()
    
    # Save results to file
    output_path = '/tmp/AlphaTrades/scaling_exits_results.txt'
    with open(output_path, 'w') as f:
        f.write("="*80 + "\n")
        f.write("GRADE-BASED SCALING EXITS BACKTEST RESULTS\n")
        f.write("="*80 + "\n\n")
        
        f.write(f"Configuration:\n")
        f.write(f"  Period: {START_DATE} to {END_DATE}\n")
        f.write(f"  Starting Capital: ${STARTING_CAPITAL:,.2f}\n")
        f.write(f"  Position Size: {POSITION_SIZE_PCT*100:.0f}% per trade\n")
        f.write(f"  Stop Loss: {STOP_LOSS_PCT}%\n")
        f.write(f"  Max Hold: {MAX_HOLD_HOURS} hours\n")
        f.write(f"  Targets: T1={T1_TARGET}%, T2={T2_TARGET}%, T3={T3_TARGET}%\n")
        f.write(f"\n")
        
        f.write(f"Results:\n")
        f.write(f"  Final Capital:    ${v5_results['final_capital']:,.2f}\n")
        f.write(f"  Total Return:     {v5_results['total_return_pct']:+.2f}%\n")
        f.write(f"  Total P/L:        ${v5_results['total_pnl']:+,.2f}\n")
        f.write(f"  Total Trades:     {v5_results['total_trades']} (tranches)\n")
        f.write(f"  Win Rate:         {v5_results['win_rate']:.1f}% ({v5_results['wins']}W / {v5_results['losses']}L)\n")
        f.write(f"  Avg Win:          ${v5_results['avg_win']:.2f}\n")
        f.write(f"  Avg Loss:         ${v5_results['avg_loss']:.2f}\n")
        f.write(f"  Max Drawdown:     {v5_results['max_drawdown']:.2f}%\n")
        f.write(f"\n")
        
        f.write(f"Tranche Breakdown:\n")
        f.write(f"  T1: {v5_results['t1_count']} exits | ${v5_results['t1_pnl']:+.2f}\n")
        f.write(f"  T2: {v5_results['t2_count']} exits | ${v5_results['t2_pnl']:+.2f}\n")
        f.write(f"  T3: {v5_results['t3_count']} exits | ${v5_results['t3_pnl']:+.2f}\n")
        f.write(f"\n")
        
        f.write(f"="*80 + "\n")
        f.write(f"COMPARISON TO ORIGINAL BACKTEST\n")
        f.write(f"="*80 + "\n\n")
        
        original_return = 6.13  # From original backtest
        improvement = v5_results['total_return_pct'] - original_return
        
        f.write(f"Original (Fixed Exits):\n")
        f.write(f"  Total Return:     +{original_return:.2f}%\n")
        f.write(f"  Exit Strategy:    +50% target, -30% stop, 3 day hold\n")
        f.write(f"\n")
        
        f.write(f"New (Scaling Exits):\n")
        f.write(f"  Total Return:     {v5_results['total_return_pct']:+.2f}%\n")
        f.write(f"  Exit Strategy:    Grade-based scaling, 36 hour hold\n")
        f.write(f"\n")
        
        f.write(f"Improvement:        {improvement:+.2f}%\n")
        f.write(f"\n")
        
        if improvement > 0:
            f.write(f"✅ SCALING EXITS IMPROVED PERFORMANCE by {improvement:.2f}%\n")
        elif improvement < 0:
            f.write(f"⚠️  SCALING EXITS UNDERPERFORMED by {abs(improvement):.2f}%\n")
        else:
            f.write(f"⚪ NO DIFFERENCE IN PERFORMANCE\n")
    
    print(f"📄 Results saved to: {output_path}")
    print()
    print("="*80)

if __name__ == '__main__':
    main()
