/* matrix-auth.jsx — Matrix-style login screen, identity chip in topbar,
 * and the members management dialog for a space.
 *
 * Login UI is client-side until submit. Member management operates on the
 * real Matrix room when signed in (invite / kick / set power level via the
 * live bridge); in demo mode it's hidden because there's no homeserver.
 */

(function () {
const { useState, useEffect, useRef, useMemo } = React;

const SESSION_KEY = 'matrix-events.session.v1';
const LEGACY_SPACES_KEY  = 'matrix-events.spaces.v1';

// One-time migration: wipe the now-removed demo spaces blob so it stops
// taking up localStorage for users upgrading from the old UI.
try { localStorage.removeItem(LEGACY_SPACES_KEY); } catch {}

// ─────────────────────────────────────────────────────────────────────────
// Hard reset from source — re-fetch the app CODE, keep the DATA.
//
// This app's html/jsx assets ship with un-hashed filenames, so a stale
// service-worker shell or browser HTTP cache can keep serving an old build
// after a deploy ("I don't see the new page"). This nukes exactly the code
// layer — the service worker registration + its shell caches — and reloads
// from the network. It deliberately does NOT touch OPFS, IndexedDB, or the
// localStorage/sessionStorage vault stash, so your encrypted workspace cache
// and saved session survive: only the app shell is re-downloaded.
// ─────────────────────────────────────────────────────────────────────────

async function hardResetFromSource() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
  } catch (e) { console.warn('[reset] SW unregister failed:', e); }

  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      // The PWA shell caches are the only thing we manage here; clearing all
      // Cache Storage is safe because this app keeps no data there (history is
      // in OPFS, media in OPFS, sessions in IndexedDB/localStorage).
      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
    }
  } catch (e) { console.warn('[reset] cache clear failed:', e); }

  // Cache-busted reload so the browser HTTP cache can't re-serve a stale
  // index.html / *.jsx either. Strip any existing buster first so they don't
  // accumulate across resets.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('fresh', Date.now().toString(36));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Only demo sessions are restored from localStorage. Real Matrix
    // sessions live in the bridge: the vault key is stashed in
    // sessionStorage so a tab refresh re-adopts it and brings the
    // client back online without a password prompt.
    if (s && s.demo) return s;
    return null;
  } catch { return null; }
}
function saveSession(s) {
  // Only persist demo sessions. Real sessions are tracked by the bridge.
  if (s && s.demo) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else             localStorage.removeItem(SESSION_KEY);
}

function useSession() {
  const ML = typeof window !== 'undefined' ? window.MatrixLive : null;

  const [session, setSession] = useState(() => {
    const demo = loadSession();
    if (demo) return demo;
    return ML?.getSession?.() || null;
  });
  const [booting, setBooting] = useState(() => !!ML?.isBooting?.());

  // The bridge runs an async auto-restore on cold boot; subscribe so
  // React picks up the resumed session (or the "nothing to resume"
  // signal) without flashing the login screen.
  useEffect(() => {
    const M = window.MatrixLive;
    if (!M?.subscribe) return;
    return M.subscribe((reason) => {
      if (reason !== 'session') return;
      setBooting(!!M.isBooting?.());
      setSession((current) => {
        if (current?.demo) return current;       // demo is user-driven
        const live = M.getSession?.() || null;
        if (live) return live;
        // Bridge says no session. If we thought we were authed for real,
        // drop down to the login screen.
        return current && !current.demo ? null : current;
      });
    });
  }, []);

  useEffect(() => { saveSession(session); }, [session]);
  return [session, setSession, booting];
}

// ─────────────────────────────────────────────────────────────────────────
// Members — live view of a Matrix room's join + invite + power levels
// ─────────────────────────────────────────────────────────────────────────

function useMembers(roomId) {
  const ML = window.MatrixLive;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ML || !roomId) return;
    return ML.subscribe((reason) => {
      if (reason === 'members' || reason === 'rooms') setTick(t => t + 1);
    });
  }, [ML, roomId]);
  return useMemo(() => {
    if (!ML || !roomId) return { members: [], myPowerLevel: 0 };
    return {
      members: ML.membersOf(roomId) || [],
      myPowerLevel: ML.myPowerLevelIn ? ML.myPowerLevelIn(roomId) : 0,
    };
  }, [ML, roomId, tick]);
}

// ─────────────────────────────────────────────────────────────────────────
// BootSplash — shown while the bridge is auto-restoring a session from
// the sessionStorage vault stash. Brief by design: the bridge resolves
// quickly to either a live session or "nothing to resume", and the
// app immediately swaps to either the workspace or the LoginScreen.
// ─────────────────────────────────────────────────────────────────────────

