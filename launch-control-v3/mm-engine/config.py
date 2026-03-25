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
# NYSE financials — institutional hedging flow creates consistent
# two-way markets with $0.13–$0.39 spreads on OTM puts/calls
UNIVERSE = os.getenv("UNIVERSE", "JPM,GS,BAC,MS,WFC").split(",")

# ── Scanner parameters ──────────────────────────────────────────────────────
CONTRACTS_PER_TRADE  = int(os.getenv("CONTRACTS_PER_TRADE", 2))       # 2 contracts = $10/trade at $0.05 target
SPREAD_CAPTURE_PCT   = float(os.getenv("SPREAD_CAPTURE_PCT", 0.40))   # used by scanner for quote level calc
TARGET_DTE_MIN       = int(os.getenv("TARGET_DTE_MIN", 2))
TARGET_DTE_MAX       = int(os.getenv("TARGET_DTE_MAX", 14))
OTM_PCT_MIN          = float(os.getenv("OTM_PCT_MIN", -0.005))
OTM_PCT_MAX          = float(os.getenv("OTM_PCT_MAX", 0.04))
MIN_SPREAD_WIDTH     = float(os.getenv("MIN_SPREAD_WIDTH", 0.10))     # $0.10 minimum for scalping
MIN_DAILY_VOLUME     = int(os.getenv("MIN_DAILY_VOLUME", 150))

# ── Scalper parameters ──────────────────────────────────────────────────────
PROFIT_TARGET        = float(os.getenv("PROFIT_TARGET", 0.10))        # $0.10/contract — must overcome spread + profit
STOP_LOSS            = float(os.getenv("STOP_LOSS", 0.15))            # $0.15/contract max loss
BUY_TTL_SECONDS      = int(os.getenv("BUY_TTL_SECONDS", 10))         # market orders fill fast, 10s is generous
SELL_TTL_SECONDS     = int(os.getenv("SELL_TTL_SECONDS", 180))        # 3 min for mean reversion bounce
DIP_THRESHOLD        = float(os.getenv("DIP_THRESHOLD", 0.002))       # 0.2% below rolling avg triggers entry
PRICE_HISTORY_SECONDS = int(os.getenv("PRICE_HISTORY_SECONDS", 300))  # 5-min rolling window
CYCLE_SECONDS        = int(os.getenv("CYCLE_SECONDS", 5))             # seconds between main loop cycles
RESCAN_INTERVAL      = int(os.getenv("RESCAN_INTERVAL", 600))         # 10 min between watchlist refreshes
COOLDOWN_SECONDS     = int(os.getenv("COOLDOWN_SECONDS", 30))         # wait after exit before re-entry
MAX_COST_PCT         = float(os.getenv("MAX_COST_PCT", 0.10))         # max 10% of balance per trade

# ── Risk controls (non-negotiable) ────────────────────────────────────────────
KILL_SWITCH_THRESHOLD  = float(os.getenv("KILL_SWITCH_THRESHOLD", -800))
PDT_FLOOR              = float(os.getenv("PDT_FLOOR", 25000))
PDT_ALERT_BUFFER       = float(os.getenv("PDT_ALERT_BUFFER", 26500))
MAX_OPS_PER_SECOND     = int(os.getenv("MAX_OPS_PER_SECOND", 5))
TTL_SECONDS            = int(os.getenv("TTL_SECONDS", 60))            # legacy, used by position_manager
TAPE_LOOKBACK_SECONDS  = int(os.getenv("TAPE_LOOKBACK_SECONDS", 300))
TAPE_MIN_PRINTS        = int(os.getenv("TAPE_MIN_PRINTS", 1))
MAX_CONCURRENT_POSITIONS = int(os.getenv("MAX_CONCURRENT_POSITIONS", 5))

# Dead man's switch heartbeat interval (seconds)
HEARTBEAT_INTERVAL = 30

# ── Fee model (for P&L simulation in paper mode) ──────────────────────────────
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
SCAN_START_MINUTE  = 0
TRADING_START_HOUR  = 9
TRADING_START_MINUTE = 45
TRADING_END_HOUR    = 15
TRADING_END_MINUTE  = 55
