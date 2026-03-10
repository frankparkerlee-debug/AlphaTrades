# 📋 AlphaTrades Integration Plan

**Distress Signal Scanner - Strategy 3 Integration**

This document outlines how to integrate the Distress Scanner into your existing AlphaTrades infrastructure.

## 🎯 Integration Goals

1. **Seamless Database Integration** - Add DistressSignal models to existing PostgreSQL
2. **Real-Time Monitoring** - Run scanner as background service
3. **Alert Pipeline** - Connect to existing notification system
4. **Trade Execution** - Link recommendations to Robinhood integration
5. **Dashboard Integration** - Display signals in web interface

## 📊 Phase 1: Database Integration

### Step 1: Add Models to Existing Schema

```python
# In your existing AlphaTrades/models.py

# Add these imports
from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, JSON, Text, Index

# Add the DistressSignal model
class DistressSignal(Base):
    __tablename__ = 'distress_signals'
    
    # ... (copy from models.py)
    
# Add related models
class DistressAlert(Base):
    __tablename__ = 'distress_alerts'
    # ... (copy from models.py)

class Watchlist(Base):
    __tablename__ = 'watchlists'
    # ... (copy from models.py)
```

### Step 2: Create Migration

```bash
# Using Alembic (if you have migrations set up)
alembic revision --autogenerate -m "Add distress scanner tables"
alembic upgrade head

# Or create tables directly
python -c "from models import create_all_tables, engine; create_all_tables(engine)"
```

### Step 3: Verify Tables

```sql
-- Connect to your PostgreSQL database
psql -d alphatrades

-- Check tables were created
\dt

-- Should see:
-- distress_signals
-- distress_alerts
-- watchlists
-- scan_jobs
```

## 🔧 Phase 2: Code Integration

### Step 1: Add Scanner Module

```bash
# Copy scanner files to your AlphaTrades directory
cp distress_scanner.py /path/to/AlphaTrades/
cp data_sources.py /path/to/AlphaTrades/
cp scorer_distress.py /path/to/AlphaTrades/
cp alerts.py /path/to/AlphaTrades/
```

### Step 2: Update Requirements

```bash
# Add to your existing requirements.txt
cat requirements.txt >> /path/to/AlphaTrades/requirements.txt

# Install new dependencies
pip install -r requirements.txt
```

### Step 3: Configuration

Create `config/distress_scanner.yaml`:

```yaml
# Distress Scanner Configuration
scanner:
  enabled: true
  scan_interval_minutes: 60
  days_back: 30
  alert_threshold: 60
  
  # API Keys
  finnhub_api_key: ${FINNHUB_API_KEY}  # From environment variable
  
  # Watchlist
  watchlist:
    - LULU
    - META
    - SNAP
    - NFLX
    - BYND
    - SHOP
    - PTON
    - ROKU
    - ZM
    - COIN
  
  # Alert channels
  alerts:
    webhook_url: ${ALERT_WEBHOOK_URL}
    slack_webhook: ${SLACK_WEBHOOK_URL}
    discord_webhook: ${DISCORD_WEBHOOK_URL}
    
    email:
      enabled: false
      smtp_server: smtp.gmail.com
      smtp_port: 587
      username: ${EMAIL_USERNAME}
      password: ${EMAIL_PASSWORD}
      from_email: ${EMAIL_FROM}
      to_email: ${EMAIL_TO}

# Database (use existing AlphaTrades connection)
database:
  url: ${DATABASE_URL}
```

### Step 4: Create Service Module

Create `services/distress_scanner_service.py`:

