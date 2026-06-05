/* airtable-import.jsx
 *
 * Connect to Airtable with a personal-access token (PAT) and pull a base into
 * this workspace. The widget lists your bases, you pick one, and it fetches the
 * base SCHEMA directly from the Metadata API — no copy-paste. It then lays down
 * `_schema.tables`, `_schema.fields.<table>` and `_schema.links`, mapping
 * Airtable's computed columns (formula / rollup / lookup / count / created
 * time) to runtime DEFINITIONS. formula.js derives every computed value at
 * render time; Airtable's pre-computed cell values are never carried across —
 * only the expressions.
 *
 * Optionally (live workspaces only) it also pulls each table's RECORDS via the
 * data API and imports them through the same lazy path the CSV/JSON importer
 * uses: the rows are stored once as a blob in the media store and materialized
 * on demand — no per-row events. Computed and linked fields are never written
 * as data (computed values recompute live; links become CON edges you draw).
 *
 * The token stays in this browser tab. It is sent only to api.airtable.com to
 * read your schema/records — never to this workspace, its homeserver, or any
 * other server. It is held in memory for the life of the dialog and never
 * persisted. Create a scoped, read-only token at
 * https://airtable.com/create/tokens with `schema.bases:read` (and
 * `data.records:read` to pull rows), limited to the bases you want.
 *
 * A no-token fallback remains: paste a Metadata API response
 * (GET /v0/meta/bases/{baseId}/tables) and it creates the schema only.
 *
 * Mounting (app.jsx owns the trigger state):
 *   <window.AirtableSchemaModal schemaImport={…} roomId={…} state={…}
 *      onEmit={…} onClose={…} />
 */

