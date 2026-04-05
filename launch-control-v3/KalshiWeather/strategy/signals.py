"""
Signal Engine — Last Mile Strategy.
Buy near-certain temperature contracts on resolution day when both weather
models predict temp well above the contract threshold. Hold to settlement.

Edge source: Contracts priced $0.80-$0.95 settle at $1.00 when YES.
Backtest: 99.7% WR at 4F offset over 365 days, $500 → $4,355 in 6 months.
"""

import logging
from datetime import datetime, timedelta

from config.settings import (
    CITIES, MIN_BUY_PRICE, MAX_BUY_PRICE,
    MIN_FORECAST_OFFSET, MAX_MODEL_SPREAD, LADDER_BUCKETS,
)
from feeds.weather import fetch_open_meteo, model_consensus, temp_probability
from feeds.kalshi import KalshiClient

log = logging.getLogger("signal")


class Signal:
    """A Last Mile signal: buy a near-certain temperature contract."""

    def __init__(self, city_code, date, ticker, threshold, direction,
                 model_prob, market_price, edge, contracts, forecast_mean,
                 spread, forecast_offset):
        self.city_code = city_code
        self.date = date
        self.ticker = ticker
        self.threshold = threshold
        self.direction = direction  # "above"
        self.model_prob = model_prob
        self.market_price = market_price
        self.edge = edge              # expected profit per contract ($1.00 - price)
        self.contracts = contracts
        self.forecast_mean = forecast_mean
        self.model_spread = spread
        self.forecast_offset = forecast_offset  # how far above threshold
        self.created_at = datetime.now()

    def __repr__(self):
        city = CITIES[self.city_code]["name"]
        return (
            f"Signal({city} {self.date} >{self.threshold}F | "
            f"forecast={self.forecast_mean:.0f}F (+{self.forecast_offset:.0f}F) "
            f"mkt=${self.market_price:.2f} profit=${self.edge:.2f})"
        )


