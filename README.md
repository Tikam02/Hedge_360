# Hedge 360

A risk desk for F&O traders: see every derivatives position, its P&L and hedge status, and place hedges sized to
your risk appetite. Built with Next.js (`web/`) and a FastAPI analytics server (repo root).

Live demo: https://tikam02.github.io/Hedge_360/ (sample data, nothing is traded).

| Tab | What it shows |
| --- | --- |
| **Dashboard** | Net P&L, winners and losers, hedge coverage, premium kept, P&L by underlying, positions that need a hedge, profits ready to book, and every trade in one sortable table. |
| **Positions** | Trades grouped by underlying with filters, hedge suggestions (by risk appetite or an eight-rule engine) and one-click hedge tickets. |
| **Screener** | Put and call options with adjustable % OTM and premium-to-margin sliders, column picker and a pre-trade risk check. |
| **Sectoral analysis** | Sector-wise derivatives build-up, put-call ratios and IV ranges. |
| **Option chain** | Chain with OI, change in OI, IV and max pain, plus a 3D strike × expiry view (three.js). |

Desktop gets a sidebar, tablets an icon rail, phones a top bar with a slide-out drawer.

## Run it

Analytics API (port 8060), from the repo root:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --port 8060
```

Web app (port 3000), in another terminal:

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000. The first visit asks for capital, trading time and risk appetite; choices stay in the
browser's localStorage. Dashboard, Positions and Screener work without the API; Sectoral analysis and Option chain
need it.

## Data

- **Positions** are a made-up sample book and **screener rows** a fixed snapshot, both in `web/lib/data.ts`. Orders are simulated.
- **Sectors** always come from the sample generator in `derivs_sample.py`.
- **Option chain, symbol list and 3D grid** use the sample too, until you point them at your own stock-derivatives
  API: write a module with `underlyings()`, `expiries(symbol)` and `chain(symbol, expiry)` (shapes documented in
  `derivs_sample.py`) and start the server with `DERIVS_CHAIN_SOURCE=my_chain .venv/bin/uvicorn server:app --port 8060`.
  Totals, PCR, max pain and the grids are still worked out in `derivs.py`.
- The web app finds the API at `http://localhost:8060/api/derivs`; set `NEXT_PUBLIC_DERIVS_API` to change it.

## GitHub Pages

`.github/workflows/pages.yml` publishes the web app on every push to `main`. Pages has no server, so the workflow
runs `export_static.py` first: it writes the API's sample answers as JSON files, and the static build reads those.
One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

## Also in the server

`server.py` still serves the earlier NSE put-option screener: its page is in `static/` (http://localhost:8060) and
its endpoints are under `/api/scan`. That scanner (`scanner.py`, `pe.py`) fetches live data from NSE, writes results
to `results/` and caches to `.nse_cache/`, both git-ignored. Nothing in the Next.js app depends on it.