(function () {
  const { useState, useMemo, useEffect, useRef } = React;

  // ── Airtable REST client (browser-only; api.airtable.com supports CORS) ──
  // Every call carries the PAT in an Authorization header and talks straight to
  // Airtable. Errors are normalized to short, actionable messages.
  const AT_BASE = 'https://api.airtable.com/v0';

  async function atFetch(token, path, params) {
    const url = new URL(AT_BASE + path);
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new Error('could not reach Airtable — check your connection (api.airtable.com must be allowed)');
    }
    if (res.status === 401) throw new Error('unauthorized — the token is invalid or expired');
    if (res.status === 403) throw new Error('forbidden — the token lacks a required scope (schema.bases:read · data.records:read) or access to this base');
    if (res.status === 404) throw new Error('not found — the base or table no longer exists');
    if (res.status === 429) throw new Error('rate limited by Airtable — wait a few seconds and retry');
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j?.error?.message || j?.error?.type || ''; } catch { /* ignore */ }
      throw new Error(`Airtable error ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    return res.json();
  }

  // List every base the token can see (paginated). Needs schema.bases:read.
  async function listBases(token) {
    const bases = [];
    let offset;
    let guard = 0;
    do {
      const j = await atFetch(token, '/meta/bases', offset ? { offset } : null);
      for (const b of (j.bases || [])) bases.push({ id: b.id, name: b.name, permissionLevel: b.permissionLevel });
      offset = j.offset;
    } while (offset && ++guard < 50);
    return bases;
  }

  // The base's full schema — the exact shape AirtableSchema.parse() accepts.
  function fetchBaseSchema(token, baseId) {
    return atFetch(token, `/meta/bases/${baseId}/tables`);
  }

  // Stream a table's records page-by-page (100/page) so the importer can flush
  // chunks as they arrive without holding the whole table in memory. Needs
  // data.records:read. `onBatch(pageRecords, totalSoFar)` is awaited per page;
  // returns the total record count.
  async function fetchRecords(token, baseId, tableIdOrName, { onBatch } = {}) {
    let offset;
    let guard = 0;
    let total = 0;
    do {
      const j = await atFetch(token, `/${baseId}/${encodeURIComponent(tableIdOrName)}`, {
        pageSize: 100,
        ...(offset ? { offset } : {}),
      });
      const page = j.records || [];
      total += page.length;
      if (onBatch) await onBatch(page, total);
      offset = j.offset;
    } while (offset && ++guard < 100000);
    return total;
  }

  const AirtableAPI = { listBases, fetchBaseSchema, fetchRecords };
  window.AirtableAPI = AirtableAPI;

  const TYPE_GLYPH = {
    formula: 'ƒ', rollup: 'ƒ', linked: '↔',
    select: '◉', multiselect: '◎', boolean: '☑',
    number: '#', date: '🗓', text: 'T', longtext: '¶',
    email: '@', url: '↗', json: '{}',
  };

  function isComputed(type) { return type === 'formula' || type === 'rollup'; }

  // Stable id for an Airtable source so re-syncs of the same base+table line up.
  function importGroupFor(baseId, table) { return `at:${baseId}:${table.id || table.name}`; }

  // Has this base+table already been synced into the room? Lets the dialog treat
  // a re-open as a re-sync (default it on, label it honestly) rather than a
  // name collision with some unrelated hand-built table.
  function hasPriorAirtableSync(state, baseId, table) {
    if (!baseId) return false;
    const group = importGroupFor(baseId, table);
    return Object.values(state?.entities || {}).some(e => e?._type === 'import' && e.import_group === group);
  }

  // Strip preview-only keys; emit exactly what buildTable + formula.js read.
  function cleanField(f) {
    const out = { name: f.name, type: f.type };
    if (Array.isArray(f.options)) out.options = f.options;
    if (typeof f.formula === 'string') out.formula = f.formula;
    if (f.rollup) out.rollup = f.rollup;
    return out;
  }

  // Plan for materializing imported records: only the fields that carry DATA.
  // Computed columns derive at render time and linked columns are CON edges, so
  // both are excluded — exactly the fields the CSV/JSON importer would refuse.
  function dataFieldPlan(fields) {
    return fields
      .filter(f => f.type !== 'formula' && f.type !== 'rollup' && f.type !== 'linked')
      .map(f => ({ name: f.name, type: f.type, jsonKey: f.name }));
  }

  // Airtable attachment fields come back as arrays of { url, filename, … }
  // whose URLs expire in ~2h, so persisting them is pointless — and we do not
  // re-host the files. Store a lightweight text summary instead. Detected
  // structurally (objects with a url + filename/type) so linked-record arrays
  // (ids) and lookup arrays are left untouched.
  function summarizeAttachments(value) {
    if (!Array.isArray(value) || value.length === 0) return value;
    const isAttachment = value.every(v => v && typeof v === 'object' && typeof v.url === 'string' && ('filename' in v || 'type' in v));
    if (!isAttachment) return value;
    const names = value.map(v => v.filename || v.type || 'file');
    const shown = names.slice(0, 5).join(', ');
    const more = names.length > 5 ? ` +${names.length - 5} more` : '';
    return `${value.length} file${value.length === 1 ? '' : 's'}: ${shown}${more}`;
  }

  // Rows per import blob. The homeserver accepts large blobs, but one giant
  // blob per table means a fresh device must download + decrypt + parse the
  // whole thing before a single row shows. Splitting into ordered chunks lets
  // the open table paint its first rows fast and stream the rest, and keeps
  // each decrypt+parse a quick, non-janky unit of work.
  const CHUNK_ROWS = 10000;

  // The newest generation number already imported for this base+table, or -1 if
  // it was never synced. Each sync writes `import_seq = previous + 1` so the
  // materializer can keep only the latest generation and drop the rest — that's
  // what makes a re-sync replace prior rows instead of duplicating them.
  function lastImportSeq(state, group) {
    let max = -1;
    for (const e of Object.values(state?.entities || {})) {
      if (e?._type === 'import' && e.import_group === group && typeof e.import_seq === 'number' && e.import_seq > max) {
        max = e.import_seq;
      }
    }
    return max;
  }

  // Pull a table's records (streamed) and import them through the lazy
  // media-blob path as one or more ordered chunks — each its own `import`
  // entity sharing `derived_set`, which the existing materializer concatenates
  // by row anchor. Every chunk also carries a STABLE `import_group`
  // (base+table) and a per-sync `import_seq` so re-syncing the same table
  // supersedes the previous rows rather than stacking duplicates. No per-row
  // events. Returns { rows, chunks }.
  async function importTableChunked({ token, baseId, table, roomId, state, onProgress }) {
    const ML = window.MatrixLive;
    if (!ML?.importFile) throw new Error('a live workspace is required to import records');
    const plan = dataFieldPlan(table.fields);
    const group = importGroupFor(baseId, table);
    const seq = lastImportSeq(state, group) + 1;
    let buffer = [];
    let chunkIndex = 0;
    let total = 0;

    async function flush() {
      if (!buffer.length) return;
      const idx = chunkIndex++;
      const count = buffer.length;
      const json = JSON.stringify(buffer);
      buffer = [];
      const file = new File([json], `${table.name}.airtable.${idx}.json`, { type: 'application/json' });
      await ML.importFile(roomId, file, {
        materialize: false,
        name: `${table.name} · airtable${idx ? ` ·${idx}` : ''}`,
        payload: {
          derived_set: table.name,
          rows_imported: count,
          has_header: false,
          shape: 'json',
          field_plan: plan,
          source: 'airtable',
          airtable_base: baseId,
          airtable_table: table.id || undefined,
          import_group: group,
          import_seq: seq,
          chunk_index: idx,
        },
      });
    }

    await fetchRecords(token, baseId, table.id || table.name, {
      onBatch: async (page) => {
        for (const r of page) {
          const f = (r && r.fields) || {};
          const row = {};
          for (const k of Object.keys(f)) row[k] = summarizeAttachments(f[k]);
          buffer.push(row);
          total++;
        }
        onProgress?.(total);
        if (buffer.length >= CHUNK_ROWS) await flush();
      },
    });
    await flush();
    return { rows: total, chunks: chunkIndex };
  }

  function FieldRow({ f }) {
    const computed = isComputed(f.type);
    const detail = f.type === 'formula'
      ? (f.formula || '(empty formula)')
      : f.type === 'rollup'
        ? `${f.rollup?.fn || 'count'}(${f.rollup?.field || ''}) via "${f.rollup?.via || '?'}"`
        : f.type === 'linked'
          ? `→ ${f.linkedTable || '?'}`
          : Array.isArray(f.options) && f.options.length
            ? f.options.join(' · ')
            : '';
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: '8px',
        alignItems: 'baseline', padding: '3px 0', fontFamily: 'var(--mono)', fontSize: '12px',
      }}>
        <span style={{ color: computed ? 'var(--accent, #b45)' : 'var(--text-faint)', fontWeight: computed ? 700 : 400 }}>
          {TYPE_GLYPH[f.type] || '·'}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--text-bright)' }}>{f.name}</span>
          <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{f.type}</span>
          {detail && (
            <span style={{ color: computed ? 'var(--text)' : 'var(--text-faint)', marginLeft: 8, fontStyle: computed ? 'normal' : 'italic' }}>
              {computed ? '= ' : ''}{detail}
            </span>
          )}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: '10px', textTransform: 'uppercase' }}>
          {computed ? 'runtime' : 'data'}
        </span>
      </div>
    );
  }

  function AirtableSchemaModal({ schemaImport, roomId, state, onEmit, onClose }) {
    if (!schemaImport) return null;
    return <Inner key={schemaImport.id || 'at'} roomId={roomId} state={state} onEmit={onEmit} onClose={onClose} />;
  }

  function Inner({ roomId, state, onEmit, onClose }) {
    // phase: connect → bases → schema → running → done
    const [phase, setPhase] = useState('connect');
    const [source, setSource] = useState('pat');        // pat | paste
    const [token, setToken] = useState('');
    const [bases, setBases] = useState(null);           // [{id,name,permissionLevel}]
    const [base, setBase] = useState(null);             // {id,name}
    const [schemaText, setSchemaText] = useState('');   // JSON we parse (fetched or pasted)
    const [include, setInclude] = useState({});         // table name → bool
    const [withData, setWithData] = useState(true);     // also pull records (pat only)
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [progress, setProgress] = useState(null);     // {table, fetched, doneTables, totalTables}
    const [result, setResult] = useState({ tables: 0, rows: 0, withData: false });
    const fileRef = useRef(null);

    // Records import needs a live homeserver room (the media store) + a token.
    const liveRoom = !!(roomId && String(roomId).startsWith('!') && window.MatrixLive?.importFile);
    const canImportData = liveRoom && source === 'pat' && !!token.trim();

    const existingTables = useMemo(() => new Set(state?.schema?.tables || []), [state]);

    const parsed = useMemo(() => {
      if (!schemaText.trim()) return null;
      return window.AirtableSchema ? window.AirtableSchema.parse(schemaText) : { ok: false, error: 'airtable-schema.js not loaded' };
    }, [schemaText]);

    // Default which tables are checked. A table we've synced from this base
    // before is a RE-SYNC — default it on so re-opening the dialog refreshes its
    // schema (computed-field definitions included) and re-pulls its rows without
    // duplicating them. A name that merely collides with a hand-built table
    // stays off, so we don't silently replace someone's authored schema. Fresh
    // tables default on.
    useEffect(() => {
      if (!parsed || !parsed.ok) return;
      setInclude(prev => {
        const next = { ...prev };
        for (const t of parsed.tables) {
          if (t.name in next) continue;
          const resync = hasPriorAirtableSync(state, base?.id, t);
          next[t.name] = resync || !existingTables.has(t.name);
        }
        return next;
      });
    }, [parsed, existingTables, state, base]);

    const includedTables = useMemo(
      () => (parsed?.ok ? parsed.tables.filter(t => include[t.name]) : []),
      [parsed, include]
    );
    const includedNames = useMemo(() => new Set(includedTables.map(t => t.name)), [includedTables]);

    async function connect() {
      const t = token.trim();
      if (!t) return;
      setError(''); setBusy(true);
      try {
        const list = await AirtableAPI.listBases(t);
        if (!list.length) { setError('this token can see no bases — check its base access at airtable.com/create/tokens'); return; }
        setBases(list);
        setPhase('bases');
      } catch (e) { setError(e?.message || String(e)); }
      finally { setBusy(false); }
    }

    async function chooseBase(b) {
      setError(''); setBusy(true); setBase(b);
      try {
        const schema = await AirtableAPI.fetchBaseSchema(token.trim(), b.id);
        setSchemaText(JSON.stringify(schema));
        setInclude({});
        setPhase('schema');
      } catch (e) { setError(e?.message || String(e)); setBase(null); }
      finally { setBusy(false); }
    }

    function usePaste() {
      setSource('paste');
      setBase(null);
      setSchemaText('');
      setError('');
      setPhase('schema');
    }

    async function loadFile(file) {
      if (!file) return;
      try { setSchemaText(await file.text()); }
      catch { /* ignore */ }
      if (fileRef.current) fileRef.current.value = '';
    }

    // Emit the schema (tables + fields + links). Same contract as before:
    // computed-field DEFINITIONS land here; values derive later at render time.
    function emitSchema() {
      const ME = window.MatrixEngine;
      const existing = state?.schema?.tables || [];
      const merged = Array.from(new Set([...existing, ...includedTables.map(t => t.name)]));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        onEmit(ME.OP.DEF, { anchor: null, path: '_schema.tables', value: merged });
      }
      for (const t of includedTables) {
        onEmit(ME.OP.DEF, { anchor: null, path: `_schema.fields.${t.name}`, value: t.fields.map(cleanField) });
      }
      const links = (parsed.links || []).filter(l => includedNames.has(l.from) && includedNames.has(l.to));
      if (links.length) {
        const existingLinks = Array.isArray(state?.schema?.links) ? state.schema.links.slice() : [];
        for (const l of links) {
          if (!existingLinks.some(e => e.from === l.from && e.to === l.to && e.rel === l.rel)) existingLinks.push(l);
        }
        onEmit(ME.OP.DEF, { anchor: null, path: '_schema.links', value: existingLinks });
      }
    }

    async function commit() {
      const ME = window.MatrixEngine;
      if (!ME || !includedTables.length) return;

      emitSchema();
      const tablesCreated = includedTables.length;

      // Schema-only path: paste mode, no live room, or the user opted out.
      if (!(withData && canImportData)) {
        setResult({ tables: tablesCreated, rows: 0, withData: false });
        setPhase('done');
        setTimeout(() => onClose?.(), 900);
        return;
      }

      // Records path: pull each included table's rows through the lazy importer.
      setPhase('running'); setError('');
      let rows = 0; let doneTables = 0;
      try {
        for (const t of includedTables) {
          setProgress({ table: t.name, fetched: 0, doneTables, totalTables: tablesCreated });
          const res = await importTableChunked({
            token: token.trim(), baseId: base.id, table: t, roomId, state,
            onProgress: (n) => setProgress({ table: t.name, fetched: n, doneTables, totalTables: tablesCreated }),
          });
          rows += res.rows;
          doneTables++;
        }
        setResult({ tables: tablesCreated, rows, withData: true });
        setPhase('done');
        setTimeout(() => onClose?.(), 1200);
      } catch (e) {
        // The schema is already created; surface the data error but keep the
        // partial result. No auto-close so the user can read it.
        setError('records: ' + (e?.message || String(e)));
        setResult({ tables: tablesCreated, rows, withData: true });
        setPhase('done');
      }
    }

    useEffect(() => {
      function onKey(e) { if (e.key === 'Escape' && !busy && phase !== 'running') onClose?.(); }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose, busy, phase]);

    const totalComputed = includedTables.reduce((n, t) => n + t.counts.computed, 0);
    const totalFields = includedTables.reduce((n, t) => n + t.counts.total, 0);
    const locked = busy || phase === 'running';

    return (
      <div className="csv-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !locked) onClose?.(); }}>
        <div className="csv-modal">
          <div className="csv-head">
            <div>
              <div className="csv-eyebrow">import airtable</div>
              <div className="csv-filename">
                {source === 'paste' ? 'paste schema · no data'
                  : base ? `${base.name} · ${base.id}`
                    : 'connect with a personal-access token'}
              </div>
              <div className="csv-fileinfo">
                computed fields (formula · rollup · lookup) become definitions — values derive at render time
              </div>
            </div>
            <button className="csv-close" onClick={() => !locked && onClose?.()} title="close" disabled={locked}>×</button>
          </div>

          <div className="csv-body">
            {/* ── CONNECT ─────────────────────────────────────────────── */}
            {phase === 'connect' && (
              <>
                <div className="csv-section">
                  <div className="csv-section-head">
                    <span className="csv-section-label">airtable personal-access token</span>
                  </div>
                  <input
                    type="password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && token.trim() && !busy) connect(); }}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="pat… (paste your token)"
                    style={{
                      width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono)', fontSize: '12px',
                      padding: '10px', background: 'var(--bg-elev, #fff)', color: 'var(--text-bright)',
                      border: '1px solid var(--border, #ddd)', borderRadius: 0,
                    }}
                  />
                  <div className="csv-state-sub" style={{ marginTop: 8 }}>
                    create a scoped, read-only token at{' '}
                    <a href="https://airtable.com/create/tokens" target="_blank" rel="noreferrer"
                      style={{ color: 'var(--accent, #b45)' }}>airtable.com/create/tokens</a>
                    {' '}with <span className="kbd">schema.bases:read</span>
                    {liveRoom && <> + <span className="kbd">data.records:read</span> (to pull rows)</>}, limited to the bases you want.
                  </div>
                  <div className="csv-state-sub" style={{ marginTop: 6 }}>
                    the token stays in this browser tab — sent only to api.airtable.com, never to this workspace or its homeserver, and never saved.
                  </div>
                  {error && (
                    <div className="csv-state-sub" style={{ color: 'var(--danger, #c33)', marginTop: 8 }}>⚠ {error}</div>
                  )}
                </div>

                <div className="csv-section">
                  <button className="csv-map-skip" onClick={usePaste}>no token? paste schema json instead →</button>
                </div>
              </>
            )}

            {/* ── BASES ───────────────────────────────────────────────── */}
            {phase === 'bases' && (
              <div className="csv-section">
                <div className="csv-section-head">
                  <span className="csv-section-label">
                    {bases?.length || 0} base{bases?.length === 1 ? '' : 's'} · pick one to import
                  </span>
                  <button className="csv-map-skip" onClick={() => { setError(''); setPhase('connect'); }}>← change token</button>
                </div>
                {(bases || []).map(b => (
                  <button key={b.id}
                    onClick={() => !busy && chooseBase(b)}
                    disabled={busy}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'left',
                      padding: '10px 12px', marginBottom: 8, cursor: busy ? 'default' : 'pointer',
                      background: 'var(--bg-soft, #f6f6f6)', border: '1px solid var(--border, #e3e3e3)',
                      fontFamily: 'var(--mono)',
                    }}>
                    <span style={{ fontWeight: 700, color: 'var(--text-bright)' }}>{b.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{b.id}</span>
                    {b.permissionLevel && (
                      <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto', textTransform: 'uppercase' }}>{b.permissionLevel}</span>
                    )}
                  </button>
                ))}
                {busy && <div className="csv-state-sub">fetching schema…</div>}
                {error && <div className="csv-state-sub" style={{ color: 'var(--danger, #c33)', marginTop: 6 }}>⚠ {error}</div>}
              </div>
            )}

            {/* ── RUNNING (records import) ─────────────────────────────── */}
            {phase === 'running' && (
              <div className="csv-state-block">
                <div className="csv-state-glyph">⇪</div>
                <div><b>importing records…</b></div>
                <div className="csv-state-sub">
                  {progress
                    ? <>table {Math.min(progress.doneTables + 1, progress.totalTables)}/{progress.totalTables} · <b>{progress.table}</b> · {progress.fetched.toLocaleString()} rows</>
                    : 'fetching from Airtable…'}
                </div>
                <div className="csv-state-sub">rows stream into ordered chunks in the media store and materialize on demand — no per-row events</div>
              </div>
            )}

            {/* ── DONE ────────────────────────────────────────────────── */}
            {phase === 'done' && (
              <div className={`csv-state-block ${error ? 'csv-state-error' : 'csv-state-done'}`}>
                <div className="csv-state-glyph">{error ? '⚠' : '✓'}</div>
                <div><b>created {result.tables} table{result.tables === 1 ? '' : 's'}</b>{result.withData && <> · imported {result.rows.toLocaleString()} row{result.rows === 1 ? '' : 's'}</>}</div>
                {error
                  ? <div className="csv-state-sub" style={{ color: 'var(--danger, #c33)' }}>{error}</div>
                  : <div className="csv-state-sub">{result.withData ? 'computed fields compute themselves from the imported rows' : 'now import a CSV/JSON into each — computed fields compute themselves'}</div>}
              </div>
            )}

            {/* ── SCHEMA preview + select ─────────────────────────────── */}
            {phase === 'schema' && (
              <>
                {source === 'paste' && (
                  <div className="csv-section">
                    <div className="csv-section-head">
                      <span className="csv-section-label">airtable schema json</span>
                      <button className="csv-map-skip" onClick={() => fileRef.current?.click()}>load .json file</button>
                      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                        onChange={e => loadFile(e.target.files?.[0])} />
                    </div>
                    <textarea
                      value={schemaText}
                      onChange={e => setSchemaText(e.target.value)}
                      spellCheck={false}
                      placeholder={'paste GET /v0/meta/bases/{baseId}/tables  →  { "tables": [ … ] }'}
                      style={{
                        width: '100%', minHeight: '120px', resize: 'vertical', boxSizing: 'border-box',
                        fontFamily: 'var(--mono)', fontSize: '12px', padding: '10px',
                        background: 'var(--bg-elev, #fff)', color: 'var(--text-bright)',
                        border: '1px solid var(--border, #ddd)', borderRadius: 0,
                      }}
                    />
                    <button className="csv-map-skip" style={{ marginTop: 6 }}
                      onClick={() => { setSource('pat'); setSchemaText(''); setError(''); setPhase('connect'); }}>
                      ← use a token instead
                    </button>
                  </div>
                )}

                {parsed && !parsed.ok && (
                  <div className="csv-state-sub" style={{ color: 'var(--danger, #c33)' }}>⚠ {parsed.error}</div>
                )}

                {parsed && parsed.ok && (
                  <>
                    <div className="csv-section">
                      <div className="csv-section-head">
                        <span className="csv-section-label">
                          {parsed.tables.length} table{parsed.tables.length === 1 ? '' : 's'} · select what to create
                        </span>
                        {source === 'pat' && (
                          <button className="csv-map-skip" onClick={() => { setError(''); setSchemaText(''); setBase(null); setPhase('bases'); }}>← change base</button>
                        )}
                      </div>
                      {parsed.tables.map(t => {
                        const collides = existingTables.has(t.name);
                        const resync = hasPriorAirtableSync(state, base?.id, t);
                        const on = !!include[t.name];
                        return (
                          <div key={t.name} style={{ border: '1px solid var(--border, #e3e3e3)', marginBottom: 10, opacity: on ? 1 : 0.5 }}>
                            <label style={{
                              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                              background: 'var(--bg-soft, #f6f6f6)', cursor: 'pointer', borderBottom: on ? '1px solid var(--border,#e3e3e3)' : 'none',
                            }}>
                              <input type="checkbox" checked={on}
                                onChange={e => setInclude(m => ({ ...m, [t.name]: e.target.checked }))} />
                              <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text-bright)' }}>{t.name}</span>
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
                                {t.counts.total} field{t.counts.total === 1 ? '' : 's'}
                                {t.counts.computed > 0 && <> · <b style={{ color: 'var(--accent,#b45)' }}>{t.counts.computed} computed</b></>}
                              </span>
                              {resync
                                ? <span className="csv-warn" style={{ marginLeft: 'auto' }}>re-sync — replaces previous rows, no duplicates</span>
                                : collides && <span className="csv-warn" style={{ marginLeft: 'auto' }}>exists — will replace its schema</span>}
                            </label>
                            {on && (
                              <div style={{ padding: '6px 10px' }}>
                                {t.fields.map(f => <FieldRow key={f.name} f={f} />)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {parsed.links.length > 0 && (
                      <div className="csv-section">
                        <div className="csv-section-head">
                          <span className="csv-section-label">{parsed.links.length} record-link relation{parsed.links.length === 1 ? '' : 's'}</span>
                        </div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', padding: '0 2px' }}>
                          {parsed.links.map((l, i) => (
                            <div key={i}>{l.from} —[{l.rel}]→ {l.to}</div>
                          ))}
                          <div style={{ marginTop: 6 }}>links connect rows via CON edges you draw after import; rollups aggregate across them.</div>
                        </div>
                      </div>
                    )}

                    {parsed.warnings.length > 0 && (
                      <div className="csv-section">
                        <div className="csv-section-head">
                          <span className="csv-section-label">{parsed.warnings.length} note{parsed.warnings.length === 1 ? '' : 's'}</span>
                        </div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', padding: '0 2px' }}>
                          {parsed.warnings.map((w, i) => <div key={i}>· {w}</div>)}
                        </div>
                      </div>
                    )}

                    {/* records toggle — only when a live workspace can store the blob */}
                    {source === 'pat' && (
                      <div className="csv-section">
                        <label style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                          background: 'var(--bg-soft, #f6f6f6)', border: '1px solid var(--border, #e3e3e3)',
                          cursor: liveRoom ? 'pointer' : 'default', opacity: liveRoom ? 1 : 0.6,
                          fontFamily: 'var(--mono)', fontSize: 12,
                        }}>
                          <input type="checkbox" checked={withData && liveRoom} disabled={!liveRoom}
                            onChange={e => setWithData(e.target.checked)} />
                          <span style={{ color: 'var(--text-bright)' }}>also import each table's records</span>
                          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                            {liveRoom ? 'via data.records:read — large tables stream in chunks; computed/linked stay derived, attachments become a text summary' : 'open a live workspace to import rows'}
                          </span>
                        </label>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          <div className="csv-foot">
            <div className="csv-foot-note">
              {phase === 'schema' && includedTables.length > 0 && (
                <span className="csv-foot-evt">
                  will emit schema for <b>{includedTables.length}</b> table{includedTables.length === 1 ? '' : 's'}
                  <span className="csv-foot-evt-detail"> · {totalFields} fields ({totalComputed} computed){withData && canImportData ? ' · + records' : ' · 0 rows'}</span>
                </span>
              )}
            </div>
            <div className="csv-foot-actions">
              <button className="csv-cancel" onClick={() => !locked && onClose?.()} disabled={locked}>cancel</button>
              {phase === 'connect' && (
                <button className="csv-import" onClick={connect} disabled={!token.trim() || busy}>
                  {busy ? 'connecting…' : 'connect'}
                </button>
              )}
              {phase === 'schema' && (
                <button className="csv-import" onClick={commit} disabled={locked || includedTables.length === 0}>
                  {includedTables.length === 0 ? 'select a table'
                    : withData && canImportData
                      ? `create ${includedTables.length} + import rows`
                      : `create ${includedTables.length} table${includedTables.length === 1 ? '' : 's'}`}
                </button>
              )}
              {phase === 'done' && (
                <button className="csv-import" onClick={() => onClose?.()}>done</button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.AirtableSchemaModal = AirtableSchemaModal;
})();