class SignalEngine:
    """Scan all cities for Last Mile temperature contracts."""

    def __init__(self, kalshi: KalshiClient):
        self.kalshi = kalshi

    def scan_city(self, city_code: str) -> list[Signal]:
        """
        Last Mile scan for one city:
        1. Fetch multi-model forecast (GFS + ECMWF)
        2. Fetch Kalshi temperature markets
        3. Find contracts where forecast is 4-6F+ above threshold
        4. Buy contracts priced $0.80-$0.95 (hold to settlement at $1.00)
        """
        city = CITIES.get(city_code)
        if not city:
            return []

        # 1. Get weather forecast
        forecasts = fetch_open_meteo(city_code)
        if not forecasts:
            log.warning(f"{city_code}: weather fetch returned None")
            return []

        log.info(f"{city_code}: weather OK -- {len(forecasts)} days")

        # 2. Get Kalshi markets for this city's series
        series = city["series"]
        markets = self.kalshi.get_markets(series)
        if not markets:
            log.warning(f"{city_code}: 0 open markets for series={series}")
            return []

        sample_tickers = [m.get("ticker", "?") for m in markets[:3]]
        log.info(f"{city_code}: {len(markets)} markets (e.g. {sample_tickers})")

        signals = []

        # Only look at today and tomorrow (Last Mile = resolution day focus)
        today = datetime.now().strftime("%Y-%m-%d")
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        target_dates = {today, tomorrow}

        for date_str, model_temps in forecasts.items():
            if date_str not in target_dates:
                log.debug(f"{city_code} {date_str}: skipping (not today/tomorrow)")
                continue

            mean_temp, spread = model_consensus(model_temps)

            # Models must agree
            if spread > MAX_MODEL_SPREAD:
                log.info(f"{city_code} {date_str}: model spread {spread:.1f}F > {MAX_MODEL_SPREAD}F, skipping")
                continue

            log.info(f"{city_code} {date_str}: forecast={mean_temp:.1f}F spread={spread:.1f}F")

            # Find markets for this date
            date_markets = [m for m in markets if self._market_matches_date(m, date_str)]
            log.info(f"{city_code} {date_str}: {len(date_markets)} markets match")

            evaluated = 0
            for market in date_markets:
                ticker = market.get("ticker", "")
                threshold = self._parse_threshold(ticker)
                if threshold is None:
                    log.debug(f"  {ticker}: could not parse threshold")
                    continue

                # KEY: forecast must be well above threshold
                forecast_offset = mean_temp - threshold
                if forecast_offset < MIN_FORECAST_OFFSET:
                    log.debug(
                        f"  {ticker}: >{threshold}F | forecast {mean_temp:.0f}F "
                        f"offset={forecast_offset:+.1f}F < {MIN_FORECAST_OFFSET}F required"
                    )
                    continue

                # Get market price
                prices = self.kalshi.get_best_prices(ticker)
                if not prices:
                    log.debug(f"  {ticker}: no orderbook")
                    continue

                market_price = prices["yes_ask"]
                evaluated += 1

                # Must be in Last Mile range ($0.80-$0.95)
                if market_price < MIN_BUY_PRICE or market_price > MAX_BUY_PRICE:
                    log.debug(
                        f"  {ticker}: price ${market_price:.2f} outside "
                        f"${MIN_BUY_PRICE}-${MAX_BUY_PRICE}"
                    )
                    continue

                # Edge = expected profit per contract (settles at $1.00)
                model_prob = temp_probability(mean_temp, threshold, spread)
                edge = (model_prob * 1.00) - market_price  # expected value minus cost

                log.info(
                    f"  {ticker}: >{threshold}F | forecast={mean_temp:.0f}F "
                    f"(+{forecast_offset:.0f}F) | model={model_prob:.1%} "
                    f"mkt=${market_price:.2f} EV=${edge:+.3f} PASS"
                )

                sig = Signal(
                    city_code=city_code,
                    date=date_str,
                    ticker=ticker,
                    threshold=threshold,
                    direction="above",
                    model_prob=model_prob,
                    market_price=market_price,
                    edge=edge,
                    contracts=0,
                    forecast_mean=mean_temp,
                    spread=spread,
                    forecast_offset=forecast_offset,
                )
                signals.append(sig)
                log.info(f"SIGNAL: {sig}")

            if evaluated == 0 and len(date_markets) > 0:
                log.info(
                    f"{city_code} {date_str}: {len(date_markets)} markets "
                    f"but 0 had valid orderbook/price"
                )

        return signals

    def scan_all(self) -> list[Signal]:
        """Scan all cities, return signals sorted by profit potential."""
        all_signals = []
        for code in CITIES:
            city_signals = self.scan_city(code)
            all_signals.extend(city_signals)

        # Sort by forecast offset descending (most certain first)
        all_signals.sort(key=lambda s: s.forecast_offset, reverse=True)

        # Apply ladder: for each city+date, keep top LADDER_BUCKETS
        seen = {}
        filtered = []
        for sig in all_signals:
            key = f"{sig.city_code}:{sig.date}"
            seen[key] = seen.get(key, 0) + 1
            if seen[key] <= LADDER_BUCKETS:
                filtered.append(sig)

        log.info(
            f"Scan complete: {len(filtered)} signals from "
            f"{len(all_signals)} candidates"
        )
        return filtered

    def _market_matches_date(self, market: dict, date_str: str) -> bool:
        """Check if a Kalshi market is for a given date."""
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

    def _parse_threshold(self, ticker: str) -> float | None:
        """
        Extract temperature threshold from ticker.
        T-type: KXHIGHNY-26APR05-T67 → 67 (above threshold)
        B-type: KXHIGHNY-26APR05-B66.5 → 66.5 (bucket midpoint)
        """
        parts = ticker.split("-")
        for part in parts:
            if part.startswith("T") and part[1:].isdigit():
                return int(part[1:])
            if part.startswith("B"):
                try:
                    return float(part[1:])
                except ValueError:
                    continue
        return None
