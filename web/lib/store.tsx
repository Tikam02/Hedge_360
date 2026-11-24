'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { POSITIONS, type Leg, type Position } from './data';
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
const KEY = 'kavach.v4';

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
  const [s, setS] = useState<State>(EMPTY);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setS({ ...EMPTY, ...JSON.parse(raw) });
      else {
        // v4 swapped in a new sample book, so trades and hedges saved against the old one are dropped; the profile carries over.
        const old = localStorage.getItem('kavach.v3') ?? localStorage.getItem('kavach.v2');
        if (old) { const o = JSON.parse(old); setS({ ...EMPTY, profile: o.profile ?? EMPTY.profile, suggestMode: o.suggestMode ?? EMPTY.suggestMode }); }
      }
    } catch { /* storage blocked */ }
    setReady(true);
  }, []);
  useEffect(() => { if (ready) try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ } }, [s, ready]);

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
