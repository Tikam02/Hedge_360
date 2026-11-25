# Hedge 360 web app

```bash
npm install
npm run dev        # http://localhost:3000
```

The app needs the analytics API and its PostgreSQL database for sign-in: from the project root (the folder with
`server.py`), `docker compose up -d`, then `.venv/bin/uvicorn server:app --port 8060`. See the root README.

Flow: sign in or create an account (`/login`, email and password) → onboarding (capital, time, risk appetite) →
dashboard. The sidebar (an icon rail on tablets, a drawer on phones) links the tabs and Profile. Its bottom-left
corner is the account menu (`components/ProfileMenu.tsx`; the top bar's chip on phones): picture, name and email,
the risk appetite with the thresholds every trade is checked against, links to the journal, notes and Zerodha, and
sign out. Below it, where each data source comes from.

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
- **Screener** (`/screener`): every F&O stock's out-of-the-money puts and calls on the nearest expiry (`/screener` on
  the API), with days to expiry, filters, a column picker (52-week high and low on by default; expiry, futures, OI and more
  can be added) and sliders for % OTM and premium as a % of margin, starting at 10% and 5%. **Re-scan** asks the API
  for a new pass. **Execute** opens the risk appetite check with a hedge suggestion; "Execute trade" or "Execute with
  hedge" adds it to Positions.
- **Sectoral analysis** (`/sectors`) and **Option chain** (`/chain`): charts and the three.js 3D view over
  `lib/derivs.ts`, which calls the API. Both are sample data until you log in to Zerodha on Profile, then live
  Kite data, read only (or whatever `DERIVS_CHAIN_SOURCE` in `derivs.py` names). `NEXT_PUBLIC_DERIVS_API` says
  where the API runs.
- **Ticker Data** (`/tickers`), in three tabs (`?tab=`): *Blacklist*, stocks the Screener leaves out (per account,
  `/api/tickers/blacklist`); *F&O in and out*, today's F&O stocks with those leaving, joined and left (`/fno` on the
  API, from Kite's instrument list); *Stock notes*, notes kept per stock (`/api/tickers/notes`). The Pages demo shows
  only the F&O list.
- **Profile** (`/profile`), in four tabs (`?tab=`):
  - *Overview*: picture (resized to 256 px in the browser before upload), name, email, password change, the risk
    profile with its risk factors (Edit reopens onboarding) and the data sources.
  - *Journal*: one entry per trade with date, symbol, outcome, P&L, notes and tags; a summary of wins, losses and
    recorded P&L; search, edit, delete.
  - *Notes*: free-form notes, pinned ones first; search, edit, delete.
  - *Zerodha*: the login, after bison_web's: save your Kite Connect app's API key, secret and optional TOTP secret
    (kept encrypted on the server, never sent back), copy the live TOTP code, then **Log in with Zerodha** opens
    Kite's own page in a small window. `lib/kite.ts` calls the server's `/api/kite` endpoints (`kite_auth.py`).

Accounts (`lib/account.tsx`) talk to the server's `/api/auth`, `/api/me`, `/api/notes` and `/api/journal`
(`accounts.py`) with the session cookie. Every page but `/login` needs a session; the API answers 401 without one.

Positions are a made-up sample book in `lib/data.ts` (P&L and change are worked out from qty, average and LTP).
Screener rows come from the API: the sample generator, or live Kite quotes once Zerodha is connected. Orders are
simulated. The trading profile, journal and notes are saved with the account on the server; the demo book's trades
and hedges stay in this browser's localStorage, per account. Google Fonts are bundled at build time by `next/font`.

**GitHub Pages build:** with `PAGES_BASE_PATH` set (the repo's Pages workflow sets it), `next build` writes a static
site to `out/` under that path, and Sectoral analysis and Option chain read JSON files that `export_static.py` writes
to `public/derivs/` instead of calling the API. There are no accounts on Pages: no sign-in, no journal or notes, and
the trading profile stays in localStorage. To try it locally from the repo root:

```bash
.venv/bin/python export_static.py web/public/derivs
cd web && PAGES_BASE_PATH=/Hedge_360 npx next build    # then serve out/ at /Hedge_360/
```

## Guesses to confirm
- Moderate rules match the DIXON card (OTM ≥ 8%, IV ≤ 50%, OI ≥ 500, margin ≤ 20% of capital). Conservative and Aggressive thresholds are invented.
- Hedge premiums are not in the sample, so orders show "At market".
- Hedges are sized in whole lots. Lot sizes for the sample book are in `LOTS` in `lib/data.ts` (index lots NIFTY 65,
  BANKNIFTY 30, SENSEX 20; stock lots rounded for the demo). CRUDEOIL on MCX is counted in lots.
