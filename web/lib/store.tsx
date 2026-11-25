'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { POSITIONS, type Leg, type Position } from './data';
import { STATIC } from './derivs';
import { api, useAccount, type User } from './account';
import type { Appetite } from './util';
import type { SuggestMode } from './suggest';

export type TimeAvail = 'weekly' | '30m' | '2h' | 'full';
export interface Profile { capital: number | null; time: TimeAvail | null; appetite: Appetite | null; done: boolean }
export interface HedgeRecord { at: string; lots: number | null; legs: Leg[]; result?: string }

interface State {
  profile: Profile;
  executed: Record<string, string>; // optionId → positionId
  hedged: Record<string, HedgeRecord>;
  added: Position[];
  suggestMode: SuggestMode;
}

const EMPTY: State = { profile: { capital: null, time: null, appetite: null, done: false }, executed: {}, hedged: {}, added: [], suggestMode: 'appetite' };
/**
 * The demo book (executed trades, hedges, added positions) lives in this browser under KEY:<account id>. The trading
 * profile belongs to the account and is saved on the server; the Pages demo has no accounts and keeps it all under KEY.
 * Before accounts the state sat under KEY alone: the first account to sign in here takes it over, profile included
 * if that account hasn't set one up yet.
 */
const KEY = 'kavach.v4';

function readLocal(key: string): Partial<State> | null {
  const raw = localStorage.getItem(key);
  if (raw) return JSON.parse(raw);
  if (key !== KEY) return null;
  // v4 swapped in a new sample book, so trades and hedges saved against the old one are dropped; the profile carries over.
  const old = localStorage.getItem('kavach.v3') ?? localStorage.getItem('kavach.v2');
  if (!old) return null;
  const o = JSON.parse(old);
  return { profile: o.profile ?? EMPTY.profile, suggestMode: o.suggestMode ?? EMPTY.suggestMode };
}

interface Ctx extends State {
  ready: boolean;
  positions: Position[];
  setProfile: (p: Partial<Profile>) => void;
  executeOption: (optionId: string, pos: Omit<Position, 'id'>, hedgeNow: boolean) => string;
  placeHedge: (posId: string, lots: number | null, legs: Leg[], result: string) => void;
  setSuggestMode: (m: SuggestMode) => void;
  removeHedge: (posId: string) => void;
  resetDemo: () => void;
  toast: string | null;
  showToast: (m: string) => void;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user, ready: signedInChecked, setUser } = useAccount();
  const [s, setS] = useState<State>(EMPTY);
  /** Whose state is loaded: 'local' in the Pages demo, else the account id. */
  const [loaded, setLoaded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const owner = STATIC ? 'local' : user ? String(user.id) : null;
  const key = owner === 'local' ? KEY : `${KEY}:${owner}`;
  const ready = owner !== null && loaded === owner;
  /** The profile as the server last had it, so only real changes are saved. */
  const sent = useRef('');
  const save = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!signedInChecked || owner === null) { setLoaded(null); return; }
    let next: State = EMPTY;
    try {
      const mine = readLocal(key);
      const legacy = owner !== 'local' && !mine ? readLocal(KEY) : null;
      next = { ...EMPTY, ...(mine ?? legacy ?? {}) };
      if (legacy) localStorage.removeItem(KEY);
      if (user) next.profile = legacy?.profile?.done && !user.profile.done ? legacy.profile : user.profile;
    } catch {
      if (user) next = { ...EMPTY, profile: user.profile }; // storage blocked
    }
    sent.current = user ? JSON.stringify(user.profile) : '';
    setS(next);
    setLoaded(owner);
    // Load once per account; later changes to `user` come from this store's own saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInChecked, owner]);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(key, JSON.stringify(owner === 'local' ? s : { ...s, profile: undefined })); } catch { /* storage blocked */ }
  }, [s, ready, key, owner]);

  // Profile changes go to the server shortly after the last one (onboarding saves on every keystroke), and at once
  // if the page is closing.
  useEffect(() => {
    if (!ready || STATIC) return;
    const body = JSON.stringify(s.profile);
    if (body === sent.current) return;
    const push = (keepalive = false) => {
      if (save.current) clearTimeout(save.current);
      save.current = null;
      sent.current = body;
      api<User>('/api/me/profile', { method: 'PUT', body: s.profile, keepalive }).then(setUser).catch(() => { sent.current = ''; });
    };
    save.current = setTimeout(push, 400);
    const onHide = () => push(true);
    window.addEventListener('pagehide', onHide);
    return () => { window.removeEventListener('pagehide', onHide); if (save.current) clearTimeout(save.current); };
  }, [s.profile, ready, setUser]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const now = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const value = useMemo<Ctx>(() => ({
    ...s,
    ready,
    toast,
    showToast,
    positions: [...s.added, ...POSITIONS],
    setProfile: (p) => setS((x) => ({ ...x, profile: { ...x.profile, ...p } })),
    executeOption: (optionId, pos, hedgeNow) => {
      const id = 'n' + Date.now();
      setS((x) => ({
        ...x,
        added: [{ ...pos, id, fresh: true }, ...x.added],
        executed: { ...x.executed, [optionId]: id },
        hedged: hedgeNow ? { ...x.hedged, [id]: { at: now(), lots: pos.lot ? Math.abs(pos.qty) / pos.lot : null, legs: pos.legs, result: pos.result } } : x.hedged,
      }));
      return id;
    },
    placeHedge: (posId, lots, legs, result) => setS((x) => ({ ...x, hedged: { ...x.hedged, [posId]: { at: now(), lots, legs, result } } })),
    setSuggestMode: (m) => setS((x) => ({ ...x, suggestMode: m })),
    removeHedge: (posId) => setS((x) => { const h = { ...x.hedged }; delete h[posId]; return { ...x, hedged: h }; }),
    resetDemo: () => setS((x) => ({ ...EMPTY, profile: x.profile, suggestMode: x.suggestMode })),
  }), [s, ready, toast, showToast]);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('useStore outside StoreProvider');
  return c;
}
