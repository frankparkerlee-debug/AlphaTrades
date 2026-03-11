# Launch Control v1/v2 — Legacy Worker Documentation
# Documented before suspension on 2026-03-11
# DO NOT DELETE — reference for any functionality not yet in v3

---

## WORKER: worker.py
**Purpose:** Background worker for Launch Control v2.0  
**Status:** SUSPENDED 2026-03-11 (replaced by v3 Node.js worker)  
**Render service:** Python worker — `python -u worker.py`

### What it does
- Runs a scoring loop every 2 seconds
- Scores 15 hardcoded tickers: NVDA, TSLA, AMD, AAPL, MSFT, META, GOOGL, AMZN, NVDA, SPY, QQQ, AVGO, ARM, PLTR, SMCI
- Fetches data from Alpaca REST snapshots (not WebSocket) on each cycle
- Fetches news from Alpaca news API
- Writes signals to `public.signals` table (v1 schema, SQLAlchemy Signal model)
- Uses LaunchControlScorer (scorer_launchcontrol.py) for scoring

### Data sources
- Alpaca snapshots REST endpoint — price, volume, prev close
- Alpaca news REST endpoint — recent headlines per ticker
- No WebSocket streaming — pure REST polling every 2 seconds

### Signal output (public.signals table)
- ticker, score (0-100), grade, price, change_pct
- convergence_json — pillar breakdown stored as JSON
- option_json — basic contract suggestion
- created_at timestamp

### Key limitations vs v3
- 15 tickers only (v3 covers full Nasdaq 100)
- Daily volume average only (v3 uses per-window baselines)
- No cluster propagation
- No pre-market intelligence
- No extended hours scoring
- REST polling every 2s vs WebSocket streams
- No confluence detection
- No position sizing logic

---

## SCORER: scorer_launchcontrol.py (v2.0)
**5-pillar system, 100 points total**

### Pillars
| Pillar | Max | Method |
|---|---|---|
| Price Action | 35 | ATR-normalized move from prev close |
| Volume | 30 | Relative volume vs daily average |
| News | 15 | Keyword sentiment on headlines |
| Market | 15 | QQQ + sector ETF alignment |
| Timing | 5 | Time-of-day gate |

### Asymmetry Gate
- PA must score > 17.5 AND Volume must score > 15.0
- If either fails → signal rejected regardless of total

### Grade scale
- A+ : 83+
- A  : 73+
- A- : 63+
- B+ : 53+
- B  : 43+
- Below 43 → rejected

### Direction determination
- Based on change_pct from prev close
- Positive → CALL, Negative → PUT
- Simple — no multi-factor direction logic

### News scoring
- Keyword matching on headline text
- Positive keywords: beat, upgrade, buyback, partnership, etc.
- Negative keywords: miss, downgrade, lawsuit, layoff, etc.
- No catalyst type classification
- No sensitivity multipliers per ticker

### Volume scoring
- Compares current volume to 20-day average daily volume
- Does NOT use per-window baselines
- Morning volume always appears low relative to full-day average
- This caused systematic under-scoring in first 2 hours — FIXED in v3

### Market alignment
- Two layers: QQQ + sector ETF
- v3 has three layers: SPY + exchange ETF + sector ETF

---

## SCORER: scorer_v5.py (v5 — legacy, not in use)
**Not used by worker.py — historical reference only**

### Pillars (different from v2)
- Catalyst, Volume, Direction, Range, Timing, Calendar, Alignment, RSI
- RSI-based scoring — removed in v2 due to lag
- Calendar scoring — earnings proximity bonus
- Range scoring — day range expansion

### Why deprecated
- Too many pillars created noise
- RSI added lag, not edge
- Replaced by cleaner 5-pillar v2 system

---

## DATABASE: public.signals (v1 schema)
**Still exists in Render Postgres — not being written to after v1 suspension**

```sql
- id (serial primary key)
- ticker (varchar)
- score (integer, 0-100)
- grade (varchar)
- price (numeric)
- change_pct (numeric)
- convergence_json (jsonb) -- pillar scores
- option_json (jsonb)      -- contract suggestion
- signal_tier (varchar)
- human_taken (boolean)
- human_pnl_pct (numeric)
- created_at (timestamp)
```

### Key difference from lc_v3.signals
- No direction column (derived from change_pct)
- No per-pillar score columns (stored in convergence_json)
- No cluster/propagation fields
- No position sizing fields
- No confluence score

---

## FUNCTIONALITY CHECKLIST
Everything below exists in v1 but verify it's working in v3:

- [x] 5-pillar scoring (PA, Vol, News, Market, Timing)
- [x] Asymmetry gate (PA > 17.5, Vol > 15)
- [x] Grade scale (A+ through B)
- [x] Direction determination (CALL/PUT)
- [x] Market alignment scoring
- [x] News sentiment scoring
- [x] Signal writing to DB
- [x] Take/skip recording
- [x] Options contract suggestion
- [x] Extended hours scoring (NEW in v3)
- [x] Per-window volume baselines (NEW in v3)
- [x] Cluster propagation (NEW in v3)
- [x] Full Nasdaq 100 coverage (NEW in v3)
- [x] Pre-market intelligence scan (NEW in v3)
- [x] Confluence detection (NEW in v3)
- [x] Three-layer market alignment (NEW in v3)
- [x] WebSocket streaming vs REST polling (NEW in v3)

---

## TO RESTORE V1 (if needed)
1. Render → suspended worker service → Resume
2. Confirm ALPACA_API_KEY and DATABASE_URL are still set
3. Worker will restart and resume writing to public.signals
4. Dashboard /launchcontrol reads from lc_v3.signals — unaffected

## FILES TO PRESERVE
- worker.py
- scorer_launchcontrol.py
- scorer_v5.py
- models.py (contains Signal model for public.signals)
- schema.sql (v1 schema definition)
