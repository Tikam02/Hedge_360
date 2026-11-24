"""
NSE Put Option Screener (v11 — fixed extras + timestamped CSV)
======================================================================
Finds F&O stocks where:
  - All strikes >= X% below CMP pass the premium filter
  - CSV includes: Futures Price (same expiry), 52W High, 52W Low, PE Ratio

Install:
    pip install "nse[local]" pandas tabulate

Run:
    python nse_pe_screener_v11.py
"""

import time
import tempfile
from pathlib import Path
from datetime import datetime

import pandas as pd
from tabulate import tabulate
from nse import NSE

# ─────────────────────────────────────────────
# FIXED CONFIG
# ─────────────────────────────────────────────
MARGIN_PCT    = 15.0
SLEEP_BETWEEN = 1.2
MAX_RETRIES   = 3
RETRY_WAIT    = 5
MAX_STOCKS    = None
DEBUG_CMP     = False

INDEX_SYMBOLS = {
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
    "NIFTYNXT50", "NIFTY50", "NIFTY100", "NIFTY200",
    "NIFTY500", "NIFTYIT", "NIFTYMIDCAP", "NIFTYSMALLCAP",
    "NIFTYMIDCAP50", "NIFTY MIDCAP SELECT",
}


# ─────────────────────────────────────────────
# USER INPUT
# ─────────────────────────────────────────────
def ask_float(prompt: str, default: float, lo: float, hi: float) -> float:
    while True:
        try:
            raw = input(f"  {prompt} [{default}]: ").strip()
            val = float(raw) if raw else default
            if lo <= val <= hi:
                return val
            print(f"    ⚠️  Enter a value between {lo} and {hi}")
        except ValueError:
            print("    ⚠️  Please enter a valid number")


def get_user_inputs() -> tuple:
    print("\n" + "=" * 65)
    print("  NSE F&O Put Option Screener  (v11)")
    print("=" * 65)
    print("  Press ENTER to accept the default shown in [brackets]\n")

    strike_below = ask_float("Strike % BELOW CMP         (e.g. 5 / 8 / 10 / 15)", 10.0, 1.0, 40.0)
    prem_min_pct = ask_float("Min premium as % of margin (e.g. 3 / 5 / 8 / 10)",   5.0, 0.1, 100.0)

    return strike_below, prem_min_pct


# ─────────────────────────────────────────────
# RETRY WRAPPER
# ─────────────────────────────────────────────
def call_with_retry(fn, label: str):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn()
        except Exception as e:
            err = str(e)
            is_timeout = any(k in err for k in ["ReadTimeout", "ConnectTimeout", "ConnectionError", "timed out"])
            if attempt < MAX_RETRIES:
                wait = RETRY_WAIT * (2 ** (attempt - 1))
                tag  = "⏱️  Timeout" if is_timeout else f"⚠️  Error ({err[:50]})"
                print(f"{tag} — retry {attempt}/{MAX_RETRIES} in {wait}s...", end=" ", flush=True)
                time.sleep(wait)
            else:
                tag = "⏱️  Timeout" if is_timeout else f"❌  Error ({err[:60]})"
                print(f"{tag} after {MAX_RETRIES} retries — skipping {label}")
                return None
    return None


# ─────────────────────────────────────────────
# PRICE EXTRACTOR
# ─────────────────────────────────────────────
def extract_price(obj, depth=0):
    if depth > 5:
        return None
    PRICE_KEYS = ["lastPrice", "previousClose", "closePrice", "close", "prevClose", "ltp", "open"]
    if isinstance(obj, dict):
        for key in PRICE_KEYS:
            val = obj.get(key)
            if val is not None:
                try:
                    p = float(str(val).replace(",", ""))
                    if p > 0:
                        return p
                except Exception:
                    pass
        for v in obj.values():
            result = extract_price(v, depth + 1)
            if result:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = extract_price(item, depth + 1)
            if result:
                return result
    return None


