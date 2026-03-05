# AlphaTrades - Automated Options Trading System

Cloud-based paper trading system that monitors momentum stocks, auto-executes trades, and optimizes strategy using machine learning.

## Architecture

**Platform:** Render.com  
**Database:** PostgreSQL  
**Language:** Python 3.11+  
**Framework:** Flask + SQLAlchemy  

## Components

### 1. Web Service (app.py)
- REST API for dashboard
- Trade history viewer
- Performance analytics
- Model configuration

### 2. Background Worker (worker.py)
- Monitors 12 tech stocks during market hours
- Calculates grades (A+/A/A-/B+/B/B-)
- Auto-executes paper trades on A+/A grades
- Manages position exits (Friday close, 2-5 day hold, stop loss, targets)

### 3. Database (PostgreSQL)
- `alerts`: Every grade calculation
- `trades`: All entries/exits with P/L
- `daily_performance`: Aggregated metrics
- `model_config`: Optimized thresholds

## Strategy (Strategy 1: Momentum)

**Stocks:** NVDA, TSLA, AMD, AAPL, AMZN, META, MSFT, GOOGL, NFLX, AVGO, ORCL, ADBE

**Scoring (out of 55 points):**
- Momentum: Up to 25 pts (% move from open)
- Range: Up to 15 pts (daily high-low %)
- Volume: 5 pts (fixed)
- Market: 10 pts (SPY direction)

**Grades:**
- A+ (50-55): Auto-trade
- A (47-49): Auto-trade
- A- (45-46): Auto-trade
- B+ (41-44): Log only
- B (38-40): Log only
- B- (35-37): Log only
- C/D: Skip

**Trade Rules:**
- Entry: ATM weekly call/put (7-14 DTE)
- Position: 20% of capital ($120/trade on $600 account)
- Hold: 2-5 days
- Exit: Friday 3pm OR 5 days OR -30% stop OR +50% target

## Deployment

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://...  # Render provides this
FINNHUB_API_KEY=your_key_here

# Optional
TRADING_MODE=paper  # paper or live
AUTO_TRADE_GRADES=A+,A  # Which grades to auto-trade
POSITION_SIZE_PCT=0.20  # 20% of capital
```

### Render Services

**Web Service:**
- Build Command: `pip install -r requirements.txt`
- Start Command: `gunicorn app:app`
- Port: 10000

**Background Worker:**
- Build Command: `pip install -r requirements.txt`
- Start Command: `python worker.py`

**Database:**
- PostgreSQL 512MB ($7/month)

### Deploy

```bash
git push origin main
```

Render auto-deploys on push.

## Usage

### Dashboard (Three-Page Architecture)

Access at `https://alphatrades.onrender.com` (or `http://localhost:10000` locally)

**1. 📊 Stock Cards** (`/`)
- Live monitoring grid for 12 tech stocks
- Real-time call/put grading (A+/A/A-/B+/B/B-)
- Entry points, strike prices, DTE (Days to Expiry)
- Click any card for detailed scoring breakdown and recent alerts
- Auto-refreshes every 30 seconds

**2. 💼 Trader Simulation** (`/trader`)
- Paper trading performance dashboard
- Account value, P/L, win rate, open positions
- Tabbed interface: Open Positions / Closed Trades / Performance Analytics
- Grade-by-grade performance breakdown
- Best/worst trades, average hold time, P/L per trade
- Auto-refreshes every 30 seconds

**3. 📋 Options Feed** (`/feed`)
- Historical alert log with full details
- Filter by: ticker, grade, direction (call/put), date range
- Search functionality for specific symbols
- Paginated results (50 per page)
- Each alert shows: date/time, ticker, strike, target price, expiry, scoring details
- Example format: "3/5/26, 12:20PM CST, AMD $200 Strike, 3/6/26 Expiry, $2.79/contract, GRADE A-"

### API Endpoints

**Dashboard:**
- `GET /` - Stock Cards (live monitoring)
- `GET /trader` - Trader Simulation (performance)
- `GET /feed` - Options Feed (historical alerts)
- `GET /api/alerts` - Recent alerts (JSON)
- `GET /api/trades` - Trade history (JSON)
- `GET /api/performance` - Daily metrics (JSON)

**Admin:**
- `GET /api/config` - Current model config
- `POST /api/config` - Update thresholds

### Monitor Logs

```bash
# Render dashboard > Services > Your Service > Logs
```

## Development

### Local Setup

```bash
# Clone repo
git clone https://github.com/frankparkerlee-debug/AlphaTrades.git
cd AlphaTrades

# Install dependencies
pip install -r requirements.txt

# Set up local database
createdb alphatrades
export DATABASE_URL=postgresql://localhost/alphatrades

# Run migrations
python init_db.py

# Start services
python app.py &      # API on localhost:5000
python worker.py &   # Background worker
```

### Database Schema

See `schema.sql` for full schema.

## Roadmap

- [x] Phase 1: Paper trading system
- [x] Phase 2: Alert logging & tracking
- [x] Phase 3: Auto-execution engine
- [ ] Phase 4: Model optimization (learning from trades)
- [ ] Phase 5: Schwab API integration (real trading)
- [ ] Phase 6: Multi-strategy support

## License

Private - Parker Lee