```python
"""
Distress Scanner Service
Integrates scanner with AlphaTrades infrastructure
"""

from distress_scanner import DistressScanner, RealTimeMonitor
from alerts import AlertManager, create_and_send_alert
from models import DistressSignal, DistressAlert, Watchlist
from sqlalchemy.orm import Session
import yaml
from datetime import datetime


class DistressScannerService:
    """Service wrapper for distress scanner"""
    
    def __init__(self, db_session: Session, config_path: str = 'config/distress_scanner.yaml'):
        # Load config
        with open(config_path) as f:
            self.config = yaml.safe_load(f)
        
        # Initialize scanner
        api_key = self.config['scanner'].get('finnhub_api_key')
        self.scanner = DistressScanner(finnhub_api_key=api_key)
        
        # Initialize alert manager
        alert_config = self.config['scanner']['alerts']
        self.alert_manager = AlertManager(
            webhook_url=alert_config.get('webhook_url'),
            slack_webhook=alert_config.get('slack_webhook'),
            discord_webhook=alert_config.get('discord_webhook'),
            email_config=alert_config.get('email') if alert_config['email'].get('enabled') else None
        )
        
        # Database session
        self.db = db_session
    
    def scan_and_store(self, tickers: list) -> list:
        """Scan tickers and store results in database"""
        results = []
        
        for ticker in tickers:
            # Scan ticker
            scan_result = self.scanner.scan_ticker(
                ticker,
                days_back=self.config['scanner']['days_back']
            )
            
            # Store in database
            signal = DistressSignal(
                ticker=ticker,
                scan_timestamp=datetime.utcnow(),
                distress_score=scan_result['score'],
                raw_score=scan_result['score'],
                alert_triggered=scan_result['alert'],
                signals_triggered=scan_result.get('signals_triggered', 0),
                signal_details=scan_result.get('signals', []),
                filings_8k_count=scan_result['data'].get('filings_8k', 0),
                form4_filings_count=scan_result['data'].get('form4_filings', 0),
                news_count=scan_result['data'].get('news_count', 0),
                news_sentiment_avg=scan_result['data']['news_sentiment'].get('average_sentiment'),
                news_sentiment_negative_ratio=scan_result['data']['news_sentiment'].get('negative_ratio'),
                days_until_earnings=scan_result['data'].get('days_until_earnings'),
                has_recommendation=False  # Will add later
            )
            
            self.db.add(signal)
            self.db.commit()
            
            # Send alert if triggered
            if scan_result['alert']:
                self.send_alert(signal, scan_result)
            
            results.append(scan_result)
        
        return results
    
    def send_alert(self, signal: DistressSignal, scan_result: dict):
        """Send alert for triggered signal"""
        # Send through alert manager
        success = self.alert_manager.send_alert(
            ticker=signal.ticker,
            score=signal.distress_score,
            signals=signal.signal_details,
            recommendation=None  # Add trade rec generation here
        )
        
        # Record alert in database
        alert = DistressAlert(
            signal_id=signal.id,
            ticker=signal.ticker,
            alert_timestamp=datetime.utcnow(),
            distress_score=signal.distress_score,
            sent=success,
            delivery_channels=['slack', 'webhook'],  # Track which channels were used
            delivery_status={'slack': 'sent' if success else 'failed'}
        )
        
        self.db.add(alert)
        self.db.commit()
    
    def run_watchlist_scan(self):
        """Scan configured watchlist"""
        watchlist = self.config['scanner']['watchlist']
        print(f"Scanning watchlist: {watchlist}")
        return self.scan_and_store(watchlist)


# Integration with existing AlphaTrades background jobs
def setup_background_job():
    """Setup scanner as background job"""
    from apscheduler.schedulers.background import BackgroundScheduler
    from database import get_db_session  # Your existing DB session
    
    scheduler = BackgroundScheduler()
    
    def scan_job():
        db = get_db_session()
        service = DistressScannerService(db)
        service.run_watchlist_scan()
    
    # Schedule every hour
    interval = config['scanner']['scan_interval_minutes']
    scheduler.add_job(scan_job, 'interval', minutes=interval)
    scheduler.start()
    
    return scheduler
```

## 🚀 Phase 3: Background Service

### Option A: Integrate with Existing Background Jobs

```python
# In your existing AlphaTrades/app.py or main.py

from services.distress_scanner_service import setup_background_job

# During app initialization
if config['scanner']['enabled']:
    scanner_scheduler = setup_background_job()
    print("✅ Distress scanner background job started")
```

### Option B: Separate Service

Create `services/distress_monitor.py`:

```python
#!/usr/bin/env python3
"""
Standalone distress scanner service
Run as: python services/distress_monitor.py
"""

from distress_scanner_service import DistressScannerService
from database import get_db_session
import time
import yaml

def main():
    # Load config
    with open('config/distress_scanner.yaml') as f:
        config = yaml.safe_load(f)
    
    interval_minutes = config['scanner']['scan_interval_minutes']
    
    print(f"🚀 Starting distress scanner service (interval: {interval_minutes}m)")
    
    while True:
        try:
            db = get_db_session()
            service = DistressScannerService(db)
            service.run_watchlist_scan()
            
            print(f"✅ Scan complete, sleeping {interval_minutes} minutes...")
            time.sleep(interval_minutes * 60)
            
        except KeyboardInterrupt:
            print("\n🛑 Shutting down...")
            break
        except Exception as e:
            print(f"❌ Error: {e}")
            time.sleep(60)  # Wait 1 min on error

if __name__ == "__main__":
    main()
```

