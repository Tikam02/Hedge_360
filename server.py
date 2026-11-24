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
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from derivs import router as derivs_router
from scanner import Scan, load_last, market_open

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Put screener")
# The Next.js app (web/, port 3000) reads /api/derivs from the browser.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_methods=["GET"])
state = {"scan": load_last()}


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
app.include_router(derivs_router)

app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
