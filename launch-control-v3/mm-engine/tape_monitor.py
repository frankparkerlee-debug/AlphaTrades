"""
Launch Control MM — Tape Monitor
Watches real-time option trade prints via Alpaca websocket.
Confirms two-way flow (buyers AND sellers active) before allowing quotes.
This is the single biggest driver of fill quality — only quote into active markets.
"""

import asyncio
import logging
import threading
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Callable, Optional
from alpaca.data.live.option import OptionDataStream
from alpaca.data.models import Trade
from config import (
    ALPACA_API_KEY, ALPACA_API_SECRET,
    TAPE_LOOKBACK_SECONDS, TAPE_MIN_PRINTS
)

logger = logging.getLogger("tape")


class TapeState:
    """
    Rolling window of recent prints for one contract.
    Tracks bid-side prints (at or below mid) and ask-side prints (at or above mid).
    """

    def __init__(self, lookback_seconds: int = TAPE_LOOKBACK_SECONDS):
        self._lookback  = lookback_seconds
        self._bid_prints = deque()   # (timestamp, price) — trades at/below mid
        self._ask_prints = deque()   # (timestamp, price) — trades at/above mid
        self._lock       = threading.Lock()
        self.last_mid    = None
        self.last_bid    = None
        self.last_ask    = None

    def update_quote(self, bid: float, ask: float):
        """Update the current quote for this contract."""
        with self._lock:
            self.last_bid = bid
            self.last_ask = ask
            self.last_mid = (bid + ask) / 2

    def record_print(self, price: float, timestamp: datetime):
        """Record a trade print and classify as bid-side or ask-side."""
        with self._lock:
            if self.last_mid is None:
                return

            entry = (timestamp.timestamp(), price)

            if price <= self.last_mid:
                self._bid_prints.append(entry)
            else:
                self._ask_prints.append(entry)

            self._prune()

    def _prune(self):
        """Remove prints older than lookback window. Call with lock held."""
        cutoff = datetime.now(timezone.utc).timestamp() - self._lookback
        while self._bid_prints and self._bid_prints[0][0] < cutoff:
            self._bid_prints.popleft()
        while self._ask_prints and self._ask_prints[0][0] < cutoff:
            self._ask_prints.popleft()

    def is_confirmed(self, min_prints: int = TAPE_MIN_PRINTS) -> bool:
        """
        Returns True if two-way flow is confirmed.
        Requires >= min_prints on BOTH bid AND ask side in the lookback window.
        """
        with self._lock:
            self._prune()
            bid_count = len(self._bid_prints)
            ask_count = len(self._ask_prints)
            confirmed = bid_count >= min_prints and ask_count >= min_prints
            if confirmed:
                logger.debug(
                    f"Tape confirmed: {bid_count} bid prints, "
                    f"{ask_count} ask prints"
                )
            return confirmed

    def counts(self) -> tuple[int, int]:
        """Returns (bid_prints, ask_prints) in the lookback window."""
        with self._lock:
            self._prune()
            return len(self._bid_prints), len(self._ask_prints)


class TapeMonitor:
    """
    Manages tape state across all watched contracts via websocket stream.
    """

    def __init__(self):
        self._states:  dict[str, TapeState] = defaultdict(TapeState)
        self._watched: set[str] = set()
        self._stream:  Optional[OptionDataStream] = None
        self._thread:  Optional[threading.Thread] = None
        self._loop:    Optional[asyncio.AbstractEventLoop] = None
        self._running  = False
        self._on_confirmation_callbacks: list[Callable] = []

    def watch(self, contract_symbols: list[str]):
        """Add contracts to the watch list."""
        new = set(contract_symbols) - self._watched
        if new:
            self._watched.update(new)
            logger.info(f"Tape: watching {len(self._watched)} contracts")
            if self._running:
                self._subscribe(list(new))

    def update_quote(self, contract_symbol: str, bid: float, ask: float):
        """
        Feed current quote into the tape state.
        Call this whenever a new quote arrives for a contract.
        """
        self._states[contract_symbol].update_quote(bid, ask)

    def is_confirmed(self, contract_symbol: str) -> bool:
        """Check if two-way flow is confirmed for this contract."""
        return self._states[contract_symbol].is_confirmed()

    def counts(self, contract_symbol: str) -> tuple[int, int]:
        """Get (bid_prints, ask_prints) for this contract."""
        return self._states[contract_symbol].counts()

    def start(self):
        """Start the websocket stream in a background thread."""
        if self._running:
            return
        self._running = True
        self._thread  = threading.Thread(
            target=self._run_stream,
            name="tape-monitor",
            daemon=True
        )
        self._thread.start()
        logger.info("Tape monitor started.")

    def stop(self):
        """Stop the websocket stream."""
        self._running = False
        if self._stream:
            try:
                asyncio.run_coroutine_threadsafe(
                    self._stream.stop_ws(), self._loop
                )
            except Exception:
                pass
        logger.info("Tape monitor stopped.")

    def _run_stream(self):
        """Run the asyncio event loop in the background thread."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._stream_loop())
        except Exception as e:
            logger.error(f"Tape stream error: {e}")
        finally:
            self._loop.close()

    async def _stream_loop(self):
        """Connect to Alpaca option data stream and process trades."""
        self._stream = OptionDataStream(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_API_SECRET,
        )

        async def on_trade(trade: Trade):
            try:
                sym   = trade.symbol
                price = float(trade.price)
                ts    = trade.timestamp

                self._states[sym].record_print(price, ts)

                # Check if this print confirmed the market
                if self._states[sym].is_confirmed():
                    for cb in self._on_confirmation_callbacks:
                        try:
                            cb(sym)
                        except Exception as e:
                            logger.error(f"Confirmation callback error: {e}")
            except Exception as e:
                logger.debug(f"Trade processing error: {e}")

        self._stream.subscribe_trades(on_trade, *list(self._watched))
        await self._stream._run_forever()

    def _subscribe(self, symbols: list[str]):
        """Subscribe to additional symbols on the running stream."""
        if self._stream and self._loop:
            asyncio.run_coroutine_threadsafe(
                self._stream.subscribe_trades(
                    lambda t: None,   # handler already registered
                    *symbols
                ),
                self._loop
            )

    def on_confirmation(self, callback: Callable[[str], None]):
        """Register a callback to fire when tape confirms for a contract."""
        self._on_confirmation_callbacks.append(callback)
