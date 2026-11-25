"""
Daily Kite login from the terminal, the same login the web app's Profile page does. The token it saves lasts until
06:00 IST tomorrow.

    python kite_login.py

Uses the API key and secret saved on the Profile page, or KITE_API_KEY and KITE_API_SECRET from the environment.
It prints the Kite login URL (and your TOTP code, if a TOTP secret is saved). Log in there, then paste the URL Kite
redirects you to (or just its request_token). The session goes to .kite_session.json, owner-only and git-ignored.
Nothing secret is printed.
"""

import sys
from urllib.parse import parse_qs, urlparse

import pyotp
from fastapi import HTTPException

import kite_auth


def main():
    c = kite_auth.credentials()
    if not (c["api_key"] and c["api_secret"]):
        sys.exit("Save your Kite API key and secret on the Profile page, or set KITE_API_KEY and KITE_API_SECRET.")

    print(f"1. Log in here:\n   https://kite.zerodha.com/connect/login?v=3&api_key={c['api_key']}\n")
    if c["totp_secret"]:
        print(f"   TOTP code: {pyotp.TOTP(c['totp_secret']).now()}\n")
    pasted = input("2. Paste the URL Kite sent you to (or its request_token): ").strip()
    request_token = parse_qs(urlparse(pasted).query).get("request_token", [pasted])[0]
    if not request_token:
        sys.exit("No request_token found.")
    try:
        who = kite_auth.exchange(request_token)
    except HTTPException as e:
        sys.exit(e.detail)
    print(f"Logged in as {who['user_name']}. A running API picks the session up on its next request.")


if __name__ == "__main__":
    main()
