"""
Launch Control MM — Position Manager
Tracks every open position. Enforces TTL cancellation.
Calculates realized P&L including modeled slippage.
Feeds fill data to the logger.
"""

import uuid
import logging
import threading
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, Callable
from fill_logger import FillLogger, FillEvent
from risk_controls import RiskManager
from config import (
    TTL_SECONDS, CONTRACTS_PER_TRADE,
    FEE_PER_LEG_OPEN, FEE_PER_LEG_CLOSE
)

logger = logging.getLogger("positions")


@dataclass
class OpenPosition:
    """State of one open round-trip attempt."""

    fill_id:              str
    symbol:               str
    contract_symbol:      str
    strike:               float
    expiry:               str
    option_type:          str
    dte_at_entry:         int
    contracts:            int

    # Market at entry
    underlying_price_entry: float
    bid_at_entry:         float
    ask_at_entry:         float
    raw_spread:           float
    iv_at_entry:          float
    delta_at_entry:       float
    otm_pct:              float

    # Our quote
    our_bid:              float
    our_ask:              float
    capture_target:       float

    # Tape state at entry
    tape_bid_prints:      int
    tape_ask_prints:      int

    # First fill
    open_side:            str       # "bid_hit" or "ask_lifted"
    open_price:           float
    open_time:            datetime

    # TTL
    ttl_deadline:         datetime

    # Alpaca order IDs
    bid_order_id:         Optional[str] = None
    ask_order_id:         Optional[str] = None

    # Underlying price tracking (for slippage calculation)
    underlying_price_close: Optional[float] = None


