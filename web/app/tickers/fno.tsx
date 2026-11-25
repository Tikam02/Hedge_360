'use client';
import { useMemo, useState } from 'react';
import { ApiNotice, Skeleton } from '@/components/charts';
import { expShort, type ApiState, type FnoResp } from '@/lib/derivs';
import { dayLabel, matches, SearchBox } from '../profile/shared';

/**
 * The F&O stock list from Kite's instrument list: stocks are its EQ rows in segment NSE that have contracts in
 * NFO-FUT / NFO-OPT. Leaving means NSE has stopped adding contracts; joins and exits are what changed between days.
 */
export function FnoList({ api: { data, error, retry } }: { api: ApiState<FnoResp> }) {
  const [q, setQ] = useState('');
  const all = data?.stocks;
  const shown = useMemo(() => (all ?? []).filter((s) => matches(q, s.symbol, s.sector)), [all, q]);
  if (!data) return error ? <ApiNotice error={error} retry={retry} /> : <Skeleton h={420} />;

  const live = data.source === 'live';
  const leaving = data.stocks.filter((s) => s.leaving);
  const joined = data.changes.filter((c) => c.change === 'in').length;
  const left = data.changes.length - joined;
  const common = data.stocks.find((s) => !s.leaving)?.lastExpiry;

  return (
    <div className="pf-tab tk-fno">
      <section className="pf-stats" aria-label="F&O list summary">
        <div><span>Stocks in F&amp;O</span><b>{data.stocks.length}</b></div>
        <div><span>Leaving</span><b className={leaving.length ? 'warn' : ''}>{leaving.length}</b></div>
        <div><span>Joined · left</span><b>{live ? `${joined} · ${left}` : '—'}</b></div>
        <div><span>Tracked since</span><b>{data.trackedSince ? dayLabel(data.trackedSince) : '—'}</b></div>
      </section>
      <p className="pf-hint tk-src">{live
        ? 'From today’s Kite instrument list: a stock is in F&O when it has futures (FUT in NFO-FUT) or options (CE / PE in NFO-OPT) and an NSE EQ row. The list is compared with the last day seen each morning.'
        : 'Sample data. Log in to Zerodha on Profile for today’s list from Kite and the joins and exits seen each day.'}</p>

      <section className="ch-card" aria-labelledby="h-leaving">
        <h2 id="h-leaving" className="pf-h3">Leaving F&amp;O</h2>
        {leaving.length ? (
          <>
            <p className="pf-hint">NSE has stopped adding contracts for these: nothing expires after the date shown, while the rest run to {common ? expShort(common) : 'later months'}. They drop out of F&amp;O after that expiry.</p>
            <ul className="tk-chips">
              {leaving.map((s) => <li key={s.symbol}><b>{s.symbol}</b> <span>last expiry {expShort(s.lastExpiry)}</span></li>)}
            </ul>
          </>
        ) : <p className="pf-none">None. Every stock has contracts up to {common ? expShort(common) : 'the same month'}.</p>}
      </section>

      <section className="ch-card" aria-labelledby="h-changes">
        <h2 id="h-changes" className="pf-h3">Joined and left</h2>
        {data.changes.length ? (
          <ul className="tk-log">
            {data.changes.map((c) => (
              <li key={`${c.day}-${c.symbol}`}>
                <span className="tk-date">{dayLabel(c.day)}</span>
                <span className={`tk-tag ${c.change === 'in' ? '' : 'out'}`}>{c.change === 'in' ? 'Joined' : 'Left'}</span>
                <b>{c.symbol}</b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pf-none">{live
            ? `No changes seen${data.trackedSince ? ` since ${dayLabel(data.trackedSince)}` : ''}. The first day sets the list; a stock that appears in or drops out of Kite’s list after that shows here.`
            : 'Nothing to compare in the sample.'}</p>
        )}
      </section>

      {data.unmatched.length > 0 && (
        <p className="pf-warn">Left out: {data.unmatched.join(', ')}. Kite lists F&amp;O contracts for {data.unmatched.length === 1 ? 'it' : 'them'} but no NSE stock (EQ) or index (INDICES) row.</p>
      )}

      <section className="table-card" aria-labelledby="h-all">
        <header className="ch-head tc-pad">
          <div><h2 id="h-all">All F&amp;O stocks</h2><p>Index F&amp;O as well: {data.indices.join(', ') || 'none'}.</p></div>
          <SearchBox value={q} onChange={setQ} label="Search stocks or sectors" />
        </header>
        <div className="table-scroll tk-scroll">
          <table className="grid tk-table">
            <thead><tr><th>Stock</th><th>Sector</th><th className="num">Lot</th><th>Last expiry</th><th>Status</th>{live && <th>In list since</th>}</tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.symbol}>
                  <td><b>{s.symbol}</b></td>
                  <td>{s.sector}</td>
                  <td className="num">{s.lot.toLocaleString('en-IN')}</td>
                  <td className="tk-date">{expShort(s.lastExpiry)}</td>
                  <td>{s.leaving ? <span className="tk-tag warn">Leaving</span> : <span className="tk-tag">In</span>}</td>
                  {live && <td className="tk-date">{s.since ? dayLabel(s.since) : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="pf-none tk-pad">No stock matches “{q}”.</p>}
        </div>
      </section>
    </div>
  );
}
