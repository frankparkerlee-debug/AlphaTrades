"""
Launch Control MM — Configuration
All strategy parameters in one place. Change here, affects everywhere.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── Alpaca connection — LIVE keys (market data only) ─────────────────────────
ALPACA_API_KEY    = os.getenv("ALPACA_API_KEY", "")
ALPACA_API_SECRET = os.getenv("ALPACA_API_SECRET", "")

# ── Alpaca connection — PAPER keys (order execution only) ────────────────────
ALPACA_PAPER_API_KEY    = os.getenv("ALPACA_PAPER_API_KEY", "")
ALPACA_PAPER_API_SECRET = os.getenv("ALPACA_PAPER_API_SECRET", "")
ALPACA_PAPER_BASE_URL   = os.getenv("ALPACA_PAPER_BASE_URL", "https://paper-api.alpaca.markets")

# ── Universe ──────────────────────────────────────────────────────────────────
# NYSE financials only — institutional hedging flow creates consistent
# two-way markets with $0.13–$0.39 spreads on OTM puts
UNIVERSE = os.getenv("UNIVERSE", "JPM,GS,BAC,MS,WFC").split(",")

# ── Strategy parameters ───────────────────────────────────────────────────────
CONTRACTS_PER_TRADE  = int(os.getenv("CONTRACTS_PER_TRADE", 10))
SPREAD_CAPTURE_PCT   = float(os.getenv("SPREAD_CAPTURE_PCT", 0.40))   # 40% of raw spread
TARGET_DTE_MIN       = int(os.getenv("TARGET_DTE_MIN", 2))
TARGET_DTE_MAX       = int(os.getenv("TARGET_DTE_MAX", 14))
OTM_PCT_MIN          = float(os.getenv("OTM_PCT_MIN", -0.005))         # allow slightly ITM (0.5%)
OTM_PCT_MAX          = float(os.getenv("OTM_PCT_MAX", 0.04))          # up to 4% OTM
MIN_SPREAD_WIDTH     = float(os.getenv("MIN_SPREAD_WIDTH", 0.13))     # $0.13 minimum viable
MIN_DAILY_VOLUME     = int(os.getenv("MIN_DAILY_VOLUME", 150))        # contracts/day

# ── Risk controls (non-negotiable) ────────────────────────────────────────────
KILL_SWITCH_THRESHOLD  = float(os.getenv("KILL_SWITCH_THRESHOLD", -800))
PDT_FLOOR              = float(os.getenv("PDT_FLOOR", 25000))
PDT_ALERT_BUFFER       = float(os.getenv("PDT_ALERT_BUFFER", 26500))
MAX_OPS_PER_SECOND     = int(os.getenv("MAX_OPS_PER_SECOND", 5))
TTL_SECONDS            = int(os.getenv("TTL_SECONDS", 60))
TAPE_LOOKBACK_SECONDS  = int(os.getenv("TAPE_LOOKBACK_SECONDS", 60))
TAPE_MIN_PRINTS        = int(os.getenv("TAPE_MIN_PRINTS", 3))
MAX_CONCURRENT_POSITIONS = int(os.getenv("MAX_CONCURRENT_POSITIONS", 8))

# Dead man's switch heartbeat interval (seconds)
HEARTBEAT_INTERVAL = 30

# ── Fee model (for P&L simulation in paper mode) ──────────────────────────────
# Tastytrade: $10/leg to open, $0 to close
# Alpaca paper: regulatory fees only (~$0.05/contract)
FEE_PER_LEG_OPEN  = 0.50   # regulatory fees only in paper
FEE_PER_LEG_CLOSE = 0.25

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_DIR  = os.path.join(os.path.dirname(__file__), "..", "logs")
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# ── Market hours (ET) ─────────────────────────────────────────────────────────
MARKET_OPEN_HOUR   = 9
MARKET_OPEN_MINUTE = 30
MARKET_CLOSE_HOUR  = 16
SCAN_START_HOUR    = 9     # scanner runs from 9:00 AM
SCAN_START_MINUTE  = 0
TRADING_START_HOUR  = 9
TRADING_START_MINUTE = 45  # first trade not before 9:45 AM
TRADING_END_HOUR    = 15
TRADING_END_MINUTE  = 55   # stop 5 min before close for final TTL expiry
