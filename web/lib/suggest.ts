import type { Leg, Position } from './data';
import { APPETITE_LABEL, fmt, lotsOf, type Appetite } from './util';

/**
 * Two ways to suggest a hedge for an open position.
 *  - Rule engine: fixed rules (R1–R8), the same for every trader. Output is the desk's written suggestion for the position.
 *  - Risk appetite: sized to the trader's profile. Wing width, futures floor, take-profit level and lots hedged all
 *    follow the appetite. Strikes are worked out from the position itself; nothing is fetched.
 * Premiums are not in the snapshot, so every loss figure is before the premium paid or received.
 */
export type SuggestMode = 'appetite' | 'rules';
export type Kind = 'CE' | 'PE' | 'FUT';

export interface Hedge {
  result: string;          // structure after the hedge, or Exit
  legs: Leg[];             // the order
  text: string;            // one-line explanation for the ticket
  source: string;          // e.g. "R2 · Premium doubled" or "Moderate profile"
  why: string;             // what triggered it / how it was sized
  lots: number | null;     // lots the suggestion hedges (null when the lot size is unknown)
  risk: { label: string; value: number } | null; // max loss, further loss or profit booked, in ₹
}

export const kindOf = (p: Pick<Position, 'name'>): Kind => (p.name.endsWith(' FUT') ? 'FUT' : p.name.endsWith(' CE') ? 'CE' : 'PE');
const strikeOf = (label: string) => { const m = label.match(/(\d+) (CE|PE)$/); return m ? +m[1] : null; };
const withStrike = (p: Position, k: number, t: 'CE' | 'PE') =>
  kindOf(p) === 'FUT' ? p.name.replace(/FUT$/, `${k} ${t}`) : p.name.replace(/\d+ (CE|PE)$/, `${k} ${t}`);

/** Contract multiplier, read back from the position's own P&L (MCX quantities count lots, so CRUDEOIL comes out at 100). */
export const multOf = (p: Position) => {
  const d = (p.ltp - p.avg) * p.qty;
  return d ? Math.max(1, Math.round(Math.abs(p.pnl / d))) : 1;
};

/** "BUY 40 × 81000 PE": the short form of a leg for tables. */
export const shortLeg = (l: Leg) => {
  const m = l.label.match(/(\d+ (?:CE|PE))$/);
  return `${l.side} ${fmt(l.qty, 0)} × ${m ? m[1] : l.label}`;
};

// Strike spacing used to place hedge strikes, per underlying.
const STEP: Record<string, number> = {
  'NIFTY 50': 100, 'NIFTY BANK': 100, SENSEX: 100, CRUDEOIL: 50, RELIANCE: 20, TCS: 20, INFY: 20, ICICIBANK: 10, LT: 20,
  TATASTEEL: 5, BHARTIARTL: 20, MARUTI: 100, AXISBANK: 10, ITC: 5, HINDUNILVR: 20, SUNPHARMA: 20, HAL: 50,
};

// ── Rule engine ─────────────────────────────────────
export const RULE_LIST = [
  { id: 'R1', name: 'Profit capture', when: 'Short option has lost 25% or more of its premium and risk is low', then: 'Book the profit and free the margin' },
  { id: 'R2', name: 'Premium doubled', when: 'Short option premium is up 100% or more from entry', then: 'Buy a further strike to cap the loss as a spread' },
  { id: 'R3', name: 'Moving against you', when: 'Short option premium is up 25% or more from entry', then: 'Buy a further strike to cap the loss as a spread' },
  { id: 'R4', name: 'Naked short option', when: 'Short option with no bought wing', then: 'Buy a further strike so the risk is defined' },
  { id: 'R5', name: 'Short straddle', when: 'Short put paired with a short call at the same strike', then: 'Add a bought wing to make an iron fly' },
  { id: 'R6', name: 'Covered call', when: 'Short call covered by long futures', then: 'Roll the call up to lift the cap' },
  { id: 'R7', name: 'Unhedged long futures', when: 'Long futures with no put below', then: 'Buy a protective put' },
  { id: 'R8', name: 'Unhedged short futures', when: 'Short futures with no call above', then: 'Buy a protective call' },
] as const;

function ruleFor(p: Position): { id: string; name: string; trigger: string } {
  const k = kindOf(p); const c = p.chg;
  const pick = (id: string, trigger: string) => ({ id, name: RULE_LIST.find((r) => r.id === id)!.name, trigger });
  if (p.result === 'Exit') return pick('R1', `Premium down ${fmt(-c, 0)}% from entry`);
  if (p.result === 'Iron fly') return pick('R5', `Paired with the short ${strikeOf(p.name)} CE`);
  if (p.result === 'Rolled covered call') return pick('R6', 'Covered by your long futures');
  if (k === 'FUT') return p.qty > 0 ? pick('R7', `Long ${fmt(p.qty, 0)} with no put below`) : pick('R8', `Short ${fmt(-p.qty, 0)} with no call above`);
  if (c >= 100) return pick('R2', `Premium up ${fmt(c, 0)}% from entry`);
  if (c >= 25) return pick('R3', `Premium up ${fmt(c, 0)}% from entry`);
  return pick('R4', `Short ${k} with no bought wing`);
}