### Option C: Systemd Service (Production)

Create `/etc/systemd/system/alphatrades-scanner.service`:

```ini
[Unit]
Description=AlphaTrades Distress Scanner
After=network.target postgresql.service

[Service]
Type=simple
User=alphatrades
WorkingDirectory=/opt/AlphaTrades
Environment="DATABASE_URL=postgresql://user:pass@localhost/alphatrades"
Environment="FINNHUB_API_KEY=your_key_here"
ExecStart=/opt/AlphaTrades/venv/bin/python services/distress_monitor.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable alphatrades-scanner
sudo systemctl start alphatrades-scanner
sudo systemctl status alphatrades-scanner
```

## 🎨 Phase 4: Dashboard Integration

### Add API Endpoints

In your existing Flask/FastAPI app:

```python
# routes/distress_scanner.py

from flask import Blueprint, jsonify, request
from models import DistressSignal, DistressAlert
from sqlalchemy import desc

bp = Blueprint('scanner', __name__, url_prefix='/api/scanner')

@bp.route('/signals', methods=['GET'])
def get_signals():
    """Get recent distress signals"""
    limit = request.args.get('limit', 50, type=int)
    
    signals = DistressSignal.query\
        .order_by(desc(DistressSignal.scan_timestamp))\
        .limit(limit)\
        .all()
    
    return jsonify([s.to_dict() for s in signals])

@bp.route('/alerts', methods=['GET'])
def get_alerts():
    """Get recent alerts"""
    limit = request.args.get('limit', 20, type=int)
    
    alerts = DistressAlert.query\
        .filter_by(alert_triggered=True)\
        .order_by(desc(DistressAlert.alert_timestamp))\
        .limit(limit)\
        .all()
    
    return jsonify([
        {
            'ticker': a.ticker,
            'score': a.distress_score,
            'timestamp': a.alert_timestamp.isoformat(),
            'signals': a.signal_details
        }
        for a in alerts
    ])

@bp.route('/scan/<ticker>', methods=['POST'])
def scan_ticker(ticker):
    """Manually trigger scan for a ticker"""
    from services.distress_scanner_service import DistressScannerService
    
    service = DistressScannerService(db.session)
    result = service.scan_and_store([ticker])
    
    return jsonify(result[0])

# Register blueprint
app.register_blueprint(bp)
```

### Add Dashboard Widget

React/Vue component example:

```javascript
// components/DistressSignals.jsx

import React, { useEffect, useState } from 'react';

export function DistressSignals() {
  const [alerts, setAlerts] = useState([]);
  
  useEffect(() => {
    fetch('/api/scanner/alerts?limit=10')
      .then(r => r.json())
      .then(setAlerts);
  }, []);
  
  return (
    <div className="distress-signals-widget">
      <h3>🚨 Distress Alerts</h3>
      {alerts.map(alert => (
        <div key={alert.ticker} className="alert-card">
          <div className="ticker">{alert.ticker}</div>
          <div className="score">{alert.score}/100</div>
          <div className="signals">
            {alert.signals.map(s => (
              <span className="signal-badge">{s.type}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

## 🤖 Phase 5: Trade Execution Integration

### Link to Robinhood Integration

```python
# services/trade_executor.py

from alerts import TradeRecommendationEngine
from robinhood_integration import RobinhoodClient  # Your existing Robinhood code

class DistressTradeExecutor:
    """Execute trades based on distress signals"""
    
    def __init__(self, robinhood_client: RobinhoodClient):
        self.rh = robinhood_client
    
    def execute_put_recommendation(self, ticker: str, score: int, current_price: float, days_until_earnings: int):
        """Execute PUT trade based on distress signal"""
        
        # Generate recommendation
        rec = TradeRecommendationEngine.calculate_strike_and_expiry(
            ticker=ticker,
            current_price=current_price,
            distress_score=score,
            days_until_earnings=days_until_earnings
        )
        
        # Check confidence threshold
        if rec.confidence != 'HIGH':
            print(f"⚠️  Confidence {rec.confidence}, manual review recommended")
            return None
        
        # Execute trade on Robinhood
        print(f"💰 Executing: {rec.action} {ticker} {rec.strike} PUT @ {rec.expiry}")
        
        order = self.rh.place_option_order(
            ticker=ticker,
            option_type='put',
            strike=rec.strike,
            expiration=rec.expiry,
            quantity=1,
            side='buy'
        )
        
        return order
