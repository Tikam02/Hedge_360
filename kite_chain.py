"""
Kite Connect as the option chain source. derivs.py uses it while a Zerodha session is live (log in on the web app's
Profile page, see kite_auth.py), or always when the API is started with it:

    DERIVS_CHAIN_SOURCE=kite_chain .venv/bin/uvicorn server:app --port 8060

Read only: the instrument list, market quotes and the margin calculator, through kite_client, which refuses every
other call. Instruments are told apart only by the list's own columns: futures are instrument_type FUT in segment
NFO-FUT, options CE / PE in NFO-OPT (BFO the same), stocks EQ in segment NSE, indices segment INDICES. The day's rows
are kept in PostgreSQL (kite_instruments), so a restart reads them back instead of asking Kite again, and the F&O
stock list is recorded each day (fno_stocks, fno_changes): fno_list() says which stocks joined, left or are leaving. Nothing here can place an order. With this chain source, Sectoral analysis comes from Kite too
(kite_sectors.py, named by SECTOR_SOURCE below).

Gives the three functions derivs.py reads from any chain source (underlyings, expiries, chain, in derivs_sample's
shapes), plus:
  - margins(symbol, expiry, strikes): Kite's margin to sell one lot of each contract on its own (NRML).
  - prefetch(symbol, expiries): quotes several expiries in one call before the 3D view reads them.
  - status(): "live", or "offline" when there is no valid Kite session.

What Kite's quote doesn't carry is worked out here:
  - IV and delta, from each option's price, the way NSE's option chain does it: Black-Scholes on spot, 6.5% rate,
    days to expiry not counting today. Checked against NSE's chain: within 0.05 IV points on average.
  - Change in OI: the quote has no previous-day OI, so it is measured from the first OI seen each trading day, kept
    in .kite_cache/. Start the API before 9:15 and that first reading is the previous close.
  - OI and volume in contracts: Kite reports quantities, so they are divided by the lot size when every figure is a
    whole number of lots (confirm on the first live run).
"""

import json
import logging
import math
import os
import threading
import time
from collections import Counter
from datetime import date, datetime
from pathlib import Path

from fastapi import HTTPException

import db
import derivs_sample
import kite_client
from scanner import IST

log = logging.getLogger("kite_chain")

CACHE = Path(os.environ.get("KITE_CACHE_DIR") or Path(__file__).resolve().parent / ".kite_cache")
EXCHANGES = ("NFO", "BFO")       # where the contracts are
SPOT_EXCHANGES = ("NSE", "BSE")  # where the underlyings are: stocks (EQ in segment NSE) and indices (segment INDICES)
BFO_NAMES = {"SENSEX", "BANKEX"}  # BSE stock options are thin; only its index options are listed
# An index's contracts are named NIFTY, its spot row "NIFTY 50", and Kite's list has no column linking the two, so
# this map does. Whether the row is there, in segment INDICES, is checked against the day's list.
INDEX_OF = {
    "NIFTY": ("NSE", "NIFTY 50"), "BANKNIFTY": ("NSE", "NIFTY BANK"), "FINNIFTY": ("NSE", "NIFTY FIN SERVICE"),
    "MIDCPNIFTY": ("NSE", "NIFTY MID SELECT"), "NIFTYNXT50": ("NSE", "NIFTY NEXT 50"), "NIFTYFPI": ("NSE", "NIFTY FPI 150"),
    "SENSEX": ("BSE", "SENSEX"), "BANKEX": ("BSE", "BANKEX"),
}
INDEX_ORDER = list(INDEX_OF)
SECTOR = {symbol: sector for symbol, sector, *_ in derivs_sample.DEFS}
STRIKES_EACH_SIDE = 20
RATE = 0.065
QUOTE_TTL, SPOT_TTL, MARGIN_TTL = 10, 30, 300
MARGIN_CHUNK = 20
SECTOR_SOURCE = "kite_sectors"  # derivs.py reads Sectoral analysis from this module when the chain is Kite