function riskOf(p: Position, result: string, legs: Leg[]): Hedge['risk'] {
  const m = multOf(p); const k = kindOf(p); const leg = legs[0];
  if (result === 'Exit') return { label: 'Books', value: p.pnl };
  if (!leg) return null;
  const hk = strikeOf(leg.label);
  if (hk == null) return null;
  if (k === 'FUT') {
    const covered = Math.min(leg.qty, Math.abs(p.qty));
    return { label: covered < Math.abs(p.qty) ? 'Further loss capped on hedged lots at' : 'Further loss capped at', value: Math.abs(p.ltp - hk) * covered * m };
  }
  const K = strikeOf(p.name);
  if (K == null || !/spread|iron fly/i.test(result)) return null;
  const covered = Math.min(leg.qty, Math.abs(p.qty));
  return { label: covered < Math.abs(p.qty) ? 'Max loss on hedged lots' : 'Max loss', value: Math.abs(K - hk) * covered * m };
}

function ruleHedge(p: Position): Hedge {
  const r = ruleFor(p);
  return { result: p.result, legs: p.legs, text: p.text, source: `${r.id} · ${r.name}`, why: r.trigger, lots: lotsOf(p), risk: riskOf(p, p.result, p.legs) };
}

// ── Risk appetite ───────────────────────────────────
export const APPETITE_RULES: Record<Appetite, { wing: number; fut: number; exitAt: number; half: boolean; note: string }> = {
  conservative: { wing: 0.01, fut: 0.02, exitAt: 50, half: false, note: 'Tight 1% wings, puts 2% under futures, every lot hedged, take profit at 50%' },
  moderate: { wing: 0.02, fut: 0.04, exitAt: 65, half: false, note: '2% wings, puts 4% under futures, every lot hedged, take profit at 65%' },
  aggressive: { wing: 0.04, fut: 0.07, exitAt: 80, half: true, note: 'Wide 4% wings, puts 7% under futures, half the lots hedged, take profit at 80%' },
};

function appetiteHedge(p: Position, a: Appetite): Hedge {
  const c = APPETITE_RULES[a]; const k = kindOf(p); const step = STEP[p.underlying] ?? 5; const L = APPETITE_LABEL[a];
  const all = lotsOf(p);
  const lots = c.half && all && all > 1 ? Math.ceil(all / 2) : all;
  const qty = lots && p.lot ? lots * p.lot : Math.abs(p.qty);
  const part = lots && all && lots < all ? ` (${lots} of ${all} lots)` : '';
  const buy = (label: string, q: number): Leg => ({ side: 'BUY', label, qty: q });
  const sell = (label: string, q: number): Leg => ({ side: 'SELL', label, qty: q });
  const out = (result: string, legs: Leg[], text: string, why: string): Hedge =>
    ({ result, legs, text, source: `${L} profile`, why, lots: result === 'Exit' ? all : lots, risk: riskOf(p, result, legs) });

  if (k === 'FUT') {
    const long = p.qty > 0;
    const hk = long ? Math.floor((p.ltp * (1 - c.fut)) / step) * step : Math.ceil((p.ltp * (1 + c.fut)) / step) * step;
    const t = long ? 'PE' : 'CE';
    return out(long ? 'Protective put' : 'Protective call', [buy(withStrike(p, hk, t), qty)],
      `Buy ${fmt(qty, 0)} × ${hk} ${t}${part} to ${long ? 'floor' : 'cap'} the futures about ${c.fut * 100}% ${long ? 'below' : 'above'} the last price.`,
      `${long ? 'Put' : 'Call'} ${c.fut * 100}% ${long ? 'under' : 'over'} LTP${part ? ', half the lots' : ''}`);
  }
  const K = strikeOf(p.name)!;
  const decayed = -p.chg;
  if (p.qty < 0 && decayed >= c.exitAt) {
    return out('Exit', [buy(p.name, Math.abs(p.qty))],
      `${fmt(decayed, 0)}% of the premium is captured, past your ${c.exitAt}% take-profit. Buy back ${fmt(Math.abs(p.qty), 0)} to book the profit.`,
      `Past your ${c.exitAt}% take-profit`);
  }
  const gap = Math.max(1, Math.round((K * c.wing) / step)) * step;
  if (p.result === 'Rolled covered call') {
    const nk = K + gap;
    return out('Rolled covered call', [buy(p.name, Math.abs(p.qty)), sell(withStrike(p, nk, 'CE'), Math.abs(p.qty))],
      `Covered by your long futures. Roll up ${fmt(gap, 0)} points to ${nk} CE to lift the cap.`,
      `Roll ${c.wing * 100}% higher`);
  }
  const hk = k === 'CE' ? K + gap : K - gap;
  const result = k === 'CE' ? 'Bear call spread' : 'Bull put spread';
  return out(result, [buy(withStrike(p, hk, k), qty)],
    `Buy ${fmt(qty, 0)} × ${hk} ${k}${part}. ${result} with a ${fmt(gap, 0)}-point wing.`,
    `${c.wing * 100}% wing${part ? ', half the lots' : ', every lot'}`);
}

export function hedgeFor(p: Position, mode: SuggestMode, appetite: Appetite): Hedge {
  return mode === 'rules' ? ruleHedge(p) : appetiteHedge(p, appetite);
}

/** The position as the order ticket sees it, with the chosen suggestion swapped in. */
export const withHedge = (p: Position, h: Hedge): Position =>
  ({ ...p, text: h.text, result: h.result, legs: h.legs, suggestLots: h.lots, source: h.source });
