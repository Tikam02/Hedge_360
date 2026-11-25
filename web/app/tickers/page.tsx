'use client';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeftRight, Ban, NotebookPen } from 'lucide-react';
import Shell from '@/components/Shell';
import { STATIC, useApi, type FnoResp } from '@/lib/derivs';
import { Blacklist } from './blacklist';
import { FnoList } from './fno';
import { StockNotes } from './notes';

export default function TickersPage() {
  return <Shell><Suspense fallback={null}><Tickers /></Suspense></Shell>;
}

const TABS = [
  { id: 'blacklist', label: 'Blacklist', icon: Ban, blurb: 'Stocks you never want to sell options on. The Screener leaves them out.' },
  { id: 'fno', label: 'F&O in and out', icon: ArrowLeftRight, blurb: 'Which stocks are in F&O today, which are leaving, and which joined or left.' },
  { id: 'notes', label: 'Stock notes', icon: NotebookPen, blurb: 'What you know about each stock: results dates, news, how it behaves.' },
] as const;
type TabId = (typeof TABS)[number]['id'];
// The demo site has no server, so no blacklist or notes there.
const SHOWN = TABS.filter((t) => !STATIC || t.id === 'fno');

function Tickers() {
  const router = useRouter();
  const params = useSearchParams();
  const tab: TabId = SHOWN.find((t) => t.id === params.get('tab'))?.id ?? SHOWN[0].id;
  const open = (id: TabId) => router.replace(id === SHOWN[0].id ? '/tickers' : `/tickers?tab=${id}`, { scroll: false });
  // Every tab picks symbols from today's F&O list, so it is loaded once here.
  const fno = useApi<FnoResp>('/fno');
  const cur = TABS.find((t) => t.id === tab)!;
  return (
    <main className="page pt pf">
      <header className="pt-head">
        <div className="pt-title">
          <h1>Ticker Data</h1>
          <p>{cur.blurb}</p>
        </div>
      </header>
      <nav className="pf-tabs" aria-label="Ticker data sections">
        {SHOWN.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} className={tab === id ? 'on' : ''} onClick={() => open(id)}>
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>
      {tab === 'blacklist' && <Blacklist fno={fno.data} />}
      {tab === 'fno' && <FnoList api={fno} />}
      {tab === 'notes' && <StockNotes fno={fno.data} />}
    </main>
  );
}
