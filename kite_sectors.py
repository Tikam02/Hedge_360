"""
Kite Connect as the Sectoral analysis source. derivs.py uses it whenever the chain source is kite_chain
(kite_chain.SECTOR_SOURCE), so logging in to Zerodha on the Profile page moves both tabs to live data.

Read only, like kite_chain: market quotes through kite_client, nothing else.

Gives what derivs.py reads from a sector source (SECTORS, underlyings, expiries, chain, in derivs_sample's shapes)
for every F&O underlying, each on its nearest expiry:
  - One batched pass of full quotes, at most once a minute: the strikes nearest the spot (SECTOR_STRIKES each
    side), every futures month, and for the Screener every listed strike SCREEN_OTM % out of the money on its
    out-of-the-money side. About 12,000 instruments, asked for by instrument token (500 to a call), so about 25
    quote calls at Kite's one a second: a load that needs a new pass takes that long, and the Option chain's quotes
    queue behind it. Later loads within the minute are instant.
  - The Screener reads the same passes through snapshot(): the last pass whatever its age, so opening it doesn't
    wait; a new pass only on the day's first visit or on its Re-scan button. Each pass also starts the day's
    kite_history fill (daily bars for the 52-week range) the first time.
  - Put-call ratio and option OI value cover those strikes only, which hold most of a stock's open interest.
  - Futures OI change is all months together, measured from the first reading of the day (as change in OI is in
    kite_chain), so a near-month rollover doesn't read as unwinding.
  - IV change is the ATM IV now against the same options at yesterday's close, in percent.
  - Kite gives no sector, so stocks are grouped by SECTOR_OF below; a stock missing from it shows under Other.
"""

import math
import threading
import time
from collections import Counter
from datetime import datetime
from types import SimpleNamespace

import derivs_sample
import kite_chain
import kite_history
from scanner import IST

SECTOR_STRIKES = 10
SCREEN_OTM = (3, 25)  # % out of the money the Screener lists; the pass quotes every listed strike in it
TTL = 60

SECTOR_OF = {}
for _sector, _names in {
    "Banks": "HDFCBANK ICICIBANK SBIN AXISBANK KOTAKBANK INDUSINDBK BANKBARODA PNB CANBK FEDERALBNK IDFCFIRSTB AUBANK "
             "BANDHANBNK UNIONBANK BANKINDIA INDIANB RBLBANK YESBANK CUB KARURVYSYA MAHABANK UJJIVANSFB",
    "Financial services": "BAJFINANCE BAJAJFINSV HDFCLIFE SBILIFE ICICIPRULI ICICIGI SBICARD CHOLAFIN SHRIRAMFIN MUTHOOTFIN "
                          "MANAPPURAM LICHSGFIN PFC RECLTD IRFC M&MFIN PEL PIRAMALFIN POONAWALLA LICI JIOFIN HDFCAMC ANGELONE "
                          "CDSL BSE MCX CAMS KFINTECH NUVAMA 360ONE IIFL ABCAPITAL LTF SAMMAANCAP PNBHOUSING HUDCO IREDA "
                          "BAJAJHFL PAYTM POLICYBZR MFSL ANANDRATHI ICICILIFE MOTILALOFS NAM-INDIA",
    "IT": "INFY TCS WIPRO HCLTECH TECHM LTIM LTM MPHASIS PERSISTENT COFORGE OFSS KPITTECH TATAELXSI TATATECH LTTS CYIENT "
          "NAUKRI SAGILITY",
    "Auto": "TATAMOTORS TMPV TMCV M&M MARUTI BAJAJ-AUTO HEROMOTOCO EICHERMOT TVSMOTOR ASHOKLEY BHARATFORG MOTHERSON BOSCHLTD "
            "EXIDEIND SONACOMS TIINDIA UNOMINDA APOLLOTYRE BALKRISIND MRF ESCORTS HYUNDAI FORCEMOT ATHERENERG",
    "Pharma": "SUNPHARMA DRREDDY CIPLA DIVISLAB LUPIN AUROPHARMA ZYDUSLIFE TORNTPHARM ALKEM BIOCON GLENMARK MANKIND "
              "LAURUSLABS GRANULES IPCALAB ABBOTINDIA APOLLOHOSP MAXHEALTH FORTIS SYNGENE PPLPHARMA",
    "Energy & power": "RELIANCE NTPC POWERGRID ONGC BPCL IOC HINDPETRO GAIL PETRONET OIL TATAPOWER ADANIGREEN ADANIENSOL "
                      "ADANIPOWER NHPC SJVN JSWENERGY TORNTPOWER CESC INOXWIND SUZLON IGL MGL COALINDIA WAAREEENER "
                      "PREMIERENE NTPCGREEN",
    "Metals": "TATASTEEL HINDALCO JSWSTEEL JINDALSTEL SAIL VEDL NATIONALUM NMDC HINDZINC APLAPOLLO HINDCOPPER",
    "FMCG": "ITC HINDUNILVR NESTLEIND BRITANNIA DABUR MARICO GODREJCP COLPAL TATACONSUM UNITDSPR VBL PATANJALI GODFRYPHLP "
            "RADICO",
    "Capital goods": "HAL BEL LT SIEMENS ABB BHEL CGPOWER CUMMINSIND POLYCAB KEI BDL MAZDOCK SOLARINDS SUPREMEIND ASTRAL "
                     "KAYNES APARINDS COCHINSHIP DATAPATTNS ENRIN GVT&D POWERINDIA SYRMA",
    "Consumer & retail": "TRENT DIXON PIDILITIND PAGEIND TITAN ASIANPAINT BERGEPAINT DMART NYKAA ETERNAL ZOMATO SWIGGY "
                         "KALYANKJIL VOLTAS HAVELLS BLUESTARCO CROMPTON JUBLFOOD IRCTC INDHOTEL AMBER PGEL VMM",
    "Cement & chemicals": "ULTRACEMCO SHREECEM AMBUJACEM ACC DALBHARAT GRASIM PIIND UPL SRF DEEPAKNTR TATACHEM "
                          "COROMANDEL NAVINFLUOR ACUTAAS",
    "Realty": "DLF GODREJPROP LODHA OBEROIRLTY PRESTIGE PHOENIXLTD",
    "Telecom & media": "BHARTIARTL IDEA INDUSTOWER TATACOMM HFCL",
    "Infra & logistics": "ADANIPORTS ADANIENT GMRAIRPORT CONCOR DELHIVERY INDIGO RVNL NBCC IRB",
}.items():
    SECTOR_OF.update(dict.fromkeys(_names.split(), _sector))
