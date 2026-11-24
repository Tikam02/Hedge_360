'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, CircleCheck, TriangleAlert } from 'lucide-react';
import Shell from '@/components/Shell';
import HedgeTicket from '@/components/HedgeTicket';
import { DOWN, RankBars, UP, pct } from '@/components/charts';
import type { Position, Risk } from '@/lib/data';
import { useStore, type HedgeRecord } from '@/lib/store';
import { RISK_ORDER, fmt, inrShort, lotsOf, signed, tone, words, type Appetite } from '@/lib/util';
import { hedgeFor, kindOf, multOf, withHedge, type Hedge } from '@/lib/suggest';

export default function DashboardPage() {
  return <Shell><Dashboard /></Shell>;
}

const RISKS: Risk[] = ['highest', 'high', 'medium', 'low'];
const RISK_SHORT: Record<Risk, string> = { highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

type Status = 'open' | 'part' | 'full' | 'exit';
const STATUS_LABEL: Record<Status, string> = { open: 'Not hedged', part: 'Partly hedged', full: 'Hedged', exit: 'Exit placed' };
const statusOf = (p: Position, h?: HedgeRecord): Status => {
  if (!h) return 'open';
  if (h.result === 'Exit') return 'exit';
  const lots = lotsOf(p);
  return h.lots != null && lots != null && h.lots < lots ? 'part' : 'full';
};

// Instrument mix: what the book is made of. Long options only appear if there are any.
const MIX: Array<{ id: string; label: string; test: (p: Position) => boolean }> = [
  { id: 'sc', label: 'Short calls', test: (p) => kindOf(p) === 'CE' && p.qty < 0 },
  { id: 'sp', label: 'Short puts', test: (p) => kindOf(p) === 'PE' && p.qty < 0 },
  { id: 'lo', label: 'Long options', test: (p) => kindOf(p) !== 'FUT' && p.qty > 0 },
  { id: 'lf', label: 'Long futures', test: (p) => kindOf(p) === 'FUT' && p.qty > 0 },
  { id: 'sf', label: 'Short futures', test: (p) => kindOf(p) === 'FUT' && p.qty < 0 },
];

type SortKey = 'name' | 'qty' | 'pnl' | 'chg' | 'risk' | 'status';
type View = 'all' | 'open' | 'hedged' | 'loss';
const VIEWS: Array<{ v: View; l: string }> = [{ v: 'all', l: 'All' }, { v: 'open', l: 'Not hedged' }, { v: 'hedged', l: 'Hedged' }, { v: 'loss', l: 'In loss' }];
const COLS: Array<{ key: SortKey | null; label: string; num?: boolean }> = [
  { key: 'name', label: 'Instrument' }, { key: 'qty', label: 'Qty', num: true }, { key: null, label: 'Avg', num: true },
  { key: null, label: 'LTP', num: true }, { key: 'pnl', label: 'P&L', num: true }, { key: 'chg', label: 'Chg', num: true },
  { key: 'risk', label: 'Risk' }, { key: 'status', label: 'Status' },
];
const STATUS_ORDER: Record<Status, number> = { open: 0, part: 1, full: 2, exit: 3 };

function Dashboard() {
  const { positions, hedged, profile, suggestMode } = useStore();
  const router = useRouter();
  const appetite: Appetite = profile.appetite ?? 'moderate';
  const [ticket, setTicket] = useState<Position | null>(null);
  const [view, setView] = useState<View>('all');
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'pnl', asc: true });

  // Same suggestions as the Positions page, so both screens always agree on what to hedge or book.
  const hedges = useMemo(() => new Map(positions.map((p) => [p.id, hedgeFor(p, suggestMode, appetite)])), [positions, suggestMode, appetite]);
  const hedgeOf = (p: Position) => hedges.get(p.id) as Hedge;

  const n = positions.length;
  const sum = (l: Position[]) => l.reduce((a, p) => a + p.pnl, 0);
  const total = sum(positions);
  const winners = positions.filter((p) => p.pnl > 0), losers = positions.filter((p) => p.pnl < 0);
  const hedgedN = positions.filter((p) => hedged[p.id]).length;
  const attention = positions.filter((p) => !hedged[p.id] && (p.risk === 'highest' || p.risk === 'high'))
    .sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.pnl - b.pnl);
  const ready = positions.filter((p) => !hedged[p.id] && hedgeOf(p).result === 'Exit').sort((a, b) => b.pnl - a.pnl);
  const readyCr = sum(ready);

  // Premium kept: of the premium collected on short options, how much is profit so far (multOf turns lots into units).
  const shorts = positions.filter((p) => kindOf(p) !== 'FUT' && p.qty < 0);
  const sold = shorts.reduce((a, p) => a + p.avg * Math.abs(p.qty) * multOf(p), 0);
  const kept = sum(shorts);

  const byStock = [...new Set(positions.map((p) => p.underlying))].map((u) => {
    const list = positions.filter((p) => p.underlying === u);
    return { u, pnl: sum(list), n: list.length, hedged: list.filter((p) => hedged[p.id]).length };
  }).sort((a, b) => b.pnl - a.pnl);
  const gross = byStock.reduce((a, s) => a + Math.abs(s.pnl), 0);
  const top = [...byStock].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))[0];

  const riskRows = RISKS.map((r) => {
    const list = positions.filter((p) => p.risk === r);
    return { id: r, label: RISK_SHORT[r], n: list.length, hedged: list.filter((p) => hedged[p.id]).length, pnl: sum(list) };
  });
  const mixRows = MIX.map((m) => {
    const list = positions.filter(m.test);
    return { id: m.id, label: m.label, n: list.length, hedged: list.filter((p) => hedged[p.id]).length, pnl: sum(list) };
  }).filter((m) => m.n > 0);
  const maxN = Math.max(1, ...riskRows.map((r) => r.n), ...mixRows.map((m) => m.n));

  const shown = positions.filter((p) => view === 'all' || (view === 'open' ? !hedged[p.id] : view === 'hedged' ? !!hedged[p.id] : p.pnl < 0));
  const val = (p: Position, k: SortKey): number | string =>
    k === 'name' ? p.name : k === 'qty' ? p.qty : k === 'pnl' ? p.pnl : k === 'chg' ? p.chg : k === 'risk' ? RISK_ORDER[p.risk] : STATUS_ORDER[statusOf(p, hedged[p.id])];
  const rows = [...shown].sort((a, b) => {
    const va = val(a, sort.key), vb = val(b, sort.key), d = sort.asc ? 1 : -1;
    return typeof va === 'string' ? d * va.localeCompare(vb as string) : d * (va - (vb as number)) || a.pnl - b.pnl;
  });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: key === 'name' || key === 'pnl' || key === 'risk' || key === 'status' }));
  const open = (p: Position) => setTicket(withHedge(p, hedgeOf(p)));

  return (
    <main className="page pt db">
      <header className="pt-head">
        <div className="pt-title">
          <h1>Dashboard</h1>
          <p>{n} open positions · {byStock.length} underlyings · sample book, prices fixed</p>
        </div>
        <Link href="/positions" className="btn btn-ghost btn-sm">All positions <ArrowRight size={16} aria-hidden="true" /></Link>
      </header>

      <section className="kpis" aria-label="Summary">
        <div className="kpi kpi-hero">
          <span className="kpi-l">Net P&amp;L</span>
          <span className={`kpi-v ${tone(total)}`} title={signed(total)}>{inrShort(total)}</span>
          <span className="kpi-s">{profile.capital ? <><b className={tone(total)}>{pct((total / profile.capital) * 100)}</b> of {words(profile.capital)} capital</> : `Across ${n} positions`}</span>
        </div>
        <div className="kpi">
          <span className="kpi-l">In profit</span>
          <span className="kpi-v up" title={signed(sum(winners))}>{inrShort(sum(winners))}</span>
          <span className="kpi-s">{winners.length} position{winners.length === 1 ? '' : 's'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-l">In loss</span>
          <span className="kpi-v down" title={signed(sum(losers))}>{inrShort(sum(losers))}</span>
          <span className="kpi-s">{losers.length} position{losers.length === 1 ? '' : 's'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-l">Hedged</span>
          <span className="kpi-v">{hedgedN}<small> of {n}</small></span>
          <span className="kpi-bar" aria-hidden="true"><span style={{ width: `${n ? (hedgedN / n) * 100 : 0}%` }} /></span>
        </div>
        <div className="kpi">
          <span className="kpi-l">{attention.length > 0 && <TriangleAlert size={14} className="warn-ic" aria-hidden="true" />}Needs attention</span>
          <span className="kpi-v">{attention.length}</span>
          <span className="kpi-s">High risk, not hedged</span>
        </div>
        <div className="kpi">
          <span className="kpi-l">Premium kept</span>
          <span className="kpi-v">{sold ? `${fmt((kept / sold) * 100, 1)}%` : '—'}</span>
          <span className="kpi-s" title={`${signed(kept, 0)} of ${fmt(sold, 0)} collected`}>{inrShort(kept, false)} of {inrShort(sold, false)}</span>
        </div>
      </section>

      <div className="db-grid">
        <section className="ch-card db-a" aria-labelledby="h-stock">
          <header className="ch-head">
            <div>
              <h2 id="h-stock">P&amp;L by underlying</h2>
              <p>{top && gross ? <><b>{top.u}</b> is {fmt((Math.abs(top.pnl) / gross) * 100, 0)}% of the total move, gains and losses together. </> : null}Click a bar to open its positions.</p>
            </div>
          </header>
          <RankBars dim={false} valW={74} color={(v) => (v >= 0 ? UP : DOWN)} onPick={(u) => router.push(`/positions?stock=${encodeURIComponent(u)}`)}
            rows={byStock.map((s) => ({
              id: s.u, label: s.u, value: s.pnl, text: inrShort(s.pnl), on: false,
              tip: <><b>{s.u}</b><span>P&amp;L {signed(s.pnl, 0)}</span><span>{s.n} position{s.n === 1 ? '' : 's'} · {s.hedged} hedged</span></>,
            }))} />
        </section>

        <section className="ch-card db-b" aria-labelledby="h-status">
          <header className="ch-head">
            <div><h2 id="h-status">Hedge status</h2><p>Positions by risk and by instrument. Bar length is the number of positions.</p></div>
            <div className="ch-legend"><span><i className="hs-k-done" />Hedged</span><span><i className="hs-k-open" />Not hedged</span></div>
          </header>
          <StatusRows title="By risk" rows={riskRows} max={maxN} onPick={(r) => router.push(`/positions?risk=${r}`)} risk />
          <StatusRows title="By instrument" rows={mixRows} max={maxN} />
        </section>

        <section className="ch-card db-a" aria-labelledby="h-att">
          <header className="ch-head">
            <div><h2 id="h-att">Needs attention</h2><p>High and highest risk positions with no hedge, most urgent first.</p></div>
            {attention.length > 5 && <Link href="/positions?risk=highest,high&hedge=open" className="link-btn">See all {attention.length} <ArrowRight size={15} aria-hidden="true" /></Link>}
          </header>
          <div className="dl">
            {attention.length === 0 && <p className="dl-empty"><CircleCheck size={18} className="up" aria-hidden="true" /> Every high-risk position is hedged.</p>}
            {attention.slice(0, 5).map((p) => {
              const h = hedgeOf(p);
              return (
                <div className="dl-row" key={p.id}>
                  <div className="dl-main">
                    <span className="dl-name"><span className={`kt kt-${kindOf(p).toLowerCase()}`}>{kindOf(p)}</span><span className="dl-nm">{p.name}</span></span>
                    <span className="dl-sub"><span className={`rk rk-${p.risk}`}><i aria-hidden="true" />{RISK_SHORT[p.risk]}</span> · Suggests {h.result === 'Exit' ? 'booking the profit' : h.result.toLowerCase()}</span>
                  </div>
                  <span className={`dl-pnl ${tone(p.pnl)}`}>{signed(p.pnl, 0)}<small className={tone(p.chg)}>{signed(p.chg)}%</small></span>
                  <button type="button" className="act" onClick={() => open(p)}>{h.result === 'Exit' ? 'Book' : 'Hedge'}</button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="ch-card db-b" aria-labelledby="h-book">
          <header className="ch-head">
            <div>
              <h2 id="h-book">Ready to book</h2>
              <p>{ready.length ? <>Short options that have given up most of their premium. Booking all locks in <b className="up">{inrShort(readyCr)}</b>.</> : 'Short options that have given up most of their premium.'}</p>
            </div>
          </header>
          <div className="dl">
            {ready.length === 0 && <p className="dl-empty">Nothing to book right now. Positions show up here once most of their premium has decayed.</p>}
            {ready.slice(0, 5).map((p) => (
              <div className="dl-row" key={p.id}>
                <div className="dl-main">
                  <span className="dl-name"><span className={`kt kt-${kindOf(p).toLowerCase()}`}>{kindOf(p)}</span><span className="dl-nm">{p.name}</span></span>
                  <span className="dl-sub">{fmt(-p.chg, 0)}% of the premium captured</span>
                </div>
                <span className={`dl-pnl ${tone(p.pnl)}`}>{signed(p.pnl, 0)}</span>
                <button type="button" className="act" onClick={() => open(p)}>Book</button>
              </div>
            ))}
            {ready.length > 5 && <p className="dl-more">and {ready.length - 5} more in Positions</p>}
          </div>
        </section>
      </div>

      <section className="table-card" aria-labelledby="h-trades">
        <header className="ch-head tc-pad">
          <div><h2 id="h-trades">All trades</h2><p>P&amp;L and hedge status of every position. Open a row to see it in Positions.</p></div>
          <div className="seg2 seg-sm" role="group" aria-label="Show">
            {VIEWS.map((x) => <button key={x.v} type="button" aria-pressed={view === x.v} onClick={() => setView(x.v)}>{x.l}</button>)}
          </div>
        </header>
        <div className="table-scroll">
          <table className="grid db-table">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.label} className={[c.num && 'num', c.key && sort.key === c.key && 'sorted', c.key === 'name' && 'sticky-l'].filter(Boolean).join(' ')}
                    aria-sort={c.key && sort.key === c.key ? (sort.asc ? 'ascending' : 'descending') : undefined}>
                    {c.key ? (
                      <button type="button" onClick={() => toggleSort(c.key!)}>
                        {c.label}<span className="ar">{sort.key === c.key ? (sort.asc ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} />}</span>
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const st = statusOf(p, hedged[p.id]);
                const lots = lotsOf(p);
                return (
                  <tr key={p.id} onClick={() => router.push(`/positions?focus=${p.id}`)}>
                    <td className="sticky-l">
                      <Link href={`/positions?focus=${p.id}`} className="db-inst" onClick={(e) => e.stopPropagation()}>
                        <span className={`kt kt-${kindOf(p).toLowerCase()}`}>{kindOf(p)}</span>
                        <span className="db-nm"><b>{p.name}</b><span className="sym-sub">{p.exch} · {p.qty < 0 ? 'Short' : 'Long'}{lots != null ? ` · ${lots} lot${lots === 1 ? '' : 's'}` : ''}</span></span>
                        {p.fresh && <span className="tag tag-new">New</span>}
                      </Link>
                    </td>
                    <td className={`num ${p.qty < 0 ? 'down' : 'up'}`}>{p.qty > 0 ? '+' : ''}{fmt(p.qty, 0)}</td>
                    <td className="num">{fmt(p.avg)}</td>
                    <td className="num">{fmt(p.ltp)}</td>
                    <td className={`num db-pnl ${tone(p.pnl)}`}>{signed(p.pnl)}</td>
                    <td className={`num ${tone(p.chg)}`}>{signed(p.chg)}%</td>
                    <td><span className={`rk rk-${p.risk}`}><i aria-hidden="true" />{RISK_SHORT[p.risk]}</span></td>
                    <td><span className={`pg-status ${st === 'open' ? 'none' : st === 'exit' ? 'full' : st}`}><span className="pg-dot" aria-hidden="true" />{STATUS_LABEL[st]}</span></td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr className="db-none"><td colSpan={COLS.length}>No positions in this view.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="foot-note">P&amp;L is marked at the sample book's fixed prices, before premiums paid on hedges. Premium kept is the profit so far on short options as a share of the premium collected. Hedge and exit orders are simulated; nothing is sent to an exchange.</p>

      {ticket && <HedgeTicket positions={[ticket]} title={ticket.name} onClose={() => setTicket(null)} />}
    </main>
  );
}

/** Count of positions per group as a bar (hedged part first), with the group's P&L. */
function StatusRows({ title, rows, max, onPick, risk }: {
  title: string; rows: Array<{ id: string; label: string; n: number; hedged: number; pnl: number }>; max: number; onPick?: (id: string) => void; risk?: boolean;
}) {
  return (
    <div className="hs">
      <p className="hs-t">{title}</p>
      {rows.map((r) => {
        const body = (
          <>
            <span className="hs-l">{risk ? <span className={`rk rk-${r.id}`}><i aria-hidden="true" />{r.label}</span> : r.label}</span>
            <span className="hs-bar" aria-hidden="true">
              <span style={{ width: `${(r.n / max) * 100}%` }}>
                {r.hedged > 0 && <i className="hs-done" style={{ flexGrow: r.hedged }} />}
                {r.n - r.hedged > 0 && <i className="hs-open" style={{ flexGrow: r.n - r.hedged }} />}
              </span>
            </span>
            <span className="hs-n">{r.hedged}<small>/{r.n}<span className="hs-w"> hedged</span></small></span>
            <span className={`hs-p ${tone(r.pnl)}`}>{inrShort(r.pnl)}</span>
          </>
        );
        return onPick
          ? <button type="button" className="hs-row" key={r.id} onClick={() => onPick(r.id)} aria-label={`${r.label} risk: ${r.n} positions, ${r.hedged} hedged, P&L ${inrShort(r.pnl)}. Open in Positions`}>{body}</button>
          : <div className="hs-row" key={r.id}>{body}</div>;
      })}
    </div>
  );
}
