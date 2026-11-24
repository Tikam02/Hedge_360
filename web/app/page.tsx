'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, CalendarClock, Check, Clock3, Coffee, MonitorDot, Zap } from 'lucide-react';
import { BrandMark } from '@/components/Shell';
import { OPTIONS, POSITIONS } from '@/lib/data';
import { useStore, type TimeAvail } from '@/lib/store';
import { APPETITE_LABEL, RULES, fmt, words, type Appetite } from '@/lib/util';
import { Suggestion } from '@/components/HedgeTicket';

const TIMES: Array<{ v: TimeAvail; t: string; s: string; icon: React.ReactNode }> = [
  { v: 'weekly', t: 'A few hours a week', s: 'Evenings or weekends. We favour monthly expiries.', icon: <CalendarClock size={20} /> },
  { v: '30m', t: 'Under 30 min a day', s: 'A quick look at the open and close.', icon: <Coffee size={20} /> },
  { v: '2h', t: '1 to 2 hours a day', s: 'Time to adjust positions during the session.', icon: <Clock3 size={20} /> },
  { v: 'full', t: 'Full market hours', s: 'Watching from 9:15 to 3:30.', icon: <MonitorDot size={20} /> },
];
const APPETITES: Array<{ v: Appetite; level: number; s: string }> = [
  { v: 'conservative', level: 1, s: 'Far out-of-the-money strikes, calm IV, small margin per trade.' },
  { v: 'moderate', level: 2, s: 'Balanced premium and safety.' },
  { v: 'aggressive', level: 3, s: 'Closer strikes and higher IV for more premium.' },
];
const CAPS = [500000, 1000000, 2500000, 5000000, 10000000];

export default function Page() {
  return <Suspense fallback={null}><Onboarding /></Suspense>;
}

function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const editing = params.get('edit') === '1';
  const { ready, profile, setProfile, showToast } = useStore();
  const [step, setStep] = useState(0);
  const [capText, setCapText] = useState('');

  useEffect(() => {
    if (!ready) return;
    if (profile.done && !editing) router.replace('/dashboard');
    setCapText(profile.capital ? fmt(profile.capital, 0) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const setCap = (v: number | null) => { setProfile({ capital: v }); setCapText(v ? fmt(v, 0) : ''); };
  const next = () => {
    if (step < 2) { setStep(step + 1); return; }
    setProfile({ done: true });
    showToast(`Profile saved. Trades are checked against a ${APPETITE_LABEL[profile.appetite ?? 'moderate'].toLowerCase()} risk appetite.`);
    router.push('/dashboard');
  };
  const canNext = step === 0 || (step === 1 && !!profile.time) || (step === 2 && !!profile.appetite);
  const sample = POSITIONS.find((p) => p.name === 'SENSEX 2nd w DEC 85000 CE')!;

  return (
    <div className="ob">
      <aside className="ob-side">
        <span className="brand"><BrandMark size={22} /><span className="brand-name">Hedge 360</span></span>
        <div className="ob-pitch">
          <h2>A hedge for every position, ready when you want it.</h2>
          <p>Screen option trades against your own risk rules, then cap the downside on any open position in one tap.</p>
        </div>
        <div className="ob-sample" aria-hidden="true">
          <div className="ob-sample-top">
            <div><div className="ob-sample-name"><span className="tag tag-prod">NRML</span> {sample.name}</div>
              <div className="ob-sample-sub tnum">Qty {sample.qty} · Avg {fmt(sample.avg)} · P&amp;L <span className="down">{fmt(sample.pnl)}</span></div></div>
            <span className="risk risk-highest">Highest risk</span>
          </div>
          <p><Suggestion text={sample.text} /></p>
          <span className="btn-hedge primary"><Zap size={16} /> Execute hedge</span>
        </div>
        <div className="ob-stats">
          <div><b>{OPTIONS.length}</b><span>options screened</span></div>
          <div><b>{POSITIONS.length}</b><span>live positions</span></div>
          <div><b>1 tap</b><span>to hedge any position</span></div>
        </div>
      </aside>

      <main className="ob-main">
        <ol className="ob-steps" aria-label="Setup progress">
          {['Capital', 'Time', 'Risk appetite'].map((l, i) => <li key={l} className={i < step ? 'done' : i === step ? 'cur' : ''}>{l}</li>)}
        </ol>

        {step === 0 && (
          <section className="ob-q" key="s0">
            <p className="eyebrow">Step 1 of 3 · Optional</p>
            <h1>How much capital do you plan to trade with?</h1>
            <p className="lede">We use it to flag trades whose margin takes too large a share of your capital. You can skip this.</p>
            <label className="money" htmlFor="cap">
              <span className="money-pre">₹</span>
              <input id="cap" inputMode="numeric" autoComplete="off" placeholder="25,00,000" value={capText} autoFocus
                onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 11); setCap(d ? +d : null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') next(); }} />
            </label>
            <p className="money-words">{profile.capital ? words(profile.capital) : ' '}</p>
            <div className="chips">
              {CAPS.map((c) => <button key={c} type="button" className={`chip${profile.capital === c ? ' on' : ''}`} onClick={() => setCap(c)}>{words(c)}</button>)}
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="ob-q" key="s1">
            <p className="eyebrow">Step 2 of 3</p>
            <h1>How much time can you give to trading?</h1>
            <p className="lede">Less time means positions that need fewer adjustments.</p>
            <div className="choices" role="radiogroup" aria-label="Time available">
              {TIMES.map((t) => (
                <button key={t.v} type="button" role="radio" aria-checked={profile.time === t.v} className={`choice${profile.time === t.v ? ' on' : ''}`} onClick={() => setProfile({ time: t.v })}>
                  {profile.time === t.v && <span className="tick"><Check size={15} strokeWidth={3} /></span>}
                  <span className="choice-icon">{t.icon}</span>
                  <span className="choice-t">{t.t}</span>
                  <span className="choice-s">{t.s}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="ob-q" key="s2">
            <p className="eyebrow">Step 3 of 3</p>
            <h1>What is your risk appetite?</h1>
            <p className="lede">This sets the checks every trade must pass before we call it a fit.</p>
            <div className="choices risk-choices" role="radiogroup" aria-label="Risk appetite">
              {APPETITES.map((a) => {
                const R = RULES[a.v];
                return (
                  <button key={a.v} type="button" role="radio" aria-checked={profile.appetite === a.v} className={`choice${profile.appetite === a.v ? ' on' : ''}`} onClick={() => setProfile({ appetite: a.v })}>
                    {profile.appetite === a.v && <span className="tick"><Check size={15} strokeWidth={3} /></span>}
                    <span className={`meter l${a.level}`}><i /><i /><i /></span>
                    <span className="choice-t">{APPETITE_LABEL[a.v]}</span>
                    <span className="choice-s">{a.s}</span>
                    <span className="rules">
                      <span>Strike <b>≥ {R.otm}%</b> OTM</span><span>IV <b>≤ {R.iv}%</b></span>
                      <span>OI <b>≥ {fmt(R.oi, 0)}</b></span><span>Margin <b>≤ {R.marginPct}%</b> of capital</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <div className="ob-actions">
          {step > 0 && <button type="button" className="btn btn-ghost btn-lg" onClick={() => setStep(step - 1)}>Back</button>}
          <div className="right">
            {step === 0 && <button type="button" className="btn btn-text btn-lg" onClick={() => { setCap(null); setStep(1); }}>Skip</button>}
            <button type="button" className="btn btn-primary btn-lg" disabled={!canNext} onClick={next}>
              {step === 2 ? 'Go to screener' : 'Continue'} <ArrowRight size={18} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