_lock = threading.RLock()
_state = {"day": None, "book": None, "client": None, "creds": None, "spots": (0, None), "base": None, "tokens": {}}
_quotes = {}   # key -> (fetched_at, quote)
_margins = {}  # contract key -> (fetched_at, ₹ total or None)


def _today():
    return datetime.now(IST).date()


def _api():
    creds = kite_client.credentials()
    with _lock:
        if _state["creds"] != creds:
            _state.update(creds=creds, client=kite_client.KiteHTTPAPI(*creds))
        return _state["client"]


def status():
    return "live" if kite_client.connected() else "offline"


# ── Instruments (once a day, kept in PostgreSQL) ───────
COLUMNS = ("exchange", "tradingsymbol", "instrument_token", "exchange_token", "name", "last_price", "expiry", "strike",
           "tick_size", "lot_size", "instrument_type", "segment")


def _wanted(df, exchange):
    """The rows of one exchange's instrument list this app uses, by Kite's own columns: futures (instrument_type FUT in
    segment <EX>-FUT) and options (CE or PE in <EX>-OPT) on NFO and BFO; stocks (EQ in segment NSE) and indices
    (segment INDICES) on NSE, indices only on BSE."""
    kind, seg = df["instrument_type"], df["segment"]
    if exchange in EXCHANGES:
        fut = (seg == f"{exchange}-FUT") & (kind == "FUT")
        opt = (seg == f"{exchange}-OPT") & kind.isin(["CE", "PE"])
        return df[(fut | opt) & (df["name"] != "") & (df["expiry"] != "")]
    return df[(seg == "INDICES") | ((seg == "NSE") & (kind == "EQ"))] if exchange == "NSE" else df[seg == "INDICES"]


def _load(exchange, today):
    """Today's rows of one exchange (_wanted): from kite_instruments, or the day's first time from Kite, then stored
    there (replacing yesterday's). Without the database they come straight from Kite."""
    try:
        with db.conn() as c:
            rows = c.execute(f"SELECT {', '.join(COLUMNS)} FROM kite_instruments WHERE exchange = %s AND day = %s",
                             (exchange, today)).fetchall()
        if rows:
            return rows
    except HTTPException:
        return _wanted(_api().instruments(exchange), exchange).to_dict("records")
    rows = _wanted(_api().instruments(exchange), exchange).to_dict("records")
    num = lambda v, f=float: f(float(v)) if str(v).strip() else None  # noqa: E731
    try:
        with db.conn() as c:
            c.execute("DELETE FROM kite_instruments WHERE exchange = %s", (exchange,))
            with c.cursor().copy(f"COPY kite_instruments ({', '.join(COLUMNS)}, day) FROM STDIN") as cp:
                for r in rows:
                    cp.write_row((exchange, r["tradingsymbol"], num(r["instrument_token"], int), num(r["exchange_token"], int),
                                  r["name"], num(r["last_price"]), date.fromisoformat(str(r["expiry"])[:10]) if r["expiry"] else None,
                                  num(r["strike"]) or 0, num(r["tick_size"]) or 0, num(r["lot_size"], int) or 0,
                                  r["instrument_type"], r["segment"], today))
    except HTTPException:
        pass  # the database went down meanwhile: today's rows are in memory, the next restart asks Kite again
    return rows


