/* matrix-auth.jsx — Matrix-style login screen, identity chip in topbar,
 * spaces dropdown, and share-space invite dialog.
 *
 * Entirely client-side / localStorage-backed; no real homeserver call.
 * Captures the *shape* of the flow: pick a homeserver, sign in, group rooms
 * into spaces, share a space with another mxid.
 */

(function () {
const { useState, useEffect, useRef, useMemo } = React;

const SESSION_KEY = 'matrix-events.session.v1';
const SPACES_KEY  = 'matrix-events.spaces.v1';

// ─────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Real Matrix sessions require an unlocked vault, which is gone after
    // a cold reload — fall back to the login screen instead of pretending
    // we are authed. Demo sessions are pure UI state and safe to keep.
    if (s && !s.demo) return null;
    return s;
  } catch { return null; }
}
function saveSession(s) {
  // Only persist demo sessions. Real sessions are tied to the bridge's
  // in-memory client + vault key and shouldn't survive a reload.
  if (s && s.demo) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else             localStorage.removeItem(SESSION_KEY);
}

function useSession() {
  const [session, setSession] = useState(loadSession);
  useEffect(() => { saveSession(session); }, [session]);
  return [session, setSession];
}

// ─────────────────────────────────────────────────────────────────────────
// Spaces — { id, name, sigil, members: [{mxid, role}], rooms: [roomId] }
// ─────────────────────────────────────────────────────────────────────────

function defaultSpaces(mxid) {
  return [
    { id: '#engineering:matrix.org', name: 'engineering', sigil: 'E', rooms: ['!proj_alpha','!infra_log'],
      members: [
        { mxid, role: 'admin' },
        { mxid: '@alice:matrix.org', role: 'member' },
        { mxid: '@bo:matrix.org', role: 'member' },
        { mxid: '@kit:fosdem.im', role: 'viewer' },
      ] },
    { id: '#research:matrix.org', name: 'research', sigil: 'R', rooms: ['!hypotheses','!observations'],
      members: [
        { mxid, role: 'admin' },
        { mxid: '@nat:matrix.org', role: 'member' },
      ] },
    { id: '#personal:matrix.org', name: 'personal', sigil: 'P', rooms: ['!scratch'],
      members: [{ mxid, role: 'admin' }] },
  ];
}

