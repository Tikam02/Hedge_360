"""
PostgreSQL for accounts, profiles, notes, the trading journal and ticker data (blacklist, stock notes) (accounts.py),
for the day's rows of Kite's instrument list and the F&O stock list with its joins and exits (kite_chain.py), and for
the F&O stocks' daily bars behind the Screener's 52-week range (kite_history.py).

    docker compose up -d        # PostgreSQL 16 on 127.0.0.1:5434, from docker-compose.yml

DATABASE_URL points elsewhere, for example at a system PostgreSQL:

    sudo -u postgres createuser --pwprompt hedge360 && sudo -u postgres createdb -O hedge360 hedge360
    DATABASE_URL=postgresql://hedge360:<password>@127.0.0.1:5432/hedge360 .venv/bin/uvicorn server:app --port 8060

Nothing connects at import time, so the market data code and the GitHub Pages export run without a database. The
first request that needs one opens the pool and creates any missing tables; while the database is down those requests
answer 503 with how to start it.
"""

import os
import threading
from contextlib import contextmanager

import psycopg
from fastapi import HTTPException
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

URL = os.environ.get("DATABASE_URL", "postgresql://hedge360:hedge360@127.0.0.1:5434/hedge360")
DOWN = "The database isn't reachable. Start it from the project root with: docker compose up -d"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             bigserial PRIMARY KEY,
    email          text NOT NULL,
    password_hash  text NOT NULL,
    name           text NOT NULL DEFAULT '',
    avatar         bytea,
    avatar_type    text,
    avatar_version integer NOT NULL DEFAULT 0,
    capital        numeric,
    trading_time   text CHECK (trading_time IN ('weekly', '30m', '2h', 'full')),
    appetite       text CHECK (appetite IN ('conservative', 'moderate', 'aggressive')),
    onboarded      boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS notes (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
    title      text NOT NULL DEFAULT '',
    body       text NOT NULL DEFAULT '',
    pinned     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_user ON notes (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS journal (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
    entry_date date NOT NULL DEFAULT current_date,
    title      text NOT NULL,
    symbol     text NOT NULL DEFAULT '',
    outcome    text CHECK (outcome IN ('profit', 'loss', 'breakeven')),
    pnl        numeric,
    body       text NOT NULL DEFAULT '',
    tags       text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_user ON journal (user_id, entry_date DESC, id DESC);

-- Today's rows of Kite's instrument list that the app uses, its columns as Kite sends them: futures (instrument_type
-- FUT, segment NFO-FUT) and options (CE / PE, NFO-OPT) from NFO and BFO, stocks (EQ, segment NSE) and indices
-- (segment INDICES) from NSE and BSE. Replaced each day.
CREATE TABLE IF NOT EXISTS kite_instruments (
    exchange         text NOT NULL,
    tradingsymbol    text NOT NULL,
    instrument_token bigint NOT NULL,
    exchange_token   bigint,
    name             text NOT NULL,
    last_price       double precision,
    expiry           date,
    strike           double precision NOT NULL DEFAULT 0,
    tick_size        double precision NOT NULL,
    lot_size         integer NOT NULL,
    instrument_type  text NOT NULL,
    segment          text NOT NULL,
    day              date NOT NULL,
    PRIMARY KEY (exchange, tradingsymbol)
);

-- The F&O stock list as each day's instrument list has it, and the stocks that joined or left it.
CREATE TABLE IF NOT EXISTS fno_stocks (
    symbol      text PRIMARY KEY,
    token       bigint NOT NULL,
    lot         integer NOT NULL,
    first_seen  date NOT NULL,
    last_seen   date NOT NULL,
    last_expiry date NOT NULL
);
CREATE TABLE IF NOT EXISTS fno_changes (
    day    date NOT NULL,
    symbol text NOT NULL,
    change text NOT NULL CHECK (change IN ('in', 'out')),
    PRIMARY KEY (day, symbol)
);

-- Each account's own ticker data: stocks it keeps off the Screener, and its notes on stocks.
CREATE TABLE IF NOT EXISTS blacklist (
    user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
    symbol     text NOT NULL,
    reason     text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, symbol)
);
CREATE TABLE IF NOT EXISTS stock_notes (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users ON DELETE CASCADE,
    symbol     text NOT NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_notes_user ON stock_notes (user_id, symbol, updated_at DESC);

-- Kite day candles of every F&O stock, about a year each; shared by every account, like the Zerodha connection.
CREATE TABLE IF NOT EXISTS fno_daily (
    symbol text NOT NULL,
    day    date NOT NULL,
    open   double precision NOT NULL,
    high   double precision NOT NULL,
    low    double precision NOT NULL,
    close  double precision NOT NULL,
    volume bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, day)
);

-- Per stock: its Kite instrument token and the last day asked for (weekends and holidays have no bar).
CREATE TABLE IF NOT EXISTS fno_history (
    symbol     text PRIMARY KEY,
    token      bigint NOT NULL,
    through    date NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now()
);
"""

_lock = threading.Lock()
_pool = None


def _open():
    global _pool
    with _lock:
        if _pool is None:
            pool = ConnectionPool(URL, min_size=1, max_size=8, kwargs={"row_factory": dict_row}, open=False)
            try:
                pool.open(wait=True, timeout=5)
                with pool.connection() as c:
                    c.execute(SCHEMA)
            except Exception:
                pool.close()
                raise
            _pool = pool
        return _pool


@contextmanager
def conn():
    """A pooled connection that commits when the block ends (rolls back on error). 503 if the database is down."""
    try:
        pool = _open()
    except (PoolTimeout, psycopg.OperationalError) as e:
        raise HTTPException(503, DOWN) from e
    with pool.connection() as c:
        yield c


def status():
    try:
        with conn() as c:
            c.execute("SELECT 1")
        return "up"
    except HTTPException:
        return "down"
