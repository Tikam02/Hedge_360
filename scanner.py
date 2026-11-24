"""
Scan engine for the web app — the same screen as pe.py, written against the
current `nse` library (v5: fno_lots / option_chain / quote, snake_case), run in
a background thread so the browser can watch progress.

Fixed config (margin %, pauses, retries, indices) is imported from pe.py so
both stay in step.
"""

import threading
import time
import json
from collections import deque
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
from nse import NSE

from pe import MARGIN_PCT, SLEEP_BETWEEN, MAX_RETRIES, RETRY_WAIT, INDEX_SYMBOLS

BASE_DIR    = Path(__file__).resolve().parent
CACHE_DIR   = BASE_DIR / ".nse_cache"
RESULTS_DIR = BASE_DIR / "results"
LAST_FILE   = RESULTS_DIR / "last.json"
IST         = timezone(timedelta(hours=5, minutes=30))

CSV_COLUMNS = [
    ("symbol", "Symbol"), ("cmp", "CMP (₹)"), ("strike", "Strike"), ("pct_below_cmp", "% OTM"),
    ("pe_premium", "Premium/Share (₹)"), ("lot_size", "Lot Size"), ("total_premium", "Total Premium (₹)"),
    ("margin", "Margin (₹)"), ("prem_pct_of_margin", "Prem % of Margin"), ("expiry", "Expiry"),
    ("underlying", "Underlying (₹)"), ("week52_high", "52W High (₹)"), ("week52_low", "52W Low (₹)"),
    ("pe_ratio", "Stock PE"), ("iv", "IV%"), ("oi", "OI"), ("volume", "Volume"),
]


def market_open(now=None) -> bool:
    """By the clock only (Mon–Fri 9:15–15:30 IST); exchange holidays are not known."""
    now = now or datetime.now(IST)
    if now.weekday() >= 5:
        return False
    t = now.hour * 60 + now.minute
    return 9 * 60 + 15 <= t <= 15 * 60 + 30


def _num(v):
    try:
        f = float(str(v).replace(",", ""))
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


