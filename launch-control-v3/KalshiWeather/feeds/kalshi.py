"""
Kalshi CLOB API client.
Handles RSA-PSS authentication, market data, and order execution.
"""

import base64
import time
import uuid
import logging
import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from config.settings import (
    KALSHI_API_KEY, KALSHI_PRIVATE_KEY,
    KALSHI_BASE_URL, KALSHI_DEMO_URL, TRADING_MODE,
)

log = logging.getLogger("kalshi")


class KalshiClient:
    """Authenticated Kalshi API client with RSA-PSS signing."""

    def __init__(self):
        self.base_url = KALSHI_DEMO_URL if TRADING_MODE == "paper" else KALSHI_BASE_URL
        self.api_key = KALSHI_API_KEY
        self.private_key = self._load_private_key()

    def _load_private_key(self):
        """Load RSA private key from env var (inline PEM)."""
        pem_data = None

        if KALSHI_PRIVATE_KEY:
            # Inline PEM (newlines encoded as \\n)
            pem_data = KALSHI_PRIVATE_KEY.replace("\\n", "\n").encode()

        if not pem_data:
            log.warning("No Kalshi private key configured — auth disabled")
            return None

        try:
            return serialization.load_pem_private_key(pem_data, password=None)
        except Exception as e:
            log.error(f"Failed to load private key: {e}")
            return None

    def _sign(self, timestamp_ms: str, method: str, path: str) -> str:
        """RSA-PSS signature for Kalshi auth."""
        message = f"{timestamp_ms}{method}{path}".encode("utf-8")
        signature = self.private_key.sign(
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        return base64.b64encode(signature).decode("utf-8")

    def _auth_headers(self, method: str, path: str) -> dict:
        """Build authenticated request headers."""
        ts = str(int(time.time() * 1000))
        headers = {"Content-Type": "application/json"}

        if self.private_key and self.api_key:
            headers["KALSHI-ACCESS-KEY"] = self.api_key
            headers["KALSHI-ACCESS-TIMESTAMP"] = ts
            headers["KALSHI-ACCESS-SIGNATURE"] = self._sign(ts, method, path)

        return headers

    def _request(self, method: str, path: str, params: dict = None, json: dict = None):
        """Make an authenticated API request."""
        url = f"{self.base_url}{path}"
        headers = self._auth_headers(method, path)

        try:
            resp = requests.request(
                method, url, headers=headers,
                params=params, json=json, timeout=10,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            log.error(f"Kalshi {method} {path}: {e.response.status_code} {e.response.text[:200]}")
            return None
        except Exception as e:
            log.error(f"Kalshi {method} {path}: {e}")
            return None

    # ── Public Market Data (no auth required) ──────────────────────────────────

    def get_markets(self, series_ticker: str, status: str = "open", limit: int = 200) -> list:
        """List markets for a series (e.g., KXHIGHNY)."""
        url = f"{self.base_url}/markets"
        try:
            resp = requests.get(url, params={
                "series_ticker": series_ticker,
                "status": status,
                "limit": limit,
            }, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            return data.get("markets", [])
        except Exception as e:
            log.error(f"get_markets({series_ticker}): {e}")
            return []

    def get_market(self, ticker: str) -> dict | None:
        """Get single market details."""
        url = f"{self.base_url}/markets/{ticker}"
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            return resp.json().get("market")
        except Exception as e:
            log.error(f"get_market({ticker}): {e}")
            return None

    def get_orderbook(self, ticker: str, depth: int = 5) -> dict | None:
        """Get orderbook for a market."""
        url = f"{self.base_url}/markets/{ticker}/orderbook"
        try:
            resp = requests.get(url, params={"depth": depth}, timeout=10)
            resp.raise_for_status()
            return resp.json().get("orderbook_fp")
        except Exception as e:
            log.error(f"get_orderbook({ticker}): {e}")
            return None

    def get_best_prices(self, ticker: str) -> dict | None:
        """
        Get best bid/ask for YES side.
        Returns {"yes_bid": float, "yes_ask": float, "spread": float}.
        """
        book = self.get_orderbook(ticker)
        if not book:
            return None

        yes_bids = book.get("yes_dollars", [])
        no_bids = book.get("no_dollars", [])

        # YES best bid = highest YES bid price
        yes_bid = float(yes_bids[0][0]) if yes_bids else 0
        # YES best ask = 1 - highest NO bid (since YES + NO = $1)
        yes_ask = (1.0 - float(no_bids[0][0])) if no_bids else 1.0
        spread = yes_ask - yes_bid

        return {
            "yes_bid": round(yes_bid, 4),
            "yes_ask": round(yes_ask, 4),
            "yes_mid": round((yes_bid + yes_ask) / 2, 4) if yes_bid > 0 else round(yes_ask, 4),
            "spread": round(spread, 4),
        }

    # ── Authenticated Trading ──────────────────────────────────────────────────

    def get_balance(self) -> float | None:
        """Get available cash balance in dollars."""
        data = self._request("GET", "/portfolio/balance")
        if data and "balance" in data:
            return data["balance"] / 100  # cents to dollars
        return None

    def get_positions(self, event_ticker: str = None) -> list:
        """Get open positions."""
        params = {}
        if event_ticker:
            params["event_ticker"] = event_ticker
        data = self._request("GET", "/portfolio/positions", params=params)
        return data.get("market_positions", []) if data else []

    def place_order(
        self,
        ticker: str,
        side: str = "yes",
        action: str = "buy",
        count: int = 10,
        price: float = 0.10,
    ) -> dict | None:
        """
        Place a limit order on Kalshi.
        price is in dollars (e.g., 0.10 = 10 cents).
        """
        body = {
            "ticker": ticker,
            "action": action,
            "side": side,
            "count_fp": f"{count:.2f}",
            "yes_price_dollars": f"{price:.4f}",
            "client_order_id": str(uuid.uuid4()),
            "time_in_force": "good_till_canceled",
        }

        log.info(f"ORDER: {action} {count}x {ticker} {side} @ ${price:.2f}")
        data = self._request("POST", "/portfolio/orders", json=body)
        if data and "order" in data:
            log.info(f"ORDER OK: {data['order'].get('order_id')}")
        return data

    def cancel_order(self, order_id: str) -> bool:
        """Cancel a resting order."""
        data = self._request("DELETE", f"/portfolio/orders/{order_id}")
        return data is not None

    def get_orders(self, status: str = "resting") -> list:
        """Get orders by status."""
        data = self._request("GET", "/portfolio/orders", params={"status": status})
        return data.get("orders", []) if data else []

    def get_fills(self, ticker: str = None, limit: int = 50) -> list:
        """Get recent fills."""
        params = {"limit": limit}
        if ticker:
            params["ticker"] = ticker
        data = self._request("GET", "/portfolio/fills", params=params)
        return data.get("fills", []) if data else []
