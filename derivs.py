"""
F&O analytics API for the web app's Sectoral analysis and Option chain tabs.

Every number the charts show is worked out here: sector build-up, put-call ratios, IV ranges, max pain
and the strike × expiry grid for the 3D view. Nothing is fetched from NSE.

Two data sources, each a module with three functions: underlyings(), expiries(symbol) and chain(symbol, expiry)
(shapes documented in derivs_sample.py):
  - Sectors always come from the sample generator, derivs_sample.
  - The option chain, the symbol picker and the 3D grid come from the module named by DERIVS_CHAIN_SOURCE,
    for example one that calls your own stock-derivatives API. Unset, they use the sample too. Your module only
    returns raw chain rows; totals, PCR, max pain, ATM IV and the grids are still worked out here.

    DERIVS_CHAIN_SOURCE=my_chain .venv/bin/uvicorn server:app --port 8060

    GET /api/derivs/health                          where sectors and the chain come from (sample or live)
    GET /api/derivs/sectors                         sector and index derivatives summary
    GET /api/derivs/symbols                         underlyings for the chain picker
    GET /api/derivs/chain?symbol=SBIN&expiry=...    one expiry's chain with totals and max pain
    GET /api/derivs/surface?symbol=SBIN             OI and IV on a strike × expiry grid
"""

import importlib
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

import derivs_sample
from pe import MARGIN_PCT
from scanner import IST

router = APIRouter(prefix="/api/derivs", tags=["derivatives"])

sector_source = derivs_sample
chain_source = importlib.import_module(os.environ["DERIVS_CHAIN_SOURCE"]) if os.environ.get("DERIVS_CHAIN_SOURCE") else derivs_sample

BUILD_UPS = ["Long build-up", "Short covering", "Short build-up", "Long unwinding"]


def build_up(chg, oi_chg):
    """Price up with OI up is fresh longs; price down with OI up is fresh shorts; the other two are positions closing."""
    if chg >= 0:
        return "Long build-up" if oi_chg >= 0 else "Short covering"
    return "Short build-up" if oi_chg >= 0 else "Long unwinding"


def _meta(src):
    return {"source": "sample" if src is derivs_sample else "live", "asOf": datetime.now(IST).isoformat(timespec="seconds")}


def _underlying(symbol):
    u = next((x for x in chain_source.underlyings() if x["symbol"] == symbol.upper()), None)
    if not u:
        raise HTTPException(404, f"Unknown symbol {symbol}")
    return u


def _side(s):
    return {"ltp": s["ltp"], "chg": round(s["chg"], 2), "iv": round(s["iv"], 2) if s["iv"] else None,
            "delta": round(s["delta"], 3), "oi": s["oi"], "chgOi": s["chg_oi"], "vol": s["vol"]}


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


def _stock(u):
    """One underlying's near-expiry numbers. Option OI notional is in ₹ crore (contracts × lot × spot)."""
    _, s = chain_summary(sector_source, u, sector_source.expiries(u["symbol"])[0])
    cr = lambda oi: oi * u["lot"] * u["spot"] / 1e7  # noqa: E731
    return {
        "symbol": u["symbol"], "sector": u["sector"], "spot": u["spot"], "chg": round(u["chg"], 2),
        "oiChg": round(u["fut_oi_chg"], 2), "pcr": s["pcr"], "atmIv": s["atmIv"], "ivChg": round(u["iv_chg"], 2),
        "callCr": round(cr(s["callOi"]), 1), "putCr": round(cr(s["putOi"]), 1), "maxPain": s["maxPain"],
        "lot": u["lot"], "buildUp": build_up(u["chg"], u["fut_oi_chg"]),
    }


@router.get("/health")
def health():
    return {"ok": True, "sectors": _meta(sector_source)["source"], "chain": _meta(chain_source)["source"]}


