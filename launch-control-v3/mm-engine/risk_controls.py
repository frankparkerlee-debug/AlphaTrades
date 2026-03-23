"""
Launch Control MM — Risk Controls
Non-negotiable. These fire before any order is submitted.
If any control blocks an order, the reason is logged and the order is dropped.
"""

import time
import threading
import logging
from datetime import datetime, timezone
from collections import deque
from typing import Optional
from config import (
    MAX_OPS_PER_SECOND, KILL_SWITCH_THRESHOLD, PDT_FLOOR,
    PDT_ALERT_BUFFER, MAX_CONCURRENT_POSITIONS
)

logger = logging.getLogger("risk")


class OrderRateLimiter:
    """
    Hard limit: MAX_OPS_PER_SECOND order operations across all symbols.
    Uses a sliding window. Not configurable at runtime.
    Knight Capital lost $440M from a runaway loop. This prevents that.
    """

    def __init__(self, max_ops: int = MAX_OPS_PER_SECOND):
        self._max_ops  = max_ops
        self._window   = deque()   # timestamps of recent ops
        self._lock     = threading.Lock()
        self._blocked  = 0

    def allow(self) -> bool:
        """Returns True if the operation is allowed. Thread-safe."""
        now = time.monotonic()
        with self._lock:
            # Remove ops older than 1 second
            while self._window and now - self._window[0] > 1.0:
                self._window.popleft()

            if len(self._window) >= self._max_ops:
                self._blocked += 1
                logger.warning(
                    f"RATE LIMITER: {len(self._window)} ops in last second "
                    f"(max {self._max_ops}). Order BLOCKED. "
                    f"Total blocked: {self._blocked}"
                )
                return False

            self._window.append(now)
            return True

    @property
    def blocked_count(self) -> int:
        return self._blocked


class KillSwitch:
    """
    Portfolio-level kill switch.
    Fires when total unrealized P&L across all open positions
    drops below KILL_SWITCH_THRESHOLD.
    Once fired, requires manual reset — never auto-resets.
    """

    def __init__(self, threshold: float = KILL_SWITCH_THRESHOLD):
        self._threshold = threshold
        self._fired     = False
        self._fired_at  = None
        self._fired_pnl = None
        self._lock      = threading.Lock()

    def check(self, unrealized_pnl: float) -> bool:
        """
        Check current unrealized P&L.
        Returns True if kill switch is active (trading should stop).
        """
        with self._lock:
            if self._fired:
                return True

            if unrealized_pnl <= self._threshold:
                self._fired     = True
                self._fired_at  = datetime.now(timezone.utc).isoformat()
                self._fired_pnl = unrealized_pnl
                logger.critical(
                    f"KILL SWITCH FIRED: unrealized P&L ${unrealized_pnl:.2f} "
                    f"<= threshold ${self._threshold:.2f} at {self._fired_at}. "
                    f"ALL QUOTING HALTED. Manual reset required."
                )
                return True

            return False

    def is_active(self) -> bool:
        return self._fired

    def manual_reset(self, authorization_code: str) -> bool:
        """
        Reset requires explicit authorization code.
        Not callable from automated code — must be triggered by operator.
        """
        if authorization_code != "OPERATOR_CONFIRMS_RESET":
            logger.error("Kill switch reset attempted with invalid code.")
            return False

        with self._lock:
            logger.warning(
                f"KILL SWITCH MANUALLY RESET. Previous trigger: "
                f"${self._fired_pnl:.2f} at {self._fired_at}"
            )
            self._fired     = False
            self._fired_at  = None
            self._fired_pnl = None
            return True

    def status(self) -> dict:
        return {
            "active":    self._fired,
            "fired_at":  self._fired_at,
            "fired_pnl": self._fired_pnl,
            "threshold": self._threshold,
        }


class PDTGuard:
    """
    Pattern Day Trader floor protection.
    Halts all new position opens if account balance
    approaches the $25K PDT minimum.
    """

    def __init__(self, floor: float = PDT_FLOOR, buffer: float = PDT_ALERT_BUFFER):
        self._floor  = floor
        self._buffer = buffer
        self._halted = False

    def check(self, account_balance: float) -> bool:
        """
        Returns True if new positions are allowed.
        Returns False if balance is too close to PDT floor.
        """
        if account_balance < self._buffer:
            if not self._halted:
                self._halted = True
                logger.critical(
                    f"PDT GUARD: Balance ${account_balance:,.2f} < "
                    f"buffer ${self._buffer:,.2f}. "
                    f"No new positions. PDT floor is ${self._floor:,.2f}."
                )
            return False

        self._halted = False
        return True

    @property
    def is_halted(self) -> bool:
        return self._halted


