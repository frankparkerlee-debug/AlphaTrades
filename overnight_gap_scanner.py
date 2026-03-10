"""
Overnight Gap Momentum Scanner
Identifies stocks building momentum midday, likely to gap overnight

Strategy: Enter midday setups, hold overnight, exit on gap at open (80%+ profit targets)
"""
from datetime import datetime, timedelta, time as dtime
import pytz
from alpaca_client import AlpacaClient
from tech_100 import get_tech_100
import logging

logger = logging.getLogger(__name__)

class OvernightGapScanner:
    def __init__(self):
        self.alpaca = AlpacaClient()
        self.et_tz = pytz.timezone('America/New_York')
        
    def calculate_rsi(self, prices, period=14):
        """Calculate RSI indicator"""
        if len(prices) < period + 1:
            return 50  # Neutral if not enough data
        
        deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
        gains = [d if d > 0 else 0 for d in deltas]
        losses = [-d if d < 0 else 0 for d in deltas]
        
        avg_gain = sum(gains[-period:]) / period
        avg_loss = sum(losses[-period:]) / period
        
        if avg_loss == 0:
            return 100
        
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        return rsi
    
    def calculate_vwap(self, bars):
        """Calculate VWAP from intraday bars"""
        if not bars:
            return 0
        
        total_pv = sum(bar['c'] * bar['v'] for bar in bars)
        total_v = sum(bar['v'] for bar in bars)
        
        if total_v == 0:
            return 0
        
        return total_pv / total_v
    
    def get_time_of_day_score(self):
        """Score based on time of day (midday = best)"""
        now = datetime.now(self.et_tz)
        current_time = now.time()
        
        # Best time: 11:00 AM - 2:00 PM ET (midday momentum)
        midday_start = dtime(11, 0)
        midday_end = dtime(14, 0)
        
        if midday_start <= current_time <= midday_end:
            return 15  # Peak midday window
        elif dtime(10, 0) <= current_time < midday_start:
            return 10  # Morning tail
        elif midday_end < current_time <= dtime(15, 30):
            return 8   # Afternoon (still tradeable)
        else:
            return 0   # Too early or after hours
    
    def scan_symbol(self, symbol):
        """
        Scan a single symbol for overnight gap setup
        Returns dict with score and signal details, or None if no setup
        """
        try:
            # Get snapshot (current price, volume, etc)
            snapshot = self.alpaca.get_snapshot(symbol)
            
            if not snapshot or snapshot.get('c', 0) == 0:
                return None
            
            current_price = snapshot['c']
            daily_volume = snapshot.get('v', 0)
            daily_open = snapshot.get('o', 0)
            daily_high = snapshot.get('h', 0)
            daily_low = snapshot.get('l', 0)
            prev_close = snapshot.get('pc', 0)
            
            if prev_close == 0 or daily_volume == 0:
                return None
            
            # Get intraday 5-minute bars for momentum analysis
            end_time = datetime.now(self.et_tz)
            start_time = end_time - timedelta(hours=3)
            
            bars_data = self.alpaca.get_bars(
                symbol, 
                timeframe='5Min',
                start=start_time,
                end=end_time,
                limit=100
            )
            
            bars = bars_data.get('bars', [])
            if len(bars) < 10:
                return None  # Not enough intraday data
            
            # Calculate intraday metrics
            intraday_prices = [bar['c'] for bar in bars]
            intraday_volumes = [bar['v'] for bar in bars]
            
            # 1. INTRADAY MOMENTUM STRENGTH (0-30 pts)
            intraday_change_pct = ((current_price - daily_open) / daily_open) * 100
            
            # Sweet spot: 1-3% moves (building momentum, not exhausted)
            if 1 <= abs(intraday_change_pct) <= 3:
                momentum_score = 30
            elif 0.5 <= abs(intraday_change_pct) < 1:
                momentum_score = 20
            elif 3 < abs(intraday_change_pct) <= 5:
                momentum_score = 15  # Still good but getting extended
            else:
                momentum_score = 5   # Too small or too big
            
            # 2. VOLUME CONFIRMATION (0-20 pts)
            morning_bars = bars[:min(12, len(bars)//3)]  # First hour
            recent_bars = bars[-12:]  # Last hour
            
            morning_avg_vol = sum(bar['v'] for bar in morning_bars) / len(morning_bars) if morning_bars else 1
            recent_avg_vol = sum(bar['v'] for bar in recent_bars) / len(recent_bars) if recent_bars else 0
            
            volume_increase = (recent_avg_vol / morning_avg_vol - 1) * 100 if morning_avg_vol > 0 else 0
            
            if volume_increase >= 50:
                volume_score = 20  # Strong volume surge
            elif volume_increase >= 25:
                volume_score = 15
            elif volume_increase >= 10:
                volume_score = 10
            else:
                volume_score = 5
            
            # 3. TECHNICAL SETUP QUALITY (0-20 pts)
            rsi = self.calculate_rsi(intraday_prices)
            vwap = self.calculate_vwap(bars)
            
            # RSI trending but not extreme (40-60 = perfect, avoid overbought/oversold)
            if 45 <= rsi <= 55:
                rsi_score = 10  # Neutral momentum building
            elif 40 <= rsi <= 60:
                rsi_score = 7
            elif 35 <= rsi <= 65:
                rsi_score = 4
            else:
                rsi_score = 0  # Too extreme
            
            # VWAP positioning
            vwap_distance = abs((current_price - vwap) / vwap * 100) if vwap > 0 else 100
            
            if vwap_distance < 0.5:
                vwap_score = 10  # Perfect - near VWAP
            elif vwap_distance < 1:
                vwap_score = 6
            elif vwap_distance < 2:
                vwap_score = 3
            else:
                vwap_score = 0
            
            technical_score = rsi_score + vwap_score
            
            # 4. DISTANCE TO KEY LEVEL (0-15 pts)
            # Key levels = daily high/low or psychological round numbers
            distance_to_high = abs((current_price - daily_high) / daily_high * 100)
            distance_to_low = abs((current_price - daily_low) / daily_low * 100)
            
            closest_key_distance = min(distance_to_high, distance_to_low)
            
            if closest_key_distance < 0.5:
                key_level_score = 15  # At key level
            elif closest_key_distance < 1:
                key_level_score = 10
            elif closest_key_distance < 2:
                key_level_score = 5
            else:
                key_level_score = 2
            
            # 5. TIME OF DAY (0-15 pts)
            time_score = self.get_time_of_day_score()
            
            # TOTAL SCORE
            total_score = momentum_score + volume_score + technical_score + key_level_score + time_score
            
            # Determine direction
            if intraday_change_pct > 0:
                direction = 'CALL'
                target_level = daily_high
            else:
                direction = 'PUT'
                target_level = daily_low
            
            # Suggest strike (ATM or 1 strike OTM)
            strike_increment = 5 if current_price > 50 else (1 if current_price > 20 else 0.5)
            atm_strike = round(current_price / strike_increment) * strike_increment
            
            if direction == 'CALL':
                suggested_strike = atm_strike + strike_increment  # 1 OTM
            else:
                suggested_strike = atm_strike - strike_increment
            
            # Suggest expiry (2-5 DTE - next week typically)
            suggested_expiry = '2-5 DTE'
            
            # Entry price range (within 0.5% of current)
            entry_low = current_price * 0.995
            entry_high = current_price * 1.005
            
            return {
                'ticker': symbol,
                'score': round(total_score, 1),
                'direction': direction,
                'current_price': round(current_price, 2),
                'suggested_strike': round(suggested_strike, 2),
                'suggested_expiry': suggested_expiry,
                'entry_range': f"${entry_low:.2f} - ${entry_high:.2f}",
                'target_level': round(target_level, 2),
                'intraday_change': round(intraday_change_pct, 2),
                'rsi': round(rsi, 1),
                'vwap': round(vwap, 2),
                'volume_increase': round(volume_increase, 1),
                'breakdown': {
                    'momentum': momentum_score,
                    'volume': volume_score,
                    'technical': technical_score,
                    'key_level': key_level_score,
                    'time_of_day': time_score
                }
            }
            
        except Exception as e:
            logger.error(f"Error scanning {symbol}: {e}")
            return None
    
    def scan_all(self, min_score=60):
        """
        Scan all tech 100 stocks
        Returns list of setups sorted by score (top 10-20)
        """
        tech_stocks = get_tech_100()
        results = []
        
        logger.info(f"Scanning {len(tech_stocks)} tech stocks...")
        
        for symbol in tech_stocks:
            setup = self.scan_symbol(symbol)
            if setup and setup['score'] >= min_score:
                results.append(setup)
        
        # Sort by score descending
        results.sort(key=lambda x: x['score'], reverse=True)
        
        # Return top 20
        return results[:20]
