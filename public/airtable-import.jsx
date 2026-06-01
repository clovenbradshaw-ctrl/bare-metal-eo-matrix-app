/* airtable-import.jsx
 *
 * Paste (or drop) an Airtable schema JSON and create the matching tables in
 * this workspace — including computed fields (formula / rollup / lookup /
 * count). NO data is imported here: this lays down `_schema.tables`,
 * `_schema.fields.<table>` and `_schema.links` only. You then import real rows
 * into a table with the existing CSV/JSON importer, and formula.js derives
 * every computed value at render time. Airtable's pre-computed cell values are
 * never carried across — only the expressions are.
 *
 * Get the JSON from the Airtable Metadata API:
 *   GET https://api.airtable.com/v0/meta/bases/{baseId}/tables
 * (or paste a single table object / an array of tables). The request needs a
 * personal-access token with schema scope — but that stays in YOUR terminal /
 * Airtable session; this app never sees a key. Consistent with the rest of the
 * repo: no backend, no credentials here.
 *
 * Mounting (app.jsx owns the trigger state):
 *   <window.AirtableSchemaModal schemaImport={…} state={…} onEmit={…} onClose={…} />
 */

(function () {
  const { useState, useMemo, useEffect, useRef } = React;

  const TYPE_GLYPH = {
    formula: 'ƒ', rollup: 'ƒ', linked: '↔',
    select: '◉', multiselect: '◎', boolean: '☑',
    number: '#', date: '🗓', text: 'T', longtext: '¶',
    email: '@', url: '↗', json: '{}',
  };

  function isComputed(type) { return type === 'formula' || type === 'rollup'; }

  // Strip preview-only keys; emit exactly what buildTable + formula.js read.
  function cleanField(f) {
    const out = { name: f.name, type: f.type };
    if (Array.isArray(f.options)) out.options = f.options;
    if (typeof f.formula === 'string') out.formula = f.formula;
    if (f.rollup) out.rollup = f.rollup;
    return out;
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

  function AirtableSchemaModal({ schemaImport, state, onEmit, onClose }) {
    if (!schemaImport) return null;
    return <Inner key={schemaImport.id || 'at'} state={state} onEmit={onEmit} onClose={onClose} />;
  }

  function Inner({ state, onEmit, onClose }) {
    const [text, setText] = useState('');
    const [phase, setPhase] = useState('input');      // input | done
    const [include, setInclude] = useState({});         // table name → bool
    const [created, setCreated] = useState(0);
    const fileRef = useRef(null);

    const existingTables = useMemo(() => new Set(state?.schema?.tables || []), [state]);

    // Live parse — cheap enough to run on every keystroke.
    const parsed = useMemo(() => {
      if (!text.trim()) return null;
      return window.AirtableSchema ? window.AirtableSchema.parse(text) : { ok: false, error: 'airtable-schema.js not loaded' };
    }, [text]);

    // Default every NON-colliding table to "include"; colliding ones off
    // (re-importing them would replace an existing field schema).
    useEffect(() => {
      if (!parsed || !parsed.ok) return;
      setInclude(prev => {
        const next = { ...prev };
        for (const t of parsed.tables) {
          if (!(t.name in next)) next[t.name] = !existingTables.has(t.name);
        }
        return next;
      });
    }, [parsed, existingTables]);

    const includedTables = useMemo(
      () => (parsed?.ok ? parsed.tables.filter(t => include[t.name]) : []),
      [parsed, include]
    );
    const includedNames = useMemo(() => new Set(includedTables.map(t => t.name)), [includedTables]);

    async function loadFile(file) {
      if (!file) return;
      try { setText(await file.text()); }
      catch { /* ignore */ }
      if (fileRef.current) fileRef.current.value = '';
    }

    function commit() {
      const ME = window.MatrixEngine;
      if (!ME || !includedTables.length) return;

      // 1. register the table names
      const existing = state?.schema?.tables || [];
      const merged = Array.from(new Set([...existing, ...includedTables.map(t => t.name)]));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        onEmit(ME.OP.DEF, { anchor: null, path: '_schema.tables', value: merged });
      }
      // 2. the field schema for each table (this is where the computed-field
      //    DEFINITIONS land — values are derived later, at render time)
      for (const t of includedTables) {
        onEmit(ME.OP.DEF, { anchor: null, path: `_schema.fields.${t.name}`, value: t.fields.map(cleanField) });
      }
      // 3. record-link relations, but only between tables we actually created
      const links = (parsed.links || []).filter(l => includedNames.has(l.from) && includedNames.has(l.to));
      if (links.length) {
        const existingLinks = Array.isArray(state?.schema?.links) ? state.schema.links.slice() : [];
        for (const l of links) {
          if (!existingLinks.some(e => e.from === l.from && e.to === l.to && e.rel === l.rel)) existingLinks.push(l);
        }
        onEmit(ME.OP.DEF, { anchor: null, path: '_schema.links', value: existingLinks });
      }

      setCreated(includedTables.length);
      setPhase('done');
      setTimeout(() => onClose?.(), 900);
    }

    useEffect(() => {
      function onKey(e) { if (e.key === 'Escape') onClose?.(); }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const totalComputed = includedTables.reduce((n, t) => n + t.counts.computed, 0);
    const totalFields = includedTables.reduce((n, t) => n + t.counts.total, 0);

    return (
      <div className="csv-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }}>
        <div className="csv-modal">
          <div className="csv-head">
            <div>
              <div className="csv-eyebrow">import airtable schema</div>
              <div className="csv-filename">create tables · no data</div>
              <div className="csv-fileinfo">
                computed fields (formula · rollup · lookup) become definitions — values derive at render time after you import rows
              </div>
            </div>
            <button className="csv-close" onClick={() => onClose?.()} title="close">×</button>
          </div>

          <div className="csv-body">
            {phase === 'done' && (
              <div className="csv-state-block csv-state-done">
                <div className="csv-state-glyph">✓</div>
                <div><b>created {created} table{created === 1 ? '' : 's'}</b></div>
                <div className="csv-state-sub">now import a CSV/JSON into each — computed fields compute themselves</div>
              </div>
            )}

            {phase === 'input' && (
              <>
                <div className="csv-section">
                  <div className="csv-section-head">
                    <span className="csv-section-label">airtable schema json</span>
                    <button className="csv-map-skip" onClick={() => fileRef.current?.click()}>load .json file</button>
                    <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                      onChange={e => loadFile(e.target.files?.[0])} />
                  </div>
                  <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    spellCheck={false}
                    placeholder={'paste GET /v0/meta/bases/{baseId}/tables  →  { "tables": [ … ] }'}
                    style={{
                      width: '100%', minHeight: '120px', resize: 'vertical', boxSizing: 'border-box',
                      fontFamily: 'var(--mono)', fontSize: '12px', padding: '10px',
                      background: 'var(--bg-elev, #fff)', color: 'var(--text-bright)',
                      border: '1px solid var(--border, #ddd)', borderRadius: 0,
                    }}
                  />
                  {parsed && !parsed.ok && (
                    <div className="csv-state-sub" style={{ color: 'var(--danger, #c33)', marginTop: 6 }}>⚠ {parsed.error}</div>
                  )}
                </div>

                {parsed && parsed.ok && (
                  <>
                    <div className="csv-section">
                      <div className="csv-section-head">
                        <span className="csv-section-label">
                          {parsed.tables.length} table{parsed.tables.length === 1 ? '' : 's'} · select what to create
                        </span>
                      </div>
                      {parsed.tables.map(t => {
                        const collides = existingTables.has(t.name);
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
                              {collides && <span className="csv-warn" style={{ marginLeft: 'auto' }}>exists — will replace its schema</span>}
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
                  </>
                )}
              </>
            )}
          </div>

          <div className="csv-foot">
            <div className="csv-foot-note">
              {phase === 'input' && includedTables.length > 0 && (
                <span className="csv-foot-evt">
                  will emit schema for <b>{includedTables.length}</b> table{includedTables.length === 1 ? '' : 's'}
                  <span className="csv-foot-evt-detail"> · {totalFields} fields ({totalComputed} computed) · 0 rows</span>
                </span>
              )}
            </div>
            <div className="csv-foot-actions">
              <button className="csv-cancel" onClick={onClose}>cancel</button>
              <button className="csv-import" onClick={commit} disabled={phase !== 'input' || includedTables.length === 0}>
                {phase === 'done' ? 'done'
                  : includedTables.length === 0 ? 'select a table'
                    : `create ${includedTables.length} table${includedTables.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.AirtableSchemaModal = AirtableSchemaModal;
})();
