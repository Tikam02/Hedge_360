'use client';
import { useCallback, useEffect, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import { api } from '@/lib/account';

/** A list from the server (notes, journal) that the tab edits in place after each save. */
export function useList<T extends { id: number }>(path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api<T[]>(path).then(setItems).catch((e: Error) => setError(e.message));
  }, [path]);
  useEffect(load, [load]);
  const put = (x: T) => setItems((xs) => (xs ? (xs.some((y) => y.id === x.id) ? xs.map((y) => (y.id === x.id ? x : y)) : [x, ...xs]) : [x]));
  const drop = (id: number) => setItems((xs) => xs?.filter((y) => y.id !== id) ?? null);
  return { items, error, load, put, drop };
}

/** Delete with a second click: the button turns into "Delete? Yes / No" first. */
export function DeleteBtn({ what, onDelete }: { what: string; onDelete: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <button type="button" className="btn btn-text btn-sm pf-del" onClick={() => setAsking(true)} aria-label={`Delete ${what}`}><Trash2 size={15} aria-hidden="true" /> Delete</button>;
  return (
    <span className="pf-ask" role="group" aria-label={`Delete ${what}?`}>
      <span>Delete?</span>
      <button type="button" className="btn btn-ghost btn-sm pf-danger" disabled={busy} autoFocus
        onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); setAsking(false); } }}>Yes, delete</button>
      <button type="button" className="btn btn-text btn-sm" onClick={() => setAsking(false)}>Keep</button>
    </span>
  );
}

export function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="pt-search pf-search">
      <Search size={18} aria-hidden="true" />
      <input type="search" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} autoComplete="off" />
      {value && <button type="button" aria-label="Clear search" onClick={() => onChange('')}><X size={16} /></button>}
    </label>
  );
}

export const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export const dayLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const matches = (q: string, ...fields: Array<string | null | undefined | string[]>) => {
  const t = q.trim().toLowerCase();
  return !t || fields.some((f) => (Array.isArray(f) ? f.join(' ') : f ?? '').toLowerCase().includes(t));
};
