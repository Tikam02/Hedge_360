'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { BookOpen, Pencil, Plus } from 'lucide-react';
import { ApiNotice, Skeleton } from '@/components/charts';
import { api, type JournalEntry, type Outcome } from '@/lib/account';
import { useStore } from '@/lib/store';
import { fmt, inr } from '@/lib/util';
import { DeleteBtn, SearchBox, dayLabel, matches, todayIst, useList } from './shared';

const OUTCOME: Record<Outcome, string> = { profit: 'Profit', loss: 'Loss', breakeven: 'Break-even' };

interface Draft { date: string; title: string; symbol: string; outcome: Outcome | ''; pnl: string; body: string; tags: string }
const blank = (): Draft => ({ date: todayIst(), title: '', symbol: '', outcome: '', pnl: '', body: '', tags: '' });
const toDraft = (e: JournalEntry): Draft => ({
  date: e.date, title: e.title, symbol: e.symbol ?? '', outcome: e.outcome ?? '', pnl: e.pnl == null ? '' : String(e.pnl), body: e.body, tags: e.tags.join(', '),
});

/** "−12,500" or "12500.50" → number; '' → null; anything else → NaN. */
const parsePnl = (s: string) => {
  const t = s.replace(/[,₹\s]/g, '').replace('−', '-');
  return t === '' ? null : /^-?\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
};