function loadSpaces(mxid) {
  try {
    const raw = localStorage.getItem(SPACES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return defaultSpaces(mxid);
}
function saveSpaces(s) { localStorage.setItem(SPACES_KEY, JSON.stringify(s)); }

function useSpaces(mxid) {
  const [spaces, setSpaces] = useState(() => loadSpaces(mxid));
  useEffect(() => { saveSpaces(spaces); }, [spaces]);
  return [spaces, setSpaces];
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
            <span>matrix-events</span>
          </div>
          <div className="login-sub">bare metal · sign in to your homeserver</div>
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
                demo loads seed workspaces locally — nothing leaves the browser.
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
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function close(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const u = session.mxid.replace(/^@/, '').split(':')[0];
  const initial = u.slice(0,1).toUpperCase();
  const demo = !!session.demo;
  return (
    <div className="identity-chip" ref={ref}>
      <button className="ic-btn" onClick={() => setOpen(o => !o)} title={session.mxid}>
        <span className="ic-avatar" style={demo ? {background:'var(--signal)'} : null}>{initial}</span>
        <span className="ic-mxid">{demo ? 'demo · @you' : session.mxid}</span>
        <span className="ic-caret">▾</span>
      </button>
      {open && (
        <div className="ic-panel">
          <div className="ic-panel-head">
            <div className="ic-panel-avatar" style={demo ? {background:'var(--signal)'} : null}>{initial}</div>
            <div>
              <div className="ic-panel-mxid">{demo ? 'demo mode' : session.mxid}</div>
              <div className="ic-panel-sub">
                {demo ? 'no homeserver · seed data only' :
                  `homeserver · ${session.homeserver.replace(/^https?:\/\//,'')}`}
              </div>
              <div className="ic-panel-sub">device · {session.device_id}{session.sso ? ' · sso' : ''}</div>
            </div>
          </div>
          {demo ? (
            <button className="ic-panel-item" onClick={() => { setOpen(false); onSignOut(); }}>
              sign in to a real homeserver
            </button>
          ) : (
            <>
              <button className="ic-panel-item" onClick={() => setOpen(false)}>account settings</button>
              <button className="ic-panel-item" onClick={() => setOpen(false)}>security &amp; keys</button>
              <button className="ic-panel-item danger" onClick={() => { setOpen(false); onSignOut(); }}>sign out</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SpacesPicker — sits in the topbar before the room picker
// ─────────────────────────────────────────────────────────────────────────

function SpacesPicker({ spaces, currentSpaceId, setCurrentSpaceId, onShare, onCreateSpace }) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function close(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const current = spaces.find(s => s.id === currentSpaceId) || spaces[0];

  return (
    <div className="spaces-picker" ref={ref}>
      <button className="sp-btn" onClick={() => setOpen(o => !o)} title={current?.id}>
        <span className="sp-sigil">{current?.sigil || '·'}</span>
        <span className="sp-name">{current?.name || 'no space'}</span>
        <span className="sp-meta">{current?.rooms.length || 0} rooms · {current?.members.length || 0}</span>
        <span className="sp-caret">▾</span>
      </button>
      {open && (
        <div className="sp-panel">
          <div className="sp-panel-head">spaces · {spaces.length}</div>
          {spaces.map(s => (
            <div
              key={s.id}
              className={`sp-row ${s.id === currentSpaceId ? 'active' : ''}`}
              onClick={() => { setCurrentSpaceId(s.id); setOpen(false); }}
            >
              <span className="sp-row-sigil">{s.sigil}</span>
              <div className="sp-row-body">
                <div className="sp-row-name">#{s.name}</div>
                <div className="sp-row-meta">{s.rooms.length} rooms · {s.members.length} members</div>
              </div>
              <button
                className="sp-row-share"
                onClick={(e) => { e.stopPropagation(); onShare(s.id); setOpen(false); }}
                title="invite somebody to this space"
              >share</button>
            </div>
          ))}
          <div className="sp-new">
            <input
              value={newName}
              placeholder="new space name"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newName) { onCreateSpace(newName); setNewName(''); setOpen(false); } }}
            />
            <button onClick={() => { if (newName) { onCreateSpace(newName); setNewName(''); setOpen(false); } }}>+ space</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ShareSpaceDialog — invite a mxid, copy link, list members
// ─────────────────────────────────────────────────────────────────────────

function ShareSpaceDialog({ space, onClose, onInvite, onChangeRole, onRemove }) {
  const [mxid, setMxid]   = useState('@');
  const [role, setRole]   = useState('member');
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const link = `https://matrix.to/#/${encodeURIComponent(space.id)}`;

  function invite() {
    const id = mxid.trim();
    if (!id.startsWith('@') || !id.includes(':')) return;
    if (space.members.some(m => m.mxid === id)) return;
    onInvite(id, role);
    setMxid('@');
  }

  function copyLink() {
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-card" onClick={e => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">share <span className="share-name">#{space.name}</span></div>
            <div className="share-sub">space · {space.id} · {space.rooms.length} rooms · {space.members.length} members</div>
          </div>
          <button className="share-close" onClick={onClose}>×</button>
        </div>

        <div className="share-section">
          <div className="share-section-label">invite by matrix id</div>
          <div className="share-invite-row">
            <input
              ref={inputRef}
              value={mxid}
              onChange={e => setMxid(e.target.value)}
              placeholder="@username:homeserver"
              onKeyDown={e => { if (e.key === 'Enter') invite(); }}
            />
            <select value={role} onChange={e => setRole(e.target.value)}>
              <option value="viewer">viewer</option>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <button className="share-invite" onClick={invite}>invite</button>
          </div>
          <div className="share-hint">they receive an invitation event in their feed of the space.</div>
        </div>

        <div className="share-section">
          <div className="share-section-label">share link</div>
          <div className="share-link-row">
            <code className="share-link">{link}</code>
            <button className="share-copy" onClick={copyLink}>{copied ? 'copied' : 'copy'}</button>
          </div>
          <div className="share-hint">anyone with the link can request to join (if space is public).</div>
        </div>

        <div className="share-section">
          <div className="share-section-label">members · {space.members.length}</div>
          <div className="share-members">
            {space.members.map(m => (
              <div className="share-member" key={m.mxid}>
                <span className="share-member-avatar">{m.mxid.replace(/^@/,'').slice(0,1).toUpperCase()}</span>
                <span className="share-member-mxid">{m.mxid}</span>
                <select
                  value={m.role}
                  onChange={e => onChangeRole(m.mxid, e.target.value)}
                  className={`share-member-role role-${m.role}`}
                >
                  <option value="viewer">viewer</option>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button className="share-member-remove" onClick={() => onRemove(m.mxid)} title="remove from space">×</button>
              </div>
            ))}
          </div>
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
  useSpaces,
  LoginScreen,
  IdentityChip,
  SpacesPicker,
  ShareSpaceDialog,
});

})();
