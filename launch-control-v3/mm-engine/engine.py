"""
Launch Control MM v3 — 1DTE Gamma Scalper

Scalps ATM SPY options expiring tomorrow using short-term momentum signals.
Uses 1DTE because Alpaca rejects opening positions on 0DTE contracts.

Strategy:
  1. Monitor SPY 1-minute bars for momentum (2 consecutive up/down bars)
  2. On UP momentum → market buy ATM call
  3. On DOWN momentum → market buy ATM put
  4. Sell at profit target ($0.20) or flatten on stop/TTL

Why this works on Alpaca paper:
  - 1DTE ATM options have $0.01-$0.10 spreads (minimal entry cost)
  - High gamma: $0.50 SPY move = $0.10-$0.30 option move
  - Market orders guarantee fills
  - Momentum gives directional edge for 30-90 second holds

Usage:
  python engine.py [--dry-run]
"""

import os
import sys
import time
import signal
import logging
import argparse
import threading
from collections import deque
from datetime import datetime, timezone, date, timedelta
from typing import Optional, Dict, Tuple

sys.path.insert(0, os.path.dirname(__file__))

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import LimitOrderRequest, MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.requests import StockLatestQuoteRequest, StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.historical.option import OptionHistoricalDataClient
from alpaca.data.requests import OptionLatestQuoteRequest

from config import (
    ALPACA_API_KEY, ALPACA_API_SECRET,
    ALPACA_PAPER_API_KEY, ALPACA_PAPER_API_SECRET,
    UNIVERSE, CONTRACTS_PER_TRADE,
    TRADING_START_HOUR, TRADING_START_MINUTE,
    TRADING_END_HOUR, TRADING_END_MINUTE,
    MAX_CONCURRENT_POSITIONS,
    PROFIT_TARGET, STOP_LOSS, HOLD_TTL_SECONDS, BUY_TTL_SECONDS,
    MOMENTUM_BARS, COOLDOWN_SECONDS,
    CYCLE_SECONDS, RESCAN_INTERVAL, MAX_COST_PCT,
    SPREAD_CAPTURE_PCT,
)
from fill_logger import FillLogger
from risk_controls import RiskManager
from scanner import ZeroDTEScanner, ViableStrike
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


# ── Momentum Tracker ─────────────────────────────────────────────────────────

class MomentumTracker:
    """
    Tracks SPY 1-minute bars and detects short-term momentum.
    Signal fires after N consecutive up (buy calls) or down (buy puts) bars.
    """

    def __init__(self, stock_client: StockHistoricalDataClient):
        self._stocks = stock_client
        self._closes: deque = deque(maxlen=20)
        self._last_bar_time = None
        self._spy_price = 0.0

    def update(self) -> bool:
        """Fetch latest 1-min bars. Returns True if a new bar was detected."""
        try:
            req = StockBarsRequest(
                symbol_or_symbols="SPY",
                timeframe=TimeFrame.Minute,
                start=datetime.now(timezone.utc) - timedelta(minutes=15),
            )
            data = self._stocks.get_stock_bars(req)

            # BarSet uses bracket access, not .get()
            try:
                bars = data["SPY"]
            except (KeyError, TypeError, AttributeError):
                bars = []

            bar_list = list(bars) if bars else []
            if not bar_list:
                return False

            latest = bar_list[-1]
            latest_time = str(latest.timestamp)
            self._spy_price = float(latest.close)

            if latest_time != self._last_bar_time:
                self._last_bar_time = latest_time
                self._closes.append(float(latest.close))
                logger.debug(
                    f"New bar: SPY close=${self._spy_price:.2f} "
                    f"bars={len(self._closes)}"
                )
                return True

        except Exception as e:
            logger.error(f"Bar fetch failed: {e}")

        return False

    def get_signal(self) -> Optional[str]:
        """
        Check for momentum signal.
        Returns 'CALL' (up momentum), 'PUT' (down momentum), or None.
        """
        needed = MOMENTUM_BARS + 1  # need N+1 closes to detect N moves
        if len(self._closes) < needed:
            return None

        recent = list(self._closes)[-needed:]

        # Check consecutive UP bars
        all_up = all(recent[i] < recent[i + 1] for i in range(len(recent) - 1))
        if all_up:
            move = recent[-1] - recent[0]
            logger.info(
                f"MOMENTUM UP: {MOMENTUM_BARS} bars, "
                f"SPY ${recent[0]:.2f} → ${recent[-1]:.2f} (+${move:.2f})"
            )
            return "CALL"

        # Check consecutive DOWN bars
        all_down = all(recent[i] > recent[i + 1] for i in range(len(recent) - 1))
        if all_down:
            move = recent[0] - recent[-1]
            logger.info(
                f"MOMENTUM DOWN: {MOMENTUM_BARS} bars, "
                f"SPY ${recent[0]:.2f} → ${recent[-1]:.2f} (-${move:.2f})"
            )
            return "PUT"

        return None

    @property
    def spy_price(self) -> float:
        return self._spy_price

    @property
    def bar_count(self) -> int:
        return len(self._closes)


