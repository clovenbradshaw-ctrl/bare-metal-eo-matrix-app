/* app.jsx — root: rooms store, mode switch, scrubber, tweaks */

(function() {
const { useState, useMemo, useEffect, useRef } = React;
const ME = window.MatrixEngine;

// ─────────────────────────────────────────────────────────────────────────
// In-memory event store
// ─────────────────────────────────────────────────────────────────────────

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

function useEventStore(initialDemo) {
  const [byRoom, setByRoom] = useState(() => initialDemo ? buildSeedMap() : { '!scratch': [] });
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
  }

  return { byRoom, setByRoom, emit, createRoom, loadSeed, clearAll };
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
      <TweakSection label="Database view">
        <TweakToggle label="Show violations"
          value={t.showViolations} onChange={v => setTweak('showViolations', v)} />
        <TweakToggle label="Show entity _hwm"
          value={t.showHwm} onChange={v => setTweak('showHwm', v)} />
      </TweakSection>
      <TweakSection label="Table view">
        <TweakToggle label="Show CREATE TABLE DDL"
          value={t.showSchemaDDL} onChange={v => setTweak('showSchemaDDL', v)} />
      </TweakSection>
      <TweakSection label="Start in">
        <TweakRadio
          value={t.defaultMode}
          onChange={v => setTweak('defaultMode', v)}
          options={[
            { value: 'db',    label: 'log'    },
            { value: 'table', label: 'tables' },
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
  const [session, setSession] = window.useSession();
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

  // If the active room disappears (left, lost from sync, demo cleared),
  // drop back to the picker. We never auto-pick a room here — entry to a
  // workspace is always an explicit user action on the WorkspacePicker.
  useEffect(() => {
    if (!session) return;
    if (currentRoomId && !byRoom[currentRoomId]) {
      setCurrentRoomId(null);
    }
  }, [session, isLive, roomIds.join('|')]);

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
  const [demoTitleOverrides, setDemoTitleOverrides] = useState({});

  // Derived values needed by hooks below; computed before the auth gate so
  // the hook order is stable across signed-in / signed-out renders.
  const allEvents = byRoom[currentRoomId] || [];
  const total = allEvents.length;
  const effectiveCursor = Math.min(cursor, total);
  const live = cursor >= total;

  useEffect(() => { if (live) setCursor(Infinity); }, [total]); // eslint-disable-line

  const state = useMemo(() => ME.fold(allEvents.slice(0, effectiveCursor)), [allEvents, effectiveCursor]);

  // Gate the app on auth (or demo session) — every hook is above this line.
  if (!session) {
    return <window.LoginScreen onSignIn={(s) => setSession(s)} />;
  }

  async function handleSignOut() {
    if (isLive && window.MatrixLive) {
      try { await window.MatrixLive.logout(); } catch (e) { console.warn('[app] logout failed:', e); }
    }
    setSession(null);
    setCurrentRoomId(null);
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

  // Create a workspace (real Matrix room in live mode; in-memory room in
  // demo mode), optionally seed it from a template, then enter it.
  async function onCreateWorkspace(name, template) {
    let newRoomId;
    if (isLive) {
      newRoomId = await liveStore.createRoom(name);
    } else {
      newRoomId = name.startsWith('!')
        ? name
        : `!${String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'workspace'}`;
      demoStore.createRoom(newRoomId);
      setDemoTitleOverrides(o => ({ ...o, [newRoomId]: name }));
    }
    if (template?.seed) {
      const emitTo = isLive
        ? (op, content) => liveStore.emit(newRoomId, op, content)
        : (op, content) => { demoStore.emit(newRoomId, op, content, session.mxid); };
      try { await template.seed(emitTo); }
      catch (e) { console.warn('[app] template seed failed:', e); }
    }
    setCurrentRoomId(newRoomId);
    setCursor(Infinity);
    return newRoomId;
  }

  async function onAcceptInvite(roomId) {
    if (isLive && window.MatrixLive?.joinRoom) {
      await window.MatrixLive.joinRoom(roomId);
    }
    setCurrentRoomId(roomId);
    setCursor(Infinity);
  }

  // No active workspace → show the Airtable-style landing.
  if (!currentRoomId) {
    return (
      <window.WorkspacePicker
        session={session}
        rooms={rooms}
        isLive={isLive}
        onPick={(id) => setCurrentRoomId(id)}
        onCreate={onCreateWorkspace}
        onAcceptInvite={onAcceptInvite}
        onSignOut={handleSignOut}
      />
    );
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
      try {
        const roomId = await liveStore.createRoom(name);
        setCurrentRoomId(roomId);
      } catch (e) {
        console.warn('[app] create room failed:', e);
        alert('Create space failed: ' + (e?.message || e));
      }
    } else {
      const id = name.startsWith('!') ? name : `!${name}`;
      demoStore.createRoom(id);
      setCurrentRoomId(id);
    }
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

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">
          matrix-events
          <span className="sub">bare metal</span>
        </span>
        <window.IdentityChip
          session={session}
          onSignOut={handleSignOut}
        />
        <button
          className="topbar-members"
          onClick={() => setCurrentRoomId(null)}
          title="back to workspaces"
        >← workspaces</button>
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
            // Declare a new (empty) table by writing _schema.tables
            const existing = state.schema?.tables || [];
            if (existing.includes(name)) return;
            onEmit(window.MatrixEngine.OP.DEF, { anchor: null, path: '_schema.tables', value: [...existing, name] });
            onEmit(window.MatrixEngine.OP.DEF, { anchor: null, path: `_schema.fields.${name}`, value: [{ name: 'title', type: 'text' }] });
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
        onClearAll={() => { demoStore.clearAll(); setDemoOn(false); setCursor(Infinity); }}
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
