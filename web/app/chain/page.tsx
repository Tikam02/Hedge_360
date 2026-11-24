'use client';
import { Fragment, Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check } from 'lucide-react';
import Shell from '@/components/Shell';
import TradeCheck from '@/components/TradeCheck';
import { ColumnsMenu, SelectMenu } from '@/components/FilterMenu';
import { ApiNotice, CALL, Legend, OiByStrike, PUT, Skeleton, pct } from '@/components/charts';
import Surface3D, { type SurfaceMode } from '@/components/Surface3D';
import { chainOption, contracts, expShort, useApi, type ChainResp, type ChainRow, type SurfaceResp, type SymbolsResp } from '@/lib/derivs';
import type { OptionRow, OptType } from '@/lib/data';
import { useStore } from '@/lib/store';
import { daysTo, fmt, tone } from '@/lib/util';

type ColKey = 'oi' | 'chgOi' | 'vol' | 'iv' | 'delta' | 'chg' | 'ltp';
// Listed outside-in for calls; puts mirror the order so LTP always sits next to the strike.
const COLS: Array<{ key: ColKey; label: string; locked?: boolean }> = [
  { key: 'oi', label: 'OI' }, { key: 'chgOi', label: 'Chg in OI' }, { key: 'vol', label: 'Volume' }, { key: 'iv', label: 'IV' },
  { key: 'delta', label: 'Delta' }, { key: 'chg', label: 'Chg %' }, { key: 'ltp', label: 'LTP', locked: true },
];
const DEFAULT_COLS: ColKey[] = ['oi', 'chgOi', 'iv', 'chg'];
const COLS_KEY = 'hedge360.chain.cols';
// On phones, showing both sides keeps only OI and LTP so the table fits without scrolling sideways.
const CORE: ColKey[] = ['oi', 'ltp'];
type Range = '5' | '10' | '15' | 'all';
const RANGES: Array<{ v: Range; l: string }> = [{ v: '5', l: '±5' }, { v: '10', l: '±10' }, { v: '15', l: '±15' }, { v: 'all', l: 'All' }];
type SideView = 'both' | 'calls' | 'puts';
const PHONE = '(max-width: 720px)';

