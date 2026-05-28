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
    return { cls: `date ${f.tone}`, text: f.text, sub: f.sub, tzLabel: f.tzLabel, title: f.title };
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

// ─────────────────────────────────────────────────────────────────────────
// Timezone-aware date formatting.
// Stored values are ISO strings (sometimes date-only `YYYY-MM-DD`, sometimes
// full RFC3339). For date-only, we skip timezone conversion entirely — there
// is no instant to project. For datetimes, we project into opts.timezone
// (IANA id) or the browser's local zone.
// ─────────────────────────────────────────────────────────────────────────

const BROWSER_TZ = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

const DEFAULT_DATE_OPTS = {
  format: 'friendly',     // 'friendly' | 'absolute' | 'relative' | 'iso'
  includeTime: false,
  hour12: false,
  showSeconds: false,
  showWeekday: false,
  showYear: 'auto',       // 'auto' | 'always' | 'never'
  timezone: 'local',      // 'local' | 'utc' | IANA id
  showRelativeSub: false, // render a small relative-time sub-line below the cell
};

// Curated, no-dependencies tz menu. The text input below it accepts any IANA id.
const COMMON_TZS = [
  'local',
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Athens',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function isDateOnly(raw) {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

// Extract Y/M/D/H/m/s/weekday of `d` rendered in IANA tz `tz`.
function partsInTz(d, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    const out = {};
    for (const p of fmt.formatToParts(d)) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    return {
      year: +out.year, month: +out.month, day: +out.day,
      hour: +out.hour, minute: +out.minute, second: +out.second,
      weekday: out.weekday,
    };
  } catch {
    return {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
      hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
      weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()],
    };
  }
}

// Short tz badge — "PDT", "JST", "UTC+5:30" — for the inline pill.
function tzShortLabel(d, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d);
    const name = parts.find(p => p.type === 'timeZoneName')?.value || '';
    if (name && !/^GMT[+-]/.test(name)) return name;
    return name || tz.split('/').pop();
  } catch { return tz; }
}

