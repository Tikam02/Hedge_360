# Hedge 360

A risk desk for F&O traders: see every derivatives position, its P&L and hedge status, and place hedges sized to
your risk appetite. Built with Next.js (`web/`) and a FastAPI analytics server (repo root).

Live demo: https://tikam02.github.io/Hedge_360/ (sample data, nothing is traded).

| Tab | What it shows |
| --- | --- |
| **Dashboard** | Net P&L, winners and losers, hedge coverage, premium kept, P&L by underlying, positions that need a hedge, profits ready to book, and every trade in one sortable table. |
| **Positions** | Trades grouped by underlying with filters, hedge suggestions (by risk appetite or an eight-rule engine) and one-click hedge tickets. |
| **Screener** | Every F&O stock's out-of-the-money puts and calls on the nearest expiry, with days to expiry, the 52-week range, % OTM and premium-to-margin sliders, a column picker, Re-scan and a pre-trade risk check. |
| **Sectoral analysis** | Sector-wise derivatives build-up, put-call ratios and IV ranges. |
| **Option chain** | Chain with OI, change in OI, IV and max pain, plus a 3D strike × expiry view (three.js). |
| **Ticker Data** | Your blacklist (stocks the Screener leaves out), the F&O stocks that are in, leaving, joined or left, and your notes on each stock. |
| **Profile** | Picture, name and password; the risk profile and the thresholds trades are checked against; a trade journal; notes; and the Zerodha login (API key, secret, TOTP code) that switches the tabs above to live data. |

Sign in with an email and password. A **Connect Zerodha** button sits at the bottom of the sidebar (green once connected). The sidebar's bottom-left corner is the account menu: who is signed in, the risk
appetite and its risk factors, links to the journal, notes and Zerodha, and sign out. Desktop gets a sidebar,
tablets an icon rail, phones a top bar with a slide-out drawer.

## Run it

Accounts, profiles, journals and notes are kept in PostgreSQL, and so are the F&O stocks' daily bars behind the
Screener's 52-week range. From the repo root, start it in Docker (port 5434 on
localhost only, so it doesn't clash with a Postgres you already run):

```bash
docker compose up -d
```

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

Open http://localhost:3000 and create an account. The first sign-in asks for capital, trading time and risk
appetite. Every page needs the API and the database, since that is where sign-in lives.

## Accounts

`accounts.py` (endpoints listed at its top) and `db.py`. The tables are created on first use.

- **Database**: `DATABASE_URL`, default `postgresql://hedge360:hedge360@127.0.0.1:5434/hedge360`, the
  `docker-compose.yml` one. Its password is `hedge360` unless `POSTGRES_PASSWORD` is set when the container is
  first created (put the same one in `DATABASE_URL` then); it only listens on localhost. To use a Postgres you already run instead, make a role and database
  and point `DATABASE_URL` at them, for example
  `sudo -u postgres createuser -P hedge360 && sudo -u postgres createdb -O hedge360 hedge360`.
- **Passwords** are hashed with Argon2id. A sign-in sets an HttpOnly session cookie (SameSite=Lax, 30 days); the
  database keeps only a SHA-256 of its token. Five wrong passwords for one email pause sign-in for that email for 15
  minutes. Changing the password signs out the account's other browsers. Serving over HTTPS? Set
  `HEDGE_SECURE_COOKIES=1`.
- **Forgotten password**: there is no email reset (that needs a mail service). On the server, run
  `.venv/bin/python accounts.py reset-password you@example.com`.
- **Pictures** are JPEG, PNG or WebP up to 1 MB, checked by their content; the web app shrinks them to 256 px first.
- Anyone who can reach the API can create an account. That is fine for a server on your own machine, as above; put
  it behind something else before exposing it.
- The **Zerodha connection is one per server**, not per account: every signed-in account shares it, including its
  TOTP code and saved app.
- The demo book's executed trades and hedges stay in the browser, per account. The trading profile, journal and
  notes are on the server.

## Data

- **Positions** are a made-up sample book in `web/lib/data.ts`. Orders are simulated.
- **Screener, sectors, option chain, symbol list and 3D grid** come from the sample generator in `derivs_sample.py`
  until you log in to Zerodha (below). Totals, PCR, max pain and the grids are always worked out in `derivs.py`.
- Your own stock-derivatives API: write a module with `underlyings()`, `expiries(symbol)` and `chain(symbol, expiry)`
  (shapes documented in `derivs_sample.py`) and start the server with
  `DERIVS_CHAIN_SOURCE=my_chain .venv/bin/uvicorn server:app --port 8060`.
- The web app finds the API on port 8060 of the host name it was opened on (`localhost` or `127.0.0.1`, so the
  session cookie stays same-site); set `NEXT_PUBLIC_DERIVS_API` to change it.

### Live F&O data from Zerodha (read only)

Log in to Zerodha on the **Profile** page (Zerodha tab) and the Screener, Sectoral analysis and the Option chain switch to
live Kite Connect data: quotes, OI, change in OI, IV, max pain, margins and the sector build-up. Log out and they go back to the sample.
`kite_client.py` allows only the instrument list, market quotes, the margin calculator and day candles of one
instrument, and refuses every other call before it is sent, so nothing here can place, modify or cancel an order.

You need your own Kite Connect app (developers.kite.trade) with market data access. On Profile:

1. **Your Kite Connect app**: paste its API key and secret, and optionally your TOTP secret (the base32 key shown
   under the QR code when you set up 2FA on Zerodha). Set the app's Redirect URL to the one Profile shows
   (`http://localhost:8060/api/kite/callback` when the app runs as above).
2. **TOTP code**: the current 6-digit code, with a countdown and a copy button.
3. **Log in with Zerodha**: opens Kite's own login page in a small window (the code is copied as you click). You type
   your password there, so it never reaches this app. Kite sends you back and the session is saved.

