# 🚀 Quick Reference Guide

**1-Page Cheat Sheet for Distress Scanner**

---

## ⚡ Quick Start (30 seconds)

```bash
# 1. Install
pip install -r requirements.txt

# 2. Scan a ticker
python3 distress_scanner.py LULU

# 3. Done! Check the score.
```

---

## 📊 CLI Commands

```bash
# Single ticker
python3 distress_scanner.py AAPL

# Multiple tickers
python3 distress_scanner.py LULU META SNAP NFLX

# Scan with more history
python3 distress_scanner.py LULU --days-back 60

# Export to JSON
python3 distress_scanner.py LULU META --export results.json

# Continuous monitoring (every 60 min)
python3 distress_scanner.py LULU META --monitor --interval 60

# With Finnhub API key
python3 distress_scanner.py LULU --api-key YOUR_KEY_HERE
```

---

## 🐍 Python API

### Simple Scan

```python
from distress_scanner import DistressScanner

scanner = DistressScanner()
result = scanner.scan_ticker('LULU')

print(f"Score: {result['score']}/100")
print(f"Alert: {result['alert']}")
```

### Batch Scan

```python
watchlist = ['LULU', 'META', 'SNAP']
results = scanner.scan_multiple(watchlist)

# Get only alerts
alerts = scanner.get_alerts(results)
```

### With Alerts

```python
from alerts import AlertManager

alert_mgr = AlertManager(
    slack_webhook="https://hooks.slack.com/..."
)

if result['alert']:
    alert_mgr.send_alert(
        ticker='LULU',
        score=result['score'],
        signals=result['signals']
    )
```

---

## 📈 Scoring System

| Score | Action | Example |
|-------|--------|---------|
| 0-39 | ✅ Normal - no action | AAPL (stable) |
| 40-59 | ⚠️ Watch list | Monitor closely |
| 60-79 | 🚨 Alert - MEDIUM confidence | Consider PUT |
| 80-100 | 🚨🚨 High Alert - HIGH confidence | Strong PUT play |

---

## 🎯 Signals & Weights

| Signal | Weight | Trigger |
|--------|--------|---------|
| Executive Departure | +30 | Recent 8-K filing |
| Insider Selling Spike | +25 | 3x normal Form 4s |
| Negative News | +20 | Sentiment <-0.3 |
| Unusual PUT Volume | +15 | PUT/CALL 2x normal |
| Analyst Downgrade | +10 | 1+ in 30 days |
| Near Earnings | +10 | Within 5 days |

**Alert Threshold:** 60 points

---

## 💰 Trade Recommendations

### High Confidence (80+ score)
- Strike: 5% OTM (near ATM)
- Expiry: 1 week
- Size: 5-10% of capital

### Medium Confidence (60-79 score)
- Strike: 8-12% OTM
- Expiry: 2-3 weeks
- Size: 3-5% of capital

### Risk Management
- Stop loss: -50% (PUTs expire worthless)
- Take profit: +50% to +100%
- Max position: 10% of capital

---

## 🔧 Configuration

### Environment Variables

```bash
# Optional: Better news data
export FINNHUB_API_KEY="your_key"

# Optional: Alert webhooks
export SLACK_WEBHOOK_URL="https://hooks.slack.com/..."
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
```

### Finnhub API Key (Free)

1. Visit https://finnhub.io
2. Sign up (free)
3. Get API key (60 calls/min free tier)
4. Set environment variable

---

## 🧪 Testing

```bash
# Run full test suite
python3 test_distress_scanner.py

# Test with live API
python3 test_distress_scanner.py --live

# Run examples
python3 example_usage.py
```

---

## 🔍 Interpreting Results

### Example Output

```
🔍 Scanning LULU...
  📄 Fetching SEC filings...
     8-K filings: 1        ← Executive change detected
     Form 4 filings: 6     ← Insider selling spike!
  📰 Fetching and analyzing news...
     News articles: 10
     Avg sentiment: -0.65  ← Very negative!
     Negative ratio: 80.0% ← Most articles negative
  📅 Checking earnings calendar...
     Next earnings: 3 days ← Near earnings!
  📊 Calculating distress score...

  🚨 ALERT | Score: 75/100 | Signals: 4
```

**Interpretation:** High probability of price drop soon. Consider buying PUTs.

---

## 🎓 Best Practices

### Do's ✅
- ✅ Scan daily during market hours
- ✅ Combine multiple signals
- ✅ Wait for score ≥60 before trading
- ✅ Paper trade first (1-2 weeks)
- ✅ Size positions appropriately

### Don'ts ❌
- ❌ Trade on single signal alone
- ❌ Ignore stop losses
- ❌ Over-leverage
- ❌ Trade without validation
- ❌ Ignore market conditions

---

## 📞 Common Issues

### "401 Unauthorized" for news
→ Using demo Finnhub key (limited)  
→ Get free API key: https://finnhub.io

### "No CIK found"
→ Ticker may be wrong or delisted  
→ Check ticker spelling

### "Rate limit exceeded"
→ Too many API calls  
→ Increase delay or upgrade API plan

### Low scores for known issues
→ Check `--days-back` parameter  
→ Some signals may not be public yet

---

## 📚 File Reference

| File | Purpose |
|------|---------|
| `distress_scanner.py` | Main scanner |
| `data_sources.py` | API integrations |
| `scorer_distress.py` | Scoring algorithm |
| `alerts.py` | Alert system |
| `models.py` | Database models |
| `test_distress_scanner.py` | Test suite |
| `example_usage.py` | Code examples |

---

## 🚀 Next Steps

1. **Week 1:** Run scanner, validate signals
2. **Week 2:** Paper trade recommendations
3. **Week 3:** Small real positions (≤$100)
4. **Week 4+:** Scale up gradually

---

## 🆘 Emergency Contacts

- **Documentation:** README.md
- **Integration:** INTEGRATION_PLAN.md
- **Deployment:** DEPLOYMENT_SUMMARY.md
- **Support:** parker@ideaworx.co

---

## ⚖️ Disclaimer

**NOT FINANCIAL ADVICE**

This is educational software. Trading involves risk. Past performance ≠ future results. Do your own research.

---

**Built for AlphaTrades Strategy 3: $2,500 → $200K**

*Find the distress signals before the market does.* 🎯
