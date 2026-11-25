'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import TradeCheck from '@/components/TradeCheck';
import { ColumnsMenu, FilterMenu, RangeMenu } from '@/components/FilterMenu';
import { ApiNotice, Skeleton } from '@/components/charts';
import { api as accountApi, type Blacklisted } from '@/lib/account';
import type { OptionRow } from '@/lib/data';
import { STATIC, useApi, type ScreenerResp } from '@/lib/derivs';
import { useStore } from '@/lib/store';
import { APPETITE_LABEL, RULES, daysTo, fmt, inr, parseExp, runChecks } from '@/lib/util';

type ColKey = keyof Pick<OptionRow, 'symbol' | 'cmp' | 'strike' | 'otm' | 'prem' | 'lot' | 'totalPrem' | 'margin' | 'premPct' | 'expiry' | 'fut' | 'hi52' | 'lo52' | 'pe' | 'iv' | 'oi'>;
const COLS: Array<{ key: ColKey; label: string; num?: boolean; hl?: boolean; locked?: boolean }> = [
  { key: 'symbol', label: 'Symbol', locked: true },
  { key: 'strike', label: 'Strike', num: true },
  { key: 'cmp', label: 'CMP', num: true },
  { key: 'otm', label: '% OTM', num: true },
  { key: 'prem', label: 'Prem/share', num: true },
  { key: 'lot', label: 'Lot size', num: true },
  { key: 'totalPrem', label: 'Credit (1 lot)', num: true },
  { key: 'margin', label: 'Margin', num: true },
  { key: 'premPct', label: 'Prem % margin', num: true, hl: true },
  { key: 'oi', label: 'OI', num: true },
  { key: 'expiry', label: 'Expiry' },
  { key: 'fut', label: 'Futures', num: true },
  { key: 'hi52', label: '52W high', num: true },
  { key: 'lo52', label: '52W low', num: true },
  { key: 'pe', label: 'Stock PE', num: true },
];
const DEFAULT_COLS: ColKey[] = ['strike', 'cmp', 'otm', 'totalPrem', 'margin', 'premPct', 'hi52', 'lo52'];
// v2: the IV column went and Expiry left the defaults for the 52-week range; a v1 choice would hide that, so it starts over.
const COLS_KEY = 'hedge360.screener.cols.v2';

type FKey = 'type' | 'expiry' | 'fit' | 'iv' | 'status';
type Filters = Record<FKey, string[]>;
const NO_FILTERS: Filters = { type: [], expiry: [], fit: [], iv: [], status: [] };

// Slider filters ("at least X%"). Bounds come from the data so the whole track is usable, and the low end lets every
// option through. They start at DEFAULT_RNG (kept inside the bounds); the user moves them either way.
type RKey = 'otm' | 'yield';
const bounds = (all: OptionRow[], pick: (o: OptionRow) => number) => {
  const v = all.map(pick);
  return v.length ? { lo: Math.floor(Math.min(...v)), hi: Math.ceil(Math.max(...v)) } : { lo: 0, hi: 1 };
};
const DEFAULT_RNG: Record<RKey, number> = { otm: 10, yield: 5 };
const RKEYS = Object.keys(DEFAULT_RNG) as RKey[];
const PAGE = 100;
const VALUE: Record<RKey, (o: OptionRow) => number> = { otm: (o) => o.otm, yield: (o) => o.premPct };

const expDate = (s: string) => s.replace(/-/g, ' ');
const thresholds = (base: number[], mine: number) => [...new Set([...base, mine])].sort((a, b) => a - b);

export default function ScreenerPage() {
  return <Shell><Screener /></Shell>;
}

const HISTORY_POLL = 10_000;

