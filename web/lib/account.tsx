'use client';
// Hedge 360 accounts on the analytics server (../accounts.py): email and password sign-in, kept by an HttpOnly
// session cookie the browser sends with every API call, and each account's trading profile, picture, notes and
// journal in PostgreSQL. The Pages demo has no server and so no accounts: with STATIC set there is no sign-in and
// the trading profile stays in this browser (lib/store.tsx).
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AUTH_LOST, DERIVS_API, STATIC } from './derivs';
import type { Profile } from './store';

export const SERVER = DERIVS_API.replace(/\/api\/derivs\/?$/, '');

/** GET /api/auth/me */
export interface User {
  id: number; email: string; name: string; createdAt: string;
  /** Path on the server, changing with each new picture; absent until one is uploaded. */
  avatar: string | null;
  profile: Profile;
}
export interface Note { id: number; title: string; body: string; pinned: boolean; createdAt: string; updatedAt: string }
/** A stock this account keeps off the Screener (Ticker Data). */
export interface Blacklisted { symbol: string; reason: string; addedAt: string }
export interface StockNote { id: number; symbol: string; body: string; createdAt: string; updatedAt: string }
export type Outcome = 'profit' | 'loss' | 'breakeven';
export interface JournalEntry {
  id: number; date: string; title: string; symbol: string | null; outcome: Outcome | null; pnl: number | null;
  body: string; tags: string[]; createdAt: string; updatedAt: string;
}

export const avatarUrl = (u: Pick<User, 'avatar'> | null) => (u?.avatar ? `${SERVER}${u.avatar}` : null);
export const initials = (name: string, email = '') =>
  (name.trim() ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') : email.slice(0, 1)).toUpperCase() || '?';

/**
 * JSON call to the server with the session cookie. Throws an Error with the server's message, or 'offline' when it
 * can't be reached. A 401 outside /api/auth means the session ended: the account context checks it again.
 */
export async function api<T>(path: string, init?: { method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; blob?: Blob; keepalive?: boolean }): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${SERVER}${path}`, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      keepalive: init?.keepalive,
      headers: init?.blob ? { 'Content-Type': init.blob.type } : init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.blob ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
  } catch {
    throw new Error('offline');
  }
  if (r.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(AUTH_LOST));
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    const detail = d?.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((x) => x.msg).join('; ') : `The server answered ${r.status}`);
  }
  return r.json() as Promise<T>;
}

interface Ctx {
  /** Null while signed out, and always in the Pages demo. */
  user: User | null;
  /** The first session check has finished. */
  ready: boolean;
  /** Why the session couldn't be checked: 'offline', or the server's message (say, the database is down). */
  error: string | null;
  signIn: (email: string, password: string) => Promise<User>;
  signUp: (email: string, password: string, name: string) => Promise<User>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (u: User) => void;
}

const AccountCtx = createContext<Ctx | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [ready, setReady] = useState(STATIC);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (STATIC) return;
    try {
      const r = await fetch(`${SERVER}/api/auth/me`, { credentials: 'include' });
      if (r.status === 401) { setUserState(null); setError(null); }
      else if (r.ok) { setUserState(await r.json()); setError(null); }
      else setError((await r.json().catch(() => null))?.detail ?? `The server answered ${r.status}`);
    } catch {
      setError('offline');
    }
    setReady(true);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(AUTH_LOST, refresh);
    return () => window.removeEventListener(AUTH_LOST, refresh);
  }, [refresh]);

  const value = useMemo<Ctx>(() => ({
    user, ready, error, refresh,
    setUser: setUserState,
    signIn: async (email, password) => { const u = await api<User>('/api/auth/login', { method: 'POST', body: { email, password } }); setUserState(u); setError(null); return u; },
    signUp: async (email, password, name) => { const u = await api<User>('/api/auth/signup', { method: 'POST', body: { email, password, name } }); setUserState(u); setError(null); return u; },
    signOut: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setUserState(null); },
  }), [user, ready, error, refresh]);

  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

export function useAccount() {
  const c = useContext(AccountCtx);
  if (!c) throw new Error('useAccount outside AccountProvider');
  return c;
}

/** For pages behind sign-in: sends a signed-out visitor to /login and back here afterwards. True once it may render. */
export function useSignedIn() {
  const { user, ready } = useAccount();
  const router = useRouter();
  const path = usePathname();
  const out = !STATIC && ready && !user;
  useEffect(() => { if (out) router.replace(`/login?next=${encodeURIComponent(path)}`); }, [out, path, router]);
  return STATIC || !!user;
}

/** Only same-app paths, so a crafted ?next= can't send someone to another site after they sign in. */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null);
