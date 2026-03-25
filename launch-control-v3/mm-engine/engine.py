"""
Launch Control MM v2 — Sequential Spread Scalper

Replaces the broken two-sided quoting engine. Instead of posting bid+ask
simultaneously (which never gets passive fills on Alpaca paper), this engine:

  1. Scans for liquid option contracts with wide spreads
  2. Monitors price for dips below rolling average (mean reversion signal)
  3. Buys one side at a time via limit order
  4. On fill: immediately posts sell at profit target
  5. Flattens at market on stop loss or TTL expiry

Per-trade economics (at 2 contracts, $0.05 target):
  Win:  +$10  (sell at buy + $0.05 × 2 × 100)
  Loss: -$20  (stop at buy - $0.10 × 2 × 100)
  Need: 67%+ win rate to break even, targeting 80%+

Usage:
  python engine.py [--paper] [--dry-run]
"""

import os
import sys
import time
import signal
import logging
import argparse
import threading
from datetime import datetime, timezone, date
from dataclasses import dataclass, field
from typing import Optional, Dict, Tuple

sys.path.insert(0, os.path.dirname(__file__))

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import LimitOrderRequest, MarketOrderRequest
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
    MAX_CONCURRENT_POSITIONS, MIN_SPREAD_WIDTH,
    SCAN_START_HOUR, SCAN_START_MINUTE,
    PROFIT_TARGET, STOP_LOSS,
    BUY_TTL_SECONDS, SELL_TTL_SECONDS,
    DIP_THRESHOLD, PRICE_HISTORY_SECONDS,
    CYCLE_SECONDS, RESCAN_INTERVAL, COOLDOWN_SECONDS,
    MAX_COST_PCT,
)
from fill_logger import FillLogger
from risk_controls import RiskManager
from scanner import MorningScanner, ViableStrike
from position_manager import PositionManager
from dead_mans_switch import write_heartbeat

# ── Logging ──────────────────────────────────────────────────────────────────
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
    ],
)
logger = logging.getLogger("engine")


# ── State per contract ───────────────────────────────────────────────────────

@dataclass
class ScalpState:
    """Tracks one contract through the scalp lifecycle."""

    contract_symbol: str
    strike_info: ViableStrike
    state: str = "watching"  # watching | buy_pending | sell_pending

    # Rolling price history for mean reversion signal
    price_history: list = field(default_factory=list)  # [(epoch, mid)]

    # Buy order
    buy_order_id: Optional[str] = None
    buy_submitted_at: float = 0.0

    # Sell order / position
    sell_order_id: Optional[str] = None
    sell_submitted_at: float = 0.0
    buy_fill_price: float = 0.0
    sell_target: float = 0.0
    stop_price: float = 0.0
    fill_id: Optional[str] = None

    # Cooldown after exit
    last_exit_time: float = 0.0

    # Per-contract stats (session only)
    trades: int = 0
    pnl: float = 0.0


# ── Spread Scalper ───────────────────────────────────────────────────────────

