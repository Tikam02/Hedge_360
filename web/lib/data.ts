// Demo data. Screener rows come from NSE screener screenshots and a scan CSV; the positions are a made-up book. Nothing is fetched. (The Sectoral analysis and Option chain tabs read lib/derivs.ts instead.)
// `null` means the value was not visible in the source.

export type OptType = 'PE' | 'CE';
export type Source = 'screener' | 'card' | 'csv' | 'chain';

export interface OptionRow {
  id: string;
  symbol: string;
  type: OptType;
  cmp: number;
  strike: number;
  otm: number;
  prem: number;
  lot: number;
  totalPrem: number;
  margin: number;
  premPct: number;
  expiry: string; // DD-Mon-YYYY
  fut: number | null;
  hi52: number | null;
  lo52: number | null;
  pe: number | null;
  iv: number;
  oi: number | null;
  src: Source;
  featured?: boolean;
  note?: string;
  est?: Array<'prem' | 'iv' | 'oi' | 'margin'>;
}

const r = (
  symbol: string, type: OptType, cmp: number, strike: number, otm: number, prem: number, lot: number,
  totalPrem: number, margin: number, premPct: number, expiry: string, fut: number | null,
  hi52: number | null, lo52: number | null, pe: number | null, iv: number, oi: number | null, src: Source,
  extra: Partial<OptionRow> = {},
): Omit<OptionRow, 'id'> => ({ symbol, type, cmp, strike, otm, prem, lot, totalPrem, margin, premPct, expiry, fut, hi52, lo52, pe, iv, oi, src, ...extra });

// "screener" = NSE Put Options Screener screenshot (Dec 2026 monthly; OI column was off-screen)
// "card"     = DIXON JAN 9600 PE risk appetite card
// "csv"      = nse_ce_results_20260514_113432.csv (scan of 14 May 2026, calls)
export const OPTIONS: OptionRow[] = [
  r('TATAMOTORS', 'PE', 780, 700, 10.26, 14.2, 1100, 15620, 160000, 9.76, '31-Dec-2026', 783.5, 1179, 675, 10.4, 34.8, null, 'screener'),
  r('SBIN', 'PE', 820, 740, 9.76, 11.5, 1500, 17250, 185000, 9.32, '31-Dec-2026', 823, 912, 598, 11.2, 25.6, null, 'screener'),
  r('INFY', 'PE', 1880, 1680, 10.64, 26.5, 400, 10600, 120000, 8.83, '31-Dec-2026', 1886, 1992, 1355, 26.8, 23.1, null, 'screener'),
  r('BAJFINANCE', 'PE', 6850, 6100, 10.95, 115, 125, 14375, 165000, 8.71, '31-Dec-2026', 6865, 7890, 6150, 28.4, 26.5, null, 'screener'),
  r('ICICIBANK', 'PE', 1260, 1140, 9.52, 16.8, 700, 11760, 135000, 8.71, '31-Dec-2026', 1264, 1362, 980, 17.6, 20.5, null, 'screener'),
  r('HDFCBANK', 'PE', 1740, 1580, 9.2, 22, 550, 12100, 140000, 8.64, '31-Dec-2026', 1744, 1794, 1363, 18.2, 19.8, null, 'screener'),
  r('HAL', 'PE', 4250, 3800, 10.59, 72, 150, 10800, 125000, 8.64, '31-Dec-2026', 4268, 5675, 2800, 38.2, 38.5, null, 'screener'),
  r('DIXON', 'PE', 10700, 9600, 10.28, 122.2, 50, 6110, 72000, 8.49, '31-Dec-2026', 10701, 18471, 9600, 36.66, 60.87, null, 'screener', { featured: true }),
  r('TRENT', 'PE', 6450, 5700, 11.63, 110, 100, 11000, 130000, 8.46, '31-Dec-2026', 6475, 8345, 3800, 72.5, 42.1, null, 'screener'),
  r('SUNPHARMA', 'PE', 1790, 1600, 10.61, 24, 350, 8400, 102000, 8.24, '31-Dec-2026', 1795, 1960, 1180, 35.2, 21, null, 'screener'),
  r('DIXON', 'PE', 11350, 9600, 15.42, 135, 50, 6750, 80000, 8.44, '25-Jan-2027', null, null, 9600, null, 40, 500, 'card', {
    note: 'Expiry 25 Jan 2027 (26th is Republic Day; verify on NSE)',
    est: ['prem', 'iv', 'oi', 'margin'],
  }),
  r('GODFRYPHLP', 'CE', 2410.1, 2680, 11.2, 37.6, 275, 10340, 147400, 7.01, '26-May-2026', 2411.6, 3947, 1832.1, 35.99, 67.73, 15, 'csv'),
  r('GODFRYPHLP', 'CE', 2410.1, 2660, 10.37, 32, 275, 8800, 146300, 6.02, '26-May-2026', 2411.6, 3947, 1832.1, 35.99, 60.58, 0, 'csv'),
  r('GODFRYPHLP', 'CE', 2410.1, 2700, 12.03, 32, 275, 8800, 148500, 5.93, '26-May-2026', 2411.6, 3947, 1832.1, 35.99, 64.75, 71, 'csv'),
  r('INOXWIND', 'CE', 96, 106, 10.42, 1.18, 3575, 4218.5, 75790, 5.57, '26-May-2026', 96, 199.01, 75.05, 31.42, 60.87, 160, 'csv'),
  r('ADANIENSOL', 'CE', 1314.7, 1460, 11.05, 15.95, 675, 10766.25, 197100, 5.46, '26-May-2026', 1314.7, 1463.65, 744.9, 66.18, 62.61, 419, 'csv'),
].map((o, i) => ({ ...o, id: 'o' + i }));

