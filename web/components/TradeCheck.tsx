'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronRight, CircleAlert, CircleCheck, ShieldCheck, X } from 'lucide-react';
import Modal from './Modal';
import type { OptionRow } from '@/lib/data';
import { STATIC, apiUrl } from '@/lib/derivs';
import { useStore } from '@/lib/store';
import { APPETITE_LABEL, RULES, daysTo, expLabel, fmt, hedgeForOption, inr, optName, runChecks, type Appetite } from '@/lib/util';

type Editable = 'cmp' | 'strike' | 'prem' | 'iv' | 'oi' | 'margin';
const FIELDS: Array<{ k: Editable; label: string }> = [
  { k: 'cmp', label: 'CMP (₹)' }, { k: 'strike', label: 'Strike' }, { k: 'prem', label: 'Premium' },
  { k: 'iv', label: 'IV %' }, { k: 'oi', label: 'OI' }, { k: 'margin', label: 'Margin/lot' },
];

/** Trade check opened by Execute on any screener row: key numbers, the risk-appetite checks and the hedge, with live inputs tucked away. */
export default function TradeCheck({ option, onClose }: { option: OptionRow; onClose: () => void }) {
  const router = useRouter();
  const { profile, executeOption, showToast } = useStore();
  const [vals, setVals] = useState<Record<Editable, string>>(() => ({
    cmp: String(option.cmp), strike: String(option.strike), prem: String(option.prem),
    iv: String(option.iv), oi: option.oi == null ? '' : String(option.oi), margin: String(option.margin),
  }));
  const [appetite, setAppetite] = useState<Appetite>(profile.appetite ?? 'moderate');
  // Screener rows carry an estimated margin. The margin endpoint has the broker's figure for this one contract (Kite's
  // margin calculator, no order placed), so fetch it and use it unless the margin has been typed over meanwhile.
  const [exact, setExact] = useState<'off' | 'loading' | 'got' | 'none'>('off');
  useEffect(() => {
    if (STATIC || option.src !== 'chain' || !option.est?.includes('margin')) return;
    let dead = false;
    setExact('loading');
    const q = new URLSearchParams({ symbol: option.symbol, expiry: option.expiry, strike: String(option.strike), type: option.type });
    fetch(apiUrl(`/margin?${q}`), { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<{ margin: number | null }>) : Promise.reject()))
      .then(({ margin: m }) => {
        if (dead) return;
        if (!m) { setExact('none'); return; }
        setVals((v) => (v.margin === String(option.margin) ? { ...v, margin: String(Math.round(m)) } : v));
        setExact('got');
      })
      .catch(() => { if (!dead) setExact('none'); });
    return () => { dead = true; };
  }, [option]);

  const num = (k: Editable, fallback: number) => { const v = parseFloat(vals[k]); return Number.isFinite(v) && v > 0 ? v : fallback; };
  const o = useMemo(() => {
    const cmp = num('cmp', option.cmp), strike = num('strike', option.strike), prem = num('prem', option.prem);
    const margin = num('margin', option.margin), iv = num('iv', option.iv);
    const oiRaw = parseFloat(vals.oi); const oi = Number.isFinite(oiRaw) ? oiRaw : option.oi;
    const otm = option.type === 'PE' ? ((cmp - strike) / cmp) * 100 : ((strike - cmp) / cmp) * 100;
    const totalPrem = prem * option.lot;
    const premPct = (totalPrem / margin) * 100;
    const be = option.type === 'PE' ? strike - prem : strike + prem;
    return { ...option, cmp, strike, prem, margin, iv, oi, otm, totalPrem, premPct, be, beDist: Math.abs((cmp - be) / cmp) * 100 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, option]);

  const dte = daysTo(option.expiry);
  const checks = runChecks(o, appetite, profile.capital);
  const hedge = hedgeForOption(o);
  const est = (k: Editable) => !!option.est?.includes(k as never) && !(k === 'margin' && exact === 'got');
  const name = optName(o);

  const execute = (withHedge: boolean) => {
    const id = executeOption(option.id, {
      underlying: option.symbol, name, exch: 'NFO', product: 'NRML', qty: -option.lot, avg: o.prem, ltp: o.prem, pnl: 0, chg: 0,
      risk: checks.fits ? 'medium' : 'high', text: hedge.text, result: hedge.result, legs: [{ side: 'BUY', label: hedge.label, qty: option.lot }], lot: option.lot,
    }, withHedge);
    showToast(withHedge
      ? `Executed ${name} with a ${hedge.result.toLowerCase()} (demo). Nothing was sent to the exchange.`
      : `Executed ${name} (demo). Its hedge suggestion is waiting in Positions.`);
    onClose();
    router.push(`/positions?new=${id}`);
  };

  return (
    <Modal narrow label={`Trade check for ${name}`} onClose={onClose} footer={dte < 0 ? <>
      <span className="tc-foot-note">This contract has expired, so it can&apos;t be executed.</span>
      <button type="button" className="btn btn-ghost btn-lg" onClick={onClose}>Close</button>
    </> : <>
      <button type="button" className="btn btn-ghost btn-lg" onClick={() => execute(false)}>Execute without hedge</button>
      <button type="button" className="btn btn-primary btn-lg" onClick={() => execute(true)}><ShieldCheck size={18} /> Execute with hedge</button>
    </>}>
      <div className="tc-head">
        <h2>{name}<span className="tag tag-sell">SELL</span><span className="tag tag-exp">{expLabel(option.expiry)}</span></h2>
        <p className="tc-meta">
          {option.note ? `${option.note} · ` : ''}Lot {fmt(option.lot, 0)} · {dte >= 0 ? `${dte} days to expiry` : `expired ${-dte} days ago`} · CMP {inr(o.cmp)}
        </p>
      </div>

      <dl className="tc-stats">
        <div><dt>Credit</dt><dd className="up">{inr(o.totalPrem, 0)}</dd></div>
        <div><dt>Prem % margin</dt><dd>{fmt(o.premPct)}%</dd>{dte > 0 && <small>≈ {fmt(o.premPct * (365 / dte), 0)}% a year</small>}
          {exact !== 'off' && <small className="tc-mg">{exact === 'loading' ? 'Getting Kite’s margin…' : exact === 'got' ? `Kite margin ${inr(o.margin, 0)}` : `Margin estimated (${inr(o.margin, 0)})`}</small>}</div>
        <div><dt>% OTM</dt><dd>{fmt(o.otm)}%</dd></div>
        <div><dt>Breakeven</dt><dd>{inr(o.be)}</dd><small>{fmt(o.beDist, 1)}% {option.type === 'PE' ? 'below' : 'above'} CMP</small></div>
      </dl>

      <details className="tc-edit">
        <summary><ChevronRight size={16} aria-hidden="true" /> Update prices from your option chain{FIELDS.some((f) => est(f.k)) && <span className="tag tag-est">some values estimated</span>}</summary>
        <div className="inputs">
          {FIELDS.map((f) => (
            <div className="field" key={f.k}>
              <label htmlFor={`in-${f.k}`}>{f.label}{est(f.k) && <span className="tag tag-est">est</span>}</label>
              <input id={`in-${f.k}`} type="number" inputMode="decimal" step={f.k === 'oi' ? 1 : 'any'} value={vals[f.k]} placeholder="—"
                onChange={(e) => setVals((v) => ({ ...v, [f.k]: e.target.value }))} />
            </div>
          ))}
        </div>
      </details>

      <section className="tc-risk" aria-labelledby="tc-risk-h">
        <div className="tc-risk-top">
          <h3 id="tc-risk-h">Risk check</h3>
          <div className="seg2" role="group" aria-label="Check against risk appetite">
            {(Object.keys(RULES) as Appetite[]).map((a) => (
              <button key={a} type="button" aria-pressed={a === appetite} onClick={() => setAppetite(a)}>{APPETITE_LABEL[a]}</button>
            ))}
          </div>
        </div>
        <div className={`verdict ${checks.fits ? 'ok' : checks.fails === 1 ? 'partial' : 'bad'}`}>
          {checks.fits ? <CircleCheck size={20} /> : <CircleAlert size={20} />}
          <span>{checks.fits
            ? `Fits ${APPETITE_LABEL[appetite].toLowerCase()}: ${checks.passed} of ${checks.total} checks pass`
            : `Misses ${APPETITE_LABEL[appetite].toLowerCase()}: ${checks.fails} required check${checks.fails > 1 ? 's' : ''} fail`}</span>
        </div>
        <ul className="checks">
          {checks.list.map((c) => (
            <li key={c.label}>
              <span className={`ck ${c.st === 'fail' && !c.gate ? 'soft' : c.st}`}>{c.st === 'pass' ? <Check size={12} strokeWidth={3} /> : c.st === 'fail' ? <X size={11} strokeWidth={3} /> : null}</span>
              <span>{c.label}</span><span className="need">{c.need}</span>
            </li>
          ))}
        </ul>
        {!profile.capital && <p className="tc-hint">Add your capital in your profile to check margin against it.</p>}
      </section>

      <p className="tc-hedge"><ShieldCheck size={16} aria-hidden="true" /><span><b>Hedge:</b> {hedge.text}</span></p>
    </Modal>
  );
}
