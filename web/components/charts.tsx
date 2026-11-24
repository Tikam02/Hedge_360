'use client';
// SVG charts for the Sectoral analysis and Option chain tabs. The numbers come from the analytics API; these only draw.
// Calls and puts use categorical slots 1 and 2 (validated against the white card surface); up/down use the app's
// green and red, always with a sign beside them. Every chart has a table on the same page showing the same values.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { API_CMD, BULLISH, contracts, type BuildUp, type ChainRow } from '@/lib/derivs';
import { fmt } from '@/lib/util';

export const CALL = '#2a78d6';
export const PUT = '#eb6834';
export const UP = '#059669';
export const DOWN = '#DC4545';
const MUTED = '#C8D3E0', GRID = '#E9EEF5', AXIS = '#B4C1D1';

export const pct = (v: number, dp = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), dp)}%`;

export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Round-number axis covering lo..hi with about n steps. */
export function scale(lo: number, hi: number, n = 5) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw)!;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(+(Math.round(v / step) * step).toFixed(6));
  return { lo: a, hi: b, ticks };
}

/** Horizontal bar from the baseline x0 to x1, rounded only at the data end. */
function hbar(x0: number, x1: number, y: number, h: number, r = 4) {
  const len = Math.abs(x1 - x0);
  if (len < 0.5) return '';
  const q = Math.min(r, len, h / 2), d = x1 >= x0 ? 1 : -1;
  return `M${x0},${y}H${x1 - d * q}Q${x1},${y} ${x1},${y + q}V${y + h - q}Q${x1},${y + h} ${x1 - d * q},${y + h}H${x0}Z`;
}
/** Vertical bar from the baseline y0 to y1, rounded only at the data end. */
function vbar(y0: number, y1: number, x: number, w: number, r = 4) {
  const len = Math.abs(y1 - y0);
  if (len < 0.5) return '';
  const q = Math.min(r, len, w / 2), d = y1 >= y0 ? 1 : -1;
  return `M${x},${y0}V${y1 - d * q}Q${x},${y1} ${x + q},${y1}H${x + w - q}Q${x + w},${y1} ${x + w},${y1 - d * q}V${y0}Z`;
}

type TipState = { x: number; y: number; body: ReactNode } | null;
function Tip({ tip, width }: { tip: TipState; width: number }) {
  if (!tip) return null;
  return (
    <div className={`ch-tip${tip.y < 70 ? ' below' : ''}`} style={{ left: Math.min(Math.max(tip.x, 100), width - 100), top: tip.y }}>
      {tip.body}
    </div>
  );
}

export function BuildUpTag({ b }: { b: BuildUp }) {
  const up = BULLISH[b];
  return <span className={`bu ${up ? 'up' : 'down'}`}>{up ? <TrendingUp size={15} aria-hidden="true" /> : <TrendingDown size={15} aria-hidden="true" />}{b}</span>;
}

export function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="ch-legend">
      {items.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
    </div>
  );
}

// ── Build-up map: price change × futures OI change ─────
export interface MapPoint { id: string; label: string; x: number; y: number; size: number; on: boolean; buildUp: BuildUp; group?: string }

export function BuildUpMap({ points, dim, onPick, height = 340, labelled }: {
  points: MapPoint[]; dim: boolean; onPick?: (id: string) => void; height?: number; labelled: (p: MapPoint) => boolean;
}) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<TipState>(null);
  const m = { l: 46, r: 14, t: 30, b: 42 };
  const iw = Math.max(1, w - m.l - m.r), ih = height - m.t - m.b;
  const ext = (k: 'x' | 'y') => Math.max(0.5, ...points.map((p) => Math.abs(p[k]))) * 1.12;
  const X = scale(-ext('x'), ext('x'), w < 480 ? 4 : 6), Y = scale(-ext('y'), ext('y'), 5);
  const sx = (v: number) => m.l + ((v - X.lo) / (X.hi - X.lo)) * iw;
  const sy = (v: number) => m.t + (1 - (v - Y.lo) / (Y.hi - Y.lo)) * ih;
  const maxS = Math.max(1, ...points.map((p) => p.size));
  const small = points.length > 14;
  const rad = (s: number) => (small ? 4 : 6) + Math.sqrt(s / maxS) * (small ? 7 : 11);

  // Quadrant names sit in the corners; dot labels go wherever they don't collide with those or each other.
  const corners: Array<[string, number, number, 'start' | 'end']> = [
    ['Short build-up', m.l + 8, m.t + 14, 'start'], ['Long build-up', m.l + iw - 8, m.t + 14, 'end'],
    ['Long unwinding', m.l + 8, m.t + ih - 8, 'start'], ['Short covering', m.l + iw - 8, m.t + ih - 8, 'end'],
  ];
  const boxes = corners.map(([t, x, y, a]) => { const tw = t.length * 6.8; const x0 = a === 'start' ? x : x - tw; return [x0, y - 12, x0 + tw, y + 3]; });
  const labels = new Map<string, [number, number, 'start' | 'end' | 'middle']>();
  for (const p of [...points].filter(labelled).sort((a, b) => b.size - a.size)) {
    const cx = sx(p.x), cy = sy(p.y), r = rad(p.size), tw = p.label.length * 6.9 + 2;
    const cands: Array<[number, number, 'start' | 'end' | 'middle']> = [[cx + r + 4, cy + 4, 'start'], [cx - r - 4, cy + 4, 'end'], [cx, cy - r - 5, 'middle'], [cx, cy + r + 14, 'middle']];
    for (const [lx, ly, a] of cands) {
      const x0 = a === 'start' ? lx : a === 'end' ? lx - tw : lx - tw / 2;
      const b = [x0, ly - 11, x0 + tw, ly + 3];
      if (b[0] < m.l + 2 || b[2] > m.l + iw || b[1] < m.t || b[3] > m.t + ih) continue;
      if (boxes.some((o) => !(b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]))) continue;
      boxes.push(b); labels.set(p.id, [lx, ly, a]); break;
    }
  }
  const order = [...points].sort((a, b) => Number(a.on) - Number(b.on) || b.size - a.size);

  return (
    <div className="ch-wrap" ref={ref} onMouseLeave={() => setTip(null)}>
      {w > 0 && (
        <svg width={w} height={height} className="ch-svg" aria-hidden="true">
          {X.ticks.map((t) => <line key={`gx${t}`} x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + ih} stroke={t === 0 ? AXIS : GRID} />)}
          {Y.ticks.map((t) => <line key={`gy${t}`} x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? AXIS : GRID} />)}
          {X.ticks.map((t) => <text key={`tx${t}`} x={sx(t)} y={m.t + ih + 17} textAnchor="middle">{t > 0 ? '+' : ''}{t}</text>)}
          {Y.ticks.map((t) => <text key={`ty${t}`} x={m.l - 7} y={sy(t) + 4} textAnchor="end">{t > 0 ? '+' : ''}{t}</text>)}
          <text x={m.l + iw / 2} y={height - 6} textAnchor="middle" className="ch-axis-t">Price change %</text>
          <text x={m.l - 40} y={16} className="ch-axis-t">Futures OI change %</text>
          {corners.map(([t, x, y, a]) => <text key={t} x={x} y={y} textAnchor={a} className="ch-quad">{t}</text>)}
          {order.map((p) => {
            const cx = sx(p.x), cy = sy(p.y), r = rad(p.size);
            const lab = labels.get(p.id);
            return (
              <g key={p.id} className="ch-pt" onClick={() => onPick?.(p.group ?? p.id)}
                onMouseEnter={() => setTip({ x: cx, y: cy - r - 6, body: <><b>{p.label}</b><span>Price {pct(p.x)} · OI {pct(p.y)}</span><BuildUpTag b={p.buildUp} /></> })}>
                <circle cx={cx} cy={cy} r={r} fill={dim && !p.on ? MUTED : CALL} fillOpacity={dim && !p.on ? 0.7 : 0.88} stroke="#fff" strokeWidth={2} />
                {lab && <text x={lab[0]} y={lab[1]} textAnchor={lab[2]} className={`ch-lab${dim && !p.on ? ' dim' : ''}`}>{p.label}</text>}
                <circle cx={cx} cy={cy} r={Math.max(r, 12)} fill="transparent" />
              </g>
            );
          })}
        </svg>
      )}
      <Tip tip={tip} width={w} />
    </div>
  );
}

// ── Ranked horizontal bars ─────────────────────────────
export interface BarRow { id: string; label: string; value: number; text: string; on: boolean; tip?: ReactNode }

export function RankBars({ rows, base = 0, color, dim, onPick, valW = 58 }: {
  rows: BarRow[]; base?: number; color: (v: number) => string; dim: boolean; onPick?: (id: string) => void; valW?: number;
}) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<TipState>(null);
  const RH = 30, BH = 16;
  const lw = Math.min(150, Math.max(96, w * 0.32));
  const lo = Math.min(base, ...rows.map((r) => r.value)), hi = Math.max(base, ...rows.map((r) => r.value));
  const padL = lo < base ? valW : 4, padR = hi > base ? valW : 4;
  const x0 = lw + padL, x1 = Math.max(x0 + 1, w - padR);
  const sx = (v: number) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);
  const height = rows.length * RH + 4;
  return (
    <div className="ch-wrap" ref={ref} onMouseLeave={() => setTip(null)}>
      {w > 0 && (
        <svg width={w} height={height} className="ch-svg" aria-hidden="true">
          <line x1={sx(base)} x2={sx(base)} y1={0} y2={height} stroke={AXIS} />
          {rows.map((r, i) => {
            const y = i * RH + (RH - BH) / 2 + 2, end = sx(r.value), pos = r.value >= base;
            return (
              <g key={r.id} className="ch-row" onClick={() => onPick?.(r.id)}
                onMouseEnter={() => setTip({ x: end, y: y - 4, body: r.tip ?? <><b>{r.label}</b><span>{r.text}</span></> })}>
                <rect x={0} y={i * RH + 2} width={w} height={RH} className="ch-hit" />
                <text x={0} y={y + BH - 3} className={`ch-name${r.on ? ' on' : ''}${dim && !r.on ? ' dim' : ''}`}>{r.label}</text>
                <path d={hbar(sx(base), end, y, BH)} fill={dim && !r.on ? MUTED : color(r.value)} />
                <text x={pos ? end + 6 : end - 6} y={y + BH - 3} textAnchor={pos ? 'start' : 'end'} className="ch-val">{r.text}</text>
              </g>
            );
          })}
        </svg>
      )}
      <Tip tip={tip} width={w} />
    </div>
  );
}

// ── Call vs put OI, mirrored ───────────────────────────
export interface PairRow { id: string; label: string; call: number; put: number; ratio: string; on: boolean; tip: ReactNode }

export function CallPutBars({ rows, dim, onPick, ratioLabel = 'PCR' }: {
  rows: PairRow[]; dim: boolean; onPick?: (id: string) => void; ratioLabel?: string;
}) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<TipState>(null);
  const RH = 30, BH = 16, HEAD = 26, RW = 46;
  const lw = Math.min(150, Math.max(96, w * 0.3));
  const cx = lw + (w - lw - RW) / 2, half = (w - lw - RW) / 2 - 6;
  const max = Math.max(1, ...rows.flatMap((r) => [r.call, r.put]));
  const height = HEAD + rows.length * RH + 4;
  return (
    <div className="ch-wrap" ref={ref} onMouseLeave={() => setTip(null)}>
      {w > 0 && (
        <svg width={w} height={height} className="ch-svg" aria-hidden="true">
          <rect x={cx - 64} y={4} width={10} height={10} rx={2} fill={CALL} />
          <text x={cx - 50} y={13} className="ch-colh">Calls</text>
          <rect x={cx + 10} y={4} width={10} height={10} rx={2} fill={PUT} />
          <text x={cx + 24} y={13} className="ch-colh">Puts</text>
          <text x={w} y={13} textAnchor="end" className="ch-colh">{ratioLabel}</text>
          <line x1={cx} x2={cx} y1={HEAD - 4} y2={height} stroke={AXIS} />
          {rows.map((r, i) => {
            const y = HEAD + i * RH + (RH - BH) / 2;
            const off = dim && !r.on;
            return (
              <g key={r.id} className="ch-row" onClick={() => onPick?.(r.id)} onMouseEnter={() => setTip({ x: cx, y: y - 4, body: r.tip })}>
                <rect x={0} y={HEAD + i * RH} width={w} height={RH} className="ch-hit" />
                <text x={0} y={y + BH - 3} className={`ch-name${r.on ? ' on' : ''}${off ? ' dim' : ''}`}>{r.label}</text>
                <path d={hbar(cx - 1, cx - 1 - (r.call / max) * half, y, BH)} fill={off ? MUTED : CALL} />
                <path d={hbar(cx + 1, cx + 1 + (r.put / max) * half, y, BH)} fill={off ? MUTED : PUT} />
                <text x={w} y={y + BH - 3} textAnchor="end" className="ch-val">{r.ratio}</text>
              </g>
            );
          })}
        </svg>
      )}
      <Tip tip={tip} width={w} />
    </div>
  );
}

// ── IV range: lowest to highest stock, dot at the average ──
export interface RangeRow { id: string; label: string; min: number; avg: number; max: number; on: boolean }

export function IvRange({ rows, dim, onPick }: { rows: RangeRow[]; dim: boolean; onPick?: (id: string) => void }) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<TipState>(null);
  const RH = 30, AX = 24, RW = 52;
  const lw = Math.min(150, Math.max(96, w * 0.3));
  const S = scale(Math.min(...rows.map((r) => r.min)) * 0.9, Math.max(...rows.map((r) => r.max)) * 1.04, w < 480 ? 4 : 6);
  const x0 = lw + 6, x1 = Math.max(x0 + 1, w - RW);
  const sx = (v: number) => x0 + ((v - S.lo) / (S.hi - S.lo)) * (x1 - x0);
  const height = rows.length * RH + AX;
  return (
    <div className="ch-wrap" ref={ref} onMouseLeave={() => setTip(null)}>
      {w > 0 && (
        <svg width={w} height={height} className="ch-svg" aria-hidden="true">
          {S.ticks.map((t) => (
            <g key={t}>
              <line x1={sx(t)} x2={sx(t)} y1={0} y2={rows.length * RH} stroke={GRID} />
              <text x={sx(t)} y={rows.length * RH + 16} textAnchor="middle">{t}%</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cy = i * RH + RH / 2 + 1, off = dim && !r.on;
            return (
              <g key={r.id} className="ch-row" onClick={() => onPick?.(r.id)}
                onMouseEnter={() => setTip({ x: sx(r.avg), y: cy - 10, body: <><b>{r.label}</b><span>Average {fmt(r.avg, 1)}% · range {fmt(r.min, 1)}–{fmt(r.max, 1)}%</span></> })}>
                <rect x={0} y={i * RH} width={w} height={RH} className="ch-hit" />
                <text x={0} y={cy + 4} className={`ch-name${r.on ? ' on' : ''}${off ? ' dim' : ''}`}>{r.label}</text>
                <rect x={sx(r.min)} y={cy - 4} width={Math.max(8, sx(r.max) - sx(r.min))} height={8} rx={4} fill={off ? MUTED : CALL} fillOpacity={off ? 0.6 : 0.3} />
                <circle cx={sx(r.avg)} cy={cy} r={6} fill={off ? MUTED : CALL} stroke="#fff" strokeWidth={2} />
                <text x={w} y={cy + 4} textAnchor="end" className="ch-val">{fmt(r.avg, 1)}%</text>
              </g>
            );
          })}
        </svg>
      )}
      <Tip tip={tip} width={w} />
    </div>
  );
}

// ── Open interest by strike (option chain) ─────────────
export function OiByStrike({ rows, spot, maxPain, mode, height = 280 }: {
  rows: ChainRow[]; spot: number; maxPain: number; mode: 'oi' | 'chg'; height?: number;
}) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 52, r: 8, t: 30, b: 30 };
  const iw = Math.max(1, w - m.l - m.r), ih = height - m.t - m.b;
  const val = (r: ChainRow, side: 'call' | 'put') => (mode === 'oi' ? r[side].oi : r[side].chgOi);
  const all = rows.flatMap((r) => [val(r, 'call'), val(r, 'put')]);
  const Y = scale(Math.min(0, ...all), Math.max(1, ...all), 4);
  const sy = (v: number) => m.t + (1 - (v - Y.lo) / (Y.hi - Y.lo)) * ih;
  const band = iw / Math.max(1, rows.length);
  const bw = Math.max(2, Math.min(12, band * 0.36));
  const cx = (i: number) => m.l + band * (i + 0.5);
  const xAt = (k: number) => {
    const i = rows.findIndex((r, j) => j < rows.length - 1 && r.strike <= k && rows[j + 1].strike > k);
    if (i < 0) return k <= rows[0]?.strike ? cx(0) : cx(rows.length - 1);
    return cx(i) + ((k - rows[i].strike) / (rows[i + 1].strike - rows[i].strike)) * band;
  };
  const every = Math.max(1, Math.ceil(46 / band));
  const atm = rows.reduce((b, r, i) => (Math.abs(r.strike - spot) < Math.abs(rows[b].strike - spot) ? i : b), 0);
  const spotX = xAt(spot), painX = xAt(maxPain);
  const spotLeft = spotX <= painX;
  const h = hover != null ? rows[hover] : null;
  return (
    <div className="ch-wrap" ref={ref} onMouseLeave={() => setHover(null)}>
      {w > 0 && rows.length > 0 && (
        <svg width={w} height={height} className="ch-svg" aria-hidden="true">
          {Y.ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? AXIS : GRID} />
              <text x={m.l - 8} y={sy(t) + 4} textAnchor="end">{contracts(t)}</text>
            </g>
          ))}
          {hover != null && <rect x={cx(hover) - band / 2} y={m.t} width={band} height={ih} fill={GRID} opacity={0.7} />}
          {rows.map((r, i) => (
            <g key={r.strike}>
              <path d={vbar(sy(0), sy(val(r, 'call')), cx(i) - bw - 0.5, bw)} fill={CALL} />
              <path d={vbar(sy(0), sy(val(r, 'put')), cx(i) + 0.5, bw)} fill={PUT} />
              {(i - atm) % every === 0 && <text x={cx(i)} y={height - 10} textAnchor="middle">{fmt(r.strike, Number.isInteger(r.strike) ? 0 : 2)}</text>}
            </g>
          ))}
          <line x1={painX} x2={painX} y1={m.t - 6} y2={m.t + ih} stroke="#58697D" strokeDasharray="2 3" />
          <text x={painX + (spotLeft ? 5 : -5)} y={m.t - 10} textAnchor={spotLeft ? 'start' : 'end'} className="ch-mark">Max pain {fmt(maxPain, 0)}</text>
          <line x1={spotX} x2={spotX} y1={m.t - 6} y2={m.t + ih} stroke="#172536" strokeWidth={1.5} strokeDasharray="5 3" />
          <text x={spotX + (spotLeft ? -5 : 5)} y={m.t - 10} textAnchor={spotLeft ? 'end' : 'start'} className="ch-mark strong">Spot {fmt(spot)}</text>
          {rows.map((r, i) => (
            <rect key={`h${r.strike}`} x={cx(i) - band / 2} y={m.t} width={band} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {h && (
        <div className={`ch-tip${sy(Math.max(val(h, 'call'), val(h, 'put'))) < 80 ? ' below' : ''}`}
          style={{ left: Math.min(Math.max(cx(hover!), 100), w - 100), top: sy(Math.max(val(h, 'call'), val(h, 'put'), 0)) - 6 }}>
          <b>Strike {fmt(h.strike, 0)}</b>
          <span><i style={{ background: CALL }} />Calls {fmt(val(h, 'call'), 0)}</span>
          <span><i style={{ background: PUT }} />Puts {fmt(val(h, 'put'), 0)}</span>
        </div>
      )}
    </div>
  );
}

// ── Loading and error states ───────────────────────────
export function ApiNotice({ error, retry }: { error: string; retry: () => void }) {
  const offline = error === 'offline';
  return (
    <div className="api-err" role="alert">
      <CircleAlert size={22} aria-hidden="true" />
      <div className="api-err-t">
        <h3>{offline ? "Can't reach the data server" : 'The data server returned an error'}</h3>
        {offline ? <p>Start it from the project root (the folder with server.py), then try again: <code>{API_CMD}</code></p> : <p>{error}</p>}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={retry}><RefreshCw size={16} aria-hidden="true" /> Try again</button>
    </div>
  );
}

export const Skeleton = ({ h, className = '' }: { h: number; className?: string }) => <div className={`sk ${className}`} style={{ height: h }} aria-hidden="true" />;
