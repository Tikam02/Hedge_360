"""
Sample F&O market behind the web app's Sectoral analysis and Option chain tabs. Nothing is fetched.

Spot, lot size and the premiums of the screener's own contracts match the web app's screener snapshot
(web/lib/data.ts), so a contract shows the same price on every tab. Everything else comes from a seeded
generator: stable between restarts, but not market data.

derivs.py builds every chart from the three functions at the bottom (underlyings, expiries, chain).
Sectors always use this module. For the option chain, point DERIVS_CHAIN_SOURCE at a module of your own
(for example one that calls your stock-derivatives API) that provides the same three with the same shapes.
"""

import math
import random
from datetime import datetime
from functools import lru_cache

from scanner import IST

RATE = 0.065
# The screener snapshot's two monthly expiries, then two more months for the strike × expiry view.
EXPIRIES = ["31-Dec-2026", "25-Jan-2027", "23-Feb-2027", "30-Mar-2027"]
STRIKES_EACH_SIDE = 20

SECTORS = ["Banks", "Financial services", "IT", "Auto", "Pharma", "Energy & power",
           "Metals", "FMCG", "Capital goods", "Consumer & retail"]

# What each sector's stocks are drawn around: price change %, futures OI change %, put-call ratio, ATM IV %.
MOOD = {
    "Banks":              (0.9,  4.5, 1.12, 19),
    "Financial services": (0.5, -2.8, 0.98, 27),
    "IT":                 (-1.2, 6.2, 0.72, 24),
    "Auto":               (1.4,  3.1, 1.05, 29),
    "Pharma":             (-0.6, -3.6, 0.88, 22),
    "Energy & power":     (-0.9, 5.4, 0.79, 33),
    "Metals":             (1.9, -4.1, 1.21, 31),
    "FMCG":               (0.3,  1.4, 1.01, 18),
    "Capital goods":      (2.3,  7.8, 1.34, 35),
    "Consumer & retail":  (-1.6, -2.2, 0.83, 38),
}
INDEX_MOOD = {"NIFTY": (0.35, 2.1, 1.04, 12.5), "BANKNIFTY": (0.35, 2.1, 1.04, 14.5)}

# symbol, sector, spot, lot size, liquidity (scales open interest). Screener stocks use the screener CMP.
DEFS = [
    ("NIFTY", "Index", 25180, 65, 24), ("BANKNIFTY", "Index", 64650, 30, 10),
    ("HDFCBANK", "Banks", 1740, 550, 2.6), ("ICICIBANK", "Banks", 1260, 700, 2.2), ("SBIN", "Banks", 820, 1500, 2.4),
    ("AXISBANK", "Banks", 1180, 625, 1.5), ("KOTAKBANK", "Banks", 2140, 400, 1.2), ("INDUSINDBK", "Banks", 968.65, 700, 1.1),
    ("BAJFINANCE", "Financial services", 6850, 125, 1.6), ("HDFCLIFE", "Financial services", 580.9, 1100, 0.8),
    ("SBICARD", "Financial services", 590, 800, 0.6), ("RECLTD", "Financial services", 294.6, 1350, 0.9),
    ("MCX", "Financial services", 3604.1, 225, 1),
    ("INFY", "IT", 1880, 400, 2.3), ("TCS", "IT", 3420, 175, 1.9), ("WIPRO", "IT", 262, 3000, 0.9),
    ("HCLTECH", "IT", 1610, 350, 1.1), ("NAUKRI", "IT", 1250, 550, 0.6),
    ("TATAMOTORS", "Auto", 780, 1100, 2.1), ("M&M", "Auto", 3150, 200, 1.3), ("MARUTI", "Auto", 12400, 50, 1.2),
    ("BAJAJ-AUTO", "Auto", 8900, 75, 0.7),
    ("SUNPHARMA", "Pharma", 1790, 350, 1.2), ("DRREDDY", "Pharma", 1265, 625, 0.8), ("CIPLA", "Pharma", 1520, 375, 0.8),
    ("DIVISLAB", "Pharma", 6100, 100, 0.6),
    ("RELIANCE", "Energy & power", 1480, 500, 2.8), ("NTPC", "Energy & power", 345, 1500, 1.1),
    ("ADANIENSOL", "Energy & power", 1314.7, 675, 0.7), ("INOXWIND", "Energy & power", 96, 3575, 0.6),
    ("TATASTEEL", "Metals", 158, 5500, 1.6), ("HINDALCO", "Metals", 720, 1400, 1.1), ("JSWSTEEL", "Metals", 1050, 675, 0.8),
    ("ITC", "FMCG", 412, 1600, 1.5), ("HINDUNILVR", "FMCG", 2380, 300, 1), ("GODFRYPHLP", "FMCG", 2410.1, 275, 0.4),
    ("HAL", "Capital goods", 4250, 150, 1.4), ("BEL", "Capital goods", 410, 1425, 1.5), ("LT", "Capital goods", 3720, 175, 1.3),
    ("TRENT", "Consumer & retail", 6450, 100, 1), ("DIXON", "Consumer & retail", 10700, 50, 0.9),
    ("PIDILITIND", "Consumer & retail", 1490, 500, 0.5), ("PAGEIND", "Consumer & retail", 30340, 15, 0.4),
    ("TITAN", "Consumer & retail", 3550, 175, 1.1),
]

