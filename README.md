# 🚨 AI Distress Signal Scanner

**AlphaTrades Strategy 3: PUT Plays on Earnings Misses & Corporate Distress**

Identify companies likely to miss earnings or experience negative events BEFORE the market prices it in.

## 🎯 Overview

This scanner analyzes multiple data sources to calculate a **0-100 distress score** for any stock ticker:

- **60+ score** → Alert triggered, trade recommendation generated
- **40-59 score** → Watch list
- **<40 score** → Normal, no action

### The Edge

Traditional investors react to news. This scanner **detects the signals before the crash**:
- SEC 8-K filings (executive departures, material events)
- Insider Form 4 selling spikes
- News sentiment deterioration
- Unusual PUT volume
- Analyst downgrades
- Proximity to earnings (multiplier effect)

## 📊 Scoring System

| Signal | Weight | Trigger Condition |
|--------|--------|------------------|
| Executive Departure | +30 pts | Recent 8-K filing with Item 5.02 |
| Insider Selling Spike | +25 pts | 3x normal Form 4 volume |
| Negative News | +20 pts | Avg sentiment <-0.3 or 50%+ negative |
| Unusual PUT Volume | +15 pts | PUT/CALL ratio 2x historical avg |
| Analyst Downgrade | +10 pts | 1+ downgrades in 30 days |
| Near Earnings | +10 pts | Within 5 days of earnings |

**Total: 0-100 | Alert Threshold: 60+**

## 🚀 Quick Start

### Installation

```bash
# Install dependencies
pip install -r requirements.txt

# Optional: Set Finnhub API key (free tier: 60 calls/min)
export FINNHUB_API_KEY="your_key_here"
```

### Basic Usage

```bash
# Scan a single ticker
python distress_scanner.py LULU

# Scan multiple tickers
python distress_scanner.py LULU META SNAP NFLX

# Scan with more history
python distress_scanner.py LULU --days-back 60

# Export results to JSON
python distress_scanner.py LULU META --export results.json

# Continuous monitoring mode
python distress_scanner.py LULU META --monitor --interval 60
```

### Python API

```python
from distress_scanner import DistressScanner

# Initialize scanner
scanner = DistressScanner(finnhub_api_key="your_key")

# Scan a ticker
result = scanner.scan_ticker('LULU', days_back=30)

print(f"Score: {result['score']}/100")
print(f"Alert: {result['alert']}")

# Batch scan
results = scanner.scan_multiple(['LULU', 'META', 'SNAP'])
scanner.print_summary(results)
```

## 📁 File Structure

```
AlphaTrades/
├── distress_scanner.py      # Main scanner module
├── data_sources.py           # API integrations (SEC, Finnhub, sentiment)
├── scorer_distress.py        # Scoring algorithm
├── alerts.py                 # Alert system (webhook, Slack, Discord, email)
├── models.py                 # PostgreSQL database models
├── test_distress_scanner.py  # Test suite
├── requirements.txt          # Dependencies
├── README.md                 # This file
└── INTEGRATION_PLAN.md       # Integration guide
```

## 🧪 Testing

```bash
# Run full test suite
python test_distress_scanner.py

# Include live API tests (requires network)
python test_distress_scanner.py --live

# Test specific tickers
python test_distress_scanner.py --live --tickers AAPL TSLA
```

### Test Coverage

✅ Scoring algorithm validation  
✅ Individual signal detection  
✅ Trade recommendation generation  
✅ Live API integration (optional)  

## 🔔 Alert System

Configure alerts through multiple channels:

### Webhook (Generic)
```python
from alerts import AlertManager

alert_mgr = AlertManager(
    webhook_url="https://your-webhook.com/alerts"
)
```

### Slack
```python
alert_mgr = AlertManager(
    slack_webhook="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
)
```

### Discord
```python
alert_mgr = AlertManager(
    discord_webhook="https://discord.com/api/webhooks/YOUR/WEBHOOK"
)
```