```

### Auto-Execute vs Manual Review

```python
# In your config
scanner:
  auto_execute:
    enabled: false  # Set to true for auto-execution
    min_score: 80   # Only auto-execute very high confidence
    max_position_size: 100  # Max $ per trade
    require_manual_approval: true  # Send to approval queue
```

## 📊 Phase 6: Monitoring & Logging

### Add Logging

```python
# In distress_scanner_service.py

import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/var/log/alphatrades/scanner.log'),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger('distress_scanner')

# Use in service
logger.info(f"Scanning {ticker}...")
logger.warning(f"Alert triggered for {ticker}: score {score}")
logger.error(f"Error scanning {ticker}: {e}")
```

### Add Metrics

```python
# Track scanner performance
from dataclasses import dataclass
from datetime import datetime

@dataclass
class ScannerMetrics:
    total_scans: int = 0
    alerts_triggered: int = 0
    api_calls: int = 0
    errors: int = 0
    avg_scan_time: float = 0.0
    last_scan: datetime = None

# Store in Redis or database
# Display in monitoring dashboard
```

## ✅ Deployment Checklist

### Pre-Deployment
- [ ] Database tables created
- [ ] Config file created and tested
- [ ] API keys configured (Finnhub)
- [ ] Webhook URLs configured (Slack/Discord)
- [ ] Test suite passing (`python test_distress_scanner.py`)
- [ ] Integration tests with existing DB
- [ ] Review watchlist tickers

### Deployment
- [ ] Copy files to production server
- [ ] Install dependencies (`pip install -r requirements.txt`)
- [ ] Configure systemd service (if applicable)
- [ ] Start background service
- [ ] Verify first scan completes successfully
- [ ] Test alert delivery

### Post-Deployment
- [ ] Monitor logs for errors
- [ ] Verify database records being created
- [ ] Check alert notifications working
- [ ] Review initial signals for accuracy
- [ ] Adjust thresholds if needed
- [ ] Document any customizations

## 🎯 Testing Strategy

### Test in Staging First

```bash
# Use staging database
export DATABASE_URL="postgresql://user:pass@staging/alphatrades_staging"

# Run scanner against staging
python distress_scanner.py AAPL TSLA --export staging_test.json

# Check results
cat staging_test.json
```

### Monitor for 1 Week

Before enabling auto-execution:
1. Run scanner in monitoring mode for 1 week
2. Review all alerts manually
3. Validate signal accuracy
4. Adjust thresholds based on false positive rate
5. Paper trade recommendations

### Gradual Rollout

1. **Week 1:** Monitoring only, no alerts
2. **Week 2:** Enable alerts, manual review
3. **Week 3:** Add to dashboard, increase watchlist
4. **Week 4:** Enable auto-execute for HIGH confidence only
5. **Week 5+:** Full production

## 📞 Support & Maintenance

### Regular Tasks

**Daily:**
- Check alert logs
- Review triggered signals
- Monitor API rate limits

**Weekly:**
- Analyze signal accuracy
- Adjust watchlist
- Review false positives/negatives
- Update thresholds if needed

**Monthly:**
- Performance review
- Cost analysis (API usage)
- Feature improvements
- Backtest recent market events

### Troubleshooting

Common issues and solutions in `README.md` Troubleshooting section.

### Updates

To update the scanner:
```bash
# Pull latest changes
git pull origin main

# Update dependencies
pip install -r requirements.txt --upgrade

# Restart service
sudo systemctl restart alphatrades-scanner
```

## 🎉 Success Metrics

Track these KPIs:

- **Alert Accuracy:** % of alerts that result in actual price drops
- **Lead Time:** Days between alert and price drop
- **Win Rate:** % of PUT trades that profit
- **ROI:** Total return on investment from Strategy 3
- **API Costs:** Monthly API spend
- **Uptime:** Scanner service availability %

Target: **>60% accuracy, 2-5 day lead time, 50%+ win rate**

---

**Integration Timeline: 1-2 weeks**

Week 1: Database + Code Integration + Testing  
Week 2: Deployment + Monitoring + Optimization

**Questions?** parker@ideaworx.co
