"""
PART 2: Seed avg_vol_by_window for all tickers
Fetches 60 days of 15-min bars from Alpaca and calculates
average volume per time window for accurate intraday comparisons.
"""

import os
import json
import requests
from datetime import datetime, timedelta
from collections import defaultdict
import statistics

# Alpaca credentials (fallback to hardcoded if not in env)
ALPACA_API_KEY = os.getenv('ALPACA_API_KEY', 'PKCF3BAQSFQEWDQRLG45SZIMMQ')
ALPACA_SECRET_KEY = os.getenv('ALPACA_SECRET_KEY', 'DFJXX1qz33tPgYxQdVAhhYt4QXmp4zFGHbiaFrCaiQkk')
ALPACA_DATA_URL = 'https://data.alpaca.markets'

# Launch Control universe
TICKERS = [
    'NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL',
    'NFLX', 'AVGO', 'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM'
]

# Time windows (15-min intervals from 9:30 to 15:45 ET)
WINDOWS = [
    '09:30', '09:45', '10:00', '10:15', '10:30', '10:45',
    '11:00', '11:15', '11:30', '11:45', '12:00', '12:15',
    '12:30', '12:45', '13:00', '13:15', '13:30', '13:45',
    '14:00', '14:15', '14:30', '14:45', '15:00', '15:15',
    '15:30', '15:45'
]


def get_window_key(timestamp_str: str) -> str:
    """
    Convert timestamp to 15-min window key.
    E.g., "2026-03-10T10:23:00-04:00" → "10:15"
    """
    # Parse timestamp
    if 'T' in timestamp_str:
        time_part = timestamp_str.split('T')[1][:5]  # HH:MM
        hour, minute = int(time_part[:2]), int(time_part[3:5])
    else:
        return None
    
    # Floor to nearest 15 minutes
    floored_minute = (minute // 15) * 15
    return f"{hour:02d}:{floored_minute:02d}"


def fetch_15min_bars(ticker: str, days_back: int = 60) -> list:
    """
    Fetch 60 days of 15-minute bars from Alpaca SIP feed.
    """
    headers = {
        'APCA-API-KEY-ID': ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY
    }
    
    end_date = datetime.now() - timedelta(days=1)  # Yesterday
    start_date = end_date - timedelta(days=days_back)
    
    url = f"{ALPACA_DATA_URL}/v2/stocks/{ticker}/bars"
    params = {
        'timeframe': '15Min',
        'start': start_date.strftime('%Y-%m-%d'),
        'end': end_date.strftime('%Y-%m-%d'),
        'feed': 'sip',
        'adjustment': 'all',
        'limit': 10000
    }
    
    all_bars = []
    next_page_token = None
    
    while True:
        if next_page_token:
            params['page_token'] = next_page_token
        
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        
        if resp.status_code != 200:
            print(f"  ❌ API error for {ticker}: {resp.status_code}")
            break
        
        data = resp.json()
        bars = data.get('bars', [])
        all_bars.extend(bars)
        
        next_page_token = data.get('next_page_token')
        if not next_page_token:
            break
    
    return all_bars


def calculate_window_averages(bars: list) -> dict:
    """
    Group bars by time window and calculate average volume per window.
    """
    window_volumes = defaultdict(list)
    
    for bar in bars:
        timestamp = bar.get('t', '')
        volume = bar.get('v', 0)
        
        window_key = get_window_key(timestamp)
        if window_key and window_key in WINDOWS:
            window_volumes[window_key].append(volume)
    
    # Calculate averages
    window_avgs = {}
    for window in WINDOWS:
        volumes = window_volumes.get(window, [])
        if volumes:
            window_avgs[window] = int(statistics.mean(volumes))
        else:
            window_avgs[window] = 0
    
    return window_avgs


def calculate_panic_threshold(bars: list, window_avgs: dict) -> float:
    """
    Calculate 90th percentile of (bar_volume / window_avg) across all bars.
    This defines what "panic volume" looks like for this stock.
    """
    ratios = []
    
    for bar in bars:
        timestamp = bar.get('t', '')
        volume = bar.get('v', 0)
        
        window_key = get_window_key(timestamp)
        if window_key and window_key in window_avgs:
            window_avg = window_avgs.get(window_key, 0)
            if window_avg > 0:
                ratio = volume / window_avg
                ratios.append(ratio)
    
    if not ratios:
        return 2.5  # Default
    
    # 90th percentile
    ratios.sort()
    idx = int(len(ratios) * 0.90)
    return round(ratios[idx], 2)


def calculate_daily_avg(bars: list) -> int:
    """Calculate average daily volume from bars."""
    # Group by date
    daily_volumes = defaultdict(int)
    for bar in bars:
        timestamp = bar.get('t', '')
        if 'T' in timestamp:
            date = timestamp.split('T')[0]
            daily_volumes[date] += bar.get('v', 0)
    
    if not daily_volumes:
        return 0
    
    return int(statistics.mean(daily_volumes.values()))


def seed_ticker(ticker: str) -> dict:
    """
    Fetch data and calculate all volume metrics for a ticker.
    """
    print(f"\n📊 Seeding {ticker}...")
    
    # Fetch bars
    bars = fetch_15min_bars(ticker, days_back=60)
    if not bars:
        print(f"  ❌ No bars returned for {ticker}")
        return None
    
    print(f"  📈 Fetched {len(bars)} bars")
    
    # Calculate window averages
    window_avgs = calculate_window_averages(bars)
    
    # Calculate panic threshold
    panic_threshold = calculate_panic_threshold(bars, window_avgs)
    
    # Calculate daily avg
    daily_avg = calculate_daily_avg(bars)
    
    # Print sample
    print(f"  ✓ {ticker} — window baselines seeded")
    print(f"    Sample: 09:30 avg={window_avgs.get('09:30', 0):,}  "
          f"10:00 avg={window_avgs.get('10:00', 0):,}  "
          f"13:00 avg={window_avgs.get('13:00', 0):,}")
    print(f"    Panic threshold: {panic_threshold}x relative volume")
    print(f"    Daily avg: {daily_avg:,}")
    
    return {
        'ticker': ticker,
        'avg_vol_by_window': window_avgs,
        'panic_vol_threshold': panic_threshold,
        'avg_daily_volume': daily_avg
    }


def seed_all_tickers():
    """Seed all tickers and save results."""
    results = {}
    
    print("=" * 60)
    print("SEEDING VOLUME WINDOW BASELINES")
    print("=" * 60)
    
    for ticker in TICKERS:
        result = seed_ticker(ticker)
        if result:
            results[ticker] = result
    
    # Save to JSON for scorer to use
    output_path = '/tmp/AlphaTrades/volume_profiles.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    print("\n" + "=" * 60)
    print(f"COMPLETE: {len(results)}/{len(TICKERS)} tickers seeded")
    print(f"Saved to: {output_path}")
    print("=" * 60)
    
    return results


if __name__ == '__main__':
    seed_all_tickers()
