"""
Launch Control MM — Dead Man's Switch (Render version)
Uses Alpaca API as shared state instead of local filesystem.
Works across two separate Render worker processes with no shared disk needed.

The logic:
  - Every 30 seconds, query Alpaca for open option positions
  - Query Alpaca for recent orders (last 60 seconds)
  - If positions exist BUT no new orders in last 60 seconds → engine is dead
  - Flatten all positions

This is more robust than the file-based approach because:
  - Works across distributed processes (Render workers, cloud VMs, anywhere)
  - Alpaca is the source of truth — no intermediate state to corrupt
  - If Alpaca itself is down, the engine can't trade anyway

Run as a separate Render background worker (lc-mm-dms).
"""

import os
import sys
import time
import signal
import logging
from datetime import datetime, timezone, timedelta
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest, GetOrdersRequest
from alpaca.trading.enums import OrderSide, TimeInForce, QueryOrderStatus

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [DMS] %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("dms-render")

# Configuration
HEARTBEAT_TIMEOUT = 60    # seconds of no new orders before declaring engine dead
CHECK_INTERVAL    = 15    # how often to poll Alpaca (seconds)
POSITION_GRACE    = 30    # seconds after market open before DMS activates


def get_recent_order_time(client: TradingClient) -> datetime | None:
    """
    Get the timestamp of the most recent order submitted.
    Returns None if no orders found.
    """
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
        orders = client.get_orders(GetOrdersRequest(
            status=QueryOrderStatus.ALL,
            after=cutoff,
            limit=10,
        ))
        if not orders:
            return None
        # Most recent order
        latest = max(orders, key=lambda o: o.submitted_at)
        return latest.submitted_at
    except Exception as e:
        logger.error(f"Could not get recent orders: {e}")
        return None


def get_open_option_positions(client: TradingClient) -> list:
    """Get all open option positions."""
    try:
        positions = client.get_all_positions()
        return [p for p in positions if p.asset_class == "us_option"]
    except Exception as e:
        logger.error(f"Could not get positions: {e}")
        return []


def flatten_all(client: TradingClient, positions: list):
    """Emergency flatten — market orders on all open option positions."""
    logger.critical(
        f"DEAD MAN'S SWITCH FIRING — flattening {len(positions)} positions"
    )
    for pos in positions:
        try:
            qty  = abs(int(pos.qty))
            side = OrderSide.SELL if float(pos.qty) > 0 else OrderSide.BUY
            order = client.submit_order(MarketOrderRequest(
                symbol=pos.symbol,
                qty=qty,
                side=side,
                time_in_force=TimeInForce.DAY,
            ))
            logger.critical(
                f"FLATTEN: {pos.symbol} {side.value} {qty} → order {order.id}"
            )
        except Exception as e:
            logger.critical(f"FLATTEN FAILED for {pos.symbol}: {e}")


def is_market_hours() -> bool:
    """Rough check for US market hours (ET). Handles EST only, not DST."""
    now_utc = datetime.now(timezone.utc)
    # ET is UTC-5 (EST) / UTC-4 (EDT) — use UTC-5 as conservative estimate
    et_hour = (now_utc.hour - 5) % 24
    et_weekday = now_utc.weekday()
    if et_weekday >= 5:   # weekend
        return False
    return 9 <= et_hour < 16


def run():
    api_key    = os.getenv("ALPACA_API_KEY", "")
    api_secret = os.getenv("ALPACA_API_SECRET", "")
    base_url   = os.getenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")

    if not api_key or not api_secret:
        logger.critical("ALPACA_API_KEY and ALPACA_API_SECRET required")
        sys.exit(1)

    client = TradingClient(
        api_key=api_key,
        secret_key=api_secret,
        paper=("paper" in base_url),
    )

    # Verify connection
    try:
        account = client.get_account()
        logger.info(f"DMS connected. Account {account.id} | {account.status}")
    except Exception as e:
        logger.critical(f"Cannot connect to Alpaca: {e}")
        sys.exit(1)

    logger.info(f"DMS active. Timeout: {HEARTBEAT_TIMEOUT}s | Check: {CHECK_INTERVAL}s")

    fired = False

    def shutdown(signum, frame):
        logger.info("DMS shutting down.")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        try:
            if not is_market_hours():
                logger.debug("Outside market hours. DMS standby.")
                fired = False
                time.sleep(60)
                continue

            positions = get_open_option_positions(client)

            if not positions:
                # No open positions — nothing to protect
                logger.debug("No open option positions. DMS idle.")
                fired = False
                time.sleep(CHECK_INTERVAL)
                continue

            # There ARE open positions — check if engine is alive
            last_order_time = get_recent_order_time(client)
            now = datetime.now(timezone.utc)

            if last_order_time is None:
                # No recent orders at all — engine may never have started
                # Only fire if positions exist AND no orders in last 10 min
                logger.warning(
                    f"Open positions ({len(positions)}) but no recent orders found."
                )
                # Give it one more check before firing
                time.sleep(CHECK_INTERVAL)
                last_order_time = get_recent_order_time(client)
                if last_order_time is None and not fired:
                    logger.critical(
                        "Confirmed: open positions with no order activity. "
                        "Assuming engine dead."
                    )
                    flatten_all(client, positions)
                    fired = True
            else:
                age = (now - last_order_time).total_seconds()

                if age > HEARTBEAT_TIMEOUT and not fired:
                    logger.critical(
                        f"ENGINE HEARTBEAT MISSING: last order was {age:.0f}s ago "
                        f"(threshold {HEARTBEAT_TIMEOUT}s). "
                        f"{len(positions)} positions open."
                    )
                    flatten_all(client, positions)
                    fired = True
                elif age <= HEARTBEAT_TIMEOUT and fired:
                    logger.warning(
                        "Engine activity detected. DMS resetting. "
                        "Manual position review recommended."
                    )
                    fired = False
                else:
                    logger.debug(
                        f"Engine alive. Last order {age:.0f}s ago. "
                        f"{len(positions)} positions open."
                    )

        except Exception as e:
            logger.error(f"DMS loop error: {e}", exc_info=True)

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    run()
