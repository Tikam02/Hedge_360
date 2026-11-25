"""
Zerodha login for the web app's Profile page. The flow is bison_web/risk_man/backend/routers/auth.py's. There is
one Zerodha connection per server, not per Hedge 360 account: any signed-in account can see its status and TOTP code,
change the saved app, and log in or out, and every account's tabs use it. That suits a server you run for yourself.

  1. Save your own Kite Connect app's API key and secret, and optionally your TOTP secret (from developers.kite.trade
     and your Zerodha 2FA setup). They are kept in .kite_credentials.json, encrypted, owner-only and git-ignored.
     The secrets are never sent back to the browser.
  2. "Log in with Zerodha" opens Kite's own login page. You type your password there and the 6-digit code the
     Profile page shows from your TOTP secret. This server never sees or stores your Zerodha password.
  3. Kite redirects to /api/kite/callback, which swaps the request_token for an access token and saves the session
     to .kite_session.json, where kite_client reads it. The tabs switch to live data on their next request.

The only Kite calls made here are creating and deleting that session. Market data goes through kite_client, which
refuses anything but quotes, the instrument list and margins: nothing in this app can place an order.

    GET    /api/kite/status         connected or not, who, which credentials are saved, the redirect URL to register
    POST   /api/kite/credentials    save api_key / api_secret / totp_secret (a blank field keeps what is saved)
    DELETE /api/kite/credentials    forget them and log out
    GET    /api/kite/totp           the current TOTP code and the seconds it has left
    GET    /api/kite/login          redirect to Kite's login page
    GET    /api/kite/callback       Kite redirects here; then back to the Profile page
    POST   /api/kite/session        swap a pasted redirect URL or request_token (when your app redirects elsewhere)
    DELETE /api/kite/session        log out: Kite invalidates the token and the session file is removed

Without saved credentials, KITE_API_KEY and KITE_API_SECRET from the environment are used (as kite_login.py does).
"""

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import pyotp
import requests
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import kite_client
from accounts import current_user, user_from_request
from scanner import IST

# Signed-in Hedge 360 users only. The Zerodha connection is one per server, shared by its accounts: this is a
# personal app on your own machine. Kite's redirect can't be made to carry a session check, so the callback has its
# own router and checks the cookie itself.
router = APIRouter(prefix="/api/kite", tags=["zerodha"], dependencies=[Depends(current_user)])
callback_router = APIRouter(prefix="/api/kite", tags=["zerodha"])

HERE = Path(__file__).resolve().parent
CRED_FILE = HERE / ".kite_credentials.json"
KEY_FILE = HERE / ".kite_secret.key"
KITE_API = "https://api.kite.trade"
WEB_URL = os.environ.get("HEDGE_WEB_URL", "http://localhost:3000").rstrip("/")
STATE_TTL = 600  # seconds a login started here stays valid

_lock = threading.Lock()
_states = {}  # login state -> time issued; Kite hands it back through redirect_params


# ── Files: owner-only from the moment they exist ───────
def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    path.chmod(0o600)


def _fernet():
    """KITE_SECRET_KEY if set, else a key generated once into .kite_secret.key. Keeping the key in a separate file
    means a copied credentials file alone can't log anyone in; keep both out of backups you share."""
    key = os.environ.get("KITE_SECRET_KEY")
    if key:
        return Fernet(base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest()))
    if not KEY_FILE.exists():
        _write_private(KEY_FILE, Fernet.generate_key().decode())
    return Fernet(KEY_FILE.read_text().strip().encode())


