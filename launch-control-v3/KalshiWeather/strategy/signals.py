"""
Signal Engine — Last Mile Strategy.
Buy near-certain temperature contracts on resolution day when both weather
models predict temp well above/below the contract threshold. Hold to settlement.

Edge source: Contracts priced $0.80-$0.95 settle at $1.00 when correct.
Backtest: 99.7% WR at 4F offset over 365 days, $500 -> $4,355 in 6 months.

Market types:
  - "above" (floor_strike only): YES = temp > threshold
  - "below" (cap_strike only):   YES = temp < threshold
  - brackets (both strikes):     skipped (range bets)

For each directional market, we check BOTH sides:
  - Buy YES if YES is the near-certain outcome at $0.80-$0.95
  - Buy NO  if NO  is the near-certain outcome at $0.80-$0.95
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
                 spread, forecast_offset, side="yes"):
        self.city_code = city_code
        self.date = date
        self.ticker = ticker
        self.threshold = threshold
        self.direction = direction  # "above" or "below"
        self.model_prob = model_prob
        self.market_price = market_price  # effective cost to us
        self.edge = edge              # expected profit per contract ($1.00 - price)
        self.contracts = contracts
        self.forecast_mean = forecast_mean
        self.model_spread = spread
        self.forecast_offset = forecast_offset  # abs distance from threshold
        self.side = side              # "yes" or "no" (which side to buy)
        self.created_at = datetime.now()

    def __repr__(self):
        city = CITIES[self.city_code]["name"]
        return (
            f"Signal({city} {self.date} {self.ticker} BUY {self.side.upper()} | "
            f"forecast={self.forecast_mean:.0f}F offset={self.forecast_offset:+.0f}F "
            f"cost=${self.market_price:.2f} profit=${self.edge:.2f})"
        )


class SignalEngine:
    """Scan all cities for Last Mile temperature contracts."""

    def __init__(self, kalshi: KalshiClient):
        self.kalshi = kalshi

    def _classify_market(self, market: dict):
        """
        Classify a Kalshi temperature market.
        Returns: ("above", threshold), ("below", threshold), or (None, None)
        """
        floor = market.get("floor_strike")
        cap = market.get("cap_strike")

        if floor is not None and cap is None:
            return "above", float(floor)
        elif cap is not None and floor is None:
            return "below", float(cap)
        else:
            return None, None  # bracket or unknown

    def scan_city(self, city_code: str) -> list[Signal]:
        """
        Last Mile scan for one city.
        For each directional market, check both YES and NO sides for
        near-certain outcomes priced $0.80-$0.95.
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
                continue

            mean_temp, spread = model_consensus(model_temps)

            if spread > MAX_MODEL_SPREAD:
                log.info(f"{city_code} {date_str}: model spread {spread:.1f}F > {MAX_MODEL_SPREAD}F, skipping")
                continue

            log.info(f"{city_code} {date_str}: forecast={mean_temp:.1f}F spread={spread:.1f}F")

            date_markets = [m for m in markets if self._market_matches_date(m, date_str)]
            log.info(f"{city_code} {date_str}: {len(date_markets)} markets match")

            evaluated = 0
            for market in date_markets:
                ticker = market.get("ticker", "")

                mkt_type, threshold = self._classify_market(market)
                if mkt_type is None:
                    continue  # bracket

                # Get orderbook
                prices = self.kalshi.get_best_prices(ticker)
                if not prices:
                    log.debug(f"  {ticker}: no orderbook")
                    continue

                yes_bid = prices["yes_bid"]
                yes_ask = prices["yes_ask"]

                # Determine which side is near-certain based on forecast
                # For "above" markets (YES = temp > threshold):
                #   forecast >> threshold → YES near-certain → buy YES at yes_ask
                #   forecast << threshold → NO near-certain  → buy NO at (1 - yes_bid)
                # For "below" markets (YES = temp < threshold):
                #   forecast << threshold → YES near-certain → buy YES at yes_ask
                #   forecast >> threshold → NO near-certain  → buy NO at (1 - yes_bid)

                offset = mean_temp - threshold  # positive = forecast above threshold

                candidates = []

                if mkt_type == "above":
                    if offset >= MIN_FORECAST_OFFSET:
                        # Forecast well above → YES is near-certain
                        candidates.append(("yes", yes_ask, offset, "ABOVE_YES"))
                    if offset <= -MIN_FORECAST_OFFSET:
                        # Forecast well below → NO is near-certain
                        no_cost = round(1.0 - yes_bid, 4) if yes_bid > 0 else 1.0
                        candidates.append(("no", no_cost, abs(offset), "ABOVE_NO"))
                elif mkt_type == "below":
                    if offset <= -MIN_FORECAST_OFFSET:
                        # Forecast well below threshold → YES (temp < threshold) near-certain
                        candidates.append(("yes", yes_ask, abs(offset), "BELOW_YES"))
                    if offset >= MIN_FORECAST_OFFSET:
                        # Forecast well above threshold → NO (temp >= threshold) near-certain
                        no_cost = round(1.0 - yes_bid, 4) if yes_bid > 0 else 1.0
                        candidates.append(("no", no_cost, offset, "BELOW_NO"))

                if not candidates:
                    log.debug(
                        f"  {ticker}: {mkt_type} thresh={threshold:.0f} "
                        f"offset={offset:+.1f}F -- insufficient"
                    )
                    continue

                evaluated += 1

                for side, cost, abs_offset, label in candidates:
                    if cost < MIN_BUY_PRICE or cost > MAX_BUY_PRICE:
                        log.info(
                            f"  {ticker}: {label} BUY {side.upper()} ${cost:.2f} "
                            f"outside ${MIN_BUY_PRICE}-${MAX_BUY_PRICE} "
                            f"(offset={offset:+.1f}F)"
                        )
                        continue

                    model_prob = temp_probability(mean_temp, threshold, spread)
                    # For NO side, invert probability
                    effective_prob = model_prob if side == "yes" and mkt_type == "above" else \
                                     (1 - model_prob) if side == "no" and mkt_type == "above" else \
                                     model_prob if side == "yes" and mkt_type == "below" else \
                                     (1 - model_prob)

                    edge = effective_prob - cost

                    log.info(
                        f"  SIGNAL: {ticker} {label} BUY {side.upper()} @ ${cost:.2f} | "
                        f"forecast={mean_temp:.0f}F offset={offset:+.0f}F | "
                        f"model={effective_prob:.1%} edge=${edge:+.3f}"
                    )

                    sig = Signal(
                        city_code=city_code,
                        date=date_str,
                        ticker=ticker,
                        threshold=threshold,
                        direction=label,
                        model_prob=effective_prob,
                        market_price=cost,
                        edge=edge,
                        contracts=0,
                        forecast_mean=mean_temp,
                        spread=spread,
                        forecast_offset=abs_offset,
                        side=side,
                    )
                    signals.append(sig)

            if evaluated == 0 and len(date_markets) > 0:
                log.info(
                    f"{city_code} {date_str}: {len(date_markets)} markets "
                    f"but 0 met offset threshold ({MIN_FORECAST_OFFSET}F)"
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
