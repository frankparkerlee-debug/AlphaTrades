"""
Weather data from Open-Meteo (primary) and NOAA (secondary).
Fetches GFS + ECMWF model forecasts for temperature highs.
"""

import time
import requests
import logging
from datetime import datetime, timedelta
from config.settings import CITIES, WEATHER_MODELS, FORECAST_DAYS

log = logging.getLogger("weather")

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
NOAA_POINTS_URL = "https://api.weather.gov/points"

# Retry config for flaky Open-Meteo endpoints
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF = [1.0, 3.0, 6.0]  # seconds between attempts
_RETRY_TIMEOUT = 15


def _get_with_retry(url: str, params: dict, label: str) -> dict | None:
    """GET with retries on 5xx errors and timeouts. Returns parsed JSON or None."""
    last_err = None
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            resp = requests.get(url, params=params, timeout=_RETRY_TIMEOUT)
            # Retry on 5xx (bad gateway, etc); raise otherwise
            if 500 <= resp.status_code < 600:
                last_err = f"{resp.status_code} {resp.reason}"
                log.warning(f"{label}: attempt {attempt+1}/{_RETRY_ATTEMPTS} got {last_err}")
            else:
                resp.raise_for_status()
                return resp.json()
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_err = f"{type(e).__name__}: {e}"
            log.warning(f"{label}: attempt {attempt+1}/{_RETRY_ATTEMPTS} {last_err}")
        except Exception as e:
            # Non-retryable (4xx, JSON decode, etc)
            log.error(f"{label} failed: {e}")
            return None

        if attempt < _RETRY_ATTEMPTS - 1:
            time.sleep(_RETRY_BACKOFF[attempt])

    log.error(f"{label} failed after {_RETRY_ATTEMPTS} attempts: {last_err}")
    return None


def fetch_open_meteo(city_code: str) -> dict | None:
    """
    Fetch multi-model daily high forecasts from Open-Meteo.
    Returns {date: {model: temp_f, ...}, ...} or None on failure.
    """
    city = CITIES.get(city_code)
    if not city:
        return None

    params = {
        "latitude": city["lat"],
        "longitude": city["lon"],
        "daily": "temperature_2m_max,temperature_2m_min",
        "models": ",".join(WEATHER_MODELS),
        "temperature_unit": "fahrenheit",
        "timezone": "America/New_York",
        "forecast_days": FORECAST_DAYS,
    }

    data = _get_with_retry(OPEN_METEO_URL, params, f"Open-Meteo[{city_code}]")
    if not data:
        return None

    daily = data.get("daily", {})
    dates = daily.get("time", [])
    result = {}

    for i, date_str in enumerate(dates):
        models = {}
        for model in WEATHER_MODELS:
            key = f"temperature_2m_max_{model}"
            if key in daily and i < len(daily[key]):
                models[model] = daily[key][i]
        if models:
            result[date_str] = models

    return result


def fetch_open_meteo_simple(lat: float, lon: float, days: int = 2) -> dict | None:
    """
    Simple forecast fetch without model splitting.
    Returns {"dates": [...], "highs": [...], "lows": [...]}.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min",
        "temperature_unit": "fahrenheit",
        "timezone": "America/New_York",
        "forecast_days": days,
    }

    data = _get_with_retry(OPEN_METEO_URL, params, "Open-Meteo[simple]")
    if not data:
        return None
    daily = data.get("daily", {})
    return {
        "dates": daily.get("time", []),
        "highs": daily.get("temperature_2m_max", []),
        "lows": daily.get("temperature_2m_min", []),
    }


def fetch_noaa(lat: float, lon: float) -> dict | None:
    """
    Fetch NWS forecast as secondary confirmation.
    Returns list of forecast periods with temperatures.
    """
    headers = {"User-Agent": "(KalshiWeather, weather-arb-bot)"}

    try:
        points = requests.get(
            f"{NOAA_POINTS_URL}/{lat},{lon}",
            headers=headers, timeout=10,
        ).json()

        forecast_url = points["properties"]["forecast"]
        forecast = requests.get(forecast_url, headers=headers, timeout=10).json()

        periods = forecast["properties"]["periods"]
        return {
            "periods": [
                {
                    "name": p["name"],
                    "temp": p["temperature"],
                    "unit": p["temperatureUnit"],
                    "forecast": p["shortForecast"],
                    "start": p["startTime"],
                }
                for p in periods
            ]
        }
    except Exception as e:
        log.error(f"NOAA fetch failed: {e}")
        return None


def fetch_all_cities() -> dict:
    """
    Fetch forecasts for all configured cities.
    Returns {city_code: {date: {model: temp}, ...}, ...}.
    """
    all_forecasts = {}
    for code in CITIES:
        forecast = fetch_open_meteo(code)
        if forecast:
            all_forecasts[code] = forecast
            log.info(f"{code}: {len(forecast)} days fetched")
        else:
            log.warning(f"{code}: fetch failed")
    return all_forecasts


def model_consensus(forecasts: dict[str, float]) -> tuple[float, float]:
    """
    Given {model: temp_f}, return (mean, spread).
    Low spread = high confidence. Spread > 5F = low confidence.
    """
    if not forecasts:
        return 0.0, 999.0
    temps = list(forecasts.values())
    mean = sum(temps) / len(temps)
    spread = max(temps) - min(temps)
    return round(mean, 1), round(spread, 1)


def temp_probability(forecast_mean: float, threshold: int, spread: float) -> float:
    """
    Estimate probability that actual high exceeds threshold,
    given forecast mean and model spread.

    Uses a simple normal approximation:
    - Forecast error std ~3F for 1-day, ~5F for 2-day
    - Model spread adds to uncertainty
    """
    import math

    # Base forecast error (std dev in F)
    base_std = 3.0
    # Add half the model spread as additional uncertainty
    total_std = math.sqrt(base_std**2 + (spread / 2)**2)

    # Z-score: how many std devs is threshold above/below mean
    z = (threshold - forecast_mean) / total_std

    # P(temp > threshold) using normal CDF complement
    # Approximation of erfc
    prob = 0.5 * math.erfc(z / math.sqrt(2))

    return round(min(max(prob, 0.01), 0.99), 3)
