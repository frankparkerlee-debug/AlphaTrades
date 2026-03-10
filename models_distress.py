"""
SQLAlchemy models for Distress Scanner & Overnight Gap features
Separate from core models to avoid breaking existing build
"""
from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, JSON, Text, Index, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime
from typing import Dict

Base = declarative_base()


class DistressSignal(Base):
    """Distress signal scan results"""
    __tablename__ = 'distress_signals'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    ticker = Column(String(10), nullable=False, index=True)
    scan_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    distress_score = Column(Integer, nullable=False, index=True)
    raw_score = Column(Integer, nullable=False)
    alert_triggered = Column(Boolean, nullable=False, default=False, index=True)
    
    signals_triggered = Column(Integer, nullable=False, default=0)
    signal_details = Column(JSON, nullable=True)
    
    filings_8k_count = Column(Integer, nullable=True)
    form4_filings_count = Column(Integer, nullable=True)
    news_count = Column(Integer, nullable=True)
    
    news_sentiment_avg = Column(Float, nullable=True)
    news_sentiment_negative_ratio = Column(Float, nullable=True)
    
    put_volume = Column(Integer, nullable=True)
    call_volume = Column(Integer, nullable=True)
    put_call_ratio = Column(Float, nullable=True)
    
    days_until_earnings = Column(Integer, nullable=True)
    earnings_date = Column(DateTime, nullable=True)
    
    analyst_downgrades = Column(Integer, nullable=True, default=0)
    
    has_recommendation = Column(Boolean, default=False)
    recommendation_data = Column(JSON, nullable=True)
    
    extra_data = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)
    
    distress_alerts = relationship("DistressAlert", back_populates="signal", cascade="all, delete-orphan")
    
    __table_args__ = (
        Index('idx_distress_ticker_timestamp', 'ticker', 'scan_timestamp'),
        Index('idx_distress_alert_score', 'alert_triggered', 'distress_score'),
    )
    
    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'ticker': self.ticker,
            'scan_timestamp': self.scan_timestamp.isoformat() if self.scan_timestamp else None,
            'distress_score': self.distress_score,
            'alert_triggered': self.alert_triggered,
            'signals_triggered': self.signals_triggered,
            'signal_details': self.signal_details,
            'recommendation': self.recommendation_data if self.has_recommendation else None,
        }


class DistressAlert(Base):
    """Distress alert history"""
    __tablename__ = 'distress_alerts'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    signal_id = Column(Integer, ForeignKey('distress_signals.id'), nullable=False, index=True)
    
    ticker = Column(String(10), nullable=False, index=True)
    alert_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    distress_score = Column(Integer, nullable=False)
    
    sent = Column(Boolean, default=False, index=True)
    delivery_channels = Column(JSON, nullable=True)
    delivery_status = Column(JSON, nullable=True)
    
    recommendation_data = Column(JSON, nullable=True)
    
    acknowledged = Column(Boolean, default=False)
    acknowledged_at = Column(DateTime, nullable=True)
    user_notes = Column(Text, nullable=True)
    
    trade_taken = Column(Boolean, default=False)
    trade_data = Column(JSON, nullable=True)
    
    signal = relationship("DistressSignal", back_populates="distress_alerts")


class OvernightGapSetup(Base):
    """Overnight gap momentum setups"""
    __tablename__ = 'overnight_gap_setups'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    ticker = Column(String(10), nullable=False, index=True)
    scan_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    gap_score = Column(Integer, nullable=False)
    direction = Column(String(4), nullable=False)  # CALL or PUT
    
    # Price data
    prev_close = Column(Float, nullable=True)
    current_price = Column(Float, nullable=True)
    gap_percent = Column(Float, nullable=True)
    
    # Volume
    relative_volume = Column(Float, nullable=True)
    
    # Recommendation
    has_recommendation = Column(Boolean, default=False)
    recommendation_data = Column(JSON, nullable=True)
    
    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'ticker': self.ticker,
            'scan_timestamp': self.scan_timestamp.isoformat() if self.scan_timestamp else None,
            'gap_score': self.gap_score,
            'direction': self.direction,
            'gap_percent': self.gap_percent,
            'recommendation': self.recommendation_data if self.has_recommendation else None,
        }
