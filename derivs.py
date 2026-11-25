"""
F&O analytics API for the web app's Sectoral analysis and Option chain tabs.

Every number the charts show is worked out here: sector build-up, put-call ratios, IV ranges, max pain
and the strike × expiry grid for the 3D view. Nothing is fetched from NSE.

Two data sources, each a module with three functions: underlyings(), expiries(symbol) and chain(symbol, expiry)
(shapes documented in derivs_sample.py). A chain source may also offer margins(), prefetch() and status(), as
kite_chain.py does:
  - The option chain, the symbol picker and the 3D grid come from the module named by DERIVS_CHAIN_SOURCE, for
    example one that calls your own stock-derivatives API. Your module only returns raw chain rows; totals, PCR,
    max pain, ATM IV and the grids are still worked out here.
  - Unset, they come from Kite (kite_chain, read only) while a Zerodha session is live, which the web app's Profile
    page sets up (kite_auth.py), and from the sample generator, derivs_sample, otherwise. Checked on every request,
    so logging in or out switches the tabs without a restart.
  - Sectors follow the chain source: one that names a sector source of its own (SECTOR_SOURCE, as kite_chain names
    kite_sectors) supplies them, any other gets the sample.

    .venv/bin/uvicorn server:app --port 8060                                   # Kite when logged in, else sample
    DERIVS_CHAIN_SOURCE=my_chain .venv/bin/uvicorn server:app --port 8060
    DERIVS_CHAIN_SOURCE=derivs_sample .venv/bin/uvicorn server:app --port 8060 # always the sample

    GET /api/derivs/health                          where sectors and the chain come from, and the Zerodha state
    GET /api/derivs/sectors                         sector and index derivatives summary
    GET /api/derivs/symbols                         underlyings for the chain picker
    GET /api/derivs/chain?symbol=SBIN&expiry=...    one expiry's chain with totals and max pain
    GET /api/derivs/surface?symbol=SBIN             OI and IV on a strike × expiry grid
    GET /api/derivs/screener[?rescan=1]             OTM stock options to sell, from the sector source's chains
    GET /api/derivs/margin?symbol&expiry&strike&type  Kite's margin to sell one lot of one option (no order placed)
    GET /api/derivs/fno                             the F&O stock list: who is in, leaving, joined or left
"""

import importlib
import logging
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query

import derivs_sample
import kite_chain
from accounts import current_user
import kite_client
import kite_history
import kite_sectors
from pe import MARGIN_PCT
from scanner import IST

# Signed-in users only (accounts.py). The functions below are plain Python, so export_static.py calls them directly.
router = APIRouter(prefix="/api/derivs", tags=["derivatives"], dependencies=[Depends(current_user)])
log = logging.getLogger("derivs")

_fixed = importlib.import_module(os.environ["DERIVS_CHAIN_SOURCE"]) if os.environ.get("DERIVS_CHAIN_SOURCE") else None


def chain_src():
    """DERIVS_CHAIN_SOURCE if set; else Kite while a Zerodha session is live, the sample otherwise."""
    return _fixed or (kite_chain if kite_client.connected() else derivs_sample)


def sector_src():
    return importlib.import_module(getattr(chain_src(), "SECTOR_SOURCE", "derivs_sample"))


BUILD_UPS = ["Long build-up", "Short covering", "Short build-up", "Long unwinding"]
SURFACE_EXPIRIES = 8  # the 3D view shows the nearest few; index weeklies would otherwise crowd it
SCREEN_OTM = kite_sectors.SCREEN_OTM  # % out of the money the Screener lists: nearer is too risky to sell, further pays next to nothing


def build_up(chg, oi_chg):
    """Price up with OI up is fresh longs; price down with OI up is fresh shorts; the other two are positions closing."""
    if chg >= 0:
        return "Long build-up" if oi_chg >= 0 else "Short covering"
    return "Short build-up" if oi_chg >= 0 else "Long unwinding"


def _meta(src):
    return {"source": "sample" if src is derivs_sample else "live", "asOf": datetime.now(IST).isoformat(timespec="seconds")}


def _underlying(src, symbol):
    u = next((x for x in src.underlyings() if x["symbol"] == symbol.upper()), None)
    if not u:
        raise HTTPException(404, f"Unknown symbol {symbol}")
    return u


