'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, Copy, LogIn, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { ApiNotice, Skeleton } from '@/components/charts';
import { STATIC } from '@/lib/derivs';
import { kite, kiteUrl, type KiteStatus, type Totp } from '@/lib/kite';
import { useStore } from '@/lib/store';

/** Login state changed: the sidebar and Data sources re-read where the data now comes from. */
export const announce = () => window.dispatchEvent(new Event('kite-change'));
/** How the login window tells the Profile page that opened it how the login went (window.opener may not survive
 * Kite's pages, a BroadcastChannel does). */
export type LoginResult = { kite: 'connected' | 'failed'; user?: string; detail?: string };
export const CHANNEL = 'hedge360-kite';
const istTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ── Zerodha ──────────────────────────────────────────
export function Zerodha() {
  const { showToast } = useStore();
  const [st, setSt] = useState<KiteStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => kite<KiteStatus>('/status').then((s) => { setSt(s); setErr(null); return s; }).catch((e: Error) => { setErr(e.message); return null; }), []);
  useEffect(() => { if (!STATIC) load(); }, [load]);
  const totp = useTotp(!!st?.has_totp_secret);

  if (STATIC) {
    return (
      <section className="ch-card" aria-labelledby="h-z">
        <header className="ch-head"><div><h2 id="h-z">Zerodha</h2><p>Live quotes, OI and margins through your own Kite Connect app.</p></div><span className="pf-pill">Not available here</span></header>
        <p className="pf-ro"><ShieldCheck size={17} aria-hidden="true" /> Logging in to Zerodha needs the analytics server running on your own machine. This demo site has no server, so every tab shows sample data.</p>
      </section>
    );
  }
  if (!st) return err ? <ApiNotice error={err} retry={load} /> : <Skeleton h={520} />;

  const logout = async () => {
    try { setSt({ ...st, ...(await kite<Partial<KiteStatus>>('/session', { method: 'DELETE' })) }); announce(); showToast('Logged out of Zerodha. The tabs are back on sample data.'); }
    catch (e) { setErr((e as Error).message); }
    load();
  };
  const steps = <>
    <li className={st.can_login ? 'done' : ''}><AppForm st={st} onSaved={setSt} /></li>
    <li className={st.has_totp_secret ? 'done' : ''}><TotpStep has={st.has_totp_secret} totp={totp} /></li>
  </>;

  return (
    <section className="ch-card pf-z" aria-labelledby="h-z">
      <header className="ch-head">
        <div><h2 id="h-z">Zerodha</h2><p>Live quotes, OI and margins through your own Kite Connect app.</p></div>
        <span className={`pf-pill${st.connected ? ' on' : st.expired ? ' warn' : ''}`}><i aria-hidden="true" />{st.connected ? 'Connected' : st.expired ? 'Session ended' : 'Not connected'}</span>
      </header>

      {st.connected ? (
        <>
          <div className="pf-acct">
            <span className="pf-av" aria-hidden="true">{(st.user_name || st.user_id || 'Z').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
            <div className="pf-who"><b>{st.user_name || st.user_id}</b><small>{[st.user_id, st.broker || 'Zerodha'].filter(Boolean).join(' · ')}</small></div>
            <dl className="pf-facts">
              {st.login_time && <div><dt>Logged in</dt><dd>{istTime(st.login_time)}</dd></div>}
              <div><dt>Session ends</dt><dd>06:00 IST</dd></div>
            </dl>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}><LogOut size={16} aria-hidden="true" /> Log out</button>
          </div>
          <details className="pf-more">
            <summary>Kite Connect app and TOTP</summary>
            <ol className="pf-steps">{steps}</ol>
          </details>
        </>
      ) : (
        <>
          {st.expired && <p className="pf-warn"><CircleAlert size={16} aria-hidden="true" /> Kite ends every session at 06:00 IST. Log in again to bring back live data.</p>}
          <ol className="pf-steps">
            {steps}
            <li><LoginStep st={st} code={totp.code} onConnected={(s) => { setSt(s); announce(); showToast(`Zerodha connected as ${s.user_name || s.user_id}. Sectors and the option chain now show live data.`); }} /></li>
          </ol>
        </>
      )}

      <p className="pf-ro">
        <ShieldCheck size={17} aria-hidden="true" />
        <span>Read only. Hedge 360 uses this session for quotes, open interest and margin figures; it never places, changes or cancels an order.
          You type your Zerodha password on Zerodha’s own page, so it never reaches this app. The API secret and TOTP secret stay encrypted on the server.</span>
      </p>
    </section>
  );
}

