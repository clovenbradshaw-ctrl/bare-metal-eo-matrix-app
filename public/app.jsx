/* app.jsx — root: rooms store, mode switch, scrubber, tweaks */

(function() {
const { useState, useMemo, useEffect, useRef, useCallback } = React;
const ME = window.MatrixEngine;

// ─────────────────────────────────────────────────────────────────────────
// In-memory event store · persisted for the demo session so spaces and
// edits survive a reload (the real Matrix path persists on its own via
// OPFS + the homeserver).
// ─────────────────────────────────────────────────────────────────────────

const DEMO_STORE_KEY = 'matrix-events.demo.store.v1';

function buildSeedMap() {
  const seed = ME.seedData();
  const map = {};
  for (const e of seed) {
    const r = e.roomId;
    if (!map[r]) map[r] = [];
    const { roomId, ...rest } = e;
    map[r].push(rest);
  }
  return map;
}

function loadDemoStore() {
  try {
    const raw = localStorage.getItem(DEMO_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.byRoom) return null;
    return parsed;
  } catch { return null; }
}

function saveDemoStore(byRoom, titleOverrides) {
  try {
    localStorage.setItem(DEMO_STORE_KEY, JSON.stringify({ byRoom, titleOverrides }));
  } catch {}
}

function clearDemoStore() {
  try { localStorage.removeItem(DEMO_STORE_KEY); } catch {}
}

function useEventStore(initialDemo) {
  const [byRoom, setByRoom] = useState(() => {
    const saved = loadDemoStore();
    if (saved) return saved.byRoom;
    return initialDemo ? buildSeedMap() : { '!scratch': [] };
  });
  const counterRef = useRef(1000);

  function emit(roomId, op, content, sender) {
    const id = `$evt_${(counterRef.current++).toString(16)}`;
    const event = {
      event_id: id,
      type: ME.eventType(op),
      content,
      sender: sender || '@you:demo',
      origin_server_ts: Date.now(),
    };
    setByRoom(s => ({ ...s, [roomId]: [...(s[roomId] || []), event] }));
    return event;
  }

  function createRoom(roomId) {
    setByRoom(s => s[roomId] ? s : { ...s, [roomId]: [] });
  }

  function loadSeed() {
    setByRoom(buildSeedMap());
  }

  function clearAll() {
    setByRoom({ '!scratch': [] });
    clearDemoStore();
  }

  return { byRoom, setByRoom, emit, createRoom, loadSeed, clearAll };
}

// Title overrides for demo spaces (rename in demo mode has no homeserver
// to write to, so we keep the user's chosen name locally and persist it).
function useDemoTitleOverrides() {
  const [overrides, setOverrides] = useState(() => {
    const saved = loadDemoStore();
    return (saved && saved.titleOverrides) || {};
  });
  return [overrides, setOverrides];
}

// ─────────────────────────────────────────────────────────────────────────
// Last-view memory — a refresh (or session resume) reopens the space and
// view that were on screen instead of dropping back to the launchpad. The
// data itself already survives (OPFS + the durable chain in live mode, the
// demo store in demo mode); this remembers *where* the user was. Keyed by
// user so one account never resumes into another's workspace.
// ─────────────────────────────────────────────────────────────────────────

const LAST_VIEW_KEY = 'matrix-events.lastView.v1';

function loadLastView() {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || !v.user) return null;
    return v;
  } catch { return null; }
}

function saveLastView(user, roomId, selection) {
  try {
    if (roomId) {
      localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ user, roomId, selection }));
    } else {
      // Back on the launchpad — a refresh should land there too. Only clear
      // an entry that belongs to this user, so signing in and straight back
      // out doesn't erase another account's resume point.
      const cur = loadLastView();
      if (!cur || cur.user === user) localStorage.removeItem(LAST_VIEW_KEY);
    }
  } catch {}
}

// Only resume into selections the view area knows how to render — a stale
// entry from an older build must fall back to the default view, never to a
// blank pane.
function validSavedSelection(sel) {
  if (!sel || typeof sel !== 'object') return false;
  if (sel.kind === 'log' || sel.kind === 'sync' || sel.kind === 'chat') return true;
  if (sel.kind !== 'slice') return false;
  return ['table', 'schema', 'kanban', 'notebook', 'graph', 'timeline'].includes(sel.sliceKind);
}

// ─────────────────────────────────────────────────────────────────────────
// Cold-start sync status — the bridge proactively pulls every workspace
// back from its durable media-store chain on a fresh load. This hook
// mirrors that progress; SyncIndicator renders it.
// ─────────────────────────────────────────────────────────────────────────

function useSyncStatus(isLive) {
  const ML = typeof window !== 'undefined' ? window.MatrixLive : null;
  const [status, setStatus] = useState(() => (isLive && ML?.getSyncStatus?.()) || null);

  useEffect(() => {
    if (!isLive || !ML?.subscribe) { setStatus(null); return; }
    setStatus(ML.getSyncStatus?.() || null);
    return ML.subscribe((reason) => {
      if (reason === 'sync' || reason === 'session') {
        setStatus(ML.getSyncStatus?.() || null);
      }
    });
  }, [isLive, ML]);

  return status;
}

