"""
Hedge 360 accounts: email and password sign-in, the trading profile, a profile picture, notes, a trading journal and
ticker data (a blacklist of stocks kept off the Screener, and notes on stocks), stored in PostgreSQL (db.py).

Passwords are hashed with Argon2id, as bison_web does; the plaintext is never stored or logged. A sign-in creates a
random session token: the browser keeps it in an HttpOnly cookie (SameSite=Lax, 30 days) and the database keeps only
its SHA-256, so signing out, or changing the password, ends it for real.

    POST   /api/auth/signup        {email, password, name}   create an account and sign in
    POST   /api/auth/login         {email, password}         sign in
    POST   /api/auth/logout                                   sign out (this browser)
    GET    /api/auth/me                                       the signed-in user, or 401

    PATCH  /api/me                 {name}                     rename
    PUT    /api/me/profile         {capital, time, appetite, done}
    POST   /api/me/password        {current, new}             change password; signs out other browsers
    GET    /api/me/avatar          the picture   PUT it (raw JPEG/PNG/WebP body, up to 1 MB)   DELETE it

    GET/POST /api/notes            PATCH/DELETE /api/notes/{id}
    GET/POST /api/journal          PATCH/DELETE /api/journal/{id}
    GET    /api/tickers/blacklist  PUT/DELETE /api/tickers/blacklist/{SYMBOL}  {reason}
    GET/POST /api/tickers/notes    PATCH/DELETE /api/tickers/notes/{id}        {symbol, body}

Everything except signup, login and logout needs a session. derivs.py and kite_auth.py put their routers behind
current_user too, so market data and the Zerodha login are for signed-in users only. There is no password reset by
email: that needs a mail service, which this app doesn't have. Whoever runs the server can set a new one instead:

    .venv/bin/python accounts.py reset-password you@example.com
"""

import hashlib
import os
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

import db

COOKIE = "hedge360_session"
SESSION_DAYS = 30
SECURE = os.environ.get("HEDGE_SECURE_COOKIES") == "1"  # set when served over HTTPS
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
AVATAR_MAX = 1_000_000
FAILS, FAIL_WINDOW = 5, 15 * 60  # failed sign-ins per email before a pause, and how long that pause lasts

_ph = PasswordHasher()
_DUMMY = _ph.hash("not a real password")  # verified against for unknown emails, so timing doesn't tell them apart
_fails = {}  # email -> [failure times]
_fails_lock = threading.Lock()

auth_router = APIRouter(prefix="/api/auth", tags=["account"])


# ── Sessions ───────────────────────────────────────────
def _digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _start_session(response, user_id):
    token = secrets.token_urlsafe(32)
    with db.conn() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < now()")
        c.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)",
                  (_digest(token), user_id, datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)))
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=SECURE,
                        path="/")


USER_COLS = "u.id, u.email, u.name, u.avatar_version, (u.avatar IS NOT NULL) AS has_avatar, u.capital, " \
            "u.trading_time, u.appetite, u.onboarded, u.created_at"


def user_from_request(request):
    """The signed-in user as a dict, or None."""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with db.conn() as c:
        return c.execute(f"SELECT {USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id "
                         "WHERE s.token_hash = %s AND s.expires_at > now()", (_digest(token),)).fetchone()


def current_user(request: Request):
    user = user_from_request(request)
    if not user:
        raise HTTPException(401, "Sign in to Hedge 360 first.")
    return user


def _public(u):
    return {
        "id": u["id"], "email": u["email"], "name": u["name"], "createdAt": u["created_at"].isoformat(),
        "avatar": f"/api/me/avatar?v={u['avatar_version']}" if u["has_avatar"] else None,
        "profile": {"capital": float(u["capital"]) if u["capital"] is not None else None, "time": u["trading_time"],
                    "appetite": u["appetite"], "done": u["onboarded"]},
    }


def _me(user_id):
    with db.conn() as c:
        return _public(c.execute(f"SELECT {USER_COLS} FROM users u WHERE u.id = %s", (user_id,)).fetchone())


