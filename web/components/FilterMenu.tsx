'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Columns3 } from 'lucide-react';

export type MenuOption = { v: string; l: string; n?: number };

export function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, close]);
  return ref;
}

/** Dropdown filter used on Positions and the Screener. `inline` renders the same options as chips for the phone filter sheet. */
export function FilterMenu({ label, options, value, onChange, single, searchable, inline }: {
  label: string; options: MenuOption[]; value: string[]; onChange: (v: string[]) => void; single?: boolean; searchable?: boolean; inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const ref = useOutside(open, () => setOpen(false));
  const summary = !value.length ? 'All' : value.length === 1 ? options.find((o) => o.v === value[0])?.l ?? value[0] : `${value.length} selected`;
  const list = find ? options.filter((o) => o.l.toLowerCase().includes(find.toLowerCase())) : options;
  const zero = (o: MenuOption) => o.n === 0 && !value.includes(o.v);
  const pick = (v: string) => {
    if (single) { onChange(value[0] === v ? [] : [v]); setOpen(false); return; }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  if (inline) {
    return (
      <fieldset className="fx">
        <legend>{label}</legend>
        <div className="fx-chips">
          {options.map((o) => (
            <button type="button" key={o.v} aria-pressed={value.includes(o.v)} className={`fx-chip${zero(o) ? ' zero' : ''}`} onClick={() => pick(o.v)}>
              {o.l}{o.n != null && <span>{o.n}</span>}
            </button>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="fm" ref={ref}>
      <button type="button" className={`fm-btn${value.length ? ' on' : ''}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <span className="fm-l">{label}</span><span className="fm-v">{summary}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="fm-pop" role="group" aria-label={label}>
          {searchable && <input className="fm-find" type="search" placeholder={`Find ${label.toLowerCase()}`} value={find} onChange={(e) => setFind(e.target.value)} />}
          <div className="fm-list">
            {list.map((o) => (
              <button type="button" key={o.v} role={single ? 'menuitemradio' : 'menuitemcheckbox'} aria-checked={value.includes(o.v)}
                className={`fm-opt${zero(o) ? ' zero' : ''}`} onClick={() => pick(o.v)}>
                <span className={`fm-box${single ? ' radio' : ''}`} aria-hidden="true" />
                <span className="fm-t">{o.l}</span>{o.n != null && <span className="fm-n">{o.n}</span>}
              </button>
            ))}
          </div>
          {value.length > 0 && <button type="button" className="fm-clear" onClick={() => { onChange([]); setOpen(false); }}>Clear {label === 'P&L' ? 'P&L' : label.toLowerCase()}</button>}
        </div>
      )}
    </div>
  );
}

export function SortMenu<T extends string>({ value, options, onChange }: { value: T; options: Array<{ v: T; l: string }>; onChange: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div className="fm fm-sort" ref={ref}>
      <button type="button" className="fm-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <span className="fm-l">Sort</span><span className="fm-v">{options.find((s) => s.v === value)?.l}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="fm-pop" role="group" aria-label="Sort">
          <div className="fm-list">
            {options.map((s) => (
              <button type="button" key={s.v} role="menuitemradio" aria-checked={value === s.v} className="fm-opt" onClick={() => { onChange(s.v); setOpen(false); }}>
                <span className="fm-box radio" aria-hidden="true" /><span className="fm-t">{s.l}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Required single choice (symbol, expiry, strike range): picking closes the menu and there is no "All" state. */
export function SelectMenu<T extends string>({ label, value, options, onChange, searchable }: {
  label: string; value: T; options: Array<{ v: T; l: string; sub?: string }>; onChange: (v: T) => void; searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const ref = useOutside(open, () => setOpen(false));
  const needle = find.trim().toLowerCase();
  const list = needle ? options.filter((o) => o.l.toLowerCase().includes(needle) || o.sub?.toLowerCase().includes(needle)) : options;
  return (
    <div className="fm fm-select" ref={ref}>
      <button type="button" className="fm-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <span className="fm-l">{label}</span><span className="fm-v">{options.find((o) => o.v === value)?.l ?? value}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="fm-pop" role="group" aria-label={label}>
          {searchable && <input className="fm-find" type="search" placeholder={`Find ${label.toLowerCase()}`} value={find} onChange={(e) => setFind(e.target.value)} autoFocus />}
          <div className="fm-list">
            {list.map((o) => (
              <button type="button" key={o.v} role="menuitemradio" aria-checked={value === o.v} className="fm-opt"
                onClick={() => { onChange(o.v); setOpen(false); setFind(''); }}>
                <span className="fm-box radio" aria-hidden="true" /><span className="fm-t">{o.l}</span>{o.sub && <span className="fm-n">{o.sub}</span>}
              </button>
            ))}
            {!list.length && <p className="fm-none">No {label.toLowerCase()} matches “{find}”</p>}
          </div>
        </div>
      )}
    </div>
  );
}

const pctText = (v: number) => `${+v.toFixed(2)}%`;

/**
 * "At least X%" filter with a slider. The histogram shows where the options sit (rows already narrowed by the
 * other filters), and everything at or above the thumb is highlighted, so the selected side is always the right side.
 * At `lo` every option passes. `base` is the starting value (default `lo`): the button stands out once it moves.
 */
export function RangeMenu({ id, label, title, value, base, onChange, lo, hi, step, values, presets, inline }: {
  id: string; label: string; title: string; value: number; base?: number; onChange: (v: number) => void;
  lo: number; hi: number; step: number; values: number[]; presets: Array<{ v: number; l: string }>; inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const start = base ?? lo;
  const active = value !== start;
  const body = <RangeBody id={inline ? `${id}-sheet` : id} title={title} value={value} onChange={onChange} lo={lo} hi={hi} step={step} values={values} presets={presets} />;
  if (inline) {
    return <fieldset className="fx"><legend>{label}</legend>{body}</fieldset>;
  }
  return (
    <div className="fm" ref={ref}>
      <button type="button" className={`fm-btn${active ? ' on' : ''}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <span className="fm-l">{label}</span><span className="fm-v">≥ {pctText(value)}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="fm-pop rng-pop" role="group" aria-label={title}>
          {body}
          {active && <button type="button" className="fm-clear" onClick={() => { onChange(start); setOpen(false); }}>Reset to ≥ {pctText(start)}</button>}
        </div>
      )}
    </div>
  );
}

function RangeBody({ id, title, value, onChange, lo, hi, step, values, presets }: {
  id: string; title: string; value: number; onChange: (v: number) => void; lo: number; hi: number; step: number; values: number[]; presets: Array<{ v: number; l: string }>;
}) {
  const BINS = 14;
  const w = (hi - lo) / BINS;
  const counts = Array.from({ length: BINS }, (_, i) =>
    values.filter((x) => x >= lo + i * w && (i === BINS - 1 ? x <= hi : x < lo + (i + 1) * w)).length);
  const peak = Math.max(1, ...counts);
  const n = values.filter((x) => x >= value).length;
  return (
    <div className="rng">
      <div className="rng-top">
        <label htmlFor={id}>{title}</label>
        <output htmlFor={id}>≥ {pctText(value)}</output>
      </div>
      <div className="rng-hist" aria-hidden="true">
        {counts.map((c, i) => (
          <span key={i} className={lo + (i + 0.5) * w >= value ? 'in' : ''} style={{ height: c ? `${(c / peak) * 100}%` : undefined }} />
        ))}
      </div>
      <input id={id} type="range" min={lo} max={hi} step={step} value={value} onChange={(e) => onChange(+e.target.value)}
        aria-valuetext={`at least ${pctText(value)}`} style={{ ['--fill' as string]: `${((value - lo) / (hi - lo)) * 100}%` }} />
      <div className="rng-scale" aria-hidden="true"><span>{pctText(lo)}</span><span>{pctText(hi)}</span></div>
      <div className="rng-chips" role="group" aria-label="Presets">
        {[{ v: lo, l: pctText(lo) }, ...presets.filter((p) => p.v !== lo)].map((p) => (
          <button type="button" key={p.v} aria-pressed={value === p.v} onClick={() => onChange(p.v)}>{p.l}</button>
        ))}
      </div>
      <p className="rng-count" aria-live="polite"><b>{n}</b> of {values.length} option{values.length === 1 ? '' : 's'} match</p>
    </div>
  );
}

/** Show/hide table columns. Locked columns are listed but can't be turned off. */
export function ColumnsMenu({ columns, visible, onChange, onReset }: {
  columns: Array<{ key: string; label: string; locked?: boolean }>; visible: string[]; onChange: (v: string[]) => void; onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const shown = columns.filter((c) => c.locked || visible.includes(c.key)).length;
  const flip = (k: string) => onChange(visible.includes(k) ? visible.filter((x) => x !== k) : [...visible, k]);
  return (
    <div className="fm fm-cols" ref={ref}>
      <button type="button" className="fm-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <Columns3 size={16} aria-hidden="true" /><span className="fm-v">Columns</span><span className="fm-l">{shown}/{columns.length}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="fm-pop" role="group" aria-label="Columns">
          <div className="fm-list">
            {columns.map((c) => (
              <button type="button" key={c.key} role="menuitemcheckbox" aria-checked={c.locked || visible.includes(c.key)} aria-disabled={c.locked}
                className={`fm-opt${c.locked ? ' locked' : ''}`} onClick={() => !c.locked && flip(c.key)}>
                <span className="fm-box" aria-hidden="true" />
                <span className="fm-t">{c.label}</span>{c.locked && <span className="fm-n">Always</span>}
              </button>
            ))}
          </div>
          <button type="button" className="fm-clear" onClick={onReset}>Reset to default</button>
        </div>
      )}
    </div>
  );
}
