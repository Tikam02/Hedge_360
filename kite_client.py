"""
Read-only Kite Connect client for the analytics API: the instrument list, market quotes and the margin calculator.

It cannot place, modify or cancel orders, or read positions or holdings: every request goes through _send, which
refuses any path outside READ_ONLY before anything leaves the machine.

Ported from bison_web/risk_man/utils/kite_http_api.py (Kite error handling, quote, instruments and margin calls)
and backend/broker.py (06:00 token expiry), without their order and portfolio code.

Credentials, first found wins:
  - KITE_API_KEY and KITE_ACCESS_TOKEN in the environment
  - .kite_session.json, written by `python kite_login.py`
"""

import gzip
import io
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

BASE_URL = "https://api.kite.trade"
SESSION_FILE = Path(__file__).resolve().parent / ".kite_session.json"

# Kite access tokens are valid until 06:00 IST the next morning.
IST = timezone(timedelta(hours=5, minutes=30))
TOKEN_EXPIRY_HOUR = 6

# Every call this client may make. Orders, positions, holdings and funds are deliberately absent.
READ_ONLY = {
    ("GET", "/quote"), ("GET", "/quote/ohlc"), ("GET", "/quote/ltp"),
    ("POST", "/margins/orders"), ("POST", "/margins/basket"),
}

# Quote calls are paced at one a second, everything else at a few a second. Shared by every thread, because the
# chain page asks for symbols, chain and the 3D grid at the same time.
PACE = {"quote": 1.0, "other": 0.15}
_last_call = {"quote": 0.0, "other": 0.0}
_pace_lock = threading.Lock()

NOT_CONNECTED = "Kite isn't connected. Set KITE_API_KEY and KITE_API_SECRET, then run: python kite_login.py"
EXPIRED = "The Kite session expired at 06:00. Log in again: python kite_login.py"


class KiteError(Exception):
    """A Kite call failed. `status` is what the analytics API answers with; the message is shown in the app."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def allowed(method, path):
    """GET /instruments/<exchange> is allowed too, but not /instruments/historical/... ."""
    if (method, path) in READ_ONLY:
        return True
    return method == "GET" and path.startswith("/instruments/") and path.count("/") == 2


def last_token_expiry(now=None):
    """Epoch of the most recent 06:00 IST. Tokens issued before it are dead."""
    now = now or datetime.now(IST)
    cutoff = now.astimezone(IST).replace(hour=TOKEN_EXPIRY_HOUR, minute=0, second=0, microsecond=0)
    if now < cutoff:
        cutoff -= timedelta(days=1)
    return cutoff.timestamp()


def credentials():
    """(api_key, access_token), or KiteError when there is no live session."""
    key, token = os.environ.get("KITE_API_KEY"), os.environ.get("KITE_ACCESS_TOKEN")
    if key and token:
        return key, token
    try:
        saved = json.loads(SESSION_FILE.read_text())
    except (OSError, ValueError):
        saved = {}
    if not (saved.get("api_key") and saved.get("access_token")):
        raise KiteError(NOT_CONNECTED, 503)
    if float(saved.get("login_timestamp") or 0) < last_token_expiry():
        raise KiteError(EXPIRED, 503)
    return saved["api_key"], saved["access_token"]


def connected():
    try:
        credentials()
        return True
    except KiteError:
        return False


def _pace(path):
    kind = "quote" if path.startswith("/quote") else "other"
    with _pace_lock:
        wait = PACE[kind] - (time.monotonic() - _last_call[kind])
        if wait > 0:
            time.sleep(wait)
        _last_call[kind] = time.monotonic()


def _error(response):
    """Kite errors are {status, message, error_type}: keep Kite's own explanation."""
    message = error_type = None
    try:
        body = response.json()
        message, error_type = body.get("message"), body.get("error_type")
    except ValueError:
        message = (response.text or "").strip()[:300] or None
    if error_type == "TokenException" or response.status_code in (401, 403) and not message:
        return KiteError(EXPIRED, 503)
    if response.status_code == 429:
        return KiteError("Kite's rate limit was hit. Try again in a moment.", 503)
    detail = message or f"HTTP {response.status_code}"
    return KiteError(f"Kite: {detail} ({error_type})" if error_type else f"Kite: {detail}", 502)


class KiteHTTPAPI:
    def __init__(self, api_key=None, access_token=None):
        if not (api_key and access_token):
            api_key, access_token = credentials()
        self.session = requests.Session()
        self.session.headers.update({"X-Kite-Version": "3", "Authorization": f"token {api_key}:{access_token}"})

    def _http(self, method, url, params, body, timeout):
        return self.session.request(method, url, params=params, json=body, timeout=timeout)

    def _send(self, method, path, params=None, body=None, timeout=15):
        if not allowed(method, path):
            raise KiteError(f"Refused {method} {path}: this Kite client is read-only.", 500)
        _pace(path)
        try:
            response = self._http(method, BASE_URL + path, params, body, timeout)
        except requests.exceptions.Timeout:
            raise KiteError("Kite took too long to answer.", 504) from None
        except requests.exceptions.RequestException as e:
            raise KiteError(f"Can't reach Kite: {e}", 502) from None
        if response.status_code >= 400:
            raise _error(response)
        return response

    def _data(self, response):
        body = response.json()
        if body.get("status") != "success":
            raise KiteError(f"Kite: {body.get('message') or 'the call failed'}", 502)
        return body.get("data")

    def _batched(self, path, instruments, size):
        """Keys with no data (expired, or never traded) are simply missing from the answer."""
        out = {}
        for i in range(0, len(instruments), size):
            out.update(self._data(self._send("GET", path, params={"i": instruments[i:i + size]})) or {})
        return out

    def quote(self, instruments):
        """Full quotes (OHLC, OI, volume, depth) for "EXCHANGE:TRADINGSYMBOL" keys, 500 per call."""
        return self._batched("/quote", instruments, 500)

    def ohlc(self, instruments):
        """Last price and OHLC, 1000 per call."""
        return self._batched("/quote/ohlc", instruments, 1000)

    def ltp(self, instruments):
        return self._batched("/quote/ltp", instruments, 1000)

    def instruments(self, exchange):
        """The day's instrument list for one exchange. Kite may send it gzipped."""
        raw = self._send("GET", f"/instruments/{exchange}", timeout=60).content
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return pd.read_csv(io.BytesIO(raw), dtype={"tradingsymbol": str, "name": str, "expiry": str},
                           keep_default_na=False)

    def order_margins(self, orders, mode=None):
        """Margin for each order, counting the account's existing positions and open orders. No order is placed."""
        return self._data(self._send("POST", "/margins/orders", params={"mode": mode} if mode else None, body=orders)) or []

    def basket_margins(self, orders, consider_positions=True, mode=None):
        """Margins for a basket: {initial, final (with spread benefit), orders (each on its own), charges}.
        A calculation only; no order is placed."""
        params = {"consider_positions": "true" if consider_positions else "false"}
        if mode:
            params["mode"] = mode
        return self._data(self._send("POST", "/margins/basket", params=params, body=orders)) or {}
