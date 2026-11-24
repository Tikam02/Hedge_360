# Hedge 360 web app

```bash
npm install
npm run dev        # http://localhost:3000
```

Sectoral analysis and Option chain read the analytics API; start it from the project root (the folder with
`server.py`) with `.venv/bin/uvicorn server:app --port 8060`. Everything else runs without it.

Flow: onboarding (capital, time, risk appetite) → dashboard. The sidebar (an icon rail on tablets, a drawer on
phones) links the five tabs; its footer edits the profile and shows where each data source comes from.

- **Dashboard** (`/dashboard`): net P&L against capital, in profit / in loss, hedged count, positions that need
  attention (high or highest risk, unhedged) and premium kept on short options. Cards break P&L down by underlying,
  hedge status by risk and instrument, the top positions to hedge and the profits ready to book. Hedge and Book open
  the same hedge ticket as Positions. The table lists every trade; clicking a row or a bar opens Positions filtered
  to it (`?stock=`, `?risk=`, `?hedge=`, `?focus=`).
- **Positions** (`/positions`): trades grouped by underlying, with the stock's hedge status in each card's top bar and
  an **Execute hedge** button on every row. Filters: search, stock, type (CE/PE/FUT), side, risk, P&L, hedge status
  and exchange, plus sorting. On phones the filters open in a bottom sheet.
  - **Hedge suggestions**: *Risk appetite* sizes each hedge to the trader's profile (wing width, futures floor,
    take-profit level, lots hedged; see `APPETITE_RULES` in `lib/suggest.ts`). *Rule engine* applies eight fixed rules
    (R1 to R8, listed in the app) and names the rule that fired on each row.
  - Placed hedge legs appear inside the same card, under the position they protect. Loss figures are before premiums,
    which the sample doesn't include.
- **Screener** (`/screener`): put and call options with filters, a column picker and sliders for % OTM and premium as
  a % of margin. **Execute** opens the risk appetite check with a hedge suggestion; "Execute trade" or "Execute with
  hedge" adds it to Positions.
- **Sectoral analysis** (`/sectors`) and **Option chain** (`/chain`): charts and the three.js 3D view over
  `lib/derivs.ts`, which calls the API. Sectors are sample data; the chain switches to your own API on the server
  (`DERIVS_CHAIN_SOURCE` in `derivs.py`). `NEXT_PUBLIC_DERIVS_API` says where the API runs.

Positions are a made-up sample book in `lib/data.ts` (P&L and change are worked out from qty, average and LTP);
screener rows come from NSE screener screenshots and a scan CSV. Orders are simulated. Choices are saved in the
browser's localStorage. Google Fonts are bundled at build time by `next/font`.

**GitHub Pages build:** with `PAGES_BASE_PATH` set (the repo's Pages workflow sets it), `next build` writes a static
site to `out/` under that path, and Sectoral analysis and Option chain read JSON files that `export_static.py` writes
to `public/derivs/` instead of calling the API. To try it locally from the repo root:

```bash
.venv/bin/python export_static.py web/public/derivs
cd web && PAGES_BASE_PATH=/Hedge_360 npx next build    # then serve out/ at /Hedge_360/
```

## Guesses to confirm
- Moderate rules match the DIXON card (OTM ≥ 8%, IV ≤ 50%, OI ≥ 500, margin ≤ 20% of capital). Conservative and Aggressive thresholds are invented.
- Hedge premiums are not in the sample, so orders show "At market".
- Hedges are sized in whole lots. Lot sizes for the sample book are in `LOTS` in `lib/data.ts` (index lots NIFTY 65,
  BANKNIFTY 30, SENSEX 20; stock lots rounded for the demo). CRUDEOIL on MCX is counted in lots.
