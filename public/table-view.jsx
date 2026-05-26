/* table-view.jsx — Airtable-style: one table per entity type, with linked
 * records derived from CON edges. Cells emit DEF; new rows emit INS;
 * linked-record pills are computed from state.connections live.
 */

(function() {
const { useState, useMemo, useRef, useEffect } = React;
const { OP: TV_OP } = window.MatrixEngine;

// ─────────────────────────────────────────────────────────────────────────
// Cell helpers
// ─────────────────────────────────────────────────────────────────────────

function inferType(values) {
  const defined = values.filter(v => v !== undefined && v !== null && v !== '');
  if (defined.length === 0) return 'text';
  if (defined.every(v => typeof v === 'number' || (!isNaN(parseFloat(v)) && isFinite(v)))) return 'number';
  if (defined.every(v => typeof v === 'boolean')) return 'boolean';
  // single-select detection: small distinct cardinality and string values
  if (defined.every(v => typeof v === 'string')) {
    const distinct = new Set(defined);
    if (distinct.size <= 5 && distinct.size < defined.length * 0.7) return 'select';
    return 'text';
  }
  return 'json';
}

function fmtCell(value, type) {
  if (value === undefined || value === null || value === '') return { cls: 'null', text: 'NULL' };
  if (type === 'number') return { cls: 'num', text: String(value) };
  if (type === 'json' && typeof value === 'object') return { cls: 'json', text: JSON.stringify(value) };
  return { cls: 'str', text: String(value) };
}

function EditableCell({ value, onCommit, type, heat }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(value === undefined || value === null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value)));
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    let parsed = draft;
    if (type === 'number') {
      const n = parseFloat(draft);
      if (!isNaN(n)) parsed = n;
    } else if (type === 'json') {
      try { parsed = JSON.parse(draft); } catch {}
    }
    if (parsed !== value) onCommit(parsed);
  }

  if (editing) {
    return (
      <td className="cell editing">
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      </td>
    );
  }
  const { cls, text } = fmtCell(value, type);
  const heatCls = heat ? heatClass(heat) : '';
  return <td className={`cell ${cls} ${heatCls}`} onDoubleClick={startEdit} title={heat ? `${heat} write${heat===1?'':'s'} · double-click to edit` : 'double-click to edit · emits DEF'}>{text}</td>;
}

function heatClass(n) {
  if (!n || n === 0) return '';
  if (n <= 1) return 'heat-1';
  if (n <= 2) return 'heat-2';
  if (n <= 3) return 'heat-3';
  if (n <= 5) return 'heat-4';
  if (n <= 7) return 'heat-5';
  if (n <= 9) return 'heat-6';
  return 'heat-7';
}

// ─────────────────────────────────────────────────────────────────────────
// Linked records cell — pills, derived from state.connections
// ─────────────────────────────────────────────────────────────────────────

function LinkedCell({ links, onJump }) {
  if (!links || links.length === 0) {
    return <td className="cell linked"><span className="em">—</span></td>;
  }
  return (
    <td className="cell linked">
      <div className="link-pills">
        {links.map((l, i) => (
          <button key={i} className="link-pill" onClick={() => onJump(l.anchor, l.type)} title={`-[${l.rel}]→ ${l.anchor}`}>
            <span className="lp-rel">{l.dir === 'out' ? '→' : '←'}</span>
            <span className="lp-name">{l.label}</span>
          </button>
        ))}
      </div>
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Build a table model from the state for one entity type
// ─────────────────────────────────────────────────────────────────────────

function buildTable(entityType, state) {
  const rows = Object.values(state.entities).filter(e => e._type === entityType);
  // Schema-driven columns. If schema declares fields for this type, use those
  // in order, with their declared SQL-ish type. Fields that show up in data
  // but NOT in schema are appended with an "unschematized" flag so the user
  // can see what the log is hiding from the contract.
  const schemaFields = state.schema?.fields?.[entityType];
  let cols;
  if (Array.isArray(schemaFields)) {
    const declared = new Set(schemaFields.map(f => f.name));
    cols = schemaFields.map(f => ({ name: f.name, type: f.type, options: f.options, schematized: true }));
    // any data-only columns get appended
    const extras = new Set();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!k.startsWith('_') && !declared.has(k)) extras.add(k);
      }
    }
    for (const name of extras) {
      cols.push({ name, type: inferType(rows.map(r => r[name])), schematized: false });
    }
  } else {
    // No schema → infer from data; everything is unschematized
    const colSet = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (!k.startsWith('_')) colSet.add(k);
    cols = Array.from(colSet).map(name => ({
      name, type: inferType(rows.map(r => r[name])), schematized: false,
    }));
  }
  // Partition column: only if schema declares one for this type OR data has partitions
  const hasPartitionInSchema = !!state.schema?.partitions?.[entityType];
  const partitioned = hasPartitionInSchema || rows.some(r => state.partitions[r._anchor]);
  return { cols, rows, partitioned, partitionFromSchema: hasPartitionInSchema };
}

function linkedTypesFor(entityType, state) {
  // Prefer schema.links if declared
  const schemaLinks = state.schema?.links;
  if (Array.isArray(schemaLinks)) {
    const set = new Set();
    for (const l of schemaLinks) {
      if (l.from === entityType) set.add(l.to);
      if (l.to === entityType) set.add(l.from);
    }
    return Array.from(set);
  }
  // Fallback: observed from data
  const set = new Set();
  for (const c of state.connections) {
    const src = state.entities[c.source];
    const tgt = state.entities[c.target];
    if (src?._type === entityType && tgt) set.add(tgt._type);
    if (tgt?._type === entityType && src) set.add(src._type);
  }
  return Array.from(set);
}

