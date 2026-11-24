'use client';
import { Fragment, useState } from 'react';
import { CircleCheck, Minus, Plus, ShieldCheck, Zap } from 'lucide-react';
import Modal from './Modal';
import { STRUCTURE, type Position } from '@/lib/data';
import { useStore } from '@/lib/store';
import { RISK_LABEL, fmt, inr, legsForLots, lotsOf, signed, spreadCap, tone } from '@/lib/util';
import { multOf } from '@/lib/suggest';

const LEG_RE = /((?:\d[\d,]* × )?\d[\d,]*(?:\/\d+)? (?:CE|PE)(?: \([^)]*\))?)/g;
export function Suggestion({ text }: { text: string }) {
  return <>{text.split(LEG_RE).map((part, i) => (i % 2 ? <span className="leg" key={i}>{part}</span> : <Fragment key={i}>{part}</Fragment>))}</>;
}

/** Hedge size in whole lots. One-lot positions and unknown lot sizes hedge the full position. */
function LotPicker({ p, value, onChange }: { p: Position; value: number | null; onChange: (v: number) => void }) {
  const total = lotsOf(p);
  if (!p.lot || !total || value == null)
    return <div className="lots-static">Full position · <b>{fmt(Math.abs(p.qty), 0)} qty</b> <span className="muted">(lot size not known)</span></div>;
  if (total === 1)
    return <div className="lots-static"><b>1 lot</b> · {fmt(p.lot, 0)} qty · the full position</div>;
  return (
    <div className="lots">
      <div className="lot-stepper">
        <button type="button" aria-label="One lot less" disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={18} /></button>
        <span><b>{value}</b> of {total} lots</span>
        <button type="button" aria-label="One lot more" disabled={value >= total} onClick={() => onChange(value + 1)}><Plus size={18} /></button>
      </div>
      <span className="lots-qty">{fmt(value * p.lot, 0)} qty <span className="muted">· lot size {fmt(p.lot, 0)}</span></span>
      {value < total && <button type="button" className="btn btn-text btn-sm" onClick={() => onChange(total)}>Hedge all {total}</button>}
    </div>
  );
}