# ─────────────────────────────────────────────
# FETCH STOCK EXTRAS (52W H/L, PE, Futures)
# ─────────────────────────────────────────────
def fetch_stock_extras(nse_obj, symbol: str) -> dict:
    """
    Fetch:
      - 52W High & Low  from quote().priceInfo.weekHighLow
      - PE Ratio        from quote().metadata.pdSymbolPe
      - Futures price   from compileOptionChain(symbol, expiry) — underlying futures value
    """
    extras = {
        "week52_high"   : "-",
        "week52_low"    : "-",
        "pe_ratio"      : "-",
    }

    # ── 52W High/Low and PE from quote() ──
    try:
        q = call_with_retry(lambda: nse_obj.quote(symbol), symbol)
        if q:
            # 52W High/Low
            whl = q.get("priceInfo", {}).get("weekHighLow", {})
            if whl:
                try:
                    extras["week52_high"] = round(float(whl.get("max", 0)), 2)
                    extras["week52_low"]  = round(float(whl.get("min", 0)), 2)
                except Exception:
                    pass
            # PE Ratio
            try:
                pe = q.get("metadata", {}).get("pdSymbolPe")
                if pe:
                    extras["pe_ratio"] = round(float(pe), 2)
            except Exception:
                pass
    except Exception:
        pass

    return extras