What is kept, all owner-only and git-ignored in the repo root:

- `.kite_credentials.json`: the API key, plus the API secret and TOTP secret encrypted with the key in
  `.kite_secret.key` (or with `KITE_SECRET_KEY` from the environment, if set). Neither is ever sent to the browser.
- `.kite_session.json`: the day's access token. Kite ends every session at 06:00 IST, so log in each morning.

The login API (`kite_auth.py`, under `/api/kite`) answers only the web app's origin and only requests addressed to
localhost or 127.0.0.1, and a login must start from Profile within ten minutes (a one-time state goes through Kite).
It assumes the server runs on your own machine, as the commands above start it; don't expose port 8060 to a network.
The callback also needs your Hedge 360 sign-in, so open the web app on the same host name as the Redirect URL:
`localhost` for both, as above. To use `127.0.0.1` instead, set the Redirect URL to
`http://127.0.0.1:8060/api/kite/callback` and start the API with `HEDGE_WEB_URL=http://127.0.0.1:3000`.
`python kite_login.py` does the same login from a terminal.

A Kite Connect app has one redirect URL, so give Hedge 360 its own app rather than sharing one with another tool
(bison_web, say): pointing a shared app here breaks the other tool's login, and Kite's docs don't say whether a new
login ends a session another tool is still using.

- **Instruments** come from Kite's instrument list once a day, `GET /instruments/NFO`, `/BFO`, `/NSE` and `/BSE`, and
  are told apart only by its own columns: futures are `instrument_type` FUT in segment `NFO-FUT`, options CE or PE in
  `NFO-OPT` (BFO the same, index options only), stocks EQ in segment `NSE`, indices segment `INDICES`. An F&O name is a
  stock when NSE lists it as EQ; an index when its spot row is in `INDICES` (Kite has no column linking NIFTY's
  contracts to the "NIFTY 50" row, so `INDEX_OF` in `kite_chain.py` names those); a name with neither is left out and
  listed under Ticker Data. Today's rows are kept in PostgreSQL (`kite_instruments`, Kite's columns), so a restart
  reads them back instead of asking again.
- **F&O in and out**: each day's stock list is recorded (`fno_stocks`) and compared with the last day seen; stocks that
  appear or drop out are logged in `fno_changes`. A stock is *leaving* when NSE has stopped adding its contracts: its
  last expiry is before the one most stocks have. `GET /api/derivs/fno` serves it to Ticker Data.
- **IV and delta** are worked out from each option's price the way NSE's option chain does it (Black-Scholes on
  spot, 6.5%, days to expiry not counting today); checked against NSE's own chain to within 0.1 IV points.
- **Change in OI**: Kite's quote has no previous-day OI, so it is measured from the first reading of the day, kept in
  `.kite_cache/`. Start the API before 9:15 and that reading is the previous close.
- **Margin** on the chain is Kite's margin to sell one lot on its own (NRML), from the basket margin calculator.
- **Sectors** cover every F&O stock on its nearest expiry, grouped by the hand-kept `SECTOR_OF` map in
  `kite_sectors.py` (stocks missing from it show under Other), from the 10 strikes each side of the spot. It is
  refreshed at most once a minute.
- **One pass** feeds both tabs: those strikes, every futures month, and for the Screener every listed strike 3 to 25%
  out of the money (puts below the spot, calls above). About 12,000 contracts, asked for by instrument token, which
  Kite answers with the same quote as the trading symbol at half the URL length, so 500 go in each call: about 25
  calls at Kite's limit of one a second. The Option chain waits behind a pass.
- **Screener** rows are every one of those strikes that has traded and has open interest. Opening the tab shows the
  last pass with its time (the day's first visit makes a new one); **Re-scan** makes a new pass. Filters start at 10%
  OTM or more and 5% premium of margin or more. Margin is estimated at 15% of strike × lot; the trade check replaces
  it with Kite's figure for that one contract (`/api/derivs/margin`). Stock PE stays empty.
- **52-week high and low**: Kite's quotes don't carry them, so `kite_history.py` keeps a year of Kite day candles of
  every F&O stock in PostgreSQL (`fno_daily`, with `fno_history` recording how far each stock has been fetched), as
  bison_web does. The day's first pass fills it in the background: a year per stock the first time, the missing days
  after that, one call per stock at Kite's three a second (about two minutes). Bars stop at yesterday; today's high
  and low come from the pass. The year runs to the last stored session and includes the day a year before it, as
  NSE counts it. A top-up re-reads five days, and if those closes changed (a split or bonus), the stock's year is
  fetched again. The Screener shows the fill's progress and refreshes until it ends.
  Kite's candles are adjusted for dividends, so for a stock that paid one in the year the range can sit a few percent
  below NSE's traded figures (COALINDIA's April high is 478.90 from Kite, 491.25 on NSE).
- `DERIVS_CHAIN_SOURCE=derivs_sample` keeps the sample even while logged in; `DERIVS_CHAIN_SOURCE=kite_chain` always
  uses Kite (and shows an error when not logged in).

## GitHub Pages

`.github/workflows/pages.yml` publishes the web app on every push to `main`. Pages has no server, so the workflow
runs `export_static.py` first: it writes the API's sample answers as JSON files, and the static build reads those.
One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. Pages has no accounts:
there is no sign-in, journal or notes, and the trading profile stays in the browser.

## Also in the server

`server.py` still serves the earlier NSE put-option screener: its page is in `static/` (http://localhost:8060) and
its endpoints are under `/api/scan`. That scanner (`scanner.py`, `pe.py`) fetches live data from NSE, writes results
to `results/` and caches to `.nse_cache/`, both git-ignored. Nothing in the Next.js app depends on it.