// ── Positions ─────────────────────────────────────────
export type Risk = 'low' | 'medium' | 'high' | 'highest';
export interface Leg { side: 'BUY' | 'SELL'; label: string; qty: number }
export interface Position {
  id: string;
  underlying: string;
  name: string;
  exch: 'NFO' | 'BFO' | 'MCX';
  product: 'NRML';
  qty: number;
  avg: number;
  ltp: number;
  pnl: number;
  chg: number;
  risk: Risk;
  text: string;           // hedge suggestion shown to the trader
  result: string;         // structure after the hedge
  legs: Leg[];            // the hedge order
  lot: number | null;     // contract lot size; null when the snapshot doesn't show it
  fresh?: boolean;        // created from the screener in this session
  suggestLots?: number | null; // lots the active suggestion hedges (set by lib/suggest)
  source?: string;        // which engine produced the active suggestion
}

// Lot sizes for the sample book: the exchange contract sizes, rounded for the demo. CRUDEOIL on MCX is counted in
// lots, so its quantity is the number of lots and the multiplier (100 barrels) goes in `mult` below.
export const LOTS: Record<string, number> = {
  'NIFTY 50': 65, 'NIFTY BANK': 30, SENSEX: 20, CRUDEOIL: 1, RELIANCE: 500, TCS: 175, INFY: 400, ICICIBANK: 700, LT: 175,
  TATASTEEL: 5500, BHARTIARTL: 475, MARUTI: 50, AXISBANK: 625, ITC: 1600, HINDUNILVR: 300, SUNPHARMA: 350, HAL: 150,
};

// P&L and change from entry are worked out from qty, avg and LTP, so every figure in the book agrees with itself.
const p = (underlying: string, name: string, exch: Position['exch'], qty: number, avg: number, ltp: number,
  risk: Risk, text: string, result: string, legs: Leg[], mult = 1): Omit<Position, 'id'> => ({
  underlying, name, exch, product: 'NRML', qty, avg, ltp, risk, text, result, legs, lot: LOTS[underlying] ?? null,
  pnl: Math.round((ltp - avg) * qty * mult * 100) / 100,
  chg: Math.round(((ltp - avg) / avg) * 10000) / 100,
});
const buy = (label: string, qty: number): Leg => ({ side: 'BUY', label, qty });
const sell = (label: string, qty: number): Leg => ({ side: 'SELL', label, qty });

