'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ChartScatter, ChevronRight, CircleCheck, LayoutDashboard, ListFilter, Menu, Shield, ShieldCheck, TableProperties, X } from 'lucide-react';
import { useStore } from '@/lib/store';
import { apiUrl } from '@/lib/derivs';
import { APPETITE_LABEL, words } from '@/lib/util';

export function BrandMark({ size = 20 }: { size?: number }) {
  return <span className="brand-mark"><ShieldCheck size={size} strokeWidth={2.4} /></span>;
}

export function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return <div className="toast" role="status"><CircleCheck size={18} /> <span>{toast}</span></div>;
}

type Feed = 'live' | 'sample' | 'offline' | null;
type Tab = { href: string; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>; count?: number };

/** Where the analytics server's sector and chain data come from. Checked once per page; never blocks the page. */
function useFeeds() {
  const [feeds, setFeeds] = useState<{ sectors: Feed; chain: Feed }>({ sectors: null, chain: null });
  useEffect(() => {
    let dead = false;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    fetch(apiUrl('/health'), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { sectors: Feed; chain: Feed }) => { if (!dead) setFeeds({ sectors: d.sectors, chain: d.chain }); })
      .catch(() => { if (!dead) setFeeds({ sectors: 'offline', chain: 'offline' }); })
      .finally(() => clearTimeout(t));
    return () => { dead = true; clearTimeout(t); ctl.abort(); };
  }, []);
  return feeds;
}

const FEED_LABEL: Record<Exclude<Feed, null>, string> = { live: 'Live', sample: 'Sample', offline: 'Offline' };

/**
 * Phone drawer: the sidebar slides in over the page. While it is open the page behind is inert and doesn't scroll;
 * Escape, the scrim, the close button or any link closes it, and focus goes back to the menu button.
 */
function useDrawer() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia('(min-width: 721px)');
    const onWide = () => { if (wide.matches) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    wide.addEventListener('change', onWide);
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('a[aria-current="page"], .sb-nav a')?.focus();
    const btn = opener.current;
    return () => {
      wide.removeEventListener('change', onWide);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      btn?.focus();
    };
  }, [open]);
  return { open, setOpen, close, panel, opener };
}

/** App frame: sidebar on desktop, an icon rail on tablets, a top bar with a slide-out drawer on phones. Sends first-time visitors to onboarding. */
export default function Shell({ children }: { children: ReactNode }) {
  const { ready, profile, positions } = useStore();
  const path = usePathname();
  const router = useRouter();
  const feeds = useFeeds();
  const drawer = useDrawer();

  useEffect(() => { if (ready && !profile.done) router.replace('/'); }, [ready, profile.done, router]);

  const appetite = profile.appetite ?? 'moderate';
  const groups: Array<{ label: string; tabs: Tab[] }> = [
    { label: 'Desk', tabs: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/positions', label: 'Positions', icon: Shield, count: positions.length },
    ] },
    { label: 'Research', tabs: [
      { href: '/screener', label: 'Screener', icon: ListFilter },
      { href: '/sectors', label: 'Sectoral analysis', icon: ChartScatter },
      { href: '/chain', label: 'Option chain', icon: TableProperties },
    ] },
  ];
  const status: Array<[string, Feed]> = [['Positions', 'sample'], ['Sector data', feeds.sectors], ['Option chain', feeds.chain]];
  const editProfile = () => { drawer.close(); router.push('/?edit=1'); };
  const { open, close } = drawer;

  return (
    <div className="app">
      <aside id="sidebar" ref={drawer.panel} className={`sb${open ? ' open' : ''}`}
        {...(open ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Menu' } : { 'aria-label': 'Sidebar' })}>
        <div className="sb-top">
          <Link href="/dashboard" className="sb-brand" aria-label="Hedge 360 dashboard" onClick={close}>
            <BrandMark size={18} />
            <span className="sb-t"><b>Hedge 360</b><small>Risk desk</small></span>
          </Link>
          <button type="button" className="sb-close" aria-label="Close menu" onClick={close}><X size={22} aria-hidden="true" /></button>
        </div>
        <nav className="sb-nav" aria-label="Main">
          {groups.map((g) => (
            <div className="sb-group" key={g.label}>
              <p className="sb-gl">{g.label}</p>
              {g.tabs.map(({ href, label, icon: Icon, count }) => (
                <Link key={href} href={href} className={path === href ? 'on' : ''} aria-current={path === href ? 'page' : undefined} title={label} onClick={close}>
                  <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                  <span className="sb-t">{label}</span>
                  {count != null && <span className="sb-count">{count}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sb-foot">
          <button type="button" className="sb-profile" onClick={editProfile} title="Edit your trading profile">
            <span className={`sb-av ${appetite}`} aria-hidden="true">{APPETITE_LABEL[appetite][0]}</span>
            <span className="sb-t">
              <b>{APPETITE_LABEL[appetite]}</b>
              <small>{profile.capital ? `${words(profile.capital)} capital` : 'Edit profile'}</small>
            </span>
            <ChevronRight size={16} className="sb-chev" aria-hidden="true" />
          </button>
          <dl className="sb-status sb-t" aria-label="Data sources">
            {status.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd><i className={`fd fd-${v ?? 'wait'}`} aria-hidden="true" />{v ? FEED_LABEL[v] : 'Checking'}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>
      <div className={`sb-scrim${open ? ' on' : ''}`} onClick={close} aria-hidden="true" />

      <header className="topbar" inert={open}>
        <div className="topbar-in">
          <button type="button" ref={drawer.opener} className="menu-btn" aria-label="Open menu" aria-expanded={open} aria-controls="sidebar" onClick={() => drawer.setOpen(true)}>
            <Menu size={24} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <Link href="/dashboard" className="brand" aria-label="Hedge 360 dashboard"><BrandMark /><span className="brand-name">Hedge 360</span></Link>
          <button type="button" className="profile-chip" onClick={editProfile} aria-label="Edit your trading profile">
            <span className={`dot ${appetite}`} />
            <span className="pc-text">{APPETITE_LABEL[appetite]}{profile.capital ? ` · ${words(profile.capital)}` : ''}</span>
          </button>
        </div>
      </header>

      <div className="app-main" inert={open}>
        {ready && profile.done ? children : <div className="loading">Loading your desk…</div>}
      </div>
      <Toast />
    </div>
  );
}
