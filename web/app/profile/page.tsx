'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BookOpen, Check, CircleAlert, NotebookPen, PlugZap, UserRound } from 'lucide-react';
import Shell from '@/components/Shell';
import { STATIC } from '@/lib/derivs';
import { useStore } from '@/lib/store';
import { Journal } from './journal';
import { Notes } from './notes';
import { Overview } from './overview';
import { CHANNEL, Zerodha, announce, type LoginResult } from './zerodha';

export default function ProfilePage() {
  return <Shell><Suspense fallback={null}><Profile /></Suspense></Shell>;
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: UserRound, blurb: 'Your account, risk profile and where the market data comes from.' },
  { id: 'journal', label: 'Journal', icon: BookOpen, blurb: 'A record of each trade: why you took it and how it went.' },
  { id: 'notes', label: 'Notes', icon: NotebookPen, blurb: 'Watchlists, rules and reminders, kept with your account.' },
  { id: 'zerodha', label: 'Zerodha', icon: PlugZap, blurb: 'The Zerodha login that feeds live quotes, OI and margins. Read only.' },
] as const;
type TabId = (typeof TABS)[number]['id'];
// The demo site has no server, so no journal or notes there.
const SHOWN = TABS.filter((t) => !STATIC || (t.id !== 'journal' && t.id !== 'notes'));

function Profile() {
  const router = useRouter();
  const params = useSearchParams();
  const { showToast } = useStore();
  const [flash, setFlash] = useState<string | null>(null);
  const [popupDone, setPopupDone] = useState(false);
  const asked = params.get('tab');
  const tab: TabId = SHOWN.find((t) => t.id === asked)?.id ?? (params.get('kite') ? 'zerodha' : 'overview');
  const open = (id: TabId) => router.replace(id === 'overview' ? '/profile' : `/profile?tab=${id}`, { scroll: false });

  // Back from Kite: /api/kite/callback sends the browser here with ?kite=connected or ?kite=failed&detail=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const result = q.get('kite');
    if (!result) return;
    const detail = q.get('detail') || 'The Zerodha login didn’t complete.';
    if (result === 'connected') announce();
    if (result === 'connected') showToast(`Zerodha connected${q.get('user') ? ` as ${q.get('user')}` : ''}. Sectors and the option chain now show live data.`);
    else setFlash(detail);
    if ('BroadcastChannel' in window) {
      const ch = new BroadcastChannel(CHANNEL);
      ch.postMessage({ kite: result === 'connected' ? 'connected' : 'failed', user: q.get('user') ?? undefined, detail } satisfies LoginResult);
      ch.close();
    }
    // The login window closes itself after a success; after a failure it stays open so the reason can be read.
    if (q.get('popup') === '1' && result === 'connected') { setPopupDone(true); window.close(); }
    router.replace('/profile?tab=zerodha');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cur = TABS.find((t) => t.id === tab)!;
  return (
    <main className="page pt pf">
      <header className="pt-head">
        <div className="pt-title">
          <h1>Profile</h1>
          <p>{cur.blurb}</p>
        </div>
      </header>
      <nav className="pf-tabs" aria-label="Profile sections">
        {SHOWN.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} className={tab === id ? 'on' : ''} onClick={() => open(id)}>
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>
      {popupDone && <p className="pf-ro"><Check size={17} aria-hidden="true" /> Login finished. You can close this window and go back to Hedge 360.</p>}
      {flash && (
        <div className="pf-flash" role="alert">
          <CircleAlert size={18} aria-hidden="true" /><span>{flash}</span>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}
      {tab === 'overview' && <Overview />}
      {tab === 'journal' && <Journal />}
      {tab === 'notes' && <Notes />}
      {tab === 'zerodha' && <div className="pf-zwrap"><Zerodha /></div>}
    </main>
  );
}