// A made-up book: index option writing, covered calls, a few naked futures and one MCX crude trade.
// It is not anyone's real account. Suggestions are the rule engine's written text for each position.
export const POSITIONS: Position[] = [
  p('NIFTY 50', 'NIFTY 1st w DEC 26000 CE', 'NFO', -130, 148, 231.6, 'high',
    'Buy 130 × 26300 CE (1st wk). Becomes a bear call spread and caps the loss.', 'Bear call spread', [buy('NIFTY 1st w DEC 26300 CE', 130)]),
  p('NIFTY 50', 'NIFTY 1st w DEC 26000 PE', 'NFO', -130, 132, 96.5, 'low',
    'Short straddle with the CE. Add a 25700 PE to make an iron fly with defined risk.', 'Iron fly', [buy('NIFTY 1st w DEC 25700 PE', 130)]),
  p('NIFTY 50', 'NIFTY DEC 25500 PE', 'NFO', -195, 118, 64.2, 'low',
    '46% decayed. Buy 195 × 25200 PE to lock the gain as a bull put spread.', 'Bull put spread', [buy('NIFTY DEC 25200 PE', 195)]),
  p('NIFTY 50', 'NIFTY JAN FUT', 'NFO', 130, 25940, 26118.5, 'medium',
    'Long 130 with no floor. Buy 130 × 25600 PE as a protective put.', 'Protective put', [buy('NIFTY JAN 25600 PE', 130)]),

  p('NIFTY BANK', 'BANKNIFTY DEC 59000 CE', 'NFO', -60, 395, 612, 'high',
    'Premium up 55% against you. Buy 60 × 59500 CE to make a bear call spread and cap the loss.', 'Bear call spread', [buy('BANKNIFTY DEC 59500 CE', 60)]),
  p('NIFTY BANK', 'BANKNIFTY DEC 57500 PE', 'NFO', -60, 420, 188.5, 'low',
    '55% of the premium is captured. Book the profit and free the margin.', 'Exit', [buy('BANKNIFTY DEC 57500 PE', 60)]),

  p('SENSEX', 'SENSEX 2nd w DEC 85000 CE', 'BFO', -60, 210, 486, 'highest',
    'Premium more than doubled. Buy 60 × 85500 CE (2nd Dec wk) to make a bear call spread and cap the loss.', 'Bear call spread', [buy('SENSEX 2nd w DEC 85500 CE', 60)]),
  p('SENSEX', 'SENSEX DEC 83000 PE', 'BFO', -40, 520, 344, 'medium',
    'Buy 40 × 82000 PE (Dec) to make a bull put spread.', 'Bull put spread', [buy('SENSEX DEC 82000 PE', 40)]),

  p('CRUDEOIL', 'CRUDEOIL DEC FUT', 'MCX', 4, 5684, 5402, 'highest',
    'Down ₹1.13 lakh. Buy 4 × 5300 PE (Dec) to floor further losses.', 'Protective put', [buy('CRUDEOIL DEC 5300 PE', 4)], 100),
  p('CRUDEOIL', 'CRUDEOIL DEC 6000 CE', 'MCX', -4, 92, 21.5, 'low',
    '77% of the premium is captured. Book the profit now.', 'Exit', [buy('CRUDEOIL DEC 6000 CE', 4)], 100),
  p('CRUDEOIL', 'CRUDEOIL DEC 5200 PE', 'MCX', -2, 78, 131, 'high',
    'Premium up 68% against you. Buy 2 × 5000 PE to make a bull put spread and cap the loss.', 'Bull put spread', [buy('CRUDEOIL DEC 5000 PE', 2)], 100),

  p('RELIANCE', 'RELIANCE DEC FUT', 'NFO', 1000, 1512.4, 1548.9, 'medium',
    'Up ₹36 a share. Buy 1000 × 1500 PE to lock in most of the gain.', 'Protective put', [buy('RELIANCE DEC 1500 PE', 1000)]),
  p('RELIANCE', 'RELIANCE DEC 1600 CE', 'NFO', -1000, 21.5, 18.2, 'low',
    'Covered by your long futures. Hold, or roll up to 1640 CE if RELIANCE keeps rising.', 'Rolled covered call', [buy('RELIANCE DEC 1600 CE', 1000), sell('RELIANCE DEC 1640 CE', 1000)]),

  p('TCS', 'TCS DEC 3200 PE', 'NFO', -350, 54, 96.5, 'high',
    'Premium up 79% against you. Buy 350 × 3100 PE to make a bull put spread and cap the loss.', 'Bull put spread', [buy('TCS DEC 3100 PE', 350)]),
  p('TCS', 'TCS DEC FUT', 'NFO', -175, 3310, 3236.4, 'medium',
    'Short futures in profit. Buy 175 × 3400 CE to cap the cost of a rally.', 'Protective call', [buy('TCS DEC 3400 CE', 175)]),

  p('INFY', 'INFY DEC 1700 PE', 'NFO', -800, 24.6, 7.9, 'low',
    '68% of the premium is captured. Book the profit now; little is left to earn.', 'Exit', [buy('INFY DEC 1700 PE', 800)]),
  p('INFY', 'INFY DEC 2000 CE', 'NFO', -400, 18.4, 25.1, 'high',
    'Short call moving against you. Buy 400 × 2060 CE to make a bear call spread.', 'Bear call spread', [buy('INFY DEC 2060 CE', 400)]),

  p('ICICIBANK', 'ICICIBANK DEC FUT', 'NFO', 1400, 1302.5, 1271.8, 'high',
    'Futures down ₹31 a share. Buy 1400 × 1250 PE to cap further downside.', 'Protective put', [buy('ICICIBANK DEC 1250 PE', 1400)]),

  p('LT', 'LT DEC 3800 PE', 'NFO', -350, 62, 31.4, 'low',
    'Book 50-70% now, or buy 3700 PE to lock gains as a bull put spread.', 'Bull put spread', [buy('LT DEC 3700 PE', 350)]),
  p('LT', 'LT DEC 4100 CE', 'NFO', -175, 48, 52.6, 'medium',
    'Buy 175 × 4200 CE to turn this into a bear call spread with defined risk.', 'Bear call spread', [buy('LT DEC 4200 CE', 175)]),

  p('TATASTEEL', 'TATASTEEL DEC FUT', 'NFO', -11000, 158.2, 166.85, 'highest',
    'Short futures ₹8.65 against you. Buy 11000 × 175 CE to cap the cost of a rally.', 'Protective call', [buy('TATASTEEL DEC 175 CE', 11000)]),

  p('BHARTIARTL', 'BHARTIARTL DEC 1960 PE', 'NFO', -475, 28, 9.6, 'low',
    '66% of the premium is captured. Book the profit and free the margin.', 'Exit', [buy('BHARTIARTL DEC 1960 PE', 475)]),
  p('BHARTIARTL', 'BHARTIARTL DEC FUT', 'NFO', 475, 2018, 2061.3, 'medium',
    'Long 475 futures with no hedge. Buy 475 × 2000 PE as a protective put.', 'Protective put', [buy('BHARTIARTL DEC 2000 PE', 475)]),

  p('MARUTI', 'MARUTI DEC 13500 CE', 'NFO', -100, 165, 72.5, 'low',
    '56% decayed. Buy 100 × 13800 CE to cap a rally as a bear call spread.', 'Bear call spread', [buy('MARUTI DEC 13800 CE', 100)]),

  p('AXISBANK', 'AXISBANK DEC 1150 PE', 'NFO', -625, 17.5, 29.8, 'high',
    'Premium up 70% against you. Buy 625 × 1120 PE to make a bull put spread and cap the loss.', 'Bull put spread', [buy('AXISBANK DEC 1120 PE', 625)]),

  p('ITC', 'ITC DEC 440 CE', 'NFO', -3200, 5.2, 1.35, 'low',
    '74% of the premium is captured. Book the profit now.', 'Exit', [buy('ITC DEC 440 CE', 3200)]),
  p('ITC', 'ITC DEC FUT', 'NFO', 1600, 418.6, 412.15, 'medium',
    'Futures down ₹6 a share. Buy 1600 × 405 PE as a protective put.', 'Protective put', [buy('ITC DEC 405 PE', 1600)]),

  p('HINDUNILVR', 'HINDUNILVR DEC 2500 CE', 'NFO', -300, 32, 19.4, 'low',
    '39% decayed. Buy 300 × 2560 CE to cap a rally as a bear call spread.', 'Bear call spread', [buy('HINDUNILVR DEC 2560 CE', 300)]),

  p('SUNPHARMA', 'SUNPHARMA DEC FUT', 'NFO', 700, 1768, 1742.3, 'medium',
    'Futures down ₹26 a share. Buy 700 × 1700 PE to floor the futures.', 'Protective put', [buy('SUNPHARMA DEC 1700 PE', 700)]),
  p('SUNPHARMA', 'SUNPHARMA DEC 1840 CE', 'NFO', -700, 26, 14.8, 'low',
    'Covered call against your futures, 43% decayed. Book now, or roll to 1880 CE to lift the cap.', 'Rolled covered call', [buy('SUNPHARMA DEC 1840 CE', 700), sell('SUNPHARMA DEC 1880 CE', 700)]),
].map((x, i) => ({ ...x, id: 'p' + i }));

export const STRUCTURE: Record<string, string> = {
  'Bull put spread': 'Your short put plus a lower bought put. The most you can lose is capped at the strike gap.',
  'Bear call spread': 'Your short call plus a higher bought call. The most you can lose is capped at the strike gap.',
  'Protective put': 'A bought put sets a floor under your long futures.',
  'Protective call': 'A bought call caps the loss on short futures if the price rallies.',
  'Rolled covered call': 'Buy back the current call and sell a higher strike to lift the cap.',
  'Iron fly': 'Short straddle with a bought wing, so risk is defined on that side.',
  Exit: 'Buy back the full position, keep the profit and free the margin.',
};
