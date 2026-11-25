'use client';
// Zerodha login on the analytics server (../kite_auth.py). The server keeps the Kite Connect credentials and the
// session; the browser only ever learns which ones are saved, never the secrets. Market data stays read only.
import { SERVER, api } from './account';

export const kiteUrl = (path: string) => `${SERVER}/api/kite${path}`;

/** GET /api/kite/status */
export interface KiteStatus {
  connected: boolean; expired: boolean; user_id: string | null; user_name: string | null; broker: string | null;
  /** ISO time (IST) of the last login. */
  login_time: string | null;
  api_key: string; source: 'saved' | 'env' | null; has_api_secret: boolean; has_totp_secret: boolean;
  /** Secrets saved under a key this server doesn't have: paste them again. */
  unreadable: string[]; can_login: boolean;
  /** The callback to set as the Redirect URL on your Kite Connect app. */
  redirect_url: string;
}
export interface Totp { code: string; remaining: number }

/** JSON call to the login API; throws an Error with the server's message ('offline' when it can't be reached). */
export const kite = <T,>(path: string, init?: { method?: 'POST' | 'DELETE'; body?: unknown }) => api<T>(`/api/kite${path}`, init);
