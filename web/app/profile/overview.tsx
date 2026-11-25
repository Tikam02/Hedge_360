'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, KeyRound, LogIn, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { AppetiteMeter, Avatar, RiskFactors, TIME_LABEL } from '@/components/ProfileMenu';
import { api, useAccount, type User } from '@/lib/account';
import { STATIC, apiUrl } from '@/lib/derivs';
import { kite, type KiteStatus } from '@/lib/kite';
import { useStore } from '@/lib/store';
import { APPETITE_LABEL, words } from '@/lib/util';
import { Msg } from './zerodha';

const PIC = 256;

/** Square-crops and shrinks a photo to PIC×PIC JPEG in the browser, so a phone photo uploads as ~20 KB. */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok();
      img.onerror = () => bad(new Error('That file isn’t an image this browser can read. Use a JPEG, PNG or WebP.'));
      img.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = PIC;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PIC, PIC);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('Couldn’t prepare the picture.'))), 'image/jpeg', 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Overview() {
  return (
    <div className="pf-grid">
      <div className="pf-side">
        {STATIC ? <DemoAccount /> : <><AccountCard /><PasswordCard /></>}
      </div>
      <div className="pf-side">
        {!STATIC && <ZerodhaSummary />}
        <RiskCard />
        <DataSources />
      </div>
    </div>
  );
}

function DemoAccount() {
  return (
    <section className="ch-card" aria-labelledby="h-acct">
      <header className="ch-head"><div><h2 id="h-acct">Account</h2><p>Sign-in, your picture, the journal and notes live on the Hedge 360 server.</p></div></header>
      <p className="pf-ro"><ShieldCheck size={17} aria-hidden="true" /> This demo site has no server, so there are no accounts here. Your trading profile is kept in this browser.</p>
    </section>
  );
}

function AccountCard() {
  const { user, setUser } = useAccount();
  const { showToast } = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState<'pic' | 'name' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setName(user?.name ?? ''), [user?.name]);
  if (!user) return null;

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy('pic'); setMsg(null);
    try { setUser(await api<User>('/api/me/avatar', { method: 'PUT', blob: await shrink(f) })); showToast('Picture updated.'); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(null); if (file.current) file.current.value = ''; }
  };
  const remove = async () => {
    setBusy('pic'); setMsg(null);
    try { setUser(await api<User>('/api/me/avatar', { method: 'DELETE' })); showToast('Picture removed.'); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setMsg({ ok: false, text: 'Write a name first.' }); return; }
    setBusy('name'); setMsg(null);
    try { setUser(await api<User>('/api/me', { method: 'PATCH', body: { name: name.trim() } })); setMsg({ ok: true, text: 'Name saved.' }); }
    catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    finally { setBusy(null); }
  };
  const since = new Date(user.createdAt).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <section className="ch-card" aria-labelledby="h-acct">
      <header className="ch-head"><div><h2 id="h-acct">Account</h2><p>Your name and picture show in the sidebar menu.</p></div></header>
      <div className="pf-me">
        <div className="pf-pic">
          <Avatar size={88} />
          <button type="button" className="pf-cam" onClick={() => file.current?.click()} disabled={busy === 'pic'} aria-label="Change picture"><Camera size={16} aria-hidden="true" /></button>
        </div>
        <div className="pf-me-t">
          <b>{user.name || user.email.split('@')[0]}</b>
          <span>{user.email}</span>
          <small>Member since {since}</small>
          <div className="pf-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => file.current?.click()} disabled={busy === 'pic'}>{busy === 'pic' ? 'Uploading…' : user.avatar ? 'Change picture' : 'Add a picture'}</button>
            {user.avatar && <button type="button" className="btn btn-text btn-sm" onClick={remove} disabled={busy === 'pic'}>Remove</button>}
          </div>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </div>
      </div>
      <form className="pf-form pf-name" onSubmit={rename}>
        <div className="field"><label htmlFor="pf-name">Name</label>
          <div className="pf-row"><input id="pf-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="How Hedge 360 greets you" />
            <button type="submit" className="btn btn-ghost btn-sm" disabled={busy === 'name' || name.trim() === user.name}>Save</button></div></div>
      </form>
      <Msg m={msg} />
    </section>
  );
}