# ── Sign up, sign in, sign out ─────────────────────────
class SignUp(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=256)
    name: str = Field("", max_length=80)


class SignIn(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=256)


def _check_password(p):
    if len(p) < 8:
        raise HTTPException(400, "Use at least 8 characters for the password.")


@auth_router.post("/signup")
def signup(body: SignUp, response: Response):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    _check_password(body.password)
    name = body.name.strip() or email.split("@")[0]
    with db.conn() as c:
        if c.execute("SELECT 1 FROM users WHERE lower(email) = %s", (email,)).fetchone():
            raise HTTPException(409, "There's already an account with that email. Sign in instead.")
        uid = c.execute("INSERT INTO users (email, password_hash, name) VALUES (%s, %s, %s) RETURNING id",
                        (email, _ph.hash(body.password), name)).fetchone()["id"]
    _start_session(response, uid)
    return _me(uid)


def _throttled(email):
    now = time.time()
    with _fails_lock:
        recent = [t for t in _fails.get(email, []) if now - t < FAIL_WINDOW]
        _fails[email] = recent
        return len(recent) >= FAILS


def _failed(email):
    with _fails_lock:
        _fails.setdefault(email, []).append(time.time())


@auth_router.post("/login")
def login(body: SignIn, response: Response):
    email = body.email.strip().lower()
    if _throttled(email):
        raise HTTPException(429, "Too many wrong passwords for this email. Try again in 15 minutes.")
    with db.conn() as c:
        row = c.execute("SELECT id, password_hash FROM users WHERE lower(email) = %s", (email,)).fetchone()
    try:
        _ph.verify(row["password_hash"] if row else _DUMMY, body.password)
        ok = row is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        ok = False
    if not ok:
        _failed(email)
        raise HTTPException(401, "That email and password don't match an account.")
    with _fails_lock:
        _fails.pop(email, None)
    if _ph.check_needs_rehash(row["password_hash"]):
        with db.conn() as c:
            c.execute("UPDATE users SET password_hash = %s WHERE id = %s", (_ph.hash(body.password), row["id"]))
    _start_session(response, row["id"])
    return _me(row["id"])