class SpreadScalper:
    """
    Sequential spread scalping engine.

    For each watched contract, cycles through:
      WATCHING → BUY_PENDING → SELL_PENDING → WATCHING

    Entry: buy when option price dips below rolling average.
    Exit: sell at profit target, or flatten on stop/TTL.

    One position at a time per contract. Sequential, never simultaneous.
    Batch quote refresh — one API call for all contracts.
    """

    def __init__(
        self,
        trading_client: TradingClient,
        stock_client: StockHistoricalDataClient,
        option_client: OptionHistoricalDataClient,
        fill_logger: FillLogger,
        risk_manager: RiskManager,
        position_manager: PositionManager,
        dry_run: bool = False,
    ):
        self._trading = trading_client
        self._stocks = stock_client
        self._options = option_client
        self._logger = fill_logger
        self._risk = risk_manager
        self._positions = position_manager
        self._dry_run = dry_run

        self._states: Dict[str, ScalpState] = {}
        self._quotes: Dict[str, Tuple[float, float]] = {}

    # ── Watchlist management ─────────────────────────────────────────────────

    def set_watchlist(self, watchlist: list[ViableStrike]):
        """Update watchlist. Preserves state for contracts in active trades."""
        new_syms = {s.contract_symbol for s in watchlist}

        # Remove contracts not in new list (only if idle)
        to_remove = [
            sym for sym in self._states
            if sym not in new_syms and self._states[sym].state == "watching"
        ]
        for sym in to_remove:
            del self._states[sym]

        # Add new contracts
        for strike in watchlist:
            sym = strike.contract_symbol
            if sym not in self._states:
                self._states[sym] = ScalpState(
                    contract_symbol=sym,
                    strike_info=strike,
                )
            else:
                # Update strike info (quotes may have changed)
                self._states[sym].strike_info = strike

        logger.info(f"Watchlist set: {len(self._states)} contracts")

    # ── Main cycle ───────────────────────────────────────────────────────────

    def run_cycle(self):
        """One complete scalp cycle across all watched contracts."""
        if not self._states:
            return

        # Categorize by state
        watching = []
        buy_pending = []
        sell_pending = []
        for sym, s in self._states.items():
            if s.state == "watching":
                watching.append(sym)
            elif s.state == "buy_pending":
                buy_pending.append(sym)
            elif s.state == "sell_pending":
                sell_pending.append(sym)

        # Batch refresh quotes for watching + sell_pending (stop checks)
        need_quotes = watching + sell_pending
        if need_quotes:
            self._batch_refresh_quotes(need_quotes)

        # Process active orders first (quick — just order status checks)
        for sym in buy_pending:
            self._handle_buy_pending(sym, self._states[sym])
        for sym in sell_pending:
            self._handle_sell_pending(sym, self._states[sym])

        # Then look for new entries
        self._scan_entries(watching)

        if buy_pending or sell_pending:
            logger.info(
                f"Cycle: {len(watching)} watching | "
                f"{len(buy_pending)} buying | {len(sell_pending)} selling"
            )

    # ── Batch quote refresh ──────────────────────────────────────────────────

    def _batch_refresh_quotes(self, symbols: list[str]):
        """Refresh quotes for multiple contracts in one API call."""
        if not symbols:
            return
        try:
            req = OptionLatestQuoteRequest(symbol_or_symbols=symbols)
            data = self._options.get_option_latest_quote(req)
            for sym, q in data.items():
                bid = float(q.bid_price or 0)
                ask = float(q.ask_price or 0)
                if bid > 0 and ask > bid:
                    self._quotes[sym] = (bid, ask)
                    self._risk.data_fresh.update(sym)
        except Exception as e:
            logger.error(f"Batch quote refresh failed: {e}")

    # ── Entry scanning ───────────────────────────────────────────────────────

    def _scan_entries(self, watching_syms: list[str]):
        """Scan watching contracts for entry signals. Submit best entries."""
        candidates = []

        for sym in watching_syms:
            state = self._states[sym]

            # Cooldown
            if state.last_exit_time and time.time() - state.last_exit_time < COOLDOWN_SECONDS:
                continue

            # Need a fresh quote
            quote = self._quotes.get(sym)
            if not quote:
                continue

            bid, ask = quote
            spread = ask - bid
            mid = (bid + ask) / 2

            if spread < MIN_SPREAD_WIDTH:
                continue

            # Skip expensive contracts — we're scalping, not investing
            if mid > 5.0:
                continue

            # Update price history
            now = time.time()
            state.price_history.append((now, mid))
            cutoff = now - PRICE_HISTORY_SECONDS
            state.price_history = [(t, m) for t, m in state.price_history if t > cutoff]

            # Need enough history for signal
            if len(state.price_history) < 6:
                continue

            # Rolling average
            avg_mid = sum(m for _, m in state.price_history) / len(state.price_history)

            # Entry signal: current mid below rolling average
            dip_pct = (mid - avg_mid) / avg_mid if avg_mid > 0 else 0
            if dip_pct > -DIP_THRESHOLD:
                continue

            # Buy at mid price — fills when ask drops to our price
            buy_price = round(mid, 2)
            if buy_price <= 0:
                continue

            candidates.append((sym, state, dip_pct, buy_price, spread))

        if not candidates:
            return

        # Sort by biggest dip first (strongest mean reversion signal)
        candidates.sort(key=lambda x: x[2])

        # How many slots available?
        active_count = sum(
            1 for s in self._states.values() if s.state != "watching"
        )
        available = MAX_CONCURRENT_POSITIONS - active_count
        if available <= 0:
            return

        # Get account balance once for all entries
        account_balance = self._get_account_balance()
        unrealized = self._positions.get_unrealized_pnl(self._quotes)

        submitted = 0
        for sym, state, dip_pct, buy_price, spread in candidates:
            if submitted >= available:
                break

            # Risk check
            ok, reason = self._risk.check_pre_order(
                symbol=sym,
                account_balance=account_balance,
                unrealized_pnl=unrealized,
                is_opening=True,
            )
            if not ok:
                logger.debug(f"Risk blocked ({reason}): {sym}")
                continue

            # Cost check
            cost = buy_price * 100 * CONTRACTS_PER_TRADE
            if cost > account_balance * MAX_COST_PCT:
                continue

            # Submit buy
            logger.info(
                f"ENTRY: {sym} | mid=${buy_price:.2f} dip={dip_pct:.3%} "
                f"spread=${spread:.2f} | buying {CONTRACTS_PER_TRADE}x @ ${buy_price:.2f}"
            )

            if self._dry_run:
                logger.info(f"[DRY RUN] Would buy: {sym} @ ${buy_price:.2f}")
                continue

            try:
                order = self._trading.submit_order(LimitOrderRequest(
                    symbol=sym,
                    qty=CONTRACTS_PER_TRADE,
                    side=OrderSide.BUY,
                    time_in_force=TimeInForce.DAY,
                    limit_price=buy_price,
                ))
                state.state = "buy_pending"
                state.buy_order_id = str(order.id)
                state.buy_submitted_at = time.time()
                submitted += 1
                logger.info(f"Buy submitted: {sym} @ ${buy_price:.2f} | order={order.id}")
                time.sleep(0.3)  # throttle between submissions
            except Exception as e:
                logger.error(f"Buy failed: {sym}: {e}")

    # ── Buy pending handler ──────────────────────────────────────────────────

    def _handle_buy_pending(self, sym: str, state: ScalpState):
        """Check buy order: filled → submit sell, TTL → cancel."""
        try:
            order = self._trading.get_order_by_id(state.buy_order_id)
        except Exception as e:
            logger.error(f"Buy check failed: {sym}: {e}")
            return

        if order.status == OrderStatus.FILLED:
            fill_price = float(order.filled_avg_price or 0)
            logger.info(f"BUY FILLED: {sym} @ ${fill_price:.2f}")
            self._on_buy_filled(sym, state, fill_price)

        elif order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED, OrderStatus.REJECTED):
            logger.info(f"Buy {order.status.name}: {sym}")
            self._reset_to_watching(state)

        elif time.time() - state.buy_submitted_at > BUY_TTL_SECONDS:
            logger.info(f"Buy TTL ({BUY_TTL_SECONDS}s): {sym} — cancelling")
            try:
                self._trading.cancel_order_by_id(state.buy_order_id)
            except Exception:
                pass
            # Check for race: filled during cancel
            time.sleep(0.3)
            try:
                final = self._trading.get_order_by_id(state.buy_order_id)
                if final.status == OrderStatus.FILLED:
                    fill_price = float(final.filled_avg_price or 0)
                    logger.info(f"Buy filled during cancel: {sym} @ ${fill_price:.2f}")
                    self._on_buy_filled(sym, state, fill_price)
                    return
            except Exception:
                pass
            self._reset_to_watching(state)

    def _on_buy_filled(self, sym: str, state: ScalpState, fill_price: float):
        """Handle a buy fill: open position + submit sell at target."""
        strike = state.strike_info

        # Open in position manager
        underlying_px = self._get_underlying_price(strike.symbol)
        quote = self._quotes.get(sym, (0, 0))

        fill_id = self._positions.open_position(
            symbol=strike.symbol,
            contract_symbol=sym,
            strike=strike.strike,
            expiry=str(strike.expiry),
            option_type=strike.option_type,
            dte_at_entry=strike.dte,
            underlying_price_entry=underlying_px or strike.underlying_price,
            bid_at_entry=quote[0],
            ask_at_entry=quote[1],
            iv_at_entry=strike.iv,
            delta_at_entry=strike.delta,
            otm_pct=strike.otm_pct,
            our_bid=fill_price,
            our_ask=round(fill_price + PROFIT_TARGET, 2),
            capture_target=PROFIT_TARGET,
            tape_bid_prints=0,
            tape_ask_prints=0,
            open_side="bid_hit",
            open_price=fill_price,
            bid_order_id=state.buy_order_id,
        )

        state.fill_id = fill_id
        state.buy_fill_price = fill_price
        state.sell_target = round(fill_price + PROFIT_TARGET, 2)
        state.stop_price = round(fill_price - STOP_LOSS, 2)

        # Submit sell at profit target
        try:
            sell_order = self._trading.submit_order(LimitOrderRequest(
                symbol=sym,
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
                limit_price=state.sell_target,
            ))
            state.state = "sell_pending"
            state.sell_order_id = str(sell_order.id)
            state.sell_submitted_at = time.time()
            logger.info(
                f"Sell posted: {sym} @ ${state.sell_target:.2f} "
                f"(+${PROFIT_TARGET:.2f}) stop=${state.stop_price:.2f} | "
                f"order={sell_order.id}"
            )
        except Exception as e:
            logger.error(f"Sell submit failed: {sym}: {e} — flattening")
            self._flatten_position(sym, state)

    # ── Sell pending handler ─────────────────────────────────────────────────

    def _handle_sell_pending(self, sym: str, state: ScalpState):
        """Check sell order: filled → profit, stop → flatten, TTL → flatten."""
        try:
            order = self._trading.get_order_by_id(state.sell_order_id)
        except Exception as e:
            logger.error(f"Sell check failed: {sym}: {e}")
            return

        if order.status == OrderStatus.FILLED:
            fill_price = float(order.filled_avg_price or state.sell_target)
            pnl = (fill_price - state.buy_fill_price) * CONTRACTS_PER_TRADE * 100
            logger.info(
                f"PROFIT: {sym} buy=${state.buy_fill_price:.2f} "
                f"sell=${fill_price:.2f} P&L=${pnl:+.2f}"
            )
            underlying_px = self._get_underlying_price(state.strike_info.symbol)
            self._positions.close_position(
                fill_id=state.fill_id,
                close_price=fill_price,
                close_reason="natural_fill",
                underlying_price_close=underlying_px,
            )
            state.trades += 1
            state.pnl += pnl
            self._reset_to_watching(state)
            return

        if order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED, OrderStatus.REJECTED):
            logger.warning(f"Sell {order.status.name}: {sym} — flattening")
            self._flatten_position(sym, state)
            return

        # Stop loss check: use cached quote from batch refresh
        quote = self._quotes.get(sym)
        if quote:
            bid = quote[0]
            if bid <= state.stop_price and state.stop_price > 0:
                logger.warning(
                    f"STOP: {sym} bid=${bid:.2f} <= stop=${state.stop_price:.2f}"
                )
                self._cancel_and_flatten(sym, state, "stop_loss")
                return

        # Sell TTL check
        if time.time() - state.sell_submitted_at > SELL_TTL_SECONDS:
            logger.info(f"Sell TTL ({SELL_TTL_SECONDS}s): {sym} — flattening")
            self._cancel_and_flatten(sym, state, "ttl_flatten")

    # ── Flatten helpers ──────────────────────────────────────────────────────

    def _cancel_and_flatten(self, sym: str, state: ScalpState, reason: str):
        """Cancel sell order, then market flatten."""
        try:
            self._trading.cancel_order_by_id(state.sell_order_id)
        except Exception:
            pass

        # Race check: did sell fill during cancel?
        time.sleep(0.3)
        try:
            final = self._trading.get_order_by_id(state.sell_order_id)
            if final.status == OrderStatus.FILLED:
                fill_price = float(final.filled_avg_price or state.sell_target)
                pnl = (fill_price - state.buy_fill_price) * CONTRACTS_PER_TRADE * 100
                logger.info(f"Sell filled during cancel: {sym} @ ${fill_price:.2f} P&L=${pnl:+.2f}")
                underlying_px = self._get_underlying_price(state.strike_info.symbol)
                self._positions.close_position(
                    fill_id=state.fill_id,
                    close_price=fill_price,
                    close_reason="natural_fill",
                    underlying_price_close=underlying_px,
                )
                state.trades += 1
                state.pnl += pnl
                self._reset_to_watching(state)
                return
        except Exception:
            pass

        self._flatten_position(sym, state, reason)

    def _flatten_position(self, sym: str, state: ScalpState, reason: str = "flatten"):
        """Market sell to exit position."""
        if self._dry_run:
            logger.info(f"[DRY RUN] Would flatten: {sym}")
            self._reset_to_watching(state)
            return

        flatten_price = None
        try:
            order = self._trading.submit_order(MarketOrderRequest(
                symbol=sym,
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
            ))
            logger.info(f"Flatten: {sym} MARKET SELL | order={order.id}")

            # Poll for fill price
            for _ in range(6):
                time.sleep(0.5)
                try:
                    status = self._trading.get_order_by_id(str(order.id))
                    if status.status == OrderStatus.FILLED:
                        flatten_price = float(status.filled_avg_price)
                        break
                except Exception:
                    pass

        except Exception as e:
            logger.error(f"Flatten failed: {sym}: {e}")

        # Log P&L
        if flatten_price:
            pnl = (flatten_price - state.buy_fill_price) * CONTRACTS_PER_TRADE * 100
            logger.info(f"Flatten filled: {sym} @ ${flatten_price:.2f} P&L=${pnl:+.2f}")
            state.pnl += pnl
        else:
            logger.warning(f"Flatten: {sym} — no fill price, modeling as loss")

        underlying_px = self._get_underlying_price(state.strike_info.symbol)
        self._positions.close_position(
            fill_id=state.fill_id,
            close_price=flatten_price,
            close_reason=reason,
            underlying_price_close=underlying_px,
        )
        state.trades += 1
        self._reset_to_watching(state)

    def _reset_to_watching(self, state: ScalpState):
        """Reset contract state to watching."""
        state.state = "watching"
        state.buy_order_id = None
        state.sell_order_id = None
        state.fill_id = None
        state.buy_fill_price = 0.0
        state.sell_target = 0.0
        state.stop_price = 0.0
        state.last_exit_time = time.time()

    # ── Shutdown ─────────────────────────────────────────────────────────────

    def cancel_all(self):
        """Cancel all pending orders and flatten all positions. Used on shutdown."""
        for sym, state in list(self._states.items()):
            if state.state == "buy_pending" and state.buy_order_id:
                try:
                    self._trading.cancel_order_by_id(state.buy_order_id)
                    logger.info(f"Cancelled buy: {sym}")
                except Exception:
                    pass
                self._reset_to_watching(state)
            elif state.state == "sell_pending":
                self._cancel_and_flatten(sym, state, "shutdown")

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _get_underlying_price(self, symbol: str) -> Optional[float]:
        try:
            req = StockLatestQuoteRequest(symbol_or_symbols=symbol)
            quote = self._stocks.get_stock_latest_quote(req)
            if symbol in quote:
                q = quote[symbol]
                return (float(q.bid_price) + float(q.ask_price)) / 2
        except Exception:
            pass
        return None

    def _get_account_balance(self) -> float:
        try:
            account = self._trading.get_account()
            return float(account.equity)
        except Exception:
            return 50000.0

    def session_stats(self) -> dict:
        """Return per-contract stats for this session."""
        total_trades = sum(s.trades for s in self._states.values())
        total_pnl = sum(s.pnl for s in self._states.values())
        active = sum(1 for s in self._states.values() if s.state != "watching")
        return {
            "total_trades": total_trades,
            "total_pnl": round(total_pnl, 2),
            "active_positions": active,
            "watching": len(self._states) - active,
            "contracts_tracked": len(self._states),
        }


