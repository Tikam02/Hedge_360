'use client';
import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, X } from 'lucide-react';
import Shell from '@/components/Shell';
import { ApiNotice, BuildUpMap, BuildUpTag, CALL, CallPutBars, DOWN, IvRange, RankBars, Skeleton, UP, pct, type MapPoint } from '@/components/charts';
import { BULLISH, crore, expShort, useApi, type SectorStat, type SectorsResp, type StockStat } from '@/lib/derivs';
import { fmt, tone } from '@/lib/util';

type Metric = 'chg' | 'oiChg' | 'pcr' | 'iv';
const METRICS: Array<{ v: Metric; l: string; about: string }> = [
  { v: 'chg', l: 'Price', about: 'Price change %, weighted by each stock’s option OI value.' },
  { v: 'oiChg', l: 'OI', about: 'Futures open interest change %. Rising OI means new positions.' },
  { v: 'pcr', l: 'PCR', about: 'Put-call ratio of option OI value. Above 1, more puts are open than calls.' },
  { v: 'iv', l: 'IV', about: 'Average at-the-money implied volatility of the sector’s stocks.' },
];
type SortKey = 'name' | 'chg' | 'oiChg' | 'pcr' | 'iv' | 'callCr' | 'putCr';
const COLS: Array<{ key: SortKey; label: string; num?: boolean }> = [
  { key: 'name', label: 'Sector' }, { key: 'chg', label: 'Price', num: true }, { key: 'oiChg', label: 'Fut OI', num: true },
  { key: 'pcr', label: 'PCR', num: true }, { key: 'iv', label: 'ATM IV', num: true },
  { key: 'callCr', label: 'Call OI', num: true }, { key: 'putCr', label: 'Put OI', num: true },
];
const sortVal = (k: SortKey, x: SectorStat | StockStat): number | string => {
  if (k === 'name') return 'name' in x ? x.name : x.symbol;
  if (k === 'iv') return 'iv' in x ? x.iv.avg : x.atmIv ?? -1;
  return (x[k] as number | null) ?? -1;
};
const stamp = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function SectorsPage() {
  return <Shell><Sectors /></Shell>;
}

function Head({ d }: { d?: SectorsResp }) {
  const n = d?.sectors.reduce((a, s) => a + s.stocks.length, 0);
  return (
    <header className="pt-head">
      <div className="pt-title">
        <h1>Sectoral analysis</h1>
        <p>{d ? <>Sector-wise F&amp;O positioning · {expShort(d.expiry)} expiry · {d.sectors.length} sectors, {n} stocks</> : 'Sector-wise F&O positioning'}</p>
      </div>
      {d && <span className="src-tag" title={`Generated ${stamp(d.asOf)}`}>{d.source === 'sample' ? 'Sample data' : `As of ${stamp(d.asOf)}`}</span>}
    </header>
  );
}