/** Phone layout is chosen in JS, not CSS, so header colSpans always match the columns actually shown. */
function usePhone() {
  // Shell renders pages only on the client, so matchMedia is available on the first render.
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const m = matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

export default function ChainPage() {
  return <Shell><Suspense fallback={<div className="loading">Loading the option chain…</div>}><Chain /></Suspense></Shell>;
}

function Chain() {
  const router = useRouter();
  const params = useSearchParams();
  const symbol = (params.get('symbol') ?? 'NIFTY').toUpperCase();
  const expiryParam = params.get('expiry');
  const { executed } = useStore();
  const phone = usePhone();
  const syms = useApi<SymbolsResp>('/symbols');
  const chain = useApi<ChainResp>(`/chain?symbol=${encodeURIComponent(symbol)}${expiryParam ? `&expiry=${encodeURIComponent(expiryParam)}` : ''}`);
  const surf = useApi<SurfaceResp>(`/surface?symbol=${encodeURIComponent(symbol)}`);
  const [range, setRange] = useState<Range>('10');
  const [side, setSide] = useState<SideView>('both');
  const [chartMode, setChartMode] = useState<'oi' | 'chg'>('oi');
  const [mode3d, setMode3d] = useState<SurfaceMode>('oi');
  const [open, setOpen] = useState<OptionRow | null>(null);
  // Shell mounts this only on the client, after the store is ready, so reading storage here can't cause a hydration mismatch.
  const [cols, setColsState] = useState<ColKey[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null');
      if (Array.isArray(saved)) return saved.filter((k): k is ColKey => COLS.some((c) => c.key === k));
    } catch { /* storage blocked */ }
    return DEFAULT_COLS;
  });
  const setCols = (next: string[]) => {
    setColsState(next as ColKey[]);
    try { localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  };
  const go = (s: string, e?: string) => router.replace(`/chain?symbol=${encodeURIComponent(s)}${e ? `&expiry=${encodeURIComponent(e)}` : ''}`, { scroll: false });

  const c = chain.data;
  const head = (
    <header className="pt-head">
      <div className="pt-title">
        <h1>Option chain</h1>
        <p>{c ? <>{c.symbol} · {c.index ? 'Index' : c.sector} · Lot {fmt(c.lot, 0)} · {c.dte} days to {expShort(c.expiry)} expiry</> : symbol}</p>
      </div>
      {c && <span className="src-tag">{c.source === 'sample' ? 'Sample data' : 'Live'}</span>}
    </header>
  );
  if (chain.error && !c) return <main className="page pt">{head}<ApiNotice error={chain.error} retry={chain.retry} /></main>;
  if (!c) {
    return (
      <main className="page pt" aria-busy="true">
        {head}<Skeleton h={76} /><Skeleton h={44} /><Skeleton h={330} /><Skeleton h={520} />
      </main>
    );
  }

  const rows = range === 'all' ? c.rows : c.rows.filter((r) => Math.abs(r.strike - c.atmStrike) <= +range * c.step + 1e-6);
  const spotAt = rows.findIndex((r) => r.strike > c.spot);
  const maxOi = Math.max(1, ...rows.flatMap((r) => [r.call.oi, r.put.oi]));
  const compact = phone && side === 'both';
  const visible = COLS.filter((x) => (x.locked || cols.includes(x.key)) && (!compact || CORE.includes(x.key)));
  const callCols = side === 'puts' ? [] : visible;
  const putCols = side === 'calls' ? [] : [...visible].reverse();
  const span = callCols.length + putCols.length + 1;
  const symbolOpts = (syms.data?.symbols ?? [{ symbol: c.symbol, sector: c.sector }]).map((s) => ({ v: s.symbol, l: s.symbol, sub: s.sector }));
  const lo = rows[0]?.strike ?? 0, hi = rows[rows.length - 1]?.strike ?? 0;

  const cell = (type: OptType, r: ChainRow, k: ColKey) => {
    const s = type === 'CE' ? r.call : r.put;
    const itm = type === 'CE' ? r.strike < c.spot : r.strike > c.spot;
    const cls = `num${itm ? ' itm' : ''}`;
    switch (k) {
      case 'oi':
        return (
          <td key={k} className={`${cls} oi-c ${type === 'CE' ? 'oi-call' : 'oi-put'}`}>
            <span className="oi-bar" style={{ width: `${(s.oi / maxOi) * 100}%`, background: type === 'CE' ? CALL : PUT }} aria-hidden="true" />
            <span className="oi-v">{compact ? contracts(s.oi) : fmt(s.oi, 0)}</span>
          </td>
        );
      case 'chgOi': return <td key={k} className={cls}>{s.chgOi > 0 ? '+' : ''}{fmt(s.chgOi, 0)}</td>;
      case 'vol': return <td key={k} className={cls}>{fmt(s.vol, 0)}</td>;
      case 'iv': return <td key={k} className={cls}>{s.iv == null ? <span className="muted">—</span> : fmt(s.iv, 2)}</td>;
      case 'delta': return <td key={k} className={cls}>{fmt(s.delta, 2)}</td>;
      case 'chg': return <td key={k} className={cls}><span className={tone(s.chg)}>{pct(s.chg)}</span></td>;
      case 'ltp': {
        const o = chainOption(c, r, type);
        const done = !!executed[o.id];
        return (
          <td key={k} className={`${cls} ltp-c`}>
            <button type="button" className={`ltp${done ? ' done' : ''}`} onClick={() => setOpen(o)}
              aria-label={`${done ? 'Executed: ' : 'Check selling '}${c.symbol} ${fmt(r.strike, 0)} ${type} at ₹${fmt(s.ltp)}`}>
              {done && <Check size={13} aria-hidden="true" />}{fmt(s.ltp)}
            </button>
          </td>
        );
      }
    }
  };

  return (
    <main className="page pt">
      {head}

      <section className={`pt-stats${chain.loading ? ' is-loading' : ''}`} aria-label="Chain summary">
        <div><span className="st-l">{c.symbol} spot</span><span className="st-v">{fmt(c.spot)}<small className={tone(c.chg)}> {pct(c.chg)}</small></span></div>
        <div>
          <span className="st-l">Put-call ratio (OI)</span>
          <span className="st-v">{fmt(c.pcr, 2)}<small className="st-sub"> · puts {contracts(c.putOi)}, calls {contracts(c.callOi)}</small></span>
        </div>
        <div>
          <span className="st-l">Max pain</span>
          <span className="st-v">{fmt(c.maxPain, 0)}<small className="st-sub"> · {pct(((c.maxPain - c.spot) / c.spot) * 100)} from spot</small></span>
        </div>
        <div>
          <span className="st-l">ATM IV</span>
          <span className="st-v">{c.atmIv == null ? '—' : `${fmt(c.atmIv, 2)}%`}<small className="st-sub"> · futures {fmt(c.fut)}</small></span>
        </div>
      </section>

      <section className="pt-tools ch-tools" aria-label="Chain options">
        <SelectMenu label="Symbol" value={c.symbol} options={symbolOpts} onChange={(s) => go(s)} searchable />
        <SelectMenu label="Expiry" value={c.expiry} onChange={(e) => go(c.symbol, e)}
          options={c.expiries.map((e) => ({ v: e, l: expShort(e), sub: `${Math.max(0, daysTo(e))}d` }))} />
        <SelectMenu label="Strikes" value={range} options={RANGES} onChange={setRange} />
        <div className="seg2 seg-side" role="group" aria-label="Show">
          {(['both', 'calls', 'puts'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={side === v} onClick={() => setSide(v)}>{v === 'both' ? 'Both' : v === 'calls' ? 'Calls' : 'Puts'}</button>
          ))}
        </div>
        <ColumnsMenu columns={COLS} visible={cols} onChange={setCols} onReset={() => setCols(DEFAULT_COLS)} />
      </section>

      <section className="ch-card" aria-labelledby="h-oi">
        <header className="ch-head">
          <div>
            <h2 id="h-oi">{chartMode === 'oi' ? 'Open interest' : 'Change in open interest'} by strike</h2>
            <p>Calls and puts at each strike, in contracts. Dashed lines mark spot and max pain.</p>
          </div>
          <div className="seg2 seg-sm" role="group" aria-label="Measure">
            <button type="button" aria-pressed={chartMode === 'oi'} onClick={() => setChartMode('oi')}>Open interest</button>
            <button type="button" aria-pressed={chartMode === 'chg'} onClick={() => setChartMode('chg')}>Change</button>
          </div>
        </header>
        <OiByStrike rows={rows} spot={c.spot} maxPain={c.maxPain} mode={chartMode} />
        <Legend items={[['Calls', CALL], ['Puts', PUT]]} />
      </section>

      <section className="ch-card" aria-labelledby="h-3d">
        <header className="ch-head">
          <div>
            <h2 id="h-3d">Strike × expiry</h2>
            <p>All {surf.data?.expiries.length ?? ''} expiries at once, nearest in front. Drag sideways to turn it; hover for values.</p>
          </div>
          <div className="seg2 seg-sm" role="group" aria-label="3D measure">
            <button type="button" aria-pressed={mode3d === 'oi'} onClick={() => setMode3d('oi')}>Open interest</button>
            <button type="button" aria-pressed={mode3d === 'iv'} onClick={() => setMode3d('iv')}>IV smile</button>
          </div>
        </header>
        {surf.data && surf.data.symbol === c.symbol
          ? <Surface3D data={surf.data} mode={mode3d} range={[lo, hi]} height={phone ? 280 : 380} />
          : surf.error ? <ApiNotice error={surf.error} retry={surf.retry} /> : <Skeleton h={380} />}
      </section>

      <section className={`table-card chain-card side-${side}${chain.loading ? ' is-loading' : ''}`} aria-labelledby="h-chain">
        <header className="ch-head tc-pad">
          <div><h2 id="h-chain">Chain</h2><p>Shaded cells are in the money. Click a price to check selling that option.</p></div>
        </header>
        <div className="table-scroll">
          <table className="grid chain">
            <thead>
              <tr className="cs">
                {callCols.length > 0 && <th colSpan={callCols.length} className="cs-call"><span><i style={{ background: CALL }} />Calls</span></th>}
                <th className="cs-k" aria-hidden="true" />
                {putCols.length > 0 && <th colSpan={putCols.length} className="cs-put"><span><i style={{ background: PUT }} />Puts</span></th>}
              </tr>
              <tr>
                {callCols.map((x) => <th key={`c${x.key}`} className="num">{x.label}</th>)}
                <th className="num k">Strike</th>
                {putCols.map((x) => <th key={`p${x.key}`} className="num">{x.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={r.strike}>
                  {i === spotAt && (
                    <tr className="spot-row" aria-label={`Spot ${fmt(c.spot)}`}><td colSpan={span}><span>Spot {fmt(c.spot)}</span></td></tr>
                  )}
                  <tr className={r.strike === c.atmStrike ? 'atm' : ''}>
                    {callCols.map((x) => cell('CE', r, x.key))}
                    <td className="num k">
                      <b>{fmt(r.strike, Number.isInteger(r.strike) ? 0 : 2)}</b>
                      {r.strike === c.maxPain && <span className="k-tag">Max pain</span>}
                    </td>
                    {putCols.map((x) => cell('PE', r, x.key))}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="foot-note">
        {c.source === 'sample' ? 'Sample chain from the analytics server (derivs.py), not market prices. ' : ''}
        OI and volume are in contracts. The trade check estimates margin as strike × lot × {fmt(c.marginPct, 0)}%, the scanner’s rule.
      </p>

      {open && <TradeCheck option={open} onClose={() => setOpen(null)} />}
    </main>
  );
}