/** Trade journal: what was traded, why, and how it went. Kept per account on the server. */
export function Journal() {
  const { showToast } = useStore();
  const list = useList<JournalEntry>('/api/journal');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [q, setQ] = useState('');

  const shown = useMemo(() => (list.items ?? []).filter((e) => matches(q, e.title, e.symbol, e.body, e.tags)), [list.items, q]);
  const stats = useMemo(() => {
    const xs = list.items ?? [];
    const wins = xs.filter((e) => e.outcome === 'profit').length, losses = xs.filter((e) => e.outcome === 'loss').length;
    const withPnl = xs.filter((e) => e.pnl != null);
    return { n: xs.length, wins, losses, pnl: withPnl.reduce((a, e) => a + (e.pnl ?? 0), 0), hasPnl: withPnl.length > 0, rate: wins + losses ? (wins / (wins + losses)) * 100 : null };
  }, [list.items]);

  if (list.error && !list.items) return <ApiNotice error={list.error} retry={list.load} />;
  if (!list.items) return <Skeleton h={360} />;

  return (
    <div className="pf-tab">
      <section className="pf-stats" aria-label="Journal summary">
        <div><span>Entries</span><b>{stats.n}</b></div>
        <div><span>Wins · losses</span><b>{stats.wins} · {stats.losses}</b></div>
        <div><span>Win rate</span><b>{stats.rate == null ? '—' : `${fmt(stats.rate, 0)}%`}</b></div>
        <div><span>Recorded P&amp;L</span><b className={stats.pnl > 0 ? 'up' : stats.pnl < 0 ? 'down' : ''}>{stats.hasPnl ? inr(stats.pnl, 0) : '—'}</b></div>
      </section>

      <div className="pf-tools">
        <SearchBox value={q} onChange={setQ} label="Search entries, symbols, tags" />
        {editing !== 'new' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> New entry</button>}
      </div>

      {editing === 'new' && (
        <EntryForm initial={blank()} onCancel={() => setEditing(null)}
          onSave={async (body) => { list.put(await api<JournalEntry>('/api/journal', { method: 'POST', body })); setEditing(null); showToast('Journal entry added.'); }} />
      )}

      {list.items.length === 0 && editing !== 'new' ? (
        <div className="pf-empty">
          <BookOpen size={26} aria-hidden="true" />
          <h3>No journal entries yet</h3>
          <p>Write down each trade: why you took it, the hedge you used, and what you’d do differently. Patterns show up after a few weeks.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> Write the first entry</button>
        </div>
      ) : shown.length === 0 && q ? (
        <p className="pf-none">No entries match “{q}”.</p>
      ) : (
        <ol className="jr-list">
          {shown.map((e) => (
            <li key={e.id}>
              {editing === e.id ? (
                <EntryForm initial={toDraft(e)} onCancel={() => setEditing(null)}
                  onSave={async (body) => { list.put(await api<JournalEntry>(`/api/journal/${e.id}`, { method: 'PATCH', body })); setEditing(null); showToast('Journal entry saved.'); }} />
              ) : (
                <article className="jr-item">
                  <header className="jr-top">
                    <time dateTime={e.date}>{dayLabel(e.date)}</time>
                    {e.symbol && <span className="jr-sym">{e.symbol}</span>}
                    {e.outcome && <span className={`jr-out ${e.outcome}`}>{OUTCOME[e.outcome]}</span>}
                    {e.pnl != null && <b className={`jr-pnl ${e.pnl > 0 ? 'up' : e.pnl < 0 ? 'down' : ''}`}>{e.pnl > 0 ? '+' : ''}{inr(e.pnl, 0)}</b>}
                  </header>
                  <h3>{e.title}</h3>
                  {e.body && <p className="jr-body">{e.body}</p>}
                  <footer className="jr-foot">
                    {e.tags.length > 0 && <ul className="jr-tags" aria-label="Tags">{e.tags.map((t) => <li key={t}>{t}</li>)}</ul>}
                    <span className="jr-acts">
                      <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(e.id)}><Pencil size={15} aria-hidden="true" /> Edit</button>
                      <DeleteBtn what={`“${e.title}”`} onDelete={async () => { await api(`/api/journal/${e.id}`, { method: 'DELETE' }); list.drop(e.id); showToast('Journal entry deleted.'); }} />
                    </span>
                  </footer>
                </article>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EntryForm({ initial, onSave, onCancel }: { initial: Draft; onSave: (body: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const pnl = parsePnl(d.pnl);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!d.title.trim()) { setErr('Give the entry a title.'); return; }
    if (Number.isNaN(pnl)) { setErr('Write the P&L as a number, like 4500 or -1200.'); return; }
    setBusy(true); setErr(null);
    try {
      await onSave({ date: d.date || todayIst(), title: d.title.trim(), symbol: d.symbol.trim(), outcome: d.outcome, pnl, body: d.body, tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean) });
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  };

  return (
    <form className="jr-form ch-card" onSubmit={submit}>
      <div className="jr-grid">
        <div className="field jr-title"><label htmlFor="jr-title">Title</label>
          <input id="jr-title" value={d.title} onChange={set('title')} maxLength={200} placeholder="Sold NIFTY 24,000 PE, hedged with a 23,600 PE" autoFocus /></div>
        <div className="field"><label htmlFor="jr-date">Date</label><input id="jr-date" type="date" value={d.date} onChange={set('date')} /></div>
        <div className="field"><label htmlFor="jr-sym">Symbol <small className="muted">optional</small></label>
          <input id="jr-sym" value={d.symbol} onChange={set('symbol')} maxLength={40} placeholder="NIFTY" autoCapitalize="characters" spellCheck={false} /></div>
        <div className="field"><label htmlFor="jr-out">Outcome</label>
          <select id="jr-out" value={d.outcome} onChange={set('outcome')}>
            <option value="">Open or not set</option>
            {(Object.keys(OUTCOME) as Outcome[]).map((o) => <option key={o} value={o}>{OUTCOME[o]}</option>)}
          </select></div>
        <div className="field"><label htmlFor="jr-pnl">P&amp;L (₹) <small className="muted">optional</small></label>
          <input id="jr-pnl" inputMode="decimal" value={d.pnl} onChange={set('pnl')} placeholder="-1,200" aria-invalid={Number.isNaN(pnl) || undefined} /></div>
      </div>
      <div className="field"><label htmlFor="jr-body">Notes</label>
        <textarea id="jr-body" rows={5} value={d.body} onChange={set('body')} maxLength={50000} placeholder="Why you took it, the plan, what happened, what you'd change." /></div>
      <div className="field"><label htmlFor="jr-tags">Tags <small className="muted">comma separated</small></label>
        <input id="jr-tags" value={d.tags} onChange={set('tags')} placeholder="expiry day, hedged, rule break" /></div>
      {err && <p className="pf-msg bad" role="alert">{err}</p>}
      <div className="pf-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save entry'}</button>
        <button type="button" className="btn btn-text btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