function Sectors() {
  const api = useApi<SectorsResp>('/sectors');
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<'sectors' | 'stocks'>('sectors');
  const [metric, setMetric] = useState<Metric>('chg');
  const [open, setOpen] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'chg', asc: false });

  if (api.error) return <main className="page pt"><Head /><ApiNotice error={api.error} retry={api.retry} /></main>;
  const d = api.data;
  if (!d) {
    return (
      <main className="page pt" aria-busy="true">
        <Head />
        <Skeleton h={76} />
        <div className="sc-grid"><Skeleton h={430} /><Skeleton h={430} /><Skeleton h={360} /><Skeleton h={360} /></div>
      </main>
    );
  }

  const pick = (id: string) => setSel((s) => (s === id ? null : id));
  const dim = sel != null;
  const sectors = d.sectors;
  const stocks = sectors.flatMap((s) => s.stocks);
  const nifty = d.indices.find((i) => i.symbol === 'NIFTY'), bank = d.indices.find((i) => i.symbol === 'BANKNIFTY');
  const bullish = sectors.filter((s) => BULLISH[s.buildUp]).length;
  const callCr = stocks.reduce((a, s) => a + s.callCr, 0), putCr = stocks.reduce((a, s) => a + s.putCr, 0);
  const ivs = stocks.map((s) => s.atmIv).filter((v): v is number => v != null);
  const ivAvg = ivs.reduce((a, b) => a + b, 0) / (ivs.length || 1);

  const big = new Set([...stocks].sort((a, b) => b.callCr + b.putCr - (a.callCr + a.putCr)).slice(0, 8).map((s) => s.symbol));
  const points: MapPoint[] = view === 'sectors'
    ? sectors.map((s) => ({ id: s.name, label: s.name, x: s.chg, y: s.oiChg, size: s.callCr + s.putCr, on: sel === s.name, buildUp: s.buildUp }))
    : stocks.map((s) => ({ id: s.symbol, label: s.symbol, x: s.chg, y: s.oiChg, size: s.callCr + s.putCr, on: sel === s.sector, buildUp: s.buildUp, group: s.sector }));

  const m = METRICS.find((x) => x.v === metric)!;
  const mval = (s: SectorStat) => (metric === 'iv' ? s.iv.avg : s[metric]);
  const rank = [...sectors].sort((a, b) => mval(b) - mval(a)).map((s) => ({
    id: s.name, label: s.name, value: mval(s), on: sel === s.name,
    text: metric === 'pcr' ? fmt(s.pcr, 2) : metric === 'iv' ? `${fmt(s.iv.avg, 1)}%` : pct(mval(s)),
  }));
  const byOi = [...sectors].sort((a, b) => b.callCr + b.putCr - (a.callCr + a.putCr));

  const dir = sort.asc ? 1 : -1;
  const cmp = (a: SectorStat | StockStat, b: SectorStat | StockStat) => {
    const va = sortVal(sort.key, a), vb = sortVal(sort.key, b);
    return typeof va === 'string' ? dir * va.localeCompare(vb as string) : dir * (va - (vb as number));
  };
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: key === 'name' }));
  const toggleRow = (name: string) => {
    const opening = !open.includes(name);
    setOpen((o) => (opening ? [...o, name] : o.filter((x) => x !== name)));
    if (opening) setSel(name);
  };

  return (
    <main className="page pt">
      <Head d={d} />

      <section className="pt-stats" aria-label="Market summary">
        {[nifty, bank].map((i) => i && (
          <div key={i.symbol}>
            <span className="st-l">{i.symbol} · <BuildUpTag b={i.buildUp} /></span>
            <span className="st-v">{fmt(i.spot)}<small className={tone(i.chg)}> {pct(i.chg)}</small></span>
          </div>
        ))}
        <div className="st-hedge">
          <span className="st-l">Bullish sectors</span>
          <span className="st-v"><span className={bullish ? 'up' : ''}>{bullish}</span><small> of {sectors.length}</small></span>
          <span className="st-bar" aria-hidden="true"><span style={{ width: `${(bullish / sectors.length) * 100}%` }} /></span>
        </div>
        <div>
          <span className="st-l">Stock options PCR</span>
          <span className="st-v">{fmt(putCr / callCr, 2)}<small className="st-sub"> · ATM IV {fmt(ivAvg, 1)}% avg</small></span>
        </div>
      </section>

      {sel && (
        <div className="pt-result">
          <span>Highlighting <b>{sel}</b> in every chart</span>
          <button type="button" className="link-btn" onClick={() => setSel(null)}><X size={15} aria-hidden="true" /> Clear</button>
        </div>
      )}

      <div className="sc-grid">
        <section className="ch-card sc-wide" aria-labelledby="h-map">
          <header className="ch-head">
            <div>
              <h2 id="h-map">Build-up map</h2>
              <p>Price change against futures OI change. Dot size is option OI value. Click a dot to highlight its sector.</p>
            </div>
            <div className="seg2 seg-sm" role="group" aria-label="Plot">
              <button type="button" aria-pressed={view === 'sectors'} onClick={() => setView('sectors')}>Sectors</button>
              <button type="button" aria-pressed={view === 'stocks'} onClick={() => setView('stocks')}>Stocks</button>
            </div>
          </header>
          <BuildUpMap points={points} dim={dim} onPick={pick} height={380} labelled={(p) => view === 'sectors' || (sel ? p.on : big.has(p.id))} />
        </section>

        <section className="ch-card" aria-labelledby="h-rank">
          <header className="ch-head">
            <div><h2 id="h-rank">Sector ranking</h2><p>{m.about}</p></div>
            <div className="seg2 seg-sm" role="group" aria-label="Rank by">
              {METRICS.map((x) => <button key={x.v} type="button" aria-pressed={metric === x.v} onClick={() => setMetric(x.v)}>{x.l}</button>)}
            </div>
          </header>
          <RankBars rows={rank} base={metric === 'pcr' ? 1 : 0} dim={dim} onPick={pick}
            color={(v) => (metric === 'chg' ? (v >= 0 ? UP : DOWN) : CALL)} />
        </section>

        <section className="ch-card" aria-labelledby="h-cp">
          <header className="ch-head"><div><h2 id="h-cp">Call vs put open interest</h2><p>Option OI value in ₹ crore, largest sectors first.</p></div></header>
          <CallPutBars dim={dim} onPick={pick} rows={byOi.map((s) => ({
            id: s.name, label: s.name, call: s.callCr, put: s.putCr, ratio: fmt(s.pcr, 2), on: sel === s.name,
            tip: <><b>{s.name}</b><span>Calls {crore(s.callCr)} · Puts {crore(s.putCr)}</span><span>PCR {fmt(s.pcr, 2)}</span></>,
          }))} />
        </section>

        <section className="ch-card" aria-labelledby="h-iv">
          <header className="ch-head"><div><h2 id="h-iv">ATM implied volatility</h2><p>Lowest to highest stock in each sector, dot at the average.</p></div></header>
          <IvRange dim={dim} onPick={pick} rows={[...sectors].sort((a, b) => b.iv.avg - a.iv.avg).map((s) => ({
            id: s.name, label: s.name, min: s.iv.min, avg: s.iv.avg, max: s.iv.max, on: sel === s.name,
          }))} />
        </section>
      </div>

      <section className="table-card" aria-labelledby="h-table">
        <header className="ch-head tc-pad"><div><h2 id="h-table">Sectors and stocks</h2><p>Open a sector to see its stocks. Open a stock’s option chain from its row.</p></div></header>
        <div className="table-scroll">
          <table className="grid sc-table">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={[c.num && 'num', sort.key === c.key && 'sorted', c.key === 'name' && 'sticky-l'].filter(Boolean).join(' ')}
                    aria-sort={sort.key === c.key ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => toggleSort(c.key)}>
                      {c.label}<span className="ar">{sort.key === c.key ? (sort.asc ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} />}</span>
                    </button>
                  </th>
                ))}
                <th>Build-up</th>
              </tr>
            </thead>
            <tbody>
              {[...sectors].sort(cmp).map((s) => {
                const isOpen = open.includes(s.name);
                const bull = s.stocks.filter((x) => BULLISH[x.buildUp]).length;
                return (
                  <Fragment key={s.name}>
                    <tr className={`sc-row${sel === s.name ? ' sel' : ''}`} onClick={() => toggleRow(s.name)}>
                      <td className="sticky-l">
                        <button type="button" className="sc-exp" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} ${s.name} stocks`}
                          onClick={(e) => { e.stopPropagation(); toggleRow(s.name); }}>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                        <span className="sc-name"><b>{s.name}</b><span className="sym-sub">{s.stocks.length} stocks · {bull} bullish</span></span>
                      </td>
                      <td className={`num ${tone(s.chg)}`}>{pct(s.chg)}</td>
                      <td className="num">{pct(s.oiChg)}</td>
                      <td className="num">{fmt(s.pcr, 2)}</td>
                      <td className="num">{fmt(s.iv.avg, 1)}%<span className="sc-rng">{fmt(s.iv.min, 0)}–{fmt(s.iv.max, 0)}</span></td>
                      <td className="num">{crore(s.callCr)}</td>
                      <td className="num">{crore(s.putCr)}</td>
                      <td><BuildUpTag b={s.buildUp} /></td>
                    </tr>
                    {isOpen && [...s.stocks].sort(cmp).map((x) => (
                      <tr key={x.symbol} className="sc-sub">
                        <td className="sticky-l">
                          <Link href={`/chain?symbol=${encodeURIComponent(x.symbol)}`} className="sc-sym" onClick={(e) => e.stopPropagation()}>
                            {x.symbol}<span className="sym-sub">₹{fmt(x.spot)} · Max pain {fmt(x.maxPain, 0)}</span>
                          </Link>
                        </td>
                        <td className={`num ${tone(x.chg)}`}>{pct(x.chg)}</td>
                        <td className="num">{pct(x.oiChg)}</td>
                        <td className="num">{fmt(x.pcr, 2)}</td>
                        <td className="num">{x.atmIv == null ? '—' : `${fmt(x.atmIv, 1)}%`}</td>
                        <td className="num">{crore(x.callCr)}</td>
                        <td className="num">{crore(x.putCr)}</td>
                        <td><span className="sc-sub-end"><BuildUpTag b={x.buildUp} /><Link href={`/chain?symbol=${encodeURIComponent(x.symbol)}`} className="act">Chain</Link></span></td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <p className="foot-note">
        {d.source === 'sample' ? 'Sample data from the analytics server (derivs.py), not market prices. ' : <>
          Live from Kite, read only, refreshed at most once a minute; each stock on its nearest expiry, PCR and option OI value over the 10 strikes
          either side of spot. Futures OI change (all months) is {d.oiSince && d.oiSince >= '09:15' ? `from ${d.oiSince}, the first reading today` : 'from the previous close'}.{' '}
        </>}
        Sector price and OI change are weighted by each stock’s option OI value (contracts × lot × spot). Build-up reads price and futures OI
        together: both up is long build-up, price down with OI up is short build-up, price up with OI down is short covering, both down is long unwinding.
      </p>
    </main>
  );
}
