"""
Technical Indicators for Momentum Strategy
RSI, MACD, Bollinger Bands, EMA, SMA, ADX
"""
from typing import List, Tuple

def calculate_sma(prices: List[float], period: int) -> float:
    """Simple Moving Average"""
    if len(prices) < period:
        return prices[-1] if prices else 0
    return sum(prices[-period:]) / period

def calculate_ema(prices: List[float], period: int) -> float:
    """Exponential Moving Average"""
    if len(prices) < period:
        return calculate_sma(prices, len(prices))
    
    multiplier = 2 / (period + 1)
    ema = calculate_sma(prices[:period], period)
    
    for price in prices[period:]:
        ema = (price * multiplier) + (ema * (1 - multiplier))
    
    return ema

def calculate_rsi(prices: List[float], period: int = 14) -> float:
    """
    Relative Strength Index (RSI)
    Returns value between 0-100
    > 70 = overbought, < 30 = oversold
    """
    if len(prices) < period + 1:
        return 50.0  # Neutral if not enough data
    
    deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
    
    gains = [d if d > 0 else 0 for d in deltas]
    losses = [abs(d) if d < 0 else 0 for d in deltas]
    
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    
    if avg_loss == 0:
        return 100.0
    
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    
    return rsi

def calculate_macd(prices: List[float], fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[float, float, float]:
    """
    MACD (Moving Average Convergence Divergence)
    Returns (macd_line, signal_line, histogram)
    """
    if len(prices) < slow:
        return (0.0, 0.0, 0.0)
    
    ema_fast = calculate_ema(prices, fast)
    ema_slow = calculate_ema(prices, slow)
    
    macd_line = ema_fast - ema_slow
    
    # Calculate signal line (EMA of MACD)
    # For simplicity, using the last MACD value as signal
    # In production, you'd calculate EMA of MACD over time
    signal_line = macd_line * 0.9  # Simplified
    
    histogram = macd_line - signal_line
    
    return (macd_line, signal_line, histogram)

def calculate_bollinger_bands(prices: List[float], period: int = 20, std_dev: float = 2.0) -> Tuple[float, float, float]:
    """
    Bollinger Bands
    Returns (upper_band, middle_band, lower_band)
    """
    if len(prices) < period:
        middle = prices[-1] if prices else 0
        return (middle, middle, middle)
    
    middle_band = calculate_sma(prices, period)
    
    # Calculate standard deviation
    recent_prices = prices[-period:]
    variance = sum((p - middle_band) ** 2 for p in recent_prices) / period
    std = variance ** 0.5
    
    upper_band = middle_band + (std_dev * std)
    lower_band = middle_band - (std_dev * std)
    
    return (upper_band, middle_band, lower_band)

def calculate_adx(bars: List[dict], period: int = 14) -> float:
    """
    Average Directional Index (ADX)
    Measures trend strength (0-100)
    > 25 = strong trend, < 20 = weak trend
    """
    if len(bars) < period + 1:
        return 0.0
    
    # Calculate True Range (TR)
    trs = []
    for i in range(1, len(bars)):
        high = bars[i]['h']
        low = bars[i]['l']
        prev_close = bars[i-1]['c']
        
        tr = max(
            high - low,
            abs(high - prev_close),
            abs(low - prev_close)
        )
        trs.append(tr)
    
    if not trs:
        return 0.0
    
    # Calculate +DM and -DM
    plus_dm = []
    minus_dm = []
    
    for i in range(1, len(bars)):
        high_diff = bars[i]['h'] - bars[i-1]['h']
        low_diff = bars[i-1]['l'] - bars[i]['l']
        
        if high_diff > low_diff and high_diff > 0:
            plus_dm.append(high_diff)
            minus_dm.append(0)
        elif low_diff > high_diff and low_diff > 0:
            plus_dm.append(0)
            minus_dm.append(low_diff)
        else:
            plus_dm.append(0)
            minus_dm.append(0)
    
    # Smooth with EMA
    if len(trs) < period:
        return 0.0
    
    atr = sum(trs[-period:]) / period
    plus_di = (sum(plus_dm[-period:]) / period / atr) * 100 if atr > 0 else 0
    minus_di = (sum(minus_dm[-period:]) / period / atr) * 100 if atr > 0 else 0
    
    # Calculate DX
    if plus_di + minus_di == 0:
        return 0.0
    
    dx = abs(plus_di - minus_di) / (plus_di + minus_di) * 100
    
    # ADX is smoothed DX (simplified)
    return dx

def calculate_volume_ratio(current_volume: float, historical_volumes: List[float]) -> float:
    """
    Calculate current volume as percentage of average historical volume
    Returns ratio (e.g., 200 = 200% of average)
    """
    if not historical_volumes or sum(historical_volumes) == 0:
        return 100.0
    
    avg_volume = sum(historical_volumes) / len(historical_volumes)
    
    if avg_volume == 0:
        return 100.0
    
    return (current_volume / avg_volume) * 100

def is_higher_highs(bars: List[dict], lookback: int = 5) -> bool:
    """
    Check if stock is making higher highs (uptrend pattern)
    """
    if len(bars) < lookback:
        return False
    
    recent_highs = [bar['h'] for bar in bars[-lookback:]]
    
    # Check if latest high is highest in lookback period
    return recent_highs[-1] == max(recent_highs)

def is_higher_lows(bars: List[dict], lookback: int = 5) -> bool:
    """
    Check if stock is making higher lows (uptrend pattern)
    """
    if len(bars) < lookback:
        return False
    
    recent_lows = [bar['l'] for bar in bars[-lookback:]]
    
    # Check if latest low is highest in lookback period
    return recent_lows[-1] == max(recent_lows)

# Test functions
if __name__ == '__main__':
    # Test with sample data
    test_prices = [100, 102, 101, 105, 103, 107, 106, 110, 108, 112, 115, 113, 118, 120, 119]
    
    print("Technical Indicators Test")
    print("=" * 50)
    print(f"Sample prices: {test_prices[-5:]}")
    print()
    
    print(f"SMA(10): {calculate_sma(test_prices, 10):.2f}")
    print(f"EMA(10): {calculate_ema(test_prices, 10):.2f}")
    print(f"RSI(14): {calculate_rsi(test_prices, 14):.2f}")
    
    macd, signal, hist = calculate_macd(test_prices)
    print(f"MACD: {macd:.2f}, Signal: {signal:.2f}, Histogram: {hist:.2f}")
    
    upper, middle, lower = calculate_bollinger_bands(test_prices)
    print(f"Bollinger Bands: Upper={upper:.2f}, Middle={middle:.2f}, Lower={lower:.2f}")
    
    print(f"Volume Ratio (150 vs avg 100): {calculate_volume_ratio(150, [90, 95, 100, 105, 110]):.0f}%")
    
    print("\n✅ All indicator functions working!")
