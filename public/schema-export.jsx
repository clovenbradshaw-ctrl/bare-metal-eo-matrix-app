/* schema-export.jsx — modal that previews and exports the current
 * workspace's schema in JSON, SQL, or Markdown.
 *
 * Sidebar opens it through `onExportSchema` (passed down from app.jsx); the
 * heavy lifting is done by schema-export.js, which converts the fold state
 * into the three formats. Copy puts the active tab's text on the clipboard;
 * Download saves it as a file. Nothing is emitted into the room — exporting
 * a schema does not change it.
 */

(function () {
  const { useState, useMemo, useEffect, useRef } = React;

  const FORMATS = [
    { key: 'sql',      label: 'SQL DDL',  ext: 'sql', mime: 'application/sql' },
    { key: 'json',     label: 'JSON',     ext: 'json', mime: 'application/json' },
    { key: 'markdown', label: 'Markdown', ext: 'md',   mime: 'text/markdown' },
  ];

  function safeFilename(name) {
    return String(name || 'workspace').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'workspace';
  }

  function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 0);
  }

  function SchemaExportModal({ room, state, onClose }) {
    const [format, setFormat] = useState('sql');
    const [copied, setCopied] = useState(false);
    const wrapRef = useRef(null);
    const SE = window.SchemaExport;

    // Pre-render all three so tab switches are instant and the model is in
    // hand for the per-tab summary. Memoized on state to skip work between
    // unrelated re-renders (the sidebar re-renders on every fold tick).
    const rendered = useMemo(() => {
      if (!SE) return { sql: '', json: '', markdown: '', model: { tables: [], links: [] } };
      const stateWithName = room && room.title ? { ...state, workspace: room.title } : state;
      return {
        sql: SE.toSQL(stateWithName),
        json: SE.toJSON(stateWithName),
        markdown: SE.toMarkdown(stateWithName),
        model: SE.buildModel(stateWithName),
      };
    }, [state, room && room.title]);

    useEffect(() => {
      function onKey(e) { if (e.key === 'Escape') onClose(); }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const active = FORMATS.find(f => f.key === format) || FORMATS[0];
    const text = rendered[format] || '';
    const workspaceName = safeFilename(room && room.title ? room.title : 'workspace');
    const filename = `${workspaceName}.schema.${active.ext}`;

    async function onCopy() {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (e) {
        // Fallback for browsers without async clipboard: select the <pre>
        // and rely on the user to copy. Surfacing the error in the UI is
        // overkill for a non-destructive action.
        const node = wrapRef.current?.querySelector('pre');
        if (node) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }

    function onDownload() {
      downloadText(text, filename, active.mime);
    }

    const { tables, links } = rendered.model;
    const tableCount = tables.length;
    const linkCount = links.length;
    const declaredCount = tables.filter(t => t.declared).length;

    return (
      <div className="proj-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          ref={wrapRef}
          className="proj-modal schema-export-modal"
          onMouseDown={e => e.stopPropagation()}
          style={{ width: 'min(820px, calc(100vw - 40px))' }}
        >
          <header className="proj-modal-head">
            <div className="proj-modal-eyebrow">export schema</div>
            <div className="proj-modal-title">
              <span className="proj-modal-set">{room && room.title ? room.title : 'workspace'}</span>
              <span className="proj-modal-dim">
                {' · '}{tableCount} table{tableCount === 1 ? '' : 's'}
                {declaredCount < tableCount ? ` (${tableCount - declaredCount} unschematized)` : ''}
                {linkCount ? ` · ${linkCount} link rule${linkCount === 1 ? '' : 's'}` : ''}
              </span>
            </div>
          </header>

          <div className="proj-modal-body" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <div className="se-tabs" role="tablist" aria-label="export format">
              {FORMATS.map(f => (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={format === f.key}
                  className={`se-tab${format === f.key ? ' on' : ''}`}
                  onClick={() => setFormat(f.key)}
                >{f.label}</button>
              ))}
              <span style={{ flex: 1 }} />
              <button
                className="se-action"
                onClick={onCopy}
                title="copy to clipboard"
              >{copied ? 'copied' : 'copy'}</button>
              <button
                className="se-action primary"
                onClick={onDownload}
                title={`download as ${filename}`}
              >download</button>
            </div>

            {tableCount === 0 ? (
              <div className="se-empty">
                <div className="glyph">⊢</div>
                <div>this workspace has no declared or observed tables yet.</div>
                <div className="se-empty-hint">
                  create a set first — the export will include every <code>_schema.*</code> DEF in the log.
                </div>
              </div>
            ) : (
              <pre className="se-preview">{text}</pre>
            )}

            <div className="se-foot">
              <span>schema lives in the log as <code>DEF _schema.*</code> events — this export is a read-only render.</span>
            </div>
          </div>

          <footer className="proj-modal-foot">
            <button className="proj-modal-cancel" onClick={onClose}>close</button>
          </footer>
        </div>
      </div>
    );
  }

  window.SchemaExportModal = SchemaExportModal;
})();