SECTORS = list(dict.fromkeys([*derivs_sample.SECTORS, *SECTOR_OF.values(), "Other"]))

_lock = threading.Lock()
_snap = {"at": 0.0, "underlyings": [], "chains": {}, "screen": {}, "expiry": None, "since": None, "scanned": None}
RESCAN_GAP = 15  # seconds: a Re-scan sooner than this after the last pass returns that pass


def status():
    return kite_chain.status()


def _prev_gap(today):
    """Calendar days back to the previous weekday's close (holidays aren't known here)."""
    return 3 if today.weekday() == 0 else 2 if today.weekday() == 6 else 1


def _atm_iv(rows, spot):
    atm = min(rows, key=lambda x: abs(x["strike"] - spot))
    ivs = [s["iv"] for s in (atm["CE"], atm["PE"]) if s["iv"]]
    return sum(ivs) / len(ivs) if ivs else None


def _iv_then(q, contracts, prev_spot, dte):
    """ATM IV (%) from yesterday's closing prices, against yesterday's spot close."""
    K, ce, pe = min(contracts, key=lambda c: abs(c[0] - prev_spot))
    T = kite_chain._years(dte + _prev_gap(kite_chain._today()))
    ivs = []
    for inst, kind in ((ce, "CE"), (pe, "PE")):
        close = ((q.get(inst["key"]) or {}).get("ohlc") or {}).get("close") or 0
        v = kite_chain._iv(close, prev_spot, K, T, kind)
        if v:
            ivs.append(v * 100)
    return sum(ivs) / len(ivs) if ivs else None


def _otm(by_strike, spot):
    """Every listed strike SCREEN_OTM % out of the money, as (strike, CE, PE), and the keys of its out-of-the-money
    side (puts below the spot, calls above): the only side the Screener lists, so the only one quoted."""
    lo, hi = SCREEN_OTM
    rows, keys = [], []
    for K in sorted(by_strike):
        sides, kind = by_strike[K], "PE" if K < spot else "CE"
        if "CE" in sides and "PE" in sides and lo <= abs(K - spot) / spot * 100 <= hi:
            rows.append((K, sides["CE"], sides["PE"]))
            keys.append(sides[kind]["key"])
    return rows, keys