def _r(v, n):
    return None if v is None else round(v, n)


def _side(s, margin=None):
    """chg, iv and delta are None when a live contract hasn't traded; margin is None unless the source gives one."""
    return {"ltp": s["ltp"], "chg": _r(s["chg"], 2), "iv": _r(s["iv"], 2) if s["iv"] else None,
            "delta": _r(s["delta"], 3), "oi": s["oi"], "chgOi": s["chg_oi"], "vol": s["vol"],
            "margin": round(margin) if margin else None}


def max_pain(rows):
    """The expiry price at which option buyers, in total, collect the least."""
    best, least = rows[0]["strike"], float("inf")
    for x in rows:
        pain = sum(k["CE"]["oi"] * max(0, x["strike"] - k["strike"]) + k["PE"]["oi"] * max(0, k["strike"] - x["strike"])
                   for k in rows)
        if pain < least:
            best, least = x["strike"], pain
    return best


def chain_summary(src, u, expiry):
    c = src.chain(u["symbol"], expiry)
    rows = c["rows"]
    atm = min(rows, key=lambda x: abs(x["strike"] - c["spot"]))
    ivs = [s["iv"] for s in (atm["CE"], atm["PE"]) if s["iv"]]
    call_oi = sum(x["CE"]["oi"] for x in rows)
    put_oi = sum(x["PE"]["oi"] for x in rows)
    return c, {
        "spot": c["spot"], "fut": round(c["fut"], 2), "dte": c["dte"], "atmStrike": atm["strike"],
        "atmIv": round(sum(ivs) / len(ivs), 2) if ivs else None, "maxPain": max_pain(rows),
        "callOi": call_oi, "putOi": put_oi, "pcr": round(put_oi / call_oi, 3) if call_oi else None,
        "callChg": sum(x["CE"]["chg_oi"] for x in rows), "putChg": sum(x["PE"]["chg_oi"] for x in rows),
    }


def _stock(src, u):
    """One underlying's near-expiry numbers. Option OI notional is in ₹ crore (contracts × lot × spot)."""
    _, s = chain_summary(src, u, src.expiries(u["symbol"])[0])
    cr = lambda oi: oi * u["lot"] * u["spot"] / 1e7  # noqa: E731
    return {
        "symbol": u["symbol"], "sector": u["sector"], "spot": u["spot"], "chg": round(u["chg"], 2),
        "oiChg": round(u["fut_oi_chg"], 2), "pcr": s["pcr"], "atmIv": s["atmIv"], "ivChg": round(u["iv_chg"], 2),
        "callCr": round(cr(s["callOi"]), 1), "putCr": round(cr(s["putOi"]), 1), "maxPain": s["maxPain"],
        "lot": u["lot"], "buildUp": build_up(u["chg"], u["fut_oi_chg"]),
    }


@router.get("/health")
def health():
    state = lambda src: src.status() if hasattr(src, "status") else _meta(src)["source"]  # noqa: E731
    return {"ok": True, "sectors": state(sector_src()), "chain": state(chain_src()),
            "kite": "live" if kite_client.connected() else "offline"}


@router.get("/sectors")
def sectors():
    sector_source = sector_src()
    stocks = [_stock(sector_source, u) for u in sector_source.underlyings()]
    out = []
    for name in sector_source.SECTORS:
        group = [s for s in stocks if s["sector"] == name]
        if not group:
            continue
        # Price and OI change are weighted by option OI notional, so heavyweights count for more.
        w = [s["callCr"] + s["putCr"] for s in group]
        if not sum(w):
            w = [1] * len(group)
        wavg = lambda k: sum(s[k] * wi for s, wi in zip(group, w)) / sum(w)  # noqa: E731
        chg, oi_chg = wavg("chg"), wavg("oiChg")
        ivs = [s["atmIv"] for s in group if s["atmIv"] is not None]
        call_cr, put_cr = sum(s["callCr"] for s in group), sum(s["putCr"] for s in group)
        if not (ivs and call_cr):
            continue  # live data: no option in the sector has traded yet
        out.append({
            "name": name, "chg": round(chg, 2), "oiChg": round(oi_chg, 2), "buildUp": build_up(chg, oi_chg),
            "pcr": round(put_cr / call_cr, 3), "callCr": round(call_cr, 1), "putCr": round(put_cr, 1),
            "iv": {"min": min(ivs), "avg": round(sum(ivs) / len(ivs), 2), "max": max(ivs)},
            "counts": {b: sum(1 for s in group if s["buildUp"] == b) for b in BUILD_UPS},
            "stocks": sorted(group, key=lambda s: -(s["callCr"] + s["putCr"])),
        })
    expiry = sector_source.near_expiry() if hasattr(sector_source, "near_expiry") else sector_source.expiries("NIFTY")[0]
    return {**_meta(sector_source), "expiry": expiry, "buildUps": BUILD_UPS,
            "oiSince": sector_source.oi_since() if hasattr(sector_source, "oi_since") else None,
            "indices": [s for s in stocks if s["sector"] == "Index"], "sectors": out}