# ── Engine orchestrator ──────────────────────────────────────────────────────

class Engine:
    """
    Top-level orchestrator. Owns all components and the main loop.
    """

    def __init__(self, dry_run: bool = False):
        self._dry_run = dry_run

        logger.info(f"{'=' * 60}")
        logger.info(f"  Launch Control MM v2 — Sequential Spread Scalper")
        logger.info(f"  Mode: {'DRY RUN' if dry_run else 'PAPER TRADING'}")
        logger.info(f"  Universe: {UNIVERSE}")
        logger.info(f"  Contracts per trade: {CONTRACTS_PER_TRADE}")
        logger.info(f"  Profit target: ${PROFIT_TARGET:.2f}/contract")
        logger.info(f"  Stop loss: ${STOP_LOSS:.2f}/contract")
        logger.info(f"  Buy TTL: {BUY_TTL_SECONDS}s | Sell TTL: {SELL_TTL_SECONDS}s")
        logger.info(f"  Dip threshold: {DIP_THRESHOLD:.1%}")
        logger.info(f"  Max positions: {MAX_CONCURRENT_POSITIONS}")
        logger.info(f"  Cycle interval: {CYCLE_SECONDS}s")
        logger.info(f"{'=' * 60}")

        # Core components
        self._fill_logger = FillLogger()
        self._risk = RiskManager()
        self._positions = PositionManager(self._fill_logger, self._risk)
        self._scanner = MorningScanner()

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

        # Scalper engine
        self._scalper = SpreadScalper(
            trading_client=self._trading,
            stock_client=self._stocks,
            option_client=self._options,
            fill_logger=self._fill_logger,
            risk_manager=self._risk,
            position_manager=self._positions,
            dry_run=dry_run,
        )

        self._running = False

    def start(self):
        """Start engine: clean up, scan, run main loop."""
        self._running = True

        # Cancel stale orders from prior sessions
        try:
            self._trading.cancel_orders()
            logger.info("Cancelled all open orders on startup")
        except Exception as e:
            logger.warning(f"Cancel orders on startup: {e}")

        # Flatten leftover positions
        try:
            time.sleep(1)
            positions = self._trading.get_all_positions()
            option_positions = [p for p in positions if p.asset_class == "us_option"]
            if option_positions:
                logger.warning(f"Flattening {len(option_positions)} leftover positions")
                for pos in option_positions:
                    try:
                        qty = abs(int(pos.qty))
                        side = OrderSide.SELL if float(pos.qty) > 0 else OrderSide.BUY
                        self._trading.submit_order(MarketOrderRequest(
                            symbol=pos.symbol, qty=qty, side=side,
                            time_in_force=TimeInForce.DAY,
                        ))
                        logger.warning(f"  Flattened: {pos.symbol} {side.name} {qty}")
                    except Exception as e:
                        logger.error(f"  Flatten {pos.symbol}: {e}")
            else:
                logger.info("No leftover positions — starting clean")
        except Exception as e:
            logger.warning(f"Leftover check: {e}")

        # Graceful shutdown handlers
        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

        # Initial scan
        self._run_scan()

        # Background threads
        threading.Thread(target=self._heartbeat_loop, name="heartbeat", daemon=True).start()
        threading.Thread(target=self._status_loop, name="status", daemon=True).start()

        logger.info("Engine started. Entering main loop.")
        self._main_loop()

    def _main_loop(self):
        """Main trading loop."""
        import pytz

        last_scan = 0

        while self._running:
            et = datetime.now(pytz.timezone("America/New_York"))

            # Trading window check
            in_window = (
                (et.hour > TRADING_START_HOUR
                 or (et.hour == TRADING_START_HOUR and et.minute >= TRADING_START_MINUTE))
                and
                (et.hour < TRADING_END_HOUR
                 or (et.hour == TRADING_END_HOUR and et.minute < TRADING_END_MINUTE))
            )

            if not in_window:
                time.sleep(30)
                continue

            # Periodic rescan
            now = time.time()
            if now - last_scan >= RESCAN_INTERVAL:
                self._run_scan()
                last_scan = now

            # Kill switch
            if self._risk.kill_switch.is_active():
                logger.warning("Kill switch active. Halted.")
                time.sleep(60)
                continue

            try:
                self._scalper.run_cycle()
            except Exception as e:
                logger.error(f"Main loop error: {e}", exc_info=True)

            time.sleep(CYCLE_SECONDS)

    def _run_scan(self):
        """Run scanner and update watchlist."""
        try:
            strikes = self._scanner.run(capture_pct=SPREAD_CAPTURE_PCT)
            if strikes:
                self._scalper.set_watchlist(strikes)
                logger.info(f"Scan: {len(strikes)} viable strikes")
                for s in strikes[:5]:
                    logger.info(f"  {s}")
            else:
                logger.warning("Scan: 0 viable strikes")
        except Exception as e:
            logger.error(f"Scan failed: {e}", exc_info=True)

    def _heartbeat_loop(self):
        """DMS heartbeat every 10s."""
        while self._running:
            positions = self._positions.list_positions()
            write_heartbeat(positions)
            time.sleep(10)

    def _status_loop(self):
        """Status summary every 2 minutes."""
        while self._running:
            time.sleep(120)
            fills = self._fill_logger.summary()
            stats = self._scalper.session_stats()
            logger.info(
                f"\nSTATUS | Trades: {stats['total_trades']} | "
                f"P&L: ${stats['total_pnl']:+,.2f} | "
                f"Active: {stats['active_positions']} | "
                f"Watching: {stats['watching']} | "
                f"Win rate: {fills['win_rate']:.0%}"
            )

    def _shutdown(self, signum, frame):
        """Graceful shutdown."""
        logger.info("Shutdown signal received.")
        self._running = False
        self._scalper.cancel_all()
        self._fill_logger.print_summary()
        sys.exit(0)


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch Control MM v2 — Spread Scalper")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print decisions without submitting orders",
    )
    args = parser.parse_args()

    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        logger.critical("ALPACA_API_KEY and ALPACA_API_SECRET (live, for data) required")
        sys.exit(1)
    if not ALPACA_PAPER_API_KEY or not ALPACA_PAPER_API_SECRET:
        logger.critical("ALPACA_PAPER_API_KEY and ALPACA_PAPER_API_SECRET (paper, for trading) required")
        sys.exit(1)

    # Verify connections
    try:
        paper = TradingClient(
            api_key=ALPACA_PAPER_API_KEY,
            secret_key=ALPACA_PAPER_API_SECRET,
            paper=True,
        )
        acct = paper.get_account()
        logger.info(f"Paper account: {acct.id} | balance: ${float(acct.equity):,.2f}")
    except Exception as e:
        logger.critical(f"Cannot connect to paper account: {e}")
        sys.exit(1)

    try:
        data_client = StockHistoricalDataClient(
            api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET,
        )
        q = data_client.get_stock_latest_quote(StockLatestQuoteRequest(symbol_or_symbols="SPY"))
        logger.info("Data API verified: SPY quote OK")
    except Exception as e:
        logger.critical(f"Cannot connect to data API: {e}")
        sys.exit(1)

    engine = Engine(dry_run=args.dry_run)
    engine.start()