function linksFromAnchor(anchor, otherType, state) {
  const out = [];
  for (const c of state.connections) {
    if (c.source === anchor) {
      const tgt = state.entities[c.target];
      if (tgt && tgt._type === otherType) {
        out.push({ anchor: c.target, label: tgt.title || tgt.body || tgt.claim || tgt.what || c.target.slice(-8), rel: c.type, type: otherType, dir: 'out' });
      }
    } else if (c.target === anchor) {
      const src = state.entities[c.source];
      if (src && src._type === otherType) {
        out.push({ anchor: c.source, label: src.title || src.body || src.claim || src.what || c.source.slice(-8), rel: c.type, type: otherType, dir: 'in' });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// One table
// ─────────────────────────────────────────────────────────────────────────

function DbTable({ entityType, state, room, onEmit, onJump, jumpHighlight, showDDL, setSelection }) {
  const { cols, rows, partitioned, partitionFromSchema } = useMemo(() => buildTable(entityType, state), [entityType, state]);
  const linkedTypes = useMemo(() => linkedTypesFor(entityType, state), [entityType, state]);
  const declaredInSchema = !!state.schema?.fields?.[entityType] || (state.schema?.tables || []).includes(entityType);
  const [newRowTitle, setNewRowTitle] = useState('');
  const [heatOn, setHeatOn] = useState(false);

  // Per-column average writes for the summary row
  const colStats = useMemo(() => {
    const out = {};
    for (const c of cols) {
      const counts = rows.map(r => r._writes?.[c.name] || 0);
      const total = counts.reduce((a, b) => a + b, 0);
      out[c.name] = {
        avg: rows.length ? total / rows.length : 0,
        total,
        max: counts.reduce((a, b) => Math.max(a, b), 0),
      };
    }
    return out;
  }, [cols, rows]);

  function commitCell(anchor, path, value) {
    onEmit(TV_OP.DEF, { anchor, path, value });
  }
  function commitPartition(anchor, partition) {
    onEmit(TV_OP.SEG, { anchor, partition });
  }

  function addRow() {
    const title = newRowTitle.trim();
    if (!title) return;
    const sender = '@you:demo';
    const ts = Date.now();
    // INS creates the thing (empty payload); DEF puts the first parameter on it.
    const anchor = window.MatrixEngine.makeAnchor(entityType, {}, sender, ts);
    onEmit(TV_OP.INS, { anchor, entity_type: entityType, payload: {} });
    const firstTextField = (cols.find(c => c.type === 'text') || cols[0]);
    const fieldName = firstTextField?.name || 'title';
    onEmit(TV_OP.DEF, { anchor, path: fieldName, value: title });
    setNewRowTitle('');
  }

  const allCols = [
    { name: '_anchor', type: 'pk', isPk: true, schematized: true },
    ...cols,
    ...(partitioned ? [{ name: '_partition', type: 'partition', schematized: partitionFromSchema }] : []),
    ...linkedTypes.map(t => ({ name: t, type: 'linked', schematized: true })),
  ];

  // DDL string for the table header — only schema-declared fields counted as part of schema
  const ddl = useMemo(() => {
    const schemaFields = cols.filter(c => c.schematized);
    const extras = cols.filter(c => !c.schematized);
    const lines = [
      `<span class="kw">CREATE TABLE</span> <span class="id">${entityType}</span> (`,
      `  <span class="id">_anchor</span>    <span class="ty">TEXT</span>     <span class="kw">PRIMARY KEY</span>,`,
      ...schemaFields.map(c => `  <span class="id">${c.name.padEnd(10)}</span> <span class="ty">${sqlType(c.type).padEnd(8)}</span>,`),
      ...(partitioned && partitionFromSchema
        ? [`  <span class="id">_partition </span> <span class="ty">TEXT</span>,     <span class="cmt">-- from _schema.partitions.${entityType} via SEG</span>`]
        : partitioned
        ? [`  <span class="id">_partition </span> <span class="ty">TEXT</span>?    <span class="cmt">-- observed in data, not in schema</span>`]
        : []),
      ...linkedTypes.map(t => `  <span class="id">${t.padEnd(10)}</span> <span class="ty">LINK&lt;${t}&gt;</span>  <span class="cmt">-- derived from CON edges${state.schema?.links ? ' (in schema)' : ''}</span>`),
      ...extras.map(c => `  <span class="cmt">-- ! </span><span class="id">${c.name.padEnd(8)}</span> <span class="ty">${sqlType(c.type).padEnd(8)}</span>  <span class="cmt">-- in data but not in _schema.fields.${entityType}</span>`),
      `);`,
    ];
    if (!declaredInSchema) {
      lines.unshift(`<span class="cmt">-- ! ${entityType} not declared in _schema.tables; appearing because of data</span>`);
    }
    return lines.join('\n');
  }, [entityType, JSON.stringify(cols), partitioned, partitionFromSchema, linkedTypes.join(','), declaredInSchema]);

  return (
    <div className="dbtable">
      {showDDL && <div className="ddl" dangerouslySetInnerHTML={{ __html: ddl }} />}
      <div className="dbtable-head">
        <div className="name">
          <span className="schema">{room.id.replace('!','')}</span><span className="dot">.</span>{entityType}
          {!declaredInSchema && <span style={{color:'var(--signal)',marginLeft:8,fontWeight:400}}>? unschematized</span>}
        </div>
        <div className="meta">
          {rows.length} row{rows.length!==1?'s':''}
          <span className="pill">{cols.length} col{cols.length!==1?'s':''}</span>
          {linkedTypes.length > 0 && <span className="pill">{linkedTypes.length} linked</span>}
          <button
            className={`heat-toggle ${heatOn ? 'on' : ''}`}
            onClick={() => setHeatOn(o => !o)}
            title="color cells by number of DEF writes per path"
          >heat map</button>
        </div>
      </div>
      <div className="dbtable-scroll">
        <table className={`dbgrid ${heatOn ? 'heat-on' : ''}`}>
          <thead>
            <tr>
              {allCols.map(c => {
                const cs = colStats[c.name];
                return (
                  <th key={c.name} className={`${c.isPk ? 'pk' : ''} ${c.schematized === false ? 'unschematized' : ''}`}
                      title={c.schematized === false ? 'in data but not in _schema' : ''}>
                    {c.name}
                    {c.type !== 'pk' && c.type !== 'linked' && c.type !== 'partition' && <span className="ty">{sqlType(c.type)}</span>}
                    {c.type === 'linked' && <span className="ty">LINK</span>}
                    {c.type === 'partition' && <span className="ty">TEXT</span>}
                    {heatOn && cs && cs.avg > 0 && (
                      <span className="rev" title={`${cs.total} writes total · max ${cs.max} on one row`}> · {cs.avg.toFixed(1)} avg</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="cell" colSpan={allCols.length} style={{textAlign:'center',padding:'14px',color:'var(--text-faint)',fontStyle:'italic'}}>
                  0 rows · schema is defined, no INS events yet
                </td>
              </tr>
            )}
            {rows.map(r => (
              <tr key={r._anchor}>
                <td
                  className="cell anchor anchor-link"
                  onClick={() => setSelection && setSelection({
                    kind: 'slice',
                    sliceId: `${entityType}.timeline.${r._anchor}`,
                    sliceKind: 'timeline',
                    tableId: entityType,
                    entityAnchor: r._anchor,
                  })}
                  title="view this entity's timeline"
                >{r._anchor}</td>
                {cols.map(c => (
                  <EditableCell
                    key={c.name}
                    value={r[c.name]}
                    type={c.type}
                    heat={heatOn ? (r._writes?.[c.name] || 0) : 0}
                    onCommit={(v) => commitCell(r._anchor, c.name, v)}
                  />
                ))}
                {partitioned && (
                  <EditableCell
                    value={state.partitions[r._anchor]}
                    type="text"
                    heat={0}
                    onCommit={(v) => commitPartition(r._anchor, v)}
                  />
                )}
                {linkedTypes.map(t => (
                  <LinkedCell
                    key={t}
                    links={linksFromAnchor(r._anchor, t, state)}
                    onJump={onJump}
                  />
                ))}
              </tr>
            ))}

            {/* Heat-map summary row */}
            {heatOn && rows.length > 0 && (
              <tr className="heat-summary">
                <td className="cell" style={{fontSize:11,color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'1.2px',fontWeight:700}}>avg writes</td>
                {cols.map(c => {
                  const cs = colStats[c.name] || { avg: 0, max: 0 };
                  const pct = Math.min(cs.max / 10 * 100, 100);
                  const color = cs.avg < 1.5 ? '#85b7eb' : cs.avg < 3 ? '#fac775' : cs.avg < 6 ? '#f09595' : '#e24b4a';
                  return (
                    <td key={c.name} className="cell heat-summary-cell">
                      <div className="heat-bar"><div className="heat-bar-fill" style={{width: pct + '%', background: color}} /></div>
                      <div className="heat-bar-label">{cs.avg.toFixed(1)} / row</div>
                    </td>
                  );
                })}
                {partitioned && <td className="cell"></td>}
                {linkedTypes.map(t => <td key={t} className="cell"></td>)}
              </tr>
            )}
            <tr className="add-row">
              <td className="cell anchor"><span className="em">auto</span></td>
              <td className="cell" colSpan={cols.length + (partitioned ? 1 : 0) + linkedTypes.length}>
                <div className="add-row-input">
                  <input
                    value={newRowTitle}
                    placeholder={`INS new ${entityType}…`}
                    onChange={e => setNewRowTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addRow(); }}
                  />
                  <button onClick={addRow}>INSERT</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sqlType(t) {
  return { text: 'TEXT', number: 'INTEGER', boolean: 'BOOLEAN', json: 'JSONB', select: 'TEXT', multiselect: 'TEXT[]', longtext: 'TEXT', date: 'TIMESTAMP', url: 'TEXT', email: 'TEXT', partition: 'TEXT', linked: 'LINK' }[t] || 'TEXT';
}

function fmtAbsDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtRelTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

// Standard field types — the type picker offers these.
const FIELD_TYPES = [
  { value: 'text',        label: 'text',         hint: 'single-line string' },
  { value: 'longtext',    label: 'long text',    hint: 'multi-line string'  },
  { value: 'number',      label: 'number',       hint: 'integer or decimal' },
  { value: 'boolean',     label: 'checkbox',     hint: 'true / false'        },
  { value: 'select',      label: 'single-select',hint: 'one of a fixed enum'},
  { value: 'multiselect', label: 'multi-select', hint: 'subset of an enum (REC: overwrite → append)' },
  { value: 'date',        label: 'date',         hint: 'timestamp'           },
  { value: 'url',         label: 'url',          hint: 'validated http(s)'   },
  { value: 'email',       label: 'email',        hint: 'validated address'   },
  { value: 'json',        label: 'json',         hint: 'arbitrary structured'},
];

// ─────────────────────────────────────────────────────────────────────────
// Per-table schema slice — renders the columns/links/partitions of one table
// as a dbgrid (table-shaped, matches the rest of the app's vocabulary).
// ─────────────────────────────────────────────────────────────────────────

function TableSchemaView({ entityType, state, room, scrubber, onEmit }) {
  const [editingField, setEditingField] = React.useState(null); // {fieldName, kind: 'name'|'params'}
  const [draft, setDraft] = React.useState('');
  const [newField, setNewField] = React.useState({ name: '', type: 'text' });
  const [newLink, setNewLink] = React.useState({ to: '', rel: '' });
  const [editingPartitions, setEditingPartitions] = React.useState(false);
  const [partitionDraft, setPartitionDraft] = React.useState('');

  if (!room) return <div className="tv-empty">select a room</div>;

  const { cols, partitioned, partitionFromSchema } = buildTable(entityType, state);
  const linkedTypes = linkedTypesFor(entityType, state);
  const declared = !!state.schema?.fields?.[entityType] || (state.schema?.tables || []).includes(entityType);
  const partitions = state.schema?.partitions?.[entityType] || [];
  const links = (state.schema?.links || []).filter(l => l.from === entityType || l.to === entityType);
  const otherTables = (state.schema?.tables || []).filter(t => t !== entityType);

  function opFor(c) {
    if (c.linked) return 'link';
    if (c.partition) return 'partition';
    if (c.type === 'multiselect') return 'append';
    return 'overwrite';
  }

  const rows = [
    {
      path: '_anchor', kind: 'pk', rawType: 'text', type: 'TEXT', operator: 'identity', schematized: true, isPk: true,
      params: 'PRIMARY KEY · content-addressed', editable: false,
    },
    ...cols.map(c => ({
      path: c.name, kind: 'field', rawType: c.type, fieldName: c.name,
      type: sqlType(c.type),
      operator: opFor(c),
      schematized: c.schematized,
      options: c.options,
      params: c.options ? c.options.join(', ') : (c.type === 'json' ? 'arbitrary JSON' : ''),
      editable: c.schematized,
    })),
    ...(partitioned ? [{
      path: '_partition', kind: 'partition', rawType: 'partition',
      type: 'TEXT',
      operator: 'partition',
      schematized: partitionFromSchema,
      params: partitions.length ? partitions.join(', ') : 'observed in data',
      editable: partitionFromSchema || !state.schema?.partitions?.[entityType],
    }] : []),
    ...linkedTypes.map(t => ({
      path: t, kind: 'link', rawType: 'linked', linkTo: t,
      type: `LINK<${t}>`,
      operator: 'link',
      schematized: !!state.schema?.links,
      params: links.filter(l => (l.from === entityType && l.to === t) || (l.to === entityType && l.from === t))
        .map(l => l.rel).join(', ') || '(observed)',
      editable: !!state.schema?.links,
    })),
  ];

  function fieldsArray() { return state.schema?.fields?.[entityType] || []; }

  // High-level stats for the table header
  const entitiesOfType = Object.values(state.entities).filter(e => e._type === entityType);
  const totalRecords = entitiesOfType.length;
  const createdTimes = entitiesOfType.map(e => e._created).filter(Boolean);
  const updatedTimes = entitiesOfType.map(e => e._updated || e._created).filter(Boolean);
  const firstCreated = createdTimes.length ? Math.min(...createdTimes) : null;
  const lastUpdated  = updatedTimes.length ? Math.max(...updatedTimes) : null;
  const incidentEdges = state.connections.filter(c => {
    const s = state.entities[c.source]; const t = state.entities[c.target];
    return s?._type === entityType || t?._type === entityType;
  }).length;
  // Heuristic per-type "writes" — DEFs on entities of this type are reflected
  // by the entities' _hwm + their evaluations count. Sum the touch count.
  let writeApprox = 0;
  let lastSender = null;
  for (const e of entitiesOfType) {
    writeApprox += 1 + (e._evaluations?.length || 0);
    if (!lastSender || (e._updated && (!lastSender.ts || e._updated > lastSender.ts))) {
      lastSender = { mxid: e._updatedBy || e._sender, ts: e._updated || e._created };
    }
  }
  const stats = { totalRecords, firstCreated, lastUpdated, incidentEdges, writeApprox, lastSender };

  function emitFields(next) {
    onEmit(window.MatrixEngine.OP.DEF, { anchor: null, path: `_schema.fields.${entityType}`, value: next });
  }

  function changeFieldType(fieldName, newType) {
    const next = fieldsArray().map(f => {
      if (f.name !== fieldName) return f;
      const updated = { ...f, type: newType };
      // Manage options vs other params on type swap
      if (newType !== 'select' && newType !== 'multiselect') delete updated.options;
      else if (!updated.options) updated.options = [];
      return updated;
    });
    emitFields(next);
  }

  function renameField(oldName, newName) {
    if (!newName || newName === oldName) return;
    const next = fieldsArray().map(f => f.name === oldName ? { ...f, name: newName } : f);
    emitFields(next);
  }

  function setFieldOptions(fieldName, options) {
    const next = fieldsArray().map(f => f.name === fieldName ? { ...f, options } : f);
    emitFields(next);
  }

  function removeField(fieldName) {
    emitFields(fieldsArray().filter(f => f.name !== fieldName));
  }

  function addField() {
    const name = newField.name.trim();
    if (!name) return;
    if (fieldsArray().some(f => f.name === name)) return;
    const f = { name, type: newField.type };
    if (newField.type === 'select' || newField.type === 'multiselect') f.options = [];
    emitFields([...fieldsArray(), f]);
    setNewField({ name: '', type: 'text' });
  }

  function emitPartitions(parts) {
    onEmit(window.MatrixEngine.OP.DEF, { anchor: null, path: `_schema.partitions.${entityType}`, value: parts });
  }

  function startEditParams(row) {
    setEditingField({ fieldName: row.fieldName || row.path, kind: 'params' });
    if (row.kind === 'partition') {
      setDraft(partitions.join(', '));
    } else {
      setDraft(row.options ? row.options.join(', ') : '');
    }
  }

  function commitParams(row) {
    const tokens = draft.split(',').map(s => s.trim()).filter(Boolean);
    if (row.kind === 'partition') emitPartitions(tokens);
    else if (row.kind === 'field') setFieldOptions(row.fieldName, tokens);
    setEditingField(null);
    setDraft('');
  }

  function startEditName(row) {
    setEditingField({ fieldName: row.fieldName, kind: 'name' });
    setDraft(row.fieldName);
  }

  function commitName(row) {
    renameField(row.fieldName, draft.trim());
    setEditingField(null);
    setDraft('');
  }

  return (
    <div className="table-view">
      {scrubber}
      <div className="tv-body single schema-body">
        <header className="page-hero">
          <div className="page-hero-eyebrow">
            <span className="page-hero-kind"><span className="page-hero-glyph">⊢</span> schema</span>
            <span className="page-hero-sep">·</span>
            <span className="page-hero-crumb">{room.id.replace('!','')}<span className="page-hero-slash">/</span>{entityType}</span>
            {!declared && <span className="page-hero-warn">? not declared in _schema.tables</span>}
          </div>
          <h1 className="page-hero-title">{entityType}</h1>
          <div className="page-hero-sub">
            the path → resolution registry for every row of this table · every line below is one <span className="kbd">DEF _schema.*</span> event
          </div>
        </header>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">overview</h2>
            <span className="page-section-sub">live counts from the current fold</span>
          </div>
          <div className="schema-stats">
            <div className="schema-stat">
              <div className="schema-stat-label">records</div>
              <div className="schema-stat-value">{stats.totalRecords}</div>
              <div className="schema-stat-sub">{cols.length} field{cols.length!==1?'s':''} declared</div>
            </div>
            <div className="schema-stat">
              <div className="schema-stat-label">first created</div>
              <div className="schema-stat-value">{stats.firstCreated ? fmtAbsDate(stats.firstCreated) : <span className="muted">—</span>}</div>
              <div className="schema-stat-sub">{stats.firstCreated ? fmtRelTime(stats.firstCreated) : 'no records yet'}</div>
            </div>
            <div className="schema-stat">
              <div className="schema-stat-label">last updated</div>
              <div className="schema-stat-value">{stats.lastUpdated ? fmtAbsDate(stats.lastUpdated) : <span className="muted">—</span>}</div>
              <div className="schema-stat-sub">{stats.lastSender?.mxid ? `by ${stats.lastSender.mxid}` : '—'}</div>
            </div>
            <div className="schema-stat">
              <div className="schema-stat-label">edges</div>
              <div className="schema-stat-value">{stats.incidentEdges}</div>
              <div className="schema-stat-sub">CON events touching this type</div>
            </div>
            <div className="schema-stat">
              <div className="schema-stat-label">writes</div>
              <div className="schema-stat-value">{stats.writeApprox}</div>
              <div className="schema-stat-sub">DEF / EVA on these records</div>
            </div>
          </div>
        </section>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">definition</h2>
            <span className="page-section-sub">
              {rows.length} path{rows.length !== 1 ? 's' : ''} · {cols.length} field{cols.length !== 1 ? 's' : ''}
              {linkedTypes.length > 0 && ` · ${linkedTypes.length} linked`}
              {partitioned && ' · partitioned'}
            </span>
          </div>
          <div className="dbtable schema-dbtable">
          <div className="dbtable-scroll">
            <table className="dbgrid schema-grid">
              <thead>
                <tr>
                  <th className="pk">path</th>
                  <th>type</th>
                  <th>resolution <span className="ty">combining fn</span></th>
                  <th>params</th>
                  <th>source</th>
                  <th style={{width:30}}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isEditingName   = editingField?.fieldName === r.fieldName && editingField?.kind === 'name';
                  const isEditingParams = editingField?.fieldName === (r.fieldName || r.path) && editingField?.kind === 'params';
                  return (
                    <tr key={r.path}>
                      {/* PATH */}
                      {isEditingName ? (
                        <td className="cell editing">
                          <input
                            autoFocus
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            onBlur={() => commitName(r)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitName(r);
                              else if (e.key === 'Escape') { setEditingField(null); setDraft(''); }
                            }}
                          />
                        </td>
                      ) : (
                        <td
                          className={`cell anchor ${r.schematized === false ? 'unsch' : ''} ${r.kind === 'field' && r.editable ? 'clickable' : ''}`}
                          onDoubleClick={() => r.kind === 'field' && r.editable && startEditName(r)}
                          title={r.kind === 'field' && r.editable ? 'double-click to rename' : ''}
                        >
                          {r.schematized === false && <span style={{color:'var(--signal)'}}>? </span>}
                          {r.path}
                        </td>
                      )}

                      {/* TYPE */}
                      <td className="cell str schema-type-cell" style={{color:'var(--triad-structure)',fontWeight:600}}>
                        {r.kind === 'field' && r.editable ? (
                          <select
                            value={r.rawType}
                            onChange={e => changeFieldType(r.fieldName, e.target.value)}
                            className="schema-type-picker"
                            title={FIELD_TYPES.find(t => t.value === r.rawType)?.hint || ''}
                          >
                            {FIELD_TYPES.map(t => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                        ) : (
                          <span>{r.type}</span>
                        )}
                      </td>

                      {/* RESOLUTION */}
                      <td className={`cell str op-${r.operator}`}>{r.operator}</td>

                      {/* PARAMS */}
                      {isEditingParams ? (
                        <td className="cell editing">
                          <input
                            autoFocus
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            onBlur={() => commitParams(r)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitParams(r);
                              else if (e.key === 'Escape') { setEditingField(null); setDraft(''); }
                            }}
                            placeholder={r.kind === 'partition' ? 'backlog, doing, done' : 'value-a, value-b, value-c'}
                          />
                        </td>
                      ) : (
                        <td
                          className={`cell str schema-params-cell ${canEditParams(r) ? 'clickable' : ''}`}
                          style={{color:'var(--text-dim)'}}
                          onDoubleClick={() => canEditParams(r) && startEditParams(r)}
                          title={canEditParams(r) ? 'double-click to edit · emits DEF' : ''}
                        >
                          {paramsLabel(r)}
                        </td>
                      )}

                      {/* SOURCE */}
                      <td className="cell str" style={{color:'var(--text-dim)',fontSize:'11.5px'}}>
                        {r.schematized
                          ? <span>DEF <span style={{color:'var(--text-faint)'}}>_schema.{r.operator === 'link' ? 'links' : r.operator === 'partition' ? `partitions.${entityType}` : `fields.${entityType}`}</span></span>
                          : <span style={{color:'var(--signal)'}}>observed in data · not in _schema</span>}
                      </td>

                      {/* REMOVE */}
                      <td className="cell" style={{textAlign:'center',padding:'5px 4px'}}>
                        {r.kind === 'field' && r.editable && (
                          <button
                            className="schema-remove-btn"
                            title="remove field"
                            onClick={() => {
                              if (confirm(`remove field "${r.fieldName}"? this emits DEF _schema.fields.${entityType} without it.`)) {
                                removeField(r.fieldName);
                              }
                            }}
                          >×</button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Add field row */}
                <tr className="add-row schema-add-row">
                  <td className="cell">
                    <input
                      value={newField.name}
                      onChange={e => setNewField(f => ({ ...f, name: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') addField(); }}
                      placeholder="new field name"
                      className="schema-add-name"
                    />
                  </td>
                  <td className="cell">
                    <select
                      value={newField.type}
                      onChange={e => setNewField(f => ({ ...f, type: e.target.value }))}
                      className="schema-type-picker"
                    >
                      {FIELD_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="cell" style={{color:'var(--text-faint)',fontStyle:'italic',fontSize:'11px'}}>
                    {newField.type === 'multiselect' ? 'append' : 'overwrite'}
                  </td>
                  <td className="cell" colSpan={2} style={{color:'var(--text-faint)',fontStyle:'italic',fontSize:'11px'}}>
                    will emit <span className="kbd">DEF _schema.fields.{entityType}</span> with new field appended
                  </td>
                  <td className="cell" style={{textAlign:'center',padding:'5px 4px'}}>
                    <button
                      className="schema-add-btn"
                      onClick={addField}
                      title="add field"
                      disabled={!newField.name.trim()}
                    >+</button>
                  </td>
                </tr>

                {/* Add partitions row, if not partitioned yet */}
                {!partitioned && (
                  <tr className="add-row schema-add-row">
                    <td className="cell anchor" style={{color:'var(--text-dim)',fontStyle:'italic'}}>_partition</td>
                    <td className="cell" style={{color:'var(--text-faint)'}}>TEXT</td>
                    <td className="cell" style={{color:'var(--text-faint)'}}>partition</td>
                    {editingPartitions ? (
                      <td className="cell editing" colSpan={2}>
                        <input
                          autoFocus
                          value={partitionDraft}
                          onChange={e => setPartitionDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              const parts = partitionDraft.split(',').map(s => s.trim()).filter(Boolean);
                              if (parts.length) { emitPartitions(parts); setEditingPartitions(false); setPartitionDraft(''); }
                            } else if (e.key === 'Escape') { setEditingPartitions(false); setPartitionDraft(''); }
                          }}
                          onBlur={() => {
                            const parts = partitionDraft.split(',').map(s => s.trim()).filter(Boolean);
                            if (parts.length) emitPartitions(parts);
                            setEditingPartitions(false);
                            setPartitionDraft('');
                          }}
                          placeholder="backlog, doing, done · enables kanban slice"
                        />
                      </td>
                    ) : (
                      <td
                        className="cell str clickable"
                        colSpan={2}
                        onClick={() => { setEditingPartitions(true); setPartitionDraft(''); }}
                        style={{color:'var(--text-dim)',fontStyle:'italic'}}
                      >+ click to add partitions · unlocks the kanban slice</td>
                    )}
                    <td className="cell"></td>
                  </tr>
                )}

                {/* Add link row */}
                {otherTables.length > 0 && (
                  <tr className="add-row schema-add-row">
                    <td className="cell">
                      <select
                        value={newLink.to}
                        onChange={e => setNewLink(l => ({ ...l, to: e.target.value }))}
                        className="schema-type-picker"
                      >
                        <option value="">+ link to…</option>
                        {otherTables.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="cell" style={{color:'var(--text-dim)'}}>LINK<span style={{color:'var(--text-faint)'}}>{`<${newLink.to || '…'}>`}</span></td>
                    <td className="cell" style={{color:'var(--text-faint)'}}>link</td>
                    <td className="cell">
                      <input
                        value={newLink.rel}
                        onChange={e => setNewLink(l => ({ ...l, rel: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && newLink.to && newLink.rel) {
                            const existing = state.schema?.links || [];
                            onEmit(window.MatrixEngine.OP.DEF, {
                              anchor: null, path: '_schema.links',
                              value: [...existing, { from: entityType, to: newLink.to, rel: newLink.rel }],
                            });
                            setNewLink({ to: '', rel: '' });
                          }
                        }}
                        placeholder="relation name (e.g. blocks)"
                        className="schema-add-name"
                      />
                    </td>
                    <td className="cell" style={{color:'var(--text-faint)',fontStyle:'italic',fontSize:'11px'}}>
                      will emit <span className="kbd">DEF _schema.links</span>
                    </td>
                    <td className="cell" style={{textAlign:'center',padding:'5px 4px'}}>
                      <button
                        className="schema-add-btn"
                        disabled={!newLink.to || !newLink.rel.trim()}
                        onClick={() => {
                          const existing = state.schema?.links || [];
                          onEmit(window.MatrixEngine.OP.DEF, {
                            anchor: null, path: '_schema.links',
                            value: [...existing, { from: entityType, to: newLink.to, rel: newLink.rel.trim() }],
                          });
                          setNewLink({ to: '', rel: '' });
                        }}
                      >+</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>
        </section>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">about</h2>
            <span className="page-section-sub">how schema is stored</span>
          </div>
          <div className="schema-foot">
            <div className="schema-foot-line">
              <b>schema</b> is itself a projection: every row above is a <span className="kbd">DEF</span> event on a <span className="kbd">_schema.*</span> path. every edit here writes one.
            </div>
            <div className="schema-foot-line muted">
              change the resolution (combining fn) for a path → that's a <span className="kbd">REC</span>.
              change params (widen an enum, rename a field, add partitions) → that's still a <span className="kbd">DEF</span>.
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function canEditParams(r) {
  if (r.kind === 'field' && r.editable) {
    return r.rawType === 'select' || r.rawType === 'multiselect';
  }
  if (r.kind === 'partition' && r.editable) return true;
  return false;
}

function paramsLabel(r) {
  if (r.kind === 'field') {
    if (r.rawType === 'select' || r.rawType === 'multiselect') {
      if (!r.options || r.options.length === 0) return <span style={{color:'var(--text-faint)',fontStyle:'italic'}}>(no options — double-click)</span>;
      return <span>{r.options.map((o, i) => (
        <span key={o} className="param-chip">{o}</span>
      ))}</span>;
    }
    return r.params || <span style={{color:'var(--text-faint)'}}>—</span>;
  }
  if (r.kind === 'partition') {
    return r.params || <span style={{color:'var(--text-faint)'}}>—</span>;
  }
  if (r.kind === 'link') return r.params;
  return r.params || <span style={{color:'var(--text-faint)'}}>—</span>;
}

window.TableSchemaView = TableSchemaView;

// ─────────────────────────────────────────────────────────────────────────
// Syntheses table — SYN events materialize as entities of _type='_synthesis'
// ─────────────────────────────────────────────────────────────────────────

function SynthesisTable({ state, room, showDDL }) {
  const rows = Object.values(state.entities).filter(e => e._type === '_synthesis');
  if (rows.length === 0) return null;
  return (
    <div className="dbtable">
      {showDDL && <div className="ddl" dangerouslySetInnerHTML={{ __html:
        `<span class="kw">CREATE TABLE</span> <span class="id">_synthesis</span> (
  <span class="id">_anchor   </span> <span class="ty">TEXT</span>     <span class="kw">PRIMARY KEY</span>,
  <span class="id">_inputs   </span> <span class="ty">TEXT[]</span>   <span class="cmt">-- anchors merged</span>,
  <span class="id">output    </span> <span class="ty">JSONB</span>
);  <span class="cmt">-- one row per SYN event</span>` }} />}
      <div className="dbtable-head">
        <div className="name">
          <span className="schema">{room.id.replace('!','')}</span><span className="dot">.</span>_synthesis
        </div>
        <div className="meta">{rows.length} row{rows.length!==1?'s':''}</div>
      </div>
      <div className="dbtable-scroll">
        <table className="dbgrid">
          <thead>
            <tr><th className="pk">_anchor</th><th>_inputs <span className="ty">TEXT[]</span></th><th>output <span className="ty">JSONB</span></th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r._anchor}>
                <td className="cell anchor">{r._anchor}</td>
                <td className="cell str">[{(r._inputs || []).join(', ')}]</td>
                <td className="cell json">{JSON.stringify({...r, _anchor:undefined, _type:undefined, _inputs:undefined, _created:undefined, _sender:undefined, _eventId:undefined, _hwm:undefined})}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Connections-as-relation-table
// ─────────────────────────────────────────────────────────────────────────

function ConnectionsTable({ state, room, onJump, showDDL }) {
  if (state.connections.length === 0) return null;
  return (
    <div className="dbtable rel">
      {showDDL && <div className="ddl" dangerouslySetInnerHTML={{ __html:
        `<span class="kw">CREATE TABLE</span> <span class="id">_connections</span> (
  <span class="id">source    </span> <span class="ty">TEXT</span>     <span class="cmt">-- anchor</span>,
  <span class="id">rel       </span> <span class="ty">TEXT</span>,
  <span class="id">target    </span> <span class="ty">TEXT</span>     <span class="cmt">-- anchor</span>,
  <span class="id">_ts       </span> <span class="ty">BIGINT</span>
);  <span class="cmt">-- one row per CON event</span>` }} />}
      <div className="dbtable-head">
        <div className="name">
          <span className="schema">{room.id.replace('!','')}</span><span className="dot">.</span>_connections
        </div>
        <div className="meta">{state.connections.length} edge{state.connections.length!==1?'s':''}</div>
      </div>
      <div className="dbtable-scroll">
        <table className="dbgrid">
          <thead>
            <tr>
              <th>source</th>
              <th>rel</th>
              <th>target</th>
              <th>ts</th>
            </tr>
          </thead>
          <tbody>
            {state.connections.map((c, i) => (
              <tr key={i}>
                <td className="cell anchor" onClick={() => onJump(c.source)} style={{cursor:'pointer'}}>{c.source}</td>
                <td className="cell str" style={{color:'var(--blue)'}}>{c.type}</td>
                <td className="cell anchor" onClick={() => onJump(c.target)} style={{cursor:'pointer'}}>{c.target}</td>
                <td className="cell str" style={{color:'var(--text-dim)'}}>{new Date(c._ts).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Schema table — show the room's _schema as another table
// ─────────────────────────────────────────────────────────────────────────

function SchemaTable({ state, room, showDDL }) {
  const entries = flattenSchema(state.schema || {});
  if (entries.length === 0) return null;
  return (
    <div className="dbtable">
      {showDDL && <div className="ddl" dangerouslySetInnerHTML={{ __html:
        `<span class="kw">CREATE TABLE</span> <span class="id">_schema</span> (
  <span class="id">key       </span> <span class="ty">TEXT</span>     <span class="kw">PRIMARY KEY</span>,
  <span class="id">value     </span> <span class="ty">JSONB</span>
);  <span class="cmt">-- one row per DEF event with anchor=null path=_schema.*</span>` }} />}
      <div className="dbtable-head">
        <div className="name">
          <span className="schema">{room.id.replace('!','')}</span><span className="dot">.</span>_schema
        </div>
        <div className="meta">{entries.length} entr{entries.length!==1?'ies':'y'}</div>
      </div>
      <div className="dbtable-scroll">
        <table className="dbgrid">
          <thead>
            <tr><th className="pk">key</th><th>value <span className="ty">JSONB</span></th></tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td className="cell anchor">{k}</td>
                <td className="cell json">{JSON.stringify(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function flattenSchema(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenSchema(v, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Create-table flow — emits schema DEF events into the log.
// "Creating a table" in a projection is just writing _schema.* to the room.
// ─────────────────────────────────────────────────────────────────────────

function CreateTableForm({ state, room, onEmit, onCancel, defaultName = '', defaultPartitions = '' }) {
  const [name, setName]                 = React.useState(defaultName);
  const [partitions, setPartitions]     = React.useState(defaultPartitions);
  const [extraFields, setExtraFields]   = React.useState('');
  const existing = state.schema?.tables || [];

  function commit() {
    const tableName = name.trim();
    if (!tableName) return;
    const newTables = existing.includes(tableName) ? existing : [...existing, tableName];

    // 1. Declare table in _schema.tables
    onEmit(TV_OP.DEF, { anchor: null, path: '_schema.tables', value: newTables });

    // 2. Declare fields — at minimum, a title text field
    const fields = [{ name: 'title', type: 'text' }];
    for (const tok of extraFields.split(',').map(s => s.trim()).filter(Boolean)) {
      // syntax: "name:type" or just "name"
      const [n, t] = tok.split(':').map(s => s.trim());
      fields.push({ name: n, type: t || 'text' });
    }
    onEmit(TV_OP.DEF, { anchor: null, path: `_schema.fields.${tableName}`, value: fields });

    // 3. Optional partitions
    const parts = partitions.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) {
      onEmit(TV_OP.DEF, { anchor: null, path: `_schema.partitions.${tableName}`, value: parts });
    }

    onCancel();
  }

  return (
    <div className="op-form" style={{margin:'12px 0',borderLeftColor:'var(--triad-significance)'}}>
      <div className="hint">
        <b>create table</b> · writes <span className="kbd">DEF _schema.*</span> into the log so the shape is part of the data, not the code.
      </div>
      <div className="row">
        <label>name</label>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="task" />
      </div>
      <div className="row">
        <label>partitions</label>
        <input value={partitions} onChange={e => setPartitions(e.target.value)} placeholder="todo, doing, done · optional · enables kanban" />
      </div>
      <div className="row">
        <label>extra fields</label>
        <input value={extraFields} onChange={e => setExtraFields(e.target.value)} placeholder="priority:select, estimate_h:number · optional" />
      </div>
      <div className="hint" style={{marginTop:2}}>
        will emit: <span className="kbd">DEF</span> _schema.tables · _schema.fields.{name || '…'} {partitions && ` · _schema.partitions.${name || '…'}`}
      </div>
      <div className="actions">
        <button onClick={commit}>create</button>
        <button className="ghost" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────

function TableView({ room, state, onEmit, tweaks, scrubber, forceTable, hideHead, setSelection }) {
  const [jumpHighlight, setJumpHighlight] = useState(null);
  const [activeTable, setActiveTable] = useState(null);
  const [creating, setCreating] = useState(false);

  if (!room) return <div className="tv-empty">select a room</div>;

  // Tables to surface: schema.tables (authoritative) ∪ any types observed in data
  const declared = state.schema?.tables || [];
  const observed = Array.from(new Set(Object.values(state.entities).map(e => e._type).filter(t => t && t !== '_synthesis')));
  const tables = Array.from(new Set([...declared, ...observed]));
  const hasSynthesis = Object.values(state.entities).some(e => e._type === '_synthesis');

  const tabs = [
    ...tables.map(t => ({ kind: 'entity', name: t, declared: declared.includes(t), rows: observed.includes(t) ? Object.values(state.entities).filter(e => e._type === t).length : 0 })),
    ...(hasSynthesis ? [{ kind: 'syntheses', name: '_synthesis', declared: false, rows: Object.values(state.entities).filter(e => e._type === '_synthesis').length }] : []),
    ...(state.connections.length > 0 ? [{ kind: 'connections', name: '_connections', declared: !!state.schema?.links, rows: state.connections.length }] : []),
    ...(Object.keys(state.schema || {}).length > 0 ? [{ kind: 'schema', name: '_schema', declared: true, rows: Object.keys(state.schema || {}).length }] : []),
  ];

  const fallback = tabs.find(t => t.kind === 'entity' && t.rows > 0)
                  || tabs.find(t => t.kind === 'entity' && t.declared)
                  || tabs[0];
  // forceTable lets a parent (e.g. the sidebar) pick exactly which table to render
  const active = forceTable
    ? tabs.find(t => t.name === forceTable) || fallback
    : (tabs.find(t => t.name === activeTable) || fallback);

  function onJump(anchor) {
    setJumpHighlight(anchor);
    setTimeout(() => setJumpHighlight(null), 1500);
    const target = state.entities[anchor];
    if (target && target._type !== active?.name) {
      setActiveTable(target._type);
    }
  }

  const totallyEmpty = tabs.length === 0;

  return (
    <div className="table-view">
      {!forceTable && !hideHead && (
        <div className="tv-head">
          <h2>{room.id.replace(/^!/, '').replace(/_/g, ' ')}</h2>
          <span className="crumb">projection · {tables.length} table{tables.length!==1?'s':''} · {Object.keys(state.entities).length} rows · {state.connections.length} edges</span>
          <div className="right">
            one table at a time — like airtable.
            rooms = bases · entity types = tables · <b>CON</b> edges = linked records.
            double-click a cell to edit (emits <b>DEF</b>).
          </div>
        </div>
      )}

      {!forceTable && tabs.length > 0 && (
        <div className="tv-tabs">
          {tabs.map(t => (
            <button
              key={t.name}
              className={`tv-tab ${active?.name === t.name ? 'active' : ''} ${!t.declared && t.kind === 'entity' ? 'unschematized' : ''} ${t.kind !== 'entity' ? 'meta' : ''}`}
              onClick={() => { setActiveTable(t.name); setCreating(false); }}
            >
              <span className="tname">{t.name}</span>
              <span className="trows">{t.rows}</span>
            </button>
          ))}
          <button
            className={`tv-tab new-tab ${creating ? 'active' : ''}`}
            onClick={() => setCreating(c => !c)}
            title="declare a new table in _schema"
          >
            <span className="tname">+ new table</span>
          </button>
        </div>
      )}

      {scrubber}

      <div className="tv-body single">
        {creating && (
          <CreateTableForm
            state={state}
            room={room}
            onEmit={onEmit}
            onCancel={() => setCreating(false)}
          />
        )}

        {totallyEmpty && !creating && (
          <div className="tv-empty">
            <div className="glyph">●</div>
            <div>no tables in this room yet.</div>
            <div style={{marginTop:6,fontSize:11.5}}>creating a table writes its shape into the log as <span className="kbd">DEF _schema.*</span> events.</div>
            <div style={{marginTop:14}}>
              <button
                onClick={() => setCreating(true)}
                style={{padding:'6px 14px',background:'#000',color:'#fff',border:'1px solid #000',fontSize:12,cursor:'pointer'}}
              >+ create your first table</button>
            </div>
          </div>
        )}

        {!creating && active?.kind === 'entity' && (
          <DbTable
            entityType={active.name}
            state={state}
            room={room}
            onEmit={onEmit}
            onJump={onJump}
            jumpHighlight={jumpHighlight}
            showDDL={tweaks?.showSchemaDDL}
            setSelection={setSelection}
          />
        )}
        {!creating && active?.kind === 'syntheses' && (
          <SynthesisTable state={state} room={room} showDDL={tweaks?.showSchemaDDL} />
        )}
        {!creating && active?.kind === 'connections' && (
          <ConnectionsTable state={state} room={room} onJump={onJump} showDDL={tweaks?.showSchemaDDL} />
        )}
        {!creating && active?.kind === 'schema' && (
          <SchemaTable state={state} room={room} showDDL={tweaks?.showSchemaDDL} />
        )}
      </div>
    </div>
  );
}

window.TableView = TableView;
})();