@router.get("/symbols")
def symbols():
    chain_source = chain_src()
    return {**_meta(chain_source), "marginPct": MARGIN_PCT, "symbols": [
        {"symbol": u["symbol"], "sector": u["sector"], "index": u["index"], "spot": u["spot"],
         "chg": round(u["chg"], 2), "lot": u["lot"], "expiries": chain_source.expiries(u["symbol"])}
        for u in chain_source.underlyings()]}


@router.get("/chain")
def chain(symbol: str = Query(..., max_length=20), expiry: str | None = None):
    chain_source = chain_src()
    u = _underlying(chain_source, symbol)
    expiries = chain_source.expiries(u["symbol"])
    expiry = expiry or expiries[0]
    if expiry not in expiries:
        raise HTTPException(404, f"No {expiry} expiry for {u['symbol']}")
    c, s = chain_summary(chain_source, u, expiry)
    m = {}
    if hasattr(chain_source, "margins"):
        # Best effort: without margins the app falls back to its estimate, so a margin error never fails the chain.
        try:
            m = chain_source.margins(u["symbol"], expiry, [x["strike"] for x in c["rows"]])
        except Exception as e:  # noqa: BLE001
            log.warning("margins for %s %s failed: %s", u["symbol"], expiry, e)
    return {**_meta(chain_source), **s, "symbol": u["symbol"], "sector": u["sector"], "index": u["index"], "expiry": expiry,
            "expiries": expiries, "chg": round(u["chg"], 2), "lot": u["lot"], "step": u["step"], "marginPct": MARGIN_PCT,
            "oiSince": c.get("oi_since"),
            "rows": [{"strike": x["strike"], "call": _side(x["CE"], m.get((x["strike"], "CE"))),
                      "put": _side(x["PE"], m.get((x["strike"], "PE")))} for x in c["rows"]]}


@router.get("/margin")
def margin(symbol: str = Query(..., max_length=20), expiry: str = Query(..., max_length=20), strike: float = Query(..., gt=0),
           type: str = Query(..., pattern="^(CE|PE)$")):
    """Kite's margin to sell one lot of one option (NRML, on its own), for the Screener's trade check: its rows reach
    strikes the chain page doesn't show. A calculation only; no order is placed. {margin: ₹, or null without one}."""
    chain_source = chain_src()
    if not hasattr(chain_source, "margins"):
        return {"margin": None}
    u = _underlying(chain_source, symbol)
    if expiry not in chain_source.expiries(u["symbol"]):
        raise HTTPException(404, f"No {expiry} expiry for {u['symbol']}")
    K = int(strike) if float(strike).is_integer() else strike
    return {"margin": chain_source.margins(u["symbol"], expiry, [strike], (type,)).get((K, type))}


@router.get("/surface")
def surface(symbol: str = Query(..., max_length=20)):
    """OI per strike and expiry for both sides, and the IV smile per expiry (out-of-the-money side: puts below
    spot, calls above). Strikes are the union across expiries; a strike missing from an expiry is null."""
    chain_source = chain_src()
    u = _underlying(chain_source, symbol)
    expiries = chain_source.expiries(u["symbol"])[:SURFACE_EXPIRIES]
    if hasattr(chain_source, "prefetch"):
        chain_source.prefetch(u["symbol"], expiries)
    chains = [(e, chain_source.chain(u["symbol"], e)) for e in expiries]
    strikes = sorted({x["strike"] for _, c in chains for x in c["rows"]})
    grid = lambda f: [[f(by[k]) if k in by else None for k in strikes]  # noqa: E731
                      for by in ({x["strike"]: x for x in c["rows"]} for _, c in chains)]
    spot = u["spot"]
    return {**_meta(chain_source), "symbol": u["symbol"], "spot": spot, "lot": u["lot"], "strikes": strikes,
            "expiries": [{"expiry": e, "dte": c["dte"]} for e, c in chains],
            "callOi": grid(lambda x: x["CE"]["oi"]), "putOi": grid(lambda x: x["PE"]["oi"]),
            "iv": grid(lambda x: _r((x["PE"] if x["strike"] < spot else x["CE"])["iv"], 2))}


