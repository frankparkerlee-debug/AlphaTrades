"""
Signal Engine: Compare weather model forecasts vs Kalshi market prices.
Finds mispriced temperature contracts where model probability >> market price.
"""

import logging
from datetime import datetime, timedelta

from config.settings import (
    CITIES, MIN_EDGE_PCT, MIN_BUY_PRICE, MAX_BUY_PRICE,
    TARGET_SELL_PRICE, LADDER_BUCKETS,
)
from feeds.weather import fetch_open_meteo, model_consensus, temp_probability
from feeds.kalshi import KalshiClient

log = logging.getLogger("signal")


class Signal:
    """A tradeable signal: buy a temperature contract where model >> market."""

    def __init__(self, city_code, date, ticker, threshold, direction,
                 model_prob, market_price, edge, contracts, forecast_mean, spread):
        self.city_code = city_code
        self.date = date
        self.ticker = ticker
        self.threshold = threshold
        self.direction = direction  # "above" or "below"
        self.model_prob = model_prob
        self.market_price = market_price
        self.edge = edge
        self.contracts = contracts
        self.forecast_mean = forecast_mean
        self.model_spread = spread
        self.created_at = datetime.now()

    def __repr__(self):
        city = CITIES[self.city_code]["name"]
        return (
            f"Signal({city} {self.date} >{self.threshold}F | "
            f"model={self.model_prob:.0%} mkt=${self.market_price:.2f} "
            f"edge={self.edge:.2f})"
        )


class SignalEngine:
    """Scan all cities for mispriced temperature contracts."""

    def __init__(self, kalshi: KalshiClient):
        self.kalshi = kalshi

    def scan_city(self, city_code: str) -> list[Signal]:
        """
        For one city:
        1. Fetch multi-model forecast
        2. Fetch Kalshi temperature markets
        3. Compare model probability vs market price
        4. Return signals where edge is large enough
        """
        city = CITIES.get(city_code)
        if not city:
            return []

        # 1. Get weather forecast
        forecasts = fetch_open_meteo(city_code)
        if not forecasts:
            return []

        # 2. Get Kalshi markets for this city's series
        series = city["series"]
        markets = self.kalshi.get_markets(series)
        if not markets:
            log.debug(f"{city_code}: no open markets for {series}")
            return []

        signals = []

        for date_str, model_temps in forecasts.items():
            mean_temp, spread = model_consensus(model_temps)
            if spread > 10:
                log.debug(f"{city_code} {date_str}: model spread {spread}F too wide, skipping")
                continue

            # Find markets for this date
            date_markets = [m for m in markets if self._market_matches_date(m, date_str)]

            for market in date_markets:
                ticker = market.get("ticker", "")
                # Extract threshold from ticker (e.g., KXHIGHNY-26APR05-T67 → 67)
                threshold = self._parse_threshold(ticker)
                if threshold is None:
                    continue

                # Get market price
                prices = self.kalshi.get_best_prices(ticker)
                if not prices:
                    continue

                market_price = prices["yes_ask"]  # cost to buy YES
                if market_price < MIN_BUY_PRICE or market_price > MAX_BUY_PRICE:
                    continue

                # Calculate model probability
                model_prob = temp_probability(mean_temp, threshold, spread)

                # Edge = model probability - market price
                edge = model_prob - market_price

                if edge >= MIN_EDGE_PCT:
                    sig = Signal(
                        city_code=city_code,
                        date=date_str,
                        ticker=ticker,
                        threshold=threshold,
                        direction="above",
                        model_prob=model_prob,
                        market_price=market_price,
                        edge=edge,
                        contracts=0,  # sized later by executor
                        forecast_mean=mean_temp,
                        spread=spread,
                    )
                    signals.append(sig)
                    log.info(f"SIGNAL: {sig}")

        return signals

    def scan_all(self) -> list[Signal]:
        """Scan all cities, return signals sorted by edge (best first)."""
        all_signals = []
        for code in CITIES:
            city_signals = self.scan_city(code)
            all_signals.extend(city_signals)

        # Sort by edge descending
        all_signals.sort(key=lambda s: s.edge, reverse=True)

        # Apply ladder: for each city+date, keep top LADDER_BUCKETS
        seen = {}
        filtered = []
        for sig in all_signals:
            key = f"{sig.city_code}:{sig.date}"
            seen[key] = seen.get(key, 0) + 1
            if seen[key] <= LADDER_BUCKETS:
                filtered.append(sig)

        log.info(f"Scan complete: {len(filtered)} signals from {len(all_signals)} candidates")
        return filtered

    def _market_matches_date(self, market: dict, date_str: str) -> bool:
        """Check if a Kalshi market is for a given date."""
        # Market ticker: KXHIGHNY-26APR05-T67
        # date_str: 2026-04-05
        ticker = market.get("ticker", "")
        parts = ticker.split("-")
        if len(parts) < 2:
            return False

        date_part = parts[1]  # e.g., "26APR05"
        try:
            dt = datetime.strptime(date_part, "%y%b%d")
            return dt.strftime("%Y-%m-%d") == date_str
        except ValueError:
            return False

    def _parse_threshold(self, ticker: str) -> int | None:
        """Extract temperature threshold from ticker. KXHIGHNY-26APR05-T67 → 67."""
        parts = ticker.split("-")
        for part in parts:
            if part.startswith("T") and part[1:].isdigit():
                return int(part[1:])
        return None
