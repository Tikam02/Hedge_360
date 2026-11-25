'use client';
import type { FnoResp, FnoStock } from '@/lib/derivs';
import { expShort } from '@/lib/derivs';

/** NSE symbols as the server accepts them: RELIANCE, M&M, BAJAJ-AUTO. */
export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9&-]{0,29}$/;
export const cleanSymbol = (s: string) => s.trim().toUpperCase();

export const stockMap = (fno: FnoResp | null | undefined) => new Map<string, FnoStock>((fno?.stocks ?? []).map((s) => [s.symbol, s]));

/** Today's F&O standing of a symbol, for a tag beside it. */
export function FnoTag({ symbol, stocks }: { symbol: string; stocks: Map<string, FnoStock> }) {
  if (!stocks.size) return null;
  const s = stocks.get(symbol);
  if (!s) return <span className="tk-tag out">Not in F&amp;O</span>;
  if (s.leaving) return <span className="tk-tag warn" title={`No contracts after ${s.lastExpiry}`}>Leaving · {expShort(s.lastExpiry)}</span>;
  return <span className="tk-tag">In F&amp;O</span>;
}

/** Symbol input with today's F&O stocks as suggestions; anything the server accepts can still be typed. */
export function SymbolInput({ id, value, onChange, stocks, autoFocus }: { id: string; value: string; onChange: (v: string) => void; stocks: Map<string, FnoStock>; autoFocus?: boolean }) {
  return (
    <>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} list={`${id}-list`} maxLength={30}
        placeholder="RELIANCE" autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus={autoFocus} />
      <datalist id={`${id}-list`}>
        {[...stocks.keys()].map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}