class Scan:
    def __init__(self, strike_below: float, prem_min_pct: float):
        self.id           = datetime.now(IST).strftime("%Y%m%d_%H%M%S")
        self.strike_below = strike_below
        self.prem_min_pct = prem_min_pct
        self.status       = "starting"      # starting | running | done | stopped | error
        self.stage        = "Fetching F&O lot sizes"
        self.error        = None
        self.total        = 0
        self.done         = 0
        self.current      = None
        self.log          = deque(maxlen=400)
        self.log_seq      = 0
        self.skipped      = []
        self.stocks       = []              # one entry per stock with at least one passing strike
        self.cells        = []              # per-symbol outcome, in scan order: hit | none | skip
        self.expiry       = None
        self.as_of        = None
        self.market_open  = market_open()
        self.started_at   = time.time()
        self.finished_at  = None
        self.csv_file     = None
        self._stop        = threading.Event()
        self._lock        = threading.Lock()

    # ── control ─────────────────────────────
    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self):
        self._stop.set()

    @property
    def running(self):
        return self.status in ("starting", "running")

    # ── helpers ─────────────────────────────
    def _add_log(self, **entry):
        with self._lock:
            self.log_seq += 1
            entry["seq"] = self.log_seq
            self.log.append(entry)

    def _retry(self, fn, label):
        for attempt in range(1, MAX_RETRIES + 1):
            if self._stop.is_set():
                return None
            try:
                return fn()
            except Exception as e:
                err = str(e)[:80]
                if attempt < MAX_RETRIES:
                    wait = RETRY_WAIT * (2 ** (attempt - 1))
                    self._add_log(kind="retry", sym=label, text=f"{err} — retry {attempt}/{MAX_RETRIES} in {wait}s")
                    self._stop.wait(wait)
                else:
                    self._add_log(kind="error", sym=label, text=f"{err} — gave up after {MAX_RETRIES} tries")
        return None

    def _sleep(self, secs):
        self._stop.wait(secs)

    # ── the scan ────────────────────────────
    def _run(self):
        try:
            CACHE_DIR.mkdir(exist_ok=True)
            with NSE(download_folder=CACHE_DIR) as nse:
                self._scan(nse)
        except Exception as e:
            self.error  = str(e)
            self.status = "error"
        finally:
            self.finished_at = time.time()
            self.current = None
            if self.status in ("starting", "running"):
                self.status = "stopped" if self._stop.is_set() else "done"
            self._save()

    def _scan(self, nse):
        lots = self._retry(nse.fno_lots, "fno_lots")
        if not lots:
            raise RuntimeError("Could not fetch F&O lot sizes from NSE")

        self.stage = "Fetching prices"
        bulk = {}
        data = self._retry(lambda: nse.list_equity_stocks_by_index("SECURITIES IN F&O"), "F&O list")
        for row in (data or {}).get("data", []):
            sym = (row.get("symbol") or "").upper()
            if sym:
                bulk[sym] = row

        if bulk:
            symbols = sorted(s for s in lots if s in bulk)
        else:
            symbols = sorted(s for s in lots if s not in INDEX_SYMBOLS)

        self.total  = len(symbols)
        self.status = "running"
        self.stage  = "Scanning"

        for symbol in symbols:
            if self._stop.is_set():
                break
            self.current = symbol
            self._scan_one(nse, symbol, lots.get(symbol, 100), bulk.get(symbol, {}))
            self.done += 1
            self._sleep(SLEEP_BETWEEN)

    def _scan_one(self, nse, symbol, lot_size, b):
        i = self.done + 1
        cmp = _num(b.get("lastPrice")) or _num(b.get("previousClose"))
        q = None
        if not cmp:
            q = self._retry(lambda: nse.quote(symbol), symbol)
            if q:
                cmp = _num(q.get("orderBook", {}).get("lastPrice")) or _num(q.get("metaData", {}).get("closePrice"))
        if not cmp:
            self.skipped.append(symbol)
            self.cells.append("skip")
            self._add_log(kind="skip", i=i, sym=symbol, text="no price — skipped")
            return

        oc = self._retry(lambda: nse.option_chain(symbol), symbol)
        records = (oc or {}).get("records", {})
        rows = records.get("data", [])
        if not rows:
            self.skipped.append(symbol)
            self.cells.append("skip")
            self._add_log(kind="skip", i=i, sym=symbol, cmp=cmp, lot=lot_size, text="no option chain — skipped")
            return

        expiries = sorted({r["expiryDates"] for r in rows if r.get("expiryDates")},
                          key=lambda d: datetime.strptime(d, "%d-%b-%Y"))
        expiry = expiries[0]
        self.expiry = self.expiry or expiry
        self.as_of  = records.get("timestamp") or self.as_of
        underlying  = _num(records.get("underlyingValue"))

        max_strike = cmp * (1 - self.strike_below / 100)
        passes, fails = [], []
        for r in rows:
            if r.get("expiryDates") != expiry or "PE" not in r:
                continue
            strike = float(r.get("strikePrice", 0))
            if strike > max_strike:
                continue
            pe = r["PE"]
            premium = _num(pe.get("lastPrice")) or _num(pe.get("buyPrice1")) or _num(pe.get("sellPrice1"))
            if not premium:
                continue
            total_premium = lot_size * premium
            margin        = strike * lot_size * MARGIN_PCT / 100
            pct           = total_premium / margin * 100 if margin else 0
            if pct >= self.prem_min_pct:
                passes.append({
                    "symbol": symbol, "cmp": round(cmp, 2), "strike": strike,
                    "pct_below_cmp": round((cmp - strike) / cmp * 100, 2),
                    "pe_premium": round(premium, 2), "lot_size": lot_size,
                    "total_premium": round(total_premium, 2), "margin": round(margin, 2),
                    "prem_pct_of_margin": round(pct, 2), "expiry": expiry,
                    "underlying": round(underlying, 2) if underlying else "-",
                    "iv": pe.get("impliedVolatility", "-"), "oi": pe.get("openInterest", 0),
                    "volume": pe.get("totalTradedVolume", 0),
                })
            else:
                fails.append(strike)

        if not passes:
            self.cells.append("none")
            self._add_log(kind="none", i=i, sym=symbol, cmp=cmp, lot=lot_size, text="no match")
            return

        # 52W from the bulk list, PE ratio from a quote (one call per matching stock)
        hi, lo = _num(b.get("yearHigh")), _num(b.get("yearLow"))
        if q is None:
            q = self._retry(lambda: nse.quote(symbol), symbol)
            self._sleep(0.5)
        pe_ratio = "-"
        if q:
            pe_ratio = _num(q.get("secInfo", {}).get("pdSymbolPe"))
            pe_ratio = round(pe_ratio, 2) if pe_ratio else "-"
            hi = hi or _num(q.get("priceInfo", {}).get("yearHigh"))
            lo = lo or _num(q.get("priceInfo", {}).get("yearLow"))

        passes.sort(key=lambda m: m["strike"], reverse=True)
        for m in passes:
            m.update(week52_high=round(hi, 2) if hi else "-", week52_low=round(lo, 2) if lo else "-", pe_ratio=pe_ratio)

        with self._lock:
            self.stocks.append({
                "symbol": symbol, "cmp": round(cmp, 2), "lot_size": lot_size, "underlying": passes[0]["underlying"],
                "week52_high": passes[0]["week52_high"], "week52_low": passes[0]["week52_low"], "pe_ratio": pe_ratio,
                "best": max(m["prem_pct_of_margin"] for m in passes),
                "strikes": passes, "fails": sorted(fails, reverse=True),
            })
        self.cells.append("hit")
        self._add_log(kind="hit", i=i, sym=symbol, cmp=cmp, lot=lot_size,
                      text=f"{len(passes)} strike(s): " + ", ".join(f"{m['strike']:g}" for m in passes))

    # ── output ──────────────────────────────
    def rows(self):
        out = [m for s in self.stocks for m in s["strikes"]]
        out.sort(key=lambda m: m["prem_pct_of_margin"], reverse=True)
        return out

    def _save(self):
        RESULTS_DIR.mkdir(exist_ok=True)
        rows = self.rows()
        if rows:
            df = pd.DataFrame(rows)[[k for k, _ in CSV_COLUMNS]]
            df.columns = [label for _, label in CSV_COLUMNS]
            self.csv_file = RESULTS_DIR / f"nse_pe_results_{self.id}.csv"
            df.to_csv(self.csv_file, index=False)
        if self.status != "error" or self.stocks:
            LAST_FILE.write_text(json.dumps(self.snapshot(full=True)))

    def snapshot(self, since: int = 0, full: bool = False) -> dict:
        with self._lock:
            log = [e for e in self.log if e["seq"] > since]
            stocks = sorted(self.stocks, key=lambda s: s["best"], reverse=True)
        end = self.finished_at or time.time()
        snap = {
            "id": self.id, "status": self.status, "stage": self.stage, "error": self.error,
            "strike_below": self.strike_below, "prem_min_pct": self.prem_min_pct,
            "total": self.total, "done": self.done, "current": self.current,
            "skipped": self.skipped, "cells": self.cells, "log": log,
            "expiry": self.expiry, "as_of": self.as_of, "market_open": self.market_open,
            "started_at": self.started_at, "elapsed": round(end - self.started_at, 1),
            "has_csv": bool(self.csv_file), "margin_pct": MARGIN_PCT,
            "stocks": stocks, "matches": sum(len(s["strikes"]) for s in stocks),
        }
        if full:
            snap["csv_file"] = str(self.csv_file) if self.csv_file else None
        return snap


class SavedScan:
    """The last finished scan, read back from results/last.json after a restart."""

    def __init__(self, snap: dict):
        self.snap    = snap
        self.id      = snap["id"]
        self.running = False
        csv = snap.get("csv_file")
        self.csv_file = Path(csv) if csv and Path(csv).exists() else None

    def snapshot(self, since: int = 0, full: bool = False) -> dict:
        snap = dict(self.snap, log=[e for e in self.snap.get("log", []) if e["seq"] > since])
        snap["has_csv"] = bool(self.csv_file)
        snap.pop("csv_file", None)
        return snap

    def stop(self):
        pass


def load_last():
    try:
        return SavedScan(json.loads(LAST_FILE.read_text()))
    except (OSError, ValueError, KeyError):
        return None
