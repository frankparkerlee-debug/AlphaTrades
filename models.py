"""
Database Models for AlphaTrades Distress Scanner
PostgreSQL schema for storing distress signals and scan results
"""

from datetime import datetime
from typing import Optional, Dict
from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Boolean, 
    JSON, Text, Index, ForeignKey
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()


class DistressSignal(Base):
    """
    Main table for distress signal scan results
    Stores scores and alerts for tracked companies
    """
    __tablename__ = 'distress_signals'
    
    # Primary key
    id = Column(Integer, primary_key=True, autoincrement=True)
    
    # Ticker info
    ticker = Column(String(10), nullable=False, index=True)
    scan_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    # Score
    distress_score = Column(Integer, nullable=False, index=True)  # 0-100
    raw_score = Column(Integer, nullable=False)
    alert_triggered = Column(Boolean, nullable=False, default=False, index=True)
    
    # Signal breakdown
    signals_triggered = Column(Integer, nullable=False, default=0)
    signal_details = Column(JSON, nullable=True)  # Array of signal objects
    
    # Data sources (counts)
    filings_8k_count = Column(Integer, nullable=True)
    form4_filings_count = Column(Integer, nullable=True)
    news_count = Column(Integer, nullable=True)
    
    # Sentiment analysis
    news_sentiment_avg = Column(Float, nullable=True)
    news_sentiment_negative_ratio = Column(Float, nullable=True)
    
    # Options data
    put_volume = Column(Integer, nullable=True)
    call_volume = Column(Integer, nullable=True)
    put_call_ratio = Column(Float, nullable=True)
    
    # Earnings
    days_until_earnings = Column(Integer, nullable=True)
    earnings_date = Column(DateTime, nullable=True)
    
    # Analyst data
    analyst_downgrades = Column(Integer, nullable=True, default=0)
    
    # Trade recommendation
    has_recommendation = Column(Boolean, default=False)
    recommendation_data = Column(JSON, nullable=True)
    
    # Metadata
    metadata = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)
    
    # Relationships
    alerts = relationship("DistressAlert", back_populates="signal", cascade="all, delete-orphan")
    
    # Indexes for common queries
    __table_args__ = (
        Index('idx_ticker_timestamp', 'ticker', 'scan_timestamp'),
        Index('idx_alert_score', 'alert_triggered', 'distress_score'),
        Index('idx_recent_alerts', 'alert_triggered', 'scan_timestamp'),
    )
    
    def __repr__(self):
        return f"<DistressSignal(ticker={self.ticker}, score={self.distress_score}, alert={self.alert_triggered})>"
    
    def to_dict(self) -> Dict:
        """Convert to dictionary"""
        return {
            'id': self.id,
            'ticker': self.ticker,
            'scan_timestamp': self.scan_timestamp.isoformat() if self.scan_timestamp else None,
            'distress_score': self.distress_score,
            'raw_score': self.raw_score,
            'alert_triggered': self.alert_triggered,
            'signals_triggered': self.signals_triggered,
            'signal_details': self.signal_details,
            'data': {
                'filings_8k': self.filings_8k_count,
                'form4_filings': self.form4_filings_count,
                'news_count': self.news_count,
                'news_sentiment_avg': self.news_sentiment_avg,
                'news_sentiment_negative_ratio': self.news_sentiment_negative_ratio,
                'put_volume': self.put_volume,
                'call_volume': self.call_volume,
                'put_call_ratio': self.put_call_ratio,
                'days_until_earnings': self.days_until_earnings,
                'earnings_date': self.earnings_date.isoformat() if self.earnings_date else None,
                'analyst_downgrades': self.analyst_downgrades
            },
            'recommendation': self.recommendation_data if self.has_recommendation else None,
            'metadata': self.metadata,
            'error': self.error_message
        }


