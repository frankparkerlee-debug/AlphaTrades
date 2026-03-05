# AlphaTrades Dashboard Guide

## Three-Page Architecture

Your dashboard has been refactored into three focused pages with navigation bar at the top.

---

## 1. 📊 Stock Cards (`/`)

**Purpose:** Live stock monitoring with real-time grading

**Features:**
- Grid layout showing all 12 monitored stocks (NVDA, TSLA, AMD, etc.)
- Each card displays:
  - Current price and % change
  - CALL grade with strike price and DTE
  - PUT grade with strike price and DTE
- **Click any card** to see:
  - Full quote details (high, low, range %)
  - Recent alert history for that stock
  - Scoring breakdown table

**Data Source:**
- Live quotes from Finnhub API
- Recent alerts from PostgreSQL database
- Auto-refreshes every 30 seconds

**Example Card:**
```
┌─────────────────────┐
│ NVDA        $850.25 │
│             ▲ 3.45% │
├─────────────────────┤
│ 📈 CALL        A+   │
│ $850 Strike   7D    │
├─────────────────────┤
│ 📉 PUT         B+   │
│ $850 Strike   7D    │
└─────────────────────┘
```

---

## 2. 💼 Trader Simulation (`/trader`)

**Purpose:** Paper trading performance and position management

**Features:**

### Stats Overview (Top)
- Account Value (capital + open positions)
- Total P/L (cumulative profit/loss)
- Win Rate % (winning trades / total trades)
- Open Positions count

### Three Tabs:

**Tab 1: Open Positions**
- All active trades
- Entry time, ticker, direction, strike, grade
- Entry price and hold time
- Current status

**Tab 2: Closed Trades**
- Last 50 completed trades
- Full P/L details ($ and %)
- Hold days and exit reason
- Color-coded profit/loss

**Tab 3: Performance Analytics**
- Best/worst trade cards
- Average hold time and P/L per trade
- **Performance by Grade table:**
  - Shows win rate for A+, A, A-, B+, B, B- grades
  - Total P/L, average P/L, best/worst for each grade
  - Validates scoring accuracy

**Data Source:**
- Account state from PostgreSQL
- Open and closed trades from database
- Auto-refreshes every 30 seconds

---

## 3. 📋 Options Feed (`/feed`)

**Purpose:** Historical alert log with filtering and search

**Features:**

### Quick Stats (Top)
- Total alerts generated
- Today's alert count
- A-grade picks count
- B-grade picks count

### Filters
- **Search Ticker:** Filter by symbol (e.g., "NVDA", "TSLA")
- **Grade:** Dropdown (A+, A, A-, B+, B, B-, C+, C, C-, D)
- **Direction:** CALL or PUT
- **Start Date:** Filter from date
- **End Date:** Filter to date

### Results Table
Shows 50 alerts per page with:
- Date & Time (formatted: "3/5/26, 12:20PM CST")
- Ticker
- Direction (📈 CALL or 📉 PUT)
- Grade (color-coded badge)
- Score (out of 55)
- Strike price
- Target price per contract
- Expiry date and DTE
- Move % and Range %

**Example Row:**
```
Date & Time      | Ticker | Direction | Grade | Score | Strike  | Target      | Expiry        | Move % | Range %
03/05/26 12:20PM | AMD    | 📈 CALL   | A-    | 45/55 | $200.00 | $2.79/cont. | 03/06/26 (1D) | 3.25%  | 4.10%
```

### Pagination
- 50 results per page
- Page numbers at bottom
- Previous/Next buttons

**Data Source:**
- All alerts from PostgreSQL database
- Filtered and paginated server-side

---

## Navigation

Top navigation bar always visible:
- 📊 Stock Cards (home)
- 💼 Trader Simulation
- 📋 Options Feed

Click any tab to switch pages instantly.

---

## Deployment on Render

After pushing to GitHub, Render will auto-deploy:

1. **Web Service rebuilds** (~2-3 minutes)
2. Dashboard becomes available at: `https://alphatrades.onrender.com`
3. All three pages will be live

**Verify deployment:**
- Visit `https://alphatrades.onrender.com/` (Stock Cards)
- Click "💼 Trader Simulation" in nav
- Click "📋 Options Feed" in nav
- Check all three pages load correctly

---

## Technical Notes

### Templates Created
- `templates/base.html` - Base layout with navigation
- `templates/stock_cards.html` - Page 1 (live monitoring)
- `templates/trader_simulation.html` - Page 2 (performance)
- `templates/options_feed.html` - Page 3 (historical)

### Routes in app.py
- `GET /` → Stock Cards page
- `GET /trader` → Trader Simulation page
- `GET /feed` → Options Feed page
- `GET /api/alerts` → JSON endpoint for live data
- `GET /api/trades` → JSON endpoint for trades
- `GET /api/performance` → JSON endpoint for metrics

### Auto-Refresh
- Stock Cards and Trader Simulation: 30 seconds
- Options Feed: Manual (use filters to refresh data)

---

## What Changed from Old Dashboard

**Before:**
- Single-page dashboard
- Mixed stock alerts and trade performance
- Hard to find specific historical alerts

**After:**
- Three focused pages with clear separation
- Stock Cards: Real-time monitoring only
- Trader Simulation: Trading performance only
- Options Feed: Searchable historical data with filters

**Migration:**
- All existing data preserved in PostgreSQL
- Worker bot continues logging alerts and trades
- No interruption to trading system
- Dashboard is just a new view layer

---

## Next Steps

1. Wait for Render deployment to complete
2. Test all three pages
3. Verify filters work on Options Feed
4. Check stock cards show live data
5. Let system collect 2-4 weeks of paper trading data
6. Analyze performance by grade (Tab 3 on Trader Simulation page)
