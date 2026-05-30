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

function fmtCell(value, type, opts) {
  if (value === undefined || value === null || value === '') return { cls: 'null', text: 'NULL' };
  if (type === 'number') return { cls: 'num', text: String(value) };
  if (type === 'boolean') return { cls: 'str', text: value ? '✓' : '✗' };
  if (type === 'date') {
    const f = formatDateCell(value, opts || {});
    return { cls: `date ${f.tone}`, text: f.text, title: f.title };
  }
  if (type === 'duration') {
    return { cls: 'num', text: formatDuration(value) };
  }
  if (type === 'multiselect' && Array.isArray(value)) {
    return { cls: 'str', text: value.join(', ') };
  }
  if (type === 'json' && typeof value === 'object') return { cls: 'json', text: JSON.stringify(value) };
  return { cls: 'str', text: String(value) };
}

// ─────────────────────────────────────────────────────────────────────────
// Date utilities — smart parse + friendly display + tone (past/today/future).
// ─────────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
const WEEKDAYS = ['sun','mon','tue','wed','thu','fri','sat'];
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function smartParseDate(input, opts = {}) {
  if (input === undefined || input === null) return null;
  if (input instanceof Date) return input.toISOString();
  const raw = String(input).trim();
  if (!raw) return null;

  // ISO/RFC3339 first — fast path
  const isoTry = new Date(raw);
  if (!isNaN(isoTry.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return opts.includeTime ? isoTry.toISOString() : raw.slice(0, 10);
  }

  const now = new Date();
  const today = startOfDay(now);
  const low = raw.toLowerCase();

  // Aliases
  if (low === 'today' || low === 'now') return opts.includeTime ? now.toISOString() : isoDate(today);
  if (low === 'tomorrow' || low === 'tmrw') return isoDate(addDays(today, 1));
  if (low === 'yesterday') return isoDate(addDays(today, -1));

  // "in N days/weeks/months" / "N days ago"
  const inMatch = low.match(/^(?:in\s+)?(-?\d+)\s*(d|day|days|w|wk|week|weeks|h|hr|hour|hours|m|min|minute|minutes|mo|mon|month|months|y|yr|year|years)(?:\s+ago)?$/);
  if (inMatch) {
    let n = parseInt(inMatch[1], 10);
    if (low.endsWith(' ago')) n = -n;
    const unit = inMatch[2];
    let d = new Date(now);
    if (/^(d|day|days)$/.test(unit))    d = addDays(d, n);
    else if (/^(w|wk|week|weeks)$/.test(unit)) d = addDays(d, n * 7);
    else if (/^(h|hr|hour|hours)$/.test(unit)) d.setHours(d.getHours() + n);
    else if (/^(m|min|minute|minutes)$/.test(unit)) d.setMinutes(d.getMinutes() + n);
    else if (/^(mo|mon|month|months)$/.test(unit)) d.setMonth(d.getMonth() + n);
    else if (/^(y|yr|year|years)$/.test(unit)) d.setFullYear(d.getFullYear() + n);
    return opts.includeTime ? d.toISOString() : isoDate(d);
  }

  // "next mon" / "this fri" / "last tue"
  const dowMatch = low.match(/^(next|this|last)\s+(\w+)$/);
  if (dowMatch) {
    const dir = dowMatch[1];
    const dowName = dowMatch[2].slice(0, 3);
    const dowIdx = WEEKDAYS.indexOf(dowName);
    if (dowIdx >= 0) {
      let d = new Date(today);
      const cur = d.getDay();
      let delta = dowIdx - cur;
      if (dir === 'next' && delta <= 0) delta += 7;
      if (dir === 'last' && delta >= 0) delta -= 7;
      d = addDays(d, delta);
      return isoDate(d);
    }
  }

  // bare weekday like "monday"
  const bareDow = WEEKDAYS.indexOf(low.slice(0, 3));
  if (bareDow >= 0) {
    let delta = bareDow - today.getDay();
    if (delta < 0) delta += 7;
    return isoDate(addDays(today, delta));
  }

  // "Aug 5" / "Aug 5 2026" / "5 Aug"
  const monMatch = low.match(/^([a-z]{3,})\s+(\d{1,2})(?:[,\s]+(\d{4}))?$/) || low.match(/^(\d{1,2})\s+([a-z]{3,})(?:[,\s]+(\d{4}))?$/);
  if (monMatch) {
    let monStr, day, year;
    if (isNaN(parseInt(monMatch[1], 10))) {
      monStr = monMatch[1].slice(0, 3); day = parseInt(monMatch[2], 10); year = monMatch[3] ? parseInt(monMatch[3], 10) : now.getFullYear();
    } else {
      day = parseInt(monMatch[1], 10); monStr = monMatch[2].slice(0, 3); year = monMatch[3] ? parseInt(monMatch[3], 10) : now.getFullYear();
    }
    const month = MONTHS.indexOf(monStr);
    if (month >= 0) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) return isoDate(d);
    }
  }

  // Slash dates: 5/12 or 5/12/2026 — month-first by default
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10) - 1;
    const day = parseInt(slashMatch[2], 10);
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return isoDate(d);
  }

  // last-ditch Date.parse
  const fallback = Date.parse(raw);
  if (!isNaN(fallback)) {
    const d = new Date(fallback);
    return opts.includeTime ? d.toISOString() : isoDate(d);
  }
  return null;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n)  { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Friendly display: "Today" / "Yesterday" / "in 3d" / "May 28" with absolute on hover.
function formatDateCell(value, opts = {}) {
  if (value === undefined || value === null || value === '') return { text: '', title: '', tone: '' };
  const d = new Date(value);
  if (isNaN(d.getTime())) return { text: '#date', title: String(value), tone: 'date-invalid' };

  const now = new Date();
  const startToday = startOfDay(now);
  const dDay = startOfDay(d);
  const diffDays = Math.round((dDay.getTime() - startToday.getTime()) / DAY_MS);

  const fmt = opts.dateFormat || 'friendly';
  const includeTime = opts.includeTime;
  const sameYear = d.getFullYear() === now.getFullYear();
  const absLabel = d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: includeTime ? '2-digit' : undefined,
    minute: includeTime ? '2-digit' : undefined,
  });
  const isoLabel = d.toISOString();

  let text;
  if (fmt === 'iso') text = isoLabel;
  else if (fmt === 'relative') text = relativeLabel(diffDays);
  else { // friendly
    if (diffDays === 0) text = includeTime ? `today, ${d.toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit'})}` : 'today';
    else if (diffDays === -1) text = 'yesterday';
    else if (diffDays === 1)  text = 'tomorrow';
    else if (diffDays >= -7 && diffDays < 0) text = `${-diffDays}d ago`;
    else if (diffDays > 1 && diffDays <= 7) text = `in ${diffDays}d`;
    else text = absLabel;
  }

  // tone — for conditional formatting
  let tone = '';
  if (diffDays < 0) tone = 'date-past';
  else if (diffDays === 0) tone = 'date-today';
  else if (diffDays <= 7) tone = 'date-soon';
  else tone = 'date-future';

  return { text, title: `${absLabel}  ·  ${isoLabel}`, tone };
}
function relativeLabel(diffDays) {
  if (diffDays === 0) return 'today';
  if (diffDays === -1) return 'yesterday';
  if (diffDays === 1)  return 'tomorrow';
  if (diffDays < 0) return `${-diffDays}d ago`;
  return `in ${diffDays}d`;
}

// Duration field — stored as seconds. Display as "2h 30m" / "1d 4h" / "45m".
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s === 0) return '0';
  const d = Math.floor(s / 86400); const r1 = s % 86400;
  const h = Math.floor(r1 / 3600); const r2 = r1 % 3600;
  const m = Math.floor(r2 / 60);   const sec = r2 % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (!d && !h && sec) parts.push(sec + 's');
  return parts.length ? parts.join(' ') : '0';
}
function parseDuration(input) {
  const raw = String(input).trim();
  if (!raw) return 0;
  // Plain number → minutes
  if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw) * 60;
  let total = 0;
  raw.replace(/(\d+(?:\.\d+)?)\s*(d|h|m|s|day|hour|min|sec)/gi, (_, n, unit) => {
    const x = parseFloat(n);
    const u = unit[0].toLowerCase();
    if (u === 'd') total += x * 86400;
    else if (u === 'h') total += x * 3600;
    else if (u === 'm') total += x * 60;
    else if (u === 's') total += x;
    return '';
  });
  return total;
}

// ─────────────────────────────────────────────────────────────────────────
// Formula + rollup evaluation is delegated to window.Formula (formula.js).
// Computed values are derived at render time from the current fold state —
// nothing here writes to the log. The expression / rollup config lives in
// _schema.fields.<set>.{formula | rollup} and is authored by room members.
// ─────────────────────────────────────────────────────────────────────────

function FormulaCell({ formula, record, state }) {
  const r = (window.Formula && window.Formula.evaluate)
    ? window.Formula.evaluate(formula, { record, state })
    : { ok: false, value: null, error: 'formula.js not loaded' };
  if (!r.ok) {
    return (
      <td className="cell formula has-error" title={`formula error · ${r.error}\n= ${formula || ''}`}>
        <span className="em">#ERR</span>
      </td>
    );
  }
  const { cls, text } = fmtCell(r.value, typeof r.value === 'number' ? 'number' : 'text');
  return (
    <td className={`cell formula ${cls}`} title={formula ? `= ${formula}` : 'formula · set the expression in the schema view'}>
      {text}
    </td>
  );
}

// Rollup cell — aggregates field values from linked records.
//   cfg = { via: '<relation>', field?: '<name>', fn: 'sum'|'count'|'avg'|... }
function RollupCell({ rollup, record, state }) {
  if (!window.Formula?.evaluateRollup) {
    return <td className="cell rollup-cell"><span className="em">rollup unavailable</span></td>;
  }
  const r = window.Formula.evaluateRollup(rollup || {}, { record, state });
  const fn = (rollup?.fn || 'count').toLowerCase();
  const titleParts = [`rollup · ${fn}(`];
  if (rollup?.field) titleParts.push(rollup.field);
  titleParts.push(`) via "${rollup?.via || '?'}"`);
  if (!r.ok) {
    return (
      <td className="cell rollup-cell has-error" title={titleParts.join('') + `\n— ${r.error}`}>
        <span className="em">#ERR</span>
      </td>
    );
  }
  const isCount = fn === 'count';
  const cls = (typeof r.value === 'number' || isCount) ? 'num' : 'str';
  const text = r.value === null || r.value === undefined || r.value === '' ? '—' : String(r.value);
  return (
    <td className={`cell rollup-cell ${cls}`} title={titleParts.join('')}>
      <span className="roll-list">{text}</span>
    </td>
  );
}

