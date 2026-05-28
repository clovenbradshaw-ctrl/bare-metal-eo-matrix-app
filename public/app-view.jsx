/* app-view.jsx — Projection: kanban + notebook. Same fold, app surface on top.
 * Every action emits operators back into the log:
 *   add task → INS (create) + DEF (title)
 *   drag card → SEG (partition)
 *   edit cell → DEF
 */

(function() {
const { OP: AV_OP } = window.MatrixEngine;

function detectKanbanType(state) {
  // Choose the first entity type with partitions declared in schema.
  const partsBy = state.schema?.partitions || {};
  const declared = Object.keys(partsBy);
  if (declared.length > 0) return declared[0];
  // Else: any type that has at least one partitioned entity
  const observed = new Set();
  for (const a of Object.keys(state.partitions)) {
    const e = state.entities[a];
    if (e) observed.add(e._type);
  }
  return observed.values().next().value || null;
}

function detectAppKind(state) {
  const entities = Object.values(state.entities);
  const hasObs = entities.some(e => e._type === 'observation' || e._type === 'hypothesis');
  const kanbanType = detectKanbanType(state);
  if (kanbanType) return { kind: 'kanban', kanbanType };
  if (hasObs) return { kind: 'notebook' };
  return { kind: 'generic' };
}

// ─────────────────────────────────────────────────────────────────────────
// Kanban — partitions are columns, entities are cards.
// Schema-driven: reads state.schema.partitions.<type>; no hardcoded columns.
// ─────────────────────────────────────────────────────────────────────────

function Kanban({ state, onEmit, entityType }) {
  const [dragAnchor, setDragAnchor] = React.useState(null);
  const [dragOverCol, setDragOverCol] = React.useState(null);
  const [newTitles, setNewTitles] = React.useState({});
  const [hiddenFields, setHiddenFields] = React.useState(() => new Set());
  const [filter, setFilter] = React.useState('');
  const [addingCol, setAddingCol] = React.useState(false);
  const [newColName, setNewColName] = React.useState('');
  const [showFieldsMenu, setShowFieldsMenu] = React.useState(false);

  const schemaPartitions = state.schema?.partitions?.[entityType] || [];
  // Anything in data but not in schema is shown but flagged
  const observedPartitions = new Set();
  for (const [anchor, p] of Object.entries(state.partitions)) {
    if (state.entities[anchor]?._type === entityType) observedPartitions.add(p);
  }
  const extras = Array.from(observedPartitions).filter(p => !schemaPartitions.includes(p));
  const partitions = [...schemaPartitions, ...extras];

  // Group entities of the chosen type by partition; unpartitioned ones become "unsorted"
  const entities = Object.values(state.entities).filter(e => e._type === entityType);
  const byPartition = {};
  for (const p of partitions) byPartition[p] = [];
  const inbox = [];
  for (const t of entities) {
    const p = state.partitions[t._anchor];
    if (p) {
      byPartition[p] = byPartition[p] || [];
      byPartition[p].push(t);
    } else {
      inbox.push(t);
    }
  }
  const allPartitions = [...partitions];
  if (inbox.length) {
    allPartitions.unshift('unsorted');
    byPartition['unsorted'] = inbox;
  }

  function connsFor(anchor) {
    return state.connections.filter(c => c.source === anchor || c.target === anchor);
  }

  // INS creates the thing, DEF puts the first parameter on it, SEG moves it
  function addEntity(partition) {
    const title = (newTitles[partition] || '').trim();
    if (!title) return;
    const sender = '@you:demo';
    const ts = Date.now();
    const anchor = window.MatrixEngine.makeAnchor(entityType, {}, sender, ts);
    onEmit(AV_OP.INS, { anchor, entity_type: entityType, payload: {} });
    // pick the first text field from schema (or fall back to 'title')
    const fields = state.schema?.fields?.[entityType];
    const firstTextField = Array.isArray(fields) ? fields.find(f => f.type === 'text')?.name : null;
    const fieldName = firstTextField || 'title';
    onEmit(AV_OP.DEF, { anchor, path: fieldName, value: title });
    if (partition && partition !== 'unsorted') {
      onEmit(AV_OP.SEG, { anchor, partition });
    }
    setNewTitles(t => ({ ...t, [partition]: '' }));
  }

  function moveTo(anchor, partition) {
    const current = state.partitions[anchor];
    if (current === partition) return;
    if (partition === 'unsorted') return; // can't drag back to inbox
    onEmit(AV_OP.SEG, { anchor, partition });
  }

  // First text field name — used to display "title" on cards
  const fields = state.schema?.fields?.[entityType] || [];
  const titleField = (fields.find(f => f.type === 'text')?.name) || 'title';
  // Fields shown as "meta" rows on each card — every schema field except the title,
  // formula fields (read-only & derived), and anything the user has hidden.
  const metaFields = fields.filter(f =>
    f.name !== titleField &&
    f.type !== 'formula' &&
    !hiddenFields.has(f.name)
  );
  // Case-insensitive substring filter across every field on the record.
  const filterLower = filter.trim().toLowerCase();
  function matchesFilter(t) {
    if (!filterLower) return true;
    for (const f of fields) {
      const v = t[f.name];
      if (v === undefined || v === null || v === '') continue;
      if (String(v).toLowerCase().includes(filterLower)) return true;
    }
    return false;
  }

  function addPartition() {
    const name = newColName.trim();
    if (!name) return;
    if (schemaPartitions.includes(name)) {
      setNewColName('');
      setAddingCol(false);
      return;
    }
    onEmit(AV_OP.DEF, {
      anchor: null,
      path: `_schema.partitions.${entityType}`,
      value: [...schemaPartitions, name],
    });
    setNewColName('');
    setAddingCol(false);
  }

  return (
    <>
    <div className="kanban-toolbar">
      <div className="kt-group">
        <button
          className={`kt-btn ${showFieldsMenu ? 'on' : ''}`}
          onClick={() => setShowFieldsMenu(o => !o)}
          title="toggle which fields show on each card"
        >
          <i className="ph ph-eye" aria-hidden="true"></i> fields
          {hiddenFields.size > 0 && <span className="kt-badge">{fields.length - hiddenFields.size}/{fields.length}</span>}
        </button>
        {showFieldsMenu && (
          <div className="kt-menu" role="menu">
            <div className="kt-menu-eyebrow">show on cards</div>
            {fields.map(f => {
              const isTitle = f.name === titleField;
              const visible = isTitle || !hiddenFields.has(f.name);
              return (
                <button
                  key={f.name}
                  className={`kt-menu-row ${visible ? 'on' : ''}`}
                  onClick={() => {
                    if (isTitle) return;
                    setHiddenFields(s => {
                      const n = new Set(s);
                      if (n.has(f.name)) n.delete(f.name); else n.add(f.name);
                      return n;
                    });
                  }}
                  disabled={isTitle}
                  title={isTitle ? 'the title field always shows' : (visible ? 'hide on cards' : 'show on cards')}
                >
                  <i className={`ph ph-${visible ? 'eye' : 'eye-slash'}`} aria-hidden="true"></i>
                  <span className="kt-menu-name">{f.name}</span>
                  {isTitle && <span className="kt-menu-tag">title</span>}
                </button>
              );
            })}
            {fields.length === 0 && <div className="kt-menu-empty">no schema fields yet</div>}
          </div>
        )}
      </div>
      <div className="kt-filter">
        <i className="ph ph-magnifying-glass" aria-hidden="true"></i>
        <input
          type="text"
          placeholder="filter cards…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        {filter && (
          <button className="kt-filter-clear" onClick={() => setFilter('')} title="clear filter" aria-label="clear filter">×</button>
        )}
      </div>
      <span className="kt-spacer" />
      <span className="kt-meta">{entities.length} {entityType}{entities.length === 1 ? '' : 's'}</span>
    </div>
    <div className="kanban">
      {allPartitions.map(p => {
        const unschematized = p === 'unsorted' || !schemaPartitions.includes(p);
        const cards = (byPartition[p] || []).filter(matchesFilter);
        return (
          <div
            key={p}
            className={`kcol ${unschematized ? 'unschematized' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOverCol(p); }}
            onDragLeave={() => setDragOverCol(null)}
            onDrop={e => {
              e.preventDefault();
              if (dragAnchor) moveTo(dragAnchor, p);
              setDragAnchor(null);
              setDragOverCol(null);
            }}
          >
            <div className="kcol-head">
              <span className="pname">{p}</span>
              {unschematized && p !== 'unsorted' && <span className="pcount" title="in data but not in _schema.partitions" style={{color:'var(--signal)',borderColor:'var(--signal)'}}>? unschematized</span>}
              <span className="pcount">{cards.length}</span>
            </div>
            <div className={`kcol-body ${dragOverCol === p ? 'drag-over' : ''}`}>
              {cards.map(t => {
                const conns = connsFor(t._anchor);
                return (
                  <div
                    key={t._anchor}
                    className={`card ${dragAnchor === t._anchor ? 'dragging' : ''}`}
                    draggable
                    onDragStart={() => setDragAnchor(t._anchor)}
                    onDragEnd={() => setDragAnchor(null)}
                  >
                    <div className="title">{t[titleField] || '(no ' + titleField + ')'}</div>
                    {metaFields.length > 0 && (
                      <div className="card-fields">
                        {metaFields.map(f => {
                          const v = t[f.name];
                          if (v === undefined || v === null || v === '') return null;
                          return (
                            <div className="cf-row" key={f.name}>
                              <i className={`cf-icon ph ph-${iconForFieldType(f.type)}`} aria-hidden="true"></i>
                              <span className="cf-key">{f.name}</span>
                              <span className={`cf-val ${f.type === 'select' && f.name === 'priority' ? 'prio-' + v : ''}`}>{formatCardVal(v, f.type)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {conns.length > 0 && (
                      <div className="meta" style={{gap:4,flexWrap:'wrap'}}>
                        {conns.slice(0, 3).map((c, i) => (
                          <span className="relchip" key={i}>
                            {c.source === t._anchor ? c.type : `← ${c.type}`}
                          </span>
                        ))}
                      </div>
                    )}
                    {t._evaluations && t._evaluations.length > 0 && (
                      <div className="evals">
                        {t._evaluations.slice(-3).map((e, i) => (
                          <span key={i} className={`eval ${e.result === 'pass' ? 'pass' : e.result === 'fail' ? 'fail' : ''}`} title={e.note}>
                            {e.criterion}:{e.result}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {cards.length === 0 && filter && (
                <div className="kcol-empty">no matches</div>
              )}
            </div>
            {p !== 'unsorted' && (
              <div className="kcol-add">
                <input
                  placeholder={`new ${entityType}…`}
                  value={newTitles[p] || ''}
                  onChange={e => setNewTitles(t => ({ ...t, [p]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addEntity(p); }}
                />
                <button onClick={() => addEntity(p)} title="INS + DEF + SEG into this column">+</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="kcol kcol-add-col">
        {addingCol ? (
          <div className="kcol-add-form">
            <div className="kcol-add-eyebrow">new column</div>
            <input
              autoFocus
              type="text"
              placeholder="column name"
              value={newColName}
              onChange={e => setNewColName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') addPartition();
                if (e.key === 'Escape') { setAddingCol(false); setNewColName(''); }
              }}
            />
            <div className="kcol-add-actions">
              <button className="kcol-add-cancel" onClick={() => { setAddingCol(false); setNewColName(''); }}>cancel</button>
              <button className="kcol-add-go" onClick={addPartition} disabled={!newColName.trim()}>add</button>
            </div>
          </div>
        ) : (
          <button className="kcol-add-btn" onClick={() => setAddingCol(true)} title="add a new column · emits DEF _schema.partitions">
            <i className="ph ph-plus" aria-hidden="true"></i>
            <span>add column</span>
          </button>
        )}
      </div>
    </div>
    </>
  );
}

// Phosphor icon name for a Kanban card-field row by field type.
function iconForFieldType(t) {
  return ({
    text: 'text-aa', longtext: 'text-align-left', number: 'hash',
    boolean: 'check-square', select: 'circle', multiselect: 'list-checks',
    date: 'calendar-blank', url: 'link', email: 'envelope',
    json: 'brackets-curly', formula: 'function',
  })[t] || 'text-aa';
}
function formatCardVal(v, t) {
  if (t === 'boolean') return v ? 'yes' : 'no';
  if (t === 'date' && v) {
    try { return new Date(v).toLocaleDateString(); } catch (e) { return String(v); }
  }
  if (t === 'multiselect' && Array.isArray(v)) return v.join(', ');
  if (t === 'json' && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─────────────────────────────────────────────────────────────────────────
// Notebook — for !lab_notes-style rooms
// ─────────────────────────────────────────────────────────────────────────

function Notebook({ state }) {
  const entries = Object.values(state.entities)
    .filter(e => e._type === 'observation' || e._type === 'hypothesis')
    .sort((a, b) => a._created - b._created);

  return (
    <div className="notebook">
      {entries.map(e => (
        <div className={`note-entry ${e._type === 'hypothesis' ? 'hypothesis' : ''}`} key={e._anchor}>
          <div className="ntype">{e._type}{e.status ? ` · ${e.status}` : ''}</div>
          <div className="nbody">{e.what || e.claim || '(empty)'}</div>
          <div className="nmeta">
            <span>{e._anchor}</span>
            <span>{e._sender}</span>
            <span>{new Date(e._created).toLocaleString()}</span>
          </div>
        </div>
      ))}
      {entries.length === 0 && (
        <div className="empty-app">
          <div className="glyph">∅</div>
          no observations or hypotheses yet
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Create-board flow — schema-driven, writes DEF events into the log.
// ─────────────────────────────────────────────────────────────────────────

function CreateBoardForm({ state, onEmit, onCancel }) {
  const [typeName, setTypeName] = React.useState('task');
  const [partitions, setPartitions] = React.useState('todo, doing, done');
  const existingTables = state.schema?.tables || [];

  function commit() {
    const name = typeName.trim();
    if (!name) return;
    const parts = partitions.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const newTables = existingTables.includes(name) ? existingTables : [...existingTables, name];
    // 1. declare table
    onEmit(AV_OP.DEF, { anchor: null, path: '_schema.tables', value: newTables });
    // 2. fields — title is the minimum
    if (!state.schema?.fields?.[name]) {
      onEmit(AV_OP.DEF, { anchor: null, path: `_schema.fields.${name}`, value: [
        { name: 'title', type: 'text' },
      ]});
    }
    // 3. partitions — required for kanban
    onEmit(AV_OP.DEF, { anchor: null, path: `_schema.partitions.${name}`, value: parts });
    onCancel();
  }

  return (
    <div style={{padding:'30px 24px',maxWidth:520,margin:'0 auto'}}>
      <div style={{fontSize:13,color:'var(--text-bright)',marginBottom:14,fontWeight:600}}>
        create a kanban board
      </div>
      <div style={{fontSize:11.5,color:'var(--text-dim)',marginBottom:18,lineHeight:1.6}}>
        a kanban is a projection of an entity type into partitions. defining the board writes its
        shape into the log:
        <span className="kbd" style={{margin:'0 4px'}}>DEF _schema.tables</span>
        <span className="kbd" style={{margin:'0 4px'}}>DEF _schema.fields.&lt;type&gt;</span>
        <span className="kbd" style={{margin:'0 4px'}}>DEF _schema.partitions.&lt;type&gt;</span>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:10}}>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{fontSize:10,textTransform:'uppercase',letterSpacing:1.1,color:'var(--text-dim)',minWidth:100}}>type name</label>
          <input autoFocus value={typeName} onChange={e => setTypeName(e.target.value)} placeholder="task" style={{flex:1}} />
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{fontSize:10,textTransform:'uppercase',letterSpacing:1.1,color:'var(--text-dim)',minWidth:100}}>partitions</label>
          <input value={partitions} onChange={e => setPartitions(e.target.value)} placeholder="todo, doing, done" style={{flex:1}} />
        </div>
        <div style={{display:'flex',gap:6,marginTop:8}}>
          <button onClick={commit} style={{padding:'5px 14px',background:'#000',color:'#fff',border:'1px solid #000',fontSize:11.5,cursor:'pointer'}}>create board</button>
          <button onClick={onCancel} style={{padding:'5px 12px',background:'#fff',color:'var(--text)',border:'1px solid var(--border)',fontSize:11.5,cursor:'pointer'}}>cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// App view root — picks the projection that fits
// ─────────────────────────────────────────────────────────────────────────

function AppView({ room, state, onEmit, scrubber, forceTable, forceMode }) {
  const [creating, setCreating] = React.useState(false);
  if (!room) return <div className="empty-app">select a room</div>;

  // forceTable + forceMode override the auto-detect logic so the sidebar can
  // drive exactly which slice this view renders.
  let kind;
  if (forceMode === 'kanban' && forceTable) {
    kind = { kind: 'kanban', kanbanType: forceTable };
  } else if (forceMode === 'notebook') {
    kind = { kind: 'notebook' };
  } else {
    kind = detectAppKind(state);
  }

  let surface;
  if (creating) {
    surface = <CreateBoardForm state={state} onEmit={onEmit} onCancel={() => setCreating(false)} />;
  } else if (kind.kind === 'kanban') {
    surface = <Kanban state={state} onEmit={onEmit} entityType={kind.kanbanType} />;
  } else if (kind.kind === 'notebook') {
    surface = <Notebook state={state} />;
  } else {
    surface = (
      <div className="empty-app">
        <div className="glyph">⊢</div>
        <div>no kanban board defined in this room yet.</div>
        <div style={{marginTop:6,fontSize:11.5}} className="muted">
          a board needs <span className="kbd">_schema.partitions.&lt;type&gt;</span> in the log.
        </div>
        <div style={{marginTop:14}}>
          <button
            onClick={() => setCreating(true)}
            style={{padding:'6px 14px',background:'#000',color:'#fff',border:'1px solid #000',fontSize:12,cursor:'pointer'}}
          >+ create kanban board</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-view">
      {!forceTable && (
        <div className="app-head">
          <h2>{room.title || 'untitled workspace'}</h2>
          <span className="crumb">projection · {creating ? 'create board' : kind.kind}{kind.kanbanType ? ` · ${kind.kanbanType}` : ''} · {Object.keys(state.entities).length} entities</span>
          <div className="right">
            add a card → emits <b>INS</b> + <b>DEF</b>. drag → <b>SEG</b>.
            switch to <b>log</b> to see them land.
          </div>
        </div>
      )}
      {scrubber}
      {surface}
    </div>
  );
}

window.AppView = AppView;
})();