function useTotp(has: boolean) {
  const [now, setNow] = useState(() => Date.now());
  const [t, setT] = useState<Totp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!has) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [has]);
  const win = Math.floor(now / 30000);
  useEffect(() => {
    if (!has) { setT(null); return; }
    let dead = false;
    kite<Totp>('/totp').then((x) => { if (!dead) { setT(x); setErr(null); } }).catch((e: Error) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [has, win]);
  return { code: has ? t?.code ?? null : null, left: 30 - (Math.floor(now / 1000) % 30), error: err };
}

export function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <p className={`pf-msg ${m.ok ? 'ok' : 'bad'}`} role={m.ok ? 'status' : 'alert'}>{m.text}</p> : null;
}

export function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {});
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={copy} aria-label={label}>
      {done ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Saved({ on, unreadable }: { on: boolean; unreadable: boolean }) {
  if (unreadable) return <span className="pf-tag warn">Paste again</span>;
  return on ? <span className="pf-tag"><Check size={13} aria-hidden="true" /> Saved</span> : null;
}

function AppForm({ st, onSaved }: { st: KiteStatus; onSaved: (s: KiteStatus) => void }) {
  const [key, setKey] = useState(st.api_key);
  const [secret, setSecret] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const s = await kite<KiteStatus>('/credentials', { method: 'POST', body: { api_key: key.trim() || null, api_secret: secret.trim() || null, totp_secret: totpSecret.trim() || null } });
      setSecret(''); setTotpSecret(''); onSaved(s);
      setMsg({ ok: true, text: 'Saved. The secrets are encrypted on the server and won’t be shown again.' });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    finally { setBusy(false); }
  };
  const forget = async () => {
    setBusy(true);
    try { const s = await kite<KiteStatus>('/credentials', { method: 'DELETE' }); onSaved(s); announce(); setKey(s.api_key); setMsg({ ok: true, text: 'Forgotten, and logged out.' }); }
    catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    finally { setBusy(false); setForgetting(false); }
  };
  const anySaved = st.source === 'saved' || st.has_totp_secret;

  return (
    <>
      <h3>Your Kite Connect app</h3>
      <p className="pf-hint">Create an app at developers.kite.trade (market data access), then copy its API key and secret here.</p>
      {st.source === 'env' && <p className="pf-hint">Using KITE_API_KEY from the server’s environment. Saving here takes its place.</p>}
      <form className="pf-form" onSubmit={save} autoComplete="off">
        <div className="field">
          <label htmlFor="k-key">API key <Saved on={st.source === 'saved'} unreadable={false} /></label>
          <input id="k-key" name="kite-api-key" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" placeholder="From your app on developers.kite.trade" />
        </div>
        <div className="field">
          <label htmlFor="k-secret">API secret <Saved on={st.has_api_secret} unreadable={st.unreadable.includes('api_secret')} /></label>
          <input id="k-secret" name="kite-api-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password"
            placeholder={st.has_api_secret ? 'Saved. Leave blank to keep it' : 'From the same app'} />
        </div>
        <div className="field">
          <label htmlFor="k-totp">TOTP secret <small className="muted">optional</small> <Saved on={st.has_totp_secret} unreadable={st.unreadable.includes('totp_secret')} /></label>
          <input id="k-totp" name="kite-totp-secret" type="password" value={totpSecret} onChange={(e) => setTotpSecret(e.target.value)} autoComplete="new-password" spellCheck={false}
            placeholder={st.has_totp_secret ? 'Saved. Leave blank to keep it' : 'The key under the QR code in Zerodha’s 2FA setup'} />
        </div>
        <div className="pf-redirect">
          <span>Set your app’s Redirect URL to</span><code>{st.redirect_url}</code><CopyBtn text={st.redirect_url} label="Copy the redirect URL" />
        </div>
        <div className="pf-row">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save</button>
          {anySaved && (forgetting
            ? <><span className="pf-hint">Forget the key and both secrets, and log out?</span>
                <button type="button" className="btn btn-ghost btn-sm pf-danger" onClick={forget} disabled={busy}>Forget</button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setForgetting(false)}>Keep</button></>
            : <button type="button" className="btn btn-text btn-sm" onClick={() => setForgetting(true)}><Trash2 size={15} aria-hidden="true" /> Forget saved details</button>)}
        </div>
        <Msg m={msg} />
      </form>
    </>
  );
}

