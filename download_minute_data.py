#!/usr/bin/env python3
"""
Download historical minute-level price data from Alpaca
Stores in PostgreSQL for backtesting and strategy development

Usage:
    python download_minute_data.py [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--tickers AAPL,NVDA,...]
"""

import os
import sys
import time
import argparse
from datetime import datetime, timedelta
from typing import List, Dict
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
import pytz

# Import models
from models import Base, MinuteBar, get_db_engine

# Alpaca client
ALPACA_API_KEY = os.getenv('ALPACA_API_KEY')
ALPACA_SECRET_KEY = os.getenv('ALPACA_SECRET_KEY')

if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
    print("ERROR: Missing Alpaca API credentials")
    sys.exit(1)

alpaca_client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)

# Default tickers (15 tech stocks)
DEFAULT_TICKERS = [
    'AMD', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META',
    'NFLX', 'AVGO', 'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM'
]

def create_tables():
    """Create minute_bars table if it doesn't exist"""
    engine = get_db_engine()
    Base.metadata.create_all(engine)
    print("✅ Database tables ready")

def get_existing_data_range(session, ticker: str) -> tuple:
    """Check what data already exists for a ticker"""
    result = session.execute(
        text("""
            SELECT 
                MIN(timestamp) as earliest,
                MAX(timestamp) as latest,
                COUNT(*) as total_bars
            FROM minute_bars 
            WHERE ticker = :ticker
        """),
        {"ticker": ticker}
    ).fetchone()
    
    if result and result.total_bars > 0:
        return result.earliest, result.latest, result.total_bars
    return None, None, 0

def download_ticker_chunk(ticker: str, start_date: datetime, end_date: datetime) -> List[Dict]:
    """Download minute bars for a ticker within a date range"""
    try:
        request_params = StockBarsRequest(
            symbol_or_symbols=ticker,
            timeframe=TimeFrame.Minute,
            start=start_date,
            end=end_date,
            limit=10000  # Alpaca's max limit
        )
        
        bars_response = alpaca_client.get_stock_bars(request_params)
        
        if not bars_response or ticker not in bars_response:
            return []
        
        bars_data = bars_response[ticker]
        
        # Convert to list of dicts
        bars_list = []
        for bar in bars_data:
            bars_list.append({
                'ticker': ticker,
                'timestamp': bar.timestamp,
                'open': float(bar.open),
                'high': float(bar.high),
                'low': float(bar.low),
                'close': float(bar.close),
                'volume': int(bar.volume),
                'vwap': float(bar.vwap) if hasattr(bar, 'vwap') and bar.vwap else None,
                'trade_count': int(bar.trade_count) if hasattr(bar, 'trade_count') and bar.trade_count else None
            })
        
        return bars_list
        
    except Exception as e:
        print(f"   ⚠️  Error downloading {ticker} {start_date.date()}-{end_date.date()}: {e}")
        return []

def insert_bars_batch(session, bars: List[Dict]):
    """Bulk insert bars into database"""
    if not bars:
        return 0
    
    try:
        # Use bulk insert for speed
        session.bulk_insert_mappings(MinuteBar, bars)
        session.commit()
        return len(bars)
    except Exception as e:
        session.rollback()
        print(f"   ⚠️  Error inserting batch: {e}")
        return 0

def download_ticker_data(ticker: str, start_date: datetime, end_date: datetime, session):
    """Download all data for one ticker, chunked by month"""
    print(f"\n{'='*70}")
    print(f"📊 {ticker}")
    print(f"{'='*70}")
    
    # Check existing data
    earliest, latest, total_bars = get_existing_data_range(session, ticker)
    if total_bars > 0:
        print(f"   Existing data: {earliest.date()} to {latest.date()} ({total_bars:,} bars)")
    else:
        print(f"   No existing data - starting fresh download")
    
    # Download in monthly chunks
    current_date = start_date
    total_downloaded = 0
    
    while current_date < end_date:
        # Chunk: current_date to end of month or end_date
        chunk_end = min(
            datetime(current_date.year, current_date.month + 1, 1) if current_date.month < 12 
            else datetime(current_date.year + 1, 1, 1),
            end_date
        )
        
        # Check if we already have this chunk
        existing_bars = session.execute(
            text("""
                SELECT COUNT(*) as cnt
                FROM minute_bars
                WHERE ticker = :ticker
                  AND timestamp >= :start
                  AND timestamp < :end
            """),
            {
                "ticker": ticker,
                "start": current_date,
                "end": chunk_end
            }
        ).fetchone()
        
        if existing_bars and existing_bars.cnt > 0:
            print(f"   ⏭️  {current_date.strftime('%Y-%m')} - already have {existing_bars.cnt:,} bars, skipping")
            current_date = chunk_end
            continue
        
        print(f"   📥 {current_date.strftime('%Y-%m')} - downloading...", end='', flush=True)
        
        # Download chunk
        bars = download_ticker_chunk(ticker, current_date, chunk_end)
        
        if bars:
            inserted = insert_bars_batch(session, bars)
            total_downloaded += inserted
            print(f" ✅ {inserted:,} bars")
        else:
            print(f" ⚠️  No data")
        
        current_date = chunk_end
        time.sleep(0.2)  # Rate limit courtesy
    
    print(f"\n✅ {ticker} complete: {total_downloaded:,} new bars downloaded")
    
    # Show final stats
    earliest, latest, total_bars = get_existing_data_range(session, ticker)
    if total_bars > 0:
        print(f"   Total in database: {total_bars:,} bars ({earliest.date()} to {latest.date()})")