class DistressAlert(Base):
    """
    Alert history table
    Tracks when alerts were triggered and sent
    """
    __tablename__ = 'distress_alerts'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    
    # Foreign key to signal
    signal_id = Column(Integer, ForeignKey('distress_signals.id'), nullable=False, index=True)
    
    # Alert info
    ticker = Column(String(10), nullable=False, index=True)
    alert_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    distress_score = Column(Integer, nullable=False)
    
    # Delivery status
    sent = Column(Boolean, default=False, index=True)
    delivery_channels = Column(JSON, nullable=True)  # ['webhook', 'slack', 'email']
    delivery_status = Column(JSON, nullable=True)  # Status per channel
    
    # Trade recommendation
    recommendation_data = Column(JSON, nullable=True)
    
    # User actions
    acknowledged = Column(Boolean, default=False)
    acknowledged_at = Column(DateTime, nullable=True)
    user_notes = Column(Text, nullable=True)
    
    # Trade tracking (if user took the trade)
    trade_taken = Column(Boolean, default=False)
    trade_data = Column(JSON, nullable=True)
    
    # Relationship
    signal = relationship("DistressSignal", back_populates="alerts")
    
    __table_args__ = (
        Index('idx_recent_alerts', 'alert_timestamp'),
        Index('idx_ticker_alerts', 'ticker', 'alert_timestamp'),
        Index('idx_unsent', 'sent', 'alert_timestamp'),
    )
    
    def __repr__(self):
        return f"<DistressAlert(ticker={self.ticker}, score={self.distress_score}, sent={self.sent})>"


class Watchlist(Base):
    """
    User watchlist for continuous monitoring
    """
    __tablename__ = 'watchlists'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    
    # Ticker
    ticker = Column(String(10), nullable=False, unique=True, index=True)
    
    # Watch settings
    active = Column(Boolean, default=True, index=True)
    alert_threshold = Column(Integer, default=60)  # Custom threshold
    
    # Monitoring
    last_scanned = Column(DateTime, nullable=True, index=True)
    last_score = Column(Integer, nullable=True)
    last_alert = Column(DateTime, nullable=True)
    
    # Metadata
    added_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    added_reason = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)
    
    def __repr__(self):
        return f"<Watchlist(ticker={self.ticker}, active={self.active}, threshold={self.alert_threshold})>"


class ScanJob(Base):
    """
    Scan job history for monitoring scheduled scans
    """
    __tablename__ = 'scan_jobs'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    
    # Job info
    job_type = Column(String(50), nullable=False)  # 'watchlist', 'manual', 'scheduled'
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    completed_at = Column(DateTime, nullable=True)
    
    # Execution
    status = Column(String(20), nullable=False, default='running')  # running, completed, failed
    tickers_scanned = Column(Integer, default=0)
    alerts_generated = Column(Integer, default=0)
    errors_count = Column(Integer, default=0)
    
    # Details
    ticker_list = Column(JSON, nullable=True)
    error_details = Column(JSON, nullable=True)
    
    __table_args__ = (
        Index('idx_job_status', 'status', 'started_at'),
    )
    
    def __repr__(self):
        return f"<ScanJob(type={self.job_type}, status={self.status}, tickers={self.tickers_scanned})>"


# Database utility functions
def create_all_tables(engine):
    """Create all tables in the database"""
    Base.metadata.create_all(engine)
    print("✅ All tables created successfully")


def drop_all_tables(engine):
    """Drop all tables (use with caution!)"""
    Base.metadata.drop_all(engine)
    print("⚠️  All tables dropped")


# Example usage
if __name__ == "__main__":
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    
    # Example: SQLite for testing (use PostgreSQL in production)
    print("Creating database schema example...")
    
    # Create engine (use your PostgreSQL connection string in production)
    # engine = create_engine('postgresql://user:password@localhost/alphatrades')
    engine = create_engine('sqlite:///distress_scanner_example.db')
    
    # Create tables
    create_all_tables(engine)
    
    # Create session
    Session = sessionmaker(bind=engine)
    session = Session()
    
    # Example: Insert a distress signal
    signal = DistressSignal(
        ticker='TEST',
        distress_score=75,
        raw_score=75,
        alert_triggered=True,
        signals_triggered=3,
        signal_details=[
            {'type': 'executive_departure', 'weight': 30, 'details': 'CFO resigned'},
            {'type': 'negative_news', 'weight': 20, 'details': 'Negative sentiment'},
            {'type': 'insider_selling_spike', 'weight': 25, 'details': '6 Form 4s'}
        ],
        filings_8k_count=1,
        form4_filings_count=6,
        news_count=10,
        news_sentiment_avg=-0.5,
        news_sentiment_negative_ratio=0.7,
        days_until_earnings=3,
        has_recommendation=True,
        recommendation_data={
            'action': 'BUY_PUT',
            'strike': 95.0,
            'expiry': '2026-03-21',
            'confidence': 'HIGH'
        }
    )
    
    session.add(signal)
    session.commit()
    
    print(f"\n✅ Example signal created: {signal}")
    print(f"\n📊 Signal as dict:")
    import json
    print(json.dumps(signal.to_dict(), indent=2))
    
    # Clean up example DB
    session.close()
    import os
    os.remove('distress_scanner_example.db')
    print("\n🧹 Example database cleaned up")