@router.get("/sectors")
def sectors():
    stocks = [_stock(u) for u in sector_source.underlyings()]
    out = []
    for name in sector_source.SECTORS:
        group = [s for s in stocks if s["sector"] == name]
        if not group:
            continue
        # Price and OI change are weighted by option OI notional, so heavyweights count for more.
        w = [s["callCr"] + s["putCr"] for s in group]
        wavg = lambda k: sum(s[k] * wi for s, wi in zip(group, w)) / sum(w)  # noqa: E731
        chg, oi_chg = wavg("chg"), wavg("oiChg")
        ivs = [s["atmIv"] for s in group if s["atmIv"] is not None]
        call_cr, put_cr = sum(s["callCr"] for s in group), sum(s["putCr"] for s in group)
        out.append({
            "name": name, "chg": round(chg, 2), "oiChg": round(oi_chg, 2), "buildUp": build_up(chg, oi_chg),
            "pcr": round(put_cr / call_cr, 3), "callCr": round(call_cr, 1), "putCr": round(put_cr, 1),
            "iv": {"min": min(ivs), "avg": round(sum(ivs) / len(ivs), 2), "max": max(ivs)},
            "counts": {b: sum(1 for s in group if s["buildUp"] == b) for b in BUILD_UPS},
            "stocks": sorted(group, key=lambda s: -(s["callCr"] + s["putCr"])),
        })
    return {**_meta(sector_source), "expiry": sector_source.expiries("NIFTY")[0], "buildUps": BUILD_UPS,
            "indices": [s for s in stocks if s["sector"] == "Index"], "sectors": out}


@router.get("/symbols")
def symbols():
    return {**_meta(chain_source), "marginPct": MARGIN_PCT, "symbols": [
        {"symbol": u["symbol"], "sector": u["sector"], "index": u["index"], "spot": u["spot"],
         "chg": round(u["chg"], 2), "lot": u["lot"], "expiries": chain_source.expiries(u["symbol"])}
        for u in chain_source.underlyings()]}


@router.get("/chain")
def chain(symbol: str = Query(..., max_length=20), expiry: str | None = None):
    u = _underlying(symbol)
    expiries = chain_source.expiries(u["symbol"])
    expiry = expiry or expiries[0]
    if expiry not in expiries:
        raise HTTPException(404, f"No {expiry} expiry for {u['symbol']}")
    c, s = chain_summary(chain_source, u, expiry)
    return {**_meta(chain_source), **s, "symbol": u["symbol"], "sector": u["sector"], "index": u["index"], "expiry": expiry,
            "expiries": expiries, "chg": round(u["chg"], 2), "lot": u["lot"], "step": u["step"], "marginPct": MARGIN_PCT,
            "rows": [{"strike": x["strike"], "call": _side(x["CE"]), "put": _side(x["PE"])} for x in c["rows"]]}


@router.get("/surface")
def surface(symbol: str = Query(..., max_length=20)):
    """OI per strike and expiry for both sides, and the IV smile per expiry (out-of-the-money side: puts below
    spot, calls above). Strikes are the union across expiries; a strike missing from an expiry is null."""
    u = _underlying(symbol)
    chains = [(e, chain_source.chain(u["symbol"], e)) for e in chain_source.expiries(u["symbol"])]
    strikes = sorted({x["strike"] for _, c in chains for x in c["rows"]})
    grid = lambda f: [[f(by[k]) if k in by else None for k in strikes]  # noqa: E731
                      for by in ({x["strike"]: x for x in c["rows"]} for _, c in chains)]
    spot = u["spot"]
    return {**_meta(chain_source), "symbol": u["symbol"], "spot": spot, "lot": u["lot"], "strikes": strikes,
            "expiries": [{"expiry": e, "dte": c["dte"]} for e, c in chains],
            "callOi": grid(lambda x: x["CE"]["oi"]), "putOi": grid(lambda x: x["PE"]["oi"]),
            "iv": grid(lambda x: round((x["PE"] if x["strike"] < spot else x["CE"])["iv"], 2))}
