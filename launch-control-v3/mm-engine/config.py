"""
Launch Control MM — Configuration
0DTE SPY gamma scalping parameters.
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

# ── Universe — 0DTE only ────────────────────────────────────────────────────
# SPY has daily expirations Mon-Fri. Tightest spreads, highest gamma.
UNIVERSE = os.getenv("UNIVERSE", "SPY").split(",")

# ── Scalper parameters ──────────────────────────────────────────────────────
CONTRACTS_PER_TRADE  = int(os.getenv("CONTRACTS_PER_TRADE", 1))
PROFIT_TARGET        = float(os.getenv("PROFIT_TARGET", 0.20))       # $0.20/contract = $20/trade
STOP_LOSS            = float(os.getenv("STOP_LOSS", 0.30))           # $0.30/contract = $30 max loss
HOLD_TTL_SECONDS     = int(os.getenv("HOLD_TTL_SECONDS", 90))        # flatten if no fill in 90s
BUY_TTL_SECONDS      = int(os.getenv("BUY_TTL_SECONDS", 10))         # market orders fill fast
MOMENTUM_BARS        = int(os.getenv("MOMENTUM_BARS", 2))            # consecutive 1-min bars for signal
COOLDOWN_SECONDS     = int(os.getenv("COOLDOWN_SECONDS", 10))        # wait after exit before re-entry
CYCLE_SECONDS        = int(os.getenv("CYCLE_SECONDS", 2))            # main loop interval (fast for stops)
RESCAN_INTERVAL      = int(os.getenv("RESCAN_INTERVAL", 120))        # rescan ATM strikes every 2 min
ATM_RANGE            = float(os.getenv("ATM_RANGE", 3.0))            # ± $3 from ATM for strike search
MAX_COST_PCT         = float(os.getenv("MAX_COST_PCT", 0.05))        # max 5% of balance per trade

# ── Scanner parameters (kept for scanner.py compatibility) ──────────────────
SPREAD_CAPTURE_PCT   = float(os.getenv("SPREAD_CAPTURE_PCT", 0.40))
TARGET_DTE_MIN       = 0
TARGET_DTE_MAX       = 0
OTM_PCT_MIN          = float(os.getenv("OTM_PCT_MIN", 0.0))
OTM_PCT_MAX          = float(os.getenv("OTM_PCT_MAX", 0.01))        # near ATM only
MIN_SPREAD_WIDTH     = float(os.getenv("MIN_SPREAD_WIDTH", 0.01))    # ATM 0DTE have tight spreads
MIN_DAILY_VOLUME     = int(os.getenv("MIN_DAILY_VOLUME", 0))

# ── Risk controls (non-negotiable) ────────────────────────────────────────────
KILL_SWITCH_THRESHOLD  = float(os.getenv("KILL_SWITCH_THRESHOLD", -500))
PDT_FLOOR              = float(os.getenv("PDT_FLOOR", 25000))
PDT_ALERT_BUFFER       = float(os.getenv("PDT_ALERT_BUFFER", 26500))
MAX_OPS_PER_SECOND     = int(os.getenv("MAX_OPS_PER_SECOND", 10))
TTL_SECONDS            = int(os.getenv("TTL_SECONDS", 90))          # used by position_manager
MAX_CONCURRENT_POSITIONS = int(os.getenv("MAX_CONCURRENT_POSITIONS", 1))

# Dead man's switch heartbeat interval (seconds)
HEARTBEAT_INTERVAL = 30

# ── Fee model ───────────────────────────────────────────────────────────────
FEE_PER_LEG_OPEN  = 0.50
FEE_PER_LEG_CLOSE = 0.25

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_DIR  = os.path.join(os.path.dirname(__file__), "..", "logs")
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# ── Market hours (ET) ─────────────────────────────────────────────────────────
MARKET_OPEN_HOUR   = 9
MARKET_OPEN_MINUTE = 30
MARKET_CLOSE_HOUR  = 16
SCAN_START_HOUR    = 9
SCAN_START_MINUTE  = 35     # 5 min after open for 0DTE to settle
TRADING_START_HOUR  = 9
TRADING_START_MINUTE = 35
TRADING_END_HOUR    = 15
TRADING_END_MINUTE  = 50    # stop 10 min before close (0DTE risk)
