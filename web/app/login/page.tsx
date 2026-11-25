'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleAlert, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/Shell';
import { safeNext, useAccount, type User } from '@/lib/account';
import { API_CMD, STATIC } from '@/lib/derivs';

export default function LoginPage() {
  return <Suspense fallback={null}><Login /></Suspense>;
}

type Mode = 'in' | 'up';

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, ready, error, signIn, signUp, refresh } = useAccount();
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'up' ? 'up' : 'in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const go = (u: User) => router.replace(u.profile.done ? safeNext(params.get('next')) ?? '/dashboard' : '/');
  // Already signed in (or back on this page by mistake): carry on.
  useEffect(() => { if (user) go(user); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try { go(mode === 'in' ? await signIn(email.trim(), password) : await signUp(email.trim(), password, name.trim())); }
    catch (err) { setMsg((err as Error).message); setBusy(false); }
  };
  const swap = (m: Mode) => { setMode(m); setMsg(null); };
  const down = msg === 'offline' || error === 'offline' ? 'offline' : error;

  return (
    <div className="ob lg">
      <aside className="ob-side">
        <span className="brand"><BrandMark size={22} /><span className="brand-name">Hedge 360</span></span>
        <div className="ob-pitch">
          <h2>Your risk rules, journal and notes in one desk.</h2>
          <p>Sign in to keep your trading profile, trade journal and notes on your own Hedge 360 server.</p>
        </div>
        <ul className="lg-points">
          <li><ShieldCheck size={18} aria-hidden="true" /> Read only: Hedge 360 never places an order.</li>
          <li><LockKeyhole size={18} aria-hidden="true" /> Passwords are stored as Argon2 hashes, never as text.</li>
        </ul>
      </aside>

      <main className="ob-main">
        {STATIC ? (
          <section className="lg-card">
            <h1>No sign-in on the demo</h1>
            <p className="lede">Accounts live on the Hedge 360 server you run yourself. This demo site has no server, so it keeps your trading profile in this browser.</p>
            <Link className="btn btn-primary" href="/">Continue to the demo</Link>
          </section>
        ) : (
          <section className="lg-card" aria-labelledby="lg-h">
            <div className="lg-tabs" role="tablist" aria-label="Sign in or create an account">
              <button type="button" role="tab" aria-selected={mode === 'in'} className={mode === 'in' ? 'on' : ''} onClick={() => swap('in')}>Sign in</button>
              <button type="button" role="tab" aria-selected={mode === 'up'} className={mode === 'up' ? 'on' : ''} onClick={() => swap('up')}>Create account</button>
            </div>
            <h1 id="lg-h">{mode === 'in' ? 'Welcome back' : 'Create your account'}</h1>
            <p className="lede">{mode === 'in' ? 'Sign in with your email and password.' : 'Your account keeps your risk profile, journal and notes.'}</p>

            {down && (
              <div className="lg-alert" role="alert">
                <CircleAlert size={18} aria-hidden="true" />
                <div>
                  {down === 'offline'
                    ? <><b>Can’t reach the Hedge 360 server.</b> Start it from the project root, then try again: <code>{API_CMD}</code></>
                    : <><b>The server can’t sign anyone in right now.</b> {down}</>}
                </div>
                <button type="button" className="btn btn-text btn-sm" onClick={() => { setMsg(null); refresh(); }}>Try again</button>
              </div>
            )}

            <form className="lg-form" onSubmit={submit}>
              {mode === 'up' && (
                <div className="field">
                  <label htmlFor="lg-name">Name <small className="muted">optional</small></label>
                  <input id="lg-name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
                </div>
              )}
              <div className="field">
                <label htmlFor="lg-email">Email</label>
                <input id="lg-email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoFocus />
              </div>
              <div className="field">
                <label htmlFor="lg-pw">Password {mode === 'up' && <small className="muted">at least 8 characters</small>}</label>
                <div className="lg-pw">
                  <input id="lg-pw" name="password" type={show ? 'text' : 'password'} autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                    required minLength={mode === 'up' ? 8 : undefined} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" className="lg-eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                    {show ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>
              </div>
              {msg && msg !== 'offline' && <p className="pf-msg bad" role="alert">{msg}</p>}
              <button type="submit" className="btn btn-primary lg-submit" disabled={busy || !ready}>
                {busy ? (mode === 'in' ? 'Signing in…' : 'Creating account…') : mode === 'in' ? 'Sign in' : 'Create account'}
              </button>
            </form>
            <p className="lg-switch">
              {mode === 'in'
                ? <>New to Hedge 360? <button type="button" className="btn-link" onClick={() => swap('up')}>Create an account</button></>
                : <>Already have an account? <button type="button" className="btn-link" onClick={() => swap('in')}>Sign in</button></>}
            </p>
            {mode === 'in' && <p className="lg-fine">Forgot your password? There’s no email reset yet: whoever runs this server can set a new one.</p>}
          </section>
        )}
      </main>
    </div>
  );
}