def screener_rows(src, year=None):
    """Every stock's out-of-the-money options on its nearest expiry, in the web app's OptionRow shape. Margin is the
    estimate (strike × lot × MARGIN_PCT): Kite's own figure takes a call per chain, so the trade check fetches it.
    year: {SYMBOL: (52-week high, low)} (kite_history); without it the underlying's own hi52 / lo52 (the sample's)."""
    rows = []
    for u in src.underlyings():
        if u["index"]:
            continue
        expiry = src.expiries(u["symbol"])[0]
        c = src.chain(u["symbol"], expiry)
        spot = c["spot"]
        hi52, lo52 = (year or {}).get(u["symbol"]) or (u.get("hi52"), u.get("lo52"))
        for x in c["rows"]:
            K = x["strike"]
            for kind in ("PE", "CE"):
                s = x[kind]
                otm = ((spot - K) if kind == "PE" else (K - spot)) / spot * 100
                if not (SCREEN_OTM[0] <= otm <= SCREEN_OTM[1]) or not s["ltp"] or not s["oi"]:
                    continue
                margin = round(K * u["lot"] * MARGIN_PCT / 100)
                total = round(s["ltp"] * u["lot"], 2)
                rows.append({
                    "id": f"chain-{u['symbol']}-{expiry}-{int(K) if float(K).is_integer() else K}-{kind}", "symbol": u["symbol"], "type": kind, "cmp": spot,
                    "strike": K, "otm": round(otm, 2), "prem": s["ltp"], "lot": u["lot"], "totalPrem": total,
                    "margin": margin, "premPct": round(total / margin * 100, 2) if margin else 0, "expiry": expiry,
                    "fut": round(c["fut"], 2), "hi52": hi52, "lo52": lo52, "pe": None, "iv": _r(s["iv"], 2) or 0,
                    "oi": s["oi"], "src": "chain", "est": ["margin"],
                })
    return rows


@router.get("/fno")
def fno():
    """Live: the F&O stocks in today's Kite instrument list, with the joins and exits seen since tracking began
    (kite_chain.fno_list). Sample: the sample's stocks, nothing leaving."""
    src = chain_src()
    if hasattr(src, "fno_list"):
        f = src.fno_list()
        f["stocks"] = [{**s, "sector": kite_sectors.SECTOR_OF.get(s["symbol"], "Other")} for s in f["stocks"]]
        return {**_meta(src), **f}
    us = src.underlyings()
    return {**_meta(src), "stocks": [{"symbol": u["symbol"], "sector": u["sector"], "lot": u["lot"],
                                      "lastExpiry": src.expiries(u["symbol"])[-1], "leaving": False, "since": None}
                                     for u in sorted(us, key=lambda u: u["symbol"]) if not u["index"]],
            "indices": [u["symbol"] for u in us if u["index"]], "unmatched": [], "changes": [], "trackedSince": None}


@router.get("/screener")
def screener(rescan: bool = False):
    src = sector_src()
    meta = _meta(src)
    # The live source answers from one pass (the last one, or a new one on Re-scan), with the 52-week range from the
    # stored daily bars plus today's high and low from the pass.
    live = hasattr(src, "snapshot")
    if not live:
        return {**meta, "scanned": meta["asOf"], "otm": list(SCREEN_OTM), "marginPct": MARGIN_PCT, "rows": screener_rows(src)}
    view = src.snapshot(rescan)
    year = kite_history.ranges({u["symbol"]: (u.get("day_high"), u.get("day_low")) for u in view.underlyings()})
    return {**meta, "scanned": view.scanned, "otm": list(SCREEN_OTM), "marginPct": MARGIN_PCT,
            "history": kite_history.status(), "rows": screener_rows(view, year)}