class PositionManager:
    """
    Manages the lifecycle of all open positions.

    The critical path:
      scanner identifies strike →
      tape confirms →
      quote submitted →
      FIRST FILL arrives (open_position called) →
      position tracked with TTL →
      SECOND FILL or TTL expiry →
      position closed, fill logged
    """

    def __init__(self, fill_logger: FillLogger, risk_manager: RiskManager):
        self._logger   = fill_logger
        self._risk     = risk_manager
        self._positions: dict[str, OpenPosition] = {}
        self._lock     = threading.Lock()
        self._cancel_callbacks: list[Callable] = []

    # ── Opening a position ────────────────────────────────────────────────────

    def open_position(
        self,
        *,
        symbol: str,
        contract_symbol: str,
        strike: float,
        expiry: str,
        option_type: str,
        dte_at_entry: int,
        underlying_price_entry: float,
        bid_at_entry: float,
        ask_at_entry: float,
        iv_at_entry: float,
        delta_at_entry: float,
        otm_pct: float,
        our_bid: float,
        our_ask: float,
        capture_target: float,
        tape_bid_prints: int,
        tape_ask_prints: int,
        open_side: str,
        open_price: float,
        bid_order_id: Optional[str] = None,
        ask_order_id: Optional[str] = None,
    ) -> str:
        """
        Record the first fill. Returns fill_id.
        Starts the TTL countdown.
        """
        fill_id   = str(uuid.uuid4())[:8]
        now       = datetime.now(timezone.utc)
        ttl_deadline = datetime.fromtimestamp(
            now.timestamp() + TTL_SECONDS, tz=timezone.utc
        )

        pos = OpenPosition(
            fill_id=fill_id,
            symbol=symbol,
            contract_symbol=contract_symbol,
            strike=strike,
            expiry=expiry,
            option_type=option_type,
            dte_at_entry=dte_at_entry,
            contracts=CONTRACTS_PER_TRADE,
            underlying_price_entry=underlying_price_entry,
            bid_at_entry=bid_at_entry,
            ask_at_entry=ask_at_entry,
            raw_spread=ask_at_entry - bid_at_entry,
            iv_at_entry=iv_at_entry,
            delta_at_entry=delta_at_entry,
            otm_pct=otm_pct,
            our_bid=our_bid,
            our_ask=our_ask,
            capture_target=capture_target,
            tape_bid_prints=tape_bid_prints,
            tape_ask_prints=tape_ask_prints,
            open_side=open_side,
            open_price=open_price,
            open_time=now,
            ttl_deadline=ttl_deadline,
            bid_order_id=bid_order_id,
            ask_order_id=ask_order_id,
        )

        with self._lock:
            self._positions[fill_id] = pos

        self._risk.positions.opened()
        logger.info(
            f"Position opened: {fill_id} | {contract_symbol} | "
            f"{open_side} @ {open_price:.2f} | TTL {TTL_SECONDS}s"
        )
        return fill_id

    # ── Closing a position ────────────────────────────────────────────────────

    def close_position(
        self,
        fill_id: str,
        close_price: Optional[float],
        close_reason: str,
        underlying_price_close: Optional[float] = None,
    ) -> Optional[FillEvent]:
        """
        Close a position and log the fill.
        Returns the FillEvent or None if position not found.
        """
        with self._lock:
            pos = self._positions.pop(fill_id, None)

        if pos is None:
            logger.warning(f"close_position: {fill_id} not found")
            return None

        self._risk.positions.closed()
        now = datetime.now(timezone.utc)

        # ── P&L calculation ───────────────────────────────────────────────────
        hold_seconds = (now - pos.open_time).total_seconds()

        if close_price is not None:
            # Real fill price — either natural_fill or ttl_flatten market order
            if pos.open_side == "bid_hit":
                # We bought at open_price, selling at close_price
                gross = (close_price - pos.open_price) * pos.contracts * 100
            else:
                # We sold at open_price, buying back at close_price
                gross = (pos.open_price - close_price) * pos.contracts * 100

            # Slippage: delta x underlying move x contracts x 100
            underlying_move = 0.0
            if underlying_price_close and pos.underlying_price_entry:
                underlying_move = abs(
                    underlying_price_close - pos.underlying_price_entry
                )
                slippage = abs(pos.delta_at_entry) * underlying_move * pos.contracts * 100
            else:
                slippage = abs(pos.delta_at_entry) * 0.15 * pos.contracts * 100

            fee_open  = FEE_PER_LEG_OPEN  * pos.contracts
            fee_close = FEE_PER_LEG_CLOSE * pos.contracts
            net_pnl   = gross - slippage - fee_open - fee_close
            win       = net_pnl > 0

            # Adverse selection detection
            adverse = False
            if underlying_price_close and pos.underlying_price_entry:
                if pos.open_side == "bid_hit":
                    adverse = (
                        underlying_price_close < pos.underlying_price_entry * 0.997
                    )
                else:
                    adverse = (
                        underlying_price_close > pos.underlying_price_entry * 1.003
                    )

        else:
            # No fill price (kill switch, error) — model as loss
            gross     = 0.0
            slippage  = abs(pos.delta_at_entry) * 0.20 * pos.contracts * 100
            fee_open  = FEE_PER_LEG_OPEN  * pos.contracts
            fee_close = FEE_PER_LEG_CLOSE * pos.contracts
            net_pnl   = -(slippage + fee_open + fee_close)
            win       = False
            adverse   = False
            underlying_move = 0.0

        fill = FillEvent(
            fill_id=pos.fill_id,
            symbol=pos.symbol,
            contract_symbol=pos.contract_symbol,
            strike=pos.strike,
            expiry=pos.expiry,
            option_type=pos.option_type,
            dte_at_entry=pos.dte_at_entry,
            underlying_price_entry=pos.underlying_price_entry,
            bid_at_entry=pos.bid_at_entry,
            ask_at_entry=pos.ask_at_entry,
            raw_spread=pos.raw_spread,
            iv_at_entry=pos.iv_at_entry,
            delta_at_entry=pos.delta_at_entry,
            otm_pct=pos.otm_pct,
            our_bid=pos.our_bid,
            our_ask=pos.our_ask,
            capture_target=pos.capture_target,
            open_side=pos.open_side,
            open_price=pos.open_price,
            open_time=pos.open_time.isoformat(),
            open_contracts=pos.contracts,
            close_price=close_price,
            close_time=now.isoformat(),
            close_reason=close_reason,
            hold_seconds=round(hold_seconds, 1),
            gross_capture=round(gross, 2),
            fee_open=round(fee_open, 2),
            fee_close=round(fee_close, 2),
            slippage=round(slippage, 2),
            net_pnl=round(net_pnl, 2),
            win=win,
            tape_bid_prints=pos.tape_bid_prints,
            tape_ask_prints=pos.tape_ask_prints,
            tape_confirmed=pos.tape_bid_prints >= 3 and pos.tape_ask_prints >= 3,
            adverse_selection=adverse,
            underlying_move_during_hold=round(underlying_move, 4),
        )

        self._logger.log(fill)
        self._risk.update_pnl(net_pnl)

        status = "WIN" if win else "LOSS"
        logger.info(
            f"Position closed: {fill_id} | {close_reason} | "
            f"{status} ${net_pnl:.2f} | hold {hold_seconds:.0f}s"
        )
        return fill

    # ── TTL enforcement ───────────────────────────────────────────────────────

    def check_ttl_expirations(
        self,
        cancel_callback: Callable[[str, Optional[str], Optional[str]], Optional[float]],
        get_underlying_price: Callable[[str], Optional[float]],
    ) -> list[str]:
        """
        Check all open positions for TTL expiration.
        Fires cancel_callback(fill_id, bid_order_id, ask_order_id) which cancels
        the unfilled leg and submits a market order to flatten the filled leg.
        Returns list of fill_ids that were TTL-closed.
        Call this on a tight loop (every 1-2 seconds).
        """
        now     = datetime.now(timezone.utc)
        expired = []

        with self._lock:
            to_expire = [
                fill_id for fill_id, pos in self._positions.items()
                if now >= pos.ttl_deadline
            ]

        for fill_id in to_expire:
            with self._lock:
                pos = self._positions.get(fill_id)
                if pos is None:
                    continue

            logger.warning(
                f"TTL EXPIRED: {fill_id} | {pos.contract_symbol} | "
                f"held {(now - pos.open_time).total_seconds():.0f}s"
            )

            # cancel_and_flatten returns the market fill price (or None)
            flatten_price = cancel_callback(fill_id, pos.bid_order_id, pos.ask_order_id)

            underlying_price = get_underlying_price(pos.symbol)
            self.close_position(
                fill_id=fill_id,
                close_price=flatten_price,
                close_reason="ttl_flatten",
                underlying_price_close=underlying_price,
            )
            expired.append(fill_id)

        return expired

    # ── Accessors ─────────────────────────────────────────────────────────────

    @property
    def open_count(self) -> int:
        return len(self._positions)

    def get_unrealized_pnl(self, current_quotes: dict[str, tuple[float, float]]) -> float:
        """
        Estimate current unrealized P&L across all open positions.
        current_quotes: {contract_symbol: (bid, ask)}
        """
        total = 0.0
        with self._lock:
            for pos in self._positions.values():
                quote = current_quotes.get(pos.contract_symbol)
                if quote:
                    mid = (quote[0] + quote[1]) / 2
                    if pos.open_side == "bid_hit":
                        pnl = (mid - pos.open_price) * pos.contracts * 100
                    else:
                        pnl = (pos.open_price - mid) * pos.contracts * 100
                    total += pnl
        return total

    def list_positions(self) -> list[dict]:
        """Return summary of all open positions."""
        now = datetime.now(timezone.utc)
        with self._lock:
            return [
                {
                    "fill_id":   p.fill_id,
                    "contract":  p.contract_symbol,
                    "side":      p.open_side,
                    "price":     p.open_price,
                    "held_sec":  round((now - p.open_time).total_seconds()),
                    "ttl_sec":   round((p.ttl_deadline - now).total_seconds()),
                }
                for p in self._positions.values()
            ]