# Screener contracts (web/lib/data.ts) the chain must price exactly: (symbol, expiry, strike, type) -> premium.
# The December ones also set the stock's ATM IV, so the whole smile lines up with the screener.
SCREENER = {
    ("TATAMOTORS", "31-Dec-2026", 700, "PE"): 14.2, ("SBIN", "31-Dec-2026", 740, "PE"): 11.5,
    ("INFY", "31-Dec-2026", 1680, "PE"): 26.5, ("BAJFINANCE", "31-Dec-2026", 6100, "PE"): 115,
    ("ICICIBANK", "31-Dec-2026", 1140, "PE"): 16.8, ("HDFCBANK", "31-Dec-2026", 1580, "PE"): 22,
    ("HAL", "31-Dec-2026", 3800, "PE"): 72, ("DIXON", "31-Dec-2026", 9600, "PE"): 122.2,
    ("TRENT", "31-Dec-2026", 5700, "PE"): 110, ("SUNPHARMA", "31-Dec-2026", 1600, "PE"): 24,
    ("DIXON", "25-Jan-2027", 9600, "PE"): 135,
}


# ── Pricing ────────────────────────────────────────────
def _n(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(S, K, T, v, kind):
    if T <= 0 or v <= 0:
        return max(0.0, S - K if kind == "CE" else K - S)
    d1 = (math.log(S / K) + (RATE + v * v / 2) * T) / (v * math.sqrt(T))
    d2 = d1 - v * math.sqrt(T)
    if kind == "CE":
        return S * _n(d1) - K * math.exp(-RATE * T) * _n(d2)
    return K * math.exp(-RATE * T) * _n(-d2) - S * _n(-d1)


def delta(S, K, T, v, kind):
    d1 = (math.log(S / K) + (RATE + v * v / 2) * T) / (v * math.sqrt(T))
    return _n(d1) if kind == "CE" else _n(d1) - 1


def implied_vol(price, S, K, T, kind):
    lo, hi = 0.01, 3.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if bs(S, K, T, mid, kind) > price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def smile(S, K):
    """Put skew: out-of-the-money puts carry more IV than calls."""
    m = math.log(K / S)
    return min(2.2, max(0.75, 1 - 0.8 * m + 2.5 * m * m))


def tick(v):
    return max(0.05, round(v * 20) / 20)


def step_for(spot, symbol):
    if symbol == "NIFTY":
        return 50
    if symbol == "BANKNIFTY":
        return 100
    for limit, step in ((100, 1), (250, 2), (500, 5), (1000, 10), (2500, 20), (5000, 50), (20000, 100)):
        if spot < limit:
            return step
    return 250


def days_to(expiry, today):
    return (datetime.strptime(expiry, "%d-%b-%Y").date() - today).days


def _around(r, centre, spread):
    return centre + (r.random() * 2 - 1) * spread


def _today():
    return datetime.now(IST).date()


# ── Generator (cached per calendar day, since days to expiry move the prices) ──
@lru_cache(maxsize=4)
def _underlyings(today):
    out = []
    for symbol, sector, spot, lot, liq in DEFS:
        r = random.Random(symbol)
        index = sector == "Index"
        px, oi, pcr, iv = INDEX_MOOD[symbol] if index else MOOD[sector]
        chg = _around(r, px, 0.2 if index else 1.1)
        t0 = max(days_to(EXPIRIES[0], today), 0.5) / 365
        known = next(((k, p) for k, p in SCREENER.items() if k[0] == symbol and k[1] == EXPIRIES[0]), None)
        if known:
            (_, _, strike, kind), prem = known
            atm_iv = implied_vol(prem, spot, strike, t0, kind) / smile(spot, strike)
        else:
            atm_iv = max(0.09, _around(r, iv, 1.5 if index else 5) / 100)
        out.append({
            "symbol": symbol, "sector": sector, "index": index, "spot": spot, "prev": spot / (1 + chg / 100),
            "chg": chg, "lot": lot, "step": step_for(spot, symbol), "atm_iv": atm_iv,
            "iv_chg": _around(r, 4 if chg < 0 else -2.5, 3),
            "fut_oi_chg": _around(r, oi, 1 if index else 4),
            "pcr": min(1.7, max(0.45, _around(r, pcr, 0.16))), "liq": liq,
        })
    return tuple(out)


@lru_cache(maxsize=512)
def _chain(symbol, expiry, today):
    u = next(x for x in _underlyings(today) if x["symbol"] == symbol)
    ei = EXPIRIES.index(expiry)
    r = random.Random(f"{symbol}|{expiry}")
    dte = max(days_to(expiry, today), 0)
    T = max(dte, 0.5) / 365
    iv_atm = u["atm_iv"] * (1 + 0.04 * ei)
    S, step = u["spot"], u["step"]
    atm = math.floor(S / step + 0.5) * step
    peak = (4000 if u["index"] else 1900) * u["liq"] * (1, 0.32, 0.14, 0.08)[ei]

    def shape(d):
        # Writers crowd out-of-the-money strikes a few steps away, with a second hump further out.
        return (math.exp(d / 2.5) if d < 0 else 1) * (
            math.exp(-(((d - 5) / 6) ** 2)) + 0.35 * math.exp(-(((d - 12) / 7) ** 2)) + 0.04)

    rows = []
    for i in range(-STRIKES_EACH_SIDE, STRIKES_EACH_SIDE + 1):
        K = atm + i * step
        if K <= 0:
            continue
        roundness = 1.9 if K % (step * 10) == 0 else 1.5 if K % (step * 5) == 0 else 1.15 if K % (step * 2) == 0 else 1
        d = (K - S) / step
        row = {"strike": K}
        for kind in ("CE", "PE"):
            iv = iv_atm * smile(S, K)
            ltp = tick(bs(S, K, T, iv, kind))
            prev = max(0.05, bs(u["prev"], K, T + 1 / 365, iv * (1 - u["iv_chg"] / 100), kind))
            oi = peak * shape(d if kind == "CE" else -d) * roundness * (0.72 + 0.56 * r.random())
            near = 0.35 + 1.6 * math.exp(-((d / 6) ** 2))
            row[kind] = {"ltp": ltp, "chg": (ltp - prev) / prev * 100, "iv": iv * 100, "delta": delta(S, K, T, iv, kind),
                         "oi": oi, "chg_oi": 0, "vol": oi * near * (0.6 + 0.8 * r.random())}
        rows.append(row)

    # Scale puts so the chain's put-call ratio is the stock's, then derive OI change. OI is in contracts.
    scale = u["pcr"] * sum(x["CE"]["oi"] for x in rows) / sum(x["PE"]["oi"] for x in rows)
    for x in rows:
        c, p = x["CE"], x["PE"]
        p["oi"] *= scale
        p["vol"] *= scale
        # Rising price: call writers cover and put writers add. Falling price: the reverse.
        c["chg_oi"] = round(c["oi"] * (u["fut_oi_chg"] / 100 * 0.8 - u["chg"] / 100 * 2.5 + _around(r, 0, 0.1)))
        p["chg_oi"] = round(p["oi"] * (u["fut_oi_chg"] / 100 * 0.8 + u["chg"] / 100 * 2.5 + _around(r, 0, 0.1)))
        for kind, s in (("CE", c), ("PE", p)):
            s["oi"], s["vol"] = round(s["oi"]), round(s["vol"])
            known = SCREENER.get((symbol, expiry, x["strike"], kind))
            if known is not None:
                s["ltp"] = known
    fut = S * math.exp(RATE * T) * (1 + _around(r, 0, 0.0008))
    return {"spot": S, "fut": fut, "dte": dte, "rows": rows}


# ── The source interface derivs.py reads ───────────────
def underlyings():
    """Every F&O underlying as a dict. A chain source must give: symbol, sector ('Index' for indices),
    index (bool), spot, chg (price change %), lot, step (strike gap). Sectors also read fut_oi_chg and iv_chg."""
    return _underlyings(_today())


def expiries(symbol):
    """Expiry labels like '31-Dec-2026', nearest first. The chain page opens on the first."""
    return list(EXPIRIES)


def chain(symbol, expiry):
    """One expiry's chain: {spot, fut, dte, rows: [{strike, CE: {...}, PE: {...}}]}, rows in strike order,
    each side with ltp, chg (%), iv (% or None), delta, oi (contracts), chg_oi (contracts) and vol."""
    return _chain(symbol, expiry, _today())