function Screener() {
  // Re-scan asks the server for a fresh pass; the rows on screen stay until it answers. While the 52-week range is
  // still being filled, the last pass is asked for again every HISTORY_POLL ms to pick up what has been stored.
  const [req, setReq] = useState({ rescan: false, n: 0 });
  const api = useApi<ScreenerResp>(req.n ? `/screener?${req.rescan ? 'rescan=1&' : ''}n=${req.n}` : '/screener');
  // useApi drops its data when a request fails; a failed Re-scan keeps showing the last good scan.
  const [last, setLast] = useState<ScreenerResp | null>(null);
  useEffect(() => { if (api.data) setLast(api.data); }, [api.data]);
  const data = api.data ?? last;
  const filling = data?.history?.state === 'filling';
  // Stocks on this account's blacklist (Ticker Data) are left out of the rows.
  const [black, setBlack] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (STATIC) return;
    accountApi<Blacklisted[]>('/api/tickers/blacklist').then((xs) => setBlack(new Set(xs.map((x) => x.symbol)))).catch(() => { /* rows stay unfiltered */ });
  }, []);
  const shown = useMemo(() => (data && black.size ? { ...data, rows: data.rows.filter((r) => !black.has(r.symbol)) } : data), [data, black]);
  const hidden = useMemo(() => (data ? new Set(data.rows.filter((r) => black.has(r.symbol)).map((r) => r.symbol)).size : 0), [data, black]);
  useEffect(() => {
    if (STATIC || !filling || api.loading) return;
    const t = setTimeout(() => setReq((r) => ({ rescan: false, n: r.n + 1 })), HISTORY_POLL);
    return () => clearTimeout(t);
  }, [filling, api.loading, data]);
  if (!shown) return (
    <main className="page pt">
      <header className="pt-head"><div className="pt-title"><h1>Screener</h1><p>Scanning F&amp;O stock options…</p></div></header>
      {api.error ? <ApiNotice error={api.error} retry={api.retry} /> : <><Skeleton h={88} /><Skeleton h={480} /></>}
    </main>
  );
  return <ScreenerTable resp={shown} hidden={hidden} busy={api.loading && req.rescan} error={req.rescan ? api.error : null}
    rescan={() => setReq((r) => ({ rescan: true, n: r.n + 1 }))} />;
}