function PasswordCard() {
  const { user } = useAccount();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) { setMsg({ ok: false, text: 'Use at least 8 characters for the new password.' }); return; }
    if (next !== again) { setMsg({ ok: false, text: 'The two new passwords don’t match.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api('/api/me/password', { method: 'POST', body: { current: cur, new: next } });
      setCur(''); setNext(''); setAgain('');
      setMsg({ ok: true, text: 'Password changed. Any other browser signed in to this account has been signed out.' });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <section className="ch-card" aria-labelledby="h-pw">
      <header className="ch-head"><div><h2 id="h-pw">Password</h2><p>Changing it signs out every other browser using this account.</p></div><KeyRound size={18} className="muted" aria-hidden="true" /></header>
      <form className="pf-form" onSubmit={submit}>
        <input type="email" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
        <div className="field"><label htmlFor="pw-cur">Current password</label><input id="pw-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw-new">New password <small className="muted">at least 8 characters</small></label><input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw-again">New password again</label><input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></div>
        <div className="pf-row"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button></div>
        <Msg m={msg} />
      </form>
    </section>
  );
}

/** Whether Zerodha is connected, at a glance, with the way in to connect it. The full login is on the Zerodha tab. */
function ZerodhaSummary() {
  const router = useRouter();
  const [st, setSt] = useState<KiteStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const read = () => kite<KiteStatus>('/status').then((s) => { setSt(s); setErr(null); }).catch((e: Error) => setErr(e.message));
    read();
    window.addEventListener('kite-change', read);
    return () => window.removeEventListener('kite-change', read);
  }, []);
  const on = !!st?.connected;
  return (
    <section className={`ch-card pf-zs${on ? ' on' : ''}`} aria-labelledby="h-zs">
      <header className="ch-head">
        <div><h2 id="h-zs">Zerodha</h2><p>Live quotes, OI and margins for Sectors and the Option chain.</p></div>
        <span className={`pf-pill${on ? ' on' : st?.expired ? ' warn' : ''}`}><i aria-hidden="true" />{!st ? (err ? 'Unknown' : 'Checking') : on ? 'Connected' : st.expired ? 'Session ended' : 'Not connected'}</span>
      </header>
      {on ? (
        <p className="pf-zs-who">Logged in as <b>{st!.user_name || st!.user_id}</b>{st!.user_id && st!.user_name ? ` (${st!.user_id})` : ''}. Kite ends the session at 06:00 IST.</p>
      ) : (
        <p className="pf-zs-who">{st?.can_login ? 'Your Kite Connect app is saved. Log in to switch to live data.' : 'Add your Kite Connect app’s API key and secret, then log in.'}{err ? ` (${err === 'offline' ? 'can’t reach the server' : err})` : ''}</p>
      )}
      <div className="pf-row">
        <button type="button" className={`btn ${on ? 'btn-ghost' : 'btn-primary'} btn-sm`} onClick={() => router.replace('/profile?tab=zerodha', { scroll: false })}>
          {on ? 'Manage Zerodha' : <><LogIn size={16} aria-hidden="true" /> Connect Zerodha</>}
        </button>
      </div>
      <p className="pf-ro"><ShieldCheck size={17} aria-hidden="true" /> Read only: market data only. Hedge 360 never places, changes or cancels an order.</p>
    </section>
  );
}

function RiskCard() {
  const { profile } = useStore();
  const router = useRouter();
  const appetite = profile.appetite ?? 'moderate';
  return (
    <section className="ch-card" aria-labelledby="h-tp">
      <header className="ch-head">
        <div><h2 id="h-tp">Risk profile</h2><p>Trade checks and hedge suggestions use these.</p></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => router.push('/?edit=1')}><SlidersHorizontal size={15} aria-hidden="true" /> Edit</button>
      </header>
      <div className="pf-app">
        <div><small>Risk appetite</small><b>{APPETITE_LABEL[appetite]}</b></div>
        <AppetiteMeter appetite={appetite} />
      </div>
      <dl className="pf-list">
        <div><dt>Capital</dt><dd>{profile.capital ? words(profile.capital) : 'Not set'}</dd></div>
        <div><dt>Time for trading</dt><dd>{profile.time ? TIME_LABEL[profile.time] : 'Not set'}</dd></div>
      </dl>
      <div>
        <h3 className="pf-h3">Risk factors</h3>
        <p className="pf-hint">A trade passes the check only when it meets all four.</p>
        <RiskFactors appetite={appetite} capital={profile.capital} />
      </div>
    </section>
  );
}

type Feed = 'live' | 'sample' | 'offline';
const FEED: Record<Feed, string> = { live: 'Live', sample: 'Sample', offline: 'Offline' };

function DataSources() {
  const [h, setH] = useState<{ sectors: Feed; chain: Feed } | null>(null);
  useEffect(() => {
    const read = () => fetch(apiUrl('/health'), { credentials: 'include' }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setH).catch(() => setH({ sectors: 'offline', chain: 'offline' }));
    read();
    window.addEventListener('kite-change', read);
    return () => window.removeEventListener('kite-change', read);
  }, []);
  const row = (label: string, v: Feed | undefined) => (
    <div><dt>{label}</dt><dd><i className={`fd fd-${v ?? 'wait'}`} aria-hidden="true" />{v ? FEED[v] : 'Checking'}</dd></div>
  );
  return (
    <section className="ch-card" aria-labelledby="h-ds">
      <header className="ch-head"><div><h2 id="h-ds">Data sources</h2><p>Sectors and the option chain switch to live Kite data while Zerodha is connected.</p></div></header>
      <dl className="pf-list">
        {row('Positions', 'sample')}
        {row('Sector data', h?.sectors)}
        {row('Option chain', h?.chain)}
      </dl>
    </section>
  );
}
