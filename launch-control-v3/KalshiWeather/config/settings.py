"""
Configuration for Kalshi Weather — Last Mile Strategy.
Buy near-certain temperature contracts ($0.80-$0.95) on resolution day
when both GFS + ECMWF predict temp well above threshold. Hold to settlement.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── Kalshi API ─────────────────────────────────────────────────────────────────

KALSHI_API_KEY = os.getenv("KALSHI_API_KEY", "")
KALSHI_PRIVATE_KEY = os.getenv("KALSHI_PRIVATE_KEY", "")
KALSHI_ENV = os.getenv("KALSHI_ENV", "prod")  # "demo" or "prod"

KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
KALSHI_DEMO_URL = "https://demo-api.kalshi.co/trade-api/v2"

PAPER_TRADING = os.getenv("PAPER_TRADING", "false").lower() == "true"
TRADING_MODE = "paper" if PAPER_TRADING else "live"

# DRY_RUN: connect to production market data but DO NOT place orders
# Use this to verify the bot is working before going live with real money
DRY_RUN = os.getenv("DRY_RUN", "false").lower() == "true"

# ── Anthropic ──────────────────────────────────────────────────────────────────

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# ── State persistence ──────────────────────────────────────────────────────────

STATE_DIR = os.getenv("STATE_DIR", "./logs")

# ── Capital & Risk ─────────────────────────────────────────────────────────────

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "500"))
MAX_POSITION_PCT = 0.15          # 15% of capital per signal
MAX_CONTRACTS_PER_BUCKET = 25    # fill cap from Kalshi trade tape data
MAX_OPEN_POSITIONS = 15          # across all cities
DAILY_LOSS_LIMIT_PCT = 0.10      # halt at -10% daily (tighter for high-cost contracts)

# ── Last Mile / Value Edge Signal Thresholds ─────────────────────────────────

# Two zones of opportunity:
#   1. Last Mile: $0.80-$0.95 (near-certain, hold to settlement at $1.00)
#   2. Value Edge: $0.30-$0.79 (clear model-vs-market disagreement, big upside)
# Both require forecast offset >= MIN_FORECAST_OFFSET from threshold
MIN_BUY_PRICE = 0.20             # widened to capture deep value edge opportunities
MAX_BUY_PRICE = 0.97             # near-certain ceiling (allow $0.96-$0.97 last mile fills)
MIN_FORECAST_OFFSET = 4          # forecast must be >= 4F from threshold
MIN_EDGE = 0.40                  # model_prob - cost must exceed this for value plays
MAX_MODEL_SPREAD = 6             # models must agree within 6F
EARLY_EXIT_PRICE = 0.97          # optional early exit if bid hits $0.97
STOP_LOSS_PCT = 0.50             # cut if bid drops below 50% of entry price
LADDER_BUCKETS = 3               # buy up to 3 adjacent buckets per city+date

# ── Scan Interval ──────────────────────────────────────────────────────────────

SCAN_INTERVAL_SECONDS = 60       # check prices every 60s between model updates
MODEL_UPDATE_HOURS = [0, 6, 12, 18]  # GFS update times (UTC)

# ── Cities ─────────────────────────────────────────────────────────────────────

# Only cities with confirmed active Kalshi temperature markets
CITIES = {
    "NY":  {"name": "New York",      "lat": 40.71,  "lon": -74.01, "series": "KXHIGHNY"},
    "CHI": {"name": "Chicago",       "lat": 41.88,  "lon": -87.63, "series": "KXHIGHCHI"},
    "MIA": {"name": "Miami",         "lat": 25.76,  "lon": -80.19, "series": "KXHIGHMIA"},
    "LAX": {"name": "Los Angeles",   "lat": 34.05,  "lon": -118.24,"series": "KXHIGHLAX"},
    "DEN": {"name": "Denver",        "lat": 39.74,  "lon": -104.99,"series": "KXHIGHDEN"},
}

# ── Weather Models ─────────────────────────────────────────────────────────────

WEATHER_MODELS = ["gfs_seamless", "ecmwf_ifs025"]
FORECAST_DAYS = 3  # look ahead 3 days for active markets
