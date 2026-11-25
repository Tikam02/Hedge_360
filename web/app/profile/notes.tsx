'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { NotebookPen, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { ApiNotice, Skeleton } from '@/components/charts';
import { api, type Note } from '@/lib/account';
import { useStore } from '@/lib/store';
import { DeleteBtn, SearchBox, matches, useList, when } from './shared';

/** Free-form notes: watchlists, rules, things to check. Pinned ones stay first. */
export function Notes() {
  const { showToast } = useStore();
  const list = useList<Note>('/api/notes');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [q, setQ] = useState('');
  // Same order as the server: pinned first, then the most recently changed.
  const shown = useMemo(() => (list.items ?? [])
    .filter((n) => matches(q, n.title, n.body))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)), [list.items, q]);

  if (list.error && !list.items) return <ApiNotice error={list.error} retry={list.load} />;
  if (!list.items) return <Skeleton h={320} />;

  const pin = async (n: Note) => {
    try { list.put(await api<Note>(`/api/notes/${n.id}`, { method: 'PATCH', body: { pinned: !n.pinned } })); }
    catch (e) { showToast((e as Error).message); }
  };

  return (
    <div className="pf-tab">
      <div className="pf-tools">
        <SearchBox value={q} onChange={setQ} label="Search notes" />
        {editing !== 'new' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> New note</button>}
      </div>

      {editing === 'new' && (
        <NoteForm initial={{ title: '', body: '' }} onCancel={() => setEditing(null)}
          onSave={async (body) => { list.put(await api<Note>('/api/notes', { method: 'POST', body })); setEditing(null); showToast('Note added.'); }} />
      )}

      {list.items.length === 0 && editing !== 'new' ? (
        <div className="pf-empty">
          <NotebookPen size={26} aria-hidden="true" />
          <h3>No notes yet</h3>
          <p>Keep a watchlist, your own rules for adjusting a hedge, or anything to check before the open.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> Write a note</button>
        </div>
      ) : shown.length === 0 && q ? (
        <p className="pf-none">No notes match “{q}”.</p>
      ) : (
        <ul className="nt-grid">
          {shown.map((n) => (
            <li key={n.id} className={editing === n.id ? 'wide' : ''}>
              {editing === n.id ? (
                <NoteForm initial={{ title: n.title, body: n.body }} onCancel={() => setEditing(null)}
                  onSave={async (body) => { list.put(await api<Note>(`/api/notes/${n.id}`, { method: 'PATCH', body })); setEditing(null); showToast('Note saved.'); }} />
              ) : (
                <article className={`nt-card${n.pinned ? ' pinned' : ''}`}>
                  <header>
                    <h3>{n.title || 'Untitled'}</h3>
                    <button type="button" className="nt-pin" onClick={() => pin(n)} aria-pressed={n.pinned} aria-label={n.pinned ? `Unpin ${n.title || 'note'}` : `Pin ${n.title || 'note'}`} title={n.pinned ? 'Unpin' : 'Pin to the top'}>
                      {n.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
                    </button>
                  </header>
                  {n.body && <p>{n.body}</p>}
                  <footer>
                    <small>Edited {when(n.updatedAt)}</small>
                    <span className="jr-acts">
                      <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(n.id)}><Pencil size={15} aria-hidden="true" /> Edit</button>
                      <DeleteBtn what={`“${n.title || 'note'}”`} onDelete={async () => { await api(`/api/notes/${n.id}`, { method: 'DELETE' }); list.drop(n.id); showToast('Note deleted.'); }} />
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

function NoteForm({ initial, onSave, onCancel }: { initial: { title: string; body: string }; onSave: (b: { title: string; body: string }) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() && !body.trim()) { setErr('Write something first.'); return; }
    setBusy(true); setErr(null);
    try { await onSave({ title: title.trim(), body }); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <form className="ch-card nt-form" onSubmit={submit}>
      <div className="field"><label htmlFor="nt-title">Title</label>
        <input id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Expiry-day checklist" autoFocus /></div>
      <div className="field"><label htmlFor="nt-body">Note</label>
        <textarea id="nt-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={50000} /></div>
      {err && <p className="pf-msg bad" role="alert">{err}</p>}
      <div className="pf-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save note'}</button>
        <button type="button" className="btn btn-text btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
