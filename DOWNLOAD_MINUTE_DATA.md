# Download Minute Bar Data on Render

## Quick Start

1. **SSH into Render Worker:**
   ```bash
   # From Render Dashboard > alphatrades-worker > Shell
   ```

2. **Run download script:**
   ```bash
   python download_minute_data.py
   ```

   This will:
   - Download ~3.2M minute bars (2024-01-01 to 2026-02-28)
   - Store directly in PostgreSQL (~300 MB)
   - Take ~20-40 minutes depending on API rate limits
   - Auto-resume if interrupted (checks existing data)

## Custom Date Range

```bash
# Download specific date range
python download_minute_data.py --start 2024-01-01 --end 2025-12-31

# Download specific tickers
python download_minute_data.py --tickers AAPL,NVDA,TSLA

# Both
python download_minute_data.py --start 2025-01-01 --end 2025-12-31 --tickers AMD,NVDA
```

## Progress Monitoring

The script shows:
- Monthly chunks as they download
- Existing data detection (skips duplicates)
- ETA for remaining tickers
- Final summary with total bars and date range

Example output:
```
======================================================================
📊 NVDA
======================================================================
   Existing data: 2024-01-01 to 2024-06-30 (52,340 bars)
   📥 2024-07 - downloading... ✅ 4,680 bars
   📥 2024-08 - downloading... ✅ 5,070 bars
   ...
```

## Verify Data

```python
# Check what's in the database
from models import get_session, MinuteBar
from sqlalchemy import func, distinct

session = get_session()

# Total bars
total = session.query(func.count(MinuteBar.id)).scalar()
print(f"Total bars: {total:,}")

# Tickers
tickers = session.query(distinct(MinuteBar.ticker)).all()
print(f"Tickers: {[t[0] for t in tickers]}")

# Date range
earliest = session.query(func.min(MinuteBar.timestamp)).scalar()
latest = session.query(func.max(MinuteBar.timestamp)).scalar()
print(f"Range: {earliest} to {latest}")
```

## Troubleshooting

**Error: Missing Alpaca credentials**
- Ensure ALPACA_API_KEY and ALPACA_SECRET_KEY are set in Render environment variables

**Error: Database connection failed**
- Verify DATABASE_URL is set (Render auto-provides this)

**Slow downloads**
- Normal - Alpaca has rate limits (~200 requests/min)
- Script auto-throttles with 0.2s delays between chunks

**Resume after interrupt**
- Just re-run the script - it checks existing data and skips completed months

## Storage Impact

- **Current usage**: ~300 MB for 2.2 years, 15 tickers
- **Render Pro DB**: 15 GB total (2% utilized)
- **Daily growth**: ~0.33 MB/day (negligible)
- **Room for**: 30+ more years at current ticker count
