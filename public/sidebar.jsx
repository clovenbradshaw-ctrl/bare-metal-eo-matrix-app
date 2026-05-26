/* sidebar.jsx — Airtable/EODB-style left rail.
 *
 * Each room contains a set of TABLES (entity types in the room's schema +
 * meta tables: _synthesis, _connections, _schema, _violations).
 * Each table has a list of SLICES — projections of that table.
 * Slice kinds:
 *   grid       — Airtable-style spreadsheet (default)
 *   kanban     — partitioned columns; only available if the table declares partitions
 *   graph      — node-link view of CONs touching this table
 *   notebook   — chronological narrative (observations / hypotheses)
 *   synthesis  — SYN-rollup view
 *
 * A "raw / log" entry sits below tables — it's not a slice but the underlying
 * timeline (the event log itself).
 */

(function () {
const { useState, useMemo } = React;

const SLICE_KINDS = {
  grid:      { icon: '⊞', label: 'grid'      },
  kanban:    { icon: '▦', label: 'kanban'    },
  graph:     { icon: '△', label: 'graph'     },
  notebook:  { icon: '▤', label: 'notebook'  },
  synthesis: { icon: '⊛', label: 'synthesis' },
  schema:    { icon: '⊢', label: 'schema'    },
  timeline:  { icon: '⏚', label: 'timeline'  },
};

// ─────────────────────────────────────────────────────────────────────────
// Derive the tables + their auto-slices from state.
// ─────────────────────────────────────────────────────────────────────────

function buildTables(state) {
  const declared = state.schema?.tables || [];
  const observed = Array.from(new Set(
    Object.values(state.entities)
      .map(e => e._type)
      .filter(t => t && !t.startsWith('_'))
  ));
  const userTables = Array.from(new Set([...declared, ...observed]));

  const tables = userTables.map(name => {
    const rows = Object.values(state.entities).filter(e => e._type === name);
    const hasPartitions = !!(state.schema?.partitions?.[name]) || rows.some(r => state.partitions[r._anchor]);
    const hasConnections = state.connections.some(c => {
      const s = state.entities[c.source]; const t = state.entities[c.target];
      return (s?._type === name) || (t?._type === name);
    });
    const slices = [
      { id: `${name}.grid`, kind: 'grid', name: 'grid', tableId: name },
      ...(hasPartitions ? [{ id: `${name}.kanban`, kind: 'kanban', name: 'kanban', tableId: name }] : []),
      ...(hasConnections ? [{ id: `${name}.graph`, kind: 'graph', name: 'graph', tableId: name }] : []),
      ...(name === 'observation' || name === 'hypothesis'
        ? [{ id: `${name}.notebook`, kind: 'notebook', name: 'notebook', tableId: name }] : []),
    ];
    return {
      id: name, name, kind: 'entity', rows: rows.length,
      declared: declared.includes(name),
      slices,
    };
  });

  // Meta tables — surfaced as plain rows with a single grid slice each
  const meta = [];
  if (Object.values(state.entities).some(e => e._type === '_synthesis')) {
    meta.push({
      id: '_synthesis', name: '_synthesis', kind: 'meta',
      rows: Object.values(state.entities).filter(e => e._type === '_synthesis').length,
      declared: false,
      slices: [{ id: '_synthesis.grid', kind: 'grid', name: 'grid', tableId: '_synthesis' }],
    });
  }
  if (state.connections.length > 0) {
    meta.push({
      id: '_connections', name: '_connections', kind: 'meta',
      rows: state.connections.length, declared: !!state.schema?.links,
      slices: [
        { id: '_connections.grid',  kind: 'grid',  name: 'grid',  tableId: '_connections' },
        { id: '_connections.graph', kind: 'graph', name: 'graph', tableId: '_connections' },
      ],
    });
  }
  if (Object.keys(state.schema || {}).length > 0) {
    meta.push({
      id: '_schema', name: '_schema', kind: 'meta',
      rows: Object.keys(state.schema).length, declared: true,
      slices: [{ id: '_schema.grid', kind: 'grid', name: 'grid', tableId: '_schema' }],
    });
  }
  if (state._violations && state._violations.length > 0) {
    meta.push({
      id: '_violations', name: '_violations', kind: 'meta',
      rows: state._violations.length, declared: false,
      slices: [{ id: '_violations.grid', kind: 'grid', name: 'grid', tableId: '_violations' }],
    });
  }

  return { tables, meta };
}

// ─────────────────────────────────────────────────────────────────────────
// Sidebar component
// ─────────────────────────────────────────────────────────────────────────

function Sidebar({
  room, state, selection, setSelection, onCreateTable, customSlices, onCreateSlice, eventsTotal, ephemeralsCount,
}) {
  const { tables, meta } = useMemo(() => buildTables(state), [state]);
  // Merge any user-created slices onto their host tables
  const allTables = [...tables, ...meta].map(t => {
    const extras = (customSlices?.[t.id] || []).map(s => ({
      id: `${t.id}.${s.name}`,
      kind: s.kind,
      name: s.name,
      tableId: t.id,
      custom: true,
    }));
    return { ...t, slices: [...t.slices, ...extras] };
  });
  const [expanded, setExpanded] = useState(() => {
    const m = {};
    allTables.forEach(t => { m[t.id] = true; });
    return m;
  });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlice, setNewSlice] = useState(null); // tableId currently authoring a new slice
  const [newSliceDraft, setNewSliceDraft] = useState({ name: '', kind: 'grid' });

  function toggle(id) { setExpanded(s => ({ ...s, [id]: !s[id] })); }

  function isActive(sliceId) {
    return selection.kind === 'slice' && selection.sliceId === sliceId;
  }

  function commitNewSlice(t) {
    const name = newSliceDraft.name.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!slug) return;
    onCreateSlice(t.id, { name: slug, kind: newSliceDraft.kind });
    setSelection({ kind: 'slice', sliceId: `${t.id}.${slug}`, tableId: t.id, sliceKind: newSliceDraft.kind });
    setNewSlice(null);
    setNewSliceDraft({ name: '', kind: 'grid' });
  }
  function cancelNewSlice() {
    setNewSlice(null);
    setNewSliceDraft({ name: '', kind: 'grid' });
  }

  function renderTable(t) {
    const open = !!expanded[t.id];
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
              setExpanded(s => ({ ...s, [t.id]: true }));
            }}
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
                title={s.custom ? 'custom slice' : ''}
              >
                <span className="sb-slice-icon">{SLICE_KINDS[s.kind].icon}</span>
                <span className="sb-slice-name">{s.name}</span>
              </button>
            ))}
            {t.kind !== 'meta' && newSlice === t.id ? (
              <div className="sb-slice-form">
                <div className="sb-slice-form-label">name</div>
                <input
                  autoFocus
                  className="sb-slice-form-input"
                  value={newSliceDraft.name}
                  onChange={e => setNewSliceDraft(d => ({ ...d, name: e.target.value }))}
                  placeholder="e.g. high-priority"
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitNewSlice(t);
                    else if (e.key === 'Escape') cancelNewSlice();
                  }}
                />
                <div className="sb-slice-form-label">kind</div>
                <div className="sb-slice-kinds">
                  {Object.entries(SLICE_KINDS).filter(([k]) => k !== 'schema' && k !== 'timeline').map(([k, info]) => (
                    <button
                      key={k}
                      className={`sb-kind-tile ${newSliceDraft.kind === k ? 'on' : ''} kind-${k}`}
                      onClick={() => setNewSliceDraft(d => ({ ...d, kind: k }))}
                      title={info.label}
                    >
                      <span className="sb-kind-tile-icon">{info.icon}</span>
                      <span className="sb-kind-tile-label">{info.label}</span>
                    </button>
                  ))}
                </div>
                <div className="sb-slice-form-actions">
                  <button className="sb-slice-cancel" onClick={cancelNewSlice}>cancel</button>
                  <button className="sb-slice-add-btn" onClick={() => commitNewSlice(t)} disabled={!newSliceDraft.name.trim()}>+ create view</button>
                </div>
              </div>
            ) : t.kind !== 'meta' ? (
              <button
                className="sb-slice add"
                title="add a new slice (projection) of this table"
                onClick={() => { setNewSlice(t.id); setNewSliceDraft({ name: '', kind: 'grid' }); }}
              >
                <span className="sb-slice-icon">+</span>
                <span className="sb-slice-name">new view…</span>
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sb-room-head">
        <div className="sb-room-name">{room?.title || room?.id.replace(/^!/, '').replace(/_/g, ' ')}</div>
        <div className="sb-room-sub">{room?.id}</div>
      </div>

      <div className="sb-section">
        <div className="sb-section-head">
          <span>tables</span>
          <span className="sb-section-count">{allTables.length}</span>
        </div>
        {allTables.map(renderTable)}
        {allTables.length === 0 && (
          <div className="sb-empty">no tables yet</div>
        )}
        {creating ? (
          <div className="sb-new-table">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="table name"
              onKeyDown={e => {
                if (e.key === 'Enter' && newName) { onCreateTable(newName); setNewName(''); setCreating(false); }
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
            />
            <button onClick={() => { if (newName) { onCreateTable(newName); setNewName(''); setCreating(false); } }}>+</button>
          </div>
        ) : (
          <button className="sb-add-table" onClick={() => setCreating(true)}>+ new table</button>
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
        <div className="sb-foot-line muted">slices are projections of the same log</div>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
window.SLICE_KINDS = SLICE_KINDS;

})();
