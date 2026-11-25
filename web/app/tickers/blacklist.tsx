'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Ban, Plus } from 'lucide-react';
import { ApiNotice, Skeleton } from '@/components/charts';
import { api, type Blacklisted } from '@/lib/account';
import type { FnoResp } from '@/lib/derivs';
import { useStore } from '@/lib/store';
import { dayLabel } from '../profile/shared';
import { FnoTag, SYMBOL_RE, SymbolInput, cleanSymbol, stockMap } from './shared';

/** Stocks this account keeps off the Screener, each with an optional reason. */
export function Blacklist({ fno }: { fno: FnoResp | null }) {
  const { showToast } = useStore();
  const stocks = useMemo(() => stockMap(fno), [fno]);
  const [items, setItems] = useState<Blacklisted[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api<Blacklisted[]>('/api/tickers/blacklist').then(setItems).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const [symbol, setSymbol] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (error && !items) return <ApiNotice error={error} retry={load} />;
  if (!items) return <Skeleton h={320} />;

  const sym = cleanSymbol(symbol);
  const known = items.find((x) => x.symbol === sym);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!SYMBOL_RE.test(sym)) { setErr('Type a stock symbol, such as RELIANCE or M&M.'); return; }
    setBusy(true); setErr(null);
    try {
      const x = await api<Blacklisted>(`/api/tickers/blacklist/${encodeURIComponent(sym)}`, { method: 'PUT', body: { reason: reason.trim() } });
      setItems((xs) => [...(xs ?? []).filter((y) => y.symbol !== x.symbol), x].sort((a, b) => a.symbol.localeCompare(b.symbol)));
      setSymbol(''); setReason('');
      showToast(known ? `${x.symbol}: reason updated.` : `${x.symbol} is blacklisted. The Screener leaves it out.`);
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  const remove = async (x: Blacklisted) => {
    try {
      await api(`/api/tickers/blacklist/${encodeURIComponent(x.symbol)}`, { method: 'DELETE' });
      setItems((xs) => xs?.filter((y) => y.symbol !== x.symbol) ?? null);
      showToast(`${x.symbol} is back on the Screener.`);
    } catch (e) { showToast((e as Error).message); }
  };

  return (
    <div className="pf-tab">
      <form className="ch-card tk-add" onSubmit={add} aria-label="Add a stock to the blacklist">
        <div className="field tk-sym"><label htmlFor="bl-sym">Stock</label>
          <SymbolInput id="bl-sym" value={symbol} onChange={setSymbol} stocks={stocks} /></div>
        <div className="field tk-why"><label htmlFor="bl-why">Reason <small>(optional)</small></label>
          <input id="bl-why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Results on 12 Dec, gaps a lot" /></div>
        <button type="submit" className="btn btn-primary" disabled={busy || !sym}>
          <Plus size={16} aria-hidden="true" /> {known ? 'Update reason' : 'Blacklist'}
        </button>
        {sym && stocks.size > 0 && !stocks.has(sym) && SYMBOL_RE.test(sym) && <p className="pf-hint tk-full">{sym} isn’t in today’s F&amp;O list, so it has no options on the Screener anyway.</p>}
        {err && <p className="pf-msg bad tk-full" role="alert">{err}</p>}
      </form>

      {items.length === 0 ? (
        <div className="pf-empty">
          <Ban size={26} aria-hidden="true" />
          <h3>No blacklisted stocks</h3>
          <p>Add a stock you never want to write options on, for example one with results due or one that gaps often. The Screener will leave it out until you remove it.</p>
        </div>
      ) : (
        <section className="table-card" aria-label="Blacklisted stocks">
          <div className="table-scroll">
            <table className="grid tk-table">
              <thead><tr><th>Stock</th><th>Reason</th><th className="tk-added">Added</th><th><span className="sr">Remove</span></th></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.symbol}>
                    <td><span className="tk-symcell"><b>{x.symbol}</b><FnoTag symbol={x.symbol} stocks={stocks} /></span></td>
                    <td className="tk-reason">{x.reason || <span className="tk-none">No reason given</span>}</td>
                    <td className="tk-date tk-added">{dayLabel(x.addedAt)}</td>
                    <td className="num"><button type="button" className="btn btn-text btn-sm" onClick={() => remove(x)} aria-label={`Remove ${x.symbol} from the blacklist`}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