# ─────────────────────────────────────────────
# OPTION CHAIN SCANNER
# ─────────────────────────────────────────────
def find_matching_puts(
    nse_obj, symbol, cmp, lot_size,
    strike_below_pct, prem_min_pct
) -> list[dict]:
    max_strike = cmp * (1 - strike_below_pct / 100)

    oc = call_with_retry(lambda: nse_obj.optionChain(symbol), symbol)
    if not oc:
        return []

    data = oc.get("records", {}).get("data", [])
    if not data:
        return []

    expiry_dates = sorted(
        {item["expiryDates"] for item in data if item.get("expiryDates")},
        key=lambda d: datetime.strptime(d, "%d-%b-%Y")
    )
    if not expiry_dates:
        return []

    nearest_expiry = expiry_dates[0]

    # Futures price is in the option chain response directly
    futures_price = oc.get("records", {}).get("underlyingValue") or "-"
    if futures_price != "-":
        try:
            futures_price = round(float(futures_price), 2)
        except Exception:
            futures_price = "-"

    candidates = []
    for item in data:
        if item.get("expiryDates") != nearest_expiry:
            continue
        if "PE" not in item:
            continue
        strike = float(item.get("strikePrice", 0))
        if strike > max_strike:
            continue
        pe      = item["PE"]
        raw_p   = pe.get("lastPrice") or pe.get("closePrice") or pe.get("bidprice") or pe.get("askPrice") or 0
        try:
            premium = float(raw_p)
        except Exception:
            premium = 0
        if premium <= 0:
            continue
        candidates.append((strike, premium, pe))

    if not candidates:
        return []

    candidates.sort(key=lambda x: x[0], reverse=True)

    matches = []
    for strike, premium, pe in candidates:
        total_premium      = lot_size * premium
        margin             = strike * lot_size * MARGIN_PCT / 100
        prem_pct_of_margin = (total_premium / margin * 100) if margin else 0

        if prem_pct_of_margin >= prem_min_pct:
            matches.append({
                "symbol"            : symbol,
                "cmp"               : round(cmp, 2),
                "strike"            : strike,
                "pct_below_cmp"     : round((cmp - strike) / cmp * 100, 2),
                "pe_premium"        : round(premium, 2),
                "lot_size"          : lot_size,
                "total_premium"     : round(total_premium, 2),
                "margin"            : round(margin, 2),
                "prem_pct_of_margin": round(prem_pct_of_margin, 2),
                "expiry"            : nearest_expiry,
                "futures_price"     : futures_price,
                "iv"                : pe.get("impliedVolatility", "-"),
                "oi"                : pe.get("openInterest", 0),
            })

    return matches


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def run_screener():
    strike_below, prem_min_pct = get_user_inputs()

    tmp_dir = Path(tempfile.gettempdir()) / "nse_screener"
    tmp_dir.mkdir(exist_ok=True)

    print("\n" + "=" * 65)
    print(f"  Strikes       : ALL strikes >= {strike_below}% below CMP")
    print(f"  Margin        : 15% of (Strike × Lot Size)")
    print(f"  Min premium   : >= {prem_min_pct}% of margin")
    print(f"  Extra columns : Futures Price, 52W High, 52W Low, PE Ratio")
    print(f"  Retries       : up to {MAX_RETRIES}x on timeout")
    print("=" * 65)

    with NSE(download_folder=tmp_dir) as nse:

        # Step 1: Lot sizes
        print("\n📋 Fetching F&O lot sizes...")
        fno_lots = call_with_retry(lambda: nse.fnoLots(), "fnoLots")
        if not fno_lots:
            print("❌ Could not fetch lot sizes.")
            return

        symbols = sorted([s for s in fno_lots.keys() if s not in INDEX_SYMBOLS])
        if MAX_STOCKS:
            symbols = symbols[:MAX_STOCKS]
        print(f"✅ {len(symbols)} stocks to scan\n")

        # Step 2: Bulk price fetch
        print("💹 Fetching prices (bulk)...")
        quote_map = {}
        try:
            fno_data = call_with_retry(lambda: nse.listFnoStocks(), "listFnoStocks")
            if fno_data:
                raw_list = fno_data if isinstance(fno_data, list) else fno_data.get("data", [])
                for stock in raw_list:
                    sym   = stock.get("symbol", "").upper()
                    price = extract_price(stock)
                    if sym and price:
                        quote_map[sym] = price
                print(f"✅ Bulk prices for {len(quote_map)} stocks\n")
            else:
                print("⚠️  Bulk fetch failed — will fetch individually\n")
        except Exception as e:
            print(f"⚠️  Bulk fetch error: {e} — will fetch individually\n")

        # Step 3: Scan
        results     = []
        skipped     = []
        debug_shown = False

        for i, symbol in enumerate(symbols, 1):
            print(f"[{i:>3}/{len(symbols)}] {symbol:<20}", end="", flush=True)

            cmp = quote_map.get(symbol)
            if not cmp:
                eq = call_with_retry(lambda: nse.equityQuote(symbol), symbol)
                if eq:
                    cmp = extract_price(eq)
                    if DEBUG_CMP and not cmp and not debug_shown:
                        import json
                        print(f"\n[DEBUG] {symbol}:", json.dumps(eq, indent=2)[:1500])
                        debug_shown = True
                time.sleep(0.5)

            if not cmp or cmp <= 0:
                print("⚠️  No price — skipping")
                skipped.append(symbol)
                continue

            lot_size = fno_lots.get(symbol, 100)
            print(f"₹{cmp:<10,.2f} lot={lot_size:<5}", end="", flush=True)

            matches = find_matching_puts(
                nse, symbol, cmp, lot_size,
                strike_below, prem_min_pct
            )

            if matches:
                strikes_str = ", ".join(str(int(m["strike"])) for m in matches)
                print(f"✅ {len(matches)} strike(s): {strikes_str}")

                # Fetch extras once per stock (same for all strikes of same stock)
                expiry  = matches[0]["expiry"]
                extras  = fetch_stock_extras(nse, symbol)
                time.sleep(0.5)

                for m in matches:
                    m.update(extras)
                results.extend(matches)
            else:
                print("— no match")

            time.sleep(SLEEP_BETWEEN)

        # Step 4: Output
        print("\n" + "=" * 65)

        if skipped:
            print(f"\n⚠️  Skipped {len(skipped)} stocks: {', '.join(skipped[:10])}"
                  + (" ..." if len(skipped) > 10 else ""))

        if not results:
            print("\n❌ No stocks matched the criteria.")
            print(f"\n   Try:")
            print(f"   • Lower min premium % (you entered {prem_min_pct}%)")
            print(f"   • Lower strike % below CMP (you entered {strike_below}%)")
            print("   • Run during market hours (9:15 AM – 3:30 PM IST)")
        else:
            df = pd.DataFrame(results)[[
                "symbol", "cmp", "strike", "pct_below_cmp",
                "pe_premium", "lot_size", "total_premium",
                "margin", "prem_pct_of_margin", "expiry",
                "futures_price", "week52_high", "week52_low", "pe_ratio",
                "iv", "oi"
            ]]
            df.columns = [
                "Symbol", "CMP (₹)", "Strike", "% OTM",
                "Premium/Share (₹)", "Lot Size", "Total Premium (₹)",
                "Margin (₹)", "Prem % of Margin", "Expiry",
                "Futures Price (₹)", "52W High (₹)", "52W Low (₹)", "Stock PE",
                "IV%", "OI"
            ]
            df.sort_values("Prem % of Margin", ascending=False, inplace=True)
            df.reset_index(drop=True, inplace=True)
            df.index += 1

            print(f"\n✅ {len(df)} match(es) found:\n")
            print(tabulate(df, headers="keys", tablefmt="fancy_grid",
                           floatfmt=".2f", showindex=True))

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            csv_file = f"nse_pe_results_{ts}.csv"
            df.to_csv(csv_file, index=False)
            print(f"\n💾 Saved to: {csv_file}")

        print("\n" + "=" * 65)
        print("⚠️  For research only. Verify actual margins on your broker before trading.")
        print("=" * 65 + "\n")


if __name__ == "__main__":
    run_screener()
