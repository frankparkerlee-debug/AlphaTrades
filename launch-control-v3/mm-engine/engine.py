"""
Launch Control MM — Main Engine
Orchestrates: scanner → tape monitor → quote engine → position manager → fill logger.
All risk controls run before every order.

Paper trading mode: uses Alpaca paper API.
Kill switch, rate limiter, PDT guard, TTL, data freshness — all active.

Usage:
  python engine.py [--paper] [--dry-run]
"""

import os
import sys
import time
import json
import signal
import logging
import argparse
import threading
from datetime import datetime, timezone, date
from typing import Optional

# Add src to path
sys.path.insert(0, os.path.dirname(__file__))

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import (
    LimitOrderRequest, GetOrdersRequest
)
from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.requests import StockLatestQuoteRequest
from alpaca.data.historical.option import OptionHistoricalDataClient
from alpaca.data.requests import OptionLatestQuoteRequest

from config import (
    ALPACA_API_KEY, ALPACA_API_SECRET,
    ALPACA_PAPER_API_KEY, ALPACA_PAPER_API_SECRET,
    UNIVERSE, CONTRACTS_PER_TRADE, SPREAD_CAPTURE_PCT,
    MARKET_OPEN_HOUR, MARKET_OPEN_MINUTE,
    TRADING_START_HOUR, TRADING_START_MINUTE,
    TRADING_END_HOUR, TRADING_END_MINUTE,
    HEARTBEAT_INTERVAL, MAX_CONCURRENT_POSITIONS,
    KILL_SWITCH_THRESHOLD, MIN_SPREAD_WIDTH,
    SCAN_START_HOUR, SCAN_START_MINUTE,
    TTL_SECONDS,
)
from fill_logger import FillLogger
from risk_controls import RiskManager
from scanner import MorningScanner, ViableStrike
from tape_monitor import TapeMonitor
from position_manager import PositionManager
from dead_mans_switch import write_heartbeat

# ── Logging setup ─────────────────────────────────────────────────────────────
# On Render, /data is a persistent disk mount. Fallback to local dirs.
LOG_BASE = "/data" if os.path.isdir("/data") else "."
os.makedirs(os.path.join(LOG_BASE, "logs"), exist_ok=True)
os.makedirs(os.path.join(LOG_BASE, "data"), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)-12s] %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            os.path.join(LOG_BASE, "logs", f"engine_{date.today().strftime('%Y%m%d')}.log")
        ),
    ]
)
logger = logging.getLogger("engine")


