"""
Daily bars of every F&O stock in PostgreSQL (fno_daily), for the Screener's 52-week high and low. Kite's quotes carry
no 52-week range, so this keeps a year of Kite day candles, the way bison_web keeps its historical_data table.

  - kite_sectors calls fill() after each pass; only the day's first pass starts one. In a background thread, one
    GET /instruments/historical/<token>/day per stock (Kite allows three a second, kite_client paces them): a year
    for a stock with nothing stored, otherwise the days since its `through` in fno_history. About 220 calls, a
    couple of minutes, the first time; the same number of small calls on each later day.
  - Bars stop at yesterday. The range is read over the year to the last stored session, as NSE counts it (its
    52-week figures include the day a year before the last session), and today's high and low come from the pass's
    quotes (ranges()), so a new high shows at once.
  - Kite's candles are adjusted for dividends: before an ex-date, prices are scaled down (COALINDIA's 30 Apr 2026
    high is 491.25 on NSE, 478.90 from Kite). So for a stock that paid one in the year, the range can sit a few
    percent below NSE's traded figures.
  - A top-up starts OVERLAP days before `through` and compares those closes with the stored ones: if a split or
    bonus re-priced the past, the stock's whole year is fetched again.
  - `through` is the last day asked for, not the last bar, so a weekend or holiday isn't asked for again.
  - One transaction per stock, so a fill that stops (a server restart, an expired session) carries on where it
    stopped. A failed fill runs again on a later pass, at most every RETRY seconds.

Read only, like the rest of the Kite code: candles in, nothing sent.
"""

import logging
import threading
import time
from datetime import date, datetime, timedelta

from fastapi import HTTPException

import db
import kite_client
from scanner import IST

YEAR = 372       # days of candles a stock starts with: a year before the last session, even after a long holiday
KEEP = 400       # bars older than this many days are deleted
OVERLAP = 5      # days a top-up re-reads to notice a split or bonus
RETRY = 300
BACKGROUND = True  # tests set False to fill in the calling thread

log = logging.getLogger("kite_history")
_lock = threading.Lock()
_state = {"day": None, "running": False, "done": 0, "total": 0, "error": None, "tried": 0.0}
_cache = {"day": None, "ranges": {}}


def _today():
    return datetime.now(IST).date()


def status():
    """{state: idle | filling | ready | error, done, total, error} for the Screener."""
    s = _state
    state = "filling" if s["running"] else "error" if s["error"] else "ready" if s["day"] == _today() else "idle"
    return {"state": state, "done": s["done"], "total": s["total"], "error": s["error"]}


def fill(tokens):
    """Bring every stock's bars up to yesterday. tokens: {SYMBOL: instrument_token}. Does nothing once today's fill
    has finished, while one runs, or within RETRY seconds of a failed one."""
    with _lock:
        s = _state
        if not tokens or s["running"] or s["day"] == _today() or s["error"] and time.monotonic() - s["tried"] < RETRY:
            return
        s.update(running=True, done=0, total=len(tokens), error=None, tried=time.monotonic())
    if BACKGROUND:
        threading.Thread(target=_run, args=(dict(tokens),), name="kite-history", daemon=True).start()
    else:
        _run(dict(tokens))


def _run(tokens):
    today, error = _today(), None
    end = today - timedelta(days=1)
    try:
        api = kite_client.KiteHTTPAPI()
        with db.conn() as c:
            through = {r["symbol"]: r["through"] for r in c.execute("SELECT symbol, through FROM fno_history")}
        for symbol, token in sorted(tokens.items()):
            if through.get(symbol) is None or through[symbol] < end:
                _stock(api, symbol, token, through.get(symbol), end)
                _cache["day"] = None
            _state["done"] += 1
    except (kite_client.KiteError, HTTPException) as e:
        error = getattr(e, "detail", None) or str(e)
    except Exception as e:  # noqa: BLE001 - recorded and shown; the next pass tries again
        log.exception("history fill failed")
        error = str(e)
    if error:
        log.warning("history fill stopped at %s of %s: %s", _state["done"], _state["total"], error)
    with _lock:
        _state.update(running=False, error=error, day=None if error else today)
    _cache["day"] = None


def _candles(api, token, start, end):
    """[(day, open, high, low, close, volume)] up to `end`. One stock Kite can't answer gives []; an expired session,
    missing permission or repeated rate limit stops the fill (KiteError)."""
    for attempt in range(3):
        try:
            got = api.day_candles(token, start, end)
            break
        except kite_client.KiteError as e:
            msg = str(e)
            if "rate limit" in msg and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            if e.status == 503 or "Permission" in msg:
                raise
            log.warning("no candles for token %s: %s", token, msg)
            return []
    rows = [(date.fromisoformat(t[:10]), o, h, lo, c, int(v or 0)) for t, o, h, lo, c, v, *_ in got]
    return [r for r in rows if start <= r[0] <= end]


def _stock(api, symbol, token, through, end):
    start = through - timedelta(days=OVERLAP) if through else end - timedelta(days=YEAR)
    bars = _candles(api, token, start, end)
    with db.conn() as c:
        if through:
            stored = {r["day"]: r["close"] for r in c.execute(
                "SELECT day, close FROM fno_daily WHERE symbol = %s AND day >= %s", (symbol, start))}
            if any(d in stored and abs(stored[d] - cl) > 0.005 * cl for d, _, _, _, cl, _ in bars):
                log.info("%s: past closes changed (split or bonus?); fetching its year again", symbol)
                start = end - timedelta(days=YEAR)
                bars = _candles(api, token, start, end)
                c.execute("DELETE FROM fno_daily WHERE symbol = %s", (symbol,))
        with c.cursor() as cur:
            cur.executemany(
                """INSERT INTO fno_daily (symbol, day, open, high, low, close, volume) VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (symbol, day) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                   close = EXCLUDED.close, volume = EXCLUDED.volume""",
                [(symbol, *b) for b in bars])
        c.execute("DELETE FROM fno_daily WHERE symbol = %s AND day < %s", (symbol, end - timedelta(days=KEEP)))
        c.execute("""INSERT INTO fno_history (symbol, token, through) VALUES (%s, %s, %s)
                     ON CONFLICT (symbol) DO UPDATE SET token = EXCLUDED.token, through = EXCLUDED.through, checked_at = now()""",
                  (symbol, int(token), end))


def ranges(today_hl=None):
    """{SYMBOL: (52-week high, low)} from the stored bars of the year to the last session, with today's
    {SYMBOL: (high, low)} folded in. Stocks with no stored bars are left out; {} while the database is down."""
    today = _today()
    if _cache["day"] != today:
        try:
            with db.conn() as c:
                rows = c.execute("""SELECT symbol, max(high) AS hi, min(low) AS lo FROM fno_daily
                                    WHERE day >= (SELECT max(day) FROM fno_daily) - interval '1 year' GROUP BY symbol""").fetchall()
        except HTTPException:
            return {}
        _cache.update(day=today, ranges={r["symbol"]: (r["hi"], r["lo"]) for r in rows})
    out = {}
    for symbol, (hi, lo) in _cache["ranges"].items():
        h, low = (today_hl or {}).get(symbol) or (None, None)
        out[symbol] = (round(max(hi, h) if h else hi, 2), round(min(lo, low) if low else lo, 2))
    return out