function BootSplash() {
  return (
    <div className="login-shell">
      <div className="login-card" style={{maxWidth:340}}>
        <div className="login-head">
          <div className="login-brand">
            <span className="login-brand-mark">▦</span>
            <span>workspace</span>
          </div>
          <div className="login-sub">resuming session…</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// AppResetLink — "stuck on an old version?" escape hatch for stale PWA shells.
// Re-fetches the app code from source without touching local data. A small
// inline confirm guards against accidental taps.
// ─────────────────────────────────────────────────────────────────────────

function AppResetLink() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    await hardResetFromSource();   // navigates away; state cleanup is moot
  }

  if (busy) {
    return <span className="login-reset busy">reloading latest version…</span>;
  }
  if (confirming) {
    return (
      <span className="login-reset">
        reload the app from source? your data &amp; session stay.{' '}
        <button className="login-reset-go" onClick={run}>reset</button>
        <button className="login-reset-cancel" onClick={() => setConfirming(false)}>cancel</button>
      </span>
    );
  }
  return (
    <button
      className="login-reset-link"
      onClick={() => setConfirming(true)}
      title="re-download the latest app code and clear the offline (PWA) cache. Your encrypted local data and saved session are kept."
    >
      stuck on an old version? reset app from source
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PasswordResetBody — "forgot password" flow embedded in the login card.
//
// Matrix resets a forgotten password by email: the homeserver mails a
// verification link, and only after the user clicks it does the new password
// take effect. Two steps mirror that: (1) request the email, (2) click the
// link then set the new password. Requires the account to have a verified
// email and the homeserver to support email-based reset.
// ─────────────────────────────────────────────────────────────────────────

function PasswordResetBody({ defaultHomeserver, onBack }) {
  const ML = window.MatrixLive;
  const [step, setStep]           = useState(1);   // 1 = email · 2 = new password
  const [homeserver, setHomeserver] = useState(defaultHomeserver || 'matrix.org');
  const [email, setEmail]         = useState('');
  const [creds, setCreds]         = useState(null);
  const [pw, setPw]               = useState('');
  const [pw2, setPw2]             = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState(null);
  const [done, setDone]           = useState(false);
  const firstRef = useRef(null);
  useEffect(() => { firstRef.current?.focus(); }, [step]);

  async function sendEmail() {
    setErr(null);
    const hs = homeserver.trim().replace(/^https?:\/\//, '');
    if (!email.trim()) { setErr('email address required'); return; }
    if (!hs)           { setErr('homeserver required'); return; }
    if (!ML?.requestPasswordReset) { setErr('matrix bridge not loaded yet — please refresh'); return; }
    setBusy(true);
    try {
      const c = await ML.requestPasswordReset(hs, email.trim());
      setCreds(c);
      setStep(2);
    } catch (e) {
      setErr(e?.message || 'could not send the reset email');
    } finally { setBusy(false); }
  }

  async function setNewPassword() {
    setErr(null);
    if (pw.length < 8) { setErr('use at least 8 characters'); return; }
    if (pw !== pw2)    { setErr('passwords do not match'); return; }
    setBusy(true);
    try {
      await ML.completePasswordReset(creds, pw);
      setDone(true);
    } catch (e) {
      setErr(e?.message || 'could not set the new password');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="login-body">
        <div className="register-pitch" style={{borderLeftColor:'var(--triad-structure)'}}>
          <div className="register-pitch-title">password updated ✓</div>
          <div className="register-pitch-body">
            your password has been reset and every other session was signed out.
            sign in with your new password to continue.
          </div>
        </div>
        <button className="login-primary" onClick={onBack}>back to sign in</button>
      </div>
    );
  }

  return (
    <div className="login-body">
      <div className="login-resetnav">
        <button className="login-linkbtn" onClick={onBack}>← back to sign in</button>
        <span className="login-step">step {step} of 2</span>
      </div>

      {step === 1 ? (
        <>
          <div className="login-sub" style={{marginTop:-4}}>
            we'll email you a link to reset your password.
          </div>
          <label className="login-field">
            <span className="login-label">email on your account</span>
            <div className="login-input-wrap">
              <input
                ref={firstRef}
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                spellCheck={false}
                disabled={busy}
                onKeyDown={e => { if (e.key === 'Enter') sendEmail(); }}
              />
            </div>
          </label>
          <label className="login-field">
            <span className="login-label">homeserver</span>
            <div className="login-input-wrap">
              <span className="login-prefix">https://</span>
              <input
                value={homeserver}
                onChange={e => setHomeserver(e.target.value)}
                placeholder="matrix.org"
                spellCheck={false}
                disabled={busy}
              />
            </div>
            <span className="login-hint">where your account lives</span>
          </label>
          {err && <div className="login-err">{err}</div>}
          <div className="login-actions">
            <button className="login-primary" disabled={busy} onClick={sendEmail}>
              {busy ? 'sending…' : 'send reset email'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="register-pitch" style={{borderLeftColor:'var(--triad-structure)'}}>
            <div className="register-pitch-title">check your inbox</div>
            <div className="register-pitch-body">
              we emailed <b>{email}</b> a verification link. <b>open it and confirm</b>,
              then come back here and set your new password below.
            </div>
          </div>
          <label className="login-field">
            <span className="login-label">new password</span>
            <div className="login-input-wrap">
              <input
                ref={firstRef}
                type="password"
                value={pw}
                onChange={e => setPw(e.target.value)}
                placeholder="••••••••"
                disabled={busy}
              />
            </div>
          </label>
          <label className="login-field">
            <span className="login-label">confirm new password</span>
            <div className="login-input-wrap">
              <input
                type="password"
                value={pw2}
                onChange={e => setPw2(e.target.value)}
                placeholder="••••••••"
                disabled={busy}
                onKeyDown={e => { if (e.key === 'Enter') setNewPassword(); }}
              />
            </div>
          </label>
          {err && <div className="login-err">{err}</div>}
          <div className="login-actions">
            <button className="login-primary" disabled={busy} onClick={setNewPassword}>
              {busy ? 'updating…' : 'set new password'}
            </button>
            <button className="login-ghost" disabled={busy} onClick={() => { setStep(1); setErr(null); }}>
              resend email
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LoginScreen — gates the app
// ─────────────────────────────────────────────────────────────────────────

function LoginScreen({ onSignIn }) {
  const ML = window.MatrixLive;
  const lastUser = ML?.getLastUser?.() || '';
  const lastLocal = lastUser ? lastUser.replace(/^@/, '').split(':')[0] : '';
  const lastHs    = lastUser && lastUser.includes(':') ? lastUser.split(':')[1] : '';
  const hasAccount = lastUser ? !!ML?.hasLocalAccount?.(lastUser) : false;

  const [homeserver, setHomeserver] = useState(lastHs || 'matrix.org');
  const [username, setUsername]     = useState(lastLocal);
  const [password, setPassword]     = useState('');
  // Persist the unlock key across browser restarts so the user isn't
  // prompted again on every cold boot. Defaults on for convenience; see
  // the security note in vault.js (PERSIST_STASH_KEY).
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState(null);
  const [mode, setMode]             = useState('signin'); // 'signin' | 'register'
  const userRef = useRef(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  const fqMatch = username.trim().match(/^@?([^:\s]+):([^\s]+)$/);
  const usernameIncludesServer = !!fqMatch;
  const effectiveHomeserver = usernameIncludesServer ? fqMatch[2] : homeserver;
  const effectiveUser        = usernameIncludesServer ? fqMatch[1] : username.replace(/^@/, '').trim();

  async function submit() {
    setErr(null);
    const u  = effectiveUser;
    const hs = effectiveHomeserver.trim().replace(/^https?:\/\//, '');
    if (!u || !hs) { setErr('username and homeserver required'); return; }
    if (!password) { setErr('password required'); return; }
    if (!ML || typeof ML.login !== 'function') {
      setErr('matrix bridge not loaded yet — please refresh');
      return;
    }
    setBusy(true);
    try {
      const session = await ML.login({
        homeserver: hs,
        username: `@${u}:${hs}`,
        password,
        keepSignedIn,
      });
      onSignIn(session);
    } catch (e) {
      setErr(e?.message || 'sign in failed');
      setBusy(false);
    }
  }

  function exploreDemo() {
    // Demo session: no homeserver, no persistence. The app feeds seed data
    // through the same fold pipeline so the workbench is fully explorable.
    onSignIn({
      demo: true,
      mxid: '@you:demo',
      homeserver: 'demo://local',
      device_id: 'DEMO',
      access_token: null,
      signed_in_at: Date.now(),
    });
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-head">
          <div className="login-brand">
            <span className="login-brand-mark">▦</span>
            <span>workspace</span>
          </div>
          <div className="login-sub">sign in to your homeserver</div>
        </div>

        <div className="login-tabs">
          <button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>sign in</button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>create account</button>
        </div>

        {mode === 'reset' ? (
          <PasswordResetBody
            defaultHomeserver={effectiveHomeserver}
            onBack={() => setMode('signin')}
          />
        ) : mode === 'signin' ? (
          <div className="login-body">
            <label className="login-field">
              <span className="login-label">username</span>
              <div className="login-input-wrap">
                <span className="login-prefix">@</span>
                <input
                  ref={userRef}
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="alice  or  alice:matrix.org"
                  spellCheck={false}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                />
              </div>
              {usernameIncludesServer && (
                <span className="login-hint">homeserver detected · <b>{effectiveHomeserver}</b></span>
              )}
            </label>

            <label className="login-field">
              <span className="login-label">password</span>
              <div className="login-input-wrap">
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                />
              </div>
              <a className="login-hint link" href="#" onClick={e => { e.preventDefault(); setMode('reset'); }}>forgot password</a>
            </label>

            {!usernameIncludesServer && (
              <label className="login-field">
                <span className="login-label">homeserver</span>
                <div className="login-input-wrap">
                  <span className="login-prefix">https://</span>
                  <input
                    value={homeserver}
                    onChange={e => setHomeserver(e.target.value)}
                    placeholder="matrix.org"
                    spellCheck={false}
                  />
                </div>
                <span className="login-hint">where your account lives · default: matrix.org</span>
              </label>
            )}

            <label className="login-remember" title="stores the encryption key on this device so a browser restart resumes without a password prompt">
              <input
                type="checkbox"
                checked={keepSignedIn}
                onChange={e => setKeepSignedIn(e.target.checked)}
              />
              <span>keep me signed in on this device</span>
            </label>
            {!keepSignedIn && (
              <span className="login-hint">you'll re-enter your password after closing the browser.</span>
            )}

            {hasAccount && (
              <div className="login-hint">
                local vault detected for <b>{lastUser}</b> · same password unlocks offline.
              </div>
            )}

            {err && <div className="login-err">{err}</div>}

            <div className="login-actions">
              <button className="login-primary" disabled={busy} onClick={submit}>
                {busy ? 'signing in…' : 'sign in'}
              </button>
              <div className="login-divider"><span>or</span></div>
              <button className="login-ghost" onClick={exploreDemo} disabled={busy}>
                explore demo data without signing in
              </button>
              <div className="login-hint" style={{textAlign:'center'}}>
                demo loads seed spaces locally — nothing leaves the browser.
              </div>
            </div>
          </div>
        ) : (
          <div className="login-body">
            <div className="register-pitch">
              <div className="register-pitch-title">don't have a matrix account?</div>
              <div className="register-pitch-body">
                matrix is a federated network — accounts live on a homeserver of your choice.
                the easiest way to get started is on the public <b>matrix.org</b> homeserver.
              </div>
            </div>
            <a
              className="login-primary"
              href="https://app.element.io/#/register"
              target="_blank"
              rel="noopener noreferrer"
              style={{textAlign:'center',textDecoration:'none',display:'block'}}
            >
              create account on matrix.org →
            </a>
            <div className="login-divider"><span>then</span></div>
            <button className="login-ghost" onClick={() => setMode('signin')}>
              come back here to sign in
            </button>
            <div className="login-hint" style={{textAlign:'center',marginTop:4}}>
              prefer a different homeserver? sign up there, then sign in with <span className="kbd">@you:that.server</span>
            </div>
          </div>
        )}

        <div className="login-foot">
          <span>your session, projection cursor, and rooms are kept locally.</span>
          <span className="muted">no data leaves your browser.</span>
          <AppResetLink />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// IdentityChip — topbar element, click for menu
// ─────────────────────────────────────────────────────────────────────────

function IdentityChip({ session, onSignOut, onOpenAccount }) {
  const [open, setOpen] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [displayName, setDisplayName] = useState(() =>
    window.MatrixLive?.getMyDisplayName?.() || null
  );
  const ref = useRef(null);
  const pwRef = useRef(null);
  useEffect(() => { if (reconnectOpen) pwRef.current?.focus(); }, [reconnectOpen]);
  useEffect(() => {
    if (!open) return;
    function close(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  // The Matrix client populates profile data asynchronously; refresh when
  // member/session events fire so the display name lands without a reload.
  useEffect(() => {
    const ML = window.MatrixLive;
    if (!ML?.subscribe) return;
    return ML.subscribe((reason) => {
      if (reason === 'members' || reason === 'session' || reason === 'rooms') {
        setDisplayName(ML.getMyDisplayName?.() || null);
      }
    });
  }, []);

  const localPart = session.mxid.replace(/^@/, '').split(':')[0];
  const demo = !!session.demo;
  const stale = !demo && !!session.stale;
  const label = demo ? 'demo' : (displayName || localPart);
  const initial = (label[0] || '?').toUpperCase();
  const avatarBg = demo ? 'var(--signal)' : stale ? 'var(--triad-significance)' : null;
  const syncStatus = demo
    ? 'demo · seed data only'
    : stale ? 'local only · changes will sync when reconnected'
            : 'synced';
  return (
    <div className="identity-chip" ref={ref}>
      <button
        className="ic-btn"
        onClick={() => setOpen(o => !o)}
        title={demo ? 'demo mode' : stale ? `${session.mxid} · local only` : session.mxid}
      >
        <span className="ic-avatar" style={avatarBg ? {background:avatarBg} : null}>{initial}</span>
        <span className="ic-mxid">
          {label}
          {stale && <span className="muted" style={{marginLeft:6}}>· local only</span>}
        </span>
        <span className="ic-caret">▾</span>
      </button>
      {open && (
        <div className="ic-panel">
          <div className="ic-panel-head">
            <div className="ic-panel-avatar" style={avatarBg ? {background:avatarBg} : null}>{initial}</div>
            <div>
              <div className="ic-panel-mxid">{label}</div>
              <div className="ic-panel-sub">{syncStatus}</div>
            </div>
          </div>
          {demo ? (
            <button className="ic-panel-item" onClick={() => { setOpen(false); onSignOut(); }}>
              sign in to a real homeserver
            </button>
          ) : stale ? (
            <>
              <button className="ic-panel-item" onClick={() => { setReconnectOpen(true); setOpen(false); }}>
                reconnect to homeserver
              </button>
              <button className="ic-panel-item danger" onClick={() => { setOpen(false); onSignOut(); }}>
                sign out (wipes local data)
              </button>
            </>
          ) : (
            <>
              <button className="ic-panel-item" onClick={() => { setOpen(false); onOpenAccount?.('profile'); }}>account settings</button>
              <button className="ic-panel-item" onClick={() => { setOpen(false); onOpenAccount?.('people'); }}>people &amp; permissions</button>
              <button className="ic-panel-item" onClick={() => { setOpen(false); onOpenAccount?.('security'); }}>security &amp; keys</button>
              <button className="ic-panel-item danger" onClick={() => { setOpen(false); onSignOut(); }}>sign out</button>
            </>
          )}
        </div>
      )}
      {reconnectOpen && (
        <div className="share-overlay" onClick={() => !busy && setReconnectOpen(false)}>
          <div className="share-card" style={{maxWidth:360}} onClick={e => e.stopPropagation()}>
            <div className="share-head">
              <div>
                <div className="share-title">reconnect</div>
                <div className="share-sub">re-enter your password to refresh the matrix session</div>
              </div>
              <button className="share-close" onClick={() => !busy && setReconnectOpen(false)}>×</button>
            </div>
            <div className="share-section">
              <label className="login-field">
                <span className="login-label">password</span>
                <div className="login-input-wrap">
                  <input
                    ref={pwRef}
                    type="password"
                    value={pw}
                    onChange={e => setPw(e.target.value)}
                    placeholder="••••••••"
                    disabled={busy}
                    onKeyDown={async (e) => {
                      if (e.key !== 'Enter' || busy) return;
                      setBusy(true); setErr(null);
                      try {
                        await window.MatrixLive.reconnect(pw);
                        setReconnectOpen(false);
                        setPw('');
                      } catch (ex) {
                        setErr(ex?.message || 'reconnect failed');
                      } finally { setBusy(false); }
                    }}
                  />
                </div>
              </label>
              {err && <div className="login-err" style={{marginTop:6}}>{err}</div>}
              <div className="login-actions" style={{marginTop:10}}>
                <button
                  className="login-primary"
                  disabled={busy || !pw}
                  onClick={async () => {
                    setBusy(true); setErr(null);
                    try {
                      await window.MatrixLive.reconnect(pw);
                      setReconnectOpen(false);
                      setPw('');
                    } catch (ex) {
                      setErr(ex?.message || 'reconnect failed');
                    } finally { setBusy(false); }
                  }}
                >{busy ? 'reconnecting…' : 'reconnect'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ImportButton — pick a file, encrypt it client-side, upload as a blob to
// the homeserver media store, and emit an `import` entity into the room.
// The decryption key rides inside the Megolm-encrypted event content, so
// the homeserver only stores ciphertext.
// ─────────────────────────────────────────────────────────────────────────

function ImportButton({ roomId, disabled, isLive, onCsvFile }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ML = window.MatrixLive;

  async function handleFile(file) {
    if (!file) return;
    // CSVs go through the airtable-style importer (preview + field mapping).
    // Other files stream straight to media; CSV/JSON datasets additionally
    // get a lazy derived set (one import entity + schema, rows materialized
    // on read) — no per-row events either way.
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    if (isCsv && typeof onCsvFile === 'function') {
      onCsvFile(file);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (!isLive || !ML?.importFile) {
      // Demo mode can't store opaque binary blobs — only the CSV path makes
      // sense without a homeserver to upload to.
      setErr('CSV only in demo · sign in for any file');
      setTimeout(() => setErr(null), 3500);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await ML.importFile(roomId, file);
    } catch (e) {
      console.warn('[import] failed:', e);
      setErr(e?.message || 'import failed');
      setTimeout(() => setErr(null), 4000);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <button
        className="topbar-import"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        title={isLive
          ? 'import a CSV / JSON / binary file into this space'
          : 'import a CSV file into this space · sign in for other file types'}
      >
        <i className="ph ph-upload-simple" aria-hidden="true"></i>
        <span>{busy ? 'uploading…' : err || 'import'}</span>
      </button>
      <input
        type="file"
        ref={inputRef}
        style={{display:'none'}}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Roles — Matrix power levels presented as named roles.
//
// Matrix has no roles, only integer power levels. The whole app converges on
// three: member (0), moderator (50), admin (100). RoleSelect renders those as
// a dropdown; a non-standard level still shows (as "Custom (N)") so an
// admin-set odd value is never silently clobbered.
// ─────────────────────────────────────────────────────────────────────────

const ROLE_LEVELS = [0, 50, 100];
const ROLE_OPTIONS = [
  { level: 0,   label: 'Member' },
  { level: 50,  label: 'Moderator' },
  { level: 100, label: 'Admin' },
];
function roleLabelForLevel(level) {
  if (level >= 100) return 'Admin';
  if (level >= 50)  return 'Moderator';
  return 'Member';
}

function RoleSelect({ level, disabled, onChange, title }) {
  const isCustom = !ROLE_LEVELS.includes(level);
  return (
    <select
      className="role-select"
      value={isCustom ? 'custom' : String(level)}
      disabled={disabled}
      title={title}
      onChange={e => {
        if (e.target.value === 'custom') return;
        onChange(Number(e.target.value));
      }}
    >
      {ROLE_OPTIONS.map(o => (
        <option key={o.level} value={String(o.level)}>{o.label}</option>
      ))}
      {isCustom && <option value="custom">{`Custom (${level})`}</option>}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MemberManager — the reusable people-and-permissions panel for one space.
//
// Renders an invite row (matrix id + starting role) and a table of every
// member with their status, an inline role dropdown, and a remove (kick)
// button. Every action is gated on the signed-in user's own power level, so
// buttons disable rather than fail. Used both by MembersDialog (the per-space
// "members" button) and by the People tab of the account dashboard.
// ─────────────────────────────────────────────────────────────────────────

function MemberManager({ roomId, mySession, autoFocus }) {
  const ML = window.MatrixLive;
  const { members, myPowerLevel } = useMembers(roomId);
  const [mxid, setMxid] = useState('@');
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus, roomId]);

  // Members are lazy-loaded to keep idle memory low; pull the full list now
  // that the panel is open. useMembers re-renders when it arrives.
  useEffect(() => {
    if (roomId && ML?.loadMembers) ML.loadMembers(roomId);
  }, [ML, roomId]);

  if (!roomId) return null;
  const myMxid = mySession?.mxid;
  const canInvite = myPowerLevel >= 50;
  const canKick   = myPowerLevel >= 50;
  const canSetPL  = myPowerLevel >= 100;

  async function doInvite() {
    const id = mxid.trim();
    if (!id.startsWith('@') || !id.includes(':')) {
      setErr('matrix id must look like @user:server');
      return;
    }
    setErr(null); setBusy(true);
    try {
      await ML.inviteUser(roomId, id);
      if (typeof level === 'number' && level !== 0 && canSetPL) {
        await ML.setUserPowerLevel(roomId, id, level);
      }
      setMxid('@');
      setLevel(0);
    } catch (e) {
      setErr(e?.message || 'invite failed');
    } finally { setBusy(false); }
  }

  async function doKick(userId, label) {
    if (userId === myMxid) {
      setErr("you can't remove yourself from here — sign out instead");
      return;
    }
    if (!confirm(`Remove ${label || userId} from this workspace?`)) return;
    setErr(null); setBusy(true);
    try { await ML.kickUser(roomId, userId); }
    catch (e) { setErr(e?.message || 'remove failed'); }
    finally { setBusy(false); }
  }

  async function doSetPL(userId, newLevel) {
    const n = Number(newLevel);
    if (!Number.isFinite(n)) return;
    if (userId === myMxid && n < myPowerLevel) {
      if (!confirm('Lowering your own role may lock you out of admin actions. Continue?')) return;
    }
    setErr(null); setBusy(true);
    try { await ML.setUserPowerLevel(roomId, userId, n); }
    catch (e) { setErr(e?.message || 'set role failed'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="share-section">
        <div className="share-section-label">invite member</div>
        <div className="share-invite-row">
          <input
            ref={inputRef}
            value={mxid}
            onChange={e => setMxid(e.target.value)}
            placeholder="@username:homeserver"
            title="full matrix id format: @username:homeserver"
            disabled={!canInvite || busy}
            onKeyDown={e => { if (e.key === 'Enter') doInvite(); }}
          />
          <RoleSelect
            level={level}
            disabled={!canInvite || !canSetPL || busy}
            onChange={setLevel}
            title="starting role for the invited member"
          />
          <button className="share-invite" onClick={doInvite} disabled={!canInvite || busy}>invite</button>
        </div>
        {!canInvite && (
          <div className="share-hint">you need to be a moderator or admin to invite. ask an admin.</div>
        )}
        {canInvite && !canSetPL && (
          <div className="share-hint">you can invite, but assigning a role above member needs admin.</div>
        )}
        {err && <div className="login-err" style={{marginTop:6}}>{err}</div>}
      </div>

      <div className="share-section">
        <div className="share-section-label">members · {members.length}</div>
        <table className="dbgrid members-table">
          <thead>
            <tr>
              <th>member</th>
              <th>status</th>
              <th>role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => {
              const isMe = m.userId === myMxid;
              const canKickThis = canKick && !isMe && m.powerLevel < myPowerLevel;
              // You can only re-role someone strictly below you (and never
              // promote anyone above your own level — Matrix would reject it).
              const canRoleThis = canSetPL && (isMe || m.powerLevel < myPowerLevel);
              const nameLabel = m.displayName && m.displayName !== m.userId
                ? m.displayName
                : m.userId.replace(/^@/, '').split(':')[0];
              const initial = (nameLabel[0] || '?').toUpperCase();
              const statusLabel = m.membership === 'join' ? 'active'
                                : m.membership === 'invite' ? 'invited'
                                : m.membership;
              return (
                <tr key={m.userId}>
                  <td title={m.userId}>
                    <span className="share-member-avatar" style={{marginRight:8}}>
                      {initial}
                    </span>
                    <span>{nameLabel}</span>
                    {isMe && <span className="muted" style={{marginLeft:6}}>(you)</span>}
                  </td>
                  <td className={m.membership === 'invite' ? 'muted' : ''}>
                    {statusLabel}
                  </td>
                  <td>
                    <RoleSelect
                      level={m.powerLevel}
                      disabled={busy || !canRoleThis}
                      onChange={(v) => { if (v !== m.powerLevel) doSetPL(m.userId, v); }}
                      title={canRoleThis ? '0 = member · 50 = moderator · 100 = admin'
                                         : 'you need a higher role to change this member'}
                    />
                  </td>
                  <td>
                    <button
                      className="share-member-remove"
                      disabled={!canKickThis || busy}
                      title={isMe ? "can't remove yourself" : canKickThis ? 'remove from workspace' : 'you need a higher role to remove this member'}
                      onClick={() => doKick(m.userId, nameLabel)}
                    >×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MembersDialog — per-space "members" button. A thin overlay around
// MemberManager so the topbar/room-picker entry points keep working.
// ─────────────────────────────────────────────────────────────────────────

function MembersDialog({ space, mySession, onClose }) {
  if (!space) return null;
  return <MembersDialogInner space={space} mySession={mySession} onClose={onClose} />;
}

function MembersDialogInner({ space, mySession, onClose }) {
  const { members, myPowerLevel } = useMembers(space.id);
  const myRoleLabel = roleLabelForLevel(myPowerLevel).toLowerCase();
  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-card" onClick={e => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">members of <span className="share-name">{space.title || 'untitled workspace'}</span></div>
            <div className="share-sub">{members.length} {members.length === 1 ? 'member' : 'members'} · your role: {myRoleLabel}</div>
          </div>
          <button className="share-close" onClick={onClose}>×</button>
        </div>
        <MemberManager roomId={space.id} mySession={mySession} autoFocus />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// AccountDashboard — the signed-in user's control center.
//
// Four tabs: Profile (display name + identity), Security (change password +
// recovery key), People (manage members & permissions across every space),
// and a clean exit. Opened from the identity chip menu. Online-only actions
// disable themselves with a hint when the session is local-only (stale).
// ─────────────────────────────────────────────────────────────────────────

function AccountDashboard({ session, rooms, initialTab, onClose, onSignOut }) {
  const ML = window.MatrixLive;
  const [tab, setTab] = useState(initialTab || 'profile');
  const stale = !!session?.stale;

  const joinedSpaces = (rooms || []).filter(r => r.membership === 'join');

  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-card acct-card" onClick={e => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">account</div>
            <div className="share-sub">{session?.mxid}{stale ? ' · local only' : ''}</div>
          </div>
          <button className="share-close" onClick={onClose}>×</button>
        </div>

        <div className="acct-tabs">
          <button className={tab === 'profile'  ? 'active' : ''} onClick={() => setTab('profile')}>profile</button>
          <button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>security</button>
          <button className={tab === 'people'   ? 'active' : ''} onClick={() => setTab('people')}>people</button>
        </div>

        {stale && (
          <div className="acct-stale">
            you're in local-only mode. reconnect to the homeserver to change your
            profile, password, or members.
          </div>
        )}

        {tab === 'profile'  && <AccountProfileTab session={session} disabled={stale} />}
        {tab === 'security' && <AccountSecurityTab session={session} disabled={stale} onSignOut={onSignOut} />}
        {tab === 'people'   && <AccountPeopleTab session={session} spaces={joinedSpaces} disabled={stale} />}
      </div>
    </div>
  );
}

function AccountProfileTab({ session, disabled }) {
  const ML = window.MatrixLive;
  const profile = useMemo(() => ML?.getProfile?.() || null, [ML]);
  const [name, setName] = useState(profile?.displayName || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [saved, setSaved] = useState(false);

  const mxid = profile?.mxid || session?.mxid || '';
  const localPart = mxid.replace(/^@/, '').split(':')[0];
  const initial = ((name || localPart || '?')[0] || '?').toUpperCase();

  async function save() {
    setErr(null); setSaved(false); setBusy(true);
    try {
      await ML.setMyDisplayName(name.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e?.message || 'could not update display name');
    } finally { setBusy(false); }
  }

  return (
    <div className="share-section">
      <div className="acct-profile-head">
        <span className="acct-avatar">{initial}</span>
        <div className="acct-identity">
          <div className="acct-mxid">{mxid}</div>
          <div className="acct-meta">
            <span><span className="acct-meta-k">homeserver</span> {profile?.homeserver || '—'}</span>
            <span><span className="acct-meta-k">device</span> {profile?.deviceId || '—'}</span>
          </div>
        </div>
      </div>

      <div className="acct-field-block">
        <label className="login-field">
          <span className="login-label">display name</span>
          <div className="login-input-wrap">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={localPart}
              disabled={disabled || busy}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
            />
          </div>
          <span className="login-hint">how other members see you across every space.</span>
        </label>
        {err && <div className="login-err" style={{marginTop:8}}>{err}</div>}
        <div className="acct-actions">
          <button
            className="login-primary"
            disabled={disabled || busy || name.trim() === (profile?.displayName || '')}
            onClick={save}
          >
            {busy ? 'saving…' : saved ? 'saved ✓' : 'save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountSecurityTab({ session, disabled, onSignOut }) {
  const ML = window.MatrixLive;
  const [cur, setCur]   = useState('');
  const [pw, setPw]     = useState('');
  const [pw2, setPw2]   = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [done, setDone] = useState(false);

  const [rkBusy, setRkBusy] = useState(false);
  const [rk, setRk]         = useState(null);
  const [rkErr, setRkErr]   = useState(null);
  const [copied, setCopied] = useState(false);

  async function changePassword() {
    setErr(null); setDone(false);
    if (!cur)          { setErr('enter your current password'); return; }
    if (pw.length < 8) { setErr('new password: use at least 8 characters'); return; }
    if (pw !== pw2)    { setErr('new passwords do not match'); return; }
    setBusy(true);
    try {
      await ML.changePassword(cur, pw);
      setDone(true);
      setCur(''); setPw(''); setPw2('');
    } catch (e) {
      setErr(e?.message || 'could not change password');
    } finally { setBusy(false); }
  }

  async function revealKey() {
    setRkErr(null); setRkBusy(true);
    try {
      const key = await ML.getRecoveryKey?.();
      if (key) setRk(key);
      else setRkErr('no recovery key stored on this device.');
    } catch (e) {
      setRkErr(e?.message || 'could not read recovery key');
    } finally { setRkBusy(false); }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(rk);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <>
      <div className="share-section">
        <div className="share-section-label">change password</div>
        <label className="login-field">
          <span className="login-label">current password</span>
          <div className="login-input-wrap">
            <input type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="••••••••" disabled={disabled || busy} />
          </div>
        </label>
        <label className="login-field" style={{marginTop:10}}>
          <span className="login-label">new password</span>
          <div className="login-input-wrap">
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••" disabled={disabled || busy} />
          </div>
        </label>
        <label className="login-field" style={{marginTop:10}}>
          <span className="login-label">confirm new password</span>
          <div className="login-input-wrap">
            <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="••••••••" disabled={disabled || busy}
              onKeyDown={e => { if (e.key === 'Enter') changePassword(); }} />
          </div>
        </label>
        {err  && <div className="login-err" style={{marginTop:8}}>{err}</div>}
        {done && <div className="acct-ok" style={{marginTop:8}}>password changed ✓ — on next cold start, unlock this device with the new password.</div>}
        <div className="acct-actions">
          <button className="login-primary" disabled={disabled || busy} onClick={changePassword}>
            {busy ? 'updating…' : 'change password'}
          </button>
        </div>
      </div>

      <div className="share-section">
        <div className="share-section-label">recovery key</div>
        <div className="share-hint" style={{marginBottom:8}}>
          your recovery key unlocks encrypted history if you lose this device. keep it somewhere safe.
        </div>
        {rk ? (
          <div className="share-link-row">
            <div className="share-link" style={{whiteSpace:'normal',wordBreak:'break-all'}}>{rk}</div>
            <button className="share-copy" onClick={copyKey}>{copied ? 'copied' : 'copy'}</button>
          </div>
        ) : (
          <button className="login-ghost" disabled={rkBusy} onClick={revealKey}>
            {rkBusy ? 'reading…' : 'reveal recovery key'}
          </button>
        )}
        {rkErr && <div className="login-err" style={{marginTop:8}}>{rkErr}</div>}
      </div>

      <div className="share-section">
        <div className="share-section-label">session</div>
        <button className="login-ghost danger-ghost" onClick={() => onSignOut?.()}>sign out of this device</button>
      </div>
    </>
  );
}

function AccountPeopleTab({ session, spaces, disabled }) {
  const [roomId, setRoomId] = useState(spaces[0]?.id || null);

  // Keep the selection valid as spaces load/change.
  useEffect(() => {
    if (!spaces.some(s => s.id === roomId)) setRoomId(spaces[0]?.id || null);
  }, [spaces, roomId]);

  if (!spaces.length) {
    return (
      <div className="share-section">
        <div className="share-hint">you haven't joined any spaces yet. create or join one to manage its people.</div>
      </div>
    );
  }

  return (
    <>
      <div className="share-section">
        <div className="share-section-label">space</div>
        <select
          className="acct-space-select"
          value={roomId || ''}
          onChange={e => setRoomId(e.target.value)}
          disabled={disabled}
        >
          {spaces.map(s => (
            <option key={s.id} value={s.id}>{s.title || 'untitled workspace'}</option>
          ))}
        </select>
        <div className="share-hint" style={{marginTop:6}}>
          permissions are per space — invite people and set their role for the selected space.
        </div>
      </div>
      {!disabled && roomId && (
        <MemberManager key={roomId} roomId={roomId} mySession={session} />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────

Object.assign(window, {
  useSession,
  useMembers,
  BootSplash,
  LoginScreen,
  IdentityChip,
  MembersDialog,
  MemberManager,
  AccountDashboard,
  ImportButton,
  // Console escape hatch: window.hardResetFromSource() force-refreshes the app
  // code (clears the PWA shell cache + service worker) without wiping data.
  hardResetFromSource,
});

})();