def main():
    parser = argparse.ArgumentParser(description='Download minute-level price data from Alpaca')
    parser.add_argument('--start', type=str, default='2024-01-01', help='Start date (YYYY-MM-DD)')
    parser.add_argument('--end', type=str, default='2026-02-28', help='End date (YYYY-MM-DD)')
    parser.add_argument('--tickers', type=str, help='Comma-separated ticker list (default: 15 tech stocks)')
    args = parser.parse_args()
    
    # Parse dates
    start_date = datetime.strptime(args.start, '%Y-%m-%d').replace(tzinfo=pytz.UTC)
    end_date = datetime.strptime(args.end, '%Y-%m-%d').replace(tzinfo=pytz.UTC)
    
    # Parse tickers
    tickers = args.tickers.split(',') if args.tickers else DEFAULT_TICKERS
    
    print("\n" + "="*70)
    print("📊 MINUTE DATA DOWNLOAD - AlphaTrades")
    print("="*70)
    print(f"Date Range: {start_date.date()} to {end_date.date()}")
    print(f"Tickers: {', '.join(tickers)}")
    print(f"Expected bars per ticker: ~{(end_date - start_date).days * 0.7 * 390:,.0f}")
    print(f"Total expected: ~{len(tickers) * (end_date - start_date).days * 0.7 * 390:,.0f}")
    print("="*70)
    
    # Create tables
    create_tables()
    
    # Setup session
    engine = get_db_engine()
    Session = sessionmaker(bind=engine)
    session = Session()
    
    # Download each ticker
    overall_start = time.time()
    
    try:
        for i, ticker in enumerate(tickers, 1):
            ticker_start = time.time()
            
            download_ticker_data(ticker, start_date, end_date, session)
            
            ticker_elapsed = time.time() - ticker_start
            print(f"   ⏱️  Time: {ticker_elapsed:.1f}s")
            
            # Progress
            if i < len(tickers):
                remaining = len(tickers) - i
                avg_time = (time.time() - overall_start) / i
                eta_seconds = remaining * avg_time
                print(f"\n📈 Progress: {i}/{len(tickers)} tickers ({i/len(tickers)*100:.1f}%)")
                print(f"⏳ ETA: ~{eta_seconds/60:.1f} minutes")
    
    finally:
        session.close()
    
    # Final summary
    elapsed_minutes = (time.time() - overall_start) / 60
    
    print("\n" + "="*70)
    print("✅ DOWNLOAD COMPLETE")
    print("="*70)
    
    # Get total stats
    session = Session()
    total_stats = session.execute(
        text("""
            SELECT 
                COUNT(DISTINCT ticker) as tickers,
                COUNT(*) as total_bars,
                MIN(timestamp) as earliest,
                MAX(timestamp) as latest
            FROM minute_bars
        """)
    ).fetchone()
    session.close()
    
    if total_stats and total_stats.total_bars > 0:
        print(f"Tickers: {total_stats.tickers}")
        print(f"Total bars: {total_stats.total_bars:,}")
        print(f"Date range: {total_stats.earliest.date()} to {total_stats.latest.date()}")
        print(f"Average bars/ticker: {total_stats.total_bars / total_stats.tickers:,.0f}")
        print(f"Time elapsed: {elapsed_minutes:.1f} minutes")
        print(f"Download rate: {total_stats.total_bars / elapsed_minutes / 60:,.0f} bars/second")
    
    print("\n🎯 Data ready for backtesting!")
    print("="*70)

if __name__ == "__main__":
    main()
