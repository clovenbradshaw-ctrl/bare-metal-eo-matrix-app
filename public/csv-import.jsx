/* csv-import.jsx
 *
 * Airtable-style CSV importer.
 *
 *   1. user picks a .csv file (or drops one)
 *   2. parse client-side (RFC 4180-ish, handles quotes + escapes + \r\n)
 *   3. one screen: destination (new set / existing set) + field mapping + preview
 *   4. on commit, emit:
 *        - DEF _schema.tables           (only if creating a new set)
 *        - DEF _schema.fields.<set>     (only when fields change)
 *        - INS per row, with the FULL row payload  ←  N events for N rows
 *      The engine spreads INS.payload into the entity at fold time
 *      (engine.js line 96), so packing the whole row into one INS is
 *      exactly equivalent to one INS + many DEFs, just ~12× cheaper.
 *
 *   5. in parallel, ship the original blob to the media store via
 *      ML.importFile so the source CSV is recoverable.
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
    const [phase, setPhase]   = useState('parsing');   // parsing | ready | importing | done | error
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

    const [importProgress, setImportProgress] = useState(0);
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

      try {
        // 1. Ship the source CSV to the media store + emit the `import` entity
        //    FIRST so the log narrative reads:
        //      INS import → DEF _schema.* → INS rows×N
        if (ML?.importFile && roomId) {
          setPhase('uploading');
          try {
            await ML.importFile(roomId, file);
          } catch (e) {
            // Non-fatal: we can still import the rows even if the blob
            // upload fails. Surface a soft warning in dev console.
            console.warn('[csv-import] source blob upload failed:', e);
          }
        }

        setPhase('importing');
        setImportProgress(0);
        setImportTotal(dataRows.length);

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

        // 2. declare table if new
        if (dest === 'new') {
          onEmit(ME.OP.DEF, {
            anchor: null,
            path: '_schema.tables',
            value: existingSets.includes(setName) ? existingSets : [...existingSets, setName],
          });
        }
        // 3. declare/extend fields if changed
        const fieldsChanged = JSON.stringify(finalFields) !== JSON.stringify(existingFieldsArr);
        if (fieldsChanged) {
          onEmit(ME.OP.DEF, { anchor: null, path: `_schema.fields.${setName}`, value: finalFields });
        }

        // 4. one INS per row, full payload, in batches with a microtask yield
        //    so the UI can paint the progress bar.
        const me = ML?.getCurrentMxid?.() || '@you:demo';
        const BATCH = 100;
        const totalRows = dataRows.length;
        let i = 0;
        const baseTs = Date.now();
        while (i < totalRows) {
          const end = Math.min(i + BATCH, totalRows);
          for (let r = i; r < end; r++) {
            const row = dataRows[r];
            const payload = {};
            for (const t of columnTargets) {
              if (!t) continue;
              const raw = row[t.csvIdx];
              const v = coerce(raw, t.type);
              if (v !== undefined) payload[t.name] = v;
            }
            const ts = baseTs + r;
            const anchor = ME.makeAnchor(setName, payload, me, ts);
            onEmit(ME.OP.INS, { anchor, entity_type: setName, payload });
          }
          i = end;
          setImportProgress(i);
          // yield to the event loop so progress paints
          await new Promise(res => setTimeout(res, 0));
        }

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
        if (e.key === 'Escape' && phase !== 'importing' && phase !== 'uploading') onClose?.();
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [phase, onClose]);

    /* render */
    return (
      <div className="csv-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && phase !== 'importing' && phase !== 'uploading') onClose?.(); }}>
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
            <button className="csv-close" onClick={() => phase !== 'importing' && phase !== 'uploading' && onClose?.()} title="close" disabled={phase === 'importing' || phase === 'uploading'}>×</button>
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
                <div className="csv-state-sub">emitted {importTotal.toLocaleString()} INS event{importTotal === 1 ? '' : 's'} + schema declarations</div>
              </div>
            )}
            {phase === 'importing' && (
              <div className="csv-state-block">
                <div className="csv-state-glyph">●</div>
                <div><b>importing rows…</b> {importProgress.toLocaleString()} / {importTotal.toLocaleString()}</div>
                <div className="csv-progress"><div className="csv-progress-fill" style={{ width: `${(importProgress / Math.max(1, importTotal)) * 100}%` }} /></div>
                <div className="csv-state-sub">one INS per row · {importTotal.toLocaleString()} events · don't close the tab</div>
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
                      · will emit <b>{(dataRows.length + (dest === 'new' ? 2 : 1)).toLocaleString()}</b> events
                      <span className="csv-foot-evt-detail"> ({dataRows.length.toLocaleString()} INS + schema)</span>
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="csv-foot-actions">
              <button className="csv-cancel" onClick={onClose} disabled={phase === 'importing' || phase === 'uploading'}>cancel</button>
              <button
                className="csv-import"
                onClick={doImport}
                disabled={!canImport}
              >
                {phase === 'uploading' ? 'uploading…'
                 : phase === 'importing' ? 'importing…'
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

  window.CsvImportModal = CsvImportModal;
  window.CsvImport = { parseCSV, inferType, coerce, FIELD_TYPES };
})();
