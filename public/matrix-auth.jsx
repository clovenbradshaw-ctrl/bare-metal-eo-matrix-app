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

        {mode === 'signin' ? (
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
              <a className="login-hint link" href="#" onClick={e => e.preventDefault()}>forgot password</a>
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
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// IdentityChip — topbar element, click for menu
// ─────────────────────────────────────────────────────────────────────────

function IdentityChip({ session, onSignOut }) {
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
              <button className="ic-panel-item" onClick={() => setOpen(false)}>account settings</button>
              <button className="ic-panel-item" onClick={() => setOpen(false)}>security &amp; keys</button>
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
// MembersDialog — manage members of a space (Matrix room).
//
// Renders the current room's members as a table: mxid, membership state,
// power level (editable inline), and a remove (kick) action. An invite
// row at the top adds new members. All actions are gated on the signed-in
// user's own power level — buttons disable when the action would fail.
// ─────────────────────────────────────────────────────────────────────────

function MembersDialog({ space, mySession, onClose }) {
  const ML = window.MatrixLive;
  const { members, myPowerLevel } = useMembers(space?.id);
  const [mxid, setMxid] = useState('@');
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Members are lazy-loaded to keep idle memory low; pull the full list now
  // that the dialog is open. useMembers re-renders when it arrives.
  useEffect(() => {
    if (space?.id && ML?.loadMembers) ML.loadMembers(space.id);
  }, [ML, space?.id]);

  if (!space) return null;
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
      await ML.inviteUser(space.id, id);
      if (typeof level === 'number' && level !== 0 && canSetPL) {
        await ML.setUserPowerLevel(space.id, id, level);
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
    try { await ML.kickUser(space.id, userId); }
    catch (e) { setErr(e?.message || 'remove failed'); }
    finally { setBusy(false); }
  }

  async function doSetPL(userId, newLevel) {
    const n = Number(newLevel);
    if (!Number.isFinite(n)) return;
    if (userId === myMxid && n < myPowerLevel) {
      if (!confirm('Lowering your own power level may lock you out of admin actions. Continue?')) return;
    }
    setErr(null); setBusy(true);
    try { await ML.setUserPowerLevel(space.id, userId, n); }
    catch (e) { setErr(e?.message || 'set power level failed'); }
    finally { setBusy(false); }
  }

  const myRoleLabel = myPowerLevel >= 100 ? 'admin' : myPowerLevel >= 50 ? 'mod' : 'member';

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

        <div className="share-section">
          <div className="share-section-label">invite member</div>
          <div className="share-invite-row">
            <input
              ref={inputRef}
              value={mxid}
              onChange={e => setMxid(e.target.value)}
              placeholder="username"
              title="full matrix id format: @username:homeserver"
              disabled={!canInvite || busy}
              onKeyDown={e => { if (e.key === 'Enter') doInvite(); }}
            />
            <input
              type="number"
              value={level}
              onChange={e => setLevel(Number(e.target.value))}
              title="initial power level (0 = default, 50 = moderator, 100 = admin)"
              min={0}
              max={100}
              step={1}
              style={{width:64,padding:'6px 8px',fontSize:12}}
              disabled={!canInvite || !canSetPL || busy}
            />
            <button className="share-invite" onClick={doInvite} disabled={!canInvite || busy}>invite</button>
          </div>
          {!canInvite && (
            <div className="share-hint">you need to be a mod or admin to invite. ask an admin.</div>
          )}
          {canInvite && !canSetPL && (
            <div className="share-hint">you can invite, but assigning a non-zero role needs admin.</div>
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
                const nameLabel = m.displayName && m.displayName !== m.userId
                  ? m.displayName
                  : m.userId.replace(/^@/, '').split(':')[0];
                const initial = (nameLabel[0] || '?').toUpperCase();
                const statusLabel = m.membership === 'join' ? 'active'
                                  : m.membership === 'invite' ? 'invited'
                                  : m.membership;
                const roleLabel = m.powerLevel >= 100 ? 'admin' : m.powerLevel >= 50 ? 'mod' : 'member';
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
                      <input
                        type="number"
                        defaultValue={m.powerLevel}
                        min={0}
                        max={100}
                        step={1}
                        disabled={!canSetPL || busy || (m.powerLevel >= myPowerLevel && !isMe)}
                        style={{width:60,padding:'3px 6px',fontSize:12}}
                        title="0 = member · 50 = mod · 100 = admin"
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== m.powerLevel) doSetPL(m.userId, v);
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                      />
                      <span className="muted" style={{marginLeft:6,fontSize:11}}>{roleLabel}</span>
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
      </div>
    </div>
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
  ImportButton,
});

})();
