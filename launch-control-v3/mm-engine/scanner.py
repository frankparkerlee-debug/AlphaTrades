"""
Launch Control MM — Morning Scanner
Runs at 9:00 AM ET. Scans universe for viable strikes.
A strike must pass ALL four filters to be added to the active watchlist.
"""

import logging
from datetime import datetime, date, timedelta, timezone
from dataclasses import dataclass
from typing import Optional
from alpaca.data.historical.option import OptionHistoricalDataClient
from alpaca.data.requests import OptionSnapshotRequest, OptionChainRequest
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.requests import StockLatestQuoteRequest
from config import (
    ALPACA_API_KEY, ALPACA_API_SECRET, UNIVERSE,
    TARGET_DTE_MIN, TARGET_DTE_MAX, OTM_PCT_MIN, OTM_PCT_MAX,
    MIN_SPREAD_WIDTH, MIN_DAILY_VOLUME, CONTRACTS_PER_TRADE
)

logger = logging.getLogger("scanner")


@dataclass
class ViableStrike:
    """A strike that has passed all morning filters."""
    symbol:          str
    contract_symbol: str
    strike:          float
    expiry:          date
    dte:             int
    option_type:     str   # always "put" — puts are structurally wider
    underlying_price: float
    otm_pct:         float
    bid:             float
    ask:             float
    spread:          float
    mid:             float
    iv:              float
    delta:           float
    volume_est:      int
    # Optimal quote levels (calculated from spread)
    our_bid:         float
    our_ask:         float
    capture_target:  float

    def __str__(self):
        return (
            f"{self.symbol} ${self.strike:.2f}P {self.expiry} "
            f"({self.dte}DTE) | spread=${self.spread:.3f} | "
            f"quote {self.our_bid:.3f}/{self.our_ask:.3f}"
        )


