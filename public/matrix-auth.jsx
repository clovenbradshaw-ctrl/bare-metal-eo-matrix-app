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
// CSV parsing + type inference (RFC 4180-ish: quoted fields with escaped
// quotes and embedded newlines, comma/CRLF tolerant).
// ─────────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  // Strip a leading BOM so it doesn't show up as the first column header.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { cur.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { cur.push(field); field = ''; rows.push(cur); cur = []; continue; }
    field += c;
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }
  // Drop a trailing all-empty row that a final newline tends to produce.
  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
  return rows;
}

function inferCsvType(values) {
  let nonEmpty = 0, nums = 0, bools = 0, dates = 0, urls = 0, emails = 0;
  for (const raw of values) {
    if (raw == null) continue;
    const v = String(raw).trim();
    if (v === '') continue;
    nonEmpty++;
    if (/^-?\d+(\.\d+)?$/.test(v)) nums++;
    if (/^(true|false)$/i.test(v)) bools++;
    if (/^https?:\/\//i.test(v)) urls++;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) emails++;
    if (/^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) dates++;
  }
  if (nonEmpty === 0) return 'text';
  if (bools === nonEmpty) return 'boolean';
  if (nums === nonEmpty) return 'number';
  if (dates === nonEmpty) return 'date';
  if (urls === nonEmpty) return 'url';
  if (emails === nonEmpty) return 'email';
  // multi-line strings → longtext (so the table view formats them as such)
  for (const raw of values) if (raw != null && String(raw).includes('\n')) return 'longtext';
  return 'text';
}

function coerceCsvValue(raw, type) {
  if (raw == null) return '';
  const v = String(raw);
  if (type === 'number') {
    if (v.trim() === '') return '';
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (type === 'boolean') {
    if (/^true$/i.test(v.trim())) return true;
    if (/^false$/i.test(v.trim())) return false;
    return v;
  }
  return v;
}

function slugifySetName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function uniqueHeaders(headers) {
  // Browsers (and our schema) need unique column names — disambiguate
  // collisions and blank headers so 1000 rows don't render as garbage.
  const seen = new Map();
  return headers.map((h, idx) => {
    let base = String(h ?? '').trim();
    if (!base) base = `column_${idx + 1}`;
    let name = base;
    let n = seen.get(base) || 0;
    if (n > 0) name = `${base}_${n + 1}`;
    seen.set(base, n + 1);
    while (seen.has(name) && name !== base) {
      n++;
      name = `${base}_${n + 1}`;
    }
    return name;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// CsvImportModal — pick a target set (new or existing) and confirm columns.
// Emits SEG-free DEF/INS events: declares the set in `_schema.tables`,
// merges fields into `_schema.fields.<set>`, and INS one entity per row.
// ─────────────────────────────────────────────────────────────────────────

function CsvImportModal({ file, parsed, state, onClose, onConfirm }) {
  const declaredTables = state?.schema?.tables || [];
  const observedTables = Array.from(new Set(
    Object.values(state?.entities || {})
      .map(e => e._type)
      .filter(t => t && !t.startsWith('_'))
  ));
  const existingSets = Array.from(new Set([...declaredTables, ...observedTables])).sort();

  const fileBase = (file?.name || 'imported').replace(/\.[^.]+$/, '');
  const defaultNew = slugifySetName(fileBase) || 'imported';

  const [mode, setMode] = useState(existingSets.length ? 'new' : 'new'); // 'new' | 'existing'
  const [newName, setNewName] = useState(defaultNew);
  const [pickedExisting, setPickedExisting] = useState(existingSets[0] || '');

  // Editable column type per CSV column. Initialise from inference.
  const colInfo = useMemo(() => {
    const headers = uniqueHeaders(parsed.headers);
    return headers.map((name, i) => ({
      name,
      type: inferCsvType(parsed.rows.map(r => r[i])),
    }));
  }, [parsed]);
  const [colTypes, setColTypes] = useState(() => colInfo.map(c => c.type));

  useEffect(() => {
    function esc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const targetName = mode === 'new' ? slugifySetName(newName) : pickedExisting;
  const targetIsNew = mode === 'new' || !existingSets.includes(targetName);
  const existingFields = (state?.schema?.fields?.[targetName] || []);
  const existingFieldNames = new Set(existingFields.map(f => f.name));

  // Per-column status when merging into an existing set.
  const merged = colInfo.map((c, i) => {
    const collision = existingFieldNames.has(c.name);
    return {
      name: c.name,
      type: colTypes[i],
      status: targetIsNew
        ? 'new-set'
        : collision ? 'matches' : 'new-field',
    };
  });

  const canConfirm = !!targetName && parsed.rows.length > 0;

  function commit() {
    if (!canConfirm) return;
    onConfirm({
      target: targetName,
      targetIsNew,
      headers: colInfo.map(c => c.name),
      colTypes,
      rows: parsed.rows,
      existingFields,
    });
  }

  const previewRows = parsed.rows.slice(0, 3);

  return (
    <div className="proj-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="proj-modal" onMouseDown={e => e.stopPropagation()}>
        <header className="proj-modal-head">
          <div className="proj-modal-eyebrow">import csv</div>
          <div className="proj-modal-title">
            <span className="proj-modal-set">{file.name}</span>
            <span className="proj-modal-dim">
              · {parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'}
              · {colInfo.length} {colInfo.length === 1 ? 'column' : 'columns'}
            </span>
          </div>
        </header>

        <div className="proj-modal-body">
          <div className="proj-modal-section-label">target set</div>
          <div className="csv-target-row">
            <label className={`csv-target-opt ${mode === 'new' ? 'on' : ''}`}>
              <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
              <span>new set</span>
              <input
                type="text"
                className="csv-target-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onFocus={() => setMode('new')}
                placeholder="set name"
              />
            </label>
            <label className={`csv-target-opt ${mode === 'existing' ? 'on' : ''} ${existingSets.length === 0 ? 'disabled' : ''}`}>
              <input
                type="radio"
                checked={mode === 'existing'}
                disabled={existingSets.length === 0}
                onChange={() => setMode('existing')}
              />
              <span>merge into existing</span>
              <select
                className="csv-target-input"
                value={pickedExisting}
                onChange={e => setPickedExisting(e.target.value)}
                onFocus={() => existingSets.length && setMode('existing')}
                disabled={existingSets.length === 0}
              >
                {existingSets.length === 0 && <option value="">no sets yet</option>}
                {existingSets.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="proj-modal-section-label">columns · {merged.length}</div>
          <div className="csv-cols-wrap">
            <table className="csv-cols">
              <thead>
                <tr><th>column</th><th>type</th><th></th></tr>
              </thead>
              <tbody>
                {merged.map((c, i) => (
                  <tr key={i} className={`csv-col-${c.status}`}>
                    <td className="csv-col-name">{c.name}</td>
                    <td>
                      <select
                        value={c.type}
                        onChange={e => setColTypes(arr => arr.map((t, j) => j === i ? e.target.value : t))}
                      >
                        <option value="text">text</option>
                        <option value="longtext">long text</option>
                        <option value="number">number</option>
                        <option value="boolean">checkbox</option>
                        <option value="select">single-select</option>
                        <option value="date">date</option>
                        <option value="url">url</option>
                        <option value="email">email</option>
                      </select>
                    </td>
                    <td className={`csv-col-status csv-col-status-${c.status}`}>
                      {c.status === 'matches' ? 'matches existing field'
                        : c.status === 'new-field' ? 'will add to schema'
                        : 'new set'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {previewRows.length > 0 && (
            <>
              <div className="proj-modal-section-label">
                preview · first {previewRows.length} of {parsed.rows.length}
              </div>
              <div className="csv-preview-wrap">
                <table className="csv-preview">
                  <thead>
                    <tr>{colInfo.map((c, i) => <th key={i}>{c.name}</th>)}</tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, ri) => (
                      <tr key={ri}>
                        {colInfo.map((c, ci) => (
                          <td key={ci}>{row[ci] == null ? '' : String(row[ci])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <footer className="proj-modal-foot">
          <button className="proj-modal-cancel" onClick={onClose}>cancel</button>
          <button
            className="proj-modal-create"
            onClick={commit}
            disabled={!canConfirm}
            title={!canConfirm ? 'pick a target set' : ''}
          >
            import {parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'}
            {targetName ? ` → ${targetName}` : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ImportButton — pick a file. CSVs open a target-picker (new set or merge
// into an existing one, with type inference) and emit one INS per row;
// other files encrypt + upload to the homeserver media store and emit a
// single `import` entity that points at the blob.
// ─────────────────────────────────────────────────────────────────────────

function ImportButton({ roomId, disabled, state, onEmit }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // {done, total}
  const [err, setErr] = useState(null);
  const [csvJob, setCsvJob] = useState(null); // {file, parsed}
  const ML = window.MatrixLive;

  function isCsv(file) {
    if (!file) return false;
    if (/\.csv$/i.test(file.name || '')) return true;
    const mt = (file.type || '').toLowerCase();
    return mt === 'text/csv' || mt === 'application/csv';
  }

  async function handleFile(file) {
    if (!file) return;
    setErr(null);
    if (isCsv(file)) {
      try {
        const text = await file.text();
        const rowsRaw = parseCsv(text);
        if (rowsRaw.length === 0) throw new Error('empty CSV');
        const headers = rowsRaw[0];
        const rows = rowsRaw.slice(1);
        setCsvJob({ file, parsed: { headers, rows } });
      } catch (e) {
        console.warn('[csv-import] parse failed:', e);
        setErr(e?.message || 'parse failed');
        setTimeout(() => setErr(null), 4000);
      } finally {
        if (inputRef.current) inputRef.current.value = '';
      }
      return;
    }
    // Non-CSV: existing media-blob import path.
    if (!ML?.importFile) {
      setErr('import unavailable in this mode');
      setTimeout(() => setErr(null), 4000);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
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

  async function runCsvImport({ target, targetIsNew, headers, colTypes, rows, existingFields }) {
    setCsvJob(null);
    if (!onEmit) {
      setErr('cannot emit events here');
      setTimeout(() => setErr(null), 4000);
      return;
    }
    const ME = window.MatrixEngine;
    setBusy(true);
    setProgress({ done: 0, total: rows.length });
    try {
      // 1. Declare the set in _schema.tables if it isn't already.
      const tables = state?.schema?.tables || [];
      if (!tables.includes(target)) {
        await onEmit(ME.OP.DEF, { anchor: null, path: '_schema.tables', value: [...tables, target] });
      }

      // 2. Merge field declarations into _schema.fields.<target>.
      const fieldsByName = new Map();
      for (const f of existingFields) fieldsByName.set(f.name, { ...f });
      for (let i = 0; i < headers.length; i++) {
        const name = headers[i];
        const type = colTypes[i] || 'text';
        if (!fieldsByName.has(name)) {
          fieldsByName.set(name, { name, type });
        }
      }
      const mergedFields = Array.from(fieldsByName.values());
      // Only re-emit if the field list changed — avoids a noop event when
      // every CSV column matches an existing field exactly.
      const schemaChanged = targetIsNew
        || mergedFields.length !== existingFields.length
        || mergedFields.some((f, i) => existingFields[i]?.name !== f.name);
      if (schemaChanged) {
        await onEmit(ME.OP.DEF, {
          anchor: null,
          path: `_schema.fields.${target}`,
          value: mergedFields,
        });
      }

      // 3. INS one entity per CSV row. Use a per-row ts tiebreaker so two
      //    identical rows still produce distinct content-addressed anchors.
      const baseTs = Date.now();
      const sender = ML?.getSession?.()?.mxid || '@you:demo';
      for (let r = 0; r < rows.length; r++) {
        const payload = {};
        for (let c = 0; c < headers.length; c++) {
          const raw = rows[r][c];
          if (raw == null || raw === '') continue;
          payload[headers[c]] = coerceCsvValue(raw, colTypes[c] || 'text');
        }
        const ts = baseTs + r;
        const anchor = ME.makeAnchor(target, payload, sender, ts);
        await onEmit(ME.OP.INS, { anchor, entity_type: target, payload });
        if ((r & 0x1F) === 0) setProgress({ done: r + 1, total: rows.length });
      }
      setProgress({ done: rows.length, total: rows.length });
    } catch (e) {
      console.warn('[csv-import] failed:', e);
      setErr(e?.message || 'import failed');
      setTimeout(() => setErr(null), 5000);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 800);
    }
  }

  const label = busy
    ? (progress ? `importing ${progress.done}/${progress.total}…` : 'uploading…')
    : err ? `failed: ${err}`
    : 'import';

  return (
    <>
      <button
        className="topbar-members"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        title={disabled ? 'sign in to a homeserver to import files'
                        : 'import a CSV / JSON / binary file into this space'}
      >{label}</button>
      <input
        type="file"
        ref={inputRef}
        style={{display:'none'}}
        accept=".csv,text/csv,application/csv,*/*"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      {csvJob && (
        <CsvImportModal
          file={csvJob.file}
          parsed={csvJob.parsed}
          state={state}
          onClose={() => setCsvJob(null)}
          onConfirm={runCsvImport}
        />
      )}
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
  LoginScreen,
  IdentityChip,
  MembersDialog,
  ImportButton,
});

})();
