/* sidebar.jsx — Airtable/EODB-style left rail.
 *
 * Each room contains a list of SETS (the high-level data objects, one per
 * entity type in the room's schema + meta sets: _synthesis, _schema,
 * _violations). Clicking a set opens its data (the default table); a small ⊢
 * button on the set opens its SCHEMA.
 *
 * Each set has a list of VIEWS (projections) — different, saved ways to view
 * the same underlying rows. Built-in (auto) view kinds:
 *   table     — Airtable-style spreadsheet (default)
 *   kanban    — partitioned columns; drag rows between
 *   timeline  — per-anchor event lifeline
 *   graph     — node-link view of CONs touching this set
 *
 * User-created views are SAVED in the log (DEF on _schema.views.<set>), so a
 * view remembers its own filters / sorts / hidden fields and is shared with
 * every collaborator on the room — exactly like an Airtable view. They can be
 * renamed, duplicated, and deleted.
 *
 * A "raw / log" entry sits below sets — it's the underlying timeline
 * (the event log itself).
 */

(function () {
const { useState, useMemo, useEffect, useRef } = React;

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

// The four user-pickable view types (in the new-view modal).
const PROJECTION_TYPES = ['table', 'kanban', 'timeline', 'graph'];

// ─────────────────────────────────────────────────────────────────────────
// Derive the sets + their views (auto + saved) from state.
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
    // Auto views — always-available lenses derived from the data's shape.
    const slices = [
      { id: `${name}.table`, kind: 'table', name: 'table', tableId: name },
      ...(hasPartitions ? [{ id: `${name}.kanban`, kind: 'kanban', name: 'kanban', tableId: name }] : []),
      ...(hasConnections ? [{ id: `${name}.graph`, kind: 'graph', name: 'graph', tableId: name }] : []),
      ...(name === 'observation' || name === 'hypothesis'
        ? [{ id: `${name}.notebook`, kind: 'notebook', name: 'notebook', tableId: name }] : []),
    ];
    // Saved views — persisted in the log under _schema.views.<set>.
    const savedViews = (state.schema?.views?.[name] || []).map(v => ({
      id: `${name}.view.${v.id}`, kind: v.kind, name: v.name, tableId: name, viewId: v.id, saved: true,
    }));
    return {
      id: name, name, kind: 'entity', rows: rows.length,
      declared: declared.includes(name),
      hasPartitions, hasConnections,
      slices: [...slices, ...savedViews],
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
  // _schema isn't a top-level set — each set has its own schema, opened by the ⊢ button on the set.

  // Raw sets live down by the log, not up with the user's data sets. The
  // `import` staging set and `_violations` are byproducts of the pipeline
  // rather than first-class sets, so we pull them out of `sets`/`meta`.
  const raw = [];
  const importIdx = sets.findIndex(s => s.id === 'import');
  if (importIdx !== -1) {
    raw.push(sets.splice(importIdx, 1)[0]);
  }
  if (state._violations && state._violations.length > 0) {
    raw.push({
      id: '_violations', name: '_violations', kind: 'meta',
      rows: state._violations.length, declared: false,
      slices: [{ id: '_violations.table', kind: 'table', name: 'table', tableId: '_violations' }],
    });
  }

  return { sets, meta, raw };
}

// ─────────────────────────────────────────────────────────────────────────
// NewViewModal — pick a view type and (optionally) name it, then create.
//
// Airtable's "create view": you pick a type and it's created instantly with
// a sensible default name you can rename later. We mirror that — the name is
// pre-filled, free-form (spaces & capitals welcome), and you can just hit
// Enter. Kanban/graph are never blocked; if the set isn't set up for them yet
// the view opens with a guided empty state instead of a dead end.
// ─────────────────────────────────────────────────────────────────────────

function NewViewModal({ set, existingViews, onCreate, onClose }) {
  const [kind, setKind] = useState('table');
  const [nameEdited, setNameEdited] = useState(false);

  const suggestFor = (k) => {
    const label = SLICE_KINDS[k]?.label || k;
    const n = (existingViews || []).filter(v => v.kind === k).length + 2; // built-in auto view is #1
    return `${label[0].toUpperCase()}${label.slice(1)} ${n}`;
  };
  const [name, setName] = useState(() => suggestFor('table'));

  // Re-suggest the name when the type changes, unless the user has typed one.
  useEffect(() => {
    if (!nameEdited) setName(suggestFor(kind));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function esc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  // Non-blocking guidance — never disables the tile, just hints at setup.
  function hintFor(k) {
    if (k === 'kanban' && !set.hasPartitions) return 'tip: add a status field to stack cards into columns';
    if (k === 'graph'  && !set.hasConnections) return 'tip: link records to see them connected';
    return null;
  }

  function commit() {
    const finalName = name.trim() || suggestFor(kind);
    onCreate({ name: finalName, kind });
  }

  return (
    <div className="proj-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="proj-modal" onMouseDown={e => e.stopPropagation()}>
        <header className="proj-modal-head">
          <div className="proj-modal-eyebrow">new view</div>
          <div className="proj-modal-title">
            <span className="proj-modal-set">{set.name}</span>
            <span className="proj-modal-dim"> · pick how to view this set</span>
          </div>
        </header>

        <div className="proj-modal-body">
          <div className="proj-modal-section-label">view type</div>
          <div className="proj-tiles">
            {PROJECTION_TYPES.map(k => {
              const info = SLICE_KINDS[k];
              const hint = hintFor(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={`proj-tile ${kind === k ? 'on' : ''} kind-${k}`}
                  onClick={() => setKind(k)}
                  title={hint || info.blurb}
                >
                  <div className="proj-tile-icon">{info.icon}</div>
                  <div className="proj-tile-name">{info.label}</div>
                  <div className="proj-tile-blurb">{hint || info.blurb}</div>
                </button>
              );
            })}
          </div>

          <div className="proj-modal-section-label">name</div>
          <input
            autoFocus
            className="proj-name-input"
            value={name}
            onChange={e => { setName(e.target.value); setNameEdited(true); }}
            onFocus={e => e.target.select()}
            placeholder={suggestFor(kind)}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') onClose();
            }}
          />
          <div className="proj-name-hint">
            views live alongside the set · each one saves its own filters, sorts &amp; hidden fields
          </div>
        </div>

        <footer className="proj-modal-foot">
          <button className="proj-modal-cancel" onClick={onClose}>cancel</button>
          <button
            className="proj-modal-create"
            onClick={commit}
          >create view</button>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SidebarView — one saved view row, with inline rename + a ⋯ options menu.
// ─────────────────────────────────────────────────────────────────────────

function SidebarView({ slice, active, onSelect, onRename, onDuplicate, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(slice.name);
  const wrapRef = useRef(null);

  useEffect(() => { setDraft(slice.name); }, [slice.name]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  function commitRename() {
    const t = draft.trim();
    setRenaming(false);
    if (t && t !== slice.name) onRename(t);
    else setDraft(slice.name);
  }

  if (renaming) {
    return (
      <div className="sb-view-row" ref={wrapRef}>
        <input
          autoFocus
          className="sb-view-rename"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') { setDraft(slice.name); setRenaming(false); }
          }}
          style={{ flex: 1, minWidth: 0, font: 'inherit', padding: '2px 6px' }}
        />
      </div>
    );
  }

  return (
    <div className="sb-view-row" ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
      <button
        className={`sb-slice sb-slice-main ${active ? 'active' : ''} kind-${slice.kind} saved`}
        onClick={onSelect}
        onDoubleClick={() => setRenaming(true)}
        title={(SLICE_KINDS[slice.kind]?.blurb || '') + ' · saved view (double-click to rename)'}
        style={{ flex: 1, minWidth: 0 }}
      >
        <span className="sb-slice-icon">{SLICE_KINDS[slice.kind]?.icon || '⊞'}</span>
        <span className="sb-slice-name">{slice.name}</span>
      </button>
      <button
        className="sb-view-kebab"
        title="view options"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 6px', opacity: 0.6, fontSize: 13 }}
      >⋯</button>
      {menuOpen && (
        <div
          className="sb-view-menu"
          style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 30, minWidth: 130,
            background: 'var(--bg, #fff)', border: '1px solid var(--border, #ddd)',
            boxShadow: '0 4px 14px rgba(0,0,0,.12)', borderRadius: 4, padding: 4,
          }}
        >
          {[
            { label: 'rename',    fn: () => setRenaming(true) },
            { label: 'duplicate', fn: () => onDuplicate() },
            { label: 'delete',    fn: () => onDelete() },
          ].map(item => (
            <button
              key={item.label}
              onClick={() => { setMenuOpen(false); item.fn(); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none',
                background: 'none', cursor: 'pointer', padding: '5px 8px', font: 'inherit',
                fontSize: 12, color: item.label === 'delete' ? 'var(--danger, #c0392b)' : 'inherit',
              }}
            >{item.label}</button>
          ))}
        </div>
      )}
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
  room, state, selection, setSelection, onCreateTable,
  onCreateView, onRenameView, onDuplicateView, onDeleteView,
  eventsTotal, ephemeralsCount, onRenameRoom, lastEventTs, onAirtableSchema,
  onExportSchema, syncOutOfDate, syncByTable,
}) {
  const { sets, meta, raw } = useMemo(() => buildSets(state), [state]);
  const allSets = [...sets, ...meta];
  const rawSets = raw;
  // Sets are open unless the user explicitly collapsed them. Storing
  // collapsed state (rather than open state) avoids the first-mount race
  // where the seed fold hasn't populated entities yet.
  const [collapsed, setCollapsed] = useState({});
  const isOpen = (id) => !collapsed[id];
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [projectionFor, setProjectionFor] = useState(null); // set object for new-view modal

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

  function openTable(t) {
    setSelection({ kind: 'slice', sliceId: `${t.id}.table`, tableId: t.id, sliceKind: 'table' });
    setCollapsed(s => ({ ...s, [t.id]: false }));
  }
  function openSchema(t) {
    setSelection({ kind: 'slice', sliceId: `${t.id}.schema`, tableId: t.id, sliceKind: 'schema' });
    setCollapsed(s => ({ ...s, [t.id]: false }));
  }

  // The count badge on a set. For imported sets we know up-front how many rows
  // there *should* be (the import op-event carries it), so we show that target
  // instantly — `materialized / expected` with a sync dot — while the rows
  // stream in from the source blob. Once complete (or for native sets) it's
  // just the row count.
  function renderSetCount(t) {
    const info = syncByTable?.[t.id];
    if (info && info.isImport && info.expected > info.localRows) {
      const title = `${info.localRows} of ${info.expected} records downloaded`
        + (info.chunksTotal > 1 ? ` · ${info.chunksReady}/${info.chunksTotal} chunks` : '')
        + ' — the rest stream in automatically';
      return (
        <span className="sb-table-count syncing" title={title}>
          <span className="sb-sync-dot" aria-hidden="true" />
          {info.localRows}<span className="sb-count-sep">/</span>{info.expected}
        </span>
      );
    }
    const total = info ? info.expected : t.rows;
    return <span className="sb-table-count" title={`${total} record${total === 1 ? '' : 's'}`}>{total}</span>;
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
            onClick={() => openTable(t)}
            title="open this set's data"
          >
            <span className="sb-table-name">{t.name}</span>
            {!t.declared && t.kind !== 'meta' && (
              <span className="sb-unschematized" title="not in _schema.tables">?</span>
            )}
            {renderSetCount(t)}
          </button>
          {t.kind !== 'meta' && (
            <button
              className="sb-table-schema"
              onClick={() => openSchema(t)}
              title="edit fields / schema of this set"
              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 6px', opacity: isSchemaActive ? 1 : 0.55 }}
            >⊢</button>
          )}
        </div>
        {open && (
          <div className="sb-slices">
            {t.slices.map(s => (
              s.saved ? (
                <SidebarView
                  key={s.id}
                  slice={s}
                  active={isActive(s.id)}
                  onSelect={() => setSelection({ kind: 'slice', sliceId: s.id, tableId: t.id, sliceKind: s.kind, viewId: s.viewId })}
                  onRename={(name) => onRenameView(t.id, s.viewId, name)}
                  onDuplicate={() => {
                    const v = onDuplicateView(t.id, s.viewId);
                    if (v) setSelection({ kind: 'slice', sliceId: `${t.id}.view.${v.id}`, tableId: t.id, sliceKind: v.kind, viewId: v.id });
                  }}
                  onDelete={() => onDeleteView(t.id, s.viewId)}
                />
              ) : (
                <button
                  key={s.id}
                  className={`sb-slice ${isActive(s.id) ? 'active' : ''} kind-${s.kind}`}
                  onClick={() => setSelection({ kind: 'slice', sliceId: s.id, tableId: t.id, sliceKind: s.kind })}
                  title={SLICE_KINDS[s.kind]?.blurb || ''}
                >
                  <span className="sb-slice-icon">{SLICE_KINDS[s.kind].icon}</span>
                  <span className="sb-slice-name">{s.name}</span>
                </button>
              )
            ))}
            {t.kind !== 'meta' && (
              <button
                className="sb-slice add"
                title="add a new saved view of this set"
                onClick={() => setProjectionFor(t)}
              >
                <span className="sb-slice-icon">+</span>
                <span className="sb-slice-name">new view…</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const setsCount = allSets.length + rawSets.length;
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

      <button
        className={`sb-ask ${selection.kind === 'chat' ? 'active' : ''}`}
        onClick={() => setSelection({ kind: 'chat' })}
        title="chat with your data — ask in plain language, get tables and record profiles linked by foreign key"
      >
        <i className="ph ph-chat-circle-dots" aria-hidden="true"></i>
        <span className="sb-ask-label">Ask your data</span>
      </button>

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
          <div className="sb-add-row">
            <button className="sb-add-table" onClick={() => setCreating(true)}>+ new set</button>
            {onAirtableSchema && (
              <button className="sb-add-table sb-add-airtable" onClick={onAirtableSchema}
                title="connect to Airtable with a personal-access token — pick a base, pull its schema (computed fields included) and optionally its records">⊞ airtable</button>
            )}
          </div>
        )}
        {allSets.map(renderSet)}
        {allSets.length === 0 && (
          <div className="sb-empty">no sets yet</div>
        )}
        {onExportSchema && allSets.length > 0 && (
          <button
            className="sb-export"
            onClick={onExportSchema}
            title="copy or download this workspace's schema as SQL DDL, JSON, or Markdown"
          >⇩ export schema</button>
        )}
      </div>

      <div className="sb-section">
        <div className="sb-section-head">
          <span>raw</span>
        </div>
        {rawSets.map(renderSet)}
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
          title="SIGs you fire while navigating — never written into the log"
        >
          <span className="sb-slice-icon">∅</span>
          <span className="sb-slice-name">ephemeral</span>
          <span className="sb-slice-meta">{ephemeralsCount}</span>
        </button>
        <button
          className={`sb-slice ${selection.kind === 'sync' ? 'active' : ''} kind-sync`}
          onClick={() => setSelection({ kind: 'sync' })}
          title="how many records each table should have, what's downloaded to this device, and whether it survives a refresh"
        >
          <span className="sb-slice-icon">⟲</span>
          <span className="sb-slice-name">sync &amp; storage</span>
          {syncOutOfDate && <span className="sb-slice-meta" title="records still downloading or edits unsent">●</span>}
        </button>
      </div>

      <div className="sb-foot">
        <div className="sb-foot-line">events · <b>{eventsTotal}</b></div>
        <div className="sb-foot-line muted">views are saved lenses on the same log</div>
      </div>

      {projectionFor && (
        <NewViewModal
          set={projectionFor}
          existingViews={state.schema?.views?.[projectionFor.id] || []}
          onClose={() => setProjectionFor(null)}
          onCreate={({ name, kind }) => {
            const v = onCreateView(projectionFor.id, { name, kind });
            if (v) {
              setSelection({
                kind: 'slice',
                sliceId: `${projectionFor.id}.view.${v.id}`,
                tableId: projectionFor.id,
                sliceKind: kind,
                viewId: v.id,
              });
            }
            setProjectionFor(null);
          }}
        />
      )}
    </aside>
  );
}

// React.memo: Sidebar receives stable callbacks + state from App, but App
// re-renders on every event arrival and on ephemeral fade-outs. Without memo
// the whole sidebar (incl. buildSets over every entity) re-runs every time.
window.Sidebar = React.memo(Sidebar);
window.SLICE_KINDS = SLICE_KINDS;

})();
