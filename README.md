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
- **Sectors, option chain, symbol list and 3D grid** come from the sample generator in `derivs_sample.py` unless the
  server runs with a live source (below). Totals, PCR, max pain and the grids are always worked out in `derivs.py`.
- Your own stock-derivatives API: write a module with `underlyings()`, `expiries(symbol)` and `chain(symbol, expiry)`
  (shapes documented in `derivs_sample.py`) and start the server with
  `DERIVS_CHAIN_SOURCE=my_chain .venv/bin/uvicorn server:app --port 8060`.
- The web app finds the API at `http://localhost:8060/api/derivs`; set `NEXT_PUBLIC_DERIVS_API` to change it.

### Live F&O data from Kite Connect (read only)

`kite_chain.py` and `kite_sectors.py` feed the Option chain and Sectoral analysis from Zerodha's Kite Connect: the
instrument list, market quotes and the margin calculator. `kite_client.py` allows only those endpoints and refuses
every other call before it is sent, so nothing here can place, modify or cancel an order. You need a Kite Connect app
(developers.kite.trade) with market data access.

```bash
export KITE_API_KEY=...  KITE_API_SECRET=...   # from your Kite Connect app; never commit them
.venv/bin/python kite_login.py                 # each morning: log in, paste the redirect URL
DERIVS_CHAIN_SOURCE=kite_chain .venv/bin/uvicorn server:app --port 8060
```

The token is saved to `.kite_session.json` (owner-only, git-ignored) and lasts until 06:00 IST the next day.

- **IV and delta** are worked out from each option's price the way NSE's option chain does it (Black-Scholes on
  spot, 6.5%, days to expiry not counting today); checked against NSE's own chain to within 0.1 IV points.
- **Change in OI**: Kite's quote has no previous-day OI, so it is measured from the first reading of the day, kept in
  `.kite_cache/`. Start the API before 9:15 and that reading is the previous close.
- **Margin** on the chain is Kite's margin to sell one lot on its own (NRML), from the basket margin calculator.
- **Sectors** cover every F&O stock on its nearest expiry, grouped by the hand-kept `SECTOR_OF` map in
  `kite_sectors.py` (stocks missing from it show under Other). It is refreshed at most once a minute. A pass needs
  roughly 20 quote calls for some 200 stocks at Kite's limit of one a second (an estimate, not yet measured live),
  so the first load takes about that many seconds, and the Option chain waits behind it meanwhile.

## GitHub Pages

`.github/workflows/pages.yml` publishes the web app on every push to `main`. Pages has no server, so the workflow
runs `export_static.py` first: it writes the API's sample answers as JSON files, and the static build reads those.
One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

## Also in the server

`server.py` still serves the earlier NSE put-option screener: its page is in `static/` (http://localhost:8060) and
its endpoints are under `/api/scan`. That scanner (`scanner.py`, `pe.py`) fetches live data from NSE, writes results
to `results/` and caches to `.nse_cache/`, both git-ignored. Nothing in the Next.js app depends on it.
