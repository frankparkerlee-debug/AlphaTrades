"""
Order execution for Kalshi weather — Last Mile strategy.
Buys near-certain contracts and holds to settlement ($1.00 payout).
Only exits early if bid hits $0.97+ (lock in profit) or contract drops
below $0.50 (rare model failure — cut loss).
"""

import logging
from datetime import datetime
from dataclasses import dataclass

from config.settings import (
    STARTING_CAPITAL, MAX_POSITION_PCT, MAX_CONTRACTS_PER_BUCKET,
    MAX_OPEN_POSITIONS, DAILY_LOSS_LIMIT_PCT, EARLY_EXIT_PRICE,
    STOP_LOSS_PCT, DRY_RUN,
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
    threshold: float
    side: str           # "yes"
    contracts: int
    entry_price: float  # avg cost per contract
    entry_time: datetime
    forecast_offset: float = 0.0  # how far forecast was above threshold
    order_id: str = ""
    status: str = "open"  # open, closed, settled
    exit_price: float = 0.0
    exit_time: datetime = None
    pnl: float = 0.0

    @property
    def cost(self) -> float:
        return self.contracts * self.entry_price

    @property
    def hold_minutes(self) -> float:
        return (datetime.now() - self.entry_time).total_seconds() / 60


class Executor:
    """Manages order execution for Last Mile strategy."""

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
        Size for Last Mile: contracts are expensive ($0.80-$0.95 each).
        Max 15% of capital per position, capped at 25 contracts (fill cap).
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
        """Place a buy order for a Last Mile signal."""
        side = getattr(signal, "side", "yes")

        # Dedup: skip if we already have an open position on this ticker+side
        for existing in self.open_positions:
            if existing.ticker == signal.ticker and existing.side == side:
                log.debug(
                    f"Skip {signal.ticker} {side}: already holding "
                    f"{existing.contracts}x @ ${existing.entry_price:.2f}"
                )
                return None

        count = self.size_order(signal)
        if count == 0:
            log.warning(f"Cannot size order for {signal.ticker}")
            return None

        if DRY_RUN:
            log.info(
                f"[DRY_RUN] Would BUY {count}x {signal.ticker} {side} @ "
                f"${signal.market_price:.2f} (cost=${count * signal.market_price:.2f})"
            )
            order = {"order_id": f"DRY_{signal.ticker}_{int(datetime.now().timestamp())}"}
        else:
            result = self.kalshi.place_order(
                ticker=signal.ticker,
                side=side,
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
            side=side,
            contracts=count,
            entry_price=signal.market_price,
            entry_time=datetime.now(),
            forecast_offset=signal.forecast_offset,
            order_id=order.get("order_id", ""),
        )
        self.positions.append(pos)

        expected_profit = count * (1.00 - signal.market_price)
        log.info(
            f"ENTERED: {count}x {signal.ticker} @ ${signal.market_price:.2f} "
            f"(cost=${pos.cost:.2f}, expected profit=${expected_profit:.2f})"
        )
        return pos

    def check_exits(self):
        """
        Last Mile exit logic:
        1. EARLY EXIT: bid >= $0.97 — lock in profit without waiting for settlement
        2. STOP LOSS: bid < $0.50 — model was wrong, cut losses (rare at 4F+ offset)
        3. SETTLED: contract resolved — Kalshi auto-pays $1.00, mark position closed

        Most positions will NOT exit early — they settle at $1.00 automatically.
        """
        for pos in self.open_positions:
            prices = self.kalshi.get_best_prices(pos.ticker)
            if not prices:
                # Check if market has settled (no orderbook = likely resolved)
                if pos.hold_minutes > 480:  # 8+ hours, likely settled
                    self._mark_settled(pos)
                continue

            # For YES positions: current_bid = YES bid
            # For NO positions: current_bid = NO bid = 1 - YES ask
            if pos.side == "no":
                current_bid = round(1.0 - prices["yes_ask"], 4)
            else:
                current_bid = prices["yes_bid"]

            # 1. Early exit: lock in profit at $0.97+
            if current_bid >= EARLY_EXIT_PRICE:
                self._exit_position(pos, current_bid, "EARLY_EXIT")
                continue

            # 2. Stop loss: bid drops below stop_loss_pct of entry price
            stop_price = pos.entry_price * STOP_LOSS_PCT
            if current_bid < stop_price and pos.hold_minutes > 30:
                self._exit_position(pos, current_bid, "STOP_LOSS")
                continue

            # 3. Normal: hold to settlement (no action needed)
            log.debug(
                f"  {pos.ticker} ({pos.side}): bid=${current_bid:.2f} "
                f"held {pos.hold_minutes:.0f}min — holding to settlement"
            )

    def _exit_position(self, pos: Position, exit_price: float, reason: str):
        """Sell a position early."""
        if DRY_RUN:
            log.info(
                f"[DRY_RUN] Would SELL {pos.contracts}x {pos.ticker} {pos.side} "
                f"@ ${exit_price:.2f} ({reason})"
            )
        else:
            self.kalshi.place_order(
                ticker=pos.ticker,
                side=pos.side,
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

        self._check_daily_limit()

    def _mark_settled(self, pos: Position):
        """Mark a position as settled (Kalshi auto-paid $1.00)."""
        pos.status = "settled"
        pos.exit_price = 1.00
        pos.exit_time = datetime.now()
        pos.pnl = (1.00 - pos.entry_price) * pos.contracts
        self.daily_pnl += pos.pnl
        self.closed_positions.append(pos)

        log.info(
            f"SETTLED: {pos.ticker} | "
            f"${pos.entry_price:.2f} -> $1.00 | "
            f"P&L: ${pos.pnl:+.2f} | held {pos.hold_minutes:.0f}min"
        )

    def _check_daily_limit(self):
        """Halt if daily loss limit is breached."""
        if self.daily_pnl <= -(self.capital * DAILY_LOSS_LIMIT_PCT):
            self.halted = True
            log.error(f"DAILY LOSS LIMIT HIT: ${self.daily_pnl:.2f} -- halting")

    def reset_daily(self):
        """Reset daily P&L (call at start of trading day)."""
        self.daily_pnl = 0.0
        self.halted = False
        balance = self.kalshi.get_balance()
        if balance is not None:
            self.capital = balance
            log.info(f"Capital updated: ${self.capital:.2f}")

    def get_stats(self) -> dict:
        """Return current trading statistics."""
        closed = self.closed_positions
        wins = [p for p in closed if p.pnl > 0]
        losses = [p for p in closed if p.pnl <= 0]
        settled = [p for p in closed if p.status == "settled"]

        return {
            "capital": self.capital,
            "deployed": self.total_deployed,
            "available": self.available_capital,
            "open_positions": len(self.open_positions),
            "total_trades": len(closed),
            "wins": len(wins),
            "losses": len(losses),
            "settled": len(settled),
            "win_rate": len(wins) / max(len(closed), 1),
            "daily_pnl": self.daily_pnl,
            "total_pnl": sum(p.pnl for p in closed),
            "avg_hold_min": (
                sum(p.hold_minutes for p in closed) / max(len(closed), 1)
            ),
            "halted": self.halted,
        }
