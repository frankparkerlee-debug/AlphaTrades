#!/usr/bin/env python3
"""Diagnose why options fetching returns None"""

from alpaca_client import AlpacaClient
from datetime import date, timedelta
import requests

a = AlpacaClient()

ticker = 'NVDA'
stock_price = 179.0
direction = 'call'
dte = 1

print("="*70)
print(f"🔍 DIAGNOSING OPTIONS FETCH FOR {ticker}")
print("="*70)
print(f"Stock price: ${stock_price}")
print(f"Direction: {direction}")
print(f"DTE preference: {dte}")
print()

# Calculate strike
strike_increment = 5 if stock_price > 50 else 1
target_strike = round(stock_price / strike_increment) * strike_increment
print(f"Target strike: ${target_strike}")

# Calculate expiration
target_date = date.today() + timedelta(days=dte)
exp_str = target_date.strftime('%y%m%d')
print(f"Target expiration: {target_date} ({exp_str})")

# Build OCC symbol
opt_type = 'C' if direction.lower() == 'call' else 'P'
strike_str = f"{int(target_strike * 1000):08d}"
occ_symbol = f"{ticker}{exp_str}{opt_type}{strike_str}"
print(f"OCC symbol: {occ_symbol}")
print()

# Try to fetch
url = f"{a.data_url}/v1beta1/options/snapshots"
params = {'symbols': occ_symbol}
print(f"Fetching from: {url}")
print(f"Params: {params}")
print()

try:
    response = requests.get(url, headers=a.headers, params=params, timeout=5)
    print(f"Response status: {response.status_code}")
    print(f"Response headers: {dict(response.headers)}")
    print()
    print(f"Response body:")
    print(response.text[:1000])
    print()
    
    if response.status_code == 200:
        data = response.json()
        print(f"✅ Success! Data keys: {data.keys()}")
        snapshots = data.get('snapshots', {})
        print(f"Snapshots count: {len(snapshots)}")
        if snapshots:
            print(f"Contract symbols: {list(snapshots.keys())}")
    else:
        print(f"❌ Non-200 status: {response.status_code}")
        
except Exception as e:
    print(f"❌ Exception: {e}")
    import traceback
    traceback.print_exc()

print()
print("="*70)