@auth_router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db.conn() as c:
            c.execute("DELETE FROM sessions WHERE token_hash = %s", (_digest(token),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@auth_router.get("/me")
def me(user=Depends(current_user)):
    return _public(user)


# ── Profile, password, picture ─────────────────────────
me_router = APIRouter(prefix="/api/me", tags=["account"], dependencies=[Depends(current_user)])


class Rename(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class TradingProfile(BaseModel):
    capital: float | None = Field(None, ge=0, le=1e12)
    time: Literal["weekly", "30m", "2h", "full"] | None = None
    appetite: Literal["conservative", "moderate", "aggressive"] | None = None
    done: bool = False


class NewPassword(BaseModel):
    current: str = Field(..., max_length=256)
    new: str = Field(..., max_length=256)


@me_router.patch("")
def rename(body: Rename, user=Depends(current_user)):
    with db.conn() as c:
        c.execute("UPDATE users SET name = %s WHERE id = %s", (body.name.strip(), user["id"]))
    return _me(user["id"])


@me_router.put("/profile")
def save_profile(body: TradingProfile, user=Depends(current_user)):
    with db.conn() as c:
        c.execute("UPDATE users SET capital = %s, trading_time = %s, appetite = %s, onboarded = %s WHERE id = %s",
                  (body.capital, body.time, body.appetite, body.done, user["id"]))
    return _me(user["id"])


@me_router.post("/password")
def change_password(body: NewPassword, request: Request, user=Depends(current_user)):
    _check_password(body.new)
    with db.conn() as c:
        current_hash = c.execute("SELECT password_hash FROM users WHERE id = %s", (user["id"],)).fetchone()["password_hash"]
        try:
            _ph.verify(current_hash, body.current)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            raise HTTPException(400, "The current password isn't right.") from None
        c.execute("UPDATE users SET password_hash = %s WHERE id = %s", (_ph.hash(body.new), user["id"]))
        # Other browsers signed in with the old password are signed out; this one stays in.
        c.execute("DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
                  (user["id"], _digest(request.cookies.get(COOKIE, ""))))
    return {"ok": True}


def _image_type(data):
    """The real type from the first bytes; the declared Content-Type is not trusted. SVG is never accepted."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@me_router.get("/avatar")
def get_avatar(user=Depends(current_user)):
    with db.conn() as c:
        row = c.execute("SELECT avatar, avatar_type FROM users WHERE id = %s", (user["id"],)).fetchone()
    if not row["avatar"]:
        raise HTTPException(404, "No profile picture.")
    return Response(bytes(row["avatar"]), media_type=row["avatar_type"],
                    headers={"Cache-Control": "private, max-age=31536000", "X-Content-Type-Options": "nosniff"})


@me_router.put("/avatar")
async def put_avatar(request: Request, user=Depends(current_user)):
    data = await request.body()
    if len(data) > AVATAR_MAX:
        raise HTTPException(413, "That picture is over 1 MB.")
    kind = _image_type(data)
    if not kind:
        raise HTTPException(400, "Use a JPEG, PNG or WebP picture.")
    with db.conn() as c:
        c.execute("UPDATE users SET avatar = %s, avatar_type = %s, avatar_version = avatar_version + 1 WHERE id = %s",
                  (data, kind, user["id"]))
    return _me(user["id"])


@me_router.delete("/avatar")
def delete_avatar(user=Depends(current_user)):
    with db.conn() as c:
        c.execute("UPDATE users SET avatar = NULL, avatar_type = NULL, avatar_version = avatar_version + 1 WHERE id = %s",
                  (user["id"],))
    return _me(user["id"])


# ── Notes ──────────────────────────────────────────────
notes_router = APIRouter(prefix="/api/notes", tags=["notes"], dependencies=[Depends(current_user)])


class Note(BaseModel):
    title: str | None = Field(None, max_length=200)
    body: str | None = Field(None, max_length=50_000)
    pinned: bool | None = None


def _note(r):
    return {"id": r["id"], "title": r["title"], "body": r["body"], "pinned": r["pinned"],
            "createdAt": r["created_at"].isoformat(), "updatedAt": r["updated_at"].isoformat()}


@notes_router.get("")
def list_notes(user=Depends(current_user)):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM notes WHERE user_id = %s ORDER BY pinned DESC, updated_at DESC",
                         (user["id"],)).fetchall()
    return [_note(r) for r in rows]


@notes_router.post("")
def add_note(body: Note, user=Depends(current_user)):
    with db.conn() as c:
        r = c.execute("INSERT INTO notes (user_id, title, body, pinned) VALUES (%s, %s, %s, %s) RETURNING *",
                      (user["id"], body.title or "", body.body or "", bool(body.pinned))).fetchone()
    return _note(r)


def _update(table, row_id, user_id, fields):
    """UPDATE one of this user's rows; 404 when it isn't theirs. Column names come from the models, never the client."""
    sets = {k: v for k, v in fields.items() if v is not None}
    with db.conn() as c:
        if sets:
            cols = ", ".join(f"{k} = %s" for k in sets)
            r = c.execute(f"UPDATE {table} SET {cols}, updated_at = now() WHERE id = %s AND user_id = %s RETURNING *",
                          (*sets.values(), row_id, user_id)).fetchone()
        else:
            r = c.execute(f"SELECT * FROM {table} WHERE id = %s AND user_id = %s", (row_id, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Not found.")
    return r


@notes_router.patch("/{note_id}")
def edit_note(note_id: int, body: Note, user=Depends(current_user)):
    return _note(_update("notes", note_id, user["id"], body.model_dump()))


@notes_router.delete("/{note_id}")
def delete_note(note_id: int, user=Depends(current_user)):
    with db.conn() as c:
        if not c.execute("DELETE FROM notes WHERE id = %s AND user_id = %s RETURNING id", (note_id, user["id"])).fetchone():
            raise HTTPException(404, "Not found.")
    return {"ok": True}


# ── Ticker data: blacklist and notes on stocks ─────────
tickers_router = APIRouter(prefix="/api/tickers", tags=["tickers"], dependencies=[Depends(current_user)])
SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9&-]{0,29}$")  # NSE symbols, such as RELIANCE, M&M, BAJAJ-AUTO


def _symbol(v):
    s = (v or "").strip().upper()
    if not SYMBOL_RE.fullmatch(s):
        raise HTTPException(422, "That isn't a stock symbol, such as RELIANCE or M&M.")
    return s


class Blacklisting(BaseModel):
    reason: str = Field("", max_length=500)


class StockNote(BaseModel):
    symbol: str | None = Field(None, max_length=30)
    body: str | None = Field(None, max_length=20_000)


def _listed(r):
    return {"symbol": r["symbol"], "reason": r["reason"], "addedAt": r["created_at"].isoformat()}


def _stock_note(r):
    return {"id": r["id"], "symbol": r["symbol"], "body": r["body"],
            "createdAt": r["created_at"].isoformat(), "updatedAt": r["updated_at"].isoformat()}


@tickers_router.get("/blacklist")
def list_blacklist(user=Depends(current_user)):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM blacklist WHERE user_id = %s ORDER BY symbol", (user["id"],)).fetchall()
    return [_listed(r) for r in rows]


@tickers_router.put("/blacklist/{symbol}")
def blacklist(symbol: str, body: Blacklisting, user=Depends(current_user)):
    """Adds the stock, or changes its reason."""
    with db.conn() as c:
        r = c.execute("""INSERT INTO blacklist (user_id, symbol, reason) VALUES (%s, %s, %s)
                         ON CONFLICT (user_id, symbol) DO UPDATE SET reason = EXCLUDED.reason RETURNING *""",
                      (user["id"], _symbol(symbol), body.reason.strip())).fetchone()
    return _listed(r)


@tickers_router.delete("/blacklist/{symbol}")
def unblacklist(symbol: str, user=Depends(current_user)):
    with db.conn() as c:
        if not c.execute("DELETE FROM blacklist WHERE user_id = %s AND symbol = %s RETURNING symbol",
                         (user["id"], _symbol(symbol))).fetchone():
            raise HTTPException(404, "Not on your blacklist.")
    return {"ok": True}


@tickers_router.get("/notes")
def list_stock_notes(user=Depends(current_user)):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM stock_notes WHERE user_id = %s ORDER BY updated_at DESC, id DESC",
                         (user["id"],)).fetchall()
    return [_stock_note(r) for r in rows]


@tickers_router.post("/notes")
def add_stock_note(body: StockNote, user=Depends(current_user)):
    if not (body.body or "").strip():
        raise HTTPException(422, "Write the note first.")
    with db.conn() as c:
        r = c.execute("INSERT INTO stock_notes (user_id, symbol, body) VALUES (%s, %s, %s) RETURNING *",
                      (user["id"], _symbol(body.symbol), body.body.strip())).fetchone()
    return _stock_note(r)


@tickers_router.patch("/notes/{note_id}")
def edit_stock_note(note_id: int, body: StockNote, user=Depends(current_user)):
    if body.body is not None and not body.body.strip():
        raise HTTPException(422, "A note can't be empty; delete it instead.")
    fields = {"symbol": _symbol(body.symbol) if body.symbol is not None else None,
              "body": body.body.strip() if body.body is not None else None}
    return _stock_note(_update("stock_notes", note_id, user["id"], fields))


@tickers_router.delete("/notes/{note_id}")
def delete_stock_note(note_id: int, user=Depends(current_user)):
    with db.conn() as c:
        if not c.execute("DELETE FROM stock_notes WHERE id = %s AND user_id = %s RETURNING id", (note_id, user["id"])).fetchone():
            raise HTTPException(404, "Not found.")
    return {"ok": True}


# ── Trading journal ────────────────────────────────────
journal_router = APIRouter(prefix="/api/journal", tags=["journal"], dependencies=[Depends(current_user)])


class Entry(BaseModel):
    entry_date: date | None = Field(None, alias="date")
    title: str | None = Field(None, max_length=200)
    symbol: str | None = Field(None, max_length=40)
    outcome: Literal["profit", "loss", "breakeven", ""] | None = None
    pnl: float | None = Field(None, ge=-1e12, le=1e12)
    body: str | None = Field(None, max_length=50_000)
    tags: list[str] | None = Field(None, max_length=20)

    @field_validator("tags")
    @classmethod
    def _clean_tags(cls, v):
        return None if v is None else list(dict.fromkeys(t.strip()[:30] for t in v if t.strip()))


def _entry(r):
    return {"id": r["id"], "date": r["entry_date"].isoformat(), "title": r["title"], "symbol": r["symbol"],
            "outcome": r["outcome"], "pnl": float(r["pnl"]) if r["pnl"] is not None else None, "body": r["body"],
            "tags": r["tags"], "createdAt": r["created_at"].isoformat(), "updatedAt": r["updated_at"].isoformat()}


@journal_router.get("")
def list_journal(user=Depends(current_user)):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM journal WHERE user_id = %s ORDER BY entry_date DESC, id DESC",
                         (user["id"],)).fetchall()
    return [_entry(r) for r in rows]


@journal_router.post("")
def add_entry(body: Entry, user=Depends(current_user)):
    if not (body.title or "").strip():
        raise HTTPException(400, "Give the entry a title.")
    with db.conn() as c:
        r = c.execute(
            "INSERT INTO journal (user_id, entry_date, title, symbol, outcome, pnl, body, tags) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
            (user["id"], body.entry_date or date.today(), body.title.strip(), (body.symbol or "").strip().upper(),
             body.outcome or None, body.pnl, body.body or "", body.tags or [])).fetchone()
    return _entry(r)


@journal_router.patch("/{entry_id}")
def edit_entry(entry_id: int, body: Entry, user=Depends(current_user)):
    fields = body.model_dump()
    if fields["title"] is not None and not fields["title"].strip():
        raise HTTPException(400, "Give the entry a title.")
    if fields["symbol"] is not None:
        fields["symbol"] = fields["symbol"].strip().upper()
    if fields["outcome"] == "":
        fields["outcome"] = None
    r = _update("journal", entry_id, user["id"], fields)
    # _update leaves out None, so clearing the outcome ("") or the P&L (null) is its own statement.
    clear = [k for k, on in (("outcome", body.outcome == ""), ("pnl", "pnl" in body.model_fields_set and body.pnl is None)) if on]
    if clear:
        with db.conn() as c:
            r = c.execute(f"UPDATE journal SET {', '.join(f'{k} = NULL' for k in clear)} WHERE id = %s AND user_id = %s "
                          "RETURNING *", (entry_id, user["id"])).fetchone()
    return _entry(r)


@journal_router.delete("/{entry_id}")
def delete_entry(entry_id: int, user=Depends(current_user)):
    with db.conn() as c:
        if not c.execute("DELETE FROM journal WHERE id = %s AND user_id = %s RETURNING id", (entry_id, user["id"])).fetchone():
            raise HTTPException(404, "Not found.")
    return {"ok": True}


def _reset_password(email):
    """Sets a new password typed at the terminal and signs the account out everywhere."""
    import getpass
    with db.conn() as c:
        row = c.execute("SELECT id FROM users WHERE lower(email) = lower(%s)", (email,)).fetchone()
    if not row:
        raise SystemExit(f"No account for {email}.")
    new = getpass.getpass("New password: ")
    if len(new) < 8:
        raise SystemExit("Use at least 8 characters.")
    if getpass.getpass("Again: ") != new:
        raise SystemExit("The two passwords don't match.")
    with db.conn() as c:
        c.execute("UPDATE users SET password_hash = %s WHERE id = %s", (_ph.hash(new), row["id"]))
        c.execute("DELETE FROM sessions WHERE user_id = %s", (row["id"],))
    print(f"Password changed for {email}. Every browser signed in to it has been signed out.")


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3 or sys.argv[1] != "reset-password":
        raise SystemExit("Usage: python accounts.py reset-password EMAIL")
    _reset_password(sys.argv[2])
