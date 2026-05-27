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
              return (
                <button
                  key={r.id}
                  className={`wh-card ${isInvite ? 'wh-card-invite' : ''}`}
                  onClick={() => isInvite ? onAcceptInvite?.(r.id) : onEnter(r.id)}
                  title={r.id}
                >
                  <span className="wh-card-sigil">{initial}</span>
                  <span className="wh-card-name">{title}</span>
                  <span className="wh-card-meta">
                    {isInvite
                      ? `invite${r.inviter ? ` from ${r.inviter}` : ''}`
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
    return { byRoom: {}, rooms: [], emit: null, createRoom: null };
  }

  const rooms = ML.listRooms();
  const byRoom = {};
  for (const r of rooms) {
    byRoom[r.id] = currentRoomId === r.id ? ML.getEventsForRoom(r.id) : [];
  }
  return {
    byRoom,
    rooms,
    emit: (roomId, op, content) => ML.emit(roomId, op, content),
    createRoom: (name) => ML.createRoom(name),
    inviteUser: (roomId, userId) => ML.inviteUser(roomId, userId),
  };
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

  const state = useMemo(() => ME.fold(allEvents.slice(0, effectiveCursor)), [allEvents, effectiveCursor]);

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

  const scrubberEl = (
    <Scrubber
      cursor={effectiveCursor}
      total={total}
      ts={ts}
      onSeek={(n) => setCursor(n)}
      onLive={() => setCursor(Infinity)}
      live={live}
    />
  );

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
    <div className="shell">
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
        {isLive && currentRoomId && (() => {
          const r = rooms.find(x => x.id === currentRoomId);
          if (!r || r.membership !== 'join') return null;
          const stale = !!session?.stale;
          return (
            <>
              <button
                className="topbar-members"
                onClick={() => setMembersDialogRoomId(currentRoomId)}
                title={stale ? 'reconnect to the homeserver to manage members' : 'manage members of this space'}
                disabled={stale}
              >members</button>
              <window.ImportButton roomId={currentRoomId} disabled={stale} />
            </>
          );
        })()}
        <span className="spacer" />
      </div>

      <div className="shell-body">
        <window.Sidebar
          room={rooms.find(r => r.id === currentRoomId)}
          state={state}
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
              state={state}
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
              state={state}
              entityType={selection.tableId}
              scrubber={scrubberEl}
              onEmit={onEmit}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'kanban' && (
            <window.AppView
              room={rooms.find(r => r.id === currentRoomId)}
              state={state}
              onEmit={onEmit}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              forceMode="kanban"
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'notebook' && (
            <window.AppView
              room={rooms.find(r => r.id === currentRoomId)}
              state={state}
              onEmit={onEmit}
              scrubber={scrubberEl}
              forceTable={selection.tableId}
              forceMode="notebook"
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'graph' && (
            <window.GraphView
              room={rooms.find(r => r.id === currentRoomId)}
              state={state}
              onEmit={onEmit}
              scrubber={scrubberEl}
            />
          )}
          {selection.kind === 'slice' && selection.sliceKind === 'timeline' && (
            <window.EntityTimelineView
              room={rooms.find(r => r.id === currentRoomId)}
              state={state}
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
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
