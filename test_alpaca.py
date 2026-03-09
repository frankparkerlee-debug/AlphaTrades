import os
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from datetime import datetime
import pytz

client = StockHistoricalDataClient(
    os.getenv('ALPACA_API_KEY'),
    os.getenv('ALPACA_SECRET_KEY')
)

request_params = StockBarsRequest(
    symbol_or_symbols='NVDA',
    timeframe=TimeFrame.Minute,
    start=datetime(2024, 1, 2, 9, 30, tzinfo=pytz.UTC),
    end=datetime(2024, 1, 2, 16, 0, tzinfo=pytz.UTC),
    limit=390
)

bars = client.get_stock_bars(request_params)

print(f"Response type: {type(bars)}")
print(f"'NVDA' in response: {'NVDA' in bars}")

if 'NVDA' in bars:
    print(f"Bars count: {len(bars['NVDA'])}")
    print(f"First bar: {bars['NVDA'][0]}")
else:
    print(f"ERROR: Keys = {list(bars.keys())}")
    print(f"Dir = {[x for x in dir(bars) if not x.startswith('_')]}")
