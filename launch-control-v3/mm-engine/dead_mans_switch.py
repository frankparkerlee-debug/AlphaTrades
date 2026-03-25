"""
Launch Control MM — Dead Man's Switch
Runs as a SEPARATE PROCESS from the main engine.
Monitors a heartbeat file. If heartbeat stops for > 30 seconds,
immediately submits flatten orders on all open positions.

This is the most critical safety control in the system.
Without it, a 4-minute API disconnect during a market move = potential $20K+ loss.
With it, damage is contained to the 30-second detection window.

Run this in a separate terminal:
  python dead_mans_switch.py

It must be running BEFORE the main engine starts.
"""

import os
import sys
import time
import json
import signal
import logging
import argparse
from datetime import datetime, timezone
from pathlib import Path
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest, GetOrdersRequest
from alpaca.trading.enums import OrderSide, TimeInForce, QueryOrderStatus

_log_base = "/data" if os.path.isdir("/data") else "."
os.makedirs(os.path.join(_log_base, "logs"), exist_ok=True)
# Only configure logging if this is the main module — avoid overriding
# the engine's logging config when imported for write_heartbeat()
logger = logging.getLogger("dms")
if __name__ == "__main__" or not logging.root.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [DMS] %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(os.path.join(_log_base, "logs", "dead_mans_switch.log")),
        ]
    )

# Paths — use /data on Render (persistent disk), fallback to local
_data_base = "/data" if os.path.isdir("/data") else "."
HEARTBEAT_FILE = Path(os.path.join(_data_base, "data", "heartbeat.json"))
POSITIONS_FILE = Path(os.path.join(_data_base, "data", "open_positions.json"))
HEARTBEAT_INTERVAL = 30   # seconds before DMS fires
CHECK_INTERVAL     = 5    # how often DMS checks the heartbeat


def write_heartbeat(positions: list[dict] | None = None):
    """
    Called by the MAIN ENGINE every ~10 seconds.
    Writes current timestamp and open positions to the heartbeat file.
    """
    os.makedirs("data", exist_ok=True)
    data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "positions": positions or [],
        "engine_pid": os.getpid(),
    }
    HEARTBEAT_FILE.write_text(json.dumps(data))


def read_heartbeat() -> dict | None:
    """Read the heartbeat file. Returns None if missing or corrupt."""
    try:
        if not HEARTBEAT_FILE.exists():
            return None
        return json.loads(HEARTBEAT_FILE.read_text())
    except Exception:
        return None


def flatten_all_positions(client: TradingClient, positions_data: list[dict]):
    """
    Emergency flatten: cancel all open orders first, then close all positions.
    Must cancel before flattening — Alpaca rejects sells on contracts with
    pending buy orders (wash trade detection).
    """
    logger.critical("DEAD MAN'S SWITCH FIRING — FLATTENING ALL POSITIONS")

    # Step 1: Cancel ALL open orders first — clears pending buys/sells
    # that would trigger wash trade rejection on the flatten
    try:
        client.cancel_orders()
        logger.critical("Cancelled all open orders before flatten.")
        # Brief pause for cancels to settle at Alpaca
        time.sleep(1)
    except Exception as e:
        logger.critical(f"Could not cancel open orders: {e}")

    # Step 2: Get all open option positions from Alpaca
    try:
        positions = client.get_all_positions()
        option_positions = [p for p in positions if p.asset_class == "us_option"]

        if not option_positions:
            logger.info("No open option positions found. Nothing to flatten.")
            return

        logger.critical(f"DEAD MAN'S SWITCH FIRING — flattening {len(option_positions)} positions")

        for pos in option_positions:
            try:
                qty  = abs(int(pos.qty))
                side = OrderSide.SELL if float(pos.qty) > 0 else OrderSide.BUY

                order = MarketOrderRequest(
                    symbol=pos.symbol,
                    qty=qty,
                    side=side,
                    time_in_force=TimeInForce.DAY,
                )
                result = client.submit_order(order)
                logger.critical(
                    f"FLATTEN ORDER: {pos.symbol} {side.value} {qty} — "
                    f"order_id={result.id}"
                )
            except Exception as e:
                logger.critical(f"FLATTEN FAILED for {pos.symbol}: {e}")

    except Exception as e:
        logger.critical(f"Could not get positions from Alpaca: {e}")


def run_dms(api_key: str, api_secret: str, base_url: str):
    """Main dead man's switch loop."""
    logger.info("Dead Man's Switch starting.")
    logger.info(f"Heartbeat timeout: {HEARTBEAT_INTERVAL}s")
    logger.info(f"Check interval: {CHECK_INTERVAL}s")
    logger.info(f"Heartbeat file: {HEARTBEAT_FILE}")

    client = TradingClient(
        api_key=api_key,
        secret_key=api_secret,
        paper=("paper" in base_url),
    )

    # Verify connection
    try:
        account = client.get_account()
        logger.info(f"Connected. Account: {account.id} | Status: {account.status}")
    except Exception as e:
        logger.critical(f"Cannot connect to Alpaca: {e}")
        sys.exit(1)

    last_heartbeat_time = None
    fired = False

    def shutdown(signum, frame):
        logger.info("Dead Man's Switch shutting down gracefully.")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    logger.info("Monitoring started. Waiting for first heartbeat...")

    while True:
        heartbeat = read_heartbeat()
        now = datetime.now(timezone.utc)

        if heartbeat is None:
            # No heartbeat file yet — engine hasn't started
            logger.debug("No heartbeat file. Engine not started yet.")
            time.sleep(CHECK_INTERVAL)
            continue

        try:
            hb_time = datetime.fromisoformat(heartbeat["timestamp"])
            age     = (now - hb_time).total_seconds()

            if last_heartbeat_time != hb_time:
                last_heartbeat_time = hb_time
                fired = False  # reset if engine recovers
                logger.debug(f"Heartbeat received. Age: {age:.1f}s")

            if age > HEARTBEAT_INTERVAL and not fired:
                logger.critical(
                    f"HEARTBEAT MISSING: last seen {age:.0f}s ago "
                    f"(threshold {HEARTBEAT_INTERVAL}s)"
                )
                positions_data = heartbeat.get("positions", [])
                flatten_all_positions(client, positions_data)
                fired = True

            elif age <= HEARTBEAT_INTERVAL and fired:
                logger.warning(
                    "Engine heartbeat restored. DMS standby. "
                    "Manual review of positions required."
                )
                fired = False

        except Exception as e:
            logger.error(f"Heartbeat parse error: {e}")

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch Control MM Dead Man's Switch")
    parser.add_argument("--key",    default=os.getenv("ALPACA_API_KEY", ""))
    parser.add_argument("--secret", default=os.getenv("ALPACA_API_SECRET", ""))
    parser.add_argument("--url",    default=os.getenv("ALPACA_BASE_URL",
                                    "https://paper-api.alpaca.markets"))
    args = parser.parse_args()

    if not args.key or not args.secret:
        logger.critical("ALPACA_API_KEY and ALPACA_API_SECRET required.")
        sys.exit(1)

    run_dms(args.key, args.secret, args.url)
