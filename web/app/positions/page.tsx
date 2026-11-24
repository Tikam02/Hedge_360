'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CornerDownRight, Info, Search, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import Shell from '@/components/Shell';
import HedgeTicket from '@/components/HedgeTicket';
import Modal from '@/components/Modal';
import { FilterMenu, SortMenu } from '@/components/FilterMenu';
import type { Position, Risk } from '@/lib/data';
import { useStore, type HedgeRecord } from '@/lib/store';
import { APPETITE_LABEL, RISK_ORDER, fmt, lotsOf, signed, tone, type Appetite } from '@/lib/util';
import { APPETITE_RULES, RULE_LIST, hedgeFor, kindOf, shortLeg, withHedge, type Hedge, type Kind } from '@/lib/suggest';

export default function PositionsPage() {
  return <Shell><Suspense fallback={null}><Positions /></Suspense></Shell>;
}

interface Filters { stock: string[]; kind: string[]; side: string[]; risk: string[]; exch: string[]; pnl: string[]; hedge: string[] }
const NO_FILTERS: Filters = { stock: [], kind: [], side: [], risk: [], exch: [], pnl: [], hedge: [] };
type Sort = 'risk' | 'loss' | 'profit' | 'name';
const SORTS: Array<{ v: Sort; l: string }> = [
  { v: 'risk', l: 'Risk, highest first' }, { v: 'loss', l: 'Biggest loss first' },
  { v: 'profit', l: 'Biggest profit first' }, { v: 'name', l: 'Name, A to Z' },
];
const RISK_SHORT: Record<Risk, string> = { highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };
const KIND_LABEL: Record<Kind, string> = { CE: 'Call (CE)', PE: 'Put (PE)', FUT: 'Future' };

