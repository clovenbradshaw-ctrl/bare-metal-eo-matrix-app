/* app.jsx — root: rooms store, mode switch, scrubber, tweaks */

(function() {
const { useState, useMemo, useEffect, useRef } = React;
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
// Workspaces home — what you see right after signing in. Lists every
// space as a card; you pick one to enter, or create a new one. No data
// editing happens here, by design: this is the launchpad.
// ─────────────────────────────────────────────────────────────────────────

function WorkspacesHome({
  session, rooms, isLive, syncReady,
  onEnter, onCreate, onSignOut, onAcceptInvite,
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
        <window.IdentityChip session={session} onSignOut={onSignOut} />
      </div>

      <div className="wh-body">
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

function App() {
  const [session, setSession, booting] = window.useSession();
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  // Demo source (in-memory + seed); used when session.demo OR no session.
  const demoStore = useEventStore(tweaks.demoOnStart);

  // Live source (real Matrix via the bridge); only active when authed real.
  const isLive = !!session && !session.demo;
  const [currentRoomId, setCurrentRoomId] = useState(null);
  const liveStore = useLiveStore(isLive, currentRoomId);

  // Pick the active source and pin the engine namespace synchronously, so
  // every fold below sees the right NS prefix.
  const dataSource = isLive ? liveStore : demoStore;
  ME.setNamespace(isLive ? (window.MatrixLive?.NAMESPACE || 'io.matrix-events') : 'demo.tasks');

  const byRoom = dataSource.byRoom;
  const roomIds = Object.keys(byRoom);

  // Drop a stale currentRoomId if the underlying source no longer has
  // that room (e.g. demo data cleared, room deleted on another device).
  // We deliberately do NOT auto-select a room — landing on the welcome
  // screen is the desired flow.
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

  const [customSlices, setCustomSlices] = useState({});
  const [csvImport, setCsvImport] = useState(null); // {id, file, roomId} | null
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

  // Derived values needed by hooks below; computed before the auth gate so
  // the hook order is stable across signed-in / signed-out renders.
  const allEvents = byRoom[currentRoomId] || [];
  const total = allEvents.length;
  const effectiveCursor = Math.min(cursor, total);
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
  const [importRowsVersion, setImportRowsVersion] = useState(0);

  const importEntities = useMemo(() => Object.values(state.entities || {}).filter(
    e => e?._type === 'import' && e.derived_set && Array.isArray(e.field_plan)
  ), [state]);

  useEffect(() => {
    const CI = window.CsvImport;
    if (!CI?.materializeImportRows) return;
    let cancelled = false;
    const timers = [];
    (async () => {
      for (const imp of importEntities) {
        const a = imp._anchor;
        if (importRowsRef.current[a] || inFlightRef.current.has(a)) continue;
        inFlightRef.current.add(a);
        try {
          const rows = await CI.materializeImportRows(imp);
          if (cancelled) return;
          if (Array.isArray(rows)) {
            // Successfully parsed (possibly to zero rows). Cache and render.
            importRowsRef.current[a] = rows;
            setImportRowsVersion(v => v + 1);
          } else {
            // Couldn't materialize yet — the import entity's `file` ref
            // hasn't folded in (it DEFs in after the INS), or the media
            // mirror is still syncing after a reload. Do NOT cache an empty
            // result (that would hide the rows permanently); retry instead.
            // New events re-run this effect on their own; the timer covers
            // the case where the blob becomes readable with no further
            // events (e.g. the homeserver finishes its first sync).
            const n = (retryRef.current[a] || 0) + 1;
            retryRef.current[a] = n;
            if (n <= 8) {
              timers.push(setTimeout(
                () => setImportRowsVersion(v => v + 1),
                Math.min(2000, 250 * n),
              ));
            }
          }
        } catch (e) {
          console.warn('[app] could not materialize import rows:', e);
        } finally {
          inFlightRef.current.delete(a);
        }
      }
    })();
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [importEntities, importRowsVersion]);

  // State the data views render from: the folded state plus any rows
  // reconstructed from imported source blobs. Real folded entities win on
  // anchor collisions, so editing a materialized row (which emits real
  // events) takes precedence over the reconstructed copy.
  const renderState = useMemo(() => {
    const byAnchor = importRowsRef.current;
    // Only inject rows whose import entity exists at the current cursor, so
    // time-travelling before an import doesn't conjure its rows.
    const anchors = Object.keys(byAnchor).filter(a => state.entities?.[a]);
    if (!anchors.length) return state;
    const entities = {};
    for (const a of anchors) for (const row of byAnchor[a]) entities[row._anchor] = row;
    Object.assign(entities, state.entities);
    return { ...state, entities };
  }, [state, importRowsVersion]);

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

  const ts = effectiveCursor > 0 ? allEvents[effectiveCursor - 1].origin_server_ts : null;

  const rooms = isLive
    ? liveStore.rooms
    : roomIds.map(id => ({
        id,
        eventCount: byRoom[id].length,
        namespace: 'demo.tasks',
        title: demoTitleOverrides[id] || id.replace(/^!/, '').replace(/_/g, ' '),
      }));

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

  async function onEmit(op, content) {
    if (!currentRoomId) return;
    if (isLive) {
      try { await liveStore.emit(currentRoomId, op, content); }
      catch (e) { console.warn('[app] live emit failed:', e); }
    } else {
      demoStore.emit(currentRoomId, op, content, session.mxid);
    }
    setCursor(Infinity);
  }

  function onEphemeral(op, content) {
    const id = ++ephCounterRef.current;
    const entry = { id, opKey: op.key, content, ts: Date.now() };
    setEphemerals(arr => [...arr, entry].slice(-6));
    setTimeout(() => setEphemerals(arr => arr.filter(e => e.id !== id)), 4500);
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

  const scrubberEl = (scrubberOpen || !live) ? (
    <Scrubber
      cursor={effectiveCursor}
      total={total}
      ts={ts}
      onSeek={(n) => setCursor(n)}
      onLive={() => setCursor(Infinity)}
      live={live}
    />
  ) : null;

  // No room selected → show the launchpad. This is the post-login default,
  // and the place users return to when they click "← spaces" inside a space.
  if (!currentRoomId) {
    return (
      <WorkspacesHome
        session={session}
        rooms={rooms}
        isLive={isLive}
        syncReady={syncReady}
        onEnter={(id) => setCurrentRoomId(id)}
        onCreate={onCreateRoom}
        onSignOut={handleSignOut}
        onAcceptInvite={handleAcceptInvite}
      />
    );
  }

  return (
    <div className="shell" onClickCapture={onActivityCapture}>
      <div className="topbar">
        <window.IdentityChip
          session={session}
          onSignOut={handleSignOut}
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
          const r = rooms.find(x => x.id === currentRoomId);
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
          room={rooms.find(r => r.id === currentRoomId)}
          state={renderState}
          selection={selection}
          setSelection={setSelection}
          customSlices={customSlices}
          onCreateSlice={(tableId, slice) => {
            setCustomSlices(s => ({ ...s, [tableId]: [...(s[tableId] || []), slice] }));
          }}
          onCreateTable={(name) => {
            const ME = window.MatrixEngine;
            const existing = state.schema?.tables || [];
            if (existing.includes(name)) {
              setSelection({ kind: 'slice', sliceId: `${name}.table`, tableId: name, sliceKind: 'table' });
              return;
            }
            onEmit(ME.OP.DEF, { anchor: null, path: '_schema.tables', value: [...existing, name] });
            onEmit(ME.OP.DEF, {
              anchor: null,
              path: `_schema.fields.${name}`,
              value: [
                { name: 'Name', type: 'text' },
                { name: 'Field 1', type: 'text' },
              ],
            });
            // Seed one empty row so the user lands on a typeable grid, not an empty state.
            const ts = Date.now();
            const anchor = ME.makeAnchor(name, {}, '@you:demo', ts);
            onEmit(ME.OP.INS, { anchor, entity_type: name, payload: {} });
            setSelection({ kind: 'slice', sliceId: `${name}.table`, tableId: name, sliceKind: 'table' });
          }}
          eventsTotal={total}
          ephemeralsCount={ephemerals.length}
          onRenameRoom={onRenameCurrentRoom}
          lastEventTs={lastEventTs}
        />

        <div className="view-area">
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
          {selection.kind === 'slice' && (selection.sliceKind === 'table') && (
            <window.TableView
              room={rooms.find(r => r.id === currentRoomId)}
              state={renderState}
              onEmit={onEmit}
              tweaks={tweaks}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              setSelection={setSelection}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'schema' && (
            <window.TableSchemaView
              room={rooms.find(r => r.id === currentRoomId)}
              state={renderState}
              entityType={selection.tableId}
              scrubber={scrubberEl}
              onEmit={onEmit}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'kanban' && (
            <window.AppView
              room={rooms.find(r => r.id === currentRoomId)}
              state={renderState}
              onEmit={onEmit}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              forceMode="kanban"
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'notebook' && (
            <window.AppView
              room={rooms.find(r => r.id === currentRoomId)}
              state={renderState}
              onEmit={onEmit}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              forceMode="notebook"
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'graph' && (
            <window.GraphView
              room={rooms.find(r => r.id === currentRoomId)}
              state={renderState}
              onEmit={onEmit}
              scrubber={scrubberEl}
              entityType={selection.tableId}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'timeline' && (
            <window.EntityTimelineView
              room={rooms.find(r => r.id === currentRoomId)}
              state={renderState}
              entityType={selection.tableId}
              entityAnchor={selection.entityAnchor}
              scrubber={scrubberEl}
              allEventsInRoom={allEvents}
              setSelection={setSelection}
            />
          )}
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

      {csvImport && window.CsvImportModal && (
        <window.CsvImportModal
          csvImport={csvImport}
          state={state}
          onEmit={onEmit}
          onClose={() => setCsvImport(null)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