class MorningScanner:
    """
    Scans the universe each morning and returns a list of viable strikes
    ready to quote.
    """

    def __init__(self):
        self._option_client = OptionHistoricalDataClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_API_SECRET,
        )
        self._stock_client = StockHistoricalDataClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_API_SECRET,
        )

    def run(self, capture_pct: float = 0.40) -> list[ViableStrike]:
        """
        Run the full morning scan.
        Returns list of ViableStrike objects sorted by spread width (widest first).
        """
        logger.info(f"Morning scan starting. Universe: {UNIVERSE}")
        viable = []

        for symbol in UNIVERSE:
            try:
                strikes = self._scan_symbol(symbol, capture_pct)
                viable.extend(strikes)
                logger.info(f"  {symbol}: {len(strikes)} viable strikes")
            except Exception as e:
                logger.error(f"  {symbol}: scan failed — {e}")

        # Sort by: puts first (put bias), then widest spreads
        viable.sort(key=lambda s: (0 if s.option_type == 'put' else 1, -s.spread))

        logger.info(
            f"Scan complete. {len(viable)} viable strikes across "
            f"{len(UNIVERSE)} symbols."
        )
        return viable

    def _scan_symbol(self, symbol: str, capture_pct: float) -> list[ViableStrike]:
        """Scan one symbol for viable put AND call strikes (put bias)."""
        viable = []

        # Get current underlying price
        underlying_price = self._get_underlying_price(symbol)
        if underlying_price is None:
            logger.warning(f"{symbol}: could not get underlying price")
            return []

        # Calculate expiry range
        today = date.today()
        expiry_min = today + timedelta(days=TARGET_DTE_MIN)
        expiry_max = today + timedelta(days=TARGET_DTE_MAX)

        # Scan both puts and calls
        for option_type in ["put", "call"]:
            # OTM strike range depends on direction:
            #   Puts:  strikes BELOW price (1-3% below)
            #   Calls: strikes ABOVE price (1-3% above)
            if option_type == "put":
                strike_min = underlying_price * (1 - OTM_PCT_MAX)
                strike_max = underlying_price * (1 - OTM_PCT_MIN)
            else:
                strike_min = underlying_price * (1 + OTM_PCT_MIN)
                strike_max = underlying_price * (1 + OTM_PCT_MAX)

            try:
                request = OptionChainRequest(
                    underlying_symbol=symbol,
                    type=option_type,
                    strike_price_gte=str(round(strike_min, 2)),
                    strike_price_lte=str(round(strike_max, 2)),
                    expiration_date_gte=expiry_min.strftime("%Y-%m-%d"),
                    expiration_date_lte=expiry_max.strftime("%Y-%m-%d"),
                )
                logger.info(
                    f"{symbol} {option_type.upper()}: price=${underlying_price:.2f} "
                    f"strikes=${strike_min:.2f}-${strike_max:.2f} "
                    f"expiry={expiry_min}..{expiry_max}"
                )
                chain = self._option_client.get_option_chain(request)

                if not chain:
                    logger.info(f"{symbol} {option_type.upper()}: empty chain")
                    continue

                logger.info(f"{symbol} {option_type.upper()}: {len(chain)} contracts in chain")

                # Dump first contract raw for debugging
                first_key = next(iter(chain))
                first_snap = chain[first_key]
                logger.info(f"  RAW SAMPLE {first_key}: {first_snap}")

                for contract_sym, snapshot in chain.items():
                    strike = self._evaluate_strike(
                        symbol, contract_sym, snapshot,
                        underlying_price, today, capture_pct
                    )
                    if strike is not None:
                        viable.append(strike)

            except Exception as e:
                logger.error(f"{symbol} {option_type} chain error: {e}", exc_info=True)

        return viable

    def _evaluate_strike(
        self,
        symbol: str,
        contract_sym: str,
        snapshot,
        underlying_price: float,
        today: date,
        capture_pct: float,
    ) -> Optional[ViableStrike]:
        """
        Apply all four filters to a single contract.
        Returns ViableStrike if it passes, None if it fails.
        """
        try:
            # Extract quote data
            if not snapshot.latest_quote:
                logger.info(f"    {contract_sym}: no quote data")
                return None

            bid = float(snapshot.latest_quote.bid_price or 0)
            ask = float(snapshot.latest_quote.ask_price or 0)

            if bid <= 0 or ask <= 0 or ask <= bid:
                logger.info(f"    {contract_sym}: bad quote bid=${bid:.2f} ask=${ask:.2f}")
                return None

            spread = ask - bid
            mid    = (bid + ask) / 2

            # Extract greeks
            iv    = float(snapshot.implied_volatility or 0)
            delta = float(snapshot.greeks.delta if snapshot.greeks else 0)

            # Extract contract details
            details    = snapshot.latest_quote
            strike     = float(snapshot.latest_trade.price if snapshot.latest_trade else 0)

            # Parse from contract symbol (format: JPM251121P00285000)
            # Better: get from chain details
            strike_val, expiry_dt, dte, parsed_type = self._parse_contract(contract_sym, today)
            if strike_val is None:
                return None

            # Calculate OTM %: puts are OTM below price, calls are OTM above price
            if parsed_type == 'put':
                otm_pct = (underlying_price - strike_val) / underlying_price
            else:
                otm_pct = (strike_val - underlying_price) / underlying_price

            # Log raw contract data for diagnostics
            volume_est = int(snapshot.daily_bar.volume if snapshot.daily_bar else 0)
            oi = int(snapshot.open_interest if snapshot.open_interest else 0)
            logger.info(
                f"  {contract_sym}: strike=${strike_val:.2f} {dte}DTE "
                f"bid=${bid:.2f} ask=${ask:.2f} spread=${spread:.3f} "
                f"OTM={otm_pct:.2%} OI={oi} vol={volume_est}"
            )

            # ── Filter 1: Spread width ────────────────────────────────────────
            if spread < MIN_SPREAD_WIDTH:
                logger.info(f"    REJECT spread: ${spread:.3f} < ${MIN_SPREAD_WIDTH}")
                return None

            # ── Filter 2: Strike in OTM range ────────────────────────────────
            if not (OTM_PCT_MIN <= otm_pct <= OTM_PCT_MAX):
                logger.info(f"    REJECT OTM: {otm_pct:.2%} not in {OTM_PCT_MIN:.0%}-{OTM_PCT_MAX:.0%}")
                return None

            # ── Filter 3: DTE range ───────────────────────────────────────────
            if not (TARGET_DTE_MIN <= dte <= TARGET_DTE_MAX):
                logger.info(f"    REJECT DTE: {dte} not in {TARGET_DTE_MIN}-{TARGET_DTE_MAX}")
                return None

            # ── Filter 4: Liquidity check (volume + open interest) ──────────
            # At 9 AM, daily volume is usually 0. Use open interest as the
            # primary liquidity signal, with volume as a bonus.

            # Require minimum open interest — this is the real liquidity signal
            if oi < 50:
                logger.info(f"    REJECT OI: {oi} < 50")
                return None

            # If we do have volume data and it's low, skip
            if 0 < volume_est < MIN_DAILY_VOLUME and oi < 200:
                logger.info(f"    REJECT volume: vol={volume_est} OI={oi}")
                return None

            # ── Calculate optimal quote levels ────────────────────────────────
            capture    = spread * capture_pct
            our_bid    = mid - capture / 2
            our_ask    = mid + capture / 2

            # Validate quote is inside market
            our_bid = max(our_bid, bid + 0.01)
            our_ask = min(our_ask, ask - 0.01)

            if our_ask <= our_bid:
                return None

            capture_target = our_ask - our_bid

            return ViableStrike(
                symbol=symbol,
                contract_symbol=contract_sym,
                strike=strike_val,
                expiry=expiry_dt,
                dte=dte,
                option_type=parsed_type,
                underlying_price=underlying_price,
                otm_pct=otm_pct,
                bid=bid,
                ask=ask,
                spread=spread,
                mid=mid,
                iv=iv,
                delta=delta,
                volume_est=volume_est,
                our_bid=round(our_bid, 2),
                our_ask=round(our_ask, 2),
                capture_target=round(capture_target, 3),
            )

        except Exception as e:
            logger.debug(f"  Error evaluating {contract_sym}: {e}")
            return None

    def _get_underlying_price(self, symbol: str) -> Optional[float]:
        """Get current best bid/ask mid for the underlying."""
        try:
            req = StockLatestQuoteRequest(symbol_or_symbols=symbol)
            quote = self._stock_client.get_stock_latest_quote(req)
            if symbol in quote:
                q = quote[symbol]
                return (float(q.bid_price) + float(q.ask_price)) / 2
        except Exception as e:
            logger.error(f"Could not get price for {symbol}: {e}")
        return None

    def _parse_contract(
        self, contract_sym: str, today: date
    ) -> tuple[Optional[float], Optional[date], int, str]:
        """
        Parse strike, expiry, DTE, and option type from Alpaca contract symbol.
        Format: JPM251121P00285000
                 ↑sym ↑YYMMDD ↑type ↑strike (× 1000)
        """
        try:
            import re
            m = re.match(r'^([A-Z]{1,6})(\d{6})([PC])(\d{8})$', contract_sym)
            if not m:
                return None, None, 0, ''

            date_str    = m.group(2)
            option_type = 'put' if m.group(3) == 'P' else 'call'
            strike_str  = m.group(4)

            expiry = datetime.strptime(date_str, "%y%m%d").date()
            strike = int(strike_str) / 1000.0
            dte    = (expiry - today).days

            return strike, expiry, dte, option_type

        except Exception:
            return None, None, 0, ''