# ── Gamma Scalper ────────────────────────────────────────────────────────────

class GammaScalper:
    """
    1DTE gamma scalping engine.

    State machine:
      IDLE → BUY_PENDING → HOLDING → IDLE
        IDLE: waiting for momentum signal
      BUY_PENDING: market buy submitted, waiting for fill
      HOLDING: position open, sell limit posted, monitoring stop/TTL
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
        self._fill_logger = fill_logger
        self._risk = risk_manager
        self._positions = position_manager
        self._dry_run = dry_run

        self._momentum = MomentumTracker(stock_client)

        # Watchlist: best ATM call and put from scanner
        self._call_strike: Optional[ViableStrike] = None
        self._put_strike: Optional[ViableStrike] = None
        self._all_strikes: list[ViableStrike] = []

        # Current position state
        self._state = "idle"  # idle | buy_pending | holding
        self._position: Dict = {}
        self._last_exit_time = 0.0

        # Quote cache for stop loss checks
        self._quotes: Dict[str, Tuple[float, float]] = {}

        # Session stats
        self._trades = 0
        self._wins = 0
        self._pnl = 0.0

    def set_watchlist(self, strikes: list[ViableStrike]):
        """Pick the best ATM call and put from scanner results."""
        self._all_strikes = strikes

        calls = [s for s in strikes if s.option_type == "call"]
        puts = [s for s in strikes if s.option_type == "put"]

        # Best = closest strike to underlying price (already sorted by scanner)
        self._call_strike = calls[0] if calls else None
        self._put_strike = puts[0] if puts else None

        if self._call_strike:
            logger.info(f"  CALL: {self._call_strike}")
        if self._put_strike:
            logger.info(f"  PUT:  {self._put_strike}")

    def run_cycle(self):
        """One scalp cycle. Called every CYCLE_SECONDS."""
        if self._state == "idle":
            self._handle_idle()
        elif self._state == "buy_pending":
            self._handle_buy_pending()
        elif self._state == "holding":
            self._handle_holding()

    # ── IDLE: wait for momentum signal ───────────────────────────────────────

    def _handle_idle(self):
        """Check for new momentum signal."""
        # Cooldown
        if time.time() - self._last_exit_time < COOLDOWN_SECONDS:
            return

        # Update momentum tracker (checks for new 1-min bars)
        new_bar = self._momentum.update()
        if not new_bar:
            return

        signal = self._momentum.get_signal()
        if not signal:
            return

        # Pick the right contract
        strike = self._call_strike if signal == "CALL" else self._put_strike
        if not strike:
            logger.warning(f"Signal {signal} but no {signal.lower()} strike available")
            return

        # Refresh quote for this contract
        quote = self._refresh_quote(strike.contract_symbol)
        if not quote:
            logger.warning(f"No quote for {strike.contract_symbol}")
            return

        bid, ask = quote
        spread = ask - bid

        # Risk checks
        account_balance = self._get_account_balance()
        unrealized = self._positions.get_unrealized_pnl(self._quotes)
        ok, reason = self._risk.check_pre_order(
            symbol=strike.contract_symbol,
            account_balance=account_balance,
            unrealized_pnl=unrealized,
            is_opening=True,
        )
        if not ok:
            logger.info(f"Risk blocked ({reason})")
            return

        cost = ask * 100 * CONTRACTS_PER_TRADE
        if cost > account_balance * MAX_COST_PCT:
            logger.info(f"Skip: cost=${cost:.0f} > {MAX_COST_PCT:.0%} of ${account_balance:.0f}")
            return

        # Enter position
        logger.info(
            f"SIGNAL: {signal} | {strike.contract_symbol} "
            f"bid=${bid:.2f} ask=${ask:.2f} spread=${spread:.2f} "
            f"delta={strike.delta:.2f} | MARKET BUY {CONTRACTS_PER_TRADE}x"
        )

        if self._dry_run:
            logger.info(f"[DRY RUN] Would buy: {strike.contract_symbol}")
            return

        try:
            order = self._trading.submit_order(MarketOrderRequest(
                symbol=strike.contract_symbol,
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.BUY,
                time_in_force=TimeInForce.DAY,
            ))
            self._state = "buy_pending"
            self._position = {
                "direction": signal,
                "strike": strike,
                "contract_symbol": strike.contract_symbol,
                "buy_order_id": str(order.id),
                "buy_submitted_at": time.time(),
            }
            logger.info(f"Market buy submitted: {strike.contract_symbol} | order={order.id}")

        except Exception as e:
            logger.error(f"Buy failed: {e}")

    # ── BUY_PENDING: wait for market order fill ──────────────────────────────

    def _handle_buy_pending(self):
        """Check if market buy filled."""
        pos = self._position
        try:
            order = self._trading.get_order_by_id(pos["buy_order_id"])
        except Exception as e:
            logger.error(f"Buy check failed: {e}")
            return

        if order.status == OrderStatus.FILLED:
            fill_price = float(order.filled_avg_price or 0)
            logger.info(
                f"BUY FILLED: {pos['contract_symbol']} @ ${fill_price:.2f} "
                f"({pos['direction']})"
            )
            self._on_buy_filled(fill_price)

        elif order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED, OrderStatus.REJECTED):
            logger.warning(f"Buy {order.status.name}: {pos['contract_symbol']}")
            self._reset_to_idle()

        elif time.time() - pos["buy_submitted_at"] > BUY_TTL_SECONDS:
            logger.warning(f"Buy TTL ({BUY_TTL_SECONDS}s) — cancelling")
            try:
                self._trading.cancel_order_by_id(pos["buy_order_id"])
            except Exception:
                pass
            time.sleep(0.3)
            # Race check
            try:
                final = self._trading.get_order_by_id(pos["buy_order_id"])
                if final.status == OrderStatus.FILLED:
                    self._on_buy_filled(float(final.filled_avg_price or 0))
                    return
            except Exception:
                pass
            self._reset_to_idle()

    def _on_buy_filled(self, fill_price: float):
        """Handle buy fill: open position, post sell limit."""
        pos = self._position
        strike = pos["strike"]

        # Open in position manager
        underlying_px = self._momentum.spy_price or strike.underlying_price
        fill_id = self._positions.open_position(
            symbol=strike.symbol,
            contract_symbol=pos["contract_symbol"],
            strike=strike.strike,
            expiry=str(strike.expiry),
            option_type=strike.option_type,
            dte_at_entry=strike.dte,
            underlying_price_entry=underlying_px,
            bid_at_entry=strike.bid,
            ask_at_entry=strike.ask,
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
            bid_order_id=pos["buy_order_id"],
        )

        sell_target = round(fill_price + PROFIT_TARGET, 2)
        stop_price = round(fill_price - STOP_LOSS, 2)

        # Post sell limit at profit target
        try:
            sell_order = self._trading.submit_order(LimitOrderRequest(
                symbol=pos["contract_symbol"],
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
                limit_price=sell_target,
            ))

            self._state = "holding"
            self._position.update({
                "fill_id": fill_id,
                "entry_price": fill_price,
                "sell_order_id": str(sell_order.id),
                "sell_submitted_at": time.time(),
                "sell_target": sell_target,
                "stop_price": stop_price,
            })
            logger.info(
                f"Sell posted: {pos['contract_symbol']} @ ${sell_target:.2f} "
                f"(+${PROFIT_TARGET:.2f}) stop=${stop_price:.2f}"
            )

        except Exception as e:
            logger.error(f"Sell submit failed: {e} — flattening")
            self._flatten("sell_failed", fill_id)

    # ── HOLDING: monitor for profit/stop/TTL ─────────────────────────────────

    def _handle_holding(self):
        """Check sell fill, stop loss, and TTL."""
        pos = self._position

        # Check sell order status
        try:
            order = self._trading.get_order_by_id(pos["sell_order_id"])
        except Exception as e:
            logger.error(f"Sell check failed: {e}")
            return

        if order.status == OrderStatus.FILLED:
            fill_price = float(order.filled_avg_price or pos["sell_target"])
            pnl = (fill_price - pos["entry_price"]) * CONTRACTS_PER_TRADE * 100
            logger.info(
                f"PROFIT: {pos['contract_symbol']} {pos['direction']} "
                f"buy=${pos['entry_price']:.2f} sell=${fill_price:.2f} "
                f"P&L=${pnl:+.2f}"
            )
            self._close_position(fill_price, "profit_target", pnl)
            return

        if order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED, OrderStatus.REJECTED):
            logger.warning(f"Sell {order.status.name} — flattening")
            self._cancel_and_flatten("sell_rejected")
            return

        # Stop loss check
        quote = self._refresh_quote(pos["contract_symbol"])
        if quote:
            bid = quote[0]
            if bid <= pos["stop_price"]:
                logger.warning(
                    f"STOP: {pos['contract_symbol']} bid=${bid:.2f} "
                    f"<= stop=${pos['stop_price']:.2f}"
                )
                self._cancel_and_flatten("stop_loss")
                return

        # TTL check
        held = time.time() - pos["sell_submitted_at"]
        if held > HOLD_TTL_SECONDS:
            logger.info(
                f"TTL ({HOLD_TTL_SECONDS}s): {pos['contract_symbol']} — flattening"
            )
            self._cancel_and_flatten("ttl_flatten")

    # ── Exit helpers ─────────────────────────────────────────────────────────

    def _cancel_and_flatten(self, reason: str):
        """Cancel sell order, check for race fill, then market flatten."""
        pos = self._position

        try:
            self._trading.cancel_order_by_id(pos["sell_order_id"])
        except Exception:
            pass

        # Race check
        time.sleep(0.3)
        try:
            final = self._trading.get_order_by_id(pos["sell_order_id"])
            if final.status == OrderStatus.FILLED:
                fill_price = float(final.filled_avg_price or pos["sell_target"])
                pnl = (fill_price - pos["entry_price"]) * CONTRACTS_PER_TRADE * 100
                logger.info(f"Sell filled during cancel @ ${fill_price:.2f} P&L=${pnl:+.2f}")
                self._close_position(fill_price, "profit_target", pnl)
                return
        except Exception:
            pass

        self._flatten(reason, pos.get("fill_id"))

    def _flatten(self, reason: str, fill_id: Optional[str] = None):
        """Market sell to exit."""
        pos = self._position
        fill_id = fill_id or pos.get("fill_id")

        if self._dry_run:
            self._reset_to_idle()
            return

        flatten_price = None
        try:
            order = self._trading.submit_order(MarketOrderRequest(
                symbol=pos["contract_symbol"],
                qty=CONTRACTS_PER_TRADE,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
            ))
            logger.info(f"Flatten: {pos['contract_symbol']} MARKET SELL")

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
            logger.error(f"Flatten failed: {e}")

        pnl = None
        if flatten_price and "entry_price" in pos:
            pnl = (flatten_price - pos["entry_price"]) * CONTRACTS_PER_TRADE * 100
            logger.info(f"Flatten filled @ ${flatten_price:.2f} P&L=${pnl:+.2f}")

        self._close_position(flatten_price, reason, pnl)

    def _close_position(self, close_price: Optional[float], reason: str, pnl: Optional[float] = None):
        """Close in position manager and update stats."""
        pos = self._position
        fill_id = pos.get("fill_id")

        if fill_id:
            underlying_px = self._momentum.spy_price
            self._positions.close_position(
                fill_id=fill_id,
                close_price=close_price,
                close_reason=reason,
                underlying_price_close=underlying_px,
            )

        self._trades += 1
        if pnl and pnl > 0:
            self._wins += 1
        if pnl:
            self._pnl += pnl

        self._reset_to_idle()

    def _reset_to_idle(self):
        """Reset to idle state."""
        self._state = "idle"
        self._position = {}
        self._last_exit_time = time.time()

    # ── Shutdown ─────────────────────────────────────────────────────────────

    def cancel_all(self):
        """Cancel pending orders and flatten any open position."""
        if self._state == "buy_pending" and self._position.get("buy_order_id"):
            try:
                self._trading.cancel_order_by_id(self._position["buy_order_id"])
            except Exception:
                pass
            self._reset_to_idle()
        elif self._state == "holding":
            self._cancel_and_flatten("shutdown")

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _refresh_quote(self, sym: str) -> Optional[Tuple[float, float]]:
        """Get latest bid/ask for one contract."""
        try:
            req = OptionLatestQuoteRequest(symbol_or_symbols=sym)
            data = self._options.get_option_latest_quote(req)
            if sym in data:
                q = data[sym]
                bid = float(q.bid_price or 0)
                ask = float(q.ask_price or 0)
                if bid > 0 and ask > bid:
                    self._quotes[sym] = (bid, ask)
                    self._risk.data_fresh.update(sym)
                    return bid, ask
        except Exception:
            pass
        return None

    def _get_account_balance(self) -> float:
        try:
            return float(self._trading.get_account().equity)
        except Exception:
            return 50000.0

    def session_stats(self) -> dict:
        win_rate = (self._wins / self._trades * 100) if self._trades > 0 else 0
        return {
            "trades": self._trades,
            "wins": self._wins,
            "win_rate": win_rate,
            "pnl": round(self._pnl, 2),
            "state": self._state,
            "spy_price": self._momentum.spy_price,
            "bars_tracked": self._momentum.bar_count,
        }


# ── Engine orchestrator ──────────────────────────────────────────────────────

class Engine:
    """Top-level orchestrator."""

    def __init__(self, dry_run: bool = False):
        self._dry_run = dry_run

        logger.info(f"{'=' * 60}")
        logger.info(f"  Launch Control MM v3 — 1DTE Gamma Scalper")
        logger.info(f"  Mode: {'DRY RUN' if dry_run else 'PAPER TRADING'}")
        logger.info(f"  Universe: {UNIVERSE}")
        logger.info(f"  Contracts: {CONTRACTS_PER_TRADE}")
        logger.info(f"  Profit target: ${PROFIT_TARGET:.2f}/contract")
        logger.info(f"  Stop loss: ${STOP_LOSS:.2f}/contract")
        logger.info(f"  Hold TTL: {HOLD_TTL_SECONDS}s")
        logger.info(f"  Momentum: {MOMENTUM_BARS} consecutive bars")
        logger.info(f"  Cycle: {CYCLE_SECONDS}s")
        logger.info(f"{'=' * 60}")

        # Core components
        self._fill_logger = FillLogger()
        self._risk = RiskManager()
        self._positions = PositionManager(self._fill_logger, self._risk)
        self._scanner = ZeroDTEScanner()

        # Alpaca clients
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

        # Scalper
        self._scalper = GammaScalper(
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
        """Start engine."""
        self._running = True

        # Clean up from prior sessions
        try:
            self._trading.cancel_orders()
            logger.info("Cancelled all open orders on startup")
        except Exception as e:
            logger.warning(f"Cancel orders: {e}")

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

        last_scan = time.time()

        while self._running:
            et = datetime.now(pytz.timezone("America/New_York"))

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

            # Rescan ATM strikes periodically
            now = time.time()
            if now - last_scan >= RESCAN_INTERVAL:
                self._run_scan()
                last_scan = now

            if self._risk.kill_switch.is_active():
                logger.warning("Kill switch active. Halted.")
                time.sleep(60)
                continue

            try:
                self._scalper.run_cycle()
            except Exception as e:
                logger.error(f"Cycle error: {e}", exc_info=True)

            time.sleep(CYCLE_SECONDS)

    def _run_scan(self):
        """Scan for 1DTE ATM strikes."""
        try:
            strikes = self._scanner.run()
            if strikes:
                self._scalper.set_watchlist(strikes)
            else:
                logger.warning("Scan: no 1DTE strikes found")
        except Exception as e:
            logger.error(f"Scan failed: {e}", exc_info=True)

    def _heartbeat_loop(self):
        while self._running:
            positions = self._positions.list_positions()
            write_heartbeat(positions)
            time.sleep(10)

    def _status_loop(self):
        while self._running:
            time.sleep(60)
            stats = self._scalper.session_stats()
            logger.info(
                f"\nSTATUS | Trades: {stats['trades']} | "
                f"Wins: {stats['wins']} ({stats['win_rate']:.0f}%) | "
                f"P&L: ${stats['pnl']:+,.2f} | "
                f"State: {stats['state']} | "
                f"SPY: ${stats['spy_price']:.2f} | "
                f"Bars: {stats['bars_tracked']}"
            )

    def _shutdown(self, signum, frame):
        logger.info("Shutdown signal received.")
        self._running = False
        self._scalper.cancel_all()
        self._fill_logger.print_summary()
        sys.exit(0)


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch Control MM v3 — 1DTE Gamma Scalper")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        logger.critical("ALPACA_API_KEY and ALPACA_API_SECRET required (data)")
        sys.exit(1)
    if not ALPACA_PAPER_API_KEY or not ALPACA_PAPER_API_SECRET:
        logger.critical("ALPACA_PAPER_API_KEY and ALPACA_PAPER_API_SECRET required (trading)")
        sys.exit(1)

    # Verify connections
    try:
        paper = TradingClient(
            api_key=ALPACA_PAPER_API_KEY, secret_key=ALPACA_PAPER_API_SECRET, paper=True,
        )
        acct = paper.get_account()
        logger.info(f"Paper account: {acct.id} | balance: ${float(acct.equity):,.2f}")
    except Exception as e:
        logger.critical(f"Paper account connection failed: {e}")
        sys.exit(1)

    try:
        data_client = StockHistoricalDataClient(
            api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET,
        )
        q = data_client.get_stock_latest_quote(StockLatestQuoteRequest(symbol_or_symbols="SPY"))
        spy_mid = (float(q["SPY"].bid_price) + float(q["SPY"].ask_price)) / 2
        logger.info(f"Data API verified: SPY=${spy_mid:.2f}")
    except Exception as e:
        logger.critical(f"Data API connection failed: {e}")
        sys.exit(1)

    engine = Engine(dry_run=args.dry_run)
    engine.start()
