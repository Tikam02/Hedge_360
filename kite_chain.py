"""
Kite Connect as the option chain source. Start the API with it:

    DERIVS_CHAIN_SOURCE=kite_chain .venv/bin/uvicorn server:app --port 8060

Read only: the instrument list, market quotes and the margin calculator, through kite_client, which refuses every
other call. Nothing here can place an order. With this chain source, Sectoral analysis comes from Kite too
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
import re
import threading
import time
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import pandas as pd

import derivs_sample
import kite_client
from scanner import IST

log = logging.getLogger("kite_chain")

CACHE = Path(os.environ.get("KITE_CACHE_DIR") or Path(__file__).resolve().parent / ".kite_cache")
EXCHANGES = ("NFO", "BFO")
BFO_NAMES = {"SENSEX", "BANKEX"}  # BSE stock options are thin; only its index options are listed
# Index spot quotes. Stocks use "NSE:<symbol>".
SPOT_KEYS = {
    "NIFTY": "NSE:NIFTY 50", "BANKNIFTY": "NSE:NIFTY BANK", "FINNIFTY": "NSE:NIFTY FIN SERVICE",
    "MIDCPNIFTY": "NSE:NIFTY MID SELECT", "NIFTYNXT50": "NSE:NIFTY NEXT 50", "SENSEX": "BSE:SENSEX", "BANKEX": "BSE:BANKEX",
}
INDEX_ORDER = list(SPOT_KEYS)
SECTOR = {symbol: sector for symbol, sector, *_ in derivs_sample.DEFS}
STRIKES_EACH_SIDE = 20
RATE = 0.065
QUOTE_TTL, SPOT_TTL, MARGIN_TTL = 10, 30, 300
MARGIN_CHUNK = 20
SECTOR_SOURCE = "kite_sectors"  # derivs.py reads Sectoral analysis from this module when the chain is Kite

_lock = threading.RLock()
_state = {"day": None, "book": None, "client": None, "creds": None, "spots": (0, None), "base": None}
_quotes = {}   # key -> (fetched_at, quote)
_margins = {}  # (symbol, expiry) -> (fetched_at, {(strike, kind): total})


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


# ── Instruments (once a day, cached on disk) ───────────
def _name_of(row):
    """Kite's sample dump leaves `name` blank on some F&O rows; then read it off the tradingsymbol."""
    if row["name"]:
        return row["name"]
    m = re.match(r"^(.*?)\d{2}(?:[A-Z]{3}|[1-9OND]\d{2})", row["tradingsymbol"])
    return m.group(1) if m else row["tradingsymbol"]


def _load(exchange, today):
    f = CACHE / f"instruments-{exchange}-{today}.csv"
    if f.exists():
        return pd.read_csv(f, dtype={"tradingsymbol": str, "name": str, "expiry": str}, keep_default_na=False)
    df = _api().instruments(exchange)
    CACHE.mkdir(exist_ok=True)
    for old in CACHE.glob(f"instruments-{exchange}-*.csv"):
        old.unlink()
    df.to_csv(f, index=False)
    return df


def _book():
    """{symbol: {lot, step, exp: {date: {strike: {"CE": inst, "PE": inst}}}, fut: {date: inst}}}, live expiries only."""
    today = _today()
    with _lock:
        if _state["day"] == today:
            return _state["book"]
        book = {}
        for exchange in EXCHANGES:
            for row in _load(exchange, today).to_dict("records"):
                kind = row["instrument_type"]
                if kind not in ("CE", "PE", "FUT") or not row["expiry"]:
                    continue
                name = _name_of(row)
                if exchange == "BFO" and name not in BFO_NAMES:
                    continue
                expiry = date.fromisoformat(str(row["expiry"])[:10])
                if expiry < today:
                    continue
                inst = {"key": f"{exchange}:{row['tradingsymbol']}", "exchange": exchange,
                        "tradingsymbol": row["tradingsymbol"], "lot": int(float(row["lot_size"]))}
                b = book.setdefault(name, {"exp": {}, "fut": {}})
                if kind == "FUT":
                    b["fut"][expiry] = inst
                else:
                    b["exp"].setdefault(expiry, {}).setdefault(float(row["strike"]), {})[kind] = inst
        for name in [n for n, b in book.items() if not b["exp"]]:
            del book[name]
        for b in book.values():
            near = b["exp"][min(b["exp"])]
            b["lot"] = next(iter(next(iter(near.values())).values()))["lot"]
            ks = sorted(near)
            gaps = Counter(round(hi - lo, 2) for lo, hi in zip(ks, ks[1:]))
            b["step"] = gaps.most_common(1)[0][0] if gaps else 1
        _state.update(day=today, book=book, base=None)
        return book


def _label(d):
    return d.strftime("%d-%b-%Y")


def _expiry_date(label):
    return datetime.strptime(label, "%d-%b-%Y").date()


# ── Quotes ─────────────────────────────────────────────
def _quote(keys):
    """Full quotes, reusing any fetched in the last few seconds. Keys Kite has no data for are left out."""
    now = time.monotonic()
    with _lock:
        missing = [k for k in dict.fromkeys(keys) if k not in _quotes or now - _quotes[k][0] > QUOTE_TTL]
    if missing:
        got = _api().quote(missing)
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
    keys = {name: SPOT_KEYS.get(name, f"NSE:{name}") for name in book}
    got = _api().ohlc(sorted(set(keys.values())))
    spots = {name: got[k] for name, k in keys.items() if k in got and got[k].get("last_price")}
    with _lock:
        _state["spots"] = (time.monotonic(), spots)
    return spots


# ── The source interface derivs.py reads ───────────────
def underlyings():
    book, spots = _book(), _spots()
    order = lambda n: (INDEX_ORDER.index(n) if n in SPOT_KEYS else len(INDEX_ORDER), n)  # noqa: E731
    out = []
    for name in sorted(spots, key=order):
        q, b = spots[name], book[name]
        last, close = q["last_price"], (q.get("ohlc") or {}).get("close") or 0
        index = name in SPOT_KEYS
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


def margins(symbol, expiry_label, strikes):
    """{(strike, "CE"|"PE"): ₹} to sell one lot of each, NRML, each on its own (consider_positions=false).
    A margin calculation through Kite's basket calculator; no order is placed."""
    ck = (symbol, expiry_label)
    with _lock:
        hit = _margins.get(ck)
        if hit and time.monotonic() - hit[0] < MARGIN_TTL:
            return hit[1]
    by_strike = _book()[symbol]["exp"][_expiry_date(expiry_label)]
    want = {float(k) for k in strikes}
    insts = [(k, kind, sides[kind]) for k, sides in by_strike.items() if k in want for kind in ("CE", "PE") if kind in sides]
    orders = [{"exchange": i["exchange"], "tradingsymbol": i["tradingsymbol"], "transaction_type": "SELL",
               "variety": "regular", "product": "NRML", "order_type": "MARKET", "quantity": i["lot"],
               "price": 0, "trigger_price": 0} for _, _, i in insts]
    totals = {}
    for n in range(0, len(orders), MARGIN_CHUNK):
        data = _api().basket_margins(orders[n:n + MARGIN_CHUNK], consider_positions=False)
        totals.update({(o["exchange"], o["tradingsymbol"]): o.get("total") for o in data.get("orders") or []})
    out = {}
    for k, kind, i in insts:
        total = totals.get((i["exchange"], i["tradingsymbol"]))
        if total:
            out[(int(k) if k.is_integer() else k, kind)] = total
    with _lock:
        _margins[ck] = (time.monotonic(), out)
    return out