def _refresh():
    book, spots = kite_chain._book(), kite_chain._spots()
    plans, keys = [], []
    for u in kite_chain.underlyings():
        b = book[u["symbol"]]
        near = min(b["exp"])
        spot, contracts, fut = kite_chain._contracts(u["symbol"], near, SECTOR_STRIKES)
        if not contracts:
            continue
        wide, wide_keys = ([], []) if u["index"] else _otm(b["exp"][near], spot)
        futs = [f["key"] for f in b["fut"].values()]
        plans.append((u, near, spot, contracts, wide, fut, futs))
        keys += [i["key"] for _, ce, pe in contracts for i in (ce, pe)] + futs + wide_keys
    q = kite_chain._quote(keys)  # one pass, by instrument token, 500 to a call
    base = kite_chain._oi_baseline({k: int(q[k].get("oi") or 0) for *_, futs in plans for k in futs if k in q})

    out, chains, screen, nears = [], {}, {}, Counter()
    for u, near, spot, contracts, wide, fut, futs in plans:
        c = kite_chain.build(near, spot, contracts, fut, q)
        if wide:
            screen[u["symbol"]] = kite_chain.build(near, spot, wide, fut, q)
        now_oi = sum(int(q[k].get("oi") or 0) for k in futs if k in q)
        then_oi = sum(base[k][0] for k in futs if k in base)
        sq = spots[u["symbol"]]
        day = sq.get("ohlc") or {}
        prev_spot = day.get("close") or spot
        iv_now, iv_then = _atm_iv(c["rows"], spot), _iv_then(q, contracts, prev_spot, c["dte"])
        out.append({**u, "sector": "Index" if u["index"] else SECTOR_OF.get(u["symbol"], "Other"),
                    "fut_oi_chg": (now_oi - then_oi) / then_oi * 100 if then_oi else 0.0,
                    "iv_chg": (iv_now - iv_then) / iv_then * 100 if iv_now and iv_then else 0.0,
                    "token": book[u["symbol"]]["spot"]["token"], "day_high": day.get("high"), "day_low": day.get("low")})
        chains[u["symbol"]] = c
        if not u["index"]:
            nears[near] += 1
    since = max((base[k][1] for k in base), default=None)
    expiry = kite_chain._label(nears.most_common(1)[0][0]) if nears else None
    _snap.update(at=time.monotonic(), underlyings=out, chains=chains, screen=screen, expiry=expiry, since=since,
                 scanned=datetime.now(IST).isoformat(timespec="seconds"))
    kite_history.fill({u["symbol"]: u["token"] for u in out if not u["index"] and u["token"]})


def _fresh(max_age=TTL):
    """The current pass, after a new one if the last is older than max_age seconds or from an earlier day. A copy,
    since _refresh updates _snap in place."""
    with _lock:
        today = datetime.now(IST).date().isoformat()
        if time.monotonic() - _snap["at"] > max_age or (_snap["scanned"] or "")[:10] != today:
            _refresh()
        return dict(_snap)


def snapshot(rescan=False):
    """One pass for the Screener, with this module's underlyings / expiries / chain, so a whole answer reads the same
    pass; chain() is each stock's SCREEN_OTM chain, out-of-the-money side only. The last pass whatever its age (the
    tab shows when it was scanned); with rescan, a new pass unless the last is under RESCAN_GAP seconds old."""
    snap = _fresh(RESCAN_GAP if rescan else math.inf)
    empty = {"spot": 0, "fut": 0, "dte": 0, "rows": []}
    return SimpleNamespace(scanned=snap["scanned"], underlyings=lambda: snap["underlyings"], expiries=expiries,
                           chain=lambda symbol, expiry: snap["screen"].get(symbol, empty))


# ── The source interface derivs.py reads ───────────────
def underlyings():
    """kite_chain's underlyings with a sector, fut_oi_chg (%) and iv_chg (%)."""
    return _fresh()["underlyings"]


def expiries(symbol):
    """Only the expiry the tab uses: the nearest."""
    b = kite_chain._book().get(symbol)
    return [kite_chain._label(min(b["exp"]))] if b else []


def chain(symbol, expiry):
    return _fresh()["chains"][symbol]


def near_expiry():
    """The stocks' nearest expiry, for the tab's heading (index weeklies expire sooner)."""
    return _fresh()["expiry"]


def oi_since():
    """"HH:MM" IST of the futures OI reading the change is measured from."""
    return _fresh()["since"]


del _sector, _names
