"""
Daily Kite login for the analytics API. Run it each morning; the token it saves lasts until 06:00 IST tomorrow.

    export KITE_API_KEY=...      # from your Kite Connect app at developers.kite.trade
    export KITE_API_SECRET=...
    python kite_login.py

It prints the Kite login URL. Log in there, then paste the URL Kite redirects you to (or just its request_token).
The access token is saved to .kite_session.json (git-ignored, readable only by you). Nothing secret is printed.

The exchange is the one in bison_web/risk_man/backend/routers/auth.py: POST /session/token with
checksum = sha256(api_key + request_token + api_secret).
"""

import hashlib
import json
import os
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

from kite_client import SESSION_FILE


def hint(message):
    m = (message or "").lower()
    if "checksum" in m:
        return " Your API key and API secret must come from the same Kite Connect app."
    if "token" in m and ("expired" in m or "invalid" in m):
        return " A request_token works once and only for a few minutes: log in again for a fresh one."
    return ""


def main():
    api_key, api_secret = os.environ.get("KITE_API_KEY"), os.environ.get("KITE_API_SECRET")
    if not (api_key and api_secret):
        sys.exit("Set KITE_API_KEY and KITE_API_SECRET first (from your app at developers.kite.trade).")

    print(f"1. Log in here:\n   https://kite.zerodha.com/connect/login?v=3&api_key={api_key}\n")
    pasted = input("2. Paste the URL Kite sent you to (or its request_token): ").strip()
    request_token = parse_qs(urlparse(pasted).query).get("request_token", [pasted])[0]
    if not request_token:
        sys.exit("No request_token found.")

    checksum = hashlib.sha256(f"{api_key}{request_token}{api_secret}".encode()).hexdigest()
    resp = requests.post("https://api.kite.trade/session/token", headers={"X-Kite-Version": "3"},
                         data={"api_key": api_key, "request_token": request_token, "checksum": checksum}, timeout=30)
    result = resp.json()
    if result.get("status") != "success":
        message = result.get("message", "Unknown error")
        sys.exit(f"Kite refused the login: {message}.{hint(message)}")

    data = result["data"]
    # Created owner-only from the start, so the token is never readable by others even for a moment.
    fd = os.open(SESSION_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"api_key": api_key, "access_token": data["access_token"],
                   "user_id": data.get("user_id"), "login_timestamp": time.time()}, f)
    SESSION_FILE.chmod(0o600)
    print(f"Logged in as {data.get('user_name') or data.get('user_id')}. Session saved to {SESSION_FILE.name}. "
          "A running API picks it up on its next request.")


if __name__ == "__main__":
    main()