def _book():
    """{symbol: {kind, spot, lot, step, exp: {date: {strike: {"CE": inst, "PE": inst}}}, fut: {date: inst}}}, live
    expiries only. kind is "stock" when NSE lists the name as EQ in segment NSE, "index" when its INDEX_OF row is in
    segment INDICES; spot is that row's {key, token}. Names with neither are left out (_state["unmatched"])."""
    today = _today()
    with _lock:
        if _state["day"] == today:
            return _state["book"]
        book = {}
        for exchange in EXCHANGES:
            for row in _load(exchange, today):
                kind, name = row["instrument_type"], row["name"]
                if exchange == "BFO" and name not in BFO_NAMES:
                    continue
                expiry = date.fromisoformat(str(row["expiry"])[:10])
                if expiry < today:
                    continue
                inst = {"key": f"{exchange}:{row['tradingsymbol']}", "exchange": exchange, "token": int(row["instrument_token"]),
                        "tradingsymbol": row["tradingsymbol"], "lot": int(float(row["lot_size"]))}
                b = book.setdefault(name, {"exp": {}, "fut": {}})
                if kind == "FUT":
                    b["fut"][expiry] = inst
                else:
                    b["exp"].setdefault(expiry, {}).setdefault(float(row["strike"]), {})[kind] = inst
        for name in [n for n, b in book.items() if not b["exp"]]:
            del book[name]
        spot_rows = [r for exchange in SPOT_EXCHANGES for r in _load(exchange, today)]
        stocks = {r["tradingsymbol"]: r for r in spot_rows if r["segment"] == "NSE" and r["instrument_type"] == "EQ"}
        indices = {(r["exchange"], r["tradingsymbol"]): r for r in spot_rows if r["segment"] == "INDICES"}
        unmatched = []
        for name, b in list(book.items()):
            row = indices.get(INDEX_OF[name]) if name in INDEX_OF else stocks.get(name)
            if not row:
                unmatched.append(name)
                del book[name]
                continue
            b["kind"] = "index" if name in INDEX_OF else "stock"
            b["spot"] = {"key": f"{row['exchange']}:{row['tradingsymbol']}", "token": int(row["instrument_token"])}
        if unmatched:
            log.warning("no NSE stock (EQ) or index (INDICES) row for %s; left out", ", ".join(sorted(unmatched)))
        for b in book.values():
            near = b["exp"][min(b["exp"])]
            b["lot"] = next(iter(next(iter(near.values())).values()))["lot"]
            ks = sorted(near)
            gaps = Counter(round(hi - lo, 2) for lo, hi in zip(ks, ks[1:]))
            b["step"] = gaps.most_common(1)[0][0] if gaps else 1
        tokens = {i["key"]: i["token"] for b in book.values() for i in
                  [*b["fut"].values(), *(i for by in b["exp"].values() for sides in by.values() for i in sides.values())]}
        _state.update(day=today, book=book, base=None, tokens=tokens, unmatched=sorted(unmatched))
        _track(book, today)
        return book


# ── Which stocks are in F&O ────────────────────────────
def _last_expiry(b):
    return max([*b["exp"], *b["fut"]])


def _track(book, today):
    """Record the day's F&O stocks (fno_stocks) and which joined or left since the last day seen (fno_changes). The
    first day only sets the list; running again the same day changes nothing."""
    stocks = {n: b for n, b in book.items() if b["kind"] == "stock"}
    try:
        with db.conn() as c:
            prev = c.execute("SELECT max(last_seen) AS d FROM fno_stocks").fetchone()["d"]
            was = {r["symbol"] for r in c.execute("SELECT symbol FROM fno_stocks WHERE last_seen = %s", (prev,))} if prev else set()
            with c.cursor() as cur:
                cur.executemany(
                    """INSERT INTO fno_stocks (symbol, token, lot, first_seen, last_seen, last_expiry) VALUES (%s, %s, %s, %s, %s, %s)
                       ON CONFLICT (symbol) DO UPDATE SET token = EXCLUDED.token, lot = EXCLUDED.lot,
                       last_seen = EXCLUDED.last_seen, last_expiry = EXCLUDED.last_expiry""",
                    [(n, b["spot"]["token"], b["lot"], today, today, _last_expiry(b)) for n, b in stocks.items()])
                if prev and prev < today:
                    cur.executemany("INSERT INTO fno_changes (day, symbol, change) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                                    [(today, n, "in") for n in sorted(set(stocks) - was)]
                                    + [(today, n, "out") for n in sorted(was - set(stocks))])
    except HTTPException:
        log.warning("database down: today's F&O list isn't recorded")


