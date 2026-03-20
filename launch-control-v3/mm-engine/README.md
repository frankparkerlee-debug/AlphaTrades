# Launch Control MM — Paper Engine

NYSE financial sector options market making. Paper trading on Alpaca.

## What this builds

A complete market making engine that:
1. Scans JPM, GS, BAC, MS, WFC every morning for viable put strikes
2. Monitors the tape for confirmed two-way flow before posting quotes  
3. Posts bid/ask inside the market at 35–45% of raw spread
4. Tracks positions with hard 60-second TTL
5. Logs every fill with full context (ML training data)
6. Enforces all risk controls before every order

## Setup

### 1. Get Alpaca paper API keys
Go to https://app.alpaca.markets → Paper Account → API Keys → Generate

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env and add your paper API keys
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Run the dead man's switch FIRST (separate terminal)
```bash
cd src
python dead_mans_switch.py
```
The DMS must be running before the engine starts.
It monitors engine heartbeat and flattens all positions if the engine dies.

### 5. Run the engine (second terminal)
```bash
cd src
python engine.py
# or for dry run (no orders submitted):
python engine.py --dry-run
```

## Architecture

```
engine.py (main loop, 2-second cycle)
    ├── MorningScanner     — 9:00 AM, filters universe for viable strikes
    ├── TapeMonitor        — websocket, watches real-time prints
    ├── QuoteEngine        — submits/tracks limit orders
    ├── PositionManager    — tracks inventory, enforces TTL
    ├── FillLogger         — records every fill to CSV + JSONL
    └── RiskManager
            ├── OrderRateLimiter  — hard 5 ops/sec
            ├── KillSwitch        — halt at -$800 unrealized
            ├── PDTGuard          — halt if balance < $26,500
            ├── DataFreshness     — require data < 2 seconds old
            └── PositionCounter   — max 8 concurrent positions

dead_mans_switch.py (separate process)
    — monitors heartbeat file every 5 seconds
    — flattens all positions if heartbeat stops for 30+ seconds
```

## Risk controls (non-negotiable)

| Control | Trigger | Action |
|---------|---------|--------|
| Kill switch | Unrealized P&L < -$800 | Halt all quoting. Manual reset only. |
| Rate limiter | > 5 ops/second | Block order. Log warning. |
| PDT guard | Balance < $26,500 | No new positions. |
| Data freshness | Data > 2 seconds old | Cancel all quotes. |
| TTL | 60 seconds since open | Cancel open quote. Flatten inventory. |
| Dead man's switch | Heartbeat missing 30s | Flatten all positions via market orders. |

## Output files

### logs/fills_YYYYMMDD.csv
One row per completed round-trip. Key columns:
- `net_pnl` — actual P&L after fees and modeled slippage
- `hold_seconds` — how long inventory was held
- `adverse_selection` — True if market moved immediately against us
- `tape_confirmed` — True if entry required 3+ prints each side
- `close_reason` — `natural_fill`, `ttl_cancel`, `kill_switch`

### data/fills_YYYYMMDD.jsonl
Same data in JSON lines format for ML pipeline.

## What the paper phase measures

The goal is 1,500 labeled fills over 6 weeks. Key metrics to track:

| Metric | Target | Action if missed |
|--------|--------|------------------|
| Win rate | > 90% | Review tape filter threshold |
| Adverse selection rate | < 4% | Retrain classifier |
| Avg hold time | < 90 seconds | Verify TTL and tape confirmation |
| Daily P&L | > $0 | Review spread width and capture % |
| Fill rate | > 10% of cycles | Check universe liquidity |

## Adding your API keys to .env

```
ALPACA_API_KEY=PKxxxxxxxxxxxxxxxxxxxxxxxx
ALPACA_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

Paper trading URL: `https://paper-api.alpaca.markets`
Live trading URL:  `https://api.alpaca.markets` (only after paper phase proven)
