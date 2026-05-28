/* csv-import.jsx
 *
 * Airtable-style CSV importer.
 *
 *   1. user picks a .csv file (or drops one)
 *   2. parse client-side (RFC 4180-ish, handles quotes + escapes + \r\n)
 *   3. one screen: destination (new set / existing set) + field mapping + preview
 *   4. on commit, emit ONLY:
 *        - DEF _schema.tables           (only if creating a new set)
 *        - DEF _schema.fields.<set>     (only when fields change)
 *        - INS one `import` entity carrying the field plan + has_header flag
 *      No per-row events. A 10k-row sheet is ~3 events, not ~70k. The rows
 *      are reconstructed lazily from the source blob at render time by
 *      materializeImportRows (below).
 *
 *   5. ship the original blob to the media store via ML.importFile (with
 *      materialize:false) so the source CSV is the system of record for the
 *      rows and the import is reproducible.
 *
 * Mounting: app.jsx owns the modal state and renders
 *   <window.CsvImportModal csvImport={…} state={…} onEmit={…} onClose={…} />
 * The ImportButton routes .csv files to this flow instead of the
 * straight blob upload.
 */

(function () {
  const { useState, useEffect, useMemo, useRef } = React;

  /* ── CSV parser ───────────────────────────────────────────────────────
   * Streaming-friendly enough for a few hundred MB. Returns rows of strings.
   * Empty trailing lines are dropped; quoted cells decode `""` → `"`.
   */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQ = false;
    let started = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else {
        if (ch === '"' && !started) { inQ = true; started = true; }
        else if (ch === ',')       { row.push(cur); cur = ''; started = false; }
        else if (ch === '\r')      { /* swallow */ }
        else if (ch === '\n')      {
          row.push(cur); cur = ''; started = false;
          if (row.length > 1 || row[0] !== '') rows.push(row);
          row = [];
        }
        else { cur += ch; started = true; }
      }
    }
    if (cur !== '' || row.length) {
      row.push(cur);
      if (row.length > 1 || row[0] !== '') rows.push(row);
    }
    return rows;
  }

  /* ── Type inference ───────────────────────────────────────────────────
   * Conservative: only commits to a non-text type if every non-empty
   * sample value matches. Falls through to text on any ambiguity.
   */
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  const URL_RE   = /^https?:\/\/\S+$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const BOOL_RE  = /^(true|false|yes|no|y|n|0|1)$/i;
  const NUM_RE   = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

  function inferType(values) {
    const sample = values.filter(v => v != null && v !== '').slice(0, 250);
    if (!sample.length) return 'text';
    if (sample.every(v => NUM_RE.test(v)))                                   return 'number';
    if (sample.every(v => BOOL_RE.test(v)) && new Set(sample.map(s => s.toLowerCase())).size <= 4) return 'boolean';
    if (sample.every(v => ISO_DATE_RE.test(v) || SLASH_DATE_RE.test(v)))     return 'date';
    if (sample.every(v => URL_RE.test(v)))                                   return 'url';
    if (sample.every(v => EMAIL_RE.test(v)))                                 return 'email';
    if (sample.some(v => v.length > 80))                                      return 'longtext';
    const distinct = new Set(sample);
    if (distinct.size <= Math.max(8, sample.length * 0.15) && sample.length >= 10) return 'select';
    return 'text';
  }

  function coerce(value, type) {
    if (value == null || value === '') return undefined;
    if (type === 'number')  { const n = parseFloat(value); return isNaN(n) ? value : n; }
    if (type === 'boolean') { return /^(true|yes|y|1)$/i.test(value); }
    if (type === 'date')    { const d = Date.parse(value); return isNaN(d) ? value : new Date(d).toISOString(); }
    return String(value);
  }

  /* ── Field types (mirror table-view.jsx) ───────────────────────────── */
  const FIELD_TYPES = [
    { value: 'text',        label: 'text' },
    { value: 'longtext',    label: 'long text' },
    { value: 'number',      label: 'number' },
    { value: 'boolean',     label: 'checkbox' },
    { value: 'select',      label: 'single-select' },
    { value: 'multiselect', label: 'multi-select' },
    { value: 'date',        label: 'date' },
    { value: 'url',         label: 'url' },
    { value: 'email',       label: 'email' },
    { value: 'json',        label: 'json' },
  ];

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /* sanitize a column header into a valid field name */
  function fieldNameFor(raw, fallback) {
    const s = String(raw || '').trim();
    return s || fallback;
  }

  /* ── The modal ────────────────────────────────────────────────────── */
  function CsvImportModal({ csvImport, state, onEmit, onClose }) {
    if (!csvImport) return null;
    return <CsvImportModalInner key={csvImport.id || 'csv'} csvImport={csvImport} state={state} onEmit={onEmit} onClose={onClose} />;
  }

  function CsvImportModalInner({ csvImport, state, onEmit, onClose }) {
    const { file, roomId } = csvImport;
    const [phase, setPhase]   = useState('parsing');   // parsing | ready | uploading | done | error
    const [error, setError]   = useState(null);
    const [rawRows, setRawRows] = useState([]);        // string[][]
    const [hasHeader, setHasHeader] = useState(true);

    const existingSets = state?.schema?.tables || [];
    const observedSets = Array.from(new Set(
      Object.values(state?.entities || {}).map(e => e._type).filter(t => t && !t.startsWith('_'))
    ));
    const allSets = Array.from(new Set([...existingSets, ...observedSets]));

    // Destination: 'new' or one of the existing set names
    const [dest, setDest]     = useState('new');
    const defaultNewName = (file?.name || 'imported').replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'imported';
    const [newName, setNewName] = useState(defaultNewName);

    // Mapping: per CSV column, { target: '<fieldName>' | '__skip__' | '__new__', newName?, type? }
    const [mapping, setMapping] = useState([]);

    const [importTotal, setImportTotal]       = useState(0);

    /* parse on mount */
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const text = await file.text();
          if (cancelled) return;
          const rows = parseCSV(text);
          if (!rows.length) throw new Error('the file is empty');
          setRawRows(rows);
          setPhase('ready');
        } catch (e) {
          if (cancelled) return;
          setError(e?.message || 'failed to parse csv');
          setPhase('error');
        }
      })();
      return () => { cancelled = true; };
    }, [file]);

    /* derived: header row + data rows */
    const headerRow = hasHeader && rawRows.length ? rawRows[0] : null;
    const dataRows  = hasHeader ? rawRows.slice(1) : rawRows;
    const numCols   = Math.max(0, ...rawRows.map(r => r.length));

    /* derived: per-column inferred type + name */
    const columns = useMemo(() => {
      if (!rawRows.length) return [];
      return Array.from({ length: numCols }, (_, i) => {
        const sample = dataRows.slice(0, 500).map(r => r[i]);
        const inferred = inferType(sample);
        const headerName = headerRow ? headerRow[i] : '';
        const name = fieldNameFor(headerName, `column_${i + 1}`);
        return { idx: i, name, type: inferred };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rawRows, hasHeader, numCols]);

    /* initialize/refresh mapping when columns or destination change */
    useEffect(() => {
      if (!columns.length) return;
      const existingFields = (dest !== 'new' && state?.schema?.fields?.[dest]) ? state.schema.fields[dest] : [];
      const existingByLower = new Map(existingFields.map(f => [f.name.toLowerCase(), f]));
      setMapping(columns.map(col => {
        if (dest === 'new') {
          return { target: '__new__', newName: col.name, type: col.type };
        }
        const match = existingByLower.get(col.name.toLowerCase());
        if (match) return { target: match.name, newName: '', type: match.type };
        return { target: '__new__', newName: col.name, type: col.type };
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [columns, dest]);

    /* validation */
    const trimmedNewName = newName.trim();
    const setName        = dest === 'new' ? trimmedNewName : dest;
    const setNameValid   = !!setName && (dest !== 'new' || !allSets.includes(trimmedNewName));
    const nameCollision  = dest === 'new' && trimmedNewName && allSets.includes(trimmedNewName);

    const includedCount = mapping.filter(m => m.target !== '__skip__').length;
    const canImport     = phase === 'ready' && setNameValid && includedCount > 0 && dataRows.length > 0;

    function updateMapping(i, patch) {
      setMapping(ms => ms.map((m, j) => j === i ? { ...m, ...patch } : m));
    }

    /* ── COMMIT ─────────────────────────────────────────────────────── */
    async function doImport() {
      if (!canImport) return;

      const ME = window.MatrixEngine;
      const ML = window.MatrixLive;
      if (!ME) { setError('engine not loaded'); setPhase('error'); return; }
      if (!ML?.importFile || !roomId) {
        setError('cannot import — not connected to a homeserver');
        setPhase('error');
        return;
      }

      try {
        // Resolve the final field list for the destination set.
        const existingFieldsArr = (state?.schema?.fields?.[setName]) || [];
        const existingByName    = new Map(existingFieldsArr.map(f => [f.name, f]));

        // Walk mapping, assign final target field names + types.
        const finalFields = existingFieldsArr.slice();
        const seenNames   = new Set(finalFields.map(f => f.name));
        const columnTargets = mapping.map((m, i) => {
          if (m.target === '__skip__') return null;
          let fieldName;
          let fieldType = m.type || 'text';
          if (m.target === '__new__') {
            fieldName = fieldNameFor(m.newName || columns[i]?.name, `column_${i + 1}`);
            let suffix = 2;
            const base = fieldName;
            while (seenNames.has(fieldName)) fieldName = `${base}_${suffix++}`;
            seenNames.add(fieldName);
            finalFields.push({
              name: fieldName,
              type: fieldType,
              ...(fieldType === 'select' || fieldType === 'multiselect' ? { options: [] } : {}),
            });
          } else {
            fieldName = m.target;
            const existing = existingByName.get(fieldName);
            if (existing) fieldType = existing.type;
          }
          return { name: fieldName, type: fieldType, csvIdx: i };
        });

        // 1. declare table if new
        if (dest === 'new') {
          onEmit(ME.OP.DEF, {
            anchor: null,
            path: '_schema.tables',
            value: existingSets.includes(setName) ? existingSets : [...existingSets, setName],
          });
        }
        // 2. declare/extend fields if changed
        const fieldsChanged = JSON.stringify(finalFields) !== JSON.stringify(existingFieldsArr);
        if (fieldsChanged) {
          onEmit(ME.OP.DEF, { anchor: null, path: `_schema.fields.${setName}`, value: finalFields });
        }

        // 3. Upload the source CSV + emit ONE INS for the import entity.
        //    The import payload carries the field plan + header flag so
        //    table-view can reconstruct rows lazily from the source blob.
        //    No per-row INS events — 10k rows now becomes ~5 log entries
        //    instead of ~70k.
        setPhase('uploading');
        setImportTotal(dataRows.length);

        const fieldPlan = columnTargets
          .filter(Boolean)
          .map(t => ({ name: t.name, type: t.type, csvIdx: t.csvIdx }));

        await ML.importFile(roomId, file, {
          materialize: false,
          payload: {
            derived_set: setName,
            rows_imported: dataRows.length,
            has_header: hasHeader,
            field_plan: fieldPlan,
          },
        });

        setPhase('done');
        setTimeout(() => onClose?.(), 700);
      } catch (e) {
        console.warn('[csv-import] failed:', e);
        setError(e?.message || 'import failed');
        setPhase('error');
      }
    }

    /* ── escape closes the modal (when not mid-import) */
    useEffect(() => {
      function onKey(e) {
        if (e.key === 'Escape' && phase !== 'uploading') onClose?.();
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [phase, onClose]);

    /* render */
    return (
      <div className="csv-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && phase !== 'uploading') onClose?.(); }}>
        <div className="csv-modal">
          {/* head */}
          <div className="csv-head">
            <div>
              <div className="csv-eyebrow">import csv</div>
              <div className="csv-filename">{file.name}</div>
              <div className="csv-fileinfo">
                {fmtBytes(file.size)}
                {phase !== 'parsing' && (
                  <>
                    {' · '}{dataRows.length.toLocaleString()} row{dataRows.length === 1 ? '' : 's'}
                    {' · '}{numCols} column{numCols === 1 ? '' : 's'}
                  </>
                )}
              </div>
            </div>
            <button className="csv-close" onClick={() => phase !== 'uploading' && onClose?.()} title="close" disabled={phase === 'uploading'}>×</button>
          </div>

          {/* body */}
          <div className="csv-body">
            {phase === 'parsing' && (
              <div className="csv-state-block">
                <div className="csv-state-glyph">⊙</div>
                <div>parsing csv…</div>
              </div>
            )}
            {phase === 'error' && (
              <div className="csv-state-block csv-state-error">
                <div className="csv-state-glyph">⚠</div>
                <div><b>could not parse</b></div>
                <div className="csv-state-sub">{error}</div>
              </div>
            )}
            {phase === 'done' && (
              <div className="csv-state-block csv-state-done">
                <div className="csv-state-glyph">✓</div>
                <div><b>imported {importTotal.toLocaleString()} row{importTotal === 1 ? '' : 's'}</b> into <b>{setName}</b></div>
                <div className="csv-state-sub">1 INS event + schema declarations · rows materialize on demand from the source blob</div>
              </div>
            )}
            {phase === 'uploading' && (
              <div className="csv-state-block">
                <div className="csv-state-glyph">⇪</div>
                <div><b>uploading source csv to media store…</b></div>
                <div className="csv-state-sub">the original file is preserved as <span className="kbd">mxc://…</span> so this import is reproducible</div>
              </div>
            )}

            {phase === 'ready' && (
              <>
                {/* DESTINATION */}
                <div className="csv-section">
                  <div className="csv-section-head">
                    <span className="csv-section-label">destination</span>
                  </div>
                  <div className="csv-dest-row">
                    <label className={`csv-dest-opt ${dest === 'new' ? 'on' : ''}`}>
                      <input type="radio" checked={dest === 'new'} onChange={() => setDest('new')} />
                      <span className="csv-dest-name">create new set</span>
                      <input
                        type="text"
                        className="csv-dest-input"
                        disabled={dest !== 'new'}
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder="set name"
                      />
                      {nameCollision && <span className="csv-warn">already exists</span>}
                    </label>
                    <label className={`csv-dest-opt ${dest !== 'new' ? 'on' : ''} ${allSets.length === 0 ? 'disabled' : ''}`}>
                      <input type="radio" checked={dest !== 'new'} onChange={() => allSets.length && setDest(allSets[0])} disabled={!allSets.length} />
                      <span className="csv-dest-name">add to existing set</span>
                      <select
                        className="csv-dest-select"
                        disabled={dest === 'new' || !allSets.length}
                        value={dest === 'new' ? '' : dest}
                        onChange={e => setDest(e.target.value)}
                      >
                        {allSets.length === 0 && <option value="">— no sets yet —</option>}
                        {allSets.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </label>
                  </div>
                </div>

                {/* MAPPING */}
                <div className="csv-section">
                  <div className="csv-section-head">
                    <span className="csv-section-label">field mapping</span>
                    <label className="csv-header-toggle">
                      <input type="checkbox" checked={hasHeader} onChange={e => setHasHeader(e.target.checked)} />
                      <span>first row is headers</span>
                    </label>
                  </div>

                  <div className="csv-map">
                    <div className="csv-map-row csv-map-head">
                      <div>csv column</div>
                      <div>→</div>
                      <div>target field</div>
                      <div>type</div>
                      <div></div>
                    </div>
                    {columns.map((col, i) => {
                      const m = mapping[i] || { target: '__new__', newName: col.name, type: col.type };
                      const isSkip = m.target === '__skip__';
                      const isNew  = m.target === '__new__';
                      const existingFields = (dest !== 'new' && state?.schema?.fields?.[dest]) ? state.schema.fields[dest] : [];
                      return (
                        <div key={i} className={`csv-map-row ${isSkip ? 'skip' : ''}`}>
                          <div className="csv-map-csvcol" title={col.name}>
                            <span className="csv-col-name">{col.name}</span>
                            <span className="csv-col-preview">{(dataRows[0]?.[i] || '').toString().slice(0, 28) || <em>—</em>}</span>
                          </div>
                          <div className="csv-map-arrow">→</div>
                          <div className="csv-map-target">
                            {isNew ? (
                              <input
                                type="text"
                                className="csv-map-newname"
                                value={m.newName || ''}
                                onChange={e => updateMapping(i, { newName: e.target.value })}
                                placeholder="new field name"
                              />
                            ) : (
                              <select
                                className="csv-map-targetsel"
                                value={m.target}
                                onChange={e => updateMapping(i, { target: e.target.value })}
                              >
                                <option value="__skip__">— skip this column —</option>
                                <option value="__new__">+ create new field…</option>
                                {existingFields.map(f => (
                                  <option key={f.name} value={f.name}>{f.name}</option>
                                ))}
                              </select>
                            )}
                            {isNew && dest !== 'new' && (
                              <button className="csv-map-undo" onClick={() => updateMapping(i, { target: '__skip__' })} title="cancel — pick existing instead">existing →</button>
                            )}
                          </div>
                          <div className="csv-map-type">
                            <select
                              value={m.type || 'text'}
                              onChange={e => updateMapping(i, { type: e.target.value })}
                              disabled={isSkip || (!isNew && dest !== 'new')}
                              title={isSkip ? '' : (!isNew && dest !== 'new' ? 'type comes from the existing field' : '')}
                            >
                              {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </div>
                          <div className="csv-map-act">
                            <button
                              className="csv-map-skip"
                              onClick={() => updateMapping(i, { target: isSkip ? '__new__' : '__skip__' })}
                              title={isSkip ? 'include this column' : 'skip this column'}
                            >{isSkip ? 'include' : 'skip'}</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* PREVIEW */}
                <div className="csv-section">
                  <div className="csv-section-head">
                    <span className="csv-section-label">preview · first {Math.min(5, dataRows.length)} of {dataRows.length.toLocaleString()} row{dataRows.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="csv-preview-wrap">
                    <table className="csv-preview">
                      <thead>
                        <tr>
                          {columns.map((c, i) => {
                            const m = mapping[i];
                            const skip = m?.target === '__skip__';
                            const targetName = m?.target === '__new__' ? (m.newName || c.name) : m?.target || c.name;
                            return (
                              <th key={i} className={skip ? 'skip' : ''}>
                                <div className="csv-prev-target">{skip ? '— skipped —' : targetName}</div>
                                <div className="csv-prev-src">{c.name}</div>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {dataRows.slice(0, 5).map((r, ri) => (
                          <tr key={ri}>
                            {columns.map((c, ci) => {
                              const m = mapping[ci];
                              const skip = m?.target === '__skip__';
                              return <td key={ci} className={skip ? 'skip' : ''}>{(r[ci] ?? '').toString().slice(0, 60)}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* foot */}
          <div className="csv-foot">
            <div className="csv-foot-note">
              {phase === 'ready' && (
                <>
                  <span className="csv-foot-mxc">⎘ source csv will be uploaded to the media store</span>
                  {dataRows.length > 0 && (
                    <span className="csv-foot-evt">
                      · will emit <b>{(1 + (dest === 'new' ? 2 : 1)).toLocaleString()}</b> events
                      <span className="csv-foot-evt-detail"> (1 import + schema · rows materialize from the blob)</span>
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="csv-foot-actions">
              <button className="csv-cancel" onClick={onClose} disabled={phase === 'uploading'}>cancel</button>
              <button
                className="csv-import"
                onClick={doImport}
                disabled={!canImport}
              >
                {phase === 'uploading' ? 'uploading…'
                 : phase === 'done'      ? 'done'
                 : phase === 'error'     ? 'retry'
                 : `import ${dataRows.length.toLocaleString()} row${dataRows.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Lazy row materialization ────────────────────────────────────────
   *
   * Imports emit 1 INS for the import entity + schema DEFs — but NO per-row
   * events. The rows live in the source CSV / JSON which is preserved in the
   * homeserver's media store. This function fetches those bytes, parses +
   * coerces them with the field plan stored on the import entity, and
   * returns synthetic row entities (stable `${importAnchor}#r${idx}`
   * anchors) the table view can render.
   *
   * The field plan tells us how to pull each field out of a parsed row:
   *   - CSV  rows are positional arrays → read `row[f.csvIdx]`
   *   - JSON rows are objects           → read `row[f.jsonKey]`
   *
   * Source blobs are immutable, so we cache parsed results in-memory for
   * the page lifetime keyed by import anchor.
   *
   * Return contract: an array (possibly empty) means the source was read
   * and parsed successfully — that result is cached. `null` means we could
   * NOT materialize yet: the import entity's `file` ref hasn't folded in
   * (it arrives as a separate DEF after the INS that carries the field
   * plan), the media mirror is still syncing after a refresh, or the bytes
   * couldn't be parsed. Callers should treat `null` as "retry later" and
   * must not cache it — otherwise a transient miss right after a reload
   * would hide the imported rows forever.
   */
  const importRowCache = new Map();

  /* Minimal JSON dataset parser, mirroring src/dataset.js parseJsonDataset:
   * array of objects → rows; array of primitives → { value }; object whose
   * first array-of-objects property → those rows; otherwise the doc itself
   * is one row. */
  function parseJsonRows(text) {
    const data = JSON.parse(text);
    const isRowObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (Array.isArray(data)) {
      if (data.length === 0) return [];
      if (isRowObj(data[0])) return data;
      return data.map(v => ({ value: v }));
    }
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (Array.isArray(v) && v.length > 0 && isRowObj(v[0])) return v;
      }
      return [data];
    }
    return [{ value: data }];
  }

  /* Coerce a JSON value: objects/arrays/numbers/booleans pass through as-is;
   * strings fall back to the CSV-style string coercion. */
  function coerceJsonValue(value, type) {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'object') return value;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    return coerce(value, type);
  }

  async function materializeImportRows(importEntity) {
    if (!importEntity || !importEntity._anchor) return null;
    const cached = importRowCache.get(importEntity._anchor);
    if (cached) return cached;

    const ML = window.MatrixLive;
    const ref = importEntity.file;
    const fieldPlan = importEntity.field_plan;
    const setName = importEntity.derived_set;
    // `file` is DEF'd onto the entity after the INS that carries the field
    // plan, so right after a refresh the ref may not have folded in yet.
    // Returning null (not []) keeps the import retryable until it does.
    if (!ML?.readMedia || !ref || !Array.isArray(fieldPlan) || !setName) return null;

    let bytes;
    try { bytes = await ML.readMedia(ref); }
    catch (e) { console.warn('[csv-import] could not read source blob:', e); return null; }
    if (!bytes) return null;

    let text;
    if (typeof bytes === 'string')         text = bytes;
    else if (bytes instanceof Blob)        text = await bytes.text();
    else if (bytes instanceof Uint8Array)  text = new TextDecoder().decode(bytes);
    else if (bytes instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(bytes));
    else                                   return null;

    const isJson = importEntity.shape === 'json';

    let dataRows;
    if (isJson) {
      try { dataRows = parseJsonRows(text); }
      catch (e) { console.warn('[csv-import] json parse failed:', e); return null; }
    } else {
      let parsed;
      try { parsed = parseCSV(text); }
      catch (e) { console.warn('[csv-import] parse failed:', e); return null; }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        importRowCache.set(importEntity._anchor, []);
        return [];
      }
      const hasHeader = importEntity.has_header !== false;
      dataRows = hasHeader ? parsed.slice(1) : parsed;
    }
    if (!Array.isArray(dataRows) || dataRows.length === 0) {
      importRowCache.set(importEntity._anchor, []);
      return [];
    }

    const rows = dataRows.map((raw, i) => {
      const out = {
        _anchor: `${importEntity._anchor}#r${i}`,
        _type: setName,
        _created: importEntity._created,
        _sender: importEntity._sender,
        _eventId: importEntity._eventId,
        _hwm: 2,
        _materialized: importEntity._anchor,
      };
      for (const f of fieldPlan) {
        const v = isJson
          ? coerceJsonValue(raw?.[f.jsonKey], f.type)
          : coerce(raw[f.csvIdx], f.type);
        if (v !== undefined && v !== null && v !== '') out[f.name] = v;
      }
      return out;
    });

    importRowCache.set(importEntity._anchor, rows);
    return rows;
  }

  // Find import entities whose derived set matches `entityType`.
  function importsForSet(state, entityType) {
    if (!state?.entities || !entityType) return [];
    return Object.values(state.entities).filter(
      e => e?._type === 'import' && e.derived_set === entityType && Array.isArray(e.field_plan)
    );
  }

  window.CsvImportModal = CsvImportModal;
  window.CsvImport = {
    parseCSV, inferType, coerce, FIELD_TYPES,
    materializeImportRows, importsForSet,
  };
})();