class QuoteEngine:
    """
    Core market making loop.
    For each viable strike with confirmed tape:
      1. Submit bid and ask as separate limit orders
      2. Track which side fills first (open_position)
      3. Wait for the second side (close) or TTL
    """

    def __init__(
        self,
        trading_client: TradingClient,
        stock_client:   StockHistoricalDataClient,
        option_client:  OptionHistoricalDataClient,
        fill_logger:    FillLogger,
        risk_manager:   RiskManager,
        tape_monitor:   TapeMonitor,
        position_manager: PositionManager,
        dry_run: bool = False,
    ):
        self._trading   = trading_client
        self._stocks    = stock_client
        self._options   = option_client
        self._logger    = fill_logger
        self._risk      = risk_manager
        self._tape      = tape_monitor
        self._positions = position_manager
        self._dry_run   = dry_run

        # Active watchlist from morning scan
        self._watchlist: list[ViableStrike] = []

        # Track pending orders: contract_symbol → {bid_order_id, ask_order_id, fill_id}
        self._pending: dict[str, dict] = {}
        self._pending_lock = threading.Lock()

        # Current quotes cache: contract_symbol → (bid, ask)
        self._quotes: dict[str, tuple[float, float]] = {}

        # Running state
        self._running = False
        self._heartbeat_counter = 0

    def set_watchlist(self, watchlist: list[ViableStrike]):
        """Set the active watchlist from the morning scanner."""
        self._watchlist = watchlist
        self._watchlist_added_at = time.time()
        logger.info(f"Watchlist set: {len(watchlist)} viable strikes")

        # Tell tape monitor to watch all contracts
        symbols = [s.contract_symbol for s in watchlist]
        self._tape.watch(symbols)

        # Seed initial quotes
        for strike in watchlist:
            self._quotes[strike.contract_symbol] = (strike.bid, strike.ask)
            self._tape.update_quote(strike.contract_symbol, strike.bid, strike.ask)
            self._risk.data_fresh.update(strike.contract_symbol)

    def run_quote_cycle(self):
        """
        One complete quote cycle across all watchlist items.
        Called repeatedly from the main loop.
        """
        account_balance   = self._get_account_balance()
        unrealized_pnl    = self._positions.get_unrealized_pnl(self._quotes)

        if not self._watchlist:
            return

        logger.info(f"Quote cycle: {len(self._watchlist)} strikes on watchlist")

        for strike in self._watchlist:
            sym = strike.contract_symbol

            # Skip if already in a pending position on this contract
            with self._pending_lock:
                if sym in self._pending:
                    continue

            # Skip if at position limit
            if not self._risk.positions.can_open():
                logger.debug("At position limit. Skipping quote cycle.")
                break

            # Refresh quote
            fresh_quote = self._refresh_quote(sym)
            if fresh_quote is None:
                logger.debug(f"No fresh quote for {sym}")
                continue

            bid, ask = fresh_quote
            spread   = ask - bid

            # Check spread is still viable
            if spread < MIN_SPREAD_WIDTH:
                continue

            # Update tape quote
            self._tape.update_quote(sym, bid, ask)
            self._risk.data_fresh.update(sym)

            # Tape confirmation gate
            tape_bypass = os.getenv("TAPE_BYPASS", "false").lower() == "true"
            bid_prints, ask_prints = self._tape.counts(sym)

            if tape_bypass:
                logger.warning(
                    f"[TAPE BYPASS] Quoting without tape confirmation on {sym}"
                )
            else:
                if not self._tape.is_confirmed(sym):
                    logger.debug(f"Tape not confirmed: {sym} ({bid_prints}B/{ask_prints}A)")
                    continue

            logger.info(
                f"Quoting: {sym} | spread=${spread:.3f} "
                f"bid=${bid:.2f} ask=${ask:.2f} | tape={bid_prints}B/{ask_prints}A"
            )

            # Pre-order risk check
            ok, reason = self._risk.check_pre_order(
                symbol=sym,
                account_balance=account_balance,
                unrealized_pnl=unrealized_pnl,
                is_opening=True,
            )
            if not ok:
                logger.info(f"Risk blocked ({reason}): {sym}")
                continue

            # Skip expensive contracts — we're capturing spread, not trading premium.
            # Contracts over $5 mid tie up too much buying power for the spread captured.
            mid = (bid + ask) / 2
            if mid > 5.0:
                logger.debug(f"Skip expensive: {sym} mid=${mid:.2f}")
                continue

            # Calculate quote levels
            quote_mode = os.getenv("QUOTE_MODE", "penny_inside")
            if quote_mode == "penny_inside":
                our_bid = round(bid + 0.01, 2)
                our_ask = round(ask - 0.01, 2)
            else:
                capture = spread * SPREAD_CAPTURE_PCT
                our_bid = round(max(bid + 0.01, mid - capture / 2), 2)
                our_ask = round(min(ask - 0.01, mid + capture / 2), 2)

            if our_ask <= our_bid:
                continue

            # Check buying power before submitting — each buy costs mid × 100 × qty
            cost_basis = our_bid * 100 * CONTRACTS_PER_TRADE
            if cost_basis > account_balance * 0.10:
                logger.info(f"Skip: {sym} cost=${cost_basis:.0f} > 10% of balance")
                continue

            # Submit quotes
            self._submit_quote(
                strike=strike,
                our_bid=our_bid,
                our_ask=our_ask,
                bid_at_market=bid,
                ask_at_market=ask,
                spread=spread,
                tape_bid_prints=bid_prints,
                tape_ask_prints=ask_prints,
            )

    def _submit_quote(
        self,
        strike: ViableStrike,
        our_bid: float,
        our_ask: float,
        bid_at_market: float,
        ask_at_market: float,
        spread: float,
        tape_bid_prints: int,
        tape_ask_prints: int,
    ):
        """Submit bid and ask limit orders for a contract."""
        sym = strike.contract_symbol

        if self._dry_run:
            logger.info(
                f"[DRY RUN] Would quote: {sym} "
                f"bid={our_bid:.2f} ask={our_ask:.2f} spread={spread:.3f}"
            )
            return

        try:
            # Submit bid order
            bid_order = self._trading.submit_order(LimitOrderRequest(
                symbol=sym,
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.BUY,
                time_in_force=TimeInForce.DAY,
                limit_price=our_bid,
            ))

            # Submit ask order
            ask_order = self._trading.submit_order(LimitOrderRequest(
                symbol=sym,
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
                limit_price=our_ask,
            ))

            with self._pending_lock:
                self._pending[sym] = {
                    "bid_order_id": str(bid_order.id),
                    "ask_order_id": str(ask_order.id),
                    "strike":       strike,
                    "our_bid":      our_bid,
                    "our_ask":      our_ask,
                    "bid_market":   bid_at_market,
                    "ask_market":   ask_at_market,
                    "spread":       spread,
                    "tape_bid":     tape_bid_prints,
                    "tape_ask":     tape_ask_prints,
                    "submitted_at": datetime.now(timezone.utc).isoformat(),
                }

            logger.info(
                f"Quote submitted: {sym} | "
                f"bid={our_bid:.2f} ask={our_ask:.2f} | "
                f"spread={spread:.3f} | "
                f"tape={tape_bid_prints}B/{tape_ask_prints}A"
            )

        except Exception as e:
            logger.error(f"Quote submission failed for {sym}: {e}")

    def process_fill_events(self):
        """
        Poll Alpaca for fill events on pending orders.
        When a fill arrives, open or close the corresponding position.
        """
        if self._dry_run:
            return

        with self._pending_lock:
            contracts = list(self._pending.keys())

        for sym in contracts:
            with self._pending_lock:
                pending = self._pending.get(sym)
                if not pending:
                    continue

            try:
                # Check bid order
                bid_order = self._trading.get_order_by_id(pending["bid_order_id"])
                ask_order = self._trading.get_order_by_id(pending["ask_order_id"])

                bid_filled = bid_order.status == OrderStatus.FILLED
                ask_filled = ask_order.status == OrderStatus.FILLED

                strike = pending["strike"]

                if bid_filled and "fill_id" not in pending:
                    # First fill — open position (bid hit, we're now long)
                    fill_price     = float(bid_order.filled_avg_price or pending["our_bid"])
                    underlying_px  = self._get_underlying_price(strike.symbol)
                    fill_id = self._positions.open_position(
                        symbol=strike.symbol,
                        contract_symbol=sym,
                        strike=strike.strike,
                        expiry=str(strike.expiry),
                        option_type=strike.option_type,
                        dte_at_entry=strike.dte,
                        underlying_price_entry=underlying_px or strike.underlying_price,
                        bid_at_entry=pending["bid_market"],
                        ask_at_entry=pending["ask_market"],
                        iv_at_entry=strike.iv,
                        delta_at_entry=strike.delta,
                        otm_pct=strike.otm_pct,
                        our_bid=pending["our_bid"],
                        our_ask=pending["our_ask"],
                        capture_target=pending["our_ask"] - pending["our_bid"],
                        tape_bid_prints=pending["tape_bid"],
                        tape_ask_prints=pending["tape_ask"],
                        open_side="bid_hit",
                        open_price=fill_price,
                        bid_order_id=pending["bid_order_id"],
                        ask_order_id=pending["ask_order_id"],
                    )
                    with self._pending_lock:
                        self._pending[sym]["fill_id"] = fill_id

                elif ask_filled and "fill_id" not in pending:
                    # First fill — ask lifted, we're now short
                    fill_price    = float(ask_order.filled_avg_price or pending["our_ask"])
                    underlying_px = self._get_underlying_price(strike.symbol)
                    fill_id = self._positions.open_position(
                        symbol=strike.symbol,
                        contract_symbol=sym,
                        strike=strike.strike,
                        expiry=str(strike.expiry),
                        option_type=strike.option_type,
                        dte_at_entry=strike.dte,
                        underlying_price_entry=underlying_px or strike.underlying_price,
                        bid_at_entry=pending["bid_market"],
                        ask_at_entry=pending["ask_market"],
                        iv_at_entry=strike.iv,
                        delta_at_entry=strike.delta,
                        otm_pct=strike.otm_pct,
                        our_bid=pending["our_bid"],
                        our_ask=pending["our_ask"],
                        capture_target=pending["our_ask"] - pending["our_bid"],
                        tape_bid_prints=pending["tape_bid"],
                        tape_ask_prints=pending["tape_ask"],
                        open_side="ask_lifted",
                        open_price=fill_price,
                        bid_order_id=pending["bid_order_id"],
                        ask_order_id=pending["ask_order_id"],
                    )
                    with self._pending_lock:
                        self._pending[sym]["fill_id"] = fill_id

                # Check for closing fill
                if "fill_id" in pending:
                    fill_id   = pending["fill_id"]
                    open_side = "bid_hit" if bid_filled else "ask_lifted"

                    # The closing fill is on the opposite side
                    close_filled = ask_filled if open_side == "bid_hit" else bid_filled
                    close_order  = ask_order  if open_side == "bid_hit" else bid_order

                    if close_filled:
                        close_price   = float(close_order.filled_avg_price or 0)
                        underlying_px = self._get_underlying_price(strike.symbol)
                        self._positions.close_position(
                            fill_id=fill_id,
                            close_price=close_price,
                            close_reason="natural_fill",
                            underlying_price_close=underlying_px,
                        )
                        with self._pending_lock:
                            self._pending.pop(sym, None)

            except Exception as e:
                logger.error(f"Fill processing error for {sym}: {e}")

    def cancel_and_flatten(
        self,
        fill_id: str,
        bid_order_id: Optional[str],
        ask_order_id: Optional[str],
    ) -> Optional[float]:
        """
        Cancel the unfilled leg and market-sell/buy to flatten the filled leg.
        Called by TTL expiry or kill switch. Returns the market fill price
        or None if no flatten was needed.
        """
        # Find the pending entry to know which side filled
        with self._pending_lock:
            entry = None
            for sym, p in self._pending.items():
                if p.get("fill_id") == fill_id or p.get("bid_order_id") == bid_order_id:
                    entry = (sym, dict(p))
                    break

        # Cancel both orders first (unfilled one matters, filled is a no-op)
        for order_id in [bid_order_id, ask_order_id]:
            if order_id:
                try:
                    self._trading.cancel_order_by_id(order_id)
                    logger.debug(f"Cancelled order {order_id}")
                except Exception as e:
                    logger.warning(f"Cancel failed for {order_id}: {e}")

        # Flatten: submit a market order on the opposite side of the fill
        flatten_price = None
        if entry and not self._dry_run:
            sym, p = entry
            has_fill = "fill_id" in p

            if has_fill:
                # Determine which side we're holding
                try:
                    bid_status = self._trading.get_order_by_id(p["bid_order_id"]).status
                except Exception:
                    bid_status = None

                if bid_status == OrderStatus.FILLED:
                    # We bought — sell to flatten
                    flatten_side = OrderSide.SELL
                else:
                    # We sold — buy to flatten
                    flatten_side = OrderSide.BUY

                try:
                    from alpaca.trading.requests import MarketOrderRequest
                    flatten_order = self._trading.submit_order(MarketOrderRequest(
                        symbol=sym,
                        qty=CONTRACTS_PER_TRADE,
                        side=flatten_side,
                        time_in_force=TimeInForce.DAY,
                    ))
                    logger.info(
                        f"Flatten order submitted: {sym} {flatten_side.name} "
                        f"(market) | fill_id={fill_id}"
                    )
                    # Poll briefly for fill price (market orders fill fast)
                    import time as _time
                    for _ in range(5):
                        _time.sleep(0.5)
                        try:
                            status = self._trading.get_order_by_id(str(flatten_order.id))
                            if status.status == OrderStatus.FILLED:
                                flatten_price = float(status.filled_avg_price)
                                logger.info(
                                    f"Flatten filled: {sym} @ ${flatten_price:.2f}"
                                )
                                break
                        except Exception:
                            pass
                except Exception as e:
                    logger.error(f"Flatten order failed for {sym}: {e}")

        # Remove from pending
        with self._pending_lock:
            to_remove = [
                sym for sym, p in self._pending.items()
                if p.get("fill_id") == fill_id
                or p.get("bid_order_id") == bid_order_id
            ]
            for sym in to_remove:
                self._pending.pop(sym, None)

        return flatten_price

    def cancel_stale_quotes(self):
        """
        Cancel pending quotes (neither side filled) older than TTL_SECONDS.
        This frees buying power consumed by unfilled DAY limit orders.
        """
        if self._dry_run:
            return

        now = datetime.now(timezone.utc).timestamp()

        with self._pending_lock:
            stale = []
            for sym, p in self._pending.items():
                # Only cancel quotes with NO fills — positions with fills
                # are handled by position_manager.check_ttl_expirations
                if "fill_id" in p:
                    continue
                submitted = datetime.fromisoformat(p["submitted_at"]).timestamp()
                age = now - submitted
                if age >= TTL_SECONDS:
                    stale.append((sym, p["bid_order_id"], p["ask_order_id"], age))

        for sym, bid_id, ask_id, age in stale:
            logger.info(
                f"Cancelling stale quote: {sym} | age={age:.0f}s "
                f"(TTL={TTL_SECONDS}s) | freeing buying power"
            )
            for order_id in [bid_id, ask_id]:
                try:
                    self._trading.cancel_order_by_id(order_id)
                except Exception as e:
                    logger.warning(f"Cancel stale order {order_id}: {e}")

            with self._pending_lock:
                self._pending.pop(sym, None)

    def _refresh_quote(self, contract_symbol: str) -> Optional[tuple[float, float]]:
        """Get the latest bid/ask for a contract."""
        try:
            req = OptionLatestQuoteRequest(symbol_or_symbols=contract_symbol)
            data = self._options.get_option_latest_quote(req)
            if contract_symbol in data:
                q   = data[contract_symbol]
                bid = float(q.bid_price or 0)
                ask = float(q.ask_price or 0)
                if bid > 0 and ask > bid:
                    self._quotes[contract_symbol] = (bid, ask)
                    return bid, ask
        except Exception as e:
            logger.debug(f"Quote refresh failed for {contract_symbol}: {e}")
        return None

    def _get_underlying_price(self, symbol: str) -> Optional[float]:
        """Get current mid price for the underlying stock."""
        try:
            req   = StockLatestQuoteRequest(symbol_or_symbols=symbol)
            quote = self._stocks.get_stock_latest_quote(req)
            if symbol in quote:
                q = quote[symbol]
                return (float(q.bid_price) + float(q.ask_price)) / 2
        except Exception:
            pass
        return None

    def _get_account_balance(self) -> float:
        """Get current account equity."""
        try:
            account = self._trading.get_account()
            return float(account.equity)
        except Exception:
            return 50000.0  # safe fallback