function EditableCell({ value, onCommit, type, heat, shouldFocus, onFocusConsumed, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  function draftFromValue(v) {
    return v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  useEffect(() => {
    if (shouldFocus && !editing) {
      setDraft(draftFromValue(value));
      setEditing(true);
      if (onFocusConsumed) onFocusConsumed();
    }
  }, [shouldFocus]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(draftFromValue(value));
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
  function commitAndNavigate(dir) {
    commit();
    if (onNavigate) onNavigate(dir);
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
            if (e.key === 'Enter') { e.preventDefault(); commitAndNavigate('enter'); }
            else if (e.key === 'Tab') { e.preventDefault(); commitAndNavigate(e.shiftKey ? 'shift-tab' : 'tab'); }
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      </td>
    );
  }
  const { cls, text } = fmtCell(value, type);
  const heatCls = heat ? heatClass(heat) : '';
  return <td className={`cell ${cls} ${heatCls}`} onClick={startEdit} title={heat ? `${heat} write${heat===1?'':'s'} · click to edit` : 'click to edit · emits DEF'}>{text}</td>;
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
// Record detail side panel — pops out when a row is expanded.
// Shows every field for one record (editable), plus its links and a jump
// into the entity's full event timeline. Lives in the same DEF/SEG emit
// path as the grid, so edits are identical writes to inline cell edits.
// ─────────────────────────────────────────────────────────────────────────

function DetailField({ value, type, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef(null);

  function draftFromValue(v) {
    return v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  useEffect(() => {
    if (editing && ref.current) { ref.current.focus(); ref.current.select(); }
  }, [editing]);

  function startEdit() { setDraft(draftFromValue(value)); setEditing(true); }
  function commit() {
    setEditing(false);
    let parsed = draft;
    if (type === 'number') { const n = parseFloat(draft); if (!isNaN(n)) parsed = n; }
    else if (type === 'json') { try { parsed = JSON.parse(draft); } catch {} }
    if (parsed !== value) onCommit(parsed);
  }

  if (editing) {
    if (type === 'longtext' || type === 'json') {
      return (
        <textarea
          ref={ref}
          className="rd-input rd-textarea"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      );
    }
    return (
      <input
        ref={ref}
        className="rd-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  const { cls, text } = fmtCell(value, type);
  const empty = value === undefined || value === null || value === '';
  return (
    <div
      className={`rd-value ${cls} ${empty ? 'is-empty' : ''}`}
      onClick={startEdit}
      title="click to edit · emits DEF"
    >{empty ? <span className="rd-empty">empty</span> : text}</div>
  );
}

function RecordDetailPanel({
  record, records, entityType, room, cols, partitioned, linkedTypes, state,
  onClose, onCommitCell, onCommitPartition, onJump, onSelectRecord, onViewTimeline,
}) {
  // Escape closes the panel. Re-registered per record so it stays live.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const idx = records.findIndex(r => r._anchor === record._anchor);
  const prev = idx > 0 ? records[idx - 1] : null;
  const next = idx >= 0 && idx < records.length - 1 ? records[idx + 1] : null;

  // First text-ish field doubles as the record's display title.
  const titleCol = cols.find(c => c.type !== 'formula' && c.type !== 'rollup');
  const titleVal = titleCol ? record[titleCol.name] : undefined;
  const title = (titleVal === undefined || titleVal === null || titleVal === '')
    ? record._anchor : String(titleVal);

  return (
    <div className="record-detail-backdrop" onClick={onClose}>
      <aside className="record-detail-panel" role="dialog" aria-label="record details" onClick={e => e.stopPropagation()}>
        <header className="rd-head">
          <div className="rd-head-top">
            <span className="rd-eyebrow">{room?.title || 'workspace'} · {entityType}</span>
            <div className="rd-head-nav">
              <button className="rd-nav-btn" disabled={!prev} title="previous record" onClick={() => prev && onSelectRecord(prev._anchor)}>‹</button>
              <span className="rd-nav-count">{idx >= 0 ? idx + 1 : '–'} / {records.length}</span>
              <button className="rd-nav-btn" disabled={!next} title="next record" onClick={() => next && onSelectRecord(next._anchor)}>›</button>
              <button className="rd-close" title="close · esc" onClick={onClose}>×</button>
            </div>
          </div>
          <h2 className="rd-title" title={title}>{title}</h2>
          <code className="rd-anchor" title="permanent anchor id">{record._anchor}</code>
        </header>

        <div className="rd-body">
          {partitioned && (
            <div className="rd-field">
              <label className="rd-label">_partition <span className="rd-type">SEG</span></label>
              <DetailField
                value={state.partitions[record._anchor]}
                type="text"
                onCommit={(v) => onCommitPartition(record._anchor, v)}
              />
            </div>
          )}

          {linkedTypes.map(t => {
            const links = linksFromAnchor(record._anchor, t, state);
            return (
              <div className="rd-field" key={`link-${t}`}>
                <label className="rd-label">{t} <span className="rd-type">link</span></label>
                {links.length === 0 ? (
                  <div className="rd-value is-empty"><span className="rd-empty">no links</span></div>
                ) : (
                  <div className="link-pills rd-links">
                    {links.map((l, i) => (
                      <button key={i} className="link-pill" onClick={() => onJump(l.anchor, l.type)} title={`-[${l.rel}]→ ${l.anchor}`}>
                        <span className="lp-rel">{l.dir === 'out' ? '→' : '←'}</span>
                        <span className="lp-name">{l.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {cols.map(c => {
            if (c.type === 'formula') {
              const r = (window.Formula && window.Formula.evaluate)
                ? window.Formula.evaluate(c.formula, { record, state })
                : { ok: false, error: 'formula.js not loaded' };
              const text = r.ok ? fmtCell(r.value, typeof r.value === 'number' ? 'number' : 'text').text : '#ERR';
              return (
                <div className="rd-field" key={c.name}>
                  <label className="rd-label"><span className="rd-fglyph">ƒ</span> {c.name} <span className="rd-type">formula</span></label>
                  <div className="rd-value rd-derived" title={c.formula ? `= ${c.formula}` : 'formula'}>{text}</div>
                </div>
              );
            }
            if (c.type === 'rollup') {
              const r = window.Formula?.evaluateRollup
                ? window.Formula.evaluateRollup(c.rollup || {}, { record, state })
                : { ok: false };
              const text = r.ok ? (r.value === null || r.value === undefined || r.value === '' ? '—' : String(r.value)) : '#ERR';
              return (
                <div className="rd-field" key={c.name}>
                  <label className="rd-label"><span className="rd-fglyph">ƒ</span> {c.name} <span className="rd-type">rollup</span></label>
                  <div className="rd-value rd-derived">{text}</div>
                </div>
              );
            }
            return (
              <div className="rd-field" key={c.name}>
                <label className="rd-label">{c.name} <span className="rd-type">{c.type}</span></label>
                <DetailField
                  value={record[c.name]}
                  type={c.type}
                  onCommit={(v) => onCommitCell(record._anchor, c.name, v)}
                />
              </div>
            );
          })}

          {cols.length === 0 && (
            <div className="rd-empty-state">no fields yet · add a field from the grid header</div>
          )}
        </div>

        <footer className="rd-foot">
          <button className="rd-timeline-btn" onClick={() => onViewTimeline(record._anchor)} title="replay every event that produced this record">
            ⏚ view full timeline
          </button>
        </footer>
      </aside>
    </div>
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
    cols = schemaFields.map(f => ({ name: f.name, type: f.type, options: f.options, formula: f.formula, rollup: f.rollup, schematized: true }));
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
        out.push({ anchor: c.target, label: tgt.Name || tgt.title || tgt.body || tgt.claim || tgt.what || c.target.slice(-8), rel: c.type, type: otherType, dir: 'out' });
      }
    } else if (c.target === anchor) {
      const src = state.entities[c.source];
      if (src && src._type === otherType) {
        out.push({ anchor: c.source, label: src.Name || src.title || src.body || src.claim || src.what || c.source.slice(-8), rel: c.type, type: otherType, dir: 'in' });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// View controls — sort / filter / hide columns. These are projection-local:
// they reshape what THIS grid shows without writing anything to the log.
// (Schema and data edits emit events; rearranging your own view does not.)
// ─────────────────────────────────────────────────────────────────────────

// Collapse the field-type zoo down to the handful of comparison behaviours the
// sort/filter engine actually cares about.
function filterKind(type) {
  if (type === 'number' || type === 'duration') return 'number';
  if (type === 'date') return 'date';
  if (type === 'boolean') return 'boolean';
  if (type === 'select') return 'select';
  if (type === 'multiselect') return 'multiselect';
  return 'text'; // text, longtext, url, email, json, formula, rollup, …
}

const FILTER_OPS = {
  text:        ['contains', 'ncontains', 'eq', 'neq', 'empty', 'notempty'],
  number:      ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'],
  date:        ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'],
  boolean:     ['true', 'false', 'empty', 'notempty'],
  select:      ['eq', 'neq', 'empty', 'notempty'],
  multiselect: ['contains', 'ncontains', 'empty', 'notempty'],
};
const OP_LABELS = {
  contains: 'contains', ncontains: "doesn't contain",
  eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤',
  empty: 'is empty', notempty: 'is not empty',
  true: 'is checked', false: 'is unchecked',
};
// Operators that compare against nothing — no value box.
const VALUELESS_OPS = new Set(['empty', 'notempty', 'true', 'false']);

function isBlank(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

// Coerce a cell value into a comparable number for ordered operators / numeric
// sorts; returns null when the side isn't comparable in that kind.
function asComparable(v, kind) {
  if (kind === 'number') {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isNaN(n) ? null : n;
  }
  if (kind === 'date') {
    const t = v instanceof Date ? v.getTime() : Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

function matchFilter(value, f, type) {
  const kind = filterKind(type);
  const op = f.op;
  if (op === 'empty')    return isBlank(value);
  if (op === 'notempty') return !isBlank(value);
  if (op === 'true')     return !!value && value !== 'false';
  if (op === 'false')    return !value || value === 'false';

  const target = (f.value == null ? '' : String(f.value)).trim();
  // A half-typed filter (operator chosen, no value yet) must not hide every row.
  if (target === '') return true;

  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    const a = asComparable(value, kind);
    const b = kind === 'date' ? Date.parse(target) : parseFloat(target);
    if (a === null || isNaN(b)) return false;
    if (op === 'gt')  return a >  b;
    if (op === 'gte') return a >= b;
    if (op === 'lt')  return a <  b;
    return a <= b;
  }

  if (kind === 'number' && (op === 'eq' || op === 'neq')) {
    const a = asComparable(value, 'number');
    const b = parseFloat(target);
    const eq = a !== null && !isNaN(b) && a === b;
    return op === 'eq' ? eq : !eq;
  }

  // string-ish comparisons (case-insensitive); arrays (multiselect) flatten
  const hay = Array.isArray(value) ? value.join(', ') : (value == null ? '' : String(value));
  const h = hay.toLowerCase();
  const t = target.toLowerCase();
  if (op === 'contains')  return h.includes(t);
  if (op === 'ncontains') return !h.includes(t);
  if (op === 'eq')        return h === t;
  if (op === 'neq')       return h !== t;
  return true;
}

function compareValues(a, b, type) {
  const kind = filterKind(type);
  const aBlank = isBlank(a), bBlank = isBlank(b);
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;   // blanks sort last
  if (bBlank) return -1;
  if (kind === 'number' || kind === 'date') {
    const na = asComparable(a, kind), nb = asComparable(b, kind);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  }
  const sa = Array.isArray(a) ? a.join(', ') : String(a);
  const sb = Array.isArray(b) ? b.join(', ') : String(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

// Resolve the displayed value of a cell — including computed formula/rollup
// fields — so sort & filter operate on what the user actually sees.
function cellValue(record, col, state) {
  if (!col) return undefined;
  if (col.type === 'formula') {
    const r = window.Formula?.evaluate ? window.Formula.evaluate(col.formula, { record, state }) : null;
    return r && r.ok ? r.value : undefined;
  }
  if (col.type === 'rollup') {
    const r = window.Formula?.evaluateRollup ? window.Formula.evaluateRollup(col.rollup || {}, { record, state }) : null;
    return r && r.ok ? r.value : undefined;
  }
  return record[col.name];
}

// ── Toolbar dropdown panels ────────────────────────────────────────────────

function FilterPanel({ cols, filters, setFilters }) {
  const fields = cols.filter(c => c.name);
  function addFilter() {
    const first = fields[0];
    if (!first) return;
    const ops = FILTER_OPS[filterKind(first.type)];
    setFilters(fs => [...fs, { id: `${Date.now()}-${Math.random()}`, field: first.name, op: ops[0], value: '' }]);
  }
  function update(id, patch) { setFilters(fs => fs.map(f => f.id === id ? { ...f, ...patch } : f)); }
  function remove(id) { setFilters(fs => fs.filter(f => f.id !== id)); }
  return (
    <div className="tv-pop tv-pop-filter" role="dialog" onClick={e => e.stopPropagation()}>
      <div className="tv-pop-head">filter rows <span className="tv-pop-sub">view-local · emits nothing</span></div>
      {filters.length === 0 && <div className="tv-pop-empty">no filters · all rows shown</div>}
      {filters.map((f, i) => {
        const col = fields.find(c => c.name === f.field) || fields[0];
        const kind = filterKind(col?.type || 'text');
        const ops = FILTER_OPS[kind];
        return (
          <div className="tv-ctrl-row" key={f.id}>
            <span className="tv-conj">{i === 0 ? 'where' : 'and'}</span>
            <select className="tv-sel" value={f.field} onChange={e => {
              const nc = fields.find(c => c.name === e.target.value);
              const nops = FILTER_OPS[filterKind(nc?.type || 'text')];
              update(f.id, { field: e.target.value, op: nops.includes(f.op) ? f.op : nops[0] });
            }}>
              {fields.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <select className="tv-sel" value={f.op} onChange={e => update(f.id, { op: e.target.value })}>
              {ops.map(o => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
            </select>
            {!VALUELESS_OPS.has(f.op) && (
              kind === 'select' && col?.options?.length
                ? <select className="tv-sel tv-val" value={f.value} onChange={e => update(f.id, { value: e.target.value })}>
                    <option value="">…</option>
                    {col.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                : <input
                    className="tv-val-input"
                    value={f.value}
                    placeholder="value"
                    type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
                    onChange={e => update(f.id, { value: e.target.value })}
                  />
            )}
            <button className="tv-row-x" title="remove filter" onClick={() => remove(f.id)}>×</button>
          </div>
        );
      })}
      <button className="tv-add" onClick={addFilter} disabled={fields.length === 0}>+ add filter</button>
    </div>
  );
}

function SortPanel({ cols, sorts, setSorts }) {
  const fields = cols.filter(c => c.name);
  const used = new Set(sorts.map(s => s.field));
  function addSort() {
    const first = fields.find(c => !used.has(c.name)) || fields[0];
    if (!first) return;
    setSorts(ss => [...ss, { field: first.name, dir: 'asc' }]);
  }
  function update(i, patch) { setSorts(ss => ss.map((s, j) => j === i ? { ...s, ...patch } : s)); }
  function remove(i) { setSorts(ss => ss.filter((_, j) => j !== i)); }
  return (
    <div className="tv-pop tv-pop-sort" role="dialog" onClick={e => e.stopPropagation()}>
      <div className="tv-pop-head">sort rows <span className="tv-pop-sub">view-local · emits nothing</span></div>
      {sorts.length === 0 && <div className="tv-pop-empty">no sorts · log order</div>}
      {sorts.map((s, i) => (
        <div className="tv-ctrl-row" key={i}>
          <span className="tv-conj">{i === 0 ? 'by' : 'then'}</span>
          <select className="tv-sel" value={s.field} onChange={e => update(i, { field: e.target.value })}>
            {fields.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <div className="tv-dir">
            <button className={s.dir === 'asc' ? 'on' : ''} onClick={() => update(i, { dir: 'asc' })} title="ascending">↑</button>
            <button className={s.dir === 'desc' ? 'on' : ''} onClick={() => update(i, { dir: 'desc' })} title="descending">↓</button>
          </div>
          <button className="tv-row-x" title="remove sort" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button className="tv-add" onClick={addSort} disabled={fields.length === 0}>+ add sort</button>
    </div>
  );
}

function HidePanel({ items, hidden, setHidden }) {
  function toggle(key) {
    setHidden(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  return (
    <div className="tv-pop tv-pop-hide" role="dialog" onClick={e => e.stopPropagation()}>
      <div className="tv-pop-head">
        hide columns <span className="tv-pop-sub">view-local · emits nothing</span>
      </div>
      <div className="tv-hide-actions">
        <button onClick={() => setHidden(new Set(items.map(it => it.key)))} disabled={items.length === 0}>hide all</button>
        <button onClick={() => setHidden(new Set())}>show all</button>
      </div>
      {items.length === 0 && <div className="tv-pop-empty">no columns</div>}
      {items.map(it => {
        const isHidden = hidden.has(it.key);
        return (
          <button key={it.key} className={`tv-hide-row ${isHidden ? 'is-hidden' : ''}`} onClick={() => toggle(it.key)} title={isHidden ? 'click to show' : 'click to hide'}>
            <i className={`ph ph-${isHidden ? 'eye-slash' : 'eye'}`} aria-hidden="true"></i>
            <span className="tv-hide-name">{it.label}</span>
            <span className="tv-hide-kind">{it.kind}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// One table
// ─────────────────────────────────────────────────────────────────────────

function DbTable({ entityType, state, room, onEmit, onJump, jumpHighlight, showDDL, setSelection }) {
  const { cols, rows, partitioned, partitionFromSchema } = useMemo(() => buildTable(entityType, state), [entityType, state]);
  const linkedTypes = useMemo(() => linkedTypesFor(entityType, state), [entityType, state]);
  const declaredInSchema = !!state.schema?.fields?.[entityType] || (state.schema?.tables || []).includes(entityType);
  const [heatOn, setHeatOn] = useState(false);
  const [showFormula, setShowFormula] = useState(false);
  // Header-rename mode for one column at a time. {oldName, draft}.
  const [renamingField, setRenamingField] = useState(null);
  // Right-click column-type picker. {name, x, y} | null
  const [colMenu, setColMenu] = useState(null);
  // Anchor of the record whose detail side panel is open, or null.
  const [detailAnchor, setDetailAnchor] = useState(null);
  // View-local controls — none of these emit events; they only reshape the grid.
  const [sorts, setSorts] = useState([]);       // [{ field, dir: 'asc'|'desc' }]
  const [filters, setFilters] = useState([]);   // [{ id, field, op, value }]
  const [hidden, setHidden] = useState(() => new Set()); // column keys: 'f:Name' | 'l:Type' | 'p:_partition'
  const [toolPanel, setToolPanel] = useState(null); // 'filter' | 'sort' | 'hide' | null
  const scrollRef = useRef(null);

  // Close any open toolbar dropdown on Escape or an outside click.
  useEffect(() => {
    if (!toolPanel) return;
    function onKey(e) { if (e.key === 'Escape') setToolPanel(null); }
    function onClick(e) { if (!e.target.closest('.tv-toolbar')) setToolPanel(null); }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [toolPanel]);

  // Close the col-type menu on Escape or outside click.
  useEffect(() => {
    if (!colMenu) return;
    function onKey(e) { if (e.key === 'Escape') setColMenu(null); }
    function onClick(e) { if (!e.target.closest('.col-type-menu')) setColMenu(null); }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [colMenu]);

  function changeFieldType(fieldName, newType) {
    const existing = state.schema?.fields?.[entityType] || [];
    const next = existing.map(f => {
      if (f.name !== fieldName) return f;
      const u = { ...f, type: newType };
      if (newType !== 'select' && newType !== 'multiselect') delete u.options;
      else if (!u.options) u.options = [];
      if (newType !== 'formula') delete u.formula;
      else if (typeof u.formula !== 'string') u.formula = '';
      if (newType !== 'rollup') delete u.rollup;
      else if (!u.rollup || typeof u.rollup !== 'object') u.rollup = { via: '', field: '', fn: 'count' };
      return u;
    });
    onEmit(TV_OP.DEF, { anchor: null, path: `_schema.fields.${entityType}`, value: next });
  }

  // Set a single param (formula expression / rollup config / select options) on a field.
  function patchField(fieldName, patch) {
    const existing = state.schema?.fields?.[entityType] || [];
    const next = existing.map(f => f.name === fieldName ? { ...f, ...patch } : f);
    onEmit(TV_OP.DEF, { anchor: null, path: `_schema.fields.${entityType}`, value: next });
    // keep colMenu in sync so the editor inside it stays responsive
    setColMenu(m => m && m.name === fieldName ? { ...m, ...patch } : m);
  }

  // Rename a field (deferred under the hood — values stored under the old key would
  // orphan, so we only allow rename when the field is empty across rows).
  function renameField(oldName, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === oldName) return false;
    const existing = state.schema?.fields?.[entityType] || [];
    if (existing.some(f => f.name === trimmed && f.name !== oldName)) return false;
    const updated = existing.map(f => f.name === oldName ? { ...f, name: trimmed } : f);
    onEmit(TV_OP.DEF, { anchor: null, path: `_schema.fields.${entityType}`, value: updated });
    setColMenu(m => m && m.name === oldName ? { ...m, name: trimmed } : m);
    return true;
  }

  // Cell-focus coordination for the airtable-style flow: a cell whose
  // {anchor, field} matches pendingFocus opens in edit mode on the next render.
  const [pendingFocus, setPendingFocus] = useState(null);
  const tsCounterRef = useRef(0);
  const autoFocusedTablesRef = useRef(new Set());

  useEffect(() => {
    setPendingFocus(null);
    setSorts([]);
    setFilters([]);
    setHidden(new Set());
    setToolPanel(null);
  }, [entityType]);

  // When landing on a freshly-created table (one row, all fields empty),
  // open the first cell in edit mode so the user can just start typing.
  useEffect(() => {
    if (autoFocusedTablesRef.current.has(entityType)) return;
    if (rows.length !== 1 || cols.length === 0) return;
    const r = rows[0];
    const editable = cols.filter(c => c.type !== 'formula' && c.type !== 'rollup');
    if (editable.length === 0) return;
    const allEmpty = editable.every(c => {
      const v = r[c.name];
      return v === undefined || v === null || v === '';
    });
    if (!allEmpty) return;
    autoFocusedTablesRef.current.add(entityType);
    setPendingFocus({ anchor: r._anchor, field: editable[0].name });
  }, [entityType, rows, cols]);

  function addNewField(typeOverride) {
    const type = typeOverride || 'text';
    const existing = state.schema?.fields?.[entityType] || [];
    const used = new Set(existing.map(f => f.name));
    let n = existing.length;
    let placeholder;
    do {
      n += 1;
      placeholder = `Field ${n}`;
    } while (used.has(placeholder));
    const newField = { name: placeholder, type };
    if (type === 'select' || type === 'multiselect') newField.options = [];
    if (type === 'formula') newField.formula = '';
    if (type === 'rollup')  newField.rollup  = { via: '', field: '', fn: 'count' };
    onEmit(TV_OP.DEF, {
      anchor: null,
      path: `_schema.fields.${entityType}`,
      value: [...existing, newField],
    });
    setRenamingField({ oldName: placeholder, draft: placeholder });
    // Scroll the grid to its rightmost edge so the new column is visible.
    requestAnimationFrame(() => {
      const s = scrollRef.current;
      if (s) s.scrollLeft = s.scrollWidth;
    });
  }

  // Open the col-type menu in "creating" mode below the "+ add column" header.
  function openAddColumnMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    setColMenu({ creating: true, x: r.left - 220, y: r.bottom });
  }

  // ── View controls: hide → filter → sort ───────────────────────────────
  // Columns the user can toggle off (field cols + derived link/partition cols).
  const hideItems = [
    ...(partitioned ? [{ key: 'p:_partition', label: '_partition', kind: 'partition' }] : []),
    ...linkedTypes.map(t => ({ key: 'l:' + t, label: t, kind: 'link' })),
    ...cols.map(c => ({ key: 'f:' + c.name, label: c.name, kind: c.type })),
  ];
  const hiddenCount = hideItems.filter(it => hidden.has(it.key)).length;
  const showPartitionCol = partitioned && !hidden.has('p:_partition');
  const visibleLinkedTypes = linkedTypes.filter(t => !hidden.has('l:' + t));
  const visibleCols = cols.filter(c => !hidden.has('f:' + c.name));

  // Filtered + sorted rows actually rendered. Filters/sorts read computed cell
  // values (formula/rollup included) so the view matches what's on screen.
  const displayRows = useMemo(() => {
    let out = rows;
    if (filters.length) {
      out = out.filter(r => filters.every(f => {
        const col = cols.find(c => c.name === f.field);
        return matchFilter(cellValue(r, col, state), f, col?.type || 'text');
      }));
    }
    if (sorts.length) {
      out = [...out].sort((a, b) => {
        for (const s of sorts) {
          const col = cols.find(c => c.name === s.field);
          const cmp = compareValues(cellValue(a, col, state), cellValue(b, col, state), col?.type || 'text');
          if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    return out;
  }, [rows, filters, sorts, cols, state]);

  // ── Row virtualization ───────────────────────────────────────────────
  // A non-virtualized grid happily renders a few hundred rows, but a CSV
  // import can materialize tens of thousands — building that many <tr>s at
  // once locks up (or crashes) the tab. For large tables we render only the
  // rows in (and near) the viewport, padding the scroll height with spacer
  // rows above and below. Small tables take the simple path unchanged.
  const VIRTUAL_THRESHOLD = 200;
  const OVERSCAN = 12;
  const virtualize = displayRows.length > VIRTUAL_THRESHOLD;
  const [rowH, setRowH] = useState(34);
  // `scrolled` is how far the row region has travelled up past the top of the
  // viewport; `viewportH` is the visible height of that viewport. Both are
  // measured against the *real* vertical scroll ancestor — the grid's own
  // wrapper (.dbtable-scroll) only scrolls horizontally, so vertical scrolling
  // bubbles to an ancestor (.tv-body). Watching the wrapper left scrollTop
  // pinned at 0 and clientHeight equal to the full table height, which made
  // endIdx resolve to every row — so a big import rendered all its rows at
  // once and could lock up the tab.
  const [scrolled, setScrolled] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const firstRowRef = useRef(null);
  const tbodyRef = useRef(null);

  useEffect(() => {
    if (!virtualize) return;
    // Walk up to the nearest vertically-scrollable ancestor of the grid.
    let vp = scrollRef.current?.parentElement;
    while (vp) {
      const oy = getComputedStyle(vp).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') break;
      vp = vp.parentElement;
    }
    vp = vp || scrollRef.current;
    if (!vp) return;
    const measure = () => {
      const body = tbodyRef.current;
      if (!body) return;
      const vpRect = vp.getBoundingClientRect();
      // The tbody's top stays put as you scroll (the top spacer reserves the
      // space for rows scrolled off above), so it marks row 0's virtual top.
      const bodyTop = body.getBoundingClientRect().top;
      setScrolled(Math.max(0, vpRect.top - bodyTop));
      setViewportH(vp.clientHeight || vpRect.height || 0);
    };
    measure();
    vp.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(vp);
    return () => { vp.removeEventListener('scroll', measure); ro?.disconnect(); };
  }, [virtualize, displayRows.length]);

  // Calibrate the row-height estimate from the first rendered data row.
  useEffect(() => {
    if (!virtualize) return;
    const h = firstRowRef.current?.getBoundingClientRect().height;
    if (h && Math.abs(h - rowH) > 1) setRowH(h);
  });

  const vh = viewportH || 600;
  let startIdx = 0;
  let endIdx = displayRows.length;
  if (virtualize) {
    startIdx = Math.max(0, Math.floor(scrolled / rowH) - OVERSCAN);
    endIdx = Math.min(displayRows.length, startIdx + Math.ceil(vh / rowH) + OVERSCAN * 2);
  }
  const visibleRows = virtualize ? displayRows.slice(startIdx, endIdx) : displayRows;
  const padTop = virtualize ? startIdx * rowH : 0;
  const padBottom = virtualize ? (displayRows.length - endIdx) * rowH : 0;
  const spacerCols = (showFormula ? 1 : 0) + (showPartitionCol ? 1 : 0) + visibleLinkedTypes.length + visibleCols.length + 1;

  function commitRename() {
    if (!renamingField) return;
    const { oldName, draft } = renamingField;
    setRenamingField(null);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === oldName) return;
    const existing = state.schema?.fields?.[entityType] || [];
    // Reject collisions with another existing field.
    if (existing.some(f => f.name === trimmed && f.name !== oldName)) return;
    const updated = existing.map(f => f.name === oldName ? { ...f, name: trimmed } : f);
    onEmit(TV_OP.DEF, { anchor: null, path: `_schema.fields.${entityType}`, value: updated });
  }

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

  function nextUniqueTs() {
    const now = Date.now();
    tsCounterRef.current = Math.max(tsCounterRef.current + 1, now);
    return tsCounterRef.current;
  }

  function addRow() {
    const sender = '@you:demo';
    const ts = nextUniqueTs();
    const anchor = window.MatrixEngine.makeAnchor(entityType, {}, sender, ts);
    onEmit(TV_OP.INS, { anchor, entity_type: entityType, payload: {} });
    return anchor;
  }

  // Cell navigation walks the *visible, displayed* grid — hidden columns are
  // skipped and row order follows the active sort/filter.
  function nextEditableCol(startIdx, step) {
    for (let i = startIdx; i >= 0 && i < visibleCols.length; i += step) {
      if (visibleCols[i].type !== 'formula' && visibleCols[i].type !== 'rollup') return i;
    }
    return -1;
  }

  function navigate(rowIdx, colIdx, dir) {
    if (dir === 'tab') {
      const next = nextEditableCol(colIdx + 1, 1);
      if (next !== -1) {
        setPendingFocus({ anchor: displayRows[rowIdx]._anchor, field: visibleCols[next].name });
      } else if (rowIdx === displayRows.length - 1) {
        const first = nextEditableCol(0, 1);
        const newAnchor = addRow();
        if (first !== -1) setPendingFocus({ anchor: newAnchor, field: visibleCols[first].name });
      } else {
        const first = nextEditableCol(0, 1);
        if (first !== -1) setPendingFocus({ anchor: displayRows[rowIdx + 1]._anchor, field: visibleCols[first].name });
      }
    } else if (dir === 'shift-tab') {
      const prev = nextEditableCol(colIdx - 1, -1);
      if (prev !== -1) {
        setPendingFocus({ anchor: displayRows[rowIdx]._anchor, field: visibleCols[prev].name });
      } else if (rowIdx > 0) {
        const last = nextEditableCol(visibleCols.length - 1, -1);
        if (last !== -1) setPendingFocus({ anchor: displayRows[rowIdx - 1]._anchor, field: visibleCols[last].name });
      }
    } else if (dir === 'enter') {
      if (rowIdx === displayRows.length - 1) {
        const first = nextEditableCol(0, 1);
        const newAnchor = addRow();
        if (first !== -1) setPendingFocus({ anchor: newAnchor, field: visibleCols[first].name });
      } else {
        setPendingFocus({ anchor: displayRows[rowIdx + 1]._anchor, field: visibleCols[colIdx].name });
      }
    }
  }

  function addRowAndFocus() {
    if (visibleCols.length === 0) return;
    const first = nextEditableCol(0, 1);
    const newAnchor = addRow();
    if (first !== -1) setPendingFocus({ anchor: newAnchor, field: visibleCols[first].name });
  }

  const allCols = [
    ...(showFormula ? [{ name: '_anchor', type: 'pk', isPk: true, schematized: true }] : []),
    // derived columns (partition + linked) sit on the LEFT, so user-defined
    // schema fields cluster on the right and new "+ add field" columns always
    // appear at the rightmost edge of the grid.
    ...(showPartitionCol ? [{ name: '_partition', type: 'partition', schematized: partitionFromSchema }] : []),
    ...visibleLinkedTypes.map(t => ({ name: t, type: 'linked', schematized: true })),
    ...visibleCols,
  ];

  // DDL string for the table header — only schema-declared fields counted as part of schema
  const ddl = useMemo(() => {
    // entityType, field names, and linked-type names are remote, attacker-
    // controllable data (any room member can DEF a field named
    // "<img onerror=...>"). This string is rendered via dangerouslySetInnerHTML
    // below, so every interpolated value MUST be HTML-escaped. The static
    // <span> scaffolding is ours; only the data is escaped, and padding is
    // applied before escaping so column alignment is preserved.
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const pad = (s, w) => esc(String(s).padEnd(w));
    const schemaFields = cols.filter(c => c.schematized);
    const extras = cols.filter(c => !c.schematized);
    const lines = [
      `<span class="kw">CREATE TABLE</span> <span class="id">${esc(entityType)}</span> (`,
      `  <span class="id">_anchor</span>    <span class="ty">TEXT</span>     <span class="kw">PRIMARY KEY</span>,`,
      ...schemaFields.map(c => `  <span class="id">${pad(c.name, 10)}</span> <span class="ty">${pad(sqlType(c.type), 8)}</span>,`),
      ...(partitioned && partitionFromSchema
        ? [`  <span class="id">_partition </span> <span class="ty">TEXT</span>,     <span class="cmt">-- from _schema.partitions.${esc(entityType)} via SEG</span>`]
        : partitioned
        ? [`  <span class="id">_partition </span> <span class="ty">TEXT</span>?    <span class="cmt">-- observed in data, not in schema</span>`]
        : []),
      ...linkedTypes.map(t => `  <span class="id">${pad(t, 10)}</span> <span class="ty">LINK&lt;${esc(t)}&gt;</span>  <span class="cmt">-- derived from CON edges${state.schema?.links ? ' (in schema)' : ''}</span>`),
      ...extras.map(c => `  <span class="cmt">-- ! </span><span class="id">${pad(c.name, 8)}</span> <span class="ty">${pad(sqlType(c.type), 8)}</span>  <span class="cmt">-- in data but not in _schema.fields.${esc(entityType)}</span>`),
      `);`,
    ];
    if (!declaredInSchema) {
      lines.unshift(`<span class="cmt">-- ! ${esc(entityType)} not declared in _schema.tables; appearing because of data</span>`);
    }
    return lines.join('\n');
  }, [entityType, JSON.stringify(cols), partitioned, partitionFromSchema, linkedTypes.join(','), declaredInSchema]);

  return (
    <div className="dbtable">
      {showDDL && <div className="ddl" dangerouslySetInnerHTML={{ __html: ddl }} />}
      <div className="dbtable-head">
        <div className="name">
          <span className="schema">{room.title || 'workspace'}</span><span className="dot">.</span>{entityType}
          {!declaredInSchema && <span style={{color:'var(--signal)',marginLeft:8,fontWeight:400}}>? unschematized</span>}
        </div>
        <div className="meta">
          {filters.length && displayRows.length !== rows.length
            ? <span title={`${rows.length} total · ${filters.length} filter${filters.length!==1?'s':''} active`}>{displayRows.length} of {rows.length} rows</span>
            : <span>{rows.length} row{rows.length!==1?'s':''}</span>}
          <button
            className={`heat-toggle ${heatOn ? 'on' : ''}`}
            onClick={() => setHeatOn(o => !o)}
            title="color cells by number of DEF writes per path"
          >heat map</button>
        </div>
      </div>
      <div className="tv-toolbar">
        <button
          className={`tv-tool-btn ${filters.length ? 'active' : ''} ${toolPanel === 'filter' ? 'open' : ''}`}
          onClick={() => setToolPanel(p => p === 'filter' ? null : 'filter')}
          title="filter rows · view-local, emits nothing"
        ><i className="ph ph-funnel" aria-hidden="true"></i> filter{filters.length ? ` · ${filters.length}` : ''}</button>
        <button
          className={`tv-tool-btn ${sorts.length ? 'active' : ''} ${toolPanel === 'sort' ? 'open' : ''}`}
          onClick={() => setToolPanel(p => p === 'sort' ? null : 'sort')}
          title="sort rows · view-local, emits nothing"
        ><i className="ph ph-arrows-down-up" aria-hidden="true"></i> sort{sorts.length ? ` · ${sorts.length}` : ''}</button>
        <button
          className={`tv-tool-btn ${hiddenCount ? 'active' : ''} ${toolPanel === 'hide' ? 'open' : ''}`}
          onClick={() => setToolPanel(p => p === 'hide' ? null : 'hide')}
          title="hide columns · view-local, emits nothing"
        ><i className={`ph ph-${hiddenCount ? 'eye-slash' : 'eye'}`} aria-hidden="true"></i> {hiddenCount ? `${hiddenCount} hidden` : 'hide fields'}</button>
        {(filters.length || sorts.length || hiddenCount) ? (
          <button className="tv-tool-reset" onClick={() => { setFilters([]); setSorts([]); setHidden(new Set()); setToolPanel(null); }} title="clear all view controls">reset view</button>
        ) : null}
        {toolPanel === 'filter' && <FilterPanel cols={cols} filters={filters} setFilters={setFilters} />}
        {toolPanel === 'sort' && <SortPanel cols={cols} sorts={sorts} setSorts={setSorts} />}
        {toolPanel === 'hide' && <HidePanel items={hideItems} hidden={hidden} setHidden={setHidden} />}
      </div>
      <div className="dbtable-scroll" ref={scrollRef}>
        <table className={`dbgrid ${heatOn ? 'heat-on' : ''}`}>
          <thead>
            <tr>
              {allCols.map(c => {
                const cs = colStats[c.name];
                const isFormula = c.type === 'formula';
                const isRollup  = c.type === 'rollup';
                const renameable = !c.isPk && c.type !== 'linked' && c.type !== 'partition';
                // Only allow dblclick-rename on fields with no row data — renaming a
                // populated field would orphan its values under the old key. Formula
                // and rollup fields don't store row data, so they're always rename-safe.
                const empty = isFormula || isRollup || rows.every(r => r[c.name] === undefined || r[c.name] === null || r[c.name] === '');
                const dblRenameable = renameable && empty;
                const isRenaming = renameable && renamingField?.oldName === c.name;
                const showGlyph = c.isPk || isFormula || isRollup;
                const canEdit = !c.isPk && c.type !== 'linked' && c.type !== 'partition' && c.schematized !== false;
                const headerTitle = c.isPk
                  ? '_anchor · formula field, derived from INS payload'
                  : isFormula
                    ? (c.formula ? `formula: ${c.formula}` : 'formula field · click to set the expression')
                    : isRollup
                      ? (c.rollup?.via ? `rollup: ${c.rollup.fn || 'count'}(${c.rollup.field || ''}) via ${c.rollup.via}` : 'rollup field · click to set via / field / fn')
                      : (c.schematized === false ? 'in data but not in _schema' : canEdit ? 'click to edit field · rename, change type, set params' : '');
                const openMenu = (canEdit && !isRenaming) ? (e) => {
                  // never hijack clicks inside the inline rename input
                  if (e.target.tagName === 'INPUT') return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setColMenu({ name: c.name, currentType: c.type, options: c.options, formula: c.formula, rollup: c.rollup, x: r.left, y: r.bottom });
                } : undefined;
                return (
                  <th key={c.name} className={`${c.isPk ? 'pk' : ''} ${c.schematized === false ? 'unschematized' : ''} ${showGlyph ? 'formula' : ''} ${canEdit ? 'editable' : ''}`}
                      title={headerTitle}
                      onClick={openMenu}
                      onContextMenu={openMenu}>
                    {showGlyph && <span className="formula-glyph" title="formula field">ƒ </span>}
                    {isRenaming ? (
                      <input
                        autoFocus
                        className="col-rename-input"
                        value={renamingField.draft}
                        onFocus={e => e.target.select()}
                        onChange={e => setRenamingField(r => ({ ...r, draft: e.target.value }))}
                        onBlur={commitRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                          else if (e.key === 'Escape') { e.preventDefault(); setRenamingField(null); }
                        }}
                      />
                    ) : c.name}
                    {!c.isPk && <span className="ty" title={sqlType(c.type)}><i className={`ph ph-${iconForType(c.type)}`} aria-hidden="true"></i></span>}
                    {heatOn && cs && cs.avg > 0 && (
                      <span className="rev" title={`${cs.total} writes total · max ${cs.max} on one row`}> · {cs.avg.toFixed(1)} avg</span>
                    )}
                  </th>
                );
              })}
              <th className="add-col" title="add a column · pick a field type">
                <button className="add-col-btn" onClick={openAddColumnMenu} title="add a column · pick a field type">+</button>
              </th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {virtualize && padTop > 0 && (
              <tr aria-hidden="true" className="virt-spacer"><td colSpan={spacerCols} style={{ height: padTop, padding: 0, border: 0 }} /></tr>
            )}
            {visibleRows.map((r, vIdx) => {
              const rIdx = startIdx + vIdx;
              return (
              <tr key={r._anchor} ref={vIdx === 0 ? firstRowRef : undefined}>
                {showFormula && (
                  <td
                    className="cell anchor anchor-link formula"
                    onClick={() => setSelection && setSelection({
                      kind: 'slice',
                      sliceId: `${entityType}.timeline.${r._anchor}`,
                      sliceKind: 'timeline',
                      tableId: entityType,
                      entityAnchor: r._anchor,
                    })}
                    title="view this entity's timeline"
                  >{r._anchor}</td>
                )}
                {showPartitionCol && (
                  <EditableCell
                    value={state.partitions[r._anchor]}
                    type="text"
                    heat={0}
                    onCommit={(v) => commitPartition(r._anchor, v)}
                  />
                )}
                {visibleLinkedTypes.map(t => (
                  <LinkedCell
                    key={t}
                    links={linksFromAnchor(r._anchor, t, state)}
                    onJump={onJump}
                  />
                ))}
                {visibleCols.map((c, cIdx) => (
                  c.type === 'formula' ? (
                    <FormulaCell key={c.name} formula={c.formula} record={r} state={state} />
                  ) : c.type === 'rollup' ? (
                    <RollupCell key={c.name} rollup={c.rollup} record={r} state={state} />
                  ) : (
                    <EditableCell
                      key={c.name}
                      value={r[c.name]}
                      type={c.type}
                      heat={heatOn ? (r._writes?.[c.name] || 0) : 0}
                      onCommit={(v) => commitCell(r._anchor, c.name, v)}
                      shouldFocus={pendingFocus?.anchor === r._anchor && pendingFocus?.field === c.name}
                      onFocusConsumed={() => setPendingFocus(null)}
                      onNavigate={(dir) => navigate(rIdx, cIdx, dir)}
                    />
                  )
                ))}
                <td className="cell add-col-spacer row-expand" title="expand record · view & edit all fields"
                    onClick={() => setDetailAnchor(r._anchor)}>⤢</td>
              </tr>
              );
            })}
            {virtualize && padBottom > 0 && (
              <tr aria-hidden="true" className="virt-spacer"><td colSpan={spacerCols} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>
            )}

            {displayRows.length === 0 && rows.length > 0 && (
              <tr className="tv-no-match">
                <td className="cell" colSpan={allCols.length + 1} style={{textAlign:'center',padding:'14px',color:'var(--text-faint)',fontStyle:'italic'}}>
                  no rows match the active filter{filters.length !== 1 ? 's' : ''} ·{' '}
                  <button className="tv-inline-link" onClick={() => setFilters([])}>clear filter{filters.length !== 1 ? 's' : ''}</button>
                </td>
              </tr>
            )}

            {/* Heat-map summary row */}
            {heatOn && rows.length > 0 && (
              <tr className="heat-summary">
                {showFormula && <td className="cell" style={{fontSize:11,color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'1.2px',fontWeight:700}}>avg writes</td>}
                {showPartitionCol && <td className="cell"></td>}
                {visibleLinkedTypes.map(t => <td key={t} className="cell hs-link"></td>)}
                {!showFormula && visibleCols.length > 0 && !showPartitionCol && visibleLinkedTypes.length === 0 && <td className="cell" style={{fontSize:11,color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'1.2px',fontWeight:700}}></td>}
                {visibleCols.map((c, i) => {
                  const cs = colStats[c.name] || { avg: 0, max: 0 };
                  const pct = Math.min(cs.max / 10 * 100, 100);
                  const color = cs.avg < 1.5 ? '#85b7eb' : cs.avg < 3 ? '#fac775' : cs.avg < 6 ? '#f09595' : '#e24b4a';
                  return (
                    <td key={c.name} className="cell heat-summary-cell">
                      {i === 0 && !showFormula && <span style={{fontSize:10,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'1.2px',fontWeight:700,marginRight:6}}>avg writes</span>}
                      <div className="heat-bar"><div className="heat-bar-fill" style={{width: pct + '%', background: color}} /></div>
                      <div className="heat-bar-label">{cs.avg.toFixed(1)} / row</div>
                    </td>
                  );
                })}
                <td className="cell"></td>
              </tr>
            )}
            {cols.length > 0 && visibleCols.length > 0 && (
              <tr className="add-row" onClick={addRowAndFocus} title="click to add a row · or hit Enter from the last cell">
                {showFormula && <td className="cell anchor add-row-gutter"><span className="add-row-plus">+</span></td>}
                <td className="cell add-row-cell" colSpan={visibleCols.length + (showPartitionCol ? 1 : 0) + visibleLinkedTypes.length + 1}>
                  {!showFormula && <span className="add-row-plus">+</span>}
                  <span className="add-row-hint">{rows.length === 0 ? `add the first ${entityType} row` : 'add row'}</span>
                </td>
              </tr>
            )}
            {cols.length === 0 && (
              <tr>
                <td className="cell" colSpan={allCols.length + 1} style={{textAlign:'center',padding:'14px',color:'var(--text-faint)',fontStyle:'italic'}}>
                  no fields yet · add a field with the <span className="kbd">+</span> in the header
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {colMenu && (
        <div className="col-type-menu" style={{ left: colMenu.x, top: colMenu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="col-type-menu-head">
            <span className="ctm-eyebrow">{colMenu.creating ? 'new column · pick a type' : 'edit column'}</span>
            {!colMenu.creating && (
              <input
                autoFocus
                className="ctm-name-input"
                defaultValue={colMenu.name}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    if (renameField(colMenu.name, e.target.value)) setColMenu(null);
                  } else if (e.key === 'Escape') {
                    setColMenu(null);
                  }
                }}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value.trim() !== colMenu.name) {
                    renameField(colMenu.name, e.target.value);
                  }
                }}
                placeholder="field name"
              />
            )}
          </div>

          {/* Type picker */}
          <div className="ctm-section-label">type</div>
          {FIELD_TYPES.map(ft => (
            <button
              key={ft.value}
              className={`col-type-menu-row ${ft.value === colMenu.currentType ? 'on' : ''}`}
              onClick={() => {
                if (colMenu.creating) {
                  addNewField(ft.value);
                  setColMenu(null);
                } else if (ft.value !== colMenu.currentType) {
                  changeFieldType(colMenu.name, ft.value);
                  // keep menu open so user can immediately set params
                  setColMenu(m => m && ({ ...m, currentType: ft.value }));
                }
              }}
              title={ft.hint}
            >
              <i className={`ctm-icon ph ph-${ft.icon}`} aria-hidden="true"></i>
              <span className="ctm-label">{ft.label}</span>
              <span className="ctm-hint">{ft.hint}</span>
            </button>
          ))}

          {/* Params editor — only when not in creating mode and type has params */}
          {!colMenu.creating && (colMenu.currentType === 'formula' || colMenu.currentType === 'rollup' || colMenu.currentType === 'select' || colMenu.currentType === 'multiselect') && (
            <ColMenuParams
              menu={colMenu}
              state={state}
              entityType={entityType}
              linkedTypes={linkedTypes}
              onPatch={(patch) => patchField(colMenu.name, patch)}
            />
          )}
        </div>
      )}
      {detailAnchor && (() => {
        const rec = rows.find(r => r._anchor === detailAnchor);
        if (!rec) return null;
        return (
          <RecordDetailPanel
            record={rec}
            records={rows}
            entityType={entityType}
            room={room}
            cols={cols}
            partitioned={partitioned}
            linkedTypes={linkedTypes}
            state={state}
            onClose={() => setDetailAnchor(null)}
            onCommitCell={commitCell}
            onCommitPartition={commitPartition}
            onJump={onJump}
            onSelectRecord={setDetailAnchor}
            onViewTimeline={(anchor) => {
              setDetailAnchor(null);
              setSelection && setSelection({
                kind: 'slice',
                sliceId: `${entityType}.timeline.${anchor}`,
                sliceKind: 'timeline',
                tableId: entityType,
                entityAnchor: anchor,
              });
            }}
          />
        );
      })()}
    </div>
  );
}

function sqlType(t) {
  return { text: 'TEXT', number: 'INTEGER', boolean: 'BOOLEAN', json: 'JSONB', select: 'TEXT', multiselect: 'TEXT[]', longtext: 'TEXT', date: 'TIMESTAMP', url: 'TEXT', email: 'TEXT', partition: 'TEXT', linked: 'LINK', formula: 'FORMULA' }[t] || 'TEXT';
}

// Short docs for the most commonly used functions (used by the autocomplete
// popover when a suggestion is hovered/active). Falls back to empty hint.
const FORMULA_HINTS = {
  SUM: 'SUM(num, …) → total', AVG: 'AVG(num, …)', AVERAGE: 'AVERAGE(num, …)',
  MIN: 'MIN(num, …)', MAX: 'MAX(num, …)', COUNT: 'COUNT(num, …)', COUNTA: 'COUNTA(any, …)',
  ROUND: 'ROUND(n, digits=0)', ROUNDUP: 'ROUNDUP(n, digits=0)', ROUNDDOWN: 'ROUNDDOWN(n, digits=0)',
  ABS: 'ABS(n)', FLOOR: 'FLOOR(n)', CEIL: 'CEIL(n)', CEILING: 'CEILING(n)', INT: 'INT(n)',
  POW: 'POW(base, exp)', POWER: 'POWER(base, exp)', SQRT: 'SQRT(n)', MOD: 'MOD(a, b)', EXP: 'EXP(n)', LOG: 'LOG(n, base=10)',
  IF: 'IF(cond, then, else)', AND: 'AND(a, …) → all truthy',
  OR: 'OR(a, …) → any truthy', NOT: 'NOT(x)', BLANK: 'BLANK(v)',
  IFERROR: 'IFERROR(value, fallback)', SWITCH: 'SWITCH(expr, key, val, …, default?)',
  CONCAT: 'CONCAT(a, …)', CONCATENATE: 'CONCATENATE(a, …)',
  LEN: 'LEN(str)', LOWER: 'LOWER(str)', UPPER: 'UPPER(str)', TRIM: 'TRIM(str)',
  LEFT: 'LEFT(str, n)', RIGHT: 'RIGHT(str, n)', MID: 'MID(str, start, count)',
  FIND: 'FIND(needle, hay, start=0) → 1-indexed', SEARCH: 'SEARCH(needle, hay) → case-insensitive',
  SUBSTITUTE: 'SUBSTITUTE(str, find, rep, [index])', REPLACE: 'REPLACE(str, find, rep)',
  REPT: 'REPT(str, n)', T: 'T(value) → str or blank',
  ENCODE_URL_COMPONENT: 'ENCODE_URL_COMPONENT(str)',
  REGEX_MATCH: 'REGEX_MATCH(str, pattern) → bool', REGEX_EXTRACT: 'REGEX_EXTRACT(str, pattern)',
  REGEX_REPLACE: 'REGEX_REPLACE(str, pattern, rep)',
  TODAY: 'TODAY() → YYYY-MM-DD', NOW: 'NOW() → ISO timestamp',
  YEAR: 'YEAR(date)', MONTH: 'MONTH(date)', DAY: 'DAY(date)',
  HOUR: 'HOUR(date)', MINUTE: 'MINUTE(date)', SECOND: 'SECOND(date)', WEEKDAY: 'WEEKDAY(date) → 0..6',
  DATEADD: 'DATEADD(date, n, "days"|"hours"|…)',
  DATETIME_DIFF: 'DATETIME_DIFF(a, b, unit="days")',
  DATETIME_FORMAT: 'DATETIME_FORMAT(date, "YYYY-MM-DD HH:mm")',
  RECORD_ID: 'RECORD_ID() → this row\'s _anchor',
  CREATED_TIME: 'CREATED_TIME() → row created ts',
  LAST_MODIFIED_TIME: 'LAST_MODIFIED_TIME() → last update ts',
};

function FormulaEditor({ value, entityType, state, onCommit }) {
  const taRef = React.useRef(null);
  const [draft, setDraft] = React.useState(value || '');
  // Open suggestions popover. {kind: 'fn'|'field', items: string[], idx: number}
  const [sugg, setSugg] = React.useState(null);

  React.useEffect(() => { setDraft(value || ''); }, [value]);

  const FUNCS = window.Formula?.FUNCTIONS || [];
  const HELPERS = ['RECORD_ID', 'CREATED_TIME', 'LAST_MODIFIED_TIME', 'TRUE', 'FALSE', 'NULL', 'PI', 'E'];
  const ALL_IDENTS = [...FUNCS, ...HELPERS];
  const fields = (state.schema?.fields?.[entityType] || []).map(f => f.name);

  // Recompute suggestions every time the textarea content changes or caret moves.
  function recomputeSuggestions() {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value;
    const pos = ta.selectionStart;
    const before = text.slice(0, pos);

    // 1. Inside an unclosed {…} → field name
    const openBrace = before.lastIndexOf('{');
    const closeBrace = before.lastIndexOf('}');
    if (openBrace > closeBrace) {
      const frag = before.slice(openBrace + 1).toLowerCase();
      const items = fields.filter(f => f.toLowerCase().includes(frag));
      if (items.length) { setSugg({ kind: 'field', items, idx: 0, start: openBrace + 1 }); return; }
      setSugg(null);
      return;
    }
    // 2. Trailing word that looks like an identifier → function/helper
    const m = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    if (m && m[0].length >= 1) {
      const frag = m[0].toUpperCase();
      // Prefix match first, then substring fallback
      const prefix = ALL_IDENTS.filter(n => n.startsWith(frag));
      const subs   = ALL_IDENTS.filter(n => !n.startsWith(frag) && n.includes(frag));
      const items = [...prefix, ...subs].slice(0, 10);
      if (items.length) { setSugg({ kind: 'fn', items, idx: 0, start: pos - m[0].length, end: pos }); return; }
    }
    setSugg(null);
  }

  function applySuggestion(s, item) {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value;
    let newText, caret;
    if (s.kind === 'field') {
      // Replace from s.start (after '{') to current caret with the chosen name, close with `}`
      const pos = ta.selectionStart;
      const before = text.slice(0, s.start);
      const after = text.slice(pos);
      // Auto-add closing brace if there isn't one already
      const trailing = after.startsWith('}') ? '' : '}';
      newText = before + item + trailing + after;
      caret = (before + item + (trailing ? '}' : '')).length;
    } else {
      // Function — replace identifier, then add "(" and place caret inside
      const before = text.slice(0, s.start);
      const after = text.slice(s.end);
      newText = before + item + '(' + after;
      caret = (before + item + '(').length;
    }
    setDraft(newText);
    setSugg(null);
    requestAnimationFrame(() => {
      ta.value = newText;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }

  function onKeyDown(e) {
    if (sugg) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSugg(s => ({ ...s, idx: (s.idx + 1) % s.items.length })); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSugg(s => ({ ...s, idx: (s.idx - 1 + s.items.length) % s.items.length })); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(sugg, sugg.items[sugg.idx]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setSugg(null); return; }
    }
    if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (e.key === 'Enter' && !sugg && e.shiftKey === false)) {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); commit(); }
    }
  }

  function commit() {
    if (draft !== (value || '')) onCommit(draft);
  }

  return (
    <div className="ctm-params">
      <div className="ctm-section-label">formula</div>
      <div className="ctm-formula-wrap">
        <textarea
          ref={taRef}
          className="ctm-formula"
          value={draft}
          placeholder="UPPER({Name})  ·  {price} * {qty}  ·  IF({done}, 'shipped', 'wip')"
          rows={3}
          spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); recomputeSuggestions(); }}
          onClick={recomputeSuggestions}
          onKeyUp={(e) => {
            // Reposition popover after arrow nav inside textarea
            if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) recomputeSuggestions();
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
        {sugg && sugg.items.length > 0 && (
          <div className="ctm-suggest" role="listbox">
            {sugg.items.map((it, i) => (
              <button
                key={it}
                className={`ctm-suggest-row ${i === sugg.idx ? 'active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); applySuggestion(sugg, it); }}
              >
                <i className={`ph ph-${sugg.kind === 'field' ? 'brackets-curly' : 'function'}`} aria-hidden="true"></i>
                <span className="cs-name">{it}</span>
                {sugg.kind === 'fn' && <span className="cs-hint">{FORMULA_HINTS[it] || ''}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="ctm-hint-line">
        type <code>{'{'}</code> for fields · letters for functions · ↑↓ to nav · ⏎/⇥ to accept · ⌘/Ctrl+⏎ to save
      </div>
    </div>
  );
}

// Distinct, sorted values present in the records for one field of an entity
// type. Multiselect cells hold arrays, so those are flattened; empty / null
// values are skipped. Used to show "what's actually in the data" when editing
// a select field's options.
function collectFieldValues(state, entityType, fieldName) {
  if (!fieldName || !state || !state.entities) return [];
  const set = new Set();
  for (const e of Object.values(state.entities)) {
    if (!e || e._type !== entityType) continue;
    const v = e[fieldName];
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      for (const x of v) { if (x != null && x !== '') set.add(String(x)); }
    } else {
      set.add(String(v));
    }
  }
  return [...set].sort();
}

// Inline params editor that lives inside the column popover.
// Formula → autocompleting editor  ·  Rollup → 3 selects  ·  Select/Multiselect → chips + add
function ColMenuParams({ menu, state, entityType, linkedTypes, onPatch }) {
  const t = menu.currentType;
  if (t === 'formula') {
    return (
      <FormulaEditor
        value={menu.formula || ''}
        entityType={entityType}
        state={state}
        onCommit={(v) => onPatch({ formula: v })}
      />
    );
  }

  if (t === 'rollup') {
    const cfg = menu.rollup || { via: '', field: '', fn: 'count' };
    const relations = linkedTypes.length
      ? (state.schema?.links || [])
          .filter(l => l.from === entityType || l.to === entityType)
          .map(l => l.rel)
          .filter((r, i, a) => a.indexOf(r) === i)
      : [];
    // candidate fields = fields on the LINKED entity types
    const linkedTypeNames = new Set();
    for (const l of (state.schema?.links || [])) {
      if (l.from === entityType) linkedTypeNames.add(l.to);
      if (l.to === entityType)   linkedTypeNames.add(l.from);
    }
    const linkedFields = new Set();
    for (const tn of linkedTypeNames) {
      for (const f of (state.schema?.fields?.[tn] || [])) {
        if (f.type !== 'linked' && f.type !== 'partition') linkedFields.add(f.name);
      }
    }
    const FNS = window.Formula?.ROLLUP_FNS || ['count', 'sum', 'avg', 'min', 'max', 'list'];
    return (
      <div className="ctm-params">
        <div className="ctm-section-label">rollup</div>
        <div className="ctm-rollup-grid">
          <label>via</label>
          <select value={cfg.via || ''} onChange={(e) => onPatch({ rollup: { ...cfg, via: e.target.value } })}>
            <option value="">(pick a relation)</option>
            {relations.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <label>fn</label>
          <select value={cfg.fn || 'count'} onChange={(e) => onPatch({ rollup: { ...cfg, fn: e.target.value } })}>
            {FNS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          {(cfg.fn !== 'count' && cfg.fn !== 'list') && (
            <>
              <label>field</label>
              <select value={cfg.field || ''} onChange={(e) => onPatch({ rollup: { ...cfg, field: e.target.value } })}>
                <option value="">(pick a field)</option>
                {[...linkedFields].sort().map(fn => <option key={fn} value={fn}>{fn}</option>)}
              </select>
            </>
          )}
        </div>
        {relations.length === 0 && (
          <div className="ctm-hint-line">no link relations on this set yet — add one in the schema view first.</div>
        )}
      </div>
    );
  }

  if (t === 'select' || t === 'multiselect') {
    const opts = menu.options || [];
    const removeOption = (o) => onPatch({ options: opts.filter(x => x !== o) });
    // Distinct values actually present in the data for this field. A schema's
    // declared options can drift from reality (CSV imports, hand edits), so we
    // surface every value found in the records and let the user register the
    // ones that aren't options yet.
    const dataValues = collectFieldValues(state, entityType, menu.name);
    const missing = dataValues.filter(v => !opts.includes(v));
    const addOption = (v) => { if (v && !opts.includes(v)) onPatch({ options: [...opts, v] }); };
    return (
      <div className="ctm-params">
        <div className="ctm-section-label">options</div>
        <div className="ctm-chips">
          {opts.map(o => (
            <span key={o} className="ctm-chip">
              {o}
              <button className="ctm-chip-x" onClick={() => removeOption(o)} title="remove">×</button>
            </span>
          ))}
          {opts.length === 0 && <span className="ctm-empty">no options yet</span>}
        </div>
        <input
          className="ctm-option-input"
          placeholder="type to add an option · enter to commit"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = e.target.value.trim();
              if (!v) return;
              if (opts.includes(v)) return;
              onPatch({ options: [...opts, v] });
              e.target.value = '';
            }
          }}
        />
        {missing.length > 0 && (
          <>
            <div className="ctm-section-label">
              found in data
              <button
                className="ctm-add-all"
                title="add every value found in the data as an option"
                onClick={() => onPatch({ options: [...opts, ...missing] })}
              >add all</button>
            </div>
            <div className="ctm-chips">
              {missing.map(v => (
                <button
                  key={v}
                  className="ctm-chip ctm-chip-suggested"
                  title="click to add as an option"
                  onClick={() => addOption(v)}
                >
                  {v}
                  <span className="ctm-chip-plus" aria-hidden="true">+</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }
  return null;
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
// `icon` is a Phosphor icon name (loaded via the @phosphor-icons/web script
// in index.html); renders as <i class="ph ph-{icon}" />.
const FIELD_TYPES = [
  { value: 'text',        label: 'text',         icon: 'text-aa',         hint: 'single-line string' },
  { value: 'longtext',    label: 'long text',    icon: 'text-align-left', hint: 'multi-line string'  },
  { value: 'number',      label: 'number',       icon: 'hash',            hint: 'integer or decimal' },
  { value: 'boolean',     label: 'checkbox',     icon: 'check-square',    hint: 'true / false'        },
  { value: 'select',      label: 'single-select',icon: 'circle',          hint: 'one of a fixed enum'},
  { value: 'multiselect', label: 'multi-select', icon: 'list-checks',     hint: 'subset of an enum (REC: overwrite → append)' },
  { value: 'date',        label: 'date',         icon: 'calendar-blank',  hint: 'timestamp'           },
  { value: 'url',         label: 'url',          icon: 'link',            hint: 'validated http(s)'   },
  { value: 'email',       label: 'email',        icon: 'envelope',        hint: 'validated address'   },
  { value: 'json',        label: 'json',         icon: 'brackets-curly',  hint: 'arbitrary structured'},
  { value: 'formula',     label: 'formula',      icon: 'function',        hint: 'read-only · e.g. RECORD_ID() or UPPER({Name})' },
  { value: 'rollup',      label: 'rollup',       icon: 'sigma',           hint: 'aggregate values across linked records (sum / count / avg / …)' },
];

// Phosphor icon for any column type (including derived: pk / linked / partition).
function iconForType(t) {
  const ft = FIELD_TYPES.find(f => f.value === t);
  if (ft) return ft.icon;
  if (t === 'pk') return 'key';
  if (t === 'linked') return 'arrows-left-right';
  if (t === 'partition') return 'kanban';
  return 'text-aa';
}

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
  const [showFormula, setShowFormula] = React.useState(false);

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
    if (c.type === 'formula') return 'compute';
    if (c.type === 'rollup')  return 'compute';
    if (c.type === 'multiselect') return 'append';
    return 'overwrite';
  }

  // Compact human-readable summary for a rollup config, used in the params cell.
  function rollupSummary(cfg) {
    if (!cfg || typeof cfg !== 'object') return '';
    const fn = (cfg.fn || 'count').toLowerCase();
    const via = cfg.via || '?';
    if (fn === 'count' || fn === 'list') return `${fn}() via ${via}`;
    return `${fn}(${cfg.field || '?'}) via ${via}`;
  }

  const rows = [
    ...(showFormula ? [{
      path: '_anchor', kind: 'pk', rawType: 'text', type: 'TEXT', operator: 'identity', schematized: true, isPk: true,
      params: 'PRIMARY KEY · content-addressed', editable: false,
    }] : []),
    ...cols.map(c => ({
      path: c.name, kind: 'field', rawType: c.type, fieldName: c.name,
      type: sqlType(c.type),
      operator: opFor(c),
      schematized: c.schematized,
      options: c.options,
      formula: c.formula,
      rollup: c.rollup,
      params: c.options ? c.options.join(', ')
              : (c.type === 'formula' ? (c.formula || '')
              : (c.type === 'rollup'  ? rollupSummary(c.rollup)
              : (c.type === 'json'    ? 'arbitrary JSON' : ''))),
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
      if (newType !== 'formula') delete updated.formula;
      else if (typeof updated.formula !== 'string') updated.formula = '';
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

  function setFieldFormula(fieldName, formula) {
    const next = fieldsArray().map(f => f.name === fieldName ? { ...f, formula } : f);
    emitFields(next);
  }

  function setFieldRollup(fieldName, rollup) {
    const next = fieldsArray().map(f => f.name === fieldName ? { ...f, rollup } : f);
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
    } else if (row.rawType === 'formula') {
      setDraft(row.formula || '');
    } else {
      setDraft(row.options ? row.options.join(', ') : '');
    }
  }

  function commitParams(row) {
    if (row.kind === 'field' && row.rawType === 'formula') {
      setFieldFormula(row.fieldName, draft);
    } else {
      const tokens = draft.split(',').map(s => s.trim()).filter(Boolean);
      if (row.kind === 'partition') emitPartitions(tokens);
      else if (row.kind === 'field') setFieldOptions(row.fieldName, tokens);
    }
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
            <span className="page-hero-crumb">{room.title || 'workspace'}<span className="page-hero-slash">/</span>{entityType}</span>
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
              <div className="schema-stat-sub" title={stats.lastSender?.mxid || ''}>
                {stats.lastSender?.mxid ? `by ${stats.lastSender.mxid.replace(/^@/, '').split(':')[0]}` : '—'}
              </div>
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
            {partitioned && <span className="page-section-sub">partitioned</span>}
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
                          {(r.isPk || r.rawType === 'formula') && <span className="formula-glyph" title="formula field">ƒ </span>}
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
                            placeholder={r.kind === 'partition' ? 'backlog, doing, done' : r.rawType === 'formula' ? 'RECORD_ID()  ·  UPPER({Name})  ·  CONCATENATE({title}, \" (\", {status}, \")\")' : 'value-a, value-b, value-c'}
                          />
                          {(r.rawType === 'select' || r.rawType === 'multiselect') && (() => {
                            // Surface the values actually present in the data so options can be
                            // reconciled with reality. Chips not yet in the draft are clickable;
                            // onMouseDown keeps the input focused so its onBlur won't commit first.
                            const tokens = draft.split(',').map(s => s.trim()).filter(Boolean);
                            const missing = collectFieldValues(state, entityType, r.fieldName).filter(v => !tokens.includes(v));
                            if (missing.length === 0) return null;
                            return (
                              <div className="schema-found-in-data">
                                <span className="schema-found-label">in data:</span>
                                {missing.map(v => (
                                  <button
                                    key={v}
                                    type="button"
                                    className="param-chip param-chip-suggested"
                                    title="click to add as an option"
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      setDraft(d => {
                                        const cur = d.split(',').map(s => s.trim()).filter(Boolean);
                                        if (cur.includes(v)) return d;
                                        return [...cur, v].join(', ');
                                      });
                                    }}
                                  >{v}<span className="ctm-chip-plus" aria-hidden="true">+</span></button>
                                ))}
                              </div>
                            );
                          })()}
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
                    {newField.type === 'multiselect' ? 'append' : newField.type === 'formula' ? 'compute' : 'overwrite'}
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
                {false && otherTables.length > 0 && (
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
    return r.rawType === 'select' || r.rawType === 'multiselect' || r.rawType === 'formula' || r.rawType === 'rollup';
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
    if (r.rawType === 'formula') {
      if (!r.formula) return <span style={{color:'var(--text-faint)',fontStyle:'italic'}}>(no formula — double-click · e.g. RECORD_ID())</span>;
      return <code style={{color:'var(--text-bright)'}}>{r.formula}</code>;
    }
    if (r.rawType === 'rollup') {
      if (!r.rollup || !r.rollup.via) return <span style={{color:'var(--text-faint)',fontStyle:'italic'}}>(no rollup — double-click · e.g. sum(estimate_h) via blocks)</span>;
      return <code style={{color:'var(--text-bright)'}}>{r.params}</code>;
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
          <span className="schema">{room.title || 'workspace'}</span><span className="dot">.</span>_synthesis
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
          <span className="schema">{room.title || 'workspace'}</span><span className="dot">.</span>_connections
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
          <span className="schema">{room.title || 'workspace'}</span><span className="dot">.</span>_schema
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

function CreateTableForm({ state, room, onEmit, onCancel, defaultName = '' }) {
  const [name, setName]   = React.useState(defaultName);
  const [fields, setFields] = React.useState([
    { name: 'Name', type: 'text' },
    { name: '',     type: 'text' },
  ]);
  const nameRef = React.useRef(null);
  React.useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);

  const existing  = state.schema?.tables || [];
  const trimmed   = name.trim();
  const collides  = trimmed && existing.includes(trimmed);
  const canCreate = !!trimmed && !collides;

  function updateField(i, patch) { setFields(fs => fs.map((f, j) => j === i ? { ...f, ...patch } : f)); }
  function addField()           { setFields(fs => [...fs, { name: '', type: 'text' }]); }
  function removeField(i)       { setFields(fs => fs.filter((_, j) => j !== i)); }

  function commit() {
    if (!canCreate) return;
    const ME = window.MatrixEngine || { OP: TV_OP };
    const tableName = trimmed;

    // De-dupe field names; fall back to "Field N" if blank.
    const seen = new Set();
    const cleanFields = fields.map((f, i) => {
      let n = (f.name || '').trim() || (i === 0 ? 'Name' : `Field ${i + 1}`);
      let suffix = 2;
      const original = n;
      while (seen.has(n)) { n = `${original} ${suffix++}`; }
      seen.add(n);
      const out = { name: n, type: f.type };
      if (f.type === 'select' || f.type === 'multiselect') out.options = [];
      return out;
    });

    // 1. declare table
    onEmit(TV_OP.DEF, { anchor: null, path: '_schema.tables', value: existing.includes(tableName) ? existing : [...existing, tableName] });
    // 2. declare fields
    onEmit(TV_OP.DEF, { anchor: null, path: `_schema.fields.${tableName}`, value: cleanFields });
    // 3. seed one empty row so the user lands on a typeable grid, not an empty state.
    if (ME.makeAnchor && ME.OP) {
      const ts = Date.now();
      const anchor = ME.makeAnchor(tableName, {}, '@you:demo', ts);
      onEmit(ME.OP.INS, { anchor, entity_type: tableName, payload: {} });
    }

    onCancel();
  }

  function onNameKey(e) {
    if (e.key === 'Enter' && canCreate) { e.preventDefault(); commit(); }
    if (e.key === 'Escape')             { e.preventDefault(); onCancel(); }
  }

  return (
    <div className="ct-form">
      <div className="ct-head">
        <div className="ct-eyebrow">new set</div>
        <input
          ref={nameRef}
          className="ct-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={onNameKey}
          placeholder="table name · e.g. tasks, contacts, invoices"
        />
        {collides && (
          <div className="ct-warn">a set called <b>{trimmed}</b> already exists in this room.</div>
        )}
      </div>

      <div className="ct-fields-head">
        <span>fields</span>
        <span className="ct-fields-sub">add more columns later from the grid · the first field is the primary identifier</span>
      </div>

      <div className="ct-fields">
        {fields.map((f, i) => (
          <div key={i} className={`ct-field-row ${i === 0 ? 'primary' : ''}`}>
            <span className="ct-field-num" title={i === 0 ? 'primary field' : `field ${i + 1}`}>
              {i === 0 ? '★' : i + 1}
            </span>
            <input
              className="ct-field-name"
              value={f.name}
              onChange={e => updateField(i, { name: e.target.value })}
              placeholder={i === 0 ? 'Name' : `Field ${i + 1}`}
            />
            <select
              className="ct-field-type"
              value={f.type}
              onChange={e => updateField(i, { type: e.target.value })}
              title={FIELD_TYPES.find(t => t.value === f.type)?.hint || ''}
            >
              {FIELD_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <button
              className="ct-field-remove"
              onClick={() => removeField(i)}
              disabled={fields.length === 1}
              title={fields.length === 1 ? "can't remove the only field" : 'remove field'}
            >×</button>
          </div>
        ))}
        <button className="ct-add-field" onClick={addField}>+ add field</button>
      </div>

      <div className="ct-actions">
        <button className="ct-cancel" onClick={onCancel}>cancel</button>
        <button className="ct-create" onClick={commit} disabled={!canCreate}>
          create {trimmed ? `"${trimmed}"` : 'set'}
        </button>
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
    // _schema isn't its own set — every set carries its own schema, reachable by clicking the set name in the sidebar.
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
          <h2>{room.title || 'untitled workspace'}</h2>
          <span className="crumb">projection · {tables.length} set{tables.length!==1?'s':''} · {Object.keys(state.entities).length} rows · {state.connections.length} edges</span>
          <div className="right">
            one set at a time — like airtable.
            spaces = bases · sets = entity types · a <b>table</b> is one projection · <b>CON</b> edges = linked records.
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
            title="declare a new set in _schema"
          >
            <span className="tname">+ new set</span>
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
            <div>no sets in this room yet.</div>
            <div style={{marginTop:6,fontSize:11.5}}>creating a set writes its shape into the log as <span className="kbd">DEF _schema.*</span> events.</div>
            <div style={{marginTop:14}}>
              <button
                onClick={() => setCreating(true)}
                style={{padding:'6px 14px',background:'#000',color:'#fff',border:'1px solid #000',fontSize:12,cursor:'pointer'}}
              >+ create your first set</button>
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
