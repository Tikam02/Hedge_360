'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, ChevronRight, ChevronsUpDown, LogOut, NotebookPen, PlugZap, SlidersHorizontal, UserRound } from 'lucide-react';
import { avatarUrl, initials, useAccount } from '@/lib/account';
import { STATIC } from '@/lib/derivs';
import { useStore, type TimeAvail } from '@/lib/store';
import { APPETITE_LABEL, RULES, fmt, words, type Appetite } from '@/lib/util';

export const TIME_LABEL: Record<TimeAvail, string> = { weekly: 'A few hours a week', '30m': 'Under 30 min a day', '2h': '1 to 2 hours a day', full: 'Full market hours' };
const LEVEL: Record<Appetite, number> = { conservative: 1, moderate: 2, aggressive: 3 };

/** The account's picture, or its initials on the appetite colour. */
export function Avatar({ size = 34, className = '' }: { size?: number; className?: string }) {
  const { user } = useAccount();
  const { profile } = useStore();
  const [broken, setBroken] = useState(false);
  const src = avatarUrl(user);
  useEffect(() => setBroken(false), [src]);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) } as CSSProperties;
  if (src && !broken) return <img className={`av av-img ${className}`} src={src} alt="" style={style} onError={() => setBroken(true)} />;
  const text = user ? initials(user.name, user.email) : APPETITE_LABEL[profile.appetite ?? 'moderate'][0];
  return <span className={`av ${profile.appetite ?? 'moderate'} ${className}`} style={style} aria-hidden="true">{text}</span>;
}

/** The thresholds every trade is checked against for this appetite, in words. */
export function RiskFactors({ appetite, capital }: { appetite: Appetite; capital: number | null }) {
  const R = RULES[appetite];
  const rows: Array<[string, ReactNode]> = [
    ['Strike', <>≥ {R.otm}% out of the money</>],
    ['Implied volatility', <>≤ {R.iv}%</>],
    ['Open interest', <>≥ {fmt(R.oi, 0)} contracts</>],
    ['Margin', <>≤ {R.marginPct}% of capital{capital ? <small> · {words((capital * R.marginPct) / 100)}</small> : null}</>],
  ];
  return (
    <dl className="rf">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function AppetiteMeter({ appetite }: { appetite: Appetite }) {
  return <span className={`meter l${LEVEL[appetite]}`} aria-hidden="true"><i /><i /><i /></span>;
}

type Place = 'side' | 'top';

/**
 * The account menu: the sidebar's bottom-left button (and the phone top bar's chip) opens it. It shows who is signed
 * in, the risk profile and the thresholds trades are checked against, links into the Profile page, and sign out.
 * A popover, not a modal: Escape or a click outside closes it, and focus goes back to the button.
 */
export function ProfileMenu({ place, kite, onNavigate, children }: { place: Place; kite?: 'live' | 'sample' | 'offline' | null; onNavigate?: () => void; children: ReactNode }) {
  const { user, signOut } = useAccount();
  const { profile } = useStore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const appetite = profile.appetite ?? 'moderate';

  const place_ = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(320, window.innerWidth - 24);
    if (place === 'top') { setPos({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right), width: w, maxHeight: window.innerHeight - r.bottom - 20 }); return; }
    // Wide sidebar: open upwards from the button. Icon rail: open to its right. Taller than the room: it scrolls.
    const rail = r.width < 120;
    const left = Math.min(rail ? r.right + 8 : r.left, window.innerWidth - w - 12);
    const base = rail ? r.bottom : r.top - 8;
    setPos({ left: Math.max(12, left), bottom: Math.max(12, window.innerHeight - base), width: w, maxHeight: base - 12 });
  }, [place]);

  useLayoutEffect(() => { if (open) place_(); }, [open, place_]);
  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // the phone drawer also closes on Escape: this closes only the menu
      setOpen(false); btn.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', place_);
    return () => { window.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', place_); };
  }, [open, place_]);

  const go = (href: string) => { setOpen(false); onNavigate?.(); router.push(href); };
  const out = async () => { setOpen(false); onNavigate?.(); await signOut(); router.replace('/login'); };
  const who = user ? user.name || user.email.split('@')[0] : 'Demo trader';

  const links: Array<{ href: string; label: string; icon: typeof UserRound; tail?: ReactNode }> = [
    { href: '/profile', label: 'Profile and picture', icon: UserRound },
    ...(STATIC ? [] : [
      { href: '/profile?tab=journal', label: 'Trade journal', icon: BookOpen },
      { href: '/profile?tab=notes', label: 'Notes', icon: NotebookPen },
    ]),
    { href: '/profile?tab=zerodha', label: 'Zerodha', icon: PlugZap,
      tail: <span className="pm-st"><i className={`fd fd-${kite === 'live' ? 'live' : 'offline'}`} aria-hidden="true" />{kite === 'live' ? 'Connected' : 'Not connected'}</span> },
  ];

  return (
    <>
      <button type="button" ref={btn} className={place === 'side' ? 'sb-profile' : 'profile-chip'} onClick={() => setOpen(!open)}
        aria-haspopup="dialog" aria-expanded={open} aria-label={place === 'top' ? 'Account and risk profile' : undefined}>
        {children}
        {place === 'side' && <ChevronsUpDown size={16} className="sb-chev" aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div ref={pop} className="pm" role="dialog" aria-label="Account and risk profile" style={pos}>
          <div className="pm-head">
            <Avatar size={44} />
            <div className="pm-who"><b>{who}</b>{user && <small>{user.email}</small>}</div>
          </div>

          <section className="pm-risk" aria-label="Risk profile">
            <div className="pm-app">
              <div><small>Risk appetite</small><b>{APPETITE_LABEL[appetite]}</b></div>
              <AppetiteMeter appetite={appetite} />
            </div>
            <dl className="pm-facts">
              <div><dt>Capital</dt><dd>{profile.capital ? words(profile.capital) : 'Not set'}</dd></div>
              <div><dt>Time</dt><dd>{profile.time ? TIME_LABEL[profile.time] : 'Not set'}</dd></div>
            </dl>
            <p className="pm-sub">Trades must pass</p>
            <RiskFactors appetite={appetite} capital={profile.capital} />
            <button type="button" className="btn btn-ghost btn-sm pm-edit" onClick={() => go('/?edit=1')}><SlidersHorizontal size={15} aria-hidden="true" /> Edit risk profile</button>
          </section>

          <nav className="pm-links" aria-label="Account">
            {links.map(({ href, label, icon: Icon, tail }) => (
              <Link key={href} href={href} onClick={(e) => { e.preventDefault(); go(href); }}>
                <Icon size={17} aria-hidden="true" /><span>{label}</span>{tail ?? <ChevronRight size={15} className="pm-chev" aria-hidden="true" />}
              </Link>
            ))}
          </nav>
          {user && <button type="button" className="pm-out" onClick={out}><LogOut size={17} aria-hidden="true" /> Sign out</button>}
        </div>,
        document.body,
      )}
    </>
  );
}