class Engine:
    """
    Top-level orchestrator. Owns all components and the main loop.
    """

    def __init__(self, dry_run: bool = False):
        self._dry_run = dry_run

        logger.info(f"{'='*60}")
        logger.info(f"  Launch Control MM — Paper Engine")
        logger.info(f"  Mode: {'DRY RUN' if dry_run else 'PAPER TRADING'}")
        logger.info(f"  Universe: {UNIVERSE}")
        logger.info(f"  Max positions: {MAX_CONCURRENT_POSITIONS}")
        logger.info(f"  Kill switch: ${KILL_SWITCH_THRESHOLD}")
        logger.info(f"{'='*60}")

        # Core components
        self._fill_logger = FillLogger()
        self._risk        = RiskManager()
        self._tape        = TapeMonitor()
        self._positions   = PositionManager(self._fill_logger, self._risk)
        self._scanner     = MorningScanner()

        # Alpaca clients — paper keys for trading, live keys for data
        self._trading = TradingClient(
            api_key=ALPACA_PAPER_API_KEY,
            secret_key=ALPACA_PAPER_API_SECRET,
            paper=True,
        )
        self._stocks = StockHistoricalDataClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_API_SECRET,
        )
        self._options = OptionHistoricalDataClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_API_SECRET,
        )

        # Quote engine
        self._quotes = QuoteEngine(
            trading_client=self._trading,
            stock_client=self._stocks,
            option_client=self._options,
            fill_logger=self._fill_logger,
            risk_manager=self._risk,
            tape_monitor=self._tape,
            position_manager=self._positions,
            dry_run=dry_run,
        )

        self._running = False

    def start(self):
        """Start all components and the main loop."""
        self._running = True

        # Cancel all open orders on startup — free up buying power from stale orders
        try:
            self._trading.cancel_orders()
            logger.info("Cancelled all open orders on startup")
        except Exception as e:
            logger.warning(f"Could not cancel open orders: {e}")

        # Start tape monitor
        self._tape.start()

        # Signal handlers for clean shutdown
        signal.signal(signal.SIGINT,  self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

        # Run morning scan immediately then on schedule
        self._run_morning_scan()

        # Start heartbeat thread
        threading.Thread(
            target=self._heartbeat_loop,
            name="heartbeat",
            daemon=True
        ).start()

        # Start status printer
        threading.Thread(
            target=self._status_loop,
            name="status",
            daemon=True
        ).start()

        logger.info("Engine started. Entering main loop.")
        self._main_loop()

    def _main_loop(self):
        """
        Main trading loop. Runs continuously during market hours.
        Cycle: scan → quote → fill check → TTL check → heartbeat
        Rescans every 10 minutes to catch new spread opportunities.
        """
        import pytz
        _last_scan_time = 0  # epoch seconds of last scan

        RESCAN_INTERVAL = 600  # rescan every 10 minutes

        while self._running:
            et_now    = datetime.now(pytz.timezone('America/New_York'))
            et_hour   = et_now.hour
            et_minute = et_now.minute

            # Check if in trading window
            in_window = (
                (et_hour > TRADING_START_HOUR or
                 (et_hour == TRADING_START_HOUR and et_minute >= TRADING_START_MINUTE))
                and
                (et_hour < TRADING_END_HOUR or
                 (et_hour == TRADING_END_HOUR and et_minute < TRADING_END_MINUTE))
            )

            if not in_window:
                time.sleep(30)
                continue

            # Rescan continuously — spreads shift, new opportunities appear
            now_epoch = time.time()
            if now_epoch - _last_scan_time >= RESCAN_INTERVAL:
                logger.info("Rescanning universe for viable strikes...")
                self._run_morning_scan()
                _last_scan_time = now_epoch

            # Kill switch check
            if self._risk.kill_switch.is_active():
                logger.warning("Kill switch active. Waiting for manual reset.")
                time.sleep(60)
                continue

            try:
                # 1. Run quote cycle
                self._quotes.run_quote_cycle()

                # 2. Process fill events
                self._quotes.process_fill_events()

                # 3. Cancel stale unfilled quotes (frees buying power)
                self._quotes.cancel_stale_quotes()

                # 4. Check TTL expirations — cancel unfilled leg + market flatten
                self._positions.check_ttl_expirations(
                    cancel_callback=self._quotes.cancel_and_flatten,
                    get_underlying_price=self._quotes._get_underlying_price,
                )

                # 5. Update unrealized P&L for kill switch
                unrealized = self._positions.get_unrealized_pnl(
                    self._quotes._quotes
                )
                self._risk.kill_switch.check(unrealized)

            except Exception as e:
                logger.error(f"Main loop error: {e}", exc_info=True)

            time.sleep(2)  # 2-second cycle

    def _run_morning_scan(self):
        """Run the scanner and update the watchlist with new viable strikes."""
        try:
            new_strikes = self._scanner.run(capture_pct=SPREAD_CAPTURE_PCT)

            if new_strikes:
                # Merge: keep existing strikes we're already quoting, add new ones
                existing_syms = {s.contract_symbol for s in self._quotes._watchlist}
                added = [s for s in new_strikes if s.contract_symbol not in existing_syms]

                # Replace watchlist with fresh scan (includes updated quotes)
                self._quotes.set_watchlist(new_strikes)

                logger.info(
                    f"Scan complete: {len(new_strikes)} viable strikes "
                    f"({len(added)} new, {len(new_strikes) - len(added)} refreshed)"
                )
                for strike in new_strikes[:5]:
                    logger.info(f"  {strike}")
            else:
                logger.warning("Scan found 0 viable strikes this cycle.")
        except Exception as e:
            logger.error(f"Scan failed: {e}", exc_info=True)

    def _heartbeat_loop(self):
        """Write heartbeat every 10 seconds for dead man's switch."""
        while self._running:
            positions = self._positions.list_positions()
            write_heartbeat(positions)
            time.sleep(10)

    def _status_loop(self):
        """Print status summary every 5 minutes."""
        while self._running:
            time.sleep(300)
            fills = self._fill_logger.summary()
            risk  = self._risk.status()
            logger.info(
                f"\nSTATUS | P&L: ${fills['daily_pnl']:,.2f} | "
                f"Fills: {fills['total_fills']} | "
                f"Win: {fills['win_rate']:.1%} | "
                f"Adv: {fills['adverse_rate']:.1%} | "
                f"Positions: {risk['open_positions']}/{risk['max_positions']}"
            )

    def _shutdown(self, signum, frame):
        """Graceful shutdown — print summary before exiting."""
        logger.info("Shutdown signal received.")
        self._running = False
        self._tape.stop()
        self._fill_logger.print_summary()
        sys.exit(0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch Control MM Paper Engine")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print quote decisions without submitting orders"
    )
    args = parser.parse_args()

    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        logger.critical("ALPACA_API_KEY and ALPACA_API_SECRET (live, for data) must be set in .env")
        sys.exit(1)
    if not ALPACA_PAPER_API_KEY or not ALPACA_PAPER_API_SECRET:
        logger.critical("ALPACA_PAPER_API_KEY and ALPACA_PAPER_API_SECRET (paper, for trading) must be set in .env")
        sys.exit(1)

    # Verify API connections before starting
    try:
        from alpaca.trading.client import TradingClient as _TC
        paper_client = _TC(
            api_key=ALPACA_PAPER_API_KEY,
            secret_key=ALPACA_PAPER_API_SECRET,
            paper=True,
        )
        acct = paper_client.get_account()
        logger.info(f"Paper account verified: {acct.id} | balance: ${float(acct.equity):,.2f}")
    except Exception as e:
        logger.critical(f"Cannot connect to Alpaca paper account: {e}")
        sys.exit(1)

    try:
        from alpaca.data.historical.stock import StockHistoricalDataClient as _SC
        from alpaca.data.requests import StockLatestQuoteRequest as _SQ
        data_client = _SC(api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET)
        q = data_client.get_stock_latest_quote(_SQ(symbol_or_symbols="SPY"))
        logger.info(f"Data API verified: SPY quote received")
    except Exception as e:
        logger.critical(f"Cannot connect to Alpaca data API: {e}")
        sys.exit(1)

    engine = Engine(dry_run=args.dry_run)
    engine.start()
