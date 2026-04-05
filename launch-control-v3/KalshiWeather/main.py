"""
KalshiWeather — Kalshi Weather Arbitrage Bot

Scans weather model forecasts (GFS/ECMWF via Open-Meteo) vs Kalshi
temperature market prices. Buys underpriced contracts and sells
when the crowd reprices after broadcast delay.

Usage:
    python main.py              # run the bot
    python main.py --scan       # one-shot scan (no trading)
    python main.py --test       # test data sources
"""

import os
import sys
import time
import logging
import argparse
from datetime import datetime

os.makedirs("logs", exist_ok=True)

from config.settings import SCAN_INTERVAL_SECONDS, STARTING_CAPITAL, TRADING_MODE
from feeds.kalshi import KalshiClient
from strategy.signals import SignalEngine
from execution.executor import Executor
from monitor.dashboard import render_dashboard

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("logs/kalshiweather.log", mode="a"),
    ],
)
log = logging.getLogger("main")


def run_bot():
    """Main bot loop: scan → signal → execute → monitor → repeat."""
    log.info(f"KalshiWeather starting | mode={TRADING_MODE} | capital=${STARTING_CAPITAL}")

    kalshi = KalshiClient()
    engine = SignalEngine(kalshi)
    executor = Executor(kalshi)

    # Check balance
    balance = kalshi.get_balance()
    if balance is not None:
        log.info(f"Kalshi balance: ${balance:.2f}")
        executor.capital = balance
    else:
        log.warning("Could not fetch Kalshi balance — using default")

    cycle = 0
    last_signals = []

    while True:
        try:
            cycle += 1
            log.info(f"--- Cycle {cycle} ---")

            # 1. Scan for signals
            signals = engine.scan_all()
            if signals:
                last_signals = signals

            # 2. Execute new signals
            for signal in signals:
                if not executor.halted:
                    executor.enter(signal)

            # 3. Check exits on open positions
            executor.check_exits()

            # 4. Render dashboard
            render_dashboard(executor, last_signals)

            # 5. Sleep
            log.info(f"Sleeping {SCAN_INTERVAL_SECONDS}s...")
            time.sleep(SCAN_INTERVAL_SECONDS)

        except KeyboardInterrupt:
            log.info("Shutting down...")
            break
        except Exception as e:
            log.error(f"Cycle error: {e}", exc_info=True)
            time.sleep(30)

    # Final stats
    stats = executor.get_stats()
    log.info(f"Final: {stats['total_trades']} trades, WR={stats['win_rate']:.0%}, P&L=${stats['total_pnl']:+.2f}")


def run_scan():
    """One-shot scan: show signals without trading."""
    kalshi = KalshiClient()
    engine = SignalEngine(kalshi)

    print("Scanning all cities for weather arbitrage signals...\n")
    signals = engine.scan_all()

    if not signals:
        print("No signals found.")
        return

    print(f"Found {len(signals)} signals:\n")
    for sig in signals:
        print(f"  {sig}")
    print()


def run_test():
    """Test data sources: Open-Meteo + Kalshi side by side."""
    from feeds.weather import fetch_open_meteo_simple
    from feeds.kalshi import KalshiClient

    print("=" * 60)
    print("  KalshiWeather Data Source Test")
    print("=" * 60)

    # 1. Open-Meteo
    print("\n[1] Open-Meteo — NYC Tomorrow's High")
    forecast = fetch_open_meteo_simple(40.71, -74.01, days=2)
    if forecast:
        for i, (date, high, low) in enumerate(
            zip(forecast["dates"], forecast["highs"], forecast["lows"])
        ):
            label = "Today" if i == 0 else "Tomorrow"
            print(f"    {label} ({date}): High {high:.0f}F / Low {low:.0f}F")
    else:
        print("    FAILED")

    # 2. Kalshi
    print("\n[2] Kalshi — NYC Temperature Markets")
    kalshi = KalshiClient()
    markets = kalshi.get_markets("KXHIGHNY", limit=20)
    if markets:
        print(f"    Found {len(markets)} open markets")
        for m in markets[:8]:
            ticker = m.get("ticker", "")
            prices = kalshi.get_best_prices(ticker)
            if prices:
                print(
                    f"    {ticker:40s} YES bid=${prices['yes_bid']:.2f}  "
                    f"ask=${prices['yes_ask']:.2f}  spread=${prices['spread']:.2f}"
                )
            else:
                print(f"    {ticker:40s} (no orderbook)")
    else:
        print("    No markets found (may need different series ticker)")

    # 3. Side by side
    if forecast and markets:
        tomorrow = forecast["dates"][1] if len(forecast["dates"]) > 1 else forecast["dates"][0]
        tomorrow_high = forecast["highs"][1] if len(forecast["highs"]) > 1 else forecast["highs"][0]
        print(f"\n[3] Comparison for {tomorrow}")
        print(f"    Model forecast high: {tomorrow_high:.0f}F")
        print(f"    Kalshi markets near that temp:")
        for m in markets:
            ticker = m.get("ticker", "")
            # Check if this market is for tomorrow
            parts = ticker.split("-")
            if len(parts) >= 3 and parts[2].startswith("T"):
                threshold = int(parts[2][1:])
                if abs(threshold - tomorrow_high) <= 5:
                    prices = kalshi.get_best_prices(ticker)
                    if prices:
                        from feeds.weather import temp_probability
                        prob = temp_probability(tomorrow_high, threshold, 3.0)
                        edge = prob - prices["yes_ask"]
                        edge_label = f"+{edge:.2f}" if edge > 0 else f"{edge:.2f}"
                        print(
                            f"    >{threshold}F  mkt=${prices['yes_ask']:.2f}  "
                            f"model={prob:.0%}  edge={edge_label}"
                        )

    print("\n" + "=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KalshiWeather — Kalshi Weather Arb")
    parser.add_argument("--scan", action="store_true", help="One-shot scan")
    parser.add_argument("--test", action="store_true", help="Test data sources")
    args = parser.parse_args()

    if args.test:
        run_test()
    elif args.scan:
        run_scan()
    else:
        run_bot()