function ScreenerTable({ resp, hidden, busy, error, rescan }: { resp: ScreenerResp; hidden: number; busy: boolean; error: string | null; rescan: () => void }) {
  const OPTIONS = resp.rows;
  const live = resp.source === 'live';
  const RANGE = useMemo(() => ({ otm: bounds(OPTIONS, (o) => o.otm), yield: bounds(OPTIONS, (o) => o.premPct) }), [OPTIONS]);
  const base = useMemo(() => Object.fromEntries(RKEYS.map((k) => [k, Math.min(Math.max(DEFAULT_RNG[k], RANGE[k].lo), RANGE[k].hi)])) as Record<RKey, number>, [RANGE]);
  const router = useRouter();
  const { profile, executed } = useStore();
  const appetite = profile.appetite ?? 'moderate';
  const rule = RULES[appetite];
  const [q, setQ] = useState('');
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [rng, setRng] = useState<Partial<Record<RKey, number>>>({});  // only what the user moved
  const at = (k: RKey) => rng[k] ?? base[k];
  const [sort, setSort] = useState<{ key: ColKey; asc: boolean }>({ key: 'premPct', asc: false });
  const [open, setOpen] = useState<OptionRow | null>(null);
  const [sheet, setSheet] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // Shell mounts this only on the client, after the store is ready, so reading storage here can't cause a hydration mismatch.
  const [cols, setColsState] = useState<ColKey[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null');
      if (Array.isArray(saved)) return saved.filter((k): k is ColKey => COLS.some((c) => c.key === k));
    } catch { /* storage blocked */ }
    return DEFAULT_COLS;
  });

  const setCols = (next: string[]) => {
    const keys = next as ColKey[];
    setColsState(keys);
    try { localStorage.setItem(COLS_KEY, JSON.stringify(keys)); } catch { /* storage blocked */ }
    if (sort.key !== 'symbol' && !keys.includes(sort.key)) setSort(keys.includes('premPct') ? { key: 'premPct', asc: false } : { key: 'symbol', asc: true });
  };
  const visibleCols = COLS.filter((c) => c.locked || cols.includes(c.key));

  const checks = useMemo(() => new Map(OPTIONS.map((o) => [o.id, runChecks(o, appetite, profile.capital)])), [OPTIONS, appetite, profile.capital]);

  const match = (k: FKey, o: OptionRow, v: string): boolean => {
    switch (k) {
      case 'type': return o.type === v;
      case 'expiry': return o.expiry === v;
      case 'fit': return (checks.get(o.id)!.fits ? 'fit' : 'out') === v;
      case 'status': return (executed[o.id] ? 'done' : 'open') === v;
      case 'iv': return o.iv <= +v;
    }
  };
  const needle = q.trim().toUpperCase();
  const passes = (o: OptionRow, skip?: FKey | RKey) =>
    (!needle || o.symbol.includes(needle)) &&
    RKEYS.every((k) => k === skip || VALUE[k](o) >= at(k)) &&
    (Object.keys(f) as FKey[]).every((k) => k === skip || !f[k].length || f[k].some((v) => match(k, o, v)));
  // Counts respect every other active filter, so a count never promises rows that won't appear.
  const opts = (k: FKey, list: Array<[string, string]>) => {
    const base = OPTIONS.filter((o) => passes(o, k));
    return list.map(([v, l]) => ({ v, l, n: base.filter((o) => match(k, o, v)).length }));
  };

  const rows = OPTIONS.filter((o) => passes(o)).sort((a, b) => {
    const { key, asc } = sort;
    if (key === 'symbol') return (asc ? 1 : -1) * a.symbol.localeCompare(b.symbol);
    const va = key === 'expiry' ? +parseExp(a.expiry) : (a[key] as number | null);
    const vb = key === 'expiry' ? +parseExp(b.expiry) : (b[key] as number | null);
    if (va == null) return 1; if (vb == null) return -1;
    return asc ? va - vb : vb - va;
  });

  const expiries = [...new Set(OPTIONS.map((o) => o.expiry))].sort((a, b) => +parseExp(a) - +parseExp(b));
  const nearest = expiries.find((e) => daysTo(e) >= 0);
  const fitN = rows.filter((o) => checks.get(o.id)!.fits).length;
  // Back to the first page whenever the list changes shape.
  useEffect(() => setLimit(PAGE), [q, f, rng, sort, OPTIONS]);
  const scanned = new Date(resp.scanned).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const set = (k: FKey, v: string[]) => setF((x) => ({ ...x, [k]: v }));
  const activeN = (Object.keys(f) as FKey[]).filter((k) => f[k].length).length + RKEYS.filter((k) => at(k) !== base[k]).length + (needle ? 1 : 0);
  const clearAll = () => { setF(NO_FILTERS); setRng({}); setQ(''); };
  const range = (k: RKey, label: string, title: string, inline: boolean | undefined, presets: number[], mine?: number) => (
    <RangeMenu id={`rng-${k}`} inline={inline} label={label} title={title} value={at(k)} base={base[k]} onChange={(v) => setRng((r) => ({ ...r, [k]: v }))}
      lo={RANGE[k].lo} hi={RANGE[k].hi} step={0.25} values={OPTIONS.filter((o) => passes(o, k)).map(VALUE[k])}
      presets={thresholds([...presets, base[k]], mine ?? base[k]).filter((t) => t > RANGE[k].lo && t <= RANGE[k].hi)
        .map((t) => ({ v: t, l: t === mine ? `${t}% (your rule)` : t === base[k] ? `${t}% (default)` : `${t}%` }))} />
  );
  const toggleSort = (key: ColKey) => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: key === 'symbol' || key === 'margin' }));

  const menus = (inline?: boolean) => (
    <>
      <FilterMenu inline={inline} label="Fit" value={f.fit} onChange={(v) => set('fit', v)} single
        options={opts('fit', [['fit', `Fits ${APPETITE_LABEL[appetite]}`], ['out', 'Outside your risk']])} />
      <FilterMenu inline={inline} label="Type" value={f.type} onChange={(v) => set('type', v)} options={opts('type', [['PE', 'Put (PE)'], ['CE', 'Call (CE)']])} />
      <FilterMenu inline={inline} label="Expiry" value={f.expiry} onChange={(v) => set('expiry', v)}
        options={opts('expiry', expiries.map((e) => [e, `${expDate(e)}${daysTo(e) < 0 ? ' (expired)' : ''}`]))} />
      {range('otm', '% OTM', 'Minimum % OTM', inline, [10, 11], rule.otm)}
      {range('yield', 'Prem % margin', 'Minimum premium % of margin', inline, [7, 9])}
      <FilterMenu inline={inline} label="IV" value={f.iv} onChange={(v) => set('iv', v)} single
        options={opts('iv', thresholds([25, 50, 70], rule.iv).map((t) => [String(t), `≤ ${t}%${t === rule.iv ? ' (your rule)' : ''}`]))} />
      <FilterMenu inline={inline} label="Status" value={f.status} onChange={(v) => set('status', v)} single
        options={opts('status', [['open', 'Not executed'], ['done', 'Executed']])} />
    </>
  );

  const cell = (c: (typeof COLS)[number], o: OptionRow) => {
    switch (c.key) {
      case 'symbol': {
        const ck = checks.get(o.id)!;
        return (
          <td key={c.key} className="sticky-l">
            <span className="sym">{o.symbol}{o.featured && <span className="tag tag-feat">Featured</span>}</span>
            <span className="sym-sub">{ck.fits
              ? <span className="up">Fits {APPETITE_LABEL[appetite]}</span>
              : `${ck.fails} check${ck.fails === 1 ? '' : 's'} miss`}</span>
          </td>
        );
      }
      case 'strike': return <td key={c.key} className="num"><span className="strike">{fmt(o.strike, Number.isInteger(o.strike) ? 0 : 2)}<span className={`kt kt-${o.type.toLowerCase()}`}>{o.type}</span></span></td>;
      case 'otm': return <td key={c.key} className="num">{fmt(o.otm)}%</td>;
      case 'premPct': return <td key={c.key} className="num hl"><b className={o.premPct >= 8.5 ? 'up' : ''}>{fmt(o.premPct)}%</b></td>;
      case 'lot': return <td key={c.key} className="num">{fmt(o.lot, 0)}</td>;
      case 'pe': return <td key={c.key} className="num">{fmt(o.pe)}</td>;
      case 'oi': return <td key={c.key} className="num">{o.oi == null ? <span className="muted">—</span> : fmt(o.oi, 0)}</td>;
      case 'expiry': return <td key={c.key}>{daysTo(o.expiry) < 0 ? <span className="muted">Expired</span> : expDate(o.expiry)}</td>;
      default: return <td key={c.key} className="num">{inr(o[c.key] as number | null)}</td>;
    }
  };

  return (
    <main className="page pt">
      <header className="pt-head">
        <div className="pt-title">
          <h1>Screener</h1>
          <p>{fmt(OPTIONS.length, 0)} OTM stock options, {resp.otm[0]}–{resp.otm[1]}% out of the money · nearest expiry · checked against your {APPETITE_LABEL[appetite].toLowerCase()} profile</p>
        </div>
        <div className="sc-scan">
          <span className={`sc-src${live ? ' on' : ''}`}><i aria-hidden="true" />{live ? 'Live from Kite' : 'Sample data'} · scanned {scanned}</span>
          {resp.history?.state === 'filling' && (
            <span className="sc-hist" role="status"><RefreshCw size={13} className="spin" aria-hidden="true" /> 52-week range: storing daily bars, {resp.history.done} of {resp.history.total} stocks</span>
          )}
          {!STATIC && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={rescan} disabled={busy} aria-busy={busy}>
              <RefreshCw size={16} className={busy ? 'spin' : ''} aria-hidden="true" /> {busy ? 'Scanning…' : 'Re-scan'}
            </button>
          )}
        </div>
      </header>
      {error && <p className="pf-msg bad" role="alert">Re-scan failed: {error === 'offline' ? 'can’t reach the server.' : error} Showing the previous scan.</p>}
      {resp.history?.state === 'error' && <p className="pf-msg bad" role="alert">The 52-week range couldn’t be updated from Kite: {resp.history.error} It tries again on a later scan.</p>}

      <section className="pt-stats sc-stats" aria-label="Summary">
        <div><span className="st-l">Options</span><span className="st-v">{rows.length}<small> of {OPTIONS.length}</small></span></div>
        <div className="st-hedge"><span className="st-l">Fit your profile</span><span className="st-v"><span className={fitN ? 'up' : ''}>{fitN}</span><small> of {rows.length}</small></span>
          <span className="st-bar" aria-hidden="true"><span style={{ width: `${rows.length ? (fitN / rows.length) * 100 : 0}%` }} /></span></div>
        <div><span className="st-l">Days to expiry</span>{nearest
          ? <span className="st-v">{daysTo(nearest) || 'Today'}<small>{daysTo(nearest) ? (daysTo(nearest) === 1 ? ' day' : ' days') : ''} · {expDate(nearest).replace(/ \d{4}$/, '')}</small></span>
          : <span className="st-v muted">Expired</span>}</div>
      </section>

      <section className="pt-tools" aria-label="Filters">
        <label className="pt-search">
          <Search size={18} aria-hidden="true" />
          <input type="search" placeholder="Search symbol" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search symbol" autoComplete="off" />
          {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')}><X size={16} /></button>}
        </label>
        <div className="pt-menus">{menus()}</div>
        <button type="button" className="pt-filters-btn" onClick={() => setSheet(true)}>
          <SlidersHorizontal size={18} /> Filters{activeN > 0 && <span className="badge">{activeN}</span>}
        </button>
        <ColumnsMenu columns={COLS} visible={cols} onChange={setCols} onReset={() => setCols(DEFAULT_COLS)} />
      </section>
      {activeN > 0 && (
        <div className="pt-result">
          <span>Showing <b>{rows.length}</b> of {OPTIONS.length} options</span>
          <button type="button" className="link-btn" onClick={clearAll}>Reset filters</button>
        </div>
      )}

      {rows.length ? (
        <section className="table-card" aria-label="Screened options">
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  {visibleCols.map((c) => (
                    <th key={c.key} className={[c.num && 'num', c.hl && 'hl', sort.key === c.key && 'sorted', c.key === 'symbol' && 'sticky-l'].filter(Boolean).join(' ')}
                      aria-sort={sort.key === c.key ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleSort(c.key)}>
                        {c.label}
                        <span className="ar">{sort.key === c.key ? (sort.asc ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} />}</span>
                      </button>
                    </th>
                  ))}
                  <th className="sticky-r"><span className="sr">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((o) => {
                  const done = !!executed[o.id];
                  const expired = daysTo(o.expiry) < 0;
                  return (
                    <tr key={o.id} onClick={() => (done ? router.push('/positions') : setOpen(o))}>
                      {visibleCols.map((c) => cell(c, o))}
                      <td className="sticky-r">
                        {done
                          ? <button type="button" className="act act-view" onClick={(e) => { e.stopPropagation(); router.push('/positions'); }}><Check size={15} /> Executed</button>
                          : <button type="button" className={`act${expired ? ' act-view' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(o); }}>{expired ? 'View' : 'Execute'}</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > limit && (
            <div className="sc-more">
              <span>Showing {fmt(limit, 0)} of {fmt(rows.length, 0)}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((n) => n + PAGE * 2)}>Show {fmt(Math.min(PAGE * 2, rows.length - limit), 0)} more</button>
            </div>
          )}
        </section>
      ) : (
        <div className="pt-empty">
          <h3>No options match these filters</h3>
          <button type="button" className="btn btn-ghost" onClick={clearAll}>Reset filters</button>
        </div>
      )}
      <p className="foot-note">{live
        ? 'Live Kite quotes, read only: every listed strike 3–25% out of the money on each F&O stock’s nearest expiry. This is the last scan; Re-scan fetches a new one (about half a minute). The 52-week high and low come from a year of Kite daily bars kept in the database, plus today’s high and low. '
        : 'Sample data from the generator, 52-week range included. Log in to Zerodha on Profile and this becomes live Kite data. '}
        Filters start at ≥ {DEFAULT_RNG.otm}% OTM and ≥ {DEFAULT_RNG.yield}% premium of margin. Margin is estimated at {resp.marginPct}% of strike × lot; the trade check fetches the broker’s exact figure{live ? '' : ' when live'}. Stock PE isn’t in either feed.{hidden > 0 && <> Hiding {hidden} blacklisted {hidden === 1 ? 'stock' : 'stocks'}; change that in <Link href="/tickers">Ticker Data</Link>.</>}</p>

      {open && <TradeCheck option={open} onClose={() => setOpen(null)} />}

      {sheet && (
        <Modal label="Filters" onClose={() => setSheet(false)} footer={<>
          <button type="button" className="btn btn-ghost btn-lg" onClick={clearAll}>Reset</button>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setSheet(false)}>Show {rows.length} options</button>
        </>}>
          <h2 className="sheet-title">Filters</h2>
          <div className="sheet-menus">{menus(true)}</div>
        </Modal>
      )}
    </main>
  );
}