function Positions() {
  const { positions, hedged, profile, setProfile, suggestMode, setSuggestMode } = useStore();
  const appetite: Appetite = profile.appetite ?? 'moderate';
  const params = useSearchParams();
  // ?new= (just executed) or ?focus= (opened from the dashboard) scrolls to that row; ?stock=, ?risk= and ?hedge= preset the filters.
  const fresh = params.get('new') ?? params.get('focus');
  const [q, setQ] = useState('');
  const fromUrl = (): Filters => {
    const list = (k: string) => params.get(k)?.split(',').filter(Boolean) ?? [];
    return { ...NO_FILTERS, stock: list('stock'), risk: list('risk'), hedge: list('hedge') };
  };
  const [f, setF] = useState<Filters>(fromUrl);
  // Following another link to this page (sidebar, dashboard) replaces the filters with that link's.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setF(fromUrl()), [params]);
  const [sort, setSort] = useState<Sort>('risk');
  const [ticket, setTicket] = useState<Position | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [sheet, setSheet] = useState(false);

  const hedges = useMemo(() => new Map(positions.map((p) => [p.id, hedgeFor(p, suggestMode, appetite)])), [positions, suggestMode, appetite]);

  const facet = (key: keyof Filters, p: Position): string => {
    switch (key) {
      case 'stock': return p.underlying;
      case 'kind': return kindOf(p);
      case 'side': return p.qty < 0 ? 'short' : 'long';
      case 'risk': return p.risk;
      case 'exch': return p.exch;
      case 'pnl': return p.pnl > 0 ? 'profit' : 'loss';
      case 'hedge': return hedged[p.id] ? 'hedged' : 'open';
    }
  };
  const needle = q.trim().toLowerCase();
  const passes = (p: Position, skip?: keyof Filters) =>
    (!needle || p.name.toLowerCase().includes(needle) || p.underlying.toLowerCase().includes(needle)) &&
    (Object.keys(f) as Array<keyof Filters>).every((k) => k === skip || !f[k].length || f[k].includes(facet(k, p)));
  const shown = positions.filter((p) => passes(p));

  // Counts respect every other active filter, so a count never promises rows that won't appear.
  const opts = (key: keyof Filters, list: Array<[string, string]>) => {
    const base = positions.filter((p) => passes(p, key));
    return list.map(([v, l]) => ({ v, l, n: base.filter((p) => facet(key, p) === v).length }));
  };
  const stocks = [...new Set(positions.map((p) => p.underlying))].sort();

  const rank = (p: Position) => (p.fresh ? -1 : RISK_ORDER[p.risk]);
  const byRow = (a: Position, b: Position) =>
    sort === 'risk' ? rank(a) - rank(b) || a.pnl - b.pnl : sort === 'loss' ? a.pnl - b.pnl : sort === 'profit' ? b.pnl - a.pnl : a.name.localeCompare(b.name);
  const sum = (l: Position[]) => l.reduce((s, p) => s + p.pnl, 0);
  const groupKey = (l: Position[]) => (sort === 'risk' ? Math.min(...l.map(rank)) : sort === 'loss' ? sum(l) : sort === 'profit' ? -sum(l) : 0);
  const map = new Map<string, Position[]>();
  [...shown].sort(byRow).forEach((p) => { if (!map.has(p.underlying)) map.set(p.underlying, []); map.get(p.underlying)!.push(p); });
  const groups = [...map].sort((a, b) => groupKey(a[1]) - groupKey(b[1]) || a[0].localeCompare(b[0]));

  useEffect(() => {
    if (!fresh) return;
    const el = document.getElementById(`row-${fresh}`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); }
  }, [fresh]);

  const set = (k: keyof Filters, v: string[]) => setF((x) => ({ ...x, [k]: v }));
  const activeN = (Object.keys(f) as Array<keyof Filters>).filter((k) => f[k].length).length + (needle ? 1 : 0);
  const clearAll = () => { setF(NO_FILTERS); setQ(''); };

  const total = sum(shown);
  const hedgedN = shown.filter((p) => hedged[p.id]).length;
  const winners = shown.filter((p) => p.pnl > 0).length;

  const menus = (inline?: boolean) => (
    <>
      <FilterMenu inline={inline} label="Stock" value={f.stock} onChange={(v) => set('stock', v)} options={opts('stock', stocks.map((s) => [s, s]))} searchable />
      <FilterMenu inline={inline} label="Type" value={f.kind} onChange={(v) => set('kind', v)} options={opts('kind', (['CE', 'PE', 'FUT'] as Kind[]).map((k) => [k, KIND_LABEL[k]]))} />
      <FilterMenu inline={inline} label="Side" value={f.side} onChange={(v) => set('side', v)} options={opts('side', [['short', 'Short (sold)'], ['long', 'Long (bought)']])} single />
      <FilterMenu inline={inline} label="Risk" value={f.risk} onChange={(v) => set('risk', v)} options={opts('risk', (['highest', 'high', 'medium', 'low'] as Risk[]).map((r) => [r, RISK_SHORT[r]]))} />
      <FilterMenu inline={inline} label="P&L" value={f.pnl} onChange={(v) => set('pnl', v)} options={opts('pnl', [['profit', 'In profit'], ['loss', 'In loss']])} single />
      <FilterMenu inline={inline} label="Hedge" value={f.hedge} onChange={(v) => set('hedge', v)} options={opts('hedge', [['open', 'Not hedged'], ['hedged', 'Hedged']])} single />
      <FilterMenu inline={inline} label="Exchange" value={f.exch} onChange={(v) => set('exch', v)} options={opts('exch', [['NFO', 'NFO'], ['BFO', 'BFO'], ['MCX', 'MCX']])} />
    </>
  );

  return (
    <main className="page pt">
      <header className="pt-head">
        <div className="pt-title">
          <h1>Positions</h1>
          <p>{positions.length} open · {stocks.length} underlyings · NRML · sample book, prices fixed</p>
        </div>
      </header>

      <section className="pt-stats" aria-label="Summary">
        <div><span className="st-l">{activeN ? 'P&L, filtered' : 'Total P&L'}</span><span className={`st-v ${tone(total)}`}>{signed(total)}</span></div>
        <div><span className="st-l">Positions</span><span className="st-v">{shown.length}<small> of {positions.length}</small></span></div>
        <div><span className="st-l">In profit / in loss</span><span className="st-v"><span className="up">{winners}</span><small> / </small><span className="down">{shown.length - winners}</span></span></div>
        <div className="st-hedge"><span className="st-l">Hedged</span><span className="st-v">{hedgedN}<small> of {shown.length}</small></span>
          <span className="st-bar" aria-hidden="true"><span style={{ width: `${shown.length ? (hedgedN / shown.length) * 100 : 0}%` }} /></span></div>
      </section>

      <section className="sugg" aria-labelledby="sugg-l">
        <h2 id="sugg-l" className="sugg-l"><ShieldCheck size={18} aria-hidden="true" />Hedge suggestions</h2>
        <div className="seg2 seg-sm" role="group" aria-label="Suggest hedges by">
          <button type="button" aria-pressed={suggestMode === 'appetite'} onClick={() => setSuggestMode('appetite')}>Risk appetite</button>
          <button type="button" aria-pressed={suggestMode === 'rules'} onClick={() => setSuggestMode('rules')}>Rule engine</button>
        </div>
        <span className="sugg-sep" aria-hidden="true" />
        {suggestMode === 'appetite' ? (
          <>
            <div className="seg2 seg-sm" role="group" aria-label="Risk appetite">
              {(['conservative', 'moderate', 'aggressive'] as Appetite[]).map((a) => (
                <button key={a} type="button" aria-pressed={appetite === a} onClick={() => setProfile({ appetite: a })}>{APPETITE_LABEL[a]}</button>
              ))}
            </div>
            <ul className="sugg-rules" aria-label={`${APPETITE_LABEL[appetite]} hedging rules`}>
              {APPETITE_RULES[appetite].note.split(', ').map((r) => <li key={r}>{r}</li>)}
            </ul>
          </>
        ) : (
          <>
            <p className="sugg-note">Eight fixed rules, the same for every trader. Each row names the rule that fired.</p>
            <button type="button" className="link-btn" onClick={() => setRulesOpen(true)}><Info size={15} aria-hidden="true" /> See the rules</button>
          </>
        )}
      </section>

      <section className="pt-tools" aria-label="Filters">
        <label className="pt-search">
          <Search size={18} aria-hidden="true" />
          <input type="search" placeholder="Search instrument" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search instrument" />
          {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')}><X size={16} /></button>}
        </label>
        <div className="pt-menus">{menus()}</div>
        <button type="button" className="pt-filters-btn" onClick={() => setSheet(true)}>
          <SlidersHorizontal size={18} /> Filters{activeN > 0 && <span className="badge">{activeN}</span>}
        </button>
        <SortMenu value={sort} options={SORTS} onChange={setSort} />
      </section>
      {activeN > 0 && (
        <div className="pt-result">
          <span>Showing <b>{shown.length}</b> of {positions.length} positions</span>
          <button type="button" className="link-btn" onClick={clearAll}>Clear all filters</button>
        </div>
      )}

      <div className="pt-groups">
        {groups.length === 0 && (
          <div className="pt-empty">
            <h3>No positions match these filters</h3>
            <button type="button" className="btn btn-ghost" onClick={clearAll}>Clear all filters</button>
          </div>
        )}
        {groups.map(([u, list]) => {
          const all = positions.filter((p) => p.underlying === u);
          const done = all.filter((p) => hedged[p.id]).length;
          const gp = sum(list);
          const state = !done ? 'none' : done < all.length ? 'part' : 'full';
          return (
            <section className="pg" key={u} aria-label={u}>
              <div className="pg-bar">
                <div className="pg-name"><b>{u}</b><span>{list.length === all.length ? `${all.length} position${all.length === 1 ? '' : 's'}` : `${list.length} of ${all.length} shown`}</span></div>
                <div className="pg-pnl"><span>P&amp;L</span><b className={tone(gp)}>{signed(gp)}</b></div>
                <div className={`pg-status ${state}`}>
                  <span className="pg-dot" aria-hidden="true" />
                  {state === 'none' ? 'Not hedged' : state === 'part' ? `${done} of ${all.length} hedged` : all.length === 1 ? 'Hedged' : 'All hedged'}
                </div>
              </div>
              <div className="pr pr-head" aria-hidden="true">
                <span>Instrument</span><span className="n">Qty</span><span className="n">Avg</span><span className="n">LTP</span><span className="n">P&amp;L</span>
                <span>Risk</span><span>Hedge suggestion</span><span />
              </div>
              {list.map((p) => (
                <Row key={p.id} p={p} h={hedged[p.id]} hedge={hedges.get(p.id)!} showSource={suggestMode === 'rules'} onHedge={() => setTicket(withHedge(p, hedges.get(p.id)!))} onView={() => setTicket(p)} />
              ))}
            </section>
          );
        })}
      </div>
      <p className="foot-note">A made-up sample book with fixed prices, not anyone's account. Loss figures are before premiums, which the sample does not include. Hedge orders are simulated and nothing is sent to an exchange.</p>

      {ticket && <HedgeTicket positions={[ticket]} title={ticket.name} onClose={() => setTicket(null)} />}

      {sheet && (
        <Modal label="Filters" onClose={() => setSheet(false)} footer={<>
          <button type="button" className="btn btn-ghost btn-lg" onClick={clearAll}>Clear all</button>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setSheet(false)}>Show {shown.length} positions</button>
        </>}>
          <h2 className="sheet-title">Filters</h2>
          <div className="sheet-menus">{menus(true)}</div>
        </Modal>
      )}

      {rulesOpen && (
        <Modal label="Rule engine" onClose={() => setRulesOpen(false)} footer={<button type="button" className="btn btn-primary btn-lg" onClick={() => setRulesOpen(false)}>Done</button>}>
          <h2 className="sheet-title">Rule engine</h2>
          <p className="sheet-lede">Rules are checked from top to bottom. The first one that matches sets the suggestion.</p>
          <div className="rules-wrap">
            <table className="rtable">
              <thead><tr><th>Rule</th><th>When</th><th>Suggests</th></tr></thead>
              <tbody>
                {RULE_LIST.map((r) => (
                  <tr key={r.id}><td><b>{r.id}</b> {r.name}</td><td>{r.when}</td><td>{r.then}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </main>
  );
}

function Row({ p, h, hedge, showSource, onHedge, onView }: { p: Position; h?: HedgeRecord; hedge: Hedge; showSource: boolean; onHedge: () => void; onView: () => void }) {
  const k = kindOf(p);
  const lots = lotsOf(p);
  const partial = !!h && h.lots != null && lots != null && h.lots < lots;
  return (
    <>
      <div className={`pr${p.fresh ? ' fresh' : ''}${h ? ' has-leg' : ''}`} id={`row-${p.id}`}>
        <div className="pr-inst">
          <span className="pr-name"><span className={`kt kt-${k.toLowerCase()}`}>{k}</span><span className="pr-nm">{p.name}</span>{p.fresh && <span className="tag tag-new">New</span>}</span>
          <span className="pr-sub">{p.exch} · NRML{lots != null ? ` · ${lots} lot${lots === 1 ? '' : 's'}` : ''}</span>
        </div>
        <div className={`n pr-qty ${p.qty < 0 ? 'down' : 'up'}`}><span className="cl">Qty</span>{p.qty > 0 ? '+' : ''}{fmt(p.qty, 0)}</div>
        <div className="n"><span className="cl">Avg</span>{fmt(p.avg)}</div>
        <div className="n"><span className="cl">LTP</span>{fmt(p.ltp)}</div>
        <div className={`n pr-pnl ${tone(p.pnl)}`}><span className="cl">P&amp;L</span>{signed(p.pnl)}<small className={tone(p.chg)}>{signed(p.chg)}%</small></div>
        <div className="pr-risk"><span className={`rk rk-${p.risk}`}><i aria-hidden="true" />{RISK_SHORT[p.risk]}</span></div>
        <div className="pr-sugg">
          {h ? (
            <>
              <span className="sg-top"><span className="sg-done">{partial ? 'Partly hedged' : 'Hedged'}</span><b>{h.result ?? p.result}</b></span>
              <span className="sg-why">{partial ? `${h.lots} of ${lots} lots covered · ` : ''}Placed {h.at} · hedge leg below</span>
            </>
          ) : (
            <>
              <span className="sg-top"><b>{hedge.result === 'Exit' ? 'Book profit' : hedge.result}</b>{hedge.legs.map((l) => <span key={l.label + l.side} className={`sg-leg ${l.side.toLowerCase()}`}>{shortLeg(l)}</span>)}</span>
              <span className="sg-why">{showSource && <span className="sg-src">{hedge.source}</span>}{hedge.why}{hedge.risk && <> · {hedge.risk.label} <b className={hedge.risk.label === 'Books' ? 'up' : ''}>₹{fmt(Math.abs(hedge.risk.value), 0)}</b></>}</span>
            </>
          )}
        </div>
        <div className="pr-act">
          {h
            ? <button type="button" className="act act-view" onClick={onView}>View hedge</button>
            : <button type="button" className="act" onClick={onHedge}>Execute hedge</button>}
        </div>
      </div>
      {h && h.legs.map((l, i) => {
        const legLots = p.lot ? l.qty / p.lot : null;
        return (
          <div className="pr pr-leg" key={`${p.id}-leg-${i}`}>
            <div className="pr-inst">
              <span className="pr-name"><CornerDownRight size={16} className="leg-arrow" aria-hidden="true" /><span className={`side side-${l.side.toLowerCase()}`}>{l.side}</span><span className="pr-nm">{l.label}</span></span>
              <span className="pr-sub">Hedge for {p.name} · market order · {h.at}</span>
            </div>
            <div className={`n pr-qty ${l.side === 'BUY' ? 'up' : 'down'}`}><span className="cl">Qty</span>{l.side === 'BUY' ? '+' : '-'}{fmt(l.qty, 0)}{legLots != null && <small className="muted">{legLots} lot{legLots === 1 ? '' : 's'}</small>}</div>
            <div className="n muted leg-x">At market</div>
            <div className="n muted leg-x">—</div>
            <div className="n muted leg-x">—</div>
            <div className="leg-x" />
            <div className="pr-sugg leg-x"><span className="sg-why">Fills at market. Premium not in the sample.</span></div>
            <div className="leg-x" />
          </div>
        );
      })}
    </>
  );
}