def fno_list():
    """The F&O stocks in today's instrument list, and the changes seen. A stock is leaving when NSE has stopped adding
    its contracts: its last expiry is before the one most stocks have, and it is out after that day."""
    book = _book()
    stocks = {n: b for n, b in book.items() if b["kind"] == "stock"}
    last = {n: _last_expiry(b) for n, b in stocks.items()}
    common = Counter(last.values()).most_common(1)[0][0] if last else None
    try:
        with db.conn() as c:
            first = {r["symbol"]: r["first_seen"] for r in c.execute("SELECT symbol, first_seen FROM fno_stocks")}
            since = min(first.values(), default=None)
            changes = [{"day": r["day"].isoformat(), "symbol": r["symbol"], "change": r["change"]} for r in
                       c.execute("SELECT day, symbol, change FROM fno_changes ORDER BY day DESC, change, symbol LIMIT 500")]
    except HTTPException:
        first, since, changes = {}, None, []
    return {
        "stocks": [{"symbol": n, "lot": b["lot"], "lastExpiry": _label(last[n]),
                    "leaving": last[n] < common, "since": first[n].isoformat() if n in first else None}
                   for n, b in sorted(stocks.items())],
        "indices": [n for n in INDEX_ORDER if n in book],
        "unmatched": _state.get("unmatched") or [],
        "changes": changes, "trackedSince": since.isoformat() if since else None,
    }


def _label(d):
    return d.strftime("%d-%b-%Y")


def _expiry_date(label):
    return datetime.strptime(label, "%d-%b-%Y").date()


# ── Quotes ─────────────────────────────────────────────
def _quote(keys):
    """Full quotes, reusing any fetched in the last few seconds. Keys Kite has no data for are left out.
    Asked for by the day's instrument tokens: Kite answers the same quote for a token as for "NFO:<tradingsymbol>",
    and a token is under half as long, so a call carries 500 instruments instead of about 200 (they go in the URL)."""
    _book()
    now = time.monotonic()
    with _lock:
        missing = [k for k in dict.fromkeys(keys) if k not in _quotes or now - _quotes[k][0] > QUOTE_TTL]
        token = _state["tokens"]
    if missing:
        by_token = {str(token[k]): k for k in missing if k in token}
        got = {by_token[t]: v for t, v in _api().quote(list(by_token)).items() if t in by_token} if by_token else {}
        rest = [k for k in missing if k not in token]
        if rest:
            got.update(_api().quote(rest))
        with _lock:
            for k in missing:  # "no data" is cached too, so it isn't asked for again on every call
                _quotes[k] = (now, got.get(k))
    with _lock:
        return {k: _quotes[k][1] for k in keys if k in _quotes and _quotes[k][1] is not None}


def _spots():
    with _lock:
        at, spots = _state["spots"]
        if spots is not None and time.monotonic() - at < SPOT_TTL:
            return spots
    book = _book()
    keys = {name: b["spot"]["key"] for name, b in book.items()}
    got = _api().ohlc(sorted(set(keys.values())))
    spots = {name: got[k] for name, k in keys.items() if k in got and got[k].get("last_price")}
    with _lock:
        _state["spots"] = (time.monotonic(), spots)
    return spots


# ── The source interface derivs.py reads ───────────────
def underlyings():
    book, spots = _book(), _spots()
    order = lambda n: (INDEX_ORDER.index(n) if book[n]["kind"] == "index" else len(INDEX_ORDER), n)  # noqa: E731
    out = []
    for name in sorted(spots, key=order):
        q, b = spots[name], book[name]
        last, close = q["last_price"], (q.get("ohlc") or {}).get("close") or 0
        index = b["kind"] == "index"
        out.append({"symbol": name, "sector": "Index" if index else SECTOR.get(name, "Other"), "index": index,
                    "spot": last, "chg": (last - close) / close * 100 if close else 0.0, "lot": b["lot"], "step": b["step"]})
    return out