def _load():
    try:
        return json.loads(CRED_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _secret(saved, field):
    """(plaintext, status): status is "absent", "ok", or "unreadable" (saved under a different key)."""
    token = saved.get(field)
    if not token:
        return "", "absent"
    try:
        return _fernet().decrypt(token.encode()).decode(), "ok"
    except (InvalidToken, ValueError):
        return "", "unreadable"


def credentials():
    """{api_key, api_secret, totp_secret, source}: saved ones first, else KITE_API_KEY / KITE_API_SECRET."""
    saved = _load()
    secret, _ = _secret(saved, "api_secret")
    totp, _ = _secret(saved, "totp_secret")
    if saved.get("api_key"):
        return {"api_key": saved["api_key"], "api_secret": secret, "totp_secret": totp, "source": "saved"}
    env_key, env_secret = os.environ.get("KITE_API_KEY"), os.environ.get("KITE_API_SECRET")
    return {"api_key": env_key or "", "api_secret": secret or env_secret or "", "totp_secret": totp,
            "source": "env" if env_key else None}


def _session():
    try:
        return json.loads(kite_client.SESSION_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _hint(message):
    m = (message or "").lower()
    if "checksum" in m:
        return " Your API key and API secret must come from the same Kite Connect app: paste the secret again."
    if "token" in m and ("expired" in m or "invalid" in m):
        return " A login works once and only for a few minutes: log in with Zerodha again."
    return ""


# ── Kite session calls (patched in tests) ──────────────
def _kite(method, path, data=None, params=None):
    resp = requests.request(method, f"{KITE_API}{path}", headers={"X-Kite-Version": "3"}, data=data, params=params,
                            timeout=30)
    try:
        return resp.json()
    except ValueError:
        return {"status": "error", "message": f"Kite answered {resp.status_code}"}


def exchange(request_token):
    """request_token -> saved session. Raises HTTPException with a readable message."""
    c = credentials()
    if not (c["api_key"] and c["api_secret"]):
        raise HTTPException(400, "Save your Kite API key and API secret first.")
    checksum = hashlib.sha256(f"{c['api_key']}{request_token}{c['api_secret']}".encode()).hexdigest()
    try:
        result = _kite("POST", "/session/token",
                       data={"api_key": c["api_key"], "request_token": request_token, "checksum": checksum})
    except requests.RequestException as e:
        raise HTTPException(502, f"Couldn't reach Kite: {e}") from e
    if result.get("status") != "success":
        message = result.get("message", "Unknown error")
        raise HTTPException(400, f"Kite refused the login: {message.rstrip('.')}.{_hint(message)}")
    d = result["data"]
    _write_private(kite_client.SESSION_FILE, json.dumps({
        "api_key": c["api_key"], "access_token": d["access_token"], "user_id": d.get("user_id"),
        "user_name": d.get("user_name"), "broker": d.get("broker"), "login_timestamp": time.time()}))
    return {"user_name": d.get("user_name") or d.get("user_id"), "user_id": d.get("user_id")}


# ── Endpoints ──────────────────────────────────────────
class Credentials(BaseModel):
    """Blank or missing keeps what is saved: the page can't show stored secrets, so empty never means erase."""
    api_key: str | None = Field(None, max_length=64)
    api_secret: str | None = Field(None, max_length=128)
    totp_secret: str | None = Field(None, max_length=128)


class Paste(BaseModel):
    url: str = Field(..., min_length=4, max_length=2048)


@router.get("/status")
def status(request: Request):
    c, saved, s = credentials(), _load(), _session()
    expired = bool(s.get("access_token")) and float(s.get("login_timestamp") or 0) < kite_client.last_token_expiry()
    connected = kite_client.connected()
    logged_in = datetime.fromtimestamp(float(s["login_timestamp"]), IST).isoformat(timespec="seconds") \
        if s.get("login_timestamp") else None
    return {
        "connected": connected, "expired": expired and not connected,
        "user_id": s.get("user_id"), "user_name": s.get("user_name"), "broker": s.get("broker"),
        "login_time": logged_in,
        "api_key": c["api_key"], "source": c["source"],
        "has_api_secret": bool(c["api_secret"]), "has_totp_secret": bool(c["totp_secret"]),
        # Saved, but under a key this server doesn't have (KITE_SECRET_KEY changed): say so instead of "not saved".
        "unreadable": [f for f in ("api_secret", "totp_secret") if _secret(saved, f)[1] == "unreadable"],
        "can_login": bool(c["api_key"] and c["api_secret"]),
        "redirect_url": f"{str(request.base_url).rstrip('/')}/api/kite/callback",
    }


@router.post("/credentials")
def save_credentials(body: Credentials, request: Request):
    clean = {k: (v or "").strip() for k, v in body.model_dump().items()}
    if clean["totp_secret"]:
        clean["totp_secret"] = clean["totp_secret"].replace(" ", "").upper()
        try:
            pyotp.TOTP(clean["totp_secret"]).now()
        except Exception as e:  # noqa: BLE001 (pyotp raises several types for a bad base32 string)
            raise HTTPException(400, "That TOTP secret isn't valid: it is the base32 key (letters A–Z and 2–7) "
                                     "shown under the QR code when you set up 2FA on Zerodha.") from e
    with _lock:
        saved = _load()
        if clean["api_key"]:
            if saved.get("api_key") and saved["api_key"] != clean["api_key"] and not clean["api_secret"]:
                raise HTTPException(400, "A new API key needs its own API secret: paste the secret from the same app.")
            saved["api_key"] = clean["api_key"]
        for field in ("api_secret", "totp_secret"):
            if clean[field]:
                saved[field] = _fernet().encrypt(clean[field].encode()).decode()
        _write_private(CRED_FILE, json.dumps(saved))
    return status(request)


@router.delete("/credentials")
def forget_credentials(request: Request):
    logout()
    with _lock:
        CRED_FILE.unlink(missing_ok=True)
    return status(request)


@router.get("/totp")
def totp():
    secret = credentials()["totp_secret"]
    if not secret:
        raise HTTPException(404, "No TOTP secret saved.")
    return {"code": pyotp.TOTP(secret).now(), "remaining": 30 - int(time.time()) % 30}


@router.get("/login")
def login(popup: bool = False):
    c = credentials()
    if not c["api_key"]:
        raise HTTPException(400, "Save your Kite API key first.")
    state = secrets.token_urlsafe(16)
    now = time.time()
    with _lock:
        for k in [k for k, t in _states.items() if now - t > STATE_TTL]:
            del _states[k]
        _states[state] = now
    # Kite passes redirect_params back to the redirect URL untouched, so the callback knows the login began here
    # (and whether it runs in the Profile page's login window).
    back = f"state={state}" + ("&popup=1" if popup else "")
    return RedirectResponse(f"https://kite.zerodha.com/connect/login?v=3&api_key={quote(c['api_key'])}"
                            f"&redirect_params={quote(back)}")


@callback_router.get("/callback")
async def callback(request: Request, request_token: str | None = None, status: str | None = None,
                   state: str | None = None, popup: str | None = None):
    def back(**q):
        if popup == "1":
            q["popup"] = 1
        return RedirectResponse(f"{WEB_URL}/profile?" + "&".join(f"{k}={quote(str(v))}" for k, v in q.items()))

    with _lock:
        if state:
            issued = _states.pop(state, None)
        else:
            # Kite's docs only say redirect_params are "sent back to the redirect URL". If they don't come back as
            # query parameters, still require a login started from Profile in the last few minutes, and use it up.
            recent = [k for k, t in _states.items() if time.time() - t <= STATE_TTL]
            issued = _states.pop(max(recent, key=_states.get)) if recent else None
    if status != "success" or not request_token:
        return back(kite="failed", detail="Zerodha didn't complete the login.")
    if not await run_in_threadpool(user_from_request, request):
        return back(kite="failed", detail="Sign in to Hedge 360 first, then log in to Zerodha.")
    if not issued or time.time() - issued > STATE_TTL:
        return back(kite="failed", detail="That login didn't start from this app, or took too long. Log in again.")
    try:
        who = await run_in_threadpool(exchange, request_token)
    except HTTPException as e:
        return back(kite="failed", detail=e.detail)
    return back(kite="connected", user=who["user_name"] or "")


@router.post("/session")
async def paste(body: Paste):
    token = parse_qs(urlparse(body.url.strip()).query).get("request_token", [body.url.strip()])[0]
    if not token.isalnum():
        raise HTTPException(400, "No request_token in that. Paste the whole address Kite sent you to.")
    return await run_in_threadpool(exchange, token)


@router.delete("/session")
def logout():
    """Kite invalidates the token (best effort), then the local session is removed."""
    s = _session()
    if s.get("api_key") and s.get("access_token"):
        try:
            _kite("DELETE", "/session/token", params={"api_key": s["api_key"], "access_token": s["access_token"]})
        except requests.RequestException:
            pass
    kite_client.SESSION_FILE.unlink(missing_ok=True)
    return {"connected": False}