// Compact, self-dismissing banner describing the durable-storage sync.
// `variant` "banner" is the wide launchpad form; "pill" is the slim topbar
// form. Renders nothing when there's nothing worth saying.
function SyncIndicator({ status, variant = 'banner', onResync }) {
  const [dismissed, setDismissed] = useState(false);
  const phase = status?.phase;

  // Auto-clear the "done" state a few seconds after it lands so the banner
  // doesn't linger once everything is in.
  useEffect(() => {
    setDismissed(false);
    if (phase === 'done') {
      const t = setTimeout(() => setDismissed(true), 4000);
      return () => clearTimeout(t);
    }
  }, [phase, status?.finishedAt]);

  if (!status || phase === 'idle') return null;
  if (phase === 'done' && (status.recovered === 0 || dismissed)) return null;

  const total = status.roomsTotal || 0;
  const done = status.roomsDone || 0;
  const syncing = phase === 'syncing';
  const errored = phase === 'error' || (status.errors && status.errors.length > 0);

  const blocksTotal = status.blocksTotal || 0;
  const blocksDone = status.blocksDone || 0;
  const blockProgress = syncing && blocksTotal
    ? ` · ${blocksDone}/${blocksTotal} blocks`
    : '';
  const label = syncing
    ? `Loading events from durable storage…${total ? ` ${done}/${total}` : ''}${blockProgress}`.trim()
    : errored
      ? `Synced with issues — ${status.recovered} event${status.recovered === 1 ? '' : 's'} recovered`
      : `Synced · ${status.recovered} event${status.recovered === 1 ? '' : 's'} restored from durable storage`;

  const sub = syncing && status.currentRoomName
    ? `restoring ${status.currentRoomName}…`
    : null;

  const cls = `sync-indicator sync-${variant} ${syncing ? 'is-syncing' : ''} ${errored ? 'is-error' : ''} ${phase === 'done' ? 'is-done' : ''}`;

  return (
    <div className={cls} role="status" aria-live="polite" title={label}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-label">{label}</span>
      {sub && variant === 'banner' && <span className="sync-sub">{sub}</span>}
      {!syncing && onResync && (
        <button className="sync-resync" onClick={onResync} title="re-sync from durable storage">
          re-sync
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Workspaces home — what you see right after signing in. Lists every
// space as a card; you pick one to enter, or create a new one. No data
// editing happens here, by design: this is the launchpad.
// ─────────────────────────────────────────────────────────────────────────

function WorkspacesHome({
  session, rooms, isLive, syncReady, syncStatus, onResync,
  onEnter, onCreate, onSignOut, onAcceptInvite, onOpenAccount,
}) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  const demo = !!session?.demo;
  const stale = !demo && !!session?.stale;
  const myLocal = (session?.mxid || '').replace(/^@/, '').split(':')[0];

  // Show a "loading" placeholder while a real Matrix sync is still warming
  // up — otherwise we briefly flash "no spaces yet" before rooms arrive.
  const loading = isLive && !syncReady && rooms.length === 0;

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setErr(null);
    setCreating(true);
    try {
      await onCreate(name);
      setNewName('');
    } catch (e) {
      setErr(e?.message || 'could not create space');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="wh-shell">
      <div className="wh-topbar">
        <div className="wh-brand">
          <span className="wh-brand-mark">▦</span>
          <span>workspace</span>
        </div>
        <span className="wh-spacer" />
        <window.IdentityChip session={session} onSignOut={onSignOut} onOpenAccount={onOpenAccount} />
      </div>

      <div className="wh-body">
        {isLive && <SyncIndicator status={syncStatus} variant="banner" onResync={onResync} />}
        <div className="wh-hero">
          <div className="wh-greeting">
            welcome{myLocal ? `, ${myLocal}` : ''}
          </div>
          <div className="wh-tagline">
            {loading
              ? 'loading your spaces from the homeserver…'
              : rooms.length > 0
                ? 'pick a space to enter, or start a new one.'
                : demo
                  ? 'create your first space — it will be saved locally in this browser.'
                  : stale
                    ? 'local-only mode — these are the spaces cached on this device.'
                    : 'create your first space to get started.'}
          </div>
          {stale && (
            <div className="wh-stale-hint">
              you are offline / local-only. reconnect from the menu above to sync changes.
            </div>
          )}
        </div>

        {loading ? (
          <div className="wh-loading">…</div>
        ) : (
          <div className="wh-grid">
            {rooms.map(r => {
              const title = r.title || 'untitled space';
              const initial = (title[0] || '?').toUpperCase();
              const isInvite = r.membership === 'invite';
              // App-created rooms are always E2EE. An invite that claims to
              // be a workspace but isn't encrypted didn't come from this app
              // — most likely a stranger who stamped the app's meta event to
              // get their room into your list. Flag it; don't auto-hide
              // (a pre-E2EE collaborator could send a legit unencrypted one).
              const suspectInvite = isInvite && r.encrypted === false;
              return (
                <button
                  key={r.id}
                  className={`wh-card ${isInvite ? 'wh-card-invite' : ''} ${suspectInvite ? 'wh-card-suspect' : ''}`}
                  onClick={() => isInvite ? onAcceptInvite?.(r.id) : onEnter(r.id)}
                  title={suspectInvite ? `${r.id}\n⚠ This invite is not encrypted and may not be from this app.` : r.id}
                >
                  <span className="wh-card-sigil">{initial}</span>
                  <span className="wh-card-name">{title}</span>
                  <span className="wh-card-meta">
                    {isInvite
                      ? `${suspectInvite ? '⚠ unencrypted invite' : 'invite'}${r.inviter ? ` from ${r.inviter}` : ''}`
                      : r.eventCount > 0
                        ? `${r.eventCount} events`
                        : 'empty'}
                  </span>
                  {isInvite && <span className="wh-card-action">accept →</span>}
                </button>
              );
            })}

            <div className="wh-card wh-card-new">
              <span className="wh-card-sigil wh-card-sigil-new">+</span>
              <div className="wh-new-form">
                <input
                  ref={inputRef}
                  className="wh-new-input"
                  value={newName}
                  placeholder="name a new space"
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                  disabled={creating || stale}
                />
                <button
                  className="wh-new-btn"
                  onClick={handleCreate}
                  disabled={!newName.trim() || creating || stale}
                >
                  {creating ? 'creating…' : 'create'}
                </button>
              </div>
              {stale && (
                <span className="wh-card-meta">reconnect to create new spaces</span>
              )}
              {err && <span className="wh-card-err">{err}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Room picker dropdown — replaces the rooms column
// ─────────────────────────────────────────────────────────────────────────

function RoomPicker({ rooms, currentRoomId, setCurrentRoomId, onCreateRoom, demoOn, onToggleDemo, isLive, onManageMembers }) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function close(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const current = rooms.find(r => r.id === currentRoomId);
  const label = current ? (current.title || 'untitled workspace') : (rooms.length ? 'pick a workspace' : 'no workspaces');

  return (
    <div className="room-picker" ref={ref}>
      <button className="pickbtn" onClick={() => setOpen(o => !o)}>
        {!isLive && (
          <span className={`demo-dot ${demoOn ? '' : 'off'}`}
            title={demoOn ? 'demo data on' : 'demo data off'} />
        )}
        <span>{label}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="panel">
          {!isLive && (
            <div className="demo-toggle">
              <span>demo data</span>
              <button className={`chip ${demoOn ? 'on' : ''}`} onClick={() => { onToggleDemo(); }}>
                {demoOn ? 'on' : 'off'}
              </button>
            </div>
          )}
          <div className="panel-head">workspaces · {rooms.length}</div>
          {rooms.length === 0 && (
            <div style={{padding:'10px 12px',fontSize:11,color:'var(--text-dim)',fontStyle:'italic'}}>
              {isLive
                ? 'no workspaces yet — create one below.'
                : 'no workspaces yet.'}
            </div>
          )}
          {rooms.map(r => (
            <div
              key={r.id}
              className={`room-row ${r.id === currentRoomId ? 'active' : ''}`}
              onClick={() => { setCurrentRoomId(r.id); setOpen(false); }}
              title={r.id}
            >
              <span className="rname">
                {r.title || 'untitled workspace'}
                {r.membership === 'invite' && (
                  <span style={{marginLeft:6,color:'var(--signal)',fontSize:10,textTransform:'uppercase'}}>invite</span>
                )}
              </span>
              <span className="rmeta">{r.eventCount} ev</span>
              {isLive && r.membership === 'join' && onManageMembers && (
                <button
                  className="sp-row-share"
                  style={{marginLeft:8}}
                  onClick={(e) => { e.stopPropagation(); setOpen(false); onManageMembers(r.id); }}
                  title="manage members of this space"
                >members</button>
              )}
            </div>
          ))}
          <div className="new-room">
            <input
              value={newName}
              placeholder="new workspace name"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newName) { onCreateRoom(newName); setNewName(''); setOpen(false); } }}
            />
            <button onClick={() => { if (newName) { onCreateRoom(newName); setNewName(''); setOpen(false); } }}>+</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Scrubber
// ─────────────────────────────────────────────────────────────────────────

function Scrubber({ cursor, total, ts, onSeek, onLive, live }) {
  return (
    <div className="scrubber">
      <span className="label">
        fold(events[0..<b>{cursor}</b>]) <span className="muted">/ {total}</span>
      </span>
      <input
        type="range"
        min={0}
        max={total}
        value={cursor}
        onChange={e => onSeek(Number(e.target.value))}
      />
      <button className={live ? 'live' : ''} onClick={onLive}>
        {live ? '● live' : 'go live'}
      </button>
      <span className="ts">{ts ? new Date(ts).toISOString().slice(11, 23) : '—'}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tweaks
// ─────────────────────────────────────────────────────────────────────────

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "showViolations": true,
  "showHwm": true,
  "showSchemaDDL": false,
  "defaultMode": "table",
  "demoOnStart": true
}/*EDITMODE-END*/;

function TweakControls({ t, setTweak, onLoadSeed, onClearAll }) {
  const { TweaksPanel, TweakSection, TweakToggle, TweakRadio, TweakButton } = window;
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Log">
        <TweakToggle label="Show violations"
          value={t.showViolations} onChange={v => setTweak('showViolations', v)} />
        <TweakToggle label="Show entity _hwm"
          value={t.showHwm} onChange={v => setTweak('showHwm', v)} />
      </TweakSection>
      <TweakSection label="Set">
        <TweakToggle label="Show CREATE SET DDL"
          value={t.showSchemaDDL} onChange={v => setTweak('showSchemaDDL', v)} />
      </TweakSection>
      <TweakSection label="Start in">
        <TweakRadio
          value={t.defaultMode}
          onChange={v => setTweak('defaultMode', v)}
          options={[
            { value: 'db',    label: 'log'    },
            { value: 'table', label: 'sets'   },
            { value: 'graph', label: 'graph'  },
            { value: 'app',   label: 'kanban' },
          ]}
        />
      </TweakSection>
      <TweakSection label="Data">
        <TweakButton label="Reload demo seed" onClick={onLoadSeed} />
        <TweakButton label="Clear all" onClick={onClearAll} />
      </TweakSection>
    </TweaksPanel>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// Live event store — mirrors window.MatrixLive into React state
// ─────────────────────────────────────────────────────────────────────────

function useLiveStore(enabled, currentRoomId) {
  const [tick, setTick] = useState(0);
  const ML = window.MatrixLive;

  useEffect(() => {
    if (!enabled || !ML) return;
    return ML.subscribe(() => setTick(t => t + 1));
  }, [enabled, ML]);

  // Open current room when it changes
  useEffect(() => {
    if (!enabled || !ML || !currentRoomId) return;
    if (currentRoomId.startsWith('!')) {
      ML.openRoom(currentRoomId).catch(e => console.warn('[app] openRoom failed:', e));
    }
  }, [enabled, ML, currentRoomId, tick]);

  if (!enabled || !ML) {
    return { byRoom: {}, committedByRoom: {}, rooms: [], emit: null, createRoom: null };
  }

  const rooms = ML.listRooms();
  const byRoom = {};
  const committedByRoom = {};
  for (const r of rooms) {
    // Only the active room is folded by the UI, so only it needs its events
    // materialized. We surface the committed (append-only) prefix and the
    // merged list separately so the fold can cache the committed prefix and
    // re-derive only the small, volatile pending tail each render.
    if (currentRoomId === r.id) {
      committedByRoom[r.id] = ML.getCommittedForRoom?.(r.id) ?? ML.getEventsForRoom(r.id);
      byRoom[r.id] = ML.getEventsForRoom(r.id);
    } else {
      committedByRoom[r.id] = [];
      byRoom[r.id] = [];
    }
  }
  return {
    byRoom,
    committedByRoom,
    rooms,
    emit: (roomId, op, content) => ML.emit(roomId, op, content),
    createRoom: (name) => ML.createRoom(name),
    inviteUser: (roomId, userId) => ML.inviteUser(roomId, userId),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Incremental fold
//
// Folding the whole event log on every edit is O(events) per keystroke —
// fine for a demo, painful for a real room with one event per cell edit.
// The committed log is strictly append-only, so we cache its fold and, on
// the next render, extend the cached accumulator with only the new tail
// (O(new events)). Pending (optimistic, not-yet-acked) events are small and
// volatile, so they're folded fresh on top of a copy that leaves the cache
// intact. Time-travel to a position behind the cache folds that prefix from
// scratch without disturbing the warm live cache.
// ─────────────────────────────────────────────────────────────────────────

const EMPTY_EVENTS = [];

// Shallow-copy a fold state's top-level containers. Inner entity objects are
// shared — safe because nothing downstream mutates state, only the fold does,
// and the fold only ever mutates through copies created here.
function shallowCopyState(s) {
  return {
    entities: { ...s.entities },
    partitions: { ...s.partitions },
    connections: s.connections.slice(),
    frames: s.frames.slice(),
    schema: s.schema,
    cursor: s.cursor,
    _violations: s._violations.slice(),
  };
}

// Anchors a pending event may mutate. Cloning just these entities before
// folding pending keeps the cached committed state untouched.
function pendingAnchors(ev) {
  const c = ev && ev.content;
  if (!c) return [];
  const out = [];
  if (c.anchor) out.push(c.anchor);
  if (c.source_anchor) out.push(c.source_anchor);
  if (c.target_anchor) out.push(c.target_anchor);
  if (Array.isArray(c.input_anchors)) out.push(...c.input_anchors);
  return out;
}

// Fold `pending` on top of the cached committed state `cs` without mutating
// it: copy the containers, deep-copy only the entities pending will touch
// (new entities pending creates are unshared already), then dispatch.
function foldPendingOnto(ME, cs, pending) {
  if (!pending || pending.length === 0) return cs;
  const state = shallowCopyState(cs);
  const touched = new Set();
  for (const ev of pending) for (const a of pendingAnchors(ev)) touched.add(a);
  for (const a of touched) {
    if (state.entities[a]) state.entities[a] = structuredClone(state.entities[a]);
  }
  return pending.reduce(ME.dispatch, state);
}

// Return the fold of `committed[0..cc]`, reusing/extending `cache` when the
// cached prefix is still valid (committed is append-only, checked by the
// event_id at the cache boundary). Mutates `cache` only when extending the
// live head; scrub-behind queries fold a fresh prefix and leave it alone.
function foldCommitted(ME, cache, committed, cc, roomId) {
  const ccLastId = cc > 0 ? committed[cc - 1].event_id : null;
  const cacheUsable =
    cache.state &&
    cache.roomId === roomId &&
    cache.count <= committed.length &&
    (cache.count === 0 || committed[cache.count - 1]?.event_id === cache.lastId);

  if (cacheUsable && cc >= cache.count) {
    if (cc > cache.count) {
      cache.state = committed.slice(cache.count, cc).reduce(ME.dispatch, cache.state);
      cache.count = cc;
      cache.lastId = ccLastId;
    }
    return cache.state;
  }

  if (cacheUsable && cc < cache.count) {
    // Scrubbed behind the live head — fold this prefix fresh, keep cache warm.
    return ME.fold(committed.slice(0, cc));
  }

  // Cold (room switch / first fold): rebuild and seed the cache at the head.
  const fresh = ME.fold(committed.slice(0, cc));
  cache.roomId = roomId;
  cache.count = cc;
  cache.lastId = ccLastId;
  cache.state = fresh;
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────
// View error boundary. The view tree is transpiled in-browser and leans on
// lazily-loaded globals (window.ChatView, the eoreader engine, …); a single
// render throw used to unmount the whole React root and leave a blank screen
// with no clue why. This contains the failure to the view area: the sidebar
// and topbar stay live so the user can switch away, the real error is shown
// (and logged) instead of a white page, and "Reset & reload" clears a stale
// service-worker shell — the usual culprit when a view stops loading after a
// deploy. Keyed by the current selection so navigating away clears the error.
// ─────────────────────────────────────────────────────────────────────────
async function hardReset() {
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) { /* best-effort — reload regardless */ }
  window.location.reload();
}

class ViewErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    try { console.error('[view crash]', error, info && info.componentStack); } catch (e) {}
  }
  render() {
    const err = this.state.error;
    if (!err) return this.props.children;
    const msg = err && err.message ? err.message : String(err);
    const appLevel = this.props.level === 'app';
    return (
      <div className="view-error" role="alert">
        <div className="view-error-card">
          <div className="view-error-title">
            <i className="ph ph-warning-octagon" aria-hidden="true"></i>
            {appLevel ? 'The app hit an error and couldn’t render' : 'This view hit an error and couldn’t render'}
          </div>
          <pre className="view-error-msg">{msg}</pre>
          <p className="view-error-hint">
            {appLevel
              ? 'Reload to recover. If this started after an update, “Reset & reload” clears the cached app shell, which is the usual fix.'
              : 'The rest of the app is still working — switch views in the sidebar, or reload. If this started after an update, “Reset & reload” clears the cached app shell.'}
          </p>
          <div className="view-error-actions">
            <button className="view-error-btn" onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="view-error-btn" onClick={() => window.location.reload()}>Reload</button>
            <button className="view-error-btn primary" onClick={hardReset}>Reset &amp; reload</button>
          </div>
        </div>
      </div>
    );
  }
}

function App() {
  const [session, setSession, booting] = window.useSession();
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  // Demo source (in-memory + seed); used when session.demo OR no session.
  const demoStore = useEventStore(tweaks.demoOnStart);

  // Live source (real Matrix via the bridge); only active when authed real.
  const isLive = !!session && !session.demo;
  const [currentRoomId, setCurrentRoomId] = useState(null);
  const liveStore = useLiveStore(isLive, currentRoomId);

  // Cold-start durable-storage sync progress (drives the sync indicator).
  const syncStatus = useSyncStatus(isLive);
  const onResync = () => { window.MatrixLive?.resync?.(); };

  // Pick the active source and pin the engine namespace synchronously, so
  // every fold below sees the right NS prefix.
  const dataSource = isLive ? liveStore : demoStore;
  ME.setNamespace(isLive ? (window.MatrixLive?.NAMESPACE || 'io.matrix-events') : 'demo.tasks');

  const byRoom = dataSource.byRoom;
  const roomIds = Object.keys(byRoom);

  // Drop a stale currentRoomId if the underlying source no longer has
  // that room (e.g. demo data cleared, room deleted on another device).
  // We deliberately do NOT auto-select a room for a fresh sign-in — landing
  // on the welcome screen is the desired flow; resuming the last-open space
  // after a refresh is handled separately below.
  useEffect(() => {
    if (!session) return;
    if (currentRoomId && !byRoom[currentRoomId]) {
      setCurrentRoomId(null);
    }
  }, [session, isLive, roomIds.join('|')]);

  const syncReady = isLive && window.MatrixLive
    ? ['PREPARED', 'SYNCING'].includes(window.MatrixLive.getSyncState?.())
    : false;

  const [selection, setSelection] = useState({ kind: 'slice', sliceId: 'task.table', tableId: 'task', sliceKind: 'table' });
  const [cursor, setCursor] = useState(Infinity);
  const [highlight, setHighlight] = useState(null);
  const [ephemerals, setEphemerals] = useState([]);
  const ephCounterRef = useRef(0);
  const [demoOn, setDemoOn] = useState(tweaks.demoOnStart);

  const [membersDialogRoomId, setMembersDialogRoomId] = useState(null);
  // Account dashboard: null when closed, else the tab to open ('profile' |
  // 'security' | 'people'). Live (non-demo) sessions only.
  const [accountTab, setAccountTab] = useState(null);

  const [csvImport, setCsvImport] = useState(null); // {id, file, roomId} | null
  const [airtableImport, setAirtableImport] = useState(null); // {id} | null
  const [exportingSchema, setExportingSchema] = useState(false);
  // Time-travel scrubber: collapsed by default; opens via the topbar toggle.
  // We also force-open it whenever the cursor is *not* live, so the user
  // can always see/return from a scrubbed state.
  const [scrubberOpen, setScrubberOpen] = useState(false);
  // Demo mode has no homeserver to push room renames to, so we keep the
  // user's chosen names in-memory and merge them into the rooms list.
  const [demoTitleOverrides, setDemoTitleOverrides] = useDemoTitleOverrides();

  // Persist demo edits — the in-memory event store and title overrides —
  // so signing back in later still shows the spaces you made.
  useEffect(() => {
    if (isLive) return; // real Matrix persists on its own (OPFS + server)
    saveDemoStore(demoStore.byRoom, demoTitleOverrides);
  }, [isLive, demoStore.byRoom, demoTitleOverrides]);

  // Resume where you left off: when this user's session lands (page refresh,
  // vault auto-restore, or re-login after an expired session), reopen the
  // space + view that were on screen last time. The saved space may not be in
  // the rooms list on the very first render (the offline manifest / SDK sync
  // can still be loading), so the attempt re-runs as the list settles — but
  // only briefly after load, and never over a navigation the user already
  // made. An explicit sign-out clears the memory (see handleSignOut), so a
  // deliberate fresh sign-in still starts at the welcome screen.
  const sessionUserKey = session ? (session.demo ? 'demo' : session.mxid) : null;
  const restoredUserRef = useRef(null);
  const mountTsRef = useRef(Date.now());
  useEffect(() => {
    if (!sessionUserKey) { restoredUserRef.current = null; return; }
    if (restoredUserRef.current === sessionUserKey) return;
    if (currentRoomId) { restoredUserRef.current = sessionUserKey; return; }
    const saved = loadLastView();
    if (!saved || saved.user !== sessionUserKey || !saved.roomId) {
      restoredUserRef.current = sessionUserKey;
      return;
    }
    if (!byRoom[saved.roomId]) {
      // Rooms are still arriving — leave the attempt armed for the next list
      // change, but stop teleporting once the user has settled on the
      // launchpad for a while (a deleted room would otherwise re-arm forever).
      if (Date.now() - mountTsRef.current > 15000) restoredUserRef.current = sessionUserKey;
      return;
    }
    restoredUserRef.current = sessionUserKey;
    setCurrentRoomId(saved.roomId);
    if (validSavedSelection(saved.selection)) setSelection(saved.selection);
  }, [sessionUserKey, currentRoomId, roomIds.join('|')]);

  // …and remember the open space + view for that resume. Recording the
  // launchpad (roomId = null) too means a refresh from the launchpad stays
  // there instead of bouncing back into the last space. The first run per
  // user is skipped: it fires in the same commit as the restore above, when
  // currentRoomId still holds its pre-restore null — persisting that would
  // clobber the very entry being restored.
  const lastPersistKeyRef = useRef(null);
  useEffect(() => {
    if (!sessionUserKey) { lastPersistKeyRef.current = null; return; }
    if (lastPersistKeyRef.current !== sessionUserKey) {
      lastPersistKeyRef.current = sessionUserKey;
      return;
    }
    saveLastView(sessionUserKey, currentRoomId, currentRoomId ? selection : null);
  }, [sessionUserKey, currentRoomId, selection]);

  // Derived values needed by hooks below; computed before the auth gate so
  // the hook order is stable across signed-in / signed-out renders.
  const allEvents = byRoom[currentRoomId] || [];
  const total = allEvents.length;
  const effectiveCursor = Math.min(cursor, total);
  const ts = effectiveCursor > 0 ? allEvents[effectiveCursor - 1].origin_server_ts : null;
  const live = cursor >= total;

  useEffect(() => { if (live) setCursor(Infinity); }, [total]); // eslint-disable-line

  // Committed (append-only) prefix vs the small pending tail. allEvents is
  // committed ++ pending, so the first `committedCount` events are committed.
  // Demo mode has no pending — committed === allEvents.
  const committed = (isLive ? (dataSource.committedByRoom?.[currentRoomId]) : allEvents) || EMPTY_EVENTS;
  const committedCount = committed.length;
  const cc = Math.min(effectiveCursor, committedCount);
  const pendingPart = effectiveCursor > committedCount
    ? allEvents.slice(committedCount, effectiveCursor)
    : EMPTY_EVENTS;

  // Incremental fold cache for the active room's committed log (see helpers
  // above). Survives re-renders; rekeyed on room switch by foldCommitted.
  const foldCacheRef = useRef({ roomId: null, count: 0, lastId: null, state: null });

  // A cheap signature of everything the fold depends on. Only when it changes
  // do we produce a new state object — so identity stays stable when nothing
  // changed (keeping downstream memos warm), and folding extends the cache by
  // just the new events otherwise.
  const lastCommittedId = cc > 0 ? committed[cc - 1].event_id : '';
  const pendingSig = pendingPart.length
    ? pendingPart.map(e => e.event_id).join(',')
    : '';
  const foldSig = `${currentRoomId || ''}|${cc}|${lastCommittedId}|${pendingSig}`;

  const state = useMemo(() => {
    const committedState = foldCommitted(ME, foldCacheRef.current, committed, cc, currentRoomId);
    if (pendingPart.length === 0) {
      // No pending: hand back a fresh top-level object (new identity for React)
      // that shares the cached inner state — never mutated downstream.
      return shallowCopyState(committedState);
    }
    return foldPendingOnto(ME, committedState, pendingPart);
  }, [foldSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Large CSV imports don't emit one event per row — a 10k-row sheet would
  // blow past Matrix's per-event size limit. The importer instead stores
  // the source blob in the media store and leaves a single `import` entity
  // carrying the field plan. We reconstruct the row records here, on demand,
  // and merge them into the state every data view renders from. Without this
  // step the import shows up as a lone `import` entity and the rows never
  // become records.
  const importRowsRef = useRef({});        // import anchor -> row entity[]
  const inFlightRef   = useRef(new Set());
  const retryRef      = useRef({});        // import anchor -> retry attempts
  const noProgressRef = useRef(0);         // consecutive materialize passes with no new chunk
  const lastPendingRef = useRef(-1);       // un-materialized chunk count at the last pass
  const [importRowsVersion, setImportRowsVersion] = useState(0);

  // Only the newest generation of each re-synced source materializes: a
  // re-import of the same Airtable base+table supersedes its prior rows rather
  // than duplicating them (see CsvImport.activeImports).
  const importEntities = useMemo(() => {
    const all = Object.values(state.entities || {}).filter(
      e => e?._type === 'import' && e.derived_set && Array.isArray(e.field_plan)
    );
    return window.CsvImport?.activeImports ? window.CsvImport.activeImports(all) : all;
  }, [state]);

  const activeImportAnchors = useMemo(
    () => new Set(importEntities.map(e => e._anchor)),
    [importEntities]
  );

  // Source blobs of *superseded* import generations. A re-synced Airtable
  // base+table uploads a fresh blob each time; the old generation stops
  // materializing (CsvImport.activeImports keeps only the newest per group) but
  // its mirrored blob lingers in OPFS forever — unbounded growth across
  // re-syncs. Collect the dead mxcs (excluding any still referenced by a live
  // generation) so the sync page can reclaim that disk on demand.
  const reclaimableMedia = useMemo(() => {
    const activeMxc = new Set(importEntities.map(e => e.file?.mxc).filter(Boolean));
    const dead = new Set();
    for (const e of Object.values(state.entities || {})) {
      if (e?._type === 'import' && e.file?.mxc &&
          !activeImportAnchors.has(e._anchor) && !activeMxc.has(e.file.mxc)) {
        dead.add(e.file.mxc);
      }
    }
    return Array.from(dead);
  }, [state, importEntities, activeImportAnchors]);

  // Drop cached row arrays for imports that aren't active anymore — a re-synced
  // table supersedes its old import anchor and the old rows would otherwise sit
  // in memory forever. (A 50k-row Airtable table is ~10MB per cached generation.)
  useEffect(() => {
    const cache = importRowsRef.current;
    let pruned = false;
    for (const a of Object.keys(cache)) {
      if (!activeImportAnchors.has(a)) { delete cache[a]; pruned = true; }
    }
    if (pruned) {
      // Also clear any retry bookkeeping for the dropped anchors.
      for (const a of Object.keys(retryRef.current)) {
        if (!activeImportAnchors.has(a)) delete retryRef.current[a];
      }
    }
  }, [activeImportAnchors]);

  // NOTE: we deliberately do NOT register a memory evictor that drops the
  // materialized import rows under pressure. An earlier version did, but it
  // thrashed instead of shedding:
  //   • It cleared only this component's `importRowsRef`, while the canonical
  //     copy of every parsed row lives in CsvImport's module-level
  //     `importRowCache` (csv-import.jsx). Those are the same array objects, so
  //     deleting them here freed almost nothing — the rows stayed resident.
  //   • It then bumped `importRowsVersion`, which immediately re-ran the
  //     materialize effect below and re-filled `importRowsRef` from that
  //     surviving cache.
  // The net effect under sustained pressure: the 10s heap sampler fired the
  // evictor every interval, so `renderState` dropped its import rows (the table
  // and its counts flashed to zero) and then "reloaded" them a beat later — a
  // visible refresh loop that never actually reclaimed the memory it targeted.
  // Import-row memory is bounded by the dataset itself; the structural room/SDK
  // caps (src/main.js) carry the heap budget. If real import-row shedding is
  // ever wanted, it has to clear `importRowCache` too AND stop the materialize
  // effect from eagerly re-fetching, or it will just thrash again.

  // The table the user is looking at — its import chunks materialize first.
  const activeSet = selection?.tableId || null;

  useEffect(() => {
    const CI = window.CsvImport;
    if (!CI?.materializeImportRows) return;
    let cancelled = false;
    const timers = [];

    // Materialize the OPEN table's chunks first, then the rest in chunk order.
    // On a fresh device the media cache is cold, so each chunk is a network
    // download + decrypt + parse; ordering by the active set means the table
    // you opened paints before the rest of the base streams in behind it.
    const queue = importEntities.slice().sort((a, b) => {
      const aa = a.derived_set === activeSet ? 0 : 1;
      const bb = b.derived_set === activeSet ? 0 : 1;
      if (aa !== bb) return aa - bb;
      const ac = a.chunk_index ?? 0;
      const bc = b.chunk_index ?? 0;
      if (ac !== bc) return ac - bc;
      return (a._created || 0) - (b._created || 0);
    });

    async function materialize(imp) {
      const a = imp._anchor;
      if (importRowsRef.current[a] || inFlightRef.current.has(a)) return;
      inFlightRef.current.add(a);
      try {
        const rows = await CI.materializeImportRows(imp);
        if (Array.isArray(rows)) {
          // Successfully parsed (possibly to zero rows). Cache always — even if
          // this run was superseded — so a re-run skips the work instead of
          // re-downloading; only nudge a render while still current.
          importRowsRef.current[a] = rows;
          if (!cancelled) setImportRowsVersion(v => v + 1);
        } else {
          // Couldn't materialize yet — the import entity's `file` ref hasn't
          // folded in (it DEFs in after the INS), or the media blob is still
          // downloading/decrypting after a cold load. Do NOT cache an empty
          // result (that would hide the rows permanently); leave it for the
          // next pass. The pass-level re-kick below keeps retrying on a backoff
          // until every chunk lands, so the data finishes loading on its own —
          // no manual refresh needed.
          retryRef.current[a] = (retryRef.current[a] || 0) + 1;
        }
      } catch (e) {
        console.warn('[app] could not materialize import rows:', e);
      } finally {
        inFlightRef.current.delete(a);
      }
    }

    // Bounded-concurrency pool over the priority-ordered queue: a few parallel
    // chunk downloads warm the open table fast without flooding the network.
    let idx = 0;
    const CONCURRENCY = 4;
    async function worker() {
      while (!cancelled && idx < queue.length) await materialize(queue[idx++]);
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) workers.push(worker());

    // Self-healing tail: once this pass settles, if any chunk is still
    // un-materialized, schedule one re-kick on a backoff and keep going until
    // they all land. Each successful chunk already bumps importRowsVersion
    // (re-running this effect), so a re-kick is only scheduled from a pass that
    // made no progress — i.e. the blobs genuinely weren't ready yet. We track
    // consecutive no-progress passes so a permanently-missing blob eventually
    // stops retrying instead of polling the network forever. This is what lets
    // a cold device finish downloading every record without the user poking a
    // refresh button.
    Promise.all(workers).then(() => {
      if (cancelled) return;
      const pending = queue.filter(imp => !importRowsRef.current[imp._anchor]).length;
      if (pending === 0) { noProgressRef.current = 0; lastPendingRef.current = -1; return; }
      // Progress made this pass (fewer pending than last time) resets the
      // patience counter; a stalled pass spends it.
      if (lastPendingRef.current < 0 || pending < lastPendingRef.current) noProgressRef.current = 0;
      else noProgressRef.current += 1;
      lastPendingRef.current = pending;
      if (noProgressRef.current <= 40) {
        const delay = Math.min(15000, 1000 * (noProgressRef.current + 1));
        timers.push(setTimeout(() => setImportRowsVersion(v => v + 1), delay));
      }
    }).catch(() => {});

    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [importEntities, importRowsVersion, activeSet]);

  // Imported rows don't live in the event log — they're reconstructed from the
  // encrypted source blob in the media cache (OPFS) on a reload, or pulled from
  // the homeserver media store on a cold device. Either way the bytes aren't
  // readable the instant the fold restores: the vault has to unlock before the
  // OPFS mirror can be decrypted, and a cold device has to sync far enough to
  // fetch the blob. The materialize effect above re-attempts as `importEntities`
  // settle, but its retry budget is bounded and the queue can drain *before*
  // readiness lands — and once it has, nothing re-nudges it. That's the reload
  // bug where the data is sitting in OPFS yet only appears after a manual
  // sync-page refresh (which just bumps `importRowsVersion`).
  //
  // So: while any active import is still un-materialized, listen for the
  // client-readiness signals — `session` (vault unlocked / session restored),
  // `sync` (cold-sync pulling blobs into OPFS, fired per chunk), `rooms` (a
  // workspace opened) — and re-run materialization on each. This is the manual
  // refresh, automated; it self-unsubscribes the moment every import is local.
  const importsPending = importEntities.some(e => !importRowsRef.current[e._anchor]);
  useEffect(() => {
    const ML = window.MatrixLive;
    if (!isLive || !ML?.subscribe || !importsPending) return;
    return ML.subscribe(reason => {
      if (reason === 'session' || reason === 'sync' || reason === 'rooms') {
        setImportRowsVersion(v => v + 1);
      }
    });
  }, [isLive, importsPending]);

  // State the data views render from: the folded state plus any rows
  // reconstructed from imported source blobs. Real folded entities win on
  // anchor collisions, so editing a materialized row (which emits real
  // events) takes precedence over the reconstructed copy.
  const renderState = useMemo(() => {
    const byAnchor = importRowsRef.current;
    // Only inject rows whose import entity exists at the current cursor AND is
    // the active (newest) generation of its source. The first guard stops
    // time-travel before an import from conjuring its rows; the second stops a
    // superseded re-sync's cached rows from duplicating the current one.
    const anchors = Object.keys(byAnchor).filter(a => state.entities?.[a] && activeImportAnchors.has(a));
    if (!anchors.length) return state;
    const entities = {};
    for (const a of anchors) for (const row of byAnchor[a]) entities[row._anchor] = row;
    Object.assign(entities, state.entities);

    // Resolve Airtable record-link fields into live connections. Each imported
    // row carries a hidden `_recordId` (its own Airtable id) and `_linkRefs`
    // (per link-field arrays of TARGET record ids). With a record-id → anchor
    // index across every materialized table, those become the same CON edges a
    // hand-drawn link produces — so link columns populate without per-row
    // events. Falls back to the folded connections when there's nothing to add.
    let connections = state.connections;
    const idIndex = new Map();
    let hasLinkRefs = false;
    for (const a of anchors) {
      for (const row of byAnchor[a]) {
        if (row._recordId) idIndex.set(row._recordId, row._anchor);
        if (row._linkRefs) hasLinkRefs = true;
      }
    }
    if (hasLinkRefs && idIndex.size) {
      const derived = [];
      const seen = new Set();
      for (const a of anchors) {
        for (const row of byAnchor[a]) {
          const refs = row._linkRefs;
          if (!refs) continue;
          for (const field of Object.keys(refs)) {
            const { rel, ids } = refs[field];
            for (const id of ids) {
              const target = idIndex.get(id);
              if (!target || target === row._anchor) continue;
              const key = row._anchor + '|' + target + '|' + (rel || field);
              if (seen.has(key)) continue;
              seen.add(key);
              derived.push({ source: row._anchor, target, type: rel || field, _derived: 'airtable' });
            }
          }
        }
      }
      if (derived.length) connections = [...state.connections, ...derived];
    }

    return { ...state, entities, connections };
  }, [state, importRowsVersion, activeImportAnchors]);

  // Per-table sync transparency: for each set, how many records it SHOULD hold
  // vs how many are actually materialized on this device. For imported sets the
  // "should" is the row count recorded at import time (rows_imported), and the
  // gap is rows still streaming out of the cached source blob; for native sets
  // the records ARE the folded entities, so should === local. Drives the sync
  // page and the sidebar's "out of date" dot.
  const syncTables = useMemo(() => {
    const declared = state.schema?.tables || [];
    const names = Array.from(new Set([
      ...declared,
      ...Object.values(state.entities || {}).map(e => e._type),
    ])).filter(n => n && !n.startsWith('_') && n !== 'import');

    const rowsByType = {};
    for (const e of Object.values(renderState.entities || {})) {
      if (e._type) rowsByType[e._type] = (rowsByType[e._type] || 0) + 1;
    }

    return names.map(name => {
      const imports = importEntities.filter(e => e.derived_set === name);
      const isImport = imports.length > 0;
      const expectedImported = imports.reduce((s, e) => s + (e.rows_imported || 0), 0);
      const localRows = rowsByType[name] || 0;
      return {
        name,
        localRows,
        expected: isImport ? Math.max(expectedImported, localRows) : localRows,
        isImport,
        chunksTotal: imports.length,
        chunksReady: imports.filter(e => importRowsRef.current[e._anchor]).length,
        declared: declared.includes(name),
      };
    }).sort((a, b) => (b.expected - a.expected) || a.name.localeCompare(b.name));
  }, [state, renderState, importEntities, importRowsVersion]);

  // Lookup by set name so the sidebar can show each table's "should have N /
  // syncing" state instantly — the expected count comes from the import
  // op-event (folds immediately), independent of the slow row download.
  const syncByTable = useMemo(() => {
    const m = {};
    for (const t of syncTables) m[t.name] = t;
    return m;
  }, [syncTables]);

  // True when something about this workspace isn't fully local/sent yet:
  // records still downloading, or edits queued in the outbox. Surfaced as a
  // small dot on the sidebar's sync entry.
  const syncOutOfDate = isLive && (
    (window.MatrixLive?.getPendingCount?.() > 0) ||
    syncTables.some(t => t.expected > t.localRows)
  );

  // ── Memoized props + stable callbacks for the children below ──────────
  // Run BEFORE the session gate so the hook order stays constant whether
  // we render the launchpad/in-space shell or the login screen.

  // Memoize `rooms` against a cheap signature of the data — in live mode
  // ML.listRooms() returns a fresh array every call, so without this every
  // App render creates a new identity and busts every downstream memo.
  const liveRoomsArr = isLive ? liveStore.rooms : null;
  const liveRoomsSig = isLive
    ? liveRoomsArr.map(r => `${r.id}|${r.eventCount}|${r.title || ''}|${r.membership || ''}|${r.encrypted ? 1 : 0}|${r.inviter || ''}`).join(';')
    : '';
  const demoRoomsSig = !isLive
    ? roomIds.map(id => `${id}|${byRoom[id].length}|${demoTitleOverrides[id] || ''}`).join(';')
    : '';
  const rooms = useMemo(() => (
    isLive
      ? liveRoomsArr
      : roomIds.map(id => ({
          id,
          eventCount: byRoom[id].length,
          namespace: 'demo.tasks',
          title: demoTitleOverrides[id] || id.replace(/^!/, '').replace(/_/g, ' '),
        }))
  ), [isLive, liveRoomsSig, demoRoomsSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentRoom = useMemo(
    () => rooms.find(r => r.id === currentRoomId) || null,
    [rooms, currentRoomId]
  );

  // Stable callback identities so descendants wrapped in React.memo don't
  // re-render every time App re-renders (e.g. on ephemeral fade-outs).
  // Refs let the closures read live state without changing identity.
  const liveStoreRef = useRef(liveStore);
  liveStoreRef.current = liveStore;
  const demoStoreRef = useRef(demoStore);
  demoStoreRef.current = demoStore;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const currentRoomIdRef = useRef(currentRoomId);
  currentRoomIdRef.current = currentRoomId;

  const onEmit = useCallback(async (op, content) => {
    const roomId = currentRoomIdRef.current;
    if (!roomId) return;
    if (sessionRef.current && !sessionRef.current.demo) {
      try { await liveStoreRef.current.emit(roomId, op, content); }
      catch (e) { console.warn('[app] live emit failed:', e); }
    } else {
      demoStoreRef.current.emit(roomId, op, content, sessionRef.current?.mxid);
    }
    setCursor(Infinity);
  }, []);

  const onEmitRef = useRef(onEmit);
  onEmitRef.current = onEmit;

  const onEphemeral = useCallback((op, content) => {
    const id = ++ephCounterRef.current;
    const entry = { id, opKey: op.key, content, ts: Date.now() };
    setEphemerals(arr => [...arr, entry].slice(-6));
    setTimeout(() => setEphemerals(arr => arr.filter(e => e.id !== id)), 4500);
  }, []);

  // Scrubber callbacks (used by the memoized scrubberEl below).
  const onScrubberSeek = useCallback((n) => setCursor(n), []);
  const onScrubberLive = useCallback(() => setCursor(Infinity), []);
  const scrubberEl = useMemo(() => (
    (scrubberOpen || !live) ? (
      <Scrubber
        cursor={effectiveCursor}
        total={total}
        ts={ts}
        onSeek={onScrubberSeek}
        onLive={onScrubberLive}
        live={live}
      />
    ) : null
  ), [scrubberOpen, live, effectiveCursor, total, ts, onScrubberSeek, onScrubberLive]);

  // Sidebar / TableView callbacks — stable across renders.
  const onAirtableSchemaCb = useCallback(
    () => setAirtableImport({ id: Date.now() }),
    []
  );
  const onExportSchemaCb = useCallback(
    () => setExportingSchema(true),
    []
  );
  const onCreateTableCb = useCallback((name) => {
    const ME = window.MatrixEngine;
    const existing = stateRef.current.schema?.tables || [];
    if (existing.includes(name)) {
      setSelection({ kind: 'slice', sliceId: `${name}.table`, tableId: name, sliceKind: 'table' });
      return;
    }
    onEmitRef.current(ME.OP.DEF, { anchor: null, path: '_schema.tables', value: [...existing, name] });
    onEmitRef.current(ME.OP.DEF, {
      anchor: null,
      path: `_schema.fields.${name}`,
      value: [
        { name: 'Name', type: 'text' },
        { name: 'Field 1', type: 'text' },
      ],
    });
    const ts = Date.now();
    const anchor = ME.makeAnchor(name, {}, '@you:demo', ts);
    onEmitRef.current(ME.OP.INS, { anchor, entity_type: name, payload: {} });
    setSelection({ kind: 'slice', sliceId: `${name}.table`, tableId: name, sliceKind: 'table' });
  }, []);
  const onUpdateViewCb = useMemo(() => (
    selection.kind === 'slice' && selection.viewId
      ? (patch) => {
          const sel = selectionRef.current;
          const cur = stateRef.current.schema?.views?.[sel.tableId] || [];
          const next = cur.map(v => v.id === sel.viewId ? { ...v, ...patch } : v);
          onEmitRef.current(ME.OP.DEF, { anchor: null, path: `_schema.views.${sel.tableId}`, value: next });
        }
      : null
  ), [selection.kind, selection.viewId]);
  const onSaveAsViewCb = useCallback((cfg) => {
    const sel = selectionRef.current;
    if (sel.kind !== 'slice') return;
    const cur = stateRef.current.schema?.views?.[sel.tableId] || [];
    const n = cur.filter(v => v.kind === 'table').length + 2;
    const id = 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const view = { id, name: `Table ${n}`, kind: 'table', filters: cfg.filters || [], sorts: cfg.sorts || [], hidden: cfg.hidden || [] };
    onEmitRef.current(ME.OP.DEF, { anchor: null, path: `_schema.views.${sel.tableId}`, value: [...cur, view] });
    setSelection({ kind: 'slice', sliceId: `${sel.tableId}.view.${view.id}`, tableId: sel.tableId, sliceKind: 'table', viewId: view.id, _seed: { filters: cfg.filters, sorts: cfg.sorts, hidden: cfg.hidden } });
  }, []);

  // Gate the app on auth (or demo session) — every hook is above this line.
  // While the bridge is still trying to resume a session from the
  // sessionStorage vault stash, show a splash instead of flashing the
  // login portal.
  if (!session) {
    if (booting) return <window.BootSplash />;
    return <window.LoginScreen onSignIn={(s) => setSession(s)} />;
  }

  async function handleSignOut() {
    if (isLive && window.MatrixLive) {
      try { await window.MatrixLive.logout(); } catch (e) { console.warn('[app] logout failed:', e); }
    }
    // Deliberate sign-out: forget the resume point so the next sign-in
    // starts at the welcome screen rather than inside the last space.
    if (sessionUserKey) saveLastView(sessionUserKey, null, null);
    // Demo data is kept on disk on sign-out — the user can come back to
    // their spaces later. Use the "Clear all" tweak to nuke it explicitly.
    setSession(null);
    setCurrentRoomId(null);
  }

  async function handleAcceptInvite(roomId) {
    if (!isLive || !window.MatrixLive?.joinRoom) return;
    try {
      await window.MatrixLive.joinRoom(roomId);
      setCurrentRoomId(roomId);
    } catch (e) {
      console.warn('[app] accept invite failed:', e);
      alert('Accept invite failed: ' + (e?.message || e));
    }
  }

  const lastEventTs = allEvents.length
    ? allEvents[allEvents.length - 1].origin_server_ts
    : null;

  async function onRenameCurrentRoom(name) {
    if (!currentRoomId) return;
    if (isLive && window.MatrixLive?.renameRoom) {
      try { await window.MatrixLive.renameRoom(currentRoomId, name); }
      catch (e) { alert('Rename failed: ' + (e?.message || e)); }
    } else {
      setDemoTitleOverrides(o => ({ ...o, [currentRoomId]: name }));
    }
  }

  // Capture meaningful UI activity (button clicks, tab switches, slice picks)
  // as ephemeral `sig` signals so the live-activity strip reflects what the
  // user is doing — not just what they've committed to the log.
  function onActivityCapture(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('button, [role="button"], a, .sb-table-link, .sb-slice, .tv-tab, .gv-zoom button');
    if (!btn) return;
    if (btn.disabled) return;
    // skip clicks inside an input/textarea (they're typing, not navigating)
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    // collect a short label
    const raw = (btn.getAttribute('aria-label')
      || btn.getAttribute('title')
      || btn.textContent
      || '').replace(/\s+/g, ' ').trim();
    if (!raw) return;
    const label = raw.length > 40 ? raw.slice(0, 38) + '…' : raw;
    // surface where the click landed (sidebar / topbar / view) so the eph
    // chip can show context.
    const zone = btn.closest('.sidebar') ? 'sidebar'
               : btn.closest('.topbar') ? 'topbar'
               : btn.closest('.tv-tabs') ? 'tabs'
               : btn.closest('.scrubber') ? 'scrubber'
               : btn.closest('.gv-zoom') ? 'zoom'
               : 'view';
    onEphemeral(ME.OP.SIG, { target: label, note: zone });
  }

  async function onCreateRoom(name) {
    if (isLive) {
      const roomId = await liveStore.createRoom(name);
      setCurrentRoomId(roomId);
      return roomId;
    }
    // Demo: derive a room id from the name, dedupe against existing rooms,
    // and stash the user's chosen display name as a title override.
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'space';
    let id = `!${slug}`;
    let n = 2;
    while (demoStore.byRoom[id]) { id = `!${slug}_${n++}`; }
    demoStore.createRoom(id);
    setDemoTitleOverrides(o => ({ ...o, [id]: name }));
    setCurrentRoomId(id);
    return id;
  }

  // ── Saved views (Airtable-style) ────────────────────────────────────────
  // A view is a named, persisted bundle of {kind, filters, sorts, hidden}
  // stored in the log as DEF _schema.views.<set>. Because it lives in the same
  // encrypted timeline as the data, every collaborator and device sees the
  // same views — no separate store, no extra sync.
  const viewsFor = (setId) => (state.schema?.views?.[setId]) || [];
  function writeViews(setId, next) {
    onEmit(ME.OP.DEF, { anchor: null, path: `_schema.views.${setId}`, value: next });
  }
  function nextViewName(setId, kind) {
    const label = kind ? kind[0].toUpperCase() + kind.slice(1) : 'View';
    const n = viewsFor(setId).filter(v => v.kind === kind).length + 2; // built-in auto view is #1
    return `${label} ${n}`;
  }
  function createView(setId, { name, kind, filters = [], sorts = [], hidden = [] }) {
    const id = 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const view = { id, name: (name || '').trim() || nextViewName(setId, kind), kind, filters, sorts, hidden };
    writeViews(setId, [...viewsFor(setId), view]);
    return view;
  }
  function updateViewConfig(setId, viewId, patch) {
    writeViews(setId, viewsFor(setId).map(v => v.id === viewId ? { ...v, ...patch } : v));
  }
  function renameView(setId, viewId, name) {
    const n = (name || '').trim();
    if (!n) return;
    updateViewConfig(setId, viewId, { name: n });
  }
  function duplicateView(setId, viewId) {
    const src = viewsFor(setId).find(v => v.id === viewId);
    if (!src) return null;
    const id = 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const copy = { ...src, id, name: `${src.name} copy` };
    writeViews(setId, [...viewsFor(setId), copy]);
    return copy;
  }
  function deleteView(setId, viewId) {
    writeViews(setId, viewsFor(setId).filter(v => v.id !== viewId));
    if (selection.viewId === viewId && selection.tableId === setId) {
      setSelection({ kind: 'slice', sliceId: `${setId}.table`, tableId: setId, sliceKind: 'table' });
    }
  }
  const activeSavedView = (selection.kind === 'slice' && selection.viewId)
    ? viewsFor(selection.tableId).find(v => v.id === selection.viewId) || null
    : null;

  function toggleDemo() {
    // Demo toggle only meaningful when *already* in demo mode. In live mode
    // it's hidden by the RoomPicker prop below.
    if (demoOn) {
      demoStore.clearAll();
      setDemoOn(false);
    } else {
      demoStore.loadSeed();
      setDemoOn(true);
      setTimeout(() => {
        const first = Object.keys(buildSeedMap())[0];
        if (first) setCurrentRoomId(first);
      }, 0);
    }
    setCursor(Infinity);
  }

  // Saved view bound to the current selection — picked up by the TableView
  // callbacks defined above (uses selectionRef to read live).
  const savedViewForSelection = selection.kind === 'slice'
    ? (activeSavedView || selection._seed || null)
    : null;

  // The account dashboard is a fixed-position overlay, so it can ride along in
  // either the launchpad or the in-space shell. Demo sessions don't get it
  // (no homeserver to manage); the identity chip hides the entry point there.
  const accountDashboardEl = (accountTab && isLive && !session?.demo) ? (
    <window.AccountDashboard
      session={session}
      rooms={rooms}
      initialTab={accountTab}
      onClose={() => setAccountTab(null)}
      onSignOut={() => { setAccountTab(null); handleSignOut(); }}
    />
  ) : null;

  // No room selected → show the launchpad. This is the post-login default,
  // and the place users return to when they click "← spaces" inside a space.
  if (!currentRoomId) {
    return (
      <>
        <WorkspacesHome
          session={session}
          rooms={rooms}
          isLive={isLive}
          syncReady={syncReady}
          syncStatus={syncStatus}
          onResync={onResync}
          onEnter={(id) => setCurrentRoomId(id)}
          onCreate={onCreateRoom}
          onSignOut={handleSignOut}
          onAcceptInvite={handleAcceptInvite}
          onOpenAccount={isLive ? setAccountTab : null}
        />
        {accountDashboardEl}
      </>
    );
  }

  return (
    <div className="shell" onClickCapture={onActivityCapture}>
      <div className="topbar">
        <window.IdentityChip
          session={session}
          onSignOut={handleSignOut}
          onOpenAccount={isLive ? setAccountTab : null}
        />
        <button
          className="topbar-spaces"
          onClick={() => setCurrentRoomId(null)}
          title="back to your spaces"
        >← spaces</button>
        <RoomPicker
          rooms={rooms}
          currentRoomId={currentRoomId}
          setCurrentRoomId={setCurrentRoomId}
          onCreateRoom={onCreateRoom}
          demoOn={isLive ? false : demoOn}
          onToggleDemo={toggleDemo}
          isLive={isLive}
          onManageMembers={isLive ? (id) => setMembersDialogRoomId(id) : null}
        />
        {currentRoomId && (
          <window.ImportButton
            roomId={currentRoomId}
            disabled={isLive ? !!session?.stale : false}
            isLive={isLive}
            onCsvFile={(file) => setCsvImport({ id: Date.now(), file, roomId: currentRoomId })}
          />
        )}
        {isLive && currentRoomId && (() => {
          const r = currentRoom;
          if (!r || r.membership !== 'join') return null;
          const stale = !!session?.stale;
          return (
            <button
              className="topbar-members"
              onClick={() => setMembersDialogRoomId(currentRoomId)}
              title={stale ? 'reconnect to the homeserver to manage members' : 'manage members of this space'}
              disabled={stale}
            >members</button>
          );
        })()}
        <span className="spacer" />
        {isLive && <SyncIndicator status={syncStatus} variant="pill" onResync={onResync} />}
        <button
          className={`topbar-timetravel ${scrubberOpen ? 'on' : ''} ${!live ? 'scrubbed' : ''}`}
          onClick={() => setScrubberOpen(o => !o)}
          title={live ? 'reveal time-travel scrubber' : `scrubbed to event ${effectiveCursor}/${total} — click to ${scrubberOpen ? 'hide' : 'show'} the scrubber`}
        >
          <span className="tt-glyph">⟲</span>
          <span className="tt-label">{live ? 'time-travel' : `t-${total - effectiveCursor}`}</span>
        </button>
      </div>

      {ephemerals.length > 0 && (
        <div className="eph-rail" aria-label="live activity">
          {ephemerals.slice(-4).map(e => {
            const op = ME.OP[e.opKey.toUpperCase()];
            if (!op) return null;
            return (
              <div key={e.id} className={`eph-flash ${op.triad}`} title={e.content.note ? `${op.key} · ${e.content.note}` : op.key}>
                <span className="eph-gly">{op.glyph}</span>
                <span className="eph-target">{e.content.target || op.key}</span>
                {e.content.note && <span className="eph-meta">·{e.content.note}</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="shell-body">
        <window.Sidebar
          room={currentRoom}
          state={renderState}
          selection={selection}
          setSelection={setSelection}
          onAirtableSchema={onAirtableSchemaCb}
          onExportSchema={onExportSchemaCb}
          onCreateView={createView}
          onRenameView={renameView}
          onDuplicateView={duplicateView}
          onDeleteView={deleteView}
          onCreateTable={onCreateTableCb}
          eventsTotal={total}
          ephemeralsCount={ephemerals.length}
          onRenameRoom={onRenameCurrentRoom}
          lastEventTs={lastEventTs}
          syncOutOfDate={syncOutOfDate}
          syncByTable={syncByTable}
        />

        <div className="view-area">
          <ViewErrorBoundary
            key={`${selection.kind}:${selection.sliceKind || ''}:${selection.tableId || ''}:${selection.viewId || ''}:${selection.entityAnchor || ''}`}
          >
          {selection.kind === 'log' && (
            <window.DbView
              rooms={rooms}
              currentRoomId={currentRoomId}
              setCurrentRoomId={setCurrentRoomId}
              createRoom={onCreateRoom}
              eventsUpTo={effectiveCursor}
              allEventsInRoom={allEvents}
              state={state}
              cursor={effectiveCursor}
              setCursor={setCursor}
              onEmit={onEmit}
              onEphemeral={onEphemeral}
              ephemerals={ephemerals}
              highlight={highlight}
              setHighlight={setHighlight}
              tweaks={tweaks}
              scrubber={scrubberEl}
            />
          )}
          {selection.kind === 'sync' && (
            <window.SyncView
              room={currentRoom}
              isLive={isLive}
              session={session}
              tables={syncTables}
              committedCount={committedCount}
              pendingPart={pendingPart.length}
              eventsTotal={total}
              scrubber={scrubberEl}
              reclaimableMedia={reclaimableMedia}
              onReclaimMedia={() =>
                window.MatrixLive?.purgeMediaBlobs
                  ? window.MatrixLive.purgeMediaBlobs(reclaimableMedia)
                  : Promise.resolve({ removed: 0, bytes: 0 })}
              onRefreshTables={() => {
                // Restart the self-healing retry loop from scratch (in case it
                // exhausted its patience on a slow/cold download).
                noProgressRef.current = 0;
                lastPendingRef.current = -1;
                setImportRowsVersion(v => v + 1);
              }}
            />
          )}
          {selection.kind === 'chat' && (
            <window.ChatView
              room={currentRoom}
              state={renderState}
              setSelection={setSelection}
            />
          )}
          {selection.kind === 'slice' && (selection.sliceKind === 'table') && (
            <window.TableView
              key={selection.sliceId}
              room={currentRoom}
              state={renderState}
              onEmit={onEmit}
              tweaks={tweaks}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              setSelection={setSelection}
              savedView={savedViewForSelection}
              onUpdateView={onUpdateViewCb}
              onSaveAsView={onSaveAsViewCb}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'schema' && (
            <window.TableSchemaView
              room={currentRoom}
              state={renderState}
              entityType={selection.tableId}
              scrubber={scrubberEl}
              onEmit={onEmit}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'kanban' && (
            <window.AppView
              room={currentRoom}
              state={renderState}
              onEmit={onEmit}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              forceMode="kanban"
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'notebook' && (
            <window.AppView
              room={currentRoom}
              state={renderState}
              onEmit={onEmit}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              forceMode="notebook"
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'graph' && (
            <window.GraphView
              room={currentRoom}
              state={renderState}
              onEmit={onEmit}
              scrubber={scrubberEl}
              entityType={selection.tableId}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'timeline' && (
            <window.EntityTimelineView
              room={currentRoom}
              state={renderState}
              entityType={selection.tableId}
              entityAnchor={selection.entityAnchor}
              scrubber={scrubberEl}
              allEventsInRoom={allEvents}
              setSelection={setSelection}
            />
          )}
          </ViewErrorBoundary>
        </div>
      </div>

      <TweakControls
        t={tweaks}
        setTweak={setTweak}
        onLoadSeed={() => { demoStore.loadSeed(); setDemoOn(true); setCursor(Infinity); }}
        onClearAll={() => {
          demoStore.clearAll();
          setDemoTitleOverrides({});
          setDemoOn(false);
          setCursor(Infinity);
          setCurrentRoomId(null);
        }}
      />

      {membersDialogRoomId && isLive && (() => {
        const r = rooms.find(x => x.id === membersDialogRoomId);
        if (!r) return null;
        return (
          <window.MembersDialog
            space={r}
            mySession={session}
            onClose={() => setMembersDialogRoomId(null)}
          />
        );
      })()}

      {accountDashboardEl}

      {csvImport && window.CsvImportModal && (
        <window.CsvImportModal
          csvImport={csvImport}
          state={state}
          onEmit={onEmit}
          onClose={() => setCsvImport(null)}
        />
      )}

      {airtableImport && window.AirtableSchemaModal && (
        <window.AirtableSchemaModal
          schemaImport={airtableImport}
          roomId={currentRoomId}
          state={state}
          onEmit={onEmit}
          onClose={() => setAirtableImport(null)}
        />
      )}

      {exportingSchema && window.SchemaExportModal && (
        <window.SchemaExportModal
          room={currentRoom}
          state={renderState}
          onClose={() => setExportingSchema(false)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ViewErrorBoundary level="app"><App /></ViewErrorBoundary>
);
})();