class DataFreshnessCheck:
    """
    Validates that market data is fresh before allowing any quote.
    If data age exceeds threshold — cancel all open quotes.
    Stale data posting quotes at wrong prices is silent death.
    """

    def __init__(self, max_age_seconds: float = 10.0):
        self._max_age = max_age_seconds
        self._last_data_timestamps: dict[str, float] = {}
        self._lock = threading.Lock()

    def update(self, symbol: str) -> None:
        """Call this every time fresh data arrives for a symbol."""
        with self._lock:
            self._last_data_timestamps[symbol] = time.monotonic()

    def is_fresh(self, symbol: str) -> bool:
        """Returns True if data for this symbol is fresh enough to trade."""
        with self._lock:
            ts = self._last_data_timestamps.get(symbol)
            if ts is None:
                logger.warning(f"DATA FRESHNESS: No data ever received for {symbol}.")
                return False
            age = time.monotonic() - ts
            if age > self._max_age:
                logger.warning(
                    f"DATA FRESHNESS: {symbol} data is {age:.1f}s old "
                    f"(max {self._max_age}s). Quote BLOCKED."
                )
                return False
            return True

    def stale_symbols(self) -> list[str]:
        """Returns list of symbols with stale data."""
        now = time.monotonic()
        with self._lock:
            return [
                sym for sym, ts in self._last_data_timestamps.items()
                if now - ts > self._max_age
            ]


class PositionCounter:
    """Tracks concurrent open positions against the maximum limit."""

    def __init__(self, max_positions: int = MAX_CONCURRENT_POSITIONS):
        self._max  = max_positions
        self._open = 0
        self._lock = threading.Lock()

    def can_open(self) -> bool:
        with self._lock:
            return self._open < self._max

    def opened(self):
        with self._lock:
            self._open += 1
            logger.debug(f"Position opened. Open: {self._open}/{self._max}")

    def closed(self):
        with self._lock:
            self._open = max(0, self._open - 1)
            logger.debug(f"Position closed. Open: {self._open}/{self._max}")

    @property
    def count(self) -> int:
        return self._open

    @property
    def at_capacity(self) -> bool:
        return self._open >= self._max


class RiskManager:
    """
    Central risk manager — single point of truth for all controls.
    Every order submission must pass through check_pre_order().
    """

    def __init__(self):
        self.rate_limiter  = OrderRateLimiter()
        self.kill_switch   = KillSwitch()
        self.pdt_guard     = PDTGuard()
        self.data_fresh    = DataFreshnessCheck()
        self.positions     = PositionCounter()
        self._daily_pnl    = 0.0
        self._lock         = threading.Lock()

    def check_pre_order(
        self,
        symbol: str,
        account_balance: float,
        unrealized_pnl: float,
        is_opening: bool = True,
    ) -> tuple[bool, str]:
        """
        Run all pre-order checks in priority order.
        Returns (allowed: bool, reason: str).
        """
        # 1. Kill switch — highest priority
        if self.kill_switch.is_active():
            return False, "kill_switch_active"

        # 2. Order rate limit
        if not self.rate_limiter.allow():
            return False, "rate_limit"

        # 3. Data freshness
        if not self.data_fresh.is_fresh(symbol):
            return False, "stale_data"

        # For opening new positions only:
        if is_opening:
            # 4. PDT floor
            if not self.pdt_guard.check(account_balance):
                return False, "pdt_floor"

            # 5. Concurrent position limit
            if not self.positions.can_open():
                return False, "position_limit"

        # 6. Kill switch threshold check on current P&L
        if self.kill_switch.check(unrealized_pnl):
            return False, "kill_switch_fired"

        return True, "ok"

    def update_pnl(self, realized_pnl: float):
        """Update daily realized P&L."""
        with self._lock:
            self._daily_pnl += realized_pnl

    def status(self) -> dict:
        return {
            "kill_switch":      self.kill_switch.status(),
            "pdt_halted":       self.pdt_guard.is_halted,
            "open_positions":   self.positions.count,
            "max_positions":    self.positions._max,
            "rate_blocked":     self.rate_limiter.blocked_count,
            "stale_symbols":    self.data_fresh.stale_symbols(),
            "daily_pnl":        round(self._daily_pnl, 2),
        }