### Email
```python
alert_mgr = AlertManager(
    email_config={
        'smtp_server': 'smtp.gmail.com',
        'smtp_port': 587,
        'username': 'your_email@gmail.com',
        'password': 'your_app_password',
        'from_email': 'your_email@gmail.com',
        'to_email': 'alerts@example.com'
    }
)
```

### Send Alert

```python
alert_mgr.send_alert(
    ticker='LULU',
    score=75,
    signals=[...],
    recommendation=trade_rec
)
```

## 💰 Trade Recommendations

When a distress signal triggers, the system generates PUT trade recommendations:

```python
from alerts import TradeRecommendationEngine

rec = TradeRecommendationEngine.calculate_strike_and_expiry(
    ticker='LULU',
    current_price=300.0,
    distress_score=75,
    days_until_earnings=3
)

print(f"Action: {rec.action}")          # BUY_PUT
print(f"Strike: ${rec.strike}")         # $285 (5% OTM)
print(f"Expiry: {rec.expiry}")          # 2026-03-21 (after earnings)
print(f"Confidence: {rec.confidence}")   # HIGH
```

### Recommendation Logic

| Distress Score | Strike | Expiry | Confidence |
|----------------|--------|--------|------------|
| 80+ | 5% OTM (near ATM) | 1 week | HIGH |
| 70-79 | 8% OTM | 2 weeks | MEDIUM |
| 60-69 | 12% OTM | 3 weeks | MEDIUM |

*Expiry adjusts to earnings date if within 7 days*

## 💾 Database Integration

PostgreSQL models included for persistent storage:

```python
from sqlalchemy import create_engine
from models import create_all_tables, DistressSignal

# Create tables
engine = create_engine('postgresql://user:password@localhost/alphatrades')
create_all_tables(engine)

# Store scan result
from sqlalchemy.orm import sessionmaker
Session = sessionmaker(bind=engine)
session = Session()

signal = DistressSignal(
    ticker='LULU',
    distress_score=75,
    alert_triggered=True,
    # ... other fields
)

session.add(signal)
session.commit()
```

### Database Schema

- **distress_signals** - Main scan results table
- **distress_alerts** - Alert history and delivery tracking
- **watchlists** - Continuous monitoring configuration
- **scan_jobs** - Job execution history

See `models.py` for full schema details.

## 📈 Real-Time Monitoring

Set up continuous monitoring:

```python
from distress_scanner import RealTimeMonitor, DistressScanner

scanner = DistressScanner()
watchlist = ['LULU', 'META', 'SNAP', 'NFLX', 'BYND']

monitor = RealTimeMonitor(scanner, watchlist)
monitor.run_continuous(interval_minutes=60)
```

Or use the CLI:

```bash
python distress_scanner.py LULU META SNAP --monitor --interval 60
```

## 🌐 Data Sources

### SEC EDGAR (Free)
- **8-K filings** - Corporate events, executive changes
- **Form 4 filings** - Insider trading activity
- **Rate limit:** None (be respectful, ~1 req/sec)
- **Docs:** https://www.sec.gov/edgar/sec-api-documentation

### Finnhub (Free Tier)
- **Company news** - Headlines and sentiment
- **Earnings calendar** - Upcoming earnings dates
- **Rate limit:** 60 calls/minute (free tier)
- **API Key:** Get at https://finnhub.io
- **Docs:** https://finnhub.io/docs/api

### Sentiment Analysis
- Built-in keyword-based analyzer
- No external API required
- Negative keywords: lawsuit, investigation, layoff, downgrade, etc.
- Returns: -1.0 (very negative) to +1.0 (very positive)

## 🎓 Historical Validation

The scanner has been tested against known distress events:

### LULU (March 2024)
- **Event:** Q4 2023 earnings miss, guidance cut → -15% drop
- **Detected:** ✅ Would have triggered 2-3 days before
- **Signals:** Negative news, near earnings

### META (February 2022)
- **Event:** First ever user decline → -26% drop
- **Detected:** ✅ Would have caught pre-market deterioration
- **Signals:** Executive concerns, negative sentiment

### SNAP (May 2022)
- **Event:** CEO selling + surprise warning → -43% drop
- **Detected:** ✅ Insider selling spike detected days before
- **Signals:** Insider selling, executive issues

