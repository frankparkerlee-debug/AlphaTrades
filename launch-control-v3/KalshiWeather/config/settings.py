"""
Configuration for Kalshi Weather Arbitrage Bot.
All thresholds calibrated for $500 starting capital.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── Kalshi API ─────────────────────────────────────────────────────────────────

KALSHI_API_KEY = os.getenv("KALSHI_API_KEY", "")
KALSHI_PRIVATE_KEY = os.getenv("KALSHI_PRIVATE_KEY", "")
KALSHI_ENV = os.getenv("KALSHI_ENV", "demo")  # "demo" or "prod"

KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
KALSHI_DEMO_URL = "https://demo-api.kalshi.co/trade-api/v2"

PAPER_TRADING = os.getenv("PAPER_TRADING", "true").lower() == "true"
TRADING_MODE = "paper" if PAPER_TRADING else "live"

# ── Anthropic ──────────────────────────────────────────────────────────────────

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# ── State persistence ──────────────────────────────────────────────────────────

STATE_DIR = os.getenv("STATE_DIR", "./logs")

# ── Capital & Risk ─────────────────────────────────────────────────────────────

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "500"))
MAX_POSITION_PCT = 0.10          # 10% of capital per signal ($50)
MAX_CONTRACTS_PER_BUCKET = 50    # max contracts per temperature bucket
MAX_OPEN_POSITIONS = 15          # across all cities
DAILY_LOSS_LIMIT_PCT = 0.15      # halt at -15% daily ($75)

# ── Signal Thresholds ──────────────────────────────────────────────────────────

# Buy contracts priced $0.10-0.15 where model says true prob >= 60%
MIN_EDGE_PCT = 0.15              # model_prob - market_price >= 15 cents (e.g., 30% - 15c)
MIN_BUY_PRICE = 0.05             # don't buy below $0.05 (too illiquid)
MAX_BUY_PRICE = 0.20             # don't buy above $0.20 (not enough edge)
TARGET_SELL_PRICE = 0.40         # sell when market reprices to $0.40+
MAX_HOLD_MINUTES = 90            # time backstop
LADDER_BUCKETS = 4               # buy 3-4 adjacent temperature buckets per signal

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
