/* sidebar.jsx — Airtable/EODB-style left rail.
 *
 * Each room contains a list of SETS (the high-level data objects, one per
 * entity type in the room's schema + meta sets: _synthesis, _connections,
 * _schema, _violations). Clicking the set itself opens its SCHEMA.
 *
 * Each set has a list of PROJECTIONS — different ways to view the same
 * underlying rows. Built-in projection kinds:
 *   table     — Airtable-style spreadsheet (default)
 *   kanban    — partitioned columns; requires partitions in the schema
 *   timeline  — per-anchor event lifeline
 *   graph     — node-link view of CONs touching this set
 *
 * Notebook and synthesis remain as auto-derived projections for the
 * observation/hypothesis sets and any set with SYN rollups.
 *
 * A "raw / log" entry sits below sets — it's the underlying timeline
 * (the event log itself).
 */

(function () {
const { useState, useMemo, useEffect } = React;

const SLICE_KINDS = {
  table:     { icon: '⊞', label: 'table',     blurb: 'spreadsheet of rows · edit cells inline'  },
  kanban:    { icon: '▦', label: 'kanban',    blurb: 'columns by partition · drag rows between' },
  timeline:  { icon: '⏚', label: 'timeline',  blurb: 'per-anchor event lifeline'                },
  graph:     { icon: '△', label: 'graph',     blurb: 'node-link view of related rows'           },
  notebook:  { icon: '▤', label: 'notebook',  blurb: 'chronological narrative entries'          },
  synthesis: { icon: '⊛', label: 'synthesis', blurb: 'SYN-rollup view'                          },
  schema:    { icon: '⊢', label: 'schema',    blurb: 'declared shape of the set'                },
  log:       { icon: '⊟', label: 'log',       blurb: 'append-only event timeline'               },
};

// The four user-pickable projections (in the new projection modal).
const PROJECTION_TYPES = ['table', 'kanban', 'timeline', 'graph'];

// ─────────────────────────────────────────────────────────────────────────
// Derive the sets + their auto-projections from state.
// ─────────────────────────────────────────────────────────────────────────

function buildSets(state) {
  const declared = state.schema?.tables || [];
  const observed = Array.from(new Set(
    Object.values(state.entities)
      .map(e => e._type)
      .filter(t => t && !t.startsWith('_'))
  ));
  const userSets = Array.from(new Set([...declared, ...observed]));

  const sets = userSets.map(name => {
    const rows = Object.values(state.entities).filter(e => e._type === name);
    const hasPartitions = !!(state.schema?.partitions?.[name]) || rows.some(r => state.partitions[r._anchor]);
    const hasConnections = state.connections.some(c => {
      const s = state.entities[c.source]; const t = state.entities[c.target];
      return (s?._type === name) || (t?._type === name);
    });
    const slices = [
      { id: `${name}.table`, kind: 'table', name: 'table', tableId: name },
      ...(hasPartitions ? [{ id: `${name}.kanban`, kind: 'kanban', name: 'kanban', tableId: name }] : []),
      ...(hasConnections ? [{ id: `${name}.graph`, kind: 'graph', name: 'graph', tableId: name }] : []),
      ...(name === 'observation' || name === 'hypothesis'
        ? [{ id: `${name}.notebook`, kind: 'notebook', name: 'notebook', tableId: name }] : []),
    ];
    return {
      id: name, name, kind: 'entity', rows: rows.length,
      declared: declared.includes(name),
      hasPartitions, hasConnections,
      slices,
    };
  });

  // Meta sets — surfaced as plain rows with a single table projection each
  const meta = [];
  if (Object.values(state.entities).some(e => e._type === '_synthesis')) {
    meta.push({
      id: '_synthesis', name: '_synthesis', kind: 'meta',
      rows: Object.values(state.entities).filter(e => e._type === '_synthesis').length,
      declared: false,
      slices: [{ id: '_synthesis.table', kind: 'table', name: 'table', tableId: '_synthesis' }],
    });
  }
  if (state.connections.length > 0) {
    meta.push({
      id: '_connections', name: '_connections', kind: 'meta',
      rows: state.connections.length, declared: !!state.schema?.links,
      slices: [
        { id: '_connections.table', kind: 'table', name: 'table', tableId: '_connections' },
        { id: '_connections.graph', kind: 'graph', name: 'graph', tableId: '_connections' },
      ],
    });
  }
  // _schema isn't a top-level set — each set has its own schema, opened by clicking the set name above.
  if (state._violations && state._violations.length > 0) {
    meta.push({
      id: '_violations', name: '_violations', kind: 'meta',
      rows: state._violations.length, declared: false,
      slices: [{ id: '_violations.table', kind: 'table', name: 'table', tableId: '_violations' }],
    });
  }

  return { sets, meta };
}

// ─────────────────────────────────────────────────────────────────────────
// NewProjectionModal — elegant overlay for picking a projection type
// ─────────────────────────────────────────────────────────────────────────

function NewProjectionModal({ set, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('table');

  useEffect(() => {
    function esc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  function reasonDisabled(k) {
    if (k === 'kanban' && !set.hasPartitions) return 'add a partition to this set first';
    if (k === 'graph' && !set.hasConnections) return 'no CON edges touch this set yet';
    return null;
  }

  function commit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (reasonDisabled(kind)) return;
    const slug = trimmed.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!slug) return;
    onCreate({ name: slug, kind });
  }

  return (
    <div className="proj-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="proj-modal" onMouseDown={e => e.stopPropagation()}>
        <header className="proj-modal-head">
          <div className="proj-modal-eyebrow">new projection</div>
          <div className="proj-modal-title">
            <span className="proj-modal-set">{set.name}</span>
            <span className="proj-modal-dim"> · pick how to view this set</span>
          </div>
        </header>

        <div className="proj-modal-body">
          <div className="proj-modal-section-label">projection type</div>
          <div className="proj-tiles">
            {PROJECTION_TYPES.map(k => {
              const info = SLICE_KINDS[k];
              const disabled = reasonDisabled(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={`proj-tile ${kind === k ? 'on' : ''} ${disabled ? 'disabled' : ''} kind-${k}`}
                  onClick={() => !disabled && setKind(k)}
                  title={disabled || info.blurb}
                  disabled={!!disabled}
                >
                  <div className="proj-tile-icon">{info.icon}</div>
                  <div className="proj-tile-name">{info.label}</div>
                  <div className="proj-tile-blurb">{disabled || info.blurb}</div>
                </button>
              );
            })}
          </div>

          <div className="proj-modal-section-label">name</div>
          <input
            autoFocus
            className="proj-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={`e.g. high-priority-${kind}`}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') onClose();
            }}
          />
          <div className="proj-name-hint">
            projections live alongside the set · they’re views over the same underlying rows
          </div>
        </div>

        <footer className="proj-modal-foot">
          <button className="proj-modal-cancel" onClick={onClose}>cancel</button>
          <button
            className="proj-modal-create"
            onClick={commit}
            disabled={!name.trim() || !!reasonDisabled(kind)}
          >create projection</button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sidebar component
// ─────────────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function Sidebar({
  room, state, selection, setSelection, onCreateTable, customSlices, onCreateSlice,
  eventsTotal, ephemeralsCount, onRenameRoom, lastEventTs,
}) {
  const { sets, meta } = useMemo(() => buildSets(state), [state]);
  const allSets = [...sets, ...meta].map(t => {
    const extras = (customSlices?.[t.id] || []).map(s => ({
      id: `${t.id}.${s.name}`,
      kind: s.kind,
      name: s.name,
      tableId: t.id,
      custom: true,
    }));
    return { ...t, slices: [...t.slices, ...extras] };
  });
  // Sets are open unless the user explicitly collapsed them. Storing
  // collapsed state (rather than open state) avoids the first-mount race
  // where the seed fold hasn't populated entities yet.
  const [collapsed, setCollapsed] = useState({});
  const isOpen = (id) => !collapsed[id];
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [projectionFor, setProjectionFor] = useState(null); // set object for new-projection modal

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // Re-render every 30s so the "last edit X ago" string stays fresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!lastEventTs) return;
    const t = setInterval(() => setNowTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, [lastEventTs]);

  const canRename = !!onRenameRoom && !!room;
  function startEditName() {
    if (!canRename) return;
    setNameDraft(room?.title || '');
    setEditingName(true);
  }
  function commitName() {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!canRename) return;
    if (!trimmed || trimmed === room?.title) return;
    onRenameRoom(trimmed);
  }

  function toggle(id) { setCollapsed(s => ({ ...s, [id]: !s[id] })); }

  function isActive(sliceId) {
    return selection.kind === 'slice' && selection.sliceId === sliceId;
  }

  function renderSet(t) {
    const open = isOpen(t.id);
    const isSchemaActive = selection.kind === 'slice' && selection.tableId === t.id && selection.sliceKind === 'schema';
    return (
      <div key={t.id} className={`sb-table ${t.kind === 'meta' ? 'meta' : ''}`}>
        <div className={`sb-table-head ${isSchemaActive ? 'active' : ''}`}>
          <button
            className="sb-toggle"
            onClick={() => toggle(t.id)}
            title={open ? 'collapse' : 'expand'}
          >
            <span className={`sb-caret ${open ? 'open' : ''}`}>▸</span>
          </button>
          <button
            className="sb-table-link"
            onClick={() => {
              setSelection({ kind: 'slice', sliceId: `${t.id}.schema`, tableId: t.id, sliceKind: 'schema' });
              setCollapsed(s => ({ ...s, [t.id]: false }));
            }}
            title="open the schema of this set"
          >
            <span className="sb-table-name">{t.name}</span>
            {!t.declared && t.kind !== 'meta' && (
              <span className="sb-unschematized" title="not in _schema.tables">?</span>
            )}
            <span className="sb-table-count">{t.rows}</span>
          </button>
        </div>
        {open && (
          <div className="sb-slices">
            {t.slices.map(s => (
              <button
                key={s.id}
                className={`sb-slice ${isActive(s.id) ? 'active' : ''} kind-${s.kind} ${s.custom ? 'custom' : ''}`}
                onClick={() => setSelection({ kind: 'slice', sliceId: s.id, tableId: t.id, sliceKind: s.kind })}
                title={(SLICE_KINDS[s.kind]?.blurb || '') + (s.custom ? ' · custom projection' : '')}
              >
                <span className="sb-slice-icon">{SLICE_KINDS[s.kind].icon}</span>
                <span className="sb-slice-name">{s.name}</span>
              </button>
            ))}
            {t.kind !== 'meta' && (
              <button
                className="sb-slice add"
                title="add a new projection of this set"
                onClick={() => setProjectionFor(t)}
              >
                <span className="sb-slice-icon">+</span>
                <span className="sb-slice-name">new projection…</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const setsCount = allSets.length;
  const lastEditLabel = relativeTime(lastEventTs);
  const headerName = room?.title || 'untitled workspace';

  return (
    <aside className="sidebar">
      <div className="sb-room-head">
        {editingName ? (
          <input
            autoFocus
            className="sb-room-name-input"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => {
              if (e.key === 'Enter') commitName();
              else if (e.key === 'Escape') setEditingName(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="sb-room-name"
            onClick={startEditName}
            disabled={!canRename}
            title={canRename ? 'click to rename' : ''}
          >{headerName}</button>
        )}
        <div className="sb-room-sub">
          {setsCount} {setsCount === 1 ? 'set' : 'sets'} · {eventsTotal} {eventsTotal === 1 ? 'event' : 'events'}
          {lastEditLabel ? <> · last edit {lastEditLabel}</> : null}
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-section-head">
          <span>sets</span>
        </div>
        {creating ? (
          <div className="sb-new-table">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="set name"
              onKeyDown={e => {
                if (e.key === 'Enter' && newName) { onCreateTable(newName); setNewName(''); setCreating(false); }
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
            />
            <button onClick={() => { if (newName) { onCreateTable(newName); setNewName(''); setCreating(false); } }}>+</button>
          </div>
        ) : (
          <button className="sb-add-table" onClick={() => setCreating(true)}>+ new set</button>
        )}
        {allSets.map(renderSet)}
        {allSets.length === 0 && (
          <div className="sb-empty">no sets yet</div>
        )}
      </div>

      <div className="sb-section">
        <div className="sb-section-head">
          <span>raw</span>
        </div>
        <button
          className={`sb-slice ${selection.kind === 'log' ? 'active' : ''} kind-log`}
          onClick={() => setSelection({ kind: 'log' })}
        >
          <span className="sb-slice-icon">⊟</span>
          <span className="sb-slice-name">log</span>
          <span className="sb-slice-meta">{eventsTotal}</span>
        </button>
        <button
          className={`sb-slice ${selection.kind === 'ephemeral' ? 'active' : ''} kind-ephemeral`}
          onClick={() => setSelection({ kind: 'log' })}
          disabled
          title="ephemeral lane is visible inside the log view"
        >
          <span className="sb-slice-icon">∅</span>
          <span className="sb-slice-name">ephemeral</span>
          <span className="sb-slice-meta">{ephemeralsCount}</span>
        </button>
      </div>

      <div className="sb-foot">
        <div className="sb-foot-line">events · <b>{eventsTotal}</b></div>
        <div className="sb-foot-line muted">projections are views of the same log</div>
      </div>

      {projectionFor && (
        <NewProjectionModal
          set={projectionFor}
          onClose={() => setProjectionFor(null)}
          onCreate={({ name, kind }) => {
            onCreateSlice(projectionFor.id, { name, kind });
            setSelection({
              kind: 'slice',
              sliceId: `${projectionFor.id}.${name}`,
              tableId: projectionFor.id,
              sliceKind: kind,
            });
            setProjectionFor(null);
          }}
        />
      )}
    </aside>
  );
}

window.Sidebar = Sidebar;
window.SLICE_KINDS = SLICE_KINDS;

})();