function TotpStep({ has, totp }: { has: boolean; totp: ReturnType<typeof useTotp> }) {
  const urgent = totp.left <= 5;
  return (
    <>
      <h3>TOTP code</h3>
      {!has ? (
        <p className="pf-hint">Save a TOTP secret above to get the code here, or read it from your authenticator app as usual.</p>
      ) : totp.error ? (
        <p className="pf-msg bad" role="alert">{totp.error}</p>
      ) : (
        <>
          <p className="pf-hint">Kite asks for this after your password. It changes every 30 seconds.</p>
          <div className={`pf-totp${urgent ? ' urgent' : ''}`}>
            <span className="pf-code" aria-live="polite">{totp.code ? `${totp.code.slice(0, 3)} ${totp.code.slice(3)}` : '··· ···'}</span>
            <span className="pf-bar"><span><i style={{ width: `${(totp.left / 30) * 100}%` }} /></span>{totp.left}s left</span>
            {totp.code && <CopyBtn text={totp.code} label="Copy the TOTP code" />}
          </div>
        </>
      )}
    </>
  );
}

function LoginStep({ st, code, onConnected }: { st: KiteStatus; code: string | null; onConnected: (s: KiteStatus) => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pasted, setPasted] = useState('');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (poll.current) clearInterval(poll.current); poll.current = null; setWaiting(false); };
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);
  // A failed login reports here from the login window, so this page stops waiting and says why.
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (e: MessageEvent<LoginResult>) => {
      if (e.data?.kite !== 'failed' || !poll.current) return;
      stop();
      setMsg({ ok: false, text: e.data.detail || 'The Zerodha login didn’t complete.' });
    };
    return () => ch.close();
  }, []);

  const go = () => {
    // Copy without waiting: the window has to open in the same click, or Safari blocks it.
    if (code) navigator.clipboard.writeText(code).catch(() => {});
    // A login window keeps this page, and the TOTP code, in view. If the browser blocks it, use this tab.
    const w = window.open(kiteUrl('/login?popup=1'), 'kite-login', 'popup,width=520,height=760');
    if (!w) { window.location.href = kiteUrl('/login'); return; }
    setWaiting(true); setMsg(null);
    let tries = 0;
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      tries += 1;
      const s = await kite<KiteStatus>('/status').catch(() => null);
      if (s?.connected) { stop(); onConnected(s); }
      else if (tries > 150) stop();
    }, 2000);
  };
  const exchange = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await kite('/session', { method: 'POST', body: { url: pasted } });
      setPasted('');
      onConnected(await kite<KiteStatus>('/status'));
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  };

  return (
    <>
      <h3>Log in</h3>
      <p className="pf-hint">
        Opens Kite’s login page. {code ? 'The TOTP code is copied as you click, ready to paste. ' : ''}Kite brings you back here when you’re done.
      </p>
      <div className="pf-row">
        <button type="button" className="btn btn-primary" onClick={go} disabled={!st.can_login}><LogIn size={18} aria-hidden="true" /> Log in with Zerodha</button>
        {!st.can_login && <span className="pf-hint">Save your API key and secret first.</span>}
        {waiting && <span className="pf-hint" role="status">Waiting for the login to finish…</span>}
      </div>
      <details className="pf-more">
        <summary>Kite sent you somewhere else?</summary>
        <form className="pf-paste" onSubmit={exchange}>
          <label htmlFor="k-paste" className="pf-hint">If your app’s Redirect URL points elsewhere, paste the full address Kite sent you to.</label>
          <div className="pf-row">
            <input id="k-paste" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…?request_token=…&status=success" spellCheck={false} autoComplete="off" />
            <button type="submit" className="btn btn-ghost btn-sm" disabled={!pasted.trim()}>Connect</button>
          </div>
        </form>
      </details>
      <Msg m={msg} />
    </>
  );
}