def expiries(symbol):
    b = _book().get(symbol)
    return [_label(d) for d in sorted(b["exp"])] if b else []


def _contracts(name, expiry, each_side=STRIKES_EACH_SIDE):
    """The strikes shown for one expiry (both sides listed, nearest the spot), and the matching future if any."""
    b = _book()[name]
    by_strike = b["exp"][expiry]
    spot = _spots()[name]["last_price"]
    ks = sorted(k for k, sides in by_strike.items() if "CE" in sides and "PE" in sides)
    mid = min(range(len(ks)), key=lambda i: abs(ks[i] - spot)) if ks else 0
    ks = ks[max(0, mid - each_side): mid + each_side + 1]
    return spot, [(k, by_strike[k]["CE"], by_strike[k]["PE"]) for k in ks], b["fut"].get(expiry)


def prefetch(symbol, expiry_labels):
    keys = []
    for label in expiry_labels:
        _, rows, fut = _contracts(symbol, _expiry_date(label))
        keys += [i["key"] for _, ce, pe in rows for i in (ce, pe)] + ([fut["key"]] if fut else [])
    _quote(keys)


def _n(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _d1(S, K, T, v):
    return (math.log(S / K) + (RATE + v * v / 2) * T) / (v * math.sqrt(T))


def _bs(S, K, T, v, kind):
    d1 = _d1(S, K, T, v)
    d2 = d1 - v * math.sqrt(T)
    df = math.exp(-RATE * T)
    return S * _n(d1) - K * df * _n(d2) if kind == "CE" else K * df * _n(-d2) - S * _n(-d1)


def _iv(price, S, K, T, kind):
    """Implied vol (as a fraction) or None when the price is zero or at or below its no-arbitrage floor."""
    floor = max(0.0, S - K * math.exp(-RATE * T) if kind == "CE" else K * math.exp(-RATE * T) - S)
    if price <= 0 or price <= floor + 1e-6:
        return None
    lo, hi = 0.005, 5.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if _bs(S, K, T, mid, kind) > price:
            hi = mid
        else:
            lo = mid
    v = (lo + hi) / 2
    return None if v < 0.006 or v > 4.9 else v


def _delta(S, K, T, v, kind):
    d1 = _d1(S, K, T, v)
    return _n(d1) if kind == "CE" else _n(d1) - 1


def _years(dte):
    """NSE's day count for IV: calendar days to expiry, not counting today (half a day on the last two days)."""
    return max(dte - 1, 0.5) / 365


def _unit(quotes, lot):
    """Kite reports OI and volume as quantities. If every figure is a whole number of lots, count contracts."""
    vals = [int(q.get(f) or 0) for q in quotes for f in ("oi", "volume")]
    vals = [v for v in vals if v]
    return lot if lot > 1 and vals and all(v % lot == 0 for v in vals) else 1


def _oi_baseline(now_oi):
    """First OI seen today per key (quantity), and when it was first seen. Saved so a restart keeps it."""
    today = _today()
    f = CACHE / f"oi-base-{today}.json"
    with _lock:
        if _state["base"] is None:
            try:
                _state["base"] = json.loads(f.read_text())
            except (OSError, ValueError):
                _state["base"] = {}
        base = _state["base"]
        stamp = datetime.now(IST).strftime("%H:%M")
        new = {k: [oi, stamp] for k, oi in now_oi.items() if k not in base}
        if new:
            base.update(new)
            CACHE.mkdir(exist_ok=True)
            for old in CACHE.glob("oi-base-*.json"):
                if old != f:
                    old.unlink()
            f.write_text(json.dumps(base))
        return {k: base[k] for k in now_oi}


def chain(symbol, expiry_label):
    expiry = _expiry_date(expiry_label)
    spot, contracts, fut = _contracts(symbol, expiry)
    keys = [i["key"] for _, ce, pe in contracts for i in (ce, pe)]
    return build(expiry, spot, contracts, fut, _quote(keys + ([fut["key"]] if fut else [])))


def build(expiry, spot, contracts, fut, q):
    """A chain in derivs_sample's shape from _contracts() and their quotes (kite_sectors passes quotes it batched)."""
    keys = [i["key"] for _, ce, pe in contracts for i in (ce, pe)]
    dte = max((expiry - _today()).days, 0)
    T = _years(dte)

    # Futures price shown in the summary: the future when this expiry has one, else put-call parity at the strike
    # nearest the spot.
    F = (q.get(fut["key"]) or {}).get("last_price") if fut else None
    if not F and contracts:
        k, ce, pe = min(contracts, key=lambda c: abs(c[0] - spot))
        c, p = (q.get(ce["key"]) or {}).get("last_price"), (q.get(pe["key"]) or {}).get("last_price")
        F = k + (c - p) * math.exp(RATE * T) if c and p else None
    F = F or spot * math.exp(RATE * T)

    lot = contracts[0][1]["lot"] if contracts else 1
    unit = _unit([q[k] for k in keys if k in q], lot)
    base = _oi_baseline({k: int(q[k].get("oi") or 0) for k in keys if k in q})

    def side(inst, K, kind):
        s = q.get(inst["key"])
        if not s:
            return {"ltp": 0, "chg": None, "iv": None, "delta": None, "oi": 0, "chg_oi": 0, "vol": 0}
        ltp, close = s.get("last_price") or 0, (s.get("ohlc") or {}).get("close") or 0
        v = _iv(ltp, spot, K, T, kind)
        oi = int(s.get("oi") or 0)
        return {"ltp": ltp, "chg": (ltp - close) / close * 100 if close else None,
                "iv": v * 100 if v else None, "delta": _delta(spot, K, T, v, kind) if v else None,
                "oi": round(oi / unit), "chg_oi": round((oi - base[inst["key"]][0]) / unit),
                "vol": round(int(s.get("volume") or 0) / unit)}

    rows = [{"strike": int(K) if K.is_integer() else K, "CE": side(ce, K, "CE"), "PE": side(pe, K, "PE")}
            for K, ce, pe in contracts]
    since = max((base[k][1] for k in base), default=None)
    return {"spot": spot, "fut": F, "dte": dte, "rows": rows, "oi_since": since}


def margins(symbol, expiry_label, strikes, kinds=("CE", "PE")):
    """{(strike, "CE"|"PE"): ₹} to sell one lot of each, NRML, each on its own (consider_positions=false).
    A margin calculation through Kite's basket calculator; no order is placed. Kept per contract for MARGIN_TTL, so
    the chain page and the Screener's trade check share what either fetched."""
    by_strike = _book()[symbol]["exp"][_expiry_date(expiry_label)]
    want = {float(k) for k in strikes}
    insts = [(k, kind, sides[kind]) for k, sides in by_strike.items() if k in want for kind in kinds if kind in sides]
    now = time.monotonic()
    with _lock:
        todo = [i for _, _, i in insts if not (i["key"] in _margins and now - _margins[i["key"]][0] < MARGIN_TTL)]
    orders = [{"exchange": i["exchange"], "tradingsymbol": i["tradingsymbol"], "transaction_type": "SELL",
               "variety": "regular", "product": "NRML", "order_type": "MARKET", "quantity": i["lot"],
               "price": 0, "trigger_price": 0} for i in todo]
    totals = {}
    for n in range(0, len(orders), MARGIN_CHUNK):
        data = _api().basket_margins(orders[n:n + MARGIN_CHUNK], consider_positions=False)
        totals.update({(o["exchange"], o["tradingsymbol"]): o.get("total") for o in data.get("orders") or []})
    with _lock:
        for i in todo:
            _margins[i["key"]] = (now, totals.get((i["exchange"], i["tradingsymbol"])))
        return {(int(k) if k.is_integer() else k, kind): _margins[i["key"]][1]
                for k, kind, i in insts if i["key"] in _margins and _margins[i["key"]][1]}
