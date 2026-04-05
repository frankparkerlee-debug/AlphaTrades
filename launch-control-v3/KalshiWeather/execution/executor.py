"""
Order execution and position management for Kalshi weather trades.
Handles sizing, entry, monitoring, and exit.
"""

import logging
import time
from datetime import datetime
from dataclasses import dataclass, field

from config.settings import (
    STARTING_CAPITAL, MAX_POSITION_PCT, MAX_CONTRACTS_PER_BUCKET,
    MAX_OPEN_POSITIONS, DAILY_LOSS_LIMIT_PCT, TARGET_SELL_PRICE,
    MAX_HOLD_MINUTES,
)
from feeds.kalshi import KalshiClient
from strategy.signals import Signal

log = logging.getLogger("executor")


@dataclass
class Position:
    """An open position on Kalshi."""
    ticker: str
    city_code: str
    date: str
    threshold: int
    side: str           # "yes" or "no"
    contracts: int
    entry_price: float  # avg cost per contract
    entry_time: datetime
    order_id: str = ""
    status: str = "open"  # open, closed, expired
    exit_price: float = 0.0
    exit_time: datetime = None
    pnl: float = 0.0

    @property
    def cost(self) -> float:
        return self.contracts * self.entry_price

    @property
    def hold_minutes(self) -> float:
        return (datetime.now() - self.entry_time).total_seconds() / 60

    @property
    def current_pnl_at(self, current_price: float) -> float:
        return (current_price - self.entry_price) * self.contracts


class Executor:
    """Manages order execution, position tracking, and exits."""

    def __init__(self, kalshi: KalshiClient):
        self.kalshi = kalshi
        self.positions: list[Position] = []
        self.closed_positions: list[Position] = []
        self.daily_pnl = 0.0
        self.capital = STARTING_CAPITAL
        self.halted = False

    @property
    def open_positions(self) -> list[Position]:
        return [p for p in self.positions if p.status == "open"]

    @property
    def total_deployed(self) -> float:
        return sum(p.cost for p in self.open_positions)

    @property
    def available_capital(self) -> float:
        return self.capital - self.total_deployed

    def size_order(self, signal: Signal) -> int:
        """
        Determine contract count for a signal.
        Max 10% of capital per position, capped at MAX_CONTRACTS_PER_BUCKET.
        """
        if self.halted:
            return 0
        if len(self.open_positions) >= MAX_OPEN_POSITIONS:
            return 0

        max_spend = self.capital * MAX_POSITION_PCT
        available = self.available_capital
        budget = min(max_spend, available)

        if budget < signal.market_price:
            return 0

        count = int(budget / signal.market_price)
        count = min(count, MAX_CONTRACTS_PER_BUCKET)

        return count

    def enter(self, signal: Signal) -> Position | None:
        """Place a buy order for a signal."""
        count = self.size_order(signal)
        if count == 0:
            log.warning(f"Cannot size order for {signal.ticker}")
            return None

        result = self.kalshi.place_order(
            ticker=signal.ticker,
            side="yes",
            action="buy",
            count=count,
            price=signal.market_price,
        )

        if not result or "order" not in result:
            log.error(f"Order failed for {signal.ticker}")
            return None

        order = result["order"]
        pos = Position(
            ticker=signal.ticker,
            city_code=signal.city_code,
            date=signal.date,
            threshold=signal.threshold,
            side="yes",
            contracts=count,
            entry_price=signal.market_price,
            entry_time=datetime.now(),
            order_id=order.get("order_id", ""),
        )
        self.positions.append(pos)
        log.info(f"ENTERED: {count}x {signal.ticker} @ ${signal.market_price:.2f} (${pos.cost:.2f})")
        return pos

    def check_exits(self):
        """Check all open positions for exit conditions."""
        for pos in self.open_positions:
            prices = self.kalshi.get_best_prices(pos.ticker)
            if not prices:
                continue

            current_bid = prices["yes_bid"]
            hold_min = pos.hold_minutes

            exit_reason = None

            # 1. Target hit: market repriced to $0.40+
            if current_bid >= TARGET_SELL_PRICE:
                exit_reason = "TARGET"

            # 2. Time backstop
            elif hold_min >= MAX_HOLD_MINUTES:
                exit_reason = "TIME"

            # 3. Stop loss: if price drops to near zero (<$0.02)
            elif current_bid <= 0.02 and hold_min > 5:
                exit_reason = "STOP"

            if exit_reason:
                self._exit_position(pos, current_bid, exit_reason)

    def _exit_position(self, pos: Position, exit_price: float, reason: str):
        """Sell a position."""
        result = self.kalshi.place_order(
            ticker=pos.ticker,
            side="yes",
            action="sell",
            count=pos.contracts,
            price=exit_price,
        )

        pos.status = "closed"
        pos.exit_price = exit_price
        pos.exit_time = datetime.now()
        pos.pnl = (exit_price - pos.entry_price) * pos.contracts
        self.daily_pnl += pos.pnl
        self.closed_positions.append(pos)

        log.info(
            f"EXIT ({reason}): {pos.ticker} | "
            f"${pos.entry_price:.2f} -> ${exit_price:.2f} | "
            f"P&L: ${pos.pnl:+.2f} | held {pos.hold_minutes:.0f}min"
        )

        # Check daily loss limit
        if self.daily_pnl <= -(self.capital * DAILY_LOSS_LIMIT_PCT):
            self.halted = True
            log.error(f"DAILY LOSS LIMIT HIT: ${self.daily_pnl:.2f} — halting")

    def reset_daily(self):
        """Reset daily P&L (call at start of trading day)."""
        self.daily_pnl = 0.0
        self.halted = False
        # Update capital from Kalshi balance
        balance = self.kalshi.get_balance()
        if balance is not None:
            self.capital = balance
            log.info(f"Capital updated: ${self.capital:.2f}")

    def get_stats(self) -> dict:
        """Return current trading statistics."""
        closed = self.closed_positions
        wins = [p for p in closed if p.pnl > 0]
        losses = [p for p in closed if p.pnl <= 0]

        return {
            "capital": self.capital,
            "deployed": self.total_deployed,
            "available": self.available_capital,
            "open_positions": len(self.open_positions),
            "total_trades": len(closed),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": len(wins) / max(len(closed), 1),
            "daily_pnl": self.daily_pnl,
            "total_pnl": sum(p.pnl for p in closed),
            "avg_hold_min": (
                sum(p.hold_minutes for p in closed) / max(len(closed), 1)
            ),
            "halted": self.halted,
        }
