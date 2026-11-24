'use client';
// Client for the F&O analytics API (FastAPI: ../derivs.py, run with `.venv/bin/uvicorn server:app --port 8060`).
// Sectors are sample data. The chain, symbol list and 3D grid switch to your own stock-derivatives API on the
// server side (DERIVS_CHAIN_SOURCE in derivs.py), so nothing here changes. NEXT_PUBLIC_DERIVS_API only says where
// the analytics server runs. The GitHub Pages build has no server: there NEXT_PUBLIC_DERIVS_STATIC is set and each
// request reads a JSON file written by export_static.py (see next.config.mjs).
import { useCallback, useEffect, useState } from 'react';
import type { OptionRow, OptType } from './data';
import { OPTIONS } from './data';

export const DERIVS_API = process.env.NEXT_PUBLIC_DERIVS_API ?? 'http://localhost:8060/api/derivs';
export const API_CMD = '.venv/bin/uvicorn server:app --port 8060';
const STATIC = process.env.NEXT_PUBLIC_DERIVS_STATIC === '1';

/** "/chain?symbol=M&M&expiry=30-Dec-2026" → "/chain/M_M/30-Dec-2026.json", the file export_static.py wrote for it. */
function staticPath(path: string) {
  const [route, query = ''] = path.split('?');
  const q = new URLSearchParams(query);
  const safe = (v: string) => v.replace(/[^A-Za-z0-9-]/g, '_');
  const sym = q.get('symbol'), exp = q.get('expiry');
  if (route === '/chain' && sym) return exp ? `/chain/${safe(sym)}/${safe(exp)}.json` : `/chain/${safe(sym)}.json`;
  if (route === '/surface' && sym) return `/surface/${safe(sym)}.json`;
  return `${route}.json`;
}
export const apiUrl = (path: string) => `${DERIVS_API}${STATIC ? staticPath(path) : path}`;

export type BuildUp = 'Long build-up' | 'Short covering' | 'Short build-up' | 'Long unwinding';
/** Price up with OI up is fresh longs, price down with OI up is fresh shorts; the other two are positions closing. */
export const BULLISH: Record<BuildUp, boolean> = { 'Long build-up': true, 'Short covering': true, 'Short build-up': false, 'Long unwinding': false };

interface Meta { source: string; asOf: string }

export interface StockStat {
  symbol: string; sector: string; spot: number; chg: number; oiChg: number; pcr: number | null; atmIv: number | null;
  ivChg: number; callCr: number; putCr: number; maxPain: number; lot: number; buildUp: BuildUp;
}
export interface SectorStat {
  name: string; chg: number; oiChg: number; buildUp: BuildUp; pcr: number; callCr: number; putCr: number;
  iv: { min: number; avg: number; max: number }; counts: Record<BuildUp, number>; stocks: StockStat[];
}
/** GET /sectors */
export interface SectorsResp extends Meta { expiry: string; buildUps: BuildUp[]; indices: StockStat[]; sectors: SectorStat[] }

export interface SymbolInfo { symbol: string; sector: string; index: boolean; spot: number; chg: number; lot: number; expiries: string[] }
/** GET /symbols */
export interface SymbolsResp extends Meta { marginPct: number; symbols: SymbolInfo[] }

/** OI and volume are in contracts. `iv` is null when the strike didn't trade. */
export interface Side { ltp: number; chg: number; iv: number | null; delta: number; oi: number; chgOi: number; vol: number }
export interface ChainRow { strike: number; call: Side; put: Side }
/** GET /chain?symbol=&expiry= */
export interface ChainResp extends Meta {
  symbol: string; sector: string; index: boolean; expiry: string; expiries: string[]; spot: number; fut: number; chg: number;
  dte: number; lot: number; step: number; atmStrike: number; atmIv: number | null; maxPain: number;
  callOi: number; putOi: number; pcr: number | null; callChg: number; putChg: number; marginPct: number; rows: ChainRow[];
}
/** GET /surface?symbol= : grids are [expiry][strike], null where an expiry has no such strike. */
export interface SurfaceResp extends Meta {
  symbol: string; spot: number; lot: number; strikes: number[]; expiries: Array<{ expiry: string; dte: number }>;
  callOi: Array<Array<number | null>>; putOi: Array<Array<number | null>>; iv: Array<Array<number | null>>;
}

export type ApiState<T> = { data: T | null; error: string | null; loading: boolean; retry: () => void };

/** Fetches `path` from the API (or its static file). Keeps the previous data on screen while a new path loads. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [s, setS] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    setS((x) => ({ data: x.data, error: null, loading: true }));
    fetch(apiUrl(path), { signal: ctl.signal })
      .then(async (r) => {
        if (STATIC && r.status === 404) throw new Error('No sample data for that symbol or expiry.');
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `The data server answered ${r.status}`);
        return r.json() as Promise<T>;
      })
      .then((data) => setS({ data, error: null, loading: false }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setS({ data: null, error: e instanceof TypeError ? 'offline' : e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => ctl.abort();
  }, [path, nonce]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { ...s, retry };
}

/** ₹ crore, switching to lakh crore for index-sized numbers. */
export const crore = (v: number) => (v >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L cr` : `₹${Math.round(v).toLocaleString('en-IN')} cr`);
/** Contracts in Indian units: 17.8 L, 42.5 K. */
export const contracts = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e7) return `${s}${+(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}${+(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${s}${+(a / 1e3).toFixed(1)} K`;
  return `${s}${a}`;
};
export const expShort = (s: string) => s.replace(/-\d{2}(\d{2})$/, ' ’$1').replace('-', ' ');

/**
 * A chain contract in the screener's shape, so the trade check and Execute flow work unchanged. Contracts that are
 * also screener rows return the screener row itself, so "Executed" shows on both tabs. Margin follows the scanner:
 * strike × lot × margin %, marked as an estimate.
 */
export function chainOption(c: ChainResp, row: ChainRow, type: OptType): OptionRow {
  const known = OPTIONS.find((o) => o.symbol === c.symbol && o.expiry === c.expiry && o.strike === row.strike && o.type === type);
  if (known) return known;
  const s = type === 'CE' ? row.call : row.put;
  const K = row.strike, S = c.spot;
  const margin = Math.round((K * c.lot * c.marginPct) / 100);
  const totalPrem = Math.round(s.ltp * c.lot * 100) / 100;
  return {
    id: `chain-${c.symbol}-${c.expiry}-${K}-${type}`, symbol: c.symbol, type, cmp: S, strike: K,
    otm: Math.round(((type === 'PE' ? S - K : K - S) / S) * 10000) / 100, prem: s.ltp, lot: c.lot, totalPrem, margin,
    premPct: margin ? Math.round((totalPrem / margin) * 10000) / 100 : 0, expiry: c.expiry, fut: c.fut,
    hi52: null, lo52: null, pe: null, iv: s.iv ?? 0, oi: s.oi, src: 'chain', est: ['margin'],
  };
}
