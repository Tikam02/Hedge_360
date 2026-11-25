"""
Web app for the NSE put screener.

Run:
    .venv/bin/uvicorn server:app --port 8060
Then open http://localhost:8060
"""

from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from derivs import router as derivs_router
from accounts import auth_router, journal_router, me_router, notes_router, tickers_router
from kite_auth import callback_router as kite_callback_router
from kite_auth import router as kite_router
from kite_client import KiteError
from scanner import Scan, load_last, market_open

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Put screener")
# The Next.js app (web/, port 3000) signs in (/api/auth), reads /api/derivs and drives the Zerodha login (/api/kite)
# from the browser, with the session cookie. Only that origin may: other sites can't read anything back or send JSON.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_credentials=True,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type"])
# Answer only requests addressed to this machine, so a web page can't reach the login API by rebinding its own
# domain to 127.0.0.1 (CORS alone doesn't stop that).
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
state = {"scan": load_last()}


@app.exception_handler(KiteError)
def kite_error(_request, e: KiteError):
    """Kite failures (not logged in, session expired, rate limit) reach the web app as a readable message."""
    return JSONResponse({"detail": str(e)}, status_code=e.status)


class ScanRequest(BaseModel):
    strike_below: float = Field(10.0, ge=1.0, le=40.0)
    prem_min_pct: float = Field(5.0, ge=0.1, le=100.0)


@app.get("/api/status")
def status():
    return {"market_open": market_open()}


@app.post("/api/scan")
def start_scan(req: ScanRequest):
    current = state["scan"]
    if current and current.running:
        raise HTTPException(409, "A scan is already running")
    scan = Scan(req.strike_below, req.prem_min_pct)
    state["scan"] = scan
    scan.start()
    return {"id": scan.id}


@app.get("/api/scan")
def get_scan(since: int = 0):
    scan = state["scan"]
    if not scan:
        return {"status": "none"}
    return scan.snapshot(since=since)


@app.post("/api/scan/stop")
def stop_scan():
    scan = state["scan"]
    if not scan or not scan.running:
        raise HTTPException(409, "No scan is running")
    scan.stop()
    return {"ok": True}


@app.get("/api/scan/csv")
def scan_csv(traded: bool = False):
    """The saved CSV holds every match; traded=1 leaves out strikes with no trades in the last session."""
    scan = state["scan"]
    if not scan or not scan.csv_file:
        raise HTTPException(404, "No CSV for this scan")
    if not traded:
        return FileResponse(scan.csv_file, media_type="text/csv", filename=scan.csv_file.name)
    df = pd.read_csv(scan.csv_file)
    df = df[pd.to_numeric(df["Volume"], errors="coerce").fillna(0) > 0]
    name = scan.csv_file.stem + "_traded.csv"
    return Response(df.to_csv(index=False), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# Registered before the static mount, which would otherwise answer every path.
for r in (auth_router, me_router, notes_router, journal_router, tickers_router, derivs_router, kite_router, kite_callback_router):
    app.include_router(r)

app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
