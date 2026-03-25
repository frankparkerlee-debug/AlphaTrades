"""
Launch Control MM — 1DTE Scanner
Finds ATM options expiring TOMORROW on SPY for gamma scalping.
Uses 1DTE because Alpaca rejects opening positions on 0DTE contracts.
Runs every 2 minutes to track shifting ATM strikes.
"""

import re
import logging
from datetime import date, timedelta
from dataclasses import dataclass
from typing import Optional
from alpaca.data.historical.option import OptionHistoricalDataClient
from alpaca.data.requests import OptionChainRequest, OptionLatestQuoteRequest
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.requests import StockLatestQuoteRequest
from config import (
    ALPACA_API_KEY, ALPACA_API_SECRET, UNIVERSE, ATM_RANGE,
)

logger = logging.getLogger("scanner")


@dataclass
class ViableStrike:
    """A 0DTE strike ready for gamma scalping."""
    symbol:          str
    contract_symbol: str
    strike:          float
    expiry:          date
    dte:             int
    option_type:     str       # "call" or "put"
    underlying_price: float
    otm_pct:         float
    bid:             float
    ask:             float
    spread:          float
    mid:             float
    iv:              float
    delta:           float
    volume_est:      int
    our_bid:         float     # not used for scalping, kept for compat
    our_ask:         float
    capture_target:  float

    def __str__(self):
        return (
            f"{self.symbol} ${self.strike:.0f}{self.option_type[0].upper()} {self.dte}DTE | "
            f"bid=${self.bid:.2f} ask=${self.ask:.2f} spread=${self.spread:.2f} "
            f"delta={self.delta:.2f}"
        )


class ZeroDTEScanner:
    """
    Finds ATM 1DTE calls and puts for gamma scalping.
    Uses 1DTE because Alpaca rejects opening positions on 0DTE contracts.
    Returns ViableStrike objects sorted by proximity to ATM (closest strike first).
    """

    def __init__(self):
        self._option_client = OptionHistoricalDataClient(
            api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET,
        )
        self._stock_client = StockHistoricalDataClient(
            api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET,
        )

    @staticmethod
    def _next_expiry() -> date:
        """Next trading day expiry (1DTE). Skips weekends."""
        today = date.today()
        day = today.weekday()  # Mon=0 ... Fri=4
        if day == 4:      # Friday → Monday
            return today + timedelta(days=3)
        elif day == 5:    # Saturday → Monday
            return today + timedelta(days=2)
        elif day == 6:    # Sunday → Monday
            return today + timedelta(days=1)
        else:             # Mon-Thu → next day
            return today + timedelta(days=1)

    def run(self, **kwargs) -> list[ViableStrike]:
        """Scan universe for 1DTE ATM options."""
        logger.info(f"1DTE scan starting. Universe: {UNIVERSE}")
        viable = []

        for symbol in UNIVERSE:
            try:
                strikes = self._scan_symbol(symbol)
                viable.extend(strikes)
                logger.info(f"  {symbol}: {len(strikes)} 1DTE strikes found")
            except Exception as e:
                logger.error(f"  {symbol}: scan failed — {e}", exc_info=True)

        # Sort by strike proximity to underlying price (most ATM first)
        # Delta is unreliable (often 0.00), so use price distance
        viable.sort(key=lambda s: abs(s.strike - s.underlying_price))
        logger.info(f"1DTE scan complete: {len(viable)} viable strikes")
        return viable

    def _scan_symbol(self, symbol: str) -> list[ViableStrike]:
        """Find 1DTE ATM calls and puts for one symbol."""
        price = self._get_price(symbol)
        if not price:
            logger.warning(f"{symbol}: could not get price")
            return []

        atm = round(price)
        expiry = self._next_expiry()
        expiry_str = expiry.strftime("%Y-%m-%d")
        dte = (expiry - date.today()).days

        logger.info(
            f"{symbol}: price=${price:.2f} ATM=${atm} "
            f"range=${atm - ATM_RANGE:.0f}-${atm + ATM_RANGE:.0f} "
            f"expiry={expiry_str} (DTE={dte})"
        )

        viable = []
        for opt_type in ["call", "put"]:
            try:
                chain = self._option_client.get_option_chain(OptionChainRequest(
                    underlying_symbol=symbol,
                    type=opt_type,
                    strike_price_gte=str(round(atm - ATM_RANGE, 2)),
                    strike_price_lte=str(round(atm + ATM_RANGE, 2)),
                    expiration_date_gte=expiry_str,
                    expiration_date_lte=expiry_str,
                ))

                if not chain:
                    logger.info(f"  {symbol} {opt_type}: no 1DTE chain")
                    continue

                logger.info(f"  {symbol} {opt_type}: {len(chain)} contracts in chain")

                # Batch fetch fresh quotes
                quotes = {}
                try:
                    req = OptionLatestQuoteRequest(symbol_or_symbols=list(chain.keys()))
                    quotes = self._option_client.get_option_latest_quote(req)
                except Exception as e:
                    logger.error(f"  Quote fetch failed: {e}")
                    continue

                for sym, snapshot in chain.items():
                    q = quotes.get(sym)
                    if not q:
                        continue

                    bid = float(q.bid_price or 0)
                    ask = float(q.ask_price or 0)
                    if bid <= 0 or ask <= bid:
                        continue

                    spread = ask - bid
                    mid = (bid + ask) / 2
                    iv = float(snapshot.implied_volatility or 0)
                    delta = float(snapshot.greeks.delta if snapshot.greeks else 0)

                    strike_val = self._parse_strike(sym)
                    if not strike_val:
                        continue

                    otm_pct = abs(strike_val - price) / price

                    logger.info(
                        f"    {sym}: strike=${strike_val:.0f} "
                        f"bid=${bid:.2f} ask=${ask:.2f} spread=${spread:.2f} "
                        f"delta={delta:.2f} iv={iv:.2f}"
                    )

                    viable.append(ViableStrike(
                        symbol=symbol,
                        contract_symbol=sym,
                        strike=strike_val,
                        expiry=expiry,
                        dte=dte,
                        option_type=opt_type,
                        underlying_price=price,
                        otm_pct=otm_pct,
                        bid=bid, ask=ask,
                        spread=spread, mid=mid,
                        iv=iv, delta=delta,
                        volume_est=0,
                        our_bid=bid, our_ask=ask,
                        capture_target=0,
                    ))

            except Exception as e:
                logger.error(f"  {symbol} {opt_type} error: {e}", exc_info=True)

        return viable

    def _get_price(self, symbol: str) -> Optional[float]:
        """Get current mid price for underlying."""
        try:
            req = StockLatestQuoteRequest(symbol_or_symbols=symbol)
            quote = self._stock_client.get_stock_latest_quote(req)
            if symbol in quote:
                q = quote[symbol]
                return (float(q.bid_price) + float(q.ask_price)) / 2
        except Exception as e:
            logger.error(f"Price fetch {symbol}: {e}")
        return None

    def _parse_strike(self, contract_sym: str) -> Optional[float]:
        """Parse strike from OCC symbol: SPY250325C00567000 → 567.0"""
        m = re.match(r'^[A-Z]{1,6}\d{6}[PC](\d{8})$', contract_sym)
        if m:
            return int(m.group(1)) / 1000.0
        return None


# Alias for backward compat with engine imports
MorningScanner = ZeroDTEScanner
