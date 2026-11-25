'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { NotebookPen, Pencil, Plus } from 'lucide-react';
import { ApiNotice, Skeleton } from '@/components/charts';
import { api, type StockNote } from '@/lib/account';
import type { FnoResp } from '@/lib/derivs';
import { useStore } from '@/lib/store';
import { DeleteBtn, SearchBox, matches, useList, when } from '../profile/shared';
import { FnoTag, SYMBOL_RE, SymbolInput, cleanSymbol, stockMap } from './shared';

/** Notes on stocks, newest first; a stock can have several. */
export function StockNotes({ fno }: { fno: FnoResp | null }) {
  const { showToast } = useStore();
  const stocks = useMemo(() => stockMap(fno), [fno]);
  const list = useList<StockNote>('/api/tickers/notes');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('');
  const symbols = useMemo(() => [...new Set((list.items ?? []).map((n) => n.symbol))].sort(), [list.items]);
  const shown = useMemo(() => (list.items ?? [])
    .filter((n) => (!only || n.symbol === only) && matches(q, n.symbol, n.body))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [list.items, q, only]);

  if (list.error && !list.items) return <ApiNotice error={list.error} retry={list.load} />;
  if (!list.items) return <Skeleton h={320} />;

  return (
    <div className="pf-tab">
      <div className="pf-tools">
        <div className="pf-row">
          <SearchBox value={q} onChange={setQ} label="Search notes" />
          {symbols.length > 1 && (
            <label className="tk-only"><span className="sr">Show notes on</span>
              <select value={only} onChange={(e) => setOnly(e.target.value)}>
                <option value="">All stocks</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
        </div>
        {editing !== 'new' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> New note</button>}
      </div>

      {editing === 'new' && (
        <NoteForm initial={{ symbol: only, body: '' }} stocks={stocks} onCancel={() => setEditing(null)}
          onSave={async (body) => { list.put(await api<StockNote>('/api/tickers/notes', { method: 'POST', body })); setEditing(null); showToast(`Note on ${body.symbol} added.`); }} />
      )}

      {list.items.length === 0 && editing !== 'new' ? (
        <div className="pf-empty">
          <NotebookPen size={26} aria-hidden="true" />
          <h3>No stock notes yet</h3>
          <p>Note a results date, a corporate action, news, or how a stock moves around expiry. Each note is kept with its stock.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> Write a note</button>
        </div>
      ) : shown.length === 0 && (q || only) ? (
        <p className="pf-none">No notes match{q ? ` “${q}”` : ''}{only ? ` on ${only}` : ''}.</p>
      ) : (
        <ul className="nt-grid">
          {shown.map((n) => (
            <li key={n.id} className={editing === n.id ? 'wide' : ''}>
              {editing === n.id ? (
                <NoteForm initial={{ symbol: n.symbol, body: n.body }} stocks={stocks} onCancel={() => setEditing(null)}
                  onSave={async (body) => { list.put(await api<StockNote>(`/api/tickers/notes/${n.id}`, { method: 'PATCH', body })); setEditing(null); showToast('Note saved.'); }} />
              ) : (
                <article className="nt-card">
                  <header>
                    <h3><button type="button" className="tk-symbtn" onClick={() => setOnly(only === n.symbol ? '' : n.symbol)} title={only === n.symbol ? 'Show every stock' : `Only notes on ${n.symbol}`}>{n.symbol}</button></h3>
                    <FnoTag symbol={n.symbol} stocks={stocks} />
                  </header>
                  <p>{n.body}</p>
                  <footer>
                    <small>Edited {when(n.updatedAt)}</small>
                    <span className="jr-acts">
                      <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(n.id)}><Pencil size={15} aria-hidden="true" /> Edit</button>
                      <DeleteBtn what={`the note on ${n.symbol}`} onDelete={async () => { await api(`/api/tickers/notes/${n.id}`, { method: 'DELETE' }); list.drop(n.id); showToast('Note deleted.'); }} />
                    </span>
                  </footer>
                </article>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteForm({ initial, stocks, onSave, onCancel }: {
  initial: { symbol: string; body: string }; stocks: ReturnType<typeof stockMap>;
  onSave: (b: { symbol: string; body: string }) => Promise<void>; onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState(initial.symbol);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const sym = cleanSymbol(symbol);
    if (!SYMBOL_RE.test(sym)) { setErr('Type a stock symbol, such as RELIANCE or M&M.'); return; }
    if (!body.trim()) { setErr('Write the note first.'); return; }
    setBusy(true); setErr(null);
    try { await onSave({ symbol: sym, body: body.trim() }); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <form className="ch-card nt-form" onSubmit={submit}>
      <div className="field tk-sym"><label htmlFor="sn-sym">Stock</label>
        <SymbolInput id="sn-sym" value={symbol} onChange={setSymbol} stocks={stocks} autoFocus={!initial.symbol} /></div>
      <div className="field"><label htmlFor="sn-body">Note</label>
        <textarea id="sn-body" rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} autoFocus={!!initial.symbol}
          placeholder="Results on 12 Dec. IV usually climbs the week before." /></div>
      {err && <p className="pf-msg bad" role="alert">{err}</p>}
      <div className="pf-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save note'}</button>
        <button type="button" className="btn btn-text btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