function tzOffsetLabel(d, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d);
    return parts.find(p => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

// Resolve the timezone string from opts.
function resolveTz(opts) {
  const t = opts && opts.timezone;
  if (!t || t === 'local' || t === 'auto') return BROWSER_TZ;
  if (t === 'utc' || t === 'UTC') return 'UTC';
  return t;
}

// Day index in tz, used to compute "today/tomorrow" stable across DST.
function dayKey(parts) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

// One human-friendly relative phrase. `nowMs` is the comparison point.
function formatRelative(targetMs, nowMs, opts = {}) {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const past = diff < 0;
  // Less than a minute → "just now"
  if (abs < 45_000) return past ? 'just now' : 'in a moment';
  const MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;
  let n, unit;
  if (abs < HR)              { n = Math.round(abs / MIN); unit = 'min'; }
  else if (abs < DAY)        { n = Math.round(abs / HR);  unit = 'h';   }
  else if (abs < 30 * DAY)   { n = Math.round(abs / DAY); unit = 'd';   }
  else if (abs < 365 * DAY)  { n = Math.round(abs / (30 * DAY)); unit = 'mo'; }
  else                       { n = Math.round(abs / (365 * DAY)); unit = 'y'; }
  if (opts.long) {
    const word = { min: 'minute', h: 'hour', d: 'day', mo: 'month', y: 'year' }[unit];
    const plural = n === 1 ? word : word + 's';
    return past ? `${n} ${plural} ago` : `in ${n} ${plural}`;
  }
  return past ? `${n}${unit} ago` : `in ${n}${unit}`;
}

// Format an absolute date+time string using opts and a target IANA tz.
function formatAbsolute(d, opts, tz) {
  const dtOpts = {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
  };
  // Year handling: 'auto' (only when different from current local year), 'always', 'never'.
  const showYear = opts.showYear || 'auto';
  const nowYear = partsInTz(new Date(), tz).year;
  const dYear = partsInTz(d, tz).year;
  if (showYear === 'always' || (showYear === 'auto' && dYear !== nowYear)) {
    dtOpts.year = 'numeric';
  }
  if (opts.showWeekday) dtOpts.weekday = 'short';
  if (opts.includeTime) {
    dtOpts.hour = 'numeric';
    dtOpts.minute = '2-digit';
    if (opts.showSeconds) dtOpts.second = '2-digit';
    dtOpts.hour12 = !!opts.hour12;
  }
  try { return new Intl.DateTimeFormat(undefined, dtOpts).format(d); }
  catch { return d.toLocaleString(); }
}

// Friendly cell display: "today, 3:42 PM" / "yesterday" / "in 3d" / "May 28 · PDT".
function formatDateCell(value, opts = {}) {
  if (value === undefined || value === null || value === '') return { text: '', sub: '', title: '', tone: '', tzLabel: '' };
  const raw = String(value);
  const dateOnly = isDateOnly(raw);
  // For date-only values, build a noon-local Date so toLocaleDateString lands on
  // the same calendar day regardless of viewer's tz.
  const d = dateOnly ? new Date(raw + 'T12:00:00') : new Date(raw);
  if (isNaN(d.getTime())) return { text: '#date', sub: '', title: String(value), tone: 'date-invalid', tzLabel: '' };

  const tz = dateOnly ? BROWSER_TZ : resolveTz(opts);
  const now = new Date();
  const targetParts = partsInTz(d, tz);
  const todayParts  = partsInTz(now, tz);

  // diffDays: how many calendar days apart in the display timezone.
  const targetMid = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
  const todayMid  = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
  const diffDays = Math.round((targetMid - todayMid) / DAY_MS);

  const includeTime = !dateOnly && !!opts.includeTime;
  const abs = formatAbsolute(d, { ...opts, includeTime }, tz);

  // Time-only fragment for "today, 3:42 PM" friendly mode.
  let timeFrag = '';
  if (includeTime) {
    try {
      timeFrag = new Intl.DateTimeFormat(undefined, {
        timeZone: tz, hour: 'numeric', minute: '2-digit',
        second: opts.showSeconds ? '2-digit' : undefined,
        hour12: !!opts.hour12,
      }).format(d);
    } catch { timeFrag = ''; }
  }

  const fmt = opts.format || opts.dateFormat || 'friendly';
  let text;
  if (fmt === 'iso') {
    text = dateOnly ? raw : d.toISOString();
  } else if (fmt === 'absolute') {
    text = abs;
  } else if (fmt === 'relative') {
    text = formatRelative(d.getTime(), now.getTime(), { long: false });
  } else { // friendly
    if (diffDays === 0)       text = timeFrag ? `today, ${timeFrag}` : 'today';
    else if (diffDays === -1) text = timeFrag ? `yesterday, ${timeFrag}` : 'yesterday';
    else if (diffDays === 1)  text = timeFrag ? `tomorrow, ${timeFrag}` : 'tomorrow';
    else if (diffDays >= -7 && diffDays < 0) text = `${-diffDays}d ago${timeFrag ? `, ${timeFrag}` : ''}`;
    else if (diffDays > 1 && diffDays <= 7)  text = `in ${diffDays}d${timeFrag ? `, ${timeFrag}` : ''}`;
    else text = abs;
  }

  // Optional sub-line — opposite of whatever's in the headline.
  let sub = '';
  if (opts.showRelativeSub) {
    if (fmt === 'friendly' || fmt === 'iso' || fmt === 'absolute') {
      // headline is absolute-ish → sub gets relative
      if (Math.abs(diffDays) > 7 || fmt === 'iso' || fmt === 'absolute') {
        sub = formatRelative(d.getTime(), now.getTime(), { long: false });
      }
    } else if (fmt === 'relative') {
      sub = abs;
    }
  }

  // Tooltip — multi-line, rich.
  const tooltipLines = [
    abs,
    formatRelative(d.getTime(), now.getTime(), { long: true }),
  ];
  if (!dateOnly) {
    const offset = tzOffsetLabel(d, tz);
    const tzShort = tzShortLabel(d, tz);
    if (tz !== BROWSER_TZ) tooltipLines.push(`${tzShort} (${offset}) · ${tz}`);
    else if (offset)       tooltipLines.push(`${tzShort} ${offset}`);
    tooltipLines.push(d.toISOString());
  }
  const title = tooltipLines.join('  ·  ');

  // tz badge: only shown when the display tz differs from the browser's,
  // and only for instants (not date-only).
  const tzLabel = (!dateOnly && tz !== BROWSER_TZ) ? tzShortLabel(d, tz) : '';

  // Conditional formatting tone.
  let tone = '';
  if (diffDays < 0) tone = 'date-past';
  else if (diffDays === 0) tone = 'date-today';
  else if (diffDays <= 7) tone = 'date-soon';
  else tone = 'date-future';

  return { text, sub, title, tone, tzLabel };
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

function FormulaCell({ formula, record, state, events, fieldName, entityType }) {
  const r = (window.Formula && window.Formula.evaluate)
    ? window.Formula.evaluate(formula, { record, state, events, entityType })
    : { ok: false, value: null, error: 'formula.js not loaded' };
  // EVA failure check — does the host entity have a failed evaluation tagged to this field's name?
  const failedEva = (events && record?._anchor && fieldName)
    ? (window.Formula?.Field?.evaluations(events, record._anchor, fieldName) || []).slice(-1)[0]
    : null;
  const evaFailed = failedEva && failedEva.result === 'fail';
  if (!r.ok) {
    return (
      <td className="cell formula has-error" title={`formula error · ${r.error}\n= ${formula || ''}`}>
        <span className="em">#ERR</span>
      </td>
    );
  }
  const { cls, text } = fmtCell(r.value, typeof r.value === 'number' ? 'number' : 'text');
  return (
    <td className={`cell formula ${cls} ${evaFailed ? 'eva-failed' : ''}`} title={(formula ? `= ${formula}` : 'formula · set the expression in the schema view') + (evaFailed ? `\n⊨ EVA failed · ${failedEva.criterion}${failedEva.note ? ' — ' + failedEva.note : ''}` : '')}>
      {text}
      {evaFailed && <span className="eva-mark" title={`⊨ ${failedEva.criterion}: ${failedEva.result}`}>⊨</span>}
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

function EditableCell({ value, onCommit, type, heat, shouldFocus, onFocusConsumed, onNavigate, events, anchor, fieldName, options, dateOpts }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  // EVA validation indicator — does this entity have a failed EVA whose
  // criterion or note mentions this field, or which is explicitly tagged
  // to this field via content.field? Surfaces as a subtle ⊨ glyph.
  const failedEva = (events && anchor && fieldName)
    ? (window.Formula?.Field?.evaluations(events, anchor) || [])
        .filter(e => e.result === 'fail' && (
          e.field === fieldName ||
          String(e.criterion || '').toLowerCase() === String(fieldName).toLowerCase() ||
          String(e.note || '').toLowerCase().includes('{' + String(fieldName).toLowerCase() + '}')
        ))
        .slice(-1)[0]
    : null;

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
    } else if (type === 'date') {
      // Smart parse: keep ISO if already so, else best-effort. Empty draft → ''.
      if (draft && draft.trim()) {
        const t = window.Formula?.parseDateLike ? window.Formula.parseDateLike(draft) : Date.parse(draft);
        if (t != null && !isNaN(t)) parsed = new Date(t).toISOString();
      }
    }
    if (parsed !== value) onCommit(parsed);
  }
  function commitAndNavigate(dir) {
    commit();
    if (onNavigate) onNavigate(dir);
  }

  if (editing) {
    // Date type → native date or datetime picker (airtable-style); also accepts free text on blur.
    if (type === 'date') {
      const wantsTime = !!(dateOpts && dateOpts.includeTime);
      if (wantsTime) {
        // For datetime-local we need a `YYYY-MM-DDTHH:MM` string in local tz.
        let dtLocal = '';
        if (draft) {
          const parsed = new Date(draft);
          if (!isNaN(parsed.getTime())) {
            const pad = (n) => String(n).padStart(2, '0');
            dtLocal = `${parsed.getFullYear()}-${pad(parsed.getMonth()+1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
          }
        }
        return (
          <td className="cell editing date-editing">
            <input
              ref={inputRef}
              type="datetime-local"
              value={dtLocal}
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
      const isoDay = draft && /^\d{4}-\d{2}-\d{2}/.test(draft) ? draft.slice(0, 10) : '';
      return (
        <td className="cell editing date-editing">
          <input
            ref={inputRef}
            type="date"
            value={isoDay}
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
    // Single-select → dropdown of the declared options.
    if (type === 'select' && Array.isArray(options) && options.length) {
      return (
        <td className="cell editing">
          <select
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitAndNavigate('enter'); }
              else if (e.key === 'Tab') { e.preventDefault(); commitAndNavigate(e.shiftKey ? 'shift-tab' : 'tab'); }
              else if (e.key === 'Escape') setEditing(false);
            }}
          >
            <option value="">—</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </td>
      );
    }
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
  const { cls, text, sub, tzLabel } = fmtCell(value, type, type === 'date' ? (dateOpts || {}) : undefined);
  const heatCls = heat ? heatClass(heat) : '';
  const evaFailed = !!failedEva;
  const baseTitle = heat ? `${heat} write${heat===1?'':'s'} · click to edit` : 'click to edit · emits DEF';
  const evaTitle = evaFailed ? `\n⊨ EVA failed · ${failedEva.criterion}${failedEva.note ? ' — ' + failedEva.note : ''}` : '';
  const dateTitle = type === 'date' && fmtCell(value, type, dateOpts || {}).title;
  const titleText = (dateTitle ? dateTitle + '\n' : '') + baseTitle + evaTitle;
  return (
    <td className={`cell ${cls} ${heatCls} ${evaFailed ? 'eva-failed' : ''}`} onClick={startEdit} title={titleText}>
      <span className="cell-main">{text}</span>
      {tzLabel && <span className="date-tz-pill" aria-hidden="true">{tzLabel}</span>}
      {sub && <span className="cell-sub">{sub}</span>}
      {evaFailed && <span className="eva-mark">⊨</span>}
    </td>
  );
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
    cols = schemaFields.map(f => ({ name: f.name, type: f.type, options: f.options, formula: f.formula, rollup: f.rollup, dateOpts: f.dateOpts, schematized: true }));
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
// One table
// ─────────────────────────────────────────────────────────────────────────

function DbTable({ entityType, state, room, onEmit, onJump, jumpHighlight, showDDL, setSelection, allEventsInRoom }) {
  const events = allEventsInRoom || [];
  const { cols, rows, partitioned, partitionFromSchema } = useMemo(() => buildTable(entityType, state), [entityType, state]);
  const linkedTypes = useMemo(() => linkedTypesFor(entityType, state), [entityType, state]);
  const declaredInSchema = !!state.schema?.fields?.[entityType] || (state.schema?.tables || []).includes(entityType);
  const [heatOn, setHeatOn] = useState(false);
  const [showFormula, setShowFormula] = useState(false);
  // Header-rename mode for one column at a time. {oldName, draft}.
  const [renamingField, setRenamingField] = useState(null);
  // Right-click column-type picker. {name, x, y} | null
  const [colMenu, setColMenu] = useState(null);
  const scrollRef = useRef(null);

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
      if (newType !== 'date') delete u.dateOpts;
      else if (!u.dateOpts) u.dateOpts = { ...DEFAULT_DATE_OPTS };
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
    if (type === 'date')    newField.dateOpts = { ...DEFAULT_DATE_OPTS };
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

  function nextEditableCol(startIdx, step) {
    for (let i = startIdx; i >= 0 && i < cols.length; i += step) {
      if (cols[i].type !== 'formula' && cols[i].type !== 'rollup') return i;
    }
    return -1;
  }

  function navigate(rowIdx, colIdx, dir) {
    if (dir === 'tab') {
      const next = nextEditableCol(colIdx + 1, 1);
      if (next !== -1) {
        setPendingFocus({ anchor: rows[rowIdx]._anchor, field: cols[next].name });
      } else if (rowIdx === rows.length - 1) {
        const first = nextEditableCol(0, 1);
        const newAnchor = addRow();
        if (first !== -1) setPendingFocus({ anchor: newAnchor, field: cols[first].name });
      } else {
        const first = nextEditableCol(0, 1);
        if (first !== -1) setPendingFocus({ anchor: rows[rowIdx + 1]._anchor, field: cols[first].name });
      }
    } else if (dir === 'shift-tab') {
      const prev = nextEditableCol(colIdx - 1, -1);
      if (prev !== -1) {
        setPendingFocus({ anchor: rows[rowIdx]._anchor, field: cols[prev].name });
      } else if (rowIdx > 0) {
        const last = nextEditableCol(cols.length - 1, -1);
        if (last !== -1) setPendingFocus({ anchor: rows[rowIdx - 1]._anchor, field: cols[last].name });
      }
    } else if (dir === 'enter') {
      if (rowIdx === rows.length - 1) {
        const first = nextEditableCol(0, 1);
        const newAnchor = addRow();
        if (first !== -1) setPendingFocus({ anchor: newAnchor, field: cols[first].name });
      } else {
        setPendingFocus({ anchor: rows[rowIdx + 1]._anchor, field: cols[colIdx].name });
      }
    }
  }

  function addRowAndFocus() {
    if (cols.length === 0) return;
    const first = nextEditableCol(0, 1);
    const newAnchor = addRow();
    if (first !== -1) setPendingFocus({ anchor: newAnchor, field: cols[first].name });
  }

  const allCols = [
    ...(showFormula ? [{ name: '_anchor', type: 'pk', isPk: true, schematized: true }] : []),
    // derived columns (partition + linked) sit on the LEFT, so user-defined
    // schema fields cluster on the right and new "+ add field" columns always
    // appear at the rightmost edge of the grid.
    ...(partitioned ? [{ name: '_partition', type: 'partition', schematized: partitionFromSchema }] : []),
    ...linkedTypes.map(t => ({ name: t, type: 'linked', schematized: true })),
    ...cols,
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
          <span className="schema">{room.title || 'workspace'}</span><span className="dot">.</span>{entityType}
          {!declaredInSchema && <span style={{color:'var(--signal)',marginLeft:8,fontWeight:400}}>? unschematized</span>}
        </div>
        <div className="meta">
          {rows.length} row{rows.length!==1?'s':''}
          <button
            className={`heat-toggle ${heatOn ? 'on' : ''}`}
            onClick={() => setHeatOn(o => !o)}
            title="color cells by number of DEF writes per path"
          >heat map</button>
        </div>
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
                // Operator-typed glyph for formula columns. Classified by the formula's structure;
                // rollup is structurally aggregation (△ SYN). pk is identity (● INS).
                const fclass = isFormula ? (window.Formula?.classify ? window.Formula.classify(c.formula || '') : null) : null;
                const glyphChar = c.isPk ? '●' : isRollup ? '△' : (fclass?.glyph || 'ƒ');
                const glyphLabel = c.isPk ? 'INS · identity' : isRollup ? 'SYN · synthesis (rollup)' : (fclass ? `${fclass.op} · ${fclass.label}` : 'formula');
                const headerTitle = c.isPk
                  ? '_anchor · formula field, derived from INS payload'
                  : isFormula
                    ? (c.formula ? `${glyphLabel}\n= ${c.formula}` : `${glyphLabel} · click to set the expression`)
                    : isRollup
                      ? (c.rollup?.via ? `△ rollup: ${c.rollup.fn || 'count'}(${c.rollup.field || ''}) via ${c.rollup.via}` : '△ rollup field · click to set via / field / fn')
                      : (c.schematized === false ? 'in data but not in _schema' : canEdit ? 'click to edit field · rename, change type, set params' : '');
                const openMenu = (canEdit && !isRenaming) ? (e) => {
                  // never hijack clicks inside the inline rename input
                  if (e.target.tagName === 'INPUT') return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setColMenu({ name: c.name, currentType: c.type, options: c.options, formula: c.formula, rollup: c.rollup, dateOpts: c.dateOpts, x: r.left, y: r.bottom });
                } : undefined;
                return (
                  <th key={c.name} className={`${c.isPk ? 'pk' : ''} ${c.schematized === false ? 'unschematized' : ''} ${showGlyph ? 'formula' : ''} ${canEdit ? 'editable' : ''}`}
                      title={headerTitle}
                      onClick={openMenu}
                      onContextMenu={openMenu}>
                    {showGlyph && <span className={`formula-glyph op-${c.isPk ? 'ins' : isRollup ? 'syn' : (fclass?.op || 'def').toLowerCase()}`} title={glyphLabel}>{glyphChar} </span>}
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
          <tbody>
            {rows.map((r, rIdx) => (
              <tr key={r._anchor}>
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
                {cols.map((c, cIdx) => (
                  c.type === 'formula' ? (
                    <FormulaCell key={c.name} formula={c.formula} record={r} state={state} events={events} fieldName={c.name} entityType={entityType} />
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
                      events={events}
                      anchor={r._anchor}
                      fieldName={c.name}
                      options={c.options}
                      dateOpts={c.dateOpts}
                    />
                  )
                ))}
                <td className="cell add-col-spacer" title="open this row's timeline" onClick={() => setSelection && setSelection({
                  kind: 'slice',
                  sliceId: `${entityType}.timeline.${r._anchor}`,
                  sliceKind: 'timeline',
                  tableId: entityType,
                  entityAnchor: r._anchor,
                })}>⏚</td>
              </tr>
            ))}

            {/* Heat-map summary row */}
            {heatOn && rows.length > 0 && (
              <tr className="heat-summary">
                {showFormula && <td className="cell" style={{fontSize:11,color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'1.2px',fontWeight:700}}>avg writes</td>}
                {partitioned && <td className="cell"></td>}
                {linkedTypes.map(t => <td key={t} className="cell hs-link"></td>)}
                {!showFormula && cols.length > 0 && !partitioned && linkedTypes.length === 0 && <td className="cell" style={{fontSize:11,color:'var(--text-dim)',textTransform:'uppercase',letterSpacing:'1.2px',fontWeight:700}}></td>}
                {cols.map((c, i) => {
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
            {cols.length > 0 && (
              <tr className="add-row" onClick={addRowAndFocus} title="click to add a row · or hit Enter from the last cell">
                {showFormula && <td className="cell anchor add-row-gutter"><span className="add-row-plus">+</span></td>}
                <td className="cell add-row-cell" colSpan={cols.length + (partitioned ? 1 : 0) + linkedTypes.length + 1}>
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
          {!colMenu.creating && (colMenu.currentType === 'formula' || colMenu.currentType === 'rollup' || colMenu.currentType === 'select' || colMenu.currentType === 'multiselect' || colMenu.currentType === 'date') && (
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
    </div>
  );
}

function sqlType(t) {
  return { text: 'TEXT', number: 'INTEGER', boolean: 'BOOLEAN', json: 'JSONB', select: 'TEXT', multiselect: 'TEXT[]', longtext: 'TEXT', date: 'TIMESTAMP', url: 'TEXT', email: 'TEXT', partition: 'TEXT', linked: 'LINK', formula: 'FORMULA' }[t] || 'TEXT';
}

// Short docs for the most commonly used functions (used by the autocomplete
// popover when a suggestion is hovered/active). Falls back to empty hint.
// We delegate to window.Formula.HINTS at runtime so this stays in lockstep
// with formula.js — the local map below is just a fallback / smaller subset.
const FORMULA_HINTS = (window.Formula && window.Formula.HINTS) ? window.Formula.HINTS : {
  SUM: 'SUM(num, …) → total', AVG: 'AVG(num, …)', IF: 'IF(cond, then, else)',
  CONCATENATE: 'CONCATENATE(a, …)', UPPER: 'UPPER(s)', LOWER: 'LOWER(s)',
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
  // Real (stored) fields PLUS linked-record column names (entity types this
  // table connects to). Linked refs resolve to an array of linked-row labels
  // at evaluate time — same value the cell renders.
  const realFields = (state.schema?.fields?.[entityType] || []).map(f => f.name);
  const linkSet = new Set();
  for (const l of (state.schema?.links || [])) {
    if (l.from === entityType) linkSet.add(l.to);
    if (l.to === entityType)   linkSet.add(l.from);
  }
  const fields = [...realFields, ...[...linkSet].filter(n => !realFields.includes(n))];

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
    // ⏎ (without suggestions) or ⌘/Ctrl+⏎ → save. Shift+⏎ inserts a newline.
    if (e.key === 'Enter' && !sugg && !e.shiftKey) {
      e.preventDefault();
      commit();
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
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            recomputeSuggestions();
            // Live commit — every keystroke writes the formula. Matches Airtable
            // and avoids the lost-on-unmount bug where clicking outside the menu
            // never fires onBlur.
            if (v !== (value || '')) onCommit(v);
          }}
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
        type <code>{'{'}</code> for fields · letters for functions · ↑↓ to nav · ⏎/⇥ to accept · saves as you type
      </div>
    </div>
  );
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
      </div>
    );
  }
  if (t === 'date') {
    return <DateParams menu={menu} onPatch={onPatch} />;
  }
  return null;
}

function DateParams({ menu, onPatch }) {
  const opts = { ...DEFAULT_DATE_OPTS, ...(menu.dateOpts || {}) };
  const set = (patch) => onPatch({ dateOpts: { ...opts, ...patch } });

  // Live preview, refreshed on each render — uses the current instant.
  const sample = new Date();
  const preview = formatDateCell(sample.toISOString(), opts);

  return (
    <div className="ctm-params date-params">
      <div className="ctm-section-label">display</div>

      <div className="dp-row dp-segmented">
        {[
          { v: 'friendly', l: 'friendly', h: 'today · in 3d · May 28' },
          { v: 'absolute', l: 'absolute', h: 'May 28, 3:42 PM' },
          { v: 'relative', l: 'relative', h: '3d ago · in 2mo' },
          { v: 'iso',      l: 'iso',      h: '2026-05-28T15:42…' },
        ].map(o => (
          <button
            key={o.v}
            className={`dp-seg ${opts.format === o.v ? 'on' : ''}`}
            onClick={() => set({ format: o.v })}
            title={o.h}
          >{o.l}</button>
        ))}
      </div>

      <div className="dp-row dp-toggles">
        <label className="dp-toggle">
          <input type="checkbox" checked={!!opts.includeTime} onChange={e => set({ includeTime: e.target.checked })} />
          <span>include time</span>
        </label>
        <label className={`dp-toggle ${!opts.includeTime ? 'is-disabled' : ''}`}>
          <input type="checkbox" disabled={!opts.includeTime} checked={!!opts.hour12} onChange={e => set({ hour12: e.target.checked })} />
          <span>12-hour</span>
        </label>
        <label className={`dp-toggle ${!opts.includeTime ? 'is-disabled' : ''}`}>
          <input type="checkbox" disabled={!opts.includeTime} checked={!!opts.showSeconds} onChange={e => set({ showSeconds: e.target.checked })} />
          <span>seconds</span>
        </label>
        <label className="dp-toggle">
          <input type="checkbox" checked={!!opts.showWeekday} onChange={e => set({ showWeekday: e.target.checked })} />
          <span>weekday</span>
        </label>
        <label className="dp-toggle">
          <input type="checkbox" checked={!!opts.showRelativeSub} onChange={e => set({ showRelativeSub: e.target.checked })} />
          <span>relative sub</span>
        </label>
      </div>

      <div className="dp-row dp-pair">
        <label>year</label>
        <select value={opts.showYear} onChange={e => set({ showYear: e.target.value })}>
          <option value="auto">auto · if different from current</option>
          <option value="always">always</option>
          <option value="never">never</option>
        </select>
      </div>

      <div className="dp-row dp-pair">
        <label>timezone</label>
        <select value={opts.timezone} onChange={e => set({ timezone: e.target.value })}>
          {COMMON_TZS.map(tz => {
            const lbl = tz === 'local' ? `local · ${BROWSER_TZ}` : tz;
            return <option key={tz} value={tz}>{lbl}</option>;
          })}
          {!COMMON_TZS.includes(opts.timezone) && <option value={opts.timezone}>{opts.timezone}</option>}
        </select>
      </div>

      <div className="dp-row dp-pair">
        <label>custom tz</label>
        <input
          type="text"
          className="dp-tz-input"
          placeholder="IANA id · e.g. America/Argentina/Buenos_Aires"
          defaultValue={COMMON_TZS.includes(opts.timezone) ? '' : opts.timezone}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) return;
            try { new Intl.DateTimeFormat('en-US', { timeZone: v }); set({ timezone: v }); }
            catch { /* ignore invalid */ }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        />
      </div>

      <div className="ctm-section-label">preview</div>
      <div className="dp-preview">
        <div className="dp-preview-row">
          <span className={`dp-preview-cell date ${preview.tone}`}>
            <span>{preview.text}</span>
            {preview.tzLabel && <span className="date-tz-pill">{preview.tzLabel}</span>}
          </span>
          {preview.sub && <span className="dp-preview-sub">{preview.sub}</span>}
        </div>
        <div className="dp-preview-meta">{preview.title}</div>
      </div>
    </div>
  );
}

function fmtAbsDate(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
function fmtRelTime(ts) {
  if (!ts) return '';
  return formatRelative(ts, Date.now(), { long: false });
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

function TableView({ room, state, onEmit, tweaks, scrubber, forceTable, hideHead, setSelection, allEventsInRoom }) {
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
            allEventsInRoom={allEventsInRoom || []}
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