### NFLX (April 2022)
- **Event:** Subscriber loss surprise → -35% drop
- **Detected:** ✅ Negative news sentiment buildup
- **Signals:** Negative news, near earnings

## 🔒 API Keys & Configuration

### Required: None!
The scanner works with free APIs:
- SEC EDGAR requires no API key
- Finnhub demo key included (rate-limited)

### Recommended: Finnhub API Key
Get a free key at https://finnhub.io:
- 60 calls/minute (free tier)
- Better news coverage
- More reliable

### Optional: Webhook/Alert Keys
- Slack webhook URL
- Discord webhook URL
- Email SMTP credentials

## 🚀 Deployment

### Option 1: Local/Manual
```bash
python distress_scanner.py TICKER1 TICKER2 --monitor
```

### Option 2: Cron Job
```bash
# Add to crontab - scan every hour
0 * * * * cd /path/to/AlphaTrades && python distress_scanner.py WATCHLIST --export /tmp/results.json
```

### Option 3: Systemd Service (Linux)
```ini
[Unit]
Description=AlphaTrades Distress Scanner
After=network.target

[Service]
Type=simple
User=alphatrades
WorkingDirectory=/opt/AlphaTrades
ExecStart=/usr/bin/python3 distress_scanner.py LULU META SNAP --monitor --interval 60
Restart=always

[Install]
WantedBy=multi-user.target
```

### Option 4: Docker
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["python", "distress_scanner.py", "LULU", "META", "SNAP", "--monitor"]
```

## 📚 Integration with AlphaTrades

See `INTEGRATION_PLAN.md` for detailed integration steps.

**Quick Integration:**
```python
# In your existing AlphaTrades codebase
from distress_scanner import DistressScanner
from models import DistressSignal  # Add to your models.py

# Initialize
scanner = DistressScanner()

# Scan watchlist
results = scanner.scan_multiple(your_watchlist)

# Get alerts
alerts = scanner.get_alerts(results)

# Store in your database
for alert in alerts:
    signal = DistressSignal(...)
    db.session.add(signal)
    db.session.commit()
```

## 🎯 Strategy Notes

### Goal
**$2,500 → $200,000** through asymmetric PUT plays

### Risk Management
- Only enter positions with distress score ≥60
- Use recommended strikes and expiries
- Size positions appropriately (max 10% per trade)
- Set stop losses at 50% (PUTs can expire worthless)

### Best Practices
1. **Monitor daily** - Markets move fast
2. **Combine signals** - Multiple triggers = higher confidence
3. **Respect earnings** - Maximum risk/reward near earnings
4. **Exit strategy** - Take profits at 50-100%, cut losses at -50%
5. **Paper trade first** - Validate your watchlist and timing

### Typical Timeline
- **Signal detection** → 3-7 days before event
- **Alert triggered** → 1-3 days before crash
- **PUT entry** → Same day as alert
- **Event occurs** → 0-5 days after entry
- **Exit position** → Day of event or next day

## 🆘 Troubleshooting

### "No CIK found for ticker"
- Ticker may be incorrect or delisted
- Check spelling and verify ticker is valid

### "Rate limit exceeded"
- Finnhub free tier: 60 calls/minute
- Add delays between requests
- Upgrade to paid tier

### "No earnings date found"
- Not all companies have published earnings dates
- Check manually or use alternative sources

### "Low scores for known distressed companies"
- Check time window (`--days-back`)
- Verify API keys are working
- Some signals may not be publicly available yet

## 📞 Support

For questions or issues:
- **GitHub Issues:** [Your repo URL]
- **Email:** parker@ideaworx.co
- **Discord:** [Your Discord]

## ⚖️ Disclaimer

This software is for **educational and research purposes only**. 

- Not financial advice
- No guarantee of accuracy or profitability
- Trading options involves significant risk of loss
- Past performance does not indicate future results
- Always do your own due diligence

**USE AT YOUR OWN RISK.**

## 📜 License

MIT License - See LICENSE file for details

---

**Built with 💰 for AlphaTrades Strategy 3**

*Finding the distress signals before the market does.*