/** Existing hedges on a stock, each with its legs and a Remove button. */
function HedgedList({ list, onRemove }: { list: Position[]; onRemove: (p: Position) => void }) {
  const { hedged } = useStore();
  return (
    <div className="hdone">
      {list.map((p) => {
        const h = hedged[p.id]; const total = lotsOf(p);
        return (
          <div className="hdone-item" key={p.id}>
            <div className="hdone-top">
              <b>{p.name}</b>
              <span className="hstat hstat-full"><ShieldCheck size={15} /> {h.result ?? p.result}</span>
            </div>
            <div className="order">
              {h.legs.map((l) => (
                <div className="order-leg" key={l.label + l.side}><span className={`side side-${l.side.toLowerCase()}`}>{l.side}</span><span className="nm">{l.label}<small>Market · NRML · {p.exch}</small></span><b className="tnum">{fmt(l.qty, 0)}</b></div>
              ))}
            </div>
            <div className="hdone-foot">
              <span className="muted">Placed {h.at}{h.lots != null && total ? ` · ${h.lots} of ${total} lot${total === 1 ? '' : 's'}` : ''}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(p)}>Remove hedge</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One ticket per stock: hedge any open positions, and see or remove the hedges already placed. */
export default function HedgeTicket({ positions, title, onClose }: { positions: Position[]; title: string; onClose: () => void }) {
  const { hedged, placeHedge, removeHedge, showToast } = useStore();
  const open = positions.filter((p) => !hedged[p.id]);
  const done = positions.filter((p) => hedged[p.id]);
  const single = open.length === 1 ? open[0] : null;
  const [lots, setLots] = useState<Record<string, number | null>>(() => Object.fromEntries(positions.map((p) => [p.id, p.suggestLots !== undefined ? p.suggestLots : lotsOf(p)])));
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(positions.map((p) => [p.id, true])));
  const chosen = open.filter((p) => picked[p.id]);
  const scaled = (p: Position) => legsForLots(p, lots[p.id]);
  const sizeText = (p: Position) => {
    const n = lots[p.id], total = lotsOf(p);
    if (n == null || !total || !p.lot) return `Full position · ${fmt(Math.abs(p.qty), 0)} qty`;
    return `${n} of ${total} lot${total > 1 ? 's' : ''} · ${fmt(n * p.lot, 0)} qty`;
  };

  const place = () => {
    chosen.forEach((p) => placeHedge(p.id, lots[p.id], scaled(p), p.result));
    showToast(chosen.length === 1
      ? `Hedge placed (demo): ${chosen[0].result} on ${chosen[0].name}. Nothing was sent to the exchange.`
      : `${chosen.length} hedge orders placed (demo). Nothing was sent to the exchange.`);
    onClose();
  };
  const remove = (p: Position) => { removeHedge(p.id); showToast(`Hedge removed from ${p.name}.`); onClose(); };

  if (!open.length) {
    return (
      <Modal narrow label={title} onClose={onClose} footer={<button type="button" className="btn btn-primary btn-lg" onClick={onClose}>Done</button>}>
        <div>
          <p className="eyebrow">{done.length === 1 ? 'Hedged' : 'All hedged'}</p>
          <h2 style={{ margin: '6px 0 0', font: '800 26px/1.15 var(--f-display)', letterSpacing: '-.02em', paddingRight: 48 }}>{title}</h2>
        </div>
        <div className="verdict ok"><CircleCheck size={22} /> {done.length === 1 ? `${hedged[done[0].id].result ?? done[0].result} in place` : `${done.length} positions hedged`}</div>
        <HedgedList list={done} onRemove={remove} />
      </Modal>
    );
  }

  const sc = single ? spreadCap(single, scaled(single)[0].qty) : null;
  const w = sc && single ? { ...sc, cap: sc.cap * multOf(single) } : null;
  return (
    <Modal narrow={!!single} label={title} onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost btn-lg hide-sm" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary btn-lg" disabled={!chosen.length} onClick={place}>
        <Zap size={18} fill="currentColor" /> {chosen.length > 1 ? `Place ${chosen.length} hedge orders` : 'Place hedge order'}
      </button>
    </>}>
      <div>
        <p className="eyebrow">Execute hedge</p>
        <h2 style={{ margin: '6px 0 0', font: '800 26px/1.15 var(--f-display)', letterSpacing: '-.02em', paddingRight: 48 }}>{title}</h2>
      </div>

      {single ? (
        <>
          <dl className="kv">
            <dt>Position</dt><dd className={single.qty < 0 ? 'down' : 'up'}>{single.qty > 0 ? '+' : ''}{fmt(single.qty, 0)} @ {fmt(single.avg)}</dd>
            <dt>LTP</dt><dd>{fmt(single.ltp)}</dd>
            <dt>P&amp;L</dt><dd className={tone(single.pnl)}>{signed(single.pnl)}</dd>
            <dt>Risk now</dt><dd><span className={`risk risk-${single.risk}`}>{RISK_LABEL[single.risk]}</span></dd>
          </dl>
          <div className="hedge-box">
            <span className="hedge-label"><ShieldCheck size={15} /> Hedge suggestion{single.source && <span className="hedge-src">{single.source}</span>}</span>
            <p><Suggestion text={single.text} /></p>
          </div>
          <div className="structure">
            <span className="structure-i"><ShieldCheck size={22} /></span>
            <div><b>Becomes: {single.result}</b><span>{STRUCTURE[single.result]}</span></div>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {open.map((p) => (
            <div className={`hpos${picked[p.id] ? '' : ' off'}`} key={p.id}>
              <div className="hpos-top">
                <label className="check-row" htmlFor={`pick-${p.id}`} style={{ minHeight: 0 }}>
                  <input id={`pick-${p.id}`} type="checkbox" checked={!!picked[p.id]} onChange={(e) => setPicked((s) => ({ ...s, [p.id]: e.target.checked }))} />
                  <b>{p.name}</b>
                </label>
                <span className={`risk risk-${p.risk}`}>{RISK_LABEL[p.risk]}</span>
              </div>
              <p><Suggestion text={p.text} /></p>
              {picked[p.id] && <LotPicker p={p} value={lots[p.id]} onChange={(v) => setLots((s) => ({ ...s, [p.id]: v }))} />}
            </div>
          ))}
        </div>
      )}

      {single && (
        <div className="size-row">
          <h3>Lots to hedge</h3>
          <LotPicker p={single} value={lots[single.id]} onChange={(v) => setLots((s) => ({ ...s, [single.id]: v }))} />
        </div>
      )}

      <div className="order">
        <div className="order-head"><span>Order ticket</span><span>Qty</span></div>
        {chosen.flatMap((p) => scaled(p).map((l) => (
          <div className="order-leg" key={p.id + l.label + l.side}>
            <span className={`side side-${l.side.toLowerCase()}`}>{l.side}</span>
            <span className="nm">{l.label}<small>Market · NRML · {p.exch}</small></span>
            <b className="tnum">{fmt(l.qty, 0)}</b>
          </div>
        )))}
        {!chosen.length && <div className="order-leg muted">Pick at least one position above.</div>}
      </div>

      <dl className="kv">
        {single
          ? <><dt>Hedge size</dt><dd>{sizeText(single)}</dd></>
          : <><dt>Orders</dt><dd>{chosen.length} position{chosen.length === 1 ? '' : 's'} · {chosen.reduce((n, p) => n + scaled(p).length, 0)} legs</dd></>}
        <dt>Premium</dt><dd>At market <span className="tag tag-est">not in sample</span></dd>
        {w && <><dt>Worst case after hedge</dt><dd>≤ {inr(w.cap, 0)} <span className="muted" style={{ fontWeight: 500 }}>before net credit</span></dd></>}
        {w && w.uncovered > 0 && <><dt>Still unhedged</dt><dd className="down">{fmt(w.uncovered, 0)} qty</dd></>}
      </dl>

      {done.length > 0 && (
        <div className="hdone-sec">
          <h3>Already hedged on this stock</h3>
          <HedgedList list={done} onRemove={remove} />
        </div>
      )}
    </Modal>
  );
}
