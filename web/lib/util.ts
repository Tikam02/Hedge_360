import type { OptionRow, Position, Risk } from './data';

export const fmt = (v: number | null | undefined, dp = 2) =>
  v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const inr = (v: number | null | undefined, dp = 2) => (v == null ? '—' : (v < 0 ? '-₹' : '₹') + fmt(Math.abs(v), dp));
export const signed = (v: number, dp = 2) => (v > 0 ? '+' : v < 0 ? '-' : '') + fmt(Math.abs(v), dp);
export const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
/** Short rupees in lakh and crore, e.g. −₹9.79 L. `sign` adds + to gains. */
export const inrShort = (v: number, sign = true) => {
  const a = Math.abs(v), s = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${s}₹${a >= 1e7 ? `${fmt(a / 1e7)} Cr` : a >= 1e5 ? `${fmt(a / 1e5)} L` : fmt(a, 0)}`;
};
export const words = (v: number | null) => {
  if (!v) return '';
  if (v >= 1e7) return `₹${+(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${+(v / 1e5).toFixed(2)} L`;
  return `₹${fmt(v, 0)}`;
};

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const parseExp = (s: string) => { const [d, m, y] = s.split('-'); return new Date(+y, MONTHS[m], +d); };
export const daysTo = (s: string) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((+parseExp(s) - +t) / 864e5); };
export const optName = (o: Pick<OptionRow, 'symbol' | 'expiry' | 'strike' | 'type'>) =>
  `${o.symbol} ${MON[parseExp(o.expiry).getMonth()]} ${o.strike} ${o.type}`;
export const expLabel = (s: string) => {
  const d = parseExp(s); const m = MON[d.getMonth()];
  return `${m[0]}${m.slice(1).toLowerCase()} ${d.getFullYear()} monthly`;
};

// ── Risk appetite ─────────────────────────────────────
export type Appetite = 'conservative' | 'moderate' | 'aggressive';
export const RULES: Record<Appetite, { otm: number; iv: number; oi: number; marginPct: number }> = {
  conservative: { otm: 12, iv: 35, oi: 1000, marginPct: 10 },
  moderate: { otm: 8, iv: 50, oi: 500, marginPct: 20 }, // matches the shared DIXON card
  aggressive: { otm: 5, iv: 70, oi: 100, marginPct: 35 },
};
export const APPETITE_LABEL: Record<Appetite, string> = { conservative: 'Conservative', moderate: 'Moderate', aggressive: 'Aggressive' };
export const RISK_LABEL: Record<Risk, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', highest: 'Highest risk' };
export const RISK_ORDER: Record<Risk, number> = { highest: 0, high: 1, medium: 2, low: 3 };

export type CheckState = 'pass' | 'fail' | 'na';
export interface Check { label: string; need: string; st: CheckState; gate: boolean }

export function runChecks(o: Pick<OptionRow, 'type' | 'otm' | 'iv' | 'oi' | 'margin' | 'strike' | 'lo52' | 'hi52'>, appetite: Appetite, capital: number | null) {
  const R = RULES[appetite];
  const list: Check[] = [
    { label: `Strike ${fmt(o.otm)}% OTM`, need: `needs ≥ ${R.otm}%`, st: o.otm >= R.otm ? 'pass' : 'fail', gate: true },
    { label: `IV ${fmt(o.iv, Number.isInteger(o.iv) ? 0 : 2)}%`, need: `needs ≤ ${R.iv}%`, st: o.iv <= R.iv ? 'pass' : 'fail', gate: true },
    o.oi == null
      ? { label: 'Open interest not in snapshot', need: `needs ≥ ${fmt(R.oi, 0)}`, st: 'na', gate: true }
      : { label: `Open interest ${fmt(o.oi, 0)}`, need: `needs ≥ ${fmt(R.oi, 0)}`, st: o.oi >= R.oi ? 'pass' : 'fail', gate: true },
    capital
      ? { label: `Margin ${fmt((o.margin / capital) * 100, 1)}% of capital`, need: `needs ≤ ${R.marginPct}%`, st: (o.margin / capital) * 100 <= R.marginPct ? 'pass' : 'fail', gate: true }
      : { label: 'Margin vs capital', need: 'add capital to check', st: 'na', gate: true },
  ];
  if (o.type === 'PE' && o.lo52 != null)
    list.push({ label: `Strike at or below 52W low (₹${fmt(o.lo52, 0)})`, need: 'support check', st: o.strike <= o.lo52 ? 'pass' : 'fail', gate: false });
  if (o.type === 'CE' && o.hi52 != null)
    list.push({ label: `Strike at or above 52W high (₹${fmt(o.hi52, 0)})`, need: 'resistance check', st: o.strike >= o.hi52 ? 'pass' : 'fail', gate: false });
  const fails = list.filter((c) => c.gate && c.st === 'fail').length;
  const evaluated = list.filter((c) => c.st !== 'na');
  return { list, fits: fails === 0, fails, passed: evaluated.filter((c) => c.st === 'pass').length, total: evaluated.length };
}

/** Hedge that turns a freshly sold option into a defined-risk spread. */
export function hedgeForOption(o: Pick<OptionRow, 'symbol' | 'expiry' | 'strike' | 'type' | 'lot'>) {
  const k = o.strike;
  const step = k >= 10000 ? 250 : k >= 2000 ? 100 : k >= 500 ? 20 : k >= 100 ? 5 : 1;
  const hk = o.type === 'PE' ? k - 2 * step : k + 2 * step;
  const mon = MON[parseExp(o.expiry).getMonth()];
  const label = `${o.symbol} ${mon} ${hk} ${o.type}`;
  return {
    strike: hk,
    label,
    result: o.type === 'PE' ? 'Bull put spread' : 'Bear call spread',
    text: o.type === 'PE'
      ? `Buy ${fmt(o.lot, 0)} × ${hk} PE to cap the downside. Becomes a bull put spread with max loss ₹${fmt((k - hk) * o.lot, 0)} before credit.`
      : `Buy ${fmt(o.lot, 0)} × ${hk} CE to cap the upside. Becomes a bear call spread with max loss ₹${fmt((hk - k) * o.lot, 0)} before credit.`,
  };
}

export const strikeOf = (name: string) => { const m = name.match(/(\d+) (CE|PE)$/); return m ? { k: +m[1], t: m[2] } : null; };

/** Worst case for a spread hedge, ignoring the net credit (premiums are not in the snapshot). */
export function spreadCap(p: Position, hedgeQty: number) {
  const a = strikeOf(p.name); const b = p.legs[0] && strikeOf(p.legs[0].label);
  if (!a || !b || a.t !== b.t || p.qty >= 0 || !/spread/i.test(p.result)) return null;
  const covered = Math.min(Math.abs(p.qty), hedgeQty);
  return { cap: Math.abs(a.k - b.k) * covered, uncovered: Math.abs(p.qty) - covered };
}

/** Number of whole lots in a position, or null when the lot size isn't known. */
export const lotsOf = (p: Pick<Position, 'qty' | 'lot'>) => (p.lot ? Math.round(Math.abs(p.qty) / p.lot) : null);

/** Hedge legs for `lots` lots of the position (every leg stays a whole number of lots). */
export function legsForLots(p: Position, lots: number | null) {
  const total = lotsOf(p);
  if (!p.lot || !total || lots == null) return p.legs;
  const lot = p.lot;
  return p.legs.map((l) => ({ ...l, qty: Math.max(1, Math.round(l.qty / Math.abs(p.qty))) * lots * lot }));
}
