/* ============================================================================
   data-chat.js — chat-with-your-data bridge (window.DataChat)

   Turns a natural-language question into a STRUCTURED query over the fold
   `state` (the same { entities, connections, schema } the table/graph views
   read), and returns a render-ready result the Ask view paints:

     { kind: 'table',   type, title, columns, rows, spec, note }
     { kind: 'value',   label, value, note, spec }       // count / sum / calc
     { kind: 'profile', anchor, type }                   // open the popup
     { kind: 'answer',  text, records, audit }            // prose fallback
     { kind: 'empty',   message, suggestions }
     { kind: 'confirm', reason, text, choices, spec }    // "which table?" /
                                                          // "show all of these?"
                                                          // — choices carry a
                                                          // ready-to-run plan

   Design: the query layer (type/field/value resolution, filters, aggregation,
   sort, foreign-key traversal) is PURE and deterministic — it runs in Node
   with no engine present, which is why test/data-chat.test.cjs can exercise it
   headlessly. The Cleo engine — loaded lazily from the eoreader3 deployment
   (it lives in that repo; see eoreaderBase()) — is an *enhancer*:

     • window.EOCompute  → catches arithmetic turns ("3 × the open tasks")
     • window.EOEmbed    → fuzzy-matches a field/value/record the lexer missed
     • window.EOEngine   → a phrased, grounded answer for prose questions

   Everything degrades cleanly: no engine ⇒ lexical matching + a record search.
   Read-only by contract: this module never emits an operator. It reads state.
   ============================================================================ */
(function () {
  'use strict';

  // ── small utils ───────────────────────────────────────────────────────────
  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const norm = (s) => lc(s).replace(/[_\s]+/g, ' ').trim();
  // accent-folded normal form — so "mexico" matches "México" and "jose" ↔ "José"
  // (immigration data is full of accented place/people names). Used by value
  // matching + the filter executor so what we find is what we filter on.
  const nfold = (s) => { try { return norm(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { return norm(s); } };
  const isUnderscore = (k) => typeof k === 'string' && k[0] === '_';
  const uniq = (a) => Array.from(new Set(a));

  // ── per-state index (one O(N) pass, reused across helpers) ──────────────────
  // The query pipeline + the LLM schema prompt call knownTypes / entitiesOfType
  // / fieldsForType / relatedRecords many times for a single question — each a
  // full Object.values(entities) (or connections) scan. For a workspace with T
  // tables and N records that made one question O(T×N); building the model
  // prompt alone walked every entity once per table. This caches a by-type
  // entity index and an edges-by-anchor index on the state object (WeakMap, so
  // it's discarded when the fold produces a new state), keyed by a cheap
  // fingerprint so an in-place mutation can't serve stale data. Read-only: the
  // cached arrays are never mutated by callers (filters/sorts always copy).
  const _stateCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  // Must be O(1) — it runs on every index access. Every mutating fold event
  // advances state.cursor (see fold.js dispatch), so cursor + connection count
  // distinguishes any in-place change to a reused state object without walking
  // the entity map.
  function stateFingerprint(state) {
    if (!state) return '0:0';
    const c = Array.isArray(state.connections) ? state.connections.length : 0;
    return (state.cursor != null ? state.cursor : 0) + ':' + c;
  }
  function stateIndex(state) {
    if (!state || !_stateCache) return null;
    const fp = stateFingerprint(state);
    let idx = _stateCache.get(state);
    if (idx && idx.fp === fp) return idx;
    const byType = new Map();
    for (const e of Object.values(state.entities || {})) {
      const t = e && e._type;
      if (!t) continue;
      let arr = byType.get(t);
      if (!arr) { arr = []; byType.set(t, arr); }
      arr.push(e);
    }
    const edges = new Map(); // anchor → connections touching it (matches relatedRecords' walk)
    for (const c of (state.connections || [])) {
      if (c.source != null) { let a = edges.get(c.source); if (!a) { a = []; edges.set(c.source, a); } a.push(c); }
      if (c.target != null && c.target !== c.source) { let a = edges.get(c.target); if (!a) { a = []; edges.set(c.target, a); } a.push(c); }
    }
    idx = { fp, byType, edges, known: null, fields: new Map() };
    _stateCache.set(state, idx);
    return idx;
  }

  // Mirror table-view.jsx's record label so chat and grid agree on titles.
  function recordLabel(e) {
    if (!e) return '';
    const v = e.Name || e.name || e.title || e.body || e.claim || e.what || e.label || e.summary;
    if (v !== undefined && v !== null && v !== '') return String(v);
    return e._anchor ? String(e._anchor).slice(-8) : '';
  }

  // ── schema introspection (over live fold state) ───────────────────────────
  function knownTypes(state) {
    const idx = stateIndex(state);
    const fromSchema = Array.isArray(state?.schema?.tables) ? state.schema.tables : [];
    if (idx) {
      if (!idx.known) idx.known = uniq([...fromSchema, ...idx.byType.keys()]);
      return idx.known;
    }
    const fromData = uniq(Object.values(state?.entities || {}).map(e => e._type).filter(Boolean));
    return uniq([...fromSchema, ...fromData]);
  }

  // Field defs for a type: schema first, then any plain keys observed on records.
  function fieldsForType(state, type) {
    const idx = stateIndex(state);
    if (idx) { const hit = idx.fields.get(type); if (hit) return hit; }
    const out = [];
    const seen = new Set();
    const sch = state?.schema?.fields?.[type];
    if (Array.isArray(sch)) {
      for (const f of sch) {
        if (!f || !f.name || seen.has(f.name)) continue;
        seen.add(f.name);
        out.push({ name: f.name, type: f.type || 'text', options: f.options || null });
      }
    }
    for (const e of entitiesOfType(state, type)) {
      for (const k of Object.keys(e)) {
        if (isUnderscore(k) || seen.has(k)) continue;
        seen.add(k);
        out.push({ name: k, type: inferFieldType(e[k]), options: null });
      }
    }
    if (idx) idx.fields.set(type, out);
    return out;
  }

  function inferFieldType(v) {
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (Array.isArray(v)) return 'multiselect';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
    return 'text';
  }

  // Collapse the field-type zoo to the comparison behaviours filters care about
  // (kept in step with table-view.jsx's filterKind).
  function filterKind(type) {
    if (type === 'number' || type === 'duration') return 'number';
    if (type === 'date') return 'date';
    if (type === 'boolean') return 'boolean';
    if (type === 'select') return 'select';
    if (type === 'multiselect') return 'multiselect';
    return 'text';
  }

  function entitiesOfType(state, type) {
    const idx = stateIndex(state);
    if (idx) return idx.byType.get(type) || [];
    return Object.values(state?.entities || {}).filter(e => e._type === type);
  }

  // ── type matching ─────────────────────────────────────────────────────────
  // Map an English word to a type, tolerating simple plural/singular ("tasks"
  // → "task", "people" → "person"). Returns the best (longest) type mentioned.
  const IRREGULAR = { people: 'person', men: 'man', women: 'woman', children: 'child', companies: 'company', entries: 'entry' };
  function singularize(w) {
    w = lc(w);
    if (IRREGULAR[w]) return IRREGULAR[w];
    if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
    if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function typeVariants(type) {
    const t = norm(type);
    return uniq([t, t + 's', t + 'es', singularize(t), t.replace(/y$/, 'ies')]);
  }
  const TYPE_STOP = new Set(['view', 'info', 'master', 'list', 'table', 'data', 'record', 'records']);
  // Score every known type against the question. Multi-word names ("Case Notes",
  // "Client Info", "Case Master View") match either as a whole phrase (strong)
  // or by how many of their content words appear (weaker) — so "clients" finds
  // "Client Info" and "notes" finds "Case Notes". Returns ranked candidates and
  // a confidence the orchestrator uses to decide whether to call the local LLM.
  function matchTypeScored(state, q) {
    const text = ' ' + norm(q) + ' ';
    const out = [];
    for (const type of knownTypes(state)) {
      const tn = norm(type);
      const words = tn.split(' ').filter(Boolean);
      let score = 0;
      // whole-phrase / simple-plural hit
      for (const v of typeVariants(type)) {
        if (v && text.indexOf(' ' + v + ' ') >= 0) score = Math.max(score, 3 + Math.min(1, v.length / 40));
      }
      // content-word overlap (down-weight generic words like "view"/"info")
      let hit = 0, weight = 0;
      for (const w of words) {
        const ww = TYPE_STOP.has(w) ? 0.25 : 1;
        weight += ww;
        const sw = singularize(w);
        if (text.indexOf(' ' + w + ' ') >= 0 || text.indexOf(' ' + sw + ' ') >= 0 || text.indexOf(' ' + sw + 's ') >= 0) hit += ww;
      }
      if (weight > 0 && hit > 0) score = Math.max(score, (hit / weight) * 2.2);
      if (score > 0) out.push({ type, score });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out[0] || null;
    // confident when a clear front-runner exists
    const confident = !!top && top.score >= 1.6 && (!out[1] || top.score - out[1].score >= 0.5);
    return { type: top ? top.type : null, score: top ? top.score : 0, confident, candidates: out.slice(0, 4) };
  }
  function matchType(state, q) { return matchTypeScored(state, q).type; }

  // ── field matching ────────────────────────────────────────────────────────
  function resolveField(fields, token) {
    const t = norm(token);
    if (!t) return null;
    let exact = fields.find(f => norm(f.name) === t);
    if (exact) return exact;
    // word-boundary contains (so "due" matches "Due date")
    let part = fields.find(f => (' ' + norm(f.name) + ' ').indexOf(' ' + t + ' ') >= 0);
    if (part) return part;
    part = fields.find(f => norm(f.name).indexOf(t) >= 0 || t.indexOf(norm(f.name)) >= 0);
    return part || null;
  }

  // Which field carries `value` as one of its select options? (lets "done
  // tasks" filter the field whose option set includes "done")
  function fieldWithOption(fields, value) {
    const v = norm(value);
    for (const f of fields) {
      if (Array.isArray(f.options) && f.options.some(o => norm(o) === v)) return f;
    }
    return null;
  }

  // ── value comparison ──────────────────────────────────────────────────────
  function asNumber(v) {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  function asDate(v) { const t = Date.parse(v); return Number.isNaN(t) ? NaN : t; }

  function cellMatches(cell, op, target, kind) {
    const empty = cell === undefined || cell === null || cell === '' || (Array.isArray(cell) && cell.length === 0);
    if (op === 'empty') return empty;
    if (op === 'notempty') return !empty;
    if (op === 'true') return cell === true || lc(cell) === 'true' || lc(cell) === 'yes';
    if (op === 'false') return cell === false || lc(cell) === 'false' || lc(cell) === 'no' || empty;
    if (kind === 'number') {
      const a = asNumber(cell), b = asNumber(target);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return numCompare(a, b, op);
    }
    if (kind === 'date') {
      const a = asDate(cell), b = asDate(target);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return numCompare(a, b, op);
    }
    if (kind === 'multiselect') {
      const arr = Array.isArray(cell) ? cell.map(nfold) : [nfold(cell)];
      const t = nfold(target);
      if (op === 'ncontains') return !arr.includes(t);
      return arr.includes(t); // contains / eq
    }
    // text & select — accent-folded so "mexico" matches "México"
    const a = nfold(cell), b = nfold(target);
    switch (op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'ncontains': return a.indexOf(b) < 0;
      case 'contains':
      default: return a.indexOf(b) >= 0;
    }
  }
  function numCompare(a, b, op) {
    switch (op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      default: return a === b;
    }
  }

  function applyFilters(records, filters) {
    if (!filters || !filters.length) return records.slice();
    return records.filter(r => filters.every(f => cellMatches(r[f.field], f.op, f.value, f.kind)));
  }

  // ── filter parsing ────────────────────────────────────────────────────────
  // Phrase → operator. Longer phrases first so "is not" beats "is".
  // Symbol operators (>, <=, !=) can't use \b — those boundaries don't fire
  // around non-word characters — so each symbol is its own alternative. Order
  // matters: the >=/<=/!= forms precede >/</= so the two-char op wins the tie.
  const OP_PHRASES = [
    [/\b(is not empty|are not empty|has any)\b/, 'notempty'],
    [/\b(is empty|are empty|is blank|has no|has none)\b/, 'empty'],
    [/\b(is not|isn'?t|does not equal|doesn'?t equal)\b|!=/, 'neq'],
    [/\b(does not contain|doesn'?t contain|not containing|without)\b/, 'ncontains'],
    [/\b(greater than or equal to|at least)\b|>=|≥/, 'gte'],
    [/\b(less than or equal to|at most|no more than)\b|<=|≤/, 'lte'],
    [/\b(greater than|more than|over|above)\b|>/, 'gt'],
    [/\b(less than|fewer than|under|below)\b|</, 'lt'],
    [/\b(after)\b/, 'gt'],
    [/\b(before)\b/, 'lt'],
    [/\b(contains|containing|including|mentions?|matching)\b/, 'contains'],
    [/\b(is|are|equals?)\b|=/, 'eq'],
  ];

  // Pull "<field> <op-phrase> <value>" clauses out of the question. Greedy but
  // schema-anchored: a clause only counts if its left side resolves to a field.
  function parseFilters(q, fields) {
    const filters = [];
    const clauses = String(q)
      .split(/\b(?:and|where|with|whose|that have|having|,)\b/i)
      .map(s => s.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      let matchedOp = null, opIdx = -1, opLen = 0;
      for (const [re, op] of OP_PHRASES) {
        const m = clause.match(re);
        if (m && (opIdx < 0 || m.index < opIdx)) { matchedOp = op; opIdx = m.index; opLen = m[0].length; }
      }
      if (!matchedOp) continue;
      const left = clause.slice(0, opIdx).trim().replace(/^(the|a|an)\s+/i, '');
      const right = clause.slice(opIdx + opLen).trim().replace(/[?.!]+$/, '');
      const field = resolveField(fields, lastNoun(left)) || resolveField(fields, left);
      if (!field) continue;
      if (matchedOp === 'empty' || matchedOp === 'notempty') {
        filters.push({ field: field.name, op: matchedOp, value: '', kind: filterKind(field.type) });
        continue;
      }
      const value = stripQuotes(right);
      if (value === '') continue;
      filters.push({ field: field.name, op: matchedOp, value, kind: filterKind(field.type) });
    }
    return filters;
  }

  // "done tasks", "open bugs" → an option-valued filter without an explicit op.
  function parseStandaloneOptions(q, fields, alreadyFiltered) {
    const used = new Set(alreadyFiltered.map(f => f.field));
    const out = [];
    const words = norm(q).split(' ');
    for (const w of words) {
      if (w.length < 2) continue;
      const f = fieldWithOption(fields, w);
      if (f && !used.has(f.name)) {
        const opt = f.options.find(o => norm(o) === w);
        out.push({ field: f.name, op: filterKind(f.type) === 'multiselect' ? 'contains' : 'eq', value: opt, kind: filterKind(f.type) });
        used.add(f.name);
      }
    }
    return out;
  }

  // ── implicit value filters: resolve a named VALUE to its (unnamed) field ────
  // parseFilters needs "<field> <op> <value>"; parseStandaloneOptions catches a
  // bare SELECT option. But people rarely name the field — "clients from
  // Mexico", "cases in California", "matters named Acme". Here we take a value
  // the user named and find whichever field actually carries it (a select
  // option first, then a real record value), so the field can stay implicit.
  // Candidate values come from preposition phrases ("from/in/at/named/called
  // <X>") and quoted text — a strong enough signal that we accept a substring
  // match and will even match a label/Name field. A phrase that only renames
  // the table ("…in cases") resolves to nothing and is dropped.
  const VALUE_PREP_RE = /\b(?:from|in|at|named|called|located in|based in|living in|residing in)\s+([\p{L}\p{N}][\p{L}\p{N} .,'’&/-]*?)(?=\s+(?:and|or|but|with|where|whose|that|who|which|sorted|ordered|order|grouped|group|by|per)\b|[?.!,;:]|$)/giu;
  const VALUE_SCAN_CAP = 20000; // don't scan a giant table to resolve one value

  function valuePhrases(q) {
    const out = [];
    let m;
    VALUE_PREP_RE.lastIndex = 0;
    while ((m = VALUE_PREP_RE.exec(q)) !== null) {
      const phrase = stripQuotes(m[1]).replace(/^(the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim();
      if (phrase) out.push(phrase);
    }
    const quoted = String(q).match(/["“'`]([^"”'`]+)["”'`]/);
    if (quoted && quoted[1].trim()) out.push(quoted[1].trim());
    return uniq(out);
  }

  // Which field carries `phrase` as a value? Returns a ready filter or null.
  function fieldForValue(state, type, fields, phrase) {
    const p = nfold(phrase);
    if (!p || p.length < 2) return null;
    if (typeVariants(type).map(nfold).indexOf(p) >= 0) return null; // just the table name
    // 1) a select / multiselect option — canonical, most trustworthy
    for (const f of fields) {
      if (!Array.isArray(f.options) || !f.options.length) continue;
      const opt = f.options.find(o => nfold(o) === p) || f.options.find(o => (' ' + nfold(o) + ' ').indexOf(' ' + p + ' ') >= 0);
      if (opt) return { field: f.name, op: filterKind(f.type) === 'multiselect' ? 'contains' : 'eq', value: opt, kind: filterKind(f.type) };
    }
    // 2) a real value on a record. Prefer an exact, non-label match; fall back
    //    to exact-on-label, then a word-boundary contains. (Free-text phrase,
    //    so numbers/dates compare as text — which is what a contains needs.)
    const records = entitiesOfType(state, type);
    if (records.length > VALUE_SCAN_CAP) return null;
    let exactNon = null, exactLabel = null, containsNon = null, containsLabel = null;
    for (const f of fields) {
      if (Array.isArray(f.options) && f.options.length) continue; // handled above
      const isLabel = isLabelField(f.name);
      for (const r of records) {
        const cell = r[f.name];
        if (cell == null || cell === '') continue;
        const cv = nfold(displayValue(cell));
        if (!cv) continue;
        if (cv === p) {
          if (isLabel) { exactLabel = exactLabel || { field: f.name, op: 'eq', value: cell }; }
          else { exactNon = { field: f.name, op: 'eq', value: cell }; }
          break;
        }
        if ((' ' + cv + ' ').indexOf(' ' + p + ' ') >= 0) {
          if (isLabel) containsLabel = containsLabel || { field: f.name, op: 'contains', value: phrase };
          else containsNon = containsNon || { field: f.name, op: 'contains', value: phrase };
        }
      }
      if (exactNon) break; // best possible (a select option was already ruled out)
    }
    const hit = exactNon || exactLabel || containsNon || containsLabel;
    if (!hit) return null;
    const fd = fields.find(f => f.name === hit.field);
    return { field: hit.field, op: hit.op, value: hit.value, kind: filterKind(fd ? fd.type : 'text') };
  }

  function parseValueFilters(q, fields, state, type, alreadyFiltered) {
    if (!type || !fields || !fields.length) return [];
    const used = new Set((alreadyFiltered || []).map(f => f.field));
    const out = [];
    for (const phrase of valuePhrases(q)) {
      const hit = fieldForValue(state, type, fields, phrase);
      if (hit && !used.has(hit.field)) { out.push(hit); used.add(hit.field); }
    }
    return out;
  }

  function lastNoun(s) { const parts = norm(s).split(' ').filter(Boolean); return parts[parts.length - 1] || ''; }
  function stripQuotes(s) { return String(s).trim().replace(/^["'`]|["'`]$/g, '').replace(/[?.!]+$/, '').trim(); }

  // ── aggregation ───────────────────────────────────────────────────────────
  const AGG_WORDS = [
    [/\b(how many|number of|count of|count)\b/, 'count'],
    [/\b(sum|total)\b/, 'sum'],
    [/\b(average|avg|mean)\b/, 'avg'],
    [/\b(maximum|max|highest|largest|most)\b/, 'max'],
    [/\b(minimum|min|lowest|smallest|least)\b/, 'min'],
  ];
  function parseAggregate(q, fields) {
    let agg = null;
    for (const [re, name] of AGG_WORDS) { if (re.test(q)) { agg = name; break; } }
    if (!agg) return null;
    // field the aggregate runs over (sum/avg/min/max need one; count usually not)
    let field = null;
    const m = q.match(/\b(?:sum|total|average|avg|mean|maximum|max|minimum|min)\s+(?:of\s+|the\s+)?([a-z0-9 _]+?)(?:\s+(?:by|per|for|where|with|in|of)\b|[?.!]|$)/i);
    if (m) field = resolveField(fields, m[1].trim());
    // group dimension
    let groupBy = null;
    const g = q.match(/\b(?:by|per|grouped by|group by|for each)\s+([a-z0-9 _]+?)(?:\s+(?:where|with|and)\b|[?.!]|$)/i);
    if (g) groupBy = resolveField(fields, g[1].trim());
    return { agg, field: field ? field.name : null, fieldType: field ? field.type : null, groupBy: groupBy ? groupBy.name : null };
  }

  function aggregate(records, spec) {
    const reduce = (rows) => {
      if (spec.agg === 'count') return rows.length;
      const nums = rows.map(r => asNumber(r[spec.field])).filter(n => !Number.isNaN(n));
      if (!nums.length) return spec.agg === 'count' ? 0 : null;
      if (spec.agg === 'sum') return round(nums.reduce((a, b) => a + b, 0));
      if (spec.agg === 'avg') return round(nums.reduce((a, b) => a + b, 0) / nums.length);
      if (spec.agg === 'max') return round(Math.max(...nums));
      if (spec.agg === 'min') return round(Math.min(...nums));
      return null;
    };
    if (!spec.groupBy) return { grouped: false, value: reduce(records) };
    const groups = new Map();
    for (const r of records) {
      const key = displayValue(r[spec.groupBy]) || '(empty)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const rows = Array.from(groups.entries()).map(([k, rows]) => ({ key: k, value: reduce(rows), count: rows.length }));
    rows.sort((a, b) => (typeof b.value === 'number' && typeof a.value === 'number') ? b.value - a.value : String(a.key).localeCompare(String(b.key)));
    return { grouped: true, rows };
  }
  function round(n) { return Math.round(n * 1e6) / 1e6; }

  // ── sort & limit ──────────────────────────────────────────────────────────
  function parseSort(q, fields) {
    let m = q.match(/\b(?:sorted?|order(?:ed)?)\s+by\s+([a-z0-9 _]+?)(?:\s+(asc|ascending|desc|descending)\b)?(?:[?.!]|$)/i);
    if (m) { const f = resolveField(fields, m[1].trim()); if (f) return { field: f.name, dir: /desc/i.test(m[2] || '') ? 'desc' : 'asc' }; }
    m = q.match(/\b(top|highest|most|largest|biggest)\s+([a-z0-9 _]+)/i);
    if (m) { const f = resolveField(fields, m[2].trim()); if (f) return { field: f.name, dir: 'desc' }; }
    m = q.match(/\b(lowest|least|smallest)\s+([a-z0-9 _]+)/i);
    if (m) { const f = resolveField(fields, m[2].trim()); if (f) return { field: f.name, dir: 'asc' }; }
    return null;
  }
  function parseLimit(q) {
    let m = q.match(/\b(?:top|first|bottom|last)\s+(\d+)\b/i);
    if (m) return parseInt(m[1], 10);
    m = q.match(/^\s*(\d+)\s+[a-z]/i); // "5 tasks ..."
    if (m) return parseInt(m[1], 10);
    return null;
  }
  function sortRecords(records, sort) {
    if (!sort) return records;
    const fld = sort.field, sgn = sort.dir === 'desc' ? -1 : 1;
    return records.slice().sort((a, b) => {
      const av = a[fld], bv = b[fld];
      const an = asNumber(av), bn = asNumber(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return (an - bn) * sgn;
      return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv)) * sgn;
    });
  }

  // ── foreign keys: linked records via CON edges (+ schema.links) ────────────
  function relatedRecords(state, anchor) {
    const groups = new Map(); // key `${dir}:${rel}:${type}` → { type, rel, dir, records }
    const idx = stateIndex(state);
    const edges = idx ? (idx.edges.get(anchor) || []) : (state?.connections || []);
    for (const c of edges) {
      let otherAnchor = null, dir = null;
      if (c.source === anchor) { otherAnchor = c.target; dir = 'out'; }
      else if (c.target === anchor) { otherAnchor = c.source; dir = 'in'; }
      else continue;
      const other = state.entities[otherAnchor];
      if (!other) continue;
      const key = dir + ':' + (c.type || 'link') + ':' + other._type;
      if (!groups.has(key)) groups.set(key, { type: other._type, rel: c.type || 'link', dir, records: [] });
      groups.get(key).records.push({ anchor: otherAnchor, type: other._type, label: recordLabel(other), rel: c.type || 'link', dir });
    }
    return Array.from(groups.values());
  }

  // Types this type can link to (declared schema.links, else observed edges) —
  // mirrors table-view.jsx's linkedTypesFor.
  function linkedTypesFor(state, type) {
    const links = state?.schema?.links;
    if (Array.isArray(links)) {
      const set = new Set();
      for (const l of links) { if (l.from === type) set.add(l.to); if (l.to === type) set.add(l.from); }
      return Array.from(set);
    }
    const set = new Set();
    for (const c of (state?.connections || [])) {
      const s = state.entities[c.source], t = state.entities[c.target];
      if (s?._type === type && t) set.add(t._type);
      if (t?._type === type && s) set.add(s._type);
    }
    return Array.from(set);
  }

  // ── columns & display ─────────────────────────────────────────────────────
  function columnsForType(state, type) {
    const fields = fieldsForType(state, type);
    return fields.map(f => ({ name: f.name, type: f.type }));
  }

  // Names that read as a record label (the chat-view uses MAX_COLS=6, so the
  // first column needs to be something a person recognizes — not "Meta Data").
  const LABEL_FIELD_RE = /^(name|title|body|label|summary|claim|what|client name|client name help|matter|description|case name|first name|family name|full name|display name)$/i;
  function isLabelField(name) { return LABEL_FIELD_RE.test(String(name || '').trim()); }

  // Order the columns of a result table so the most useful 5–6 land at the
  // front (since chat-view caps the preview at MAX_COLS). Priority:
  //   1. ONE label-like field (Name / Title / Body / Matter …), in declaration
  //      order — promoting every label-like field crowds out the columns the
  //      user actually asked about.
  //   2. anything the spec touched — filter/sort/aggregate field, groupBy
  //   3. typed, enumerable fields (select / date / number / boolean)
  //   4. everything else, in declaration order
  // Falls back to columnsForType behavior when fields is empty.
  function preferredColumns(state, type, spec) {
    const fields = fieldsForType(state, type);
    if (!fields.length) return [];
    const score = new Map();
    fields.forEach((f, i) => score.set(f.name, { f, base: 0, idx: i }));
    const bump = (name, n) => {
      const e = name && score.get(name);
      if (e) e.base = Math.max(e.base, n);
    };
    const label = fields.find(f => isLabelField(f.name));
    if (label) bump(label.name, 100);
    if (spec) {
      for (const flt of (spec.filters || [])) bump(flt && flt.field, 80);
      if (spec.sort) bump(spec.sort.field, 75);
      if (spec.agg) { bump(spec.agg.field, 70); bump(spec.agg.groupBy, 70); }
    }
    for (const f of fields) {
      if (f.type === 'select' || f.type === 'multiselect') bump(f.name, 40);
      else if (Array.isArray(f.options) && f.options.length) bump(f.name, 40);
      else if (f.type === 'date' || f.type === 'number' || f.type === 'boolean') bump(f.name, 25);
      else if (f.type === 'longtext') bump(f.name, 5);
    }
    return fields.slice()
      .sort((a, b) => {
        const sa = score.get(a.name), sb = score.get(b.name);
        return (sb.base - sa.base) || (sa.idx - sb.idx);
      })
      .map(f => ({ name: f.name, type: f.type }));
  }

  // Pick the schema fields to show the on-device LLM. The full schema dump can
  // be hundreds of fields per table (real Airtable bases routinely are), and a
  // small CPU model can't reason over a long context — so this trims to the
  // fields most likely to matter for THIS question:
  //   • label-like fields (so the model can sort/filter on what users see)
  //   • fields whose name overlaps a content word in the question
  //   • fields whose select-option labels match a word in the question
  //   • a few enumerable / typed fields as background context
  // Pure / deterministic — no model, no engine. Safe to call without a question
  // (degrades to the first N by declaration order, matching the prior behavior).
  const PROMPT_FIELDS_FLOOR = 14;
  const PROMPT_FIELDS_CEIL = 32;
  function selectFieldsForPrompt(fields, q, limit) {
    if (!fields || !fields.length) return [];
    const cap = Math.max(1, limit | 0) || PROMPT_FIELDS_FLOOR;
    if (fields.length <= cap) return fields.slice();
    const qw = q ? norm(q).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)) : [];
    const scored = fields.map((f, i) => {
      let s = 0;
      const fn = norm(f.name);
      if (isLabelField(f.name)) s += 12;
      if (Array.isArray(f.options) && f.options.length) s += 5;
      if (f.type === 'select' || f.type === 'multiselect') s += 4;
      else if (f.type === 'date' || f.type === 'number' || f.type === 'boolean') s += 2;
      for (const w of qw) {
        if (fn.indexOf(w) >= 0) s += 8;
        if (Array.isArray(f.options) && f.options.some(o => norm(o).indexOf(w) >= 0)) s += 10;
      }
      return { f, s, i };
    });
    scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    return scored.slice(0, cap).map(x => x.f);
  }

  function displayValue(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'boolean') return v ? '✓' : '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }

  // ── record resolution (for profile intent) ───────────────────────────────
  // Find the single record a phrase points at. Lexical first (exact > prefix >
  // contains); the caller may have already narrowed by type.
  function resolveRecord(state, phrase, type) {
    const p = norm(phrase);
    if (!p) return null;
    const pool = type ? entitiesOfType(state, type) : Object.values(state?.entities || {});
    let exact = null, prefix = null, contains = null;
    for (const e of pool) {
      const label = norm(recordLabel(e));
      if (!label) continue;
      if (label === p) { exact = e; break; }
      if (!prefix && label.indexOf(p) === 0) prefix = e;
      if (!contains && (label.indexOf(p) >= 0 || p.indexOf(label) >= 0)) contains = e;
    }
    const hit = exact || prefix || contains;
    return hit ? { anchor: hit._anchor, type: hit._type } : null;
  }

  // ── global record search (prose / catch-all fallback) ─────────────────────
  const STOP = new Set('a an the of to in on for with and or is are was were be been show me list find all give get what which who whose how many about into from by as at that this it'.split(' '));
  function searchTerms(q) {
    return uniq(norm(q).split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)));
  }
  const GLOBAL_SEARCH_CAP = 50000; // bound the catch-all scan on huge workspaces
  function globalSearch(state, q, limit) {
    const terms = searchTerms(q);
    if (!terms.length) return [];
    const scored = [];
    let scanned = 0;
    for (const e of Object.values(state?.entities || {})) {
      if (++scanned > GLOBAL_SEARCH_CAP) break;
      let hay = recordLabel(e) + ' ';
      for (const k of Object.keys(e)) if (!isUnderscore(k)) hay += displayValue(e[k]) + ' ';
      hay = norm(hay);
      let score = 0;
      for (const t of terms) if (hay.indexOf(t) >= 0) score += 1;
      if (score > 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit || 25).map(s => s.e);
  }

  // ── intent detection helpers ──────────────────────────────────────────────
  const PROFILE_RE = /\b(profile|details?|info(?:rmation)?|tell me about|show me|open|who is|what is|the record|card for|page for|everything about)\b/i;
  const LIST_RE = /\b(list|show|all|every|find|table of|records?|rows?|which)\b/i;

  // The phrase after a profile verb — the candidate record/type name.
  function profileTarget(q) {
    const m = String(q).match(/\b(?:about|for|on|of|named|called|titled|is|profile of|details? of|record)\s+(.+)$/i);
    if (m) return stripQuotes(m[1]);
    const quoted = String(q).match(/["“'`]([^"”'`]+)["”'`]/);
    if (quoted) return quoted[1].trim();
    return null;
  }

  // ── plan: the normalized intermediate both parsers emit ────────────────────
  // { intent:'profile'|'query'|'aggregate'|'search', type, record, filters[],
  //   agg{agg,field,groupBy}|null, sort{field,dir}|null, limit, source }

  // Build a query/aggregate plan for a specific (type, question) pair. Pulled
  // out of buildPlan so the disambiguation flow can produce one ready-to-run
  // plan per candidate table without re-walking the type matcher.
  function buildPlanForType(q, state, type, source) {
    const fields = type ? fieldsForType(state, type) : [];
    let filters = parseFilters(q, fields);
    filters = filters.concat(parseStandaloneOptions(q, fields, filters));
    filters = filters.concat(parseValueFilters(q, fields, state, type, filters));
    const agg = parseAggregate(q, fields);
    const sort = parseSort(q, fields);
    const limit = parseLimit(q);
    return {
      intent: agg ? 'aggregate' : 'query',
      type, record: null, filters, agg, sort, limit,
      source: source || 'deterministic',
    };
  }

  // Deterministic parse → { plan, confidence, alternatives }. No engine needed.
  function buildPlan(q, state) {
    const ts = matchTypeScored(state, q);
    const type = ts.type;

    // profile intent — a verb phrase pointing at a named record (not a table)
    if (PROFILE_RE.test(q)) {
      const target = profileTarget(q);
      const targetIsType = target && matchType(state, ' ' + target + ' ');
      if (target && !targetIsType) {
        return { plan: { intent: 'profile', type, record: target, filters: [], agg: null, sort: null, limit: null, source: 'deterministic' }, confidence: 0.7, alternatives: ts.candidates };
      }
    }
    if (!type) {
      // a bare quoted name with no table → still a profile attempt
      if (/^["“'`]/.test(q)) {
        return { plan: { intent: 'profile', type: null, record: stripQuotes(q), filters: [], agg: null, sort: null, limit: null, source: 'deterministic' }, confidence: 0.4, alternatives: ts.candidates };
      }
      return { plan: { intent: 'search', type: null, record: null, filters: [], agg: null, sort: null, limit: null, source: 'deterministic' }, confidence: 0.2, alternatives: ts.candidates };
    }

    const plan = buildPlanForType(q, state, type, 'deterministic');
    let conf = ts.confident ? 0.8 : 0.5;
    if (plan.filters.length || plan.agg || plan.sort || plan.limit) conf += 0.12;
    return { plan, confidence: Math.min(1, conf), alternatives: ts.candidates };
  }

  // Sanitize any plan (deterministic OR llm-proposed) against the live schema,
  // then run it. The executor is the ONLY thing that touches data, so an LLM
  // can only ever propose a read query — never an unchecked field or a write.
  async function executePlan(state, plan, ctx) {
    ctx = ctx || {};
    const q = ctx.q || '';
    const spec = { question: q, intent: plan.intent, source: plan.source || 'deterministic' };

    if (plan.intent === 'profile') {
      const hit = resolveRecord(state, plan.record, plan.type)
        || await fuzzyResolveRecord(state, plan.record, plan.type)
        || resolveRecord(state, plan.record, null);
      if (hit) return { kind: 'profile', anchor: hit.anchor, type: hit.type, spec: { ...spec, target: plan.record } };
      plan = { ...plan, intent: 'search' }; // couldn't find the record → search
    }

    if ((plan.intent === 'query' || plan.intent === 'aggregate') && plan.type && knownTypes(state).includes(plan.type)) {
      const fields = fieldsForType(state, plan.type);
      const filters = validateFilters(plan.filters, fields);
      await fuzzyRepairFilters(filters, fields, state, plan.type);
      const filtered = applyFilters(entitiesOfType(state, plan.type), filters);

      const agg = plan.agg ? validateAgg(plan.agg, fields) : null;
      if (agg) {
        const res = aggregate(filtered, agg);
        if (!res.grouped) {
          return { kind: 'value', label: aggLabel(agg) + ' of ' + plural(plan.type), value: res.value == null ? '—' : res.value, note: filters.length ? whereNote(filters) : null, spec: { ...spec, type: plan.type, filters, agg } };
        }
        return {
          kind: 'table', type: plan.type, title: aggLabel(agg) + ' of ' + plural(plan.type) + ' by ' + agg.groupBy,
          columns: [{ name: agg.groupBy, type: 'text' }, { name: aggLabel(agg), type: 'number' }, { name: 'count', type: 'number' }],
          rows: res.rows.map(r => ({ _anchor: '__agg__' + r.key, _type: plan.type, [agg.groupBy]: r.key, [aggLabel(agg)]: r.value, count: r.count, _agg: true })),
          note: filters.length ? whereNote(filters) : null, spec: { ...spec, type: plan.type, filters, agg },
        };
      }

      const sort = validateSort(plan.sort, fields);
      const limit = plan.limit > 0 ? (plan.limit | 0) : null;
      let rows = sortRecords(filtered, sort);
      if (limit) rows = rows.slice(0, limit);
      return {
        kind: 'table', type: plan.type, title: titleFor(plan.type, filters, sort, limit),
        columns: preferredColumns(state, plan.type, { filters, sort, agg: null }),
        rows, total: filtered.length,
        note: filters.length ? whereNote(filters) : null, alternatives: ctx.alternatives,
        spec: { ...spec, type: plan.type, filters, sort, limit },
      };
    }

    // search / catch-all — a global record scan, optionally narrated by the engine
    const hits = globalSearch(state, q, 30);
    const proseNote = await engineAnswer(state, q, ctx.opts).catch(() => null);
    if (hits.length) {
      return {
        kind: 'table', type: null, title: 'Records matching “' + q.replace(/[?.!]+$/, '') + '”',
        columns: [{ name: 'type', type: 'text' }, { name: 'record', type: 'text' }],
        rows: hits.map(e => ({ _anchor: e._anchor, _type: e._type, type: e._type, record: recordLabel(e) })),
        total: hits.length, note: proseNote || null, mixed: true, spec,
      };
    }
    return {
      kind: proseNote ? 'answer' : 'empty', text: proseNote || null, records: [],
      message: proseNote ? null : 'No records matched that. Try a table name, e.g. ' + plural(knownTypes(state)[0]) + '.',
      suggestions: suggestions(state), spec,
    };
  }

  // plan validators — resolve names to real fields, normalize operators/dirs.
  const OP_CODES = new Set(['eq', 'neq', 'contains', 'ncontains', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty', 'true', 'false']);
  const OP_SYNONYMS = { '=': 'eq', '==': 'eq', is: 'eq', equals: 'eq', equal: 'eq', '!=': 'neq', isnt: 'neq', 'is not': 'neq', not: 'neq', has: 'contains', includes: 'contains', '>': 'gt', greater: 'gt', after: 'gt', '>=': 'gte', '<': 'lt', less: 'lt', before: 'lt', '<=': 'lte' };
  function normalizeOp(op, type) {
    const o = lc(op).trim();
    if (OP_CODES.has(o)) return o;
    if (OP_SYNONYMS[o]) return OP_SYNONYMS[o];
    return filterKind(type) === 'text' ? 'contains' : 'eq';
  }
  function validateFilters(filters, fields) {
    const out = [];
    for (const f of (filters || [])) {
      if (!f || f.field == null) continue;
      const fd = resolveField(fields, f.field);
      if (!fd) continue;
      const op = normalizeOp(f.op, fd.type);
      out.push({ field: fd.name, op, value: f.value == null ? '' : String(f.value), kind: filterKind(fd.type) });
    }
    return out;
  }
  function validateAgg(agg, fields) {
    if (!agg) return null;
    const fn = lc(agg.agg || agg.fn || agg.op);
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(fn)) return null;
    const field = agg.field ? resolveField(fields, agg.field) : null;
    const groupBy = agg.groupBy ? resolveField(fields, agg.groupBy) : null;
    if ((fn === 'sum' || fn === 'avg' || fn === 'min' || fn === 'max') && !field) return null;
    return { agg: fn, field: field ? field.name : null, groupBy: groupBy ? groupBy.name : null };
  }
  function validateSort(sort, fields) {
    if (!sort || !sort.field) return null;
    const fd = resolveField(fields, sort.field);
    if (!fd) return null;
    return { field: fd.name, dir: /desc/i.test(sort.dir) ? 'desc' : 'asc' };
  }

  // ── confirmation gates ────────────────────────────────────────────────────
  // The chat is mechanical by design — every value comes from a deterministic
  // query, not a model summary — but mechanical can still be wrong. Two cases
  // are worth a one-tap check-in before answering:
  //
  //   1) TYPE AMBIGUITY  — multiple tables score close to each other for the
  //      question (e.g. "show notes" against both `Case Notes` and
  //      `case_notes`). Better to ask "which table?" than to silently pick.
  //
  //   2) BROAD QUERY     — the question would dump the entire table (no
  //      filters, no sort/limit), and the table is large. Show a count and
  //      let the user pick "first 25" or "all of them".
  //
  // Both are surfaced as { kind: 'confirm', choices: [{label, hint, plan}] }.
  // The chat-view renders the choices as buttons; tapping one runs that exact
  // plan with skipConfirm=true so we never loop on the same gate twice.
  const CONFIRM_TYPE_FLOOR = 1.0;   // both candidates must score at least this
  const CONFIRM_TYPE_GAP = 0.25;    // and be within this many points of each other
  const CONFIRM_FLOOD_ROWS = 200;   // ask before dumping more than N rows

  function maybeTypeConfirm(state, q, det) {
    const cands = (det && det.alternatives) || [];
    if (cands.length < 2) return null;
    const [a, b] = cands;
    if (!a || !b) return null;
    if (a.score < CONFIRM_TYPE_FLOOR) return null;
    if (a.score - b.score >= CONFIRM_TYPE_GAP) return null;
    const top = cands.slice(0, 4).filter(c => a.score - c.score < CONFIRM_TYPE_GAP);
    const choices = top.map(c => {
      const plan = buildPlanForType(q, state, c.type, 'confirm-type');
      const total = entitiesOfType(state, c.type).length;
      return {
        label: c.type,
        hint: total.toLocaleString() + ' record' + (total === 1 ? '' : 's'),
        plan,
      };
    });
    return {
      kind: 'confirm',
      reason: 'type',
      text: 'I read that as either ' + top.map(c => '“' + c.type + '”').join(' or ') + '. Which did you mean?',
      choices,
      spec: { question: q, source: 'confirm-type' },
    };
  }

  function maybeFloodConfirm(state, q, plan, result) {
    if (!result || result.kind !== 'table') return null;
    if (!plan || plan.intent !== 'query' || !plan.type) return null;
    if ((plan.filters && plan.filters.length) || (plan.limit && plan.limit > 0)) return null;
    const total = (result.rows && result.rows.length) || result.total || 0;
    if (total <= CONFIRM_FLOOD_ROWS) return null;
    const allPlan = { ...plan, source: 'confirm-flood' };
    const previewPlan = { ...plan, source: 'confirm-flood', limit: 25 };
    return {
      kind: 'confirm',
      reason: 'flood',
      text: 'That matches ' + total.toLocaleString() + ' ' + plural(plan.type) +
            '. Want a quick look first, or all of them?',
      choices: [
        { label: 'Show first 25', hint: 'quick look', plan: previewPlan },
        { label: 'Show all ' + total.toLocaleString(), hint: 'full set', plan: allPlan },
      ],
      spec: { question: q, source: 'confirm-flood', type: plan.type, total },
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // interpret — the one entry point the Ask view calls. Deterministic-first;
  // the local LLM is consulted only when the deterministic plan is unsure AND
  // opts.useLLM is set (the "Smart parse" toggle).
  //
  // Confirmation gating: when the deterministic parser is uncertain about
  // which table the user means, or when running the plan would flood the
  // thread with hundreds of rows, interpret returns a 'confirm' result with
  // explicit choices instead. Set opts.skipConfirm=true to bypass — used by
  // the chat-view when the user has already tapped one of those choices.
  // ════════════════════════════════════════════════════════════════════════
  // Public entry. Wraps interpretInner so a parser/engine/data hiccup can never
  // crash the Ask view: on any throw we retry deterministic-only (no engine, no
  // prose), and if even that fails we return a friendly note instead of letting
  // the error bubble up to the view.
  async function interpret(question, state, opts) {
    try {
      return await interpretInner(question, state, opts);
    } catch (e) {
      try {
        const q = String(question || '').trim();
        const det = buildPlan(q, state);
        const r = await executePlan(state, det.plan, { q, opts: Object.assign({}, opts, { noProse: true }) });
        r.spec = Object.assign({}, r.spec, { recovered: true });
        return r;
      } catch (e2) {
        return { kind: 'answer', text: 'I couldn’t read that one — try naming a table, like “how many clients”.', spec: { error: String((e && e.message) || e) } };
      }
    }
  }

  async function interpretInner(question, state, opts) {
    opts = opts || {};
    const q = String(question || '').trim();
    if (!q) return { kind: 'empty', message: 'Ask about your data.', suggestions: suggestions(state) };
    if (!knownTypes(state).length) return { kind: 'empty', message: 'This workspace has no records yet.', suggestions: [] };

    // Arithmetic first — the engine's deterministic calculator, if loaded.
    try {
      if (typeof window !== 'undefined' && window.EOCompute && window.EOCompute.detect) {
        const calc = window.EOCompute.detect(q);
        if (calc && calc.kind === 'calc') {
          return { kind: 'value', label: 'Result', value: calc.display, note: 'Computed locally with math.js — no model did this arithmetic.', spec: { question: q, intent: 'calc' } };
        }
      }
    } catch (e) { /* calculator never fatal */ }

    const det = buildPlan(q, state);
    let plan = det.plan;
    let usedLLM = false;
    const threshold = typeof opts.llmThreshold === 'number' ? opts.llmThreshold : 0.6;
    const canLLM = opts.useLLM && typeof window !== 'undefined' && window.EOLLM && window.EOLLM.phrase;
    if (canLLM && (opts.forceLLM || det.confidence < threshold)) {
      const lp = await planWithLLM(q, state, opts).catch(() => null);
      if (lp && (lp.type || lp.record || lp.intent === 'search')) { plan = lp; usedLLM = true; }
    }

    // Gate 1: type ambiguity — but skip if the user has already chosen, or if
    // the LLM produced a plan (they opted in to that path).
    if (!opts.skipConfirm && !usedLLM) {
      const conf = maybeTypeConfirm(state, q, det);
      if (conf) return conf;
    }

    const result = await executePlan(state, plan, { q, opts, alternatives: det.alternatives });

    // Gate 2: broad query — many rows, no filters. Always safe to ask.
    if (!opts.skipConfirm) {
      const flood = maybeFloodConfirm(state, q, plan, result);
      if (flood) return flood;
    }

    result.spec = { ...(result.spec || {}), usedLLM, confidence: det.confidence };
    return result;
  }

  // ── local-LLM intent planner (on-device only) ─────────────────────────────
  const LLM_SYSTEM = [
    'You translate a question about a database into a JSON query plan.',
    'Output ONLY a single JSON object — no prose, no code fence, no explanation.',
    'Shape: {"intent":"query|aggregate|profile|search","type":<table name or null>,',
    '"record":<a specific record name or null>,"filters":[{"field":<field>,"op":<op>,"value":<value>}],',
    '"agg":{"fn":"count|sum|avg|min|max","field":<field or null>,"groupBy":<field or null>} or null,',
    '"sort":{"field":<field>,"dir":"asc|desc"} or null,"limit":<integer or null>}.',
    'op is one of: eq, neq, contains, gt, gte, lt, lte, empty, notempty.',
    'Use "profile" when the user asks about ONE named record; "aggregate" for count/sum/average;',
    'otherwise "query". Pick type/field names ONLY from the provided schema.',
  ].join(' ');

  function schemaPrompt(state, q) {
    const lines = ['Tables and fields:'];
    for (const t of knownTypes(state)) {
      const all = fieldsForType(state, t);
      const picked = selectFieldsForPrompt(all, q, PROMPT_FIELDS_CEIL);
      const fs = picked.map(f => {
        let s = f.name + ':' + f.type;
        if (Array.isArray(f.options) && f.options.length) s += '[' + f.options.slice(0, 8).join('|') + ']';
        return s;
      });
      const extra = all.length > picked.length ? ' (+' + (all.length - picked.length) + ' more fields)' : '';
      lines.push('- "' + t + '" → ' + (fs.join(', ') || '(no fields)') + extra);
    }
    const links = state?.schema?.links;
    if (Array.isArray(links) && links.length) {
      lines.push('Links: ' + links.map(l => l.from + '—' + (l.rel || 'link') + '→' + l.to).join('; '));
    }
    return lines.join('\n');
  }

  function defaultLLMKey() {
    if (typeof window === 'undefined' || !window.EOLLM) return null;
    try {
      const models = window.EOLLM.wllamaModels ? window.EOLLM.wllamaModels() : {};
      if (models['qwen25-05b']) return 'wllama:qwen25-05b';
      if (window.EOLLM.fallbackKey) return window.EOLLM.fallbackKey();
    } catch (e) {}
    return window.EOLLM.fallbackKey ? window.EOLLM.fallbackKey() : null;
  }

  // Pull the first balanced {...} object out of a model's reply and parse it.
  function parsePlanJSON(raw) {
    if (!raw) return null;
    let s = String(raw);
    const i = s.indexOf('{');
    if (i < 0) return null;
    let depth = 0, end = -1;
    for (let j = i; j < s.length; j++) { const c = s[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = j; break; } } }
    if (end < 0) return null;
    let obj;
    try { obj = JSON.parse(s.slice(i, end + 1)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const plan = {
      intent: ['query', 'aggregate', 'profile', 'search'].includes(obj.intent) ? obj.intent : (obj.agg ? 'aggregate' : (obj.record ? 'profile' : 'query')),
      type: obj.type || null,
      record: obj.record || null,
      filters: Array.isArray(obj.filters) ? obj.filters : [],
      agg: obj.agg || null,
      sort: obj.sort || null,
      limit: Number.isFinite(obj.limit) ? obj.limit : null,
      source: 'llm',
    };
    return plan;
  }

  async function planWithLLM(q, state, opts) {
    if (typeof window === 'undefined' || !window.EOLLM || !window.EOLLM.phrase) return null;
    const key = (opts && opts.llmKey) || defaultLLMKey();
    if (!key) return null;
    try {
      if (window.EOLLM.isLoaded && !window.EOLLM.isLoaded(key)) {
        const ok = await window.EOLLM.load(key, opts && opts.onModelProgress);
        if (ok === false) return null;
      }
      const user = schemaPrompt(state, q) + '\n\nQuestion: ' + q + '\nJSON:';
      const raw = await window.EOLLM.phrase({ mlcKey: key, mode: 'plain-chat', sysOverride: LLM_SYSTEM, question: user, maxTokens: 220, onToken: opts && opts.onPlanToken });
      const plan = parsePlanJSON(raw);
      if (!plan) return null;
      // resolve a loosely-named type back to a real one ("clients" → "Client Info")
      if (plan.type) { const t = matchType(state, ' ' + plan.type + ' ') || (knownTypes(state).includes(plan.type) ? plan.type : null); plan.type = t; }
      return plan;
    } catch (e) { return null; }
  }

  // ── engine-backed enhancers (browser only, optional) ──────────────────────
  let _proseDoc = null, _proseKey = '';
  const PROSE_DOC_CAP = 4000; // building a prose corpus over a huge workspace would OOM
  function proseKey(state) { return (state?.cursor || 0) + ':' + Object.keys(state?.entities || {}).length; }
  async function buildProseDoc(state) {
    if (typeof window === 'undefined' || !window.EOEngine || !window.EOEngine.parseDocument) return null;
    if (Object.keys(state?.entities || {}).length > PROSE_DOC_CAP) return null;
    const key = proseKey(state);
    if (_proseDoc && _proseKey === key) return _proseDoc;
    const lines = [];
    for (const e of Object.values(state.entities || {})) {
      let line = (e._type || 'record') + ' “' + recordLabel(e) + '”.';
      const parts = [];
      for (const k of Object.keys(e)) if (!isUnderscore(k) && e[k] !== '' && e[k] != null) parts.push(k + ' is ' + displayValue(e[k]));
      if (parts.length) line += ' ' + parts.join('; ') + '.';
      const rel = relatedRecords(state, e._anchor);
      if (rel.length) line += ' Linked to ' + rel.map(g => g.records.map(r => r.label).join(', ')).join('; ') + '.';
      lines.push(line);
    }
    if (!lines.length) return null;
    try {
      _proseDoc = await window.EOEngine.parseDocument('workspace', lines.join('\n'), 'workspace-corpus');
      _proseKey = key;
      return _proseDoc;
    } catch (e) { return null; }
  }
  async function engineAnswer(state, q, opts) {
    if (typeof window === 'undefined' || !window.EOEngine || !window.EOEngine.answer) return null;
    if (opts && opts.noProse) return null;
    const doc = await buildProseDoc(state);
    if (!doc) return null;
    try {
      const a = window.EOEngine.answer(doc, q);
      let text = a && a.text ? String(a.text) : '';
      // Strip citation markers ({{cite:...}}) — chat shows record chips instead.
      text = text.replace(/\{\{cite:[^}]*\}\}/g, '').replace(/\s{2,}/g, ' ').trim();
      return text || null;
    } catch (e) { return null; }
  }

  // Fuzzy field/value/record repair using MiniLM embeddings, when resident.
  async function embedReady() {
    return typeof window !== 'undefined' && window.EOEmbed && window.EOEmbed.ready && window.EOEmbed.ready();
  }
  // Embedding the full label set is the costly half of a fuzzy lookup; cache it
  // per (state, type) so repeated "tell me about …" turns don't re-embed every
  // record label each time. Invalidated by the state fingerprint (any edit).
  let _labelEmbed = { key: '', vs: null };
  async function fuzzyResolveRecord(state, phrase, type) {
    if (!(await embedReady())) return null;
    const pool = type ? entitiesOfType(state, type) : Object.values(state.entities || {});
    const labels = pool.map(recordLabel);
    if (!labels.length) return null;
    try {
      const qv = await window.EOEmbed.embedQuery(phrase);
      const cacheKey = (type || '*') + '|' + stateFingerprint(state);
      let vs = (_labelEmbed.key === cacheKey) ? _labelEmbed.vs : null;
      if (!vs) { vs = await window.EOEmbed.embedSentences(labels); _labelEmbed = { key: cacheKey, vs }; }
      if (!qv || !vs) return null;
      let best = -1, bi = -1;
      for (let i = 0; i < vs.length; i++) { const s = dot(qv, vs[i]); if (s > best) { best = s; bi = i; } }
      if (bi >= 0 && best > 0.55) return { anchor: pool[bi]._anchor, type: pool[bi]._type };
    } catch (e) { /* ignore */ }
    return null;
  }
  async function fuzzyRepairFilters(filters, fields, state, type) {
    if (!filters.length || !(await embedReady())) return;
    // (Reserved hook: embeddings could repair an unresolved option value here.)
  }
  function dot(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

  // ── phrasing helpers ──────────────────────────────────────────────────────
  // Airtable bases commonly suffix table names with "Info", "View", "Master
  // View", or "Table" (so a "clients" table is "Client Info"). For chat copy
  // we strip those suffixes before pluralizing, so a suggestion reads "show
  // all clients" instead of "show all client infos".
  const TYPE_ADMIN_SUFFIX = /\s+(?:master\s+)?(?:info|infos|view|views|table|tables|list|lists|data|records?)$/i;
  function plural(type) {
    const raw = String(type == null ? '' : type).trim();
    if (!raw) return '';
    const stripped = raw.replace(TYPE_ADMIN_SUFFIX, '').trim() || raw;
    const t = norm(stripped);
    if (!t) return norm(raw);
    if (/s$/.test(t)) return t;
    if (/y$/.test(t) && !/[aeiou]y$/.test(t)) return t.slice(0, -1) + 'ies';
    return t + 's';
  }
  function aggLabel(agg) { return { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' }[agg.agg] + (agg.field ? ' (' + agg.field + ')' : ''); }
  function whereNote(filters) {
    return 'where ' + filters.map(f => {
      if (f.op === 'empty') return f.field + ' is empty';
      if (f.op === 'notempty') return f.field + ' is set';
      return f.field + ' ' + opWord(f.op) + ' ' + f.value;
    }).join(' and ');
  }
  function opWord(op) { return { eq: 'is', neq: 'is not', contains: 'contains', ncontains: 'excludes', gt: '>', gte: '≥', lt: '<', lte: '≤' }[op] || op; }
  function titleFor(type, filters, sort, limit) {
    let t = (limit ? 'Top ' + limit + ' ' : '') + plural(type);
    if (filters.length) t += ' ' + whereNote(filters);
    if (sort) t += ' · by ' + sort.field + ' ' + sort.dir;
    return t;
  }

  // A one-line restatement of the query we're about to run, shown in the Ask
  // view BEFORE the answer so a misread is obvious at a glance: "Count of
  // clients" with no "where …" means it didn't catch your filter. Built from
  // the executed spec, so it always mirrors the query that actually ran.
  function describe(spec) {
    if (!spec) return '';
    if (spec.intent === 'calc') return 'Reading that as arithmetic.';
    if (spec.intent === 'profile') return 'Opening the profile' + (spec.target ? ' for “' + stripQuotes(spec.target) + '”' : '') + '.';
    const type = spec.type;
    if (!type) {
      const q = String(spec.question || '').replace(/[?.!]+$/, '').trim();
      return q ? 'Searching every record for “' + q + '”.' : 'Searching your records.';
    }
    const noun = plural(type);
    if (spec.agg && spec.agg.agg) {
      let s = aggLabel(spec.agg) + ' of ' + noun;
      if (spec.agg.groupBy) s += ', grouped by ' + spec.agg.groupBy;
      if (spec.filters && spec.filters.length) s += ', ' + whereNote(spec.filters);
      return s + '.';
    }
    let s = (spec.limit ? 'First ' + spec.limit + ' ' : 'All ') + noun;
    if (spec.filters && spec.filters.length) s += ' ' + whereNote(spec.filters);
    if (spec.sort) s += ', sorted by ' + spec.sort.field + ' (' + spec.sort.dir + ')';
    return s + '.';
  }

  function suggestions(state) {
    const types = knownTypes(state).slice(0, 3);
    const out = [];
    if (types[0]) out.push('Show all ' + plural(types[0]));
    if (types[0]) out.push('How many ' + plural(types[0]) + '?');
    const f = types[0] && fieldsForType(state, types[0]).find(x => x.type === 'select');
    if (f && f.options && f.options[0]) out.push(plural(types[0]) + ' where ' + f.name + ' is ' + f.options[0]);
    const rec = Object.values(state.entities || {})[0];
    if (rec) out.push('Tell me about ' + recordLabel(rec));
    return out;
  }

  // ── lazy engine loader (browser) ──────────────────────────────────────────
  let _enginePromise = null, _llmPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-dc-src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = false; s.setAttribute('data-dc-src', src);
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  // Where the Cleo engine lives. The engine is NOT vendored here — it's loaded
  // from the eoreader3 deployment so this app always tracks the latest engine
  // (it's actively developed in that repo). Override with window.EOREADER_BASE
  // to point at a local eoreader3 dev server while working on both, e.g.
  //   window.EOREADER_BASE = 'http://localhost:5500/';   // before first ask
  const EOREADER_DEFAULT = 'https://clovenbradshaw-ctrl.github.io/eoreader3/';
  function eoreaderBase() {
    if (typeof window !== 'undefined' && window.EOREADER_BASE) {
      const b = String(window.EOREADER_BASE);
      return b.endsWith('/') ? b : b + '/';
    }
    return EOREADER_DEFAULT;
  }
  // Load the deterministic engine + arithmetic + (lazy) embeddings from
  // eoreader3. Idempotent. On failure (offline / not deployed) the chat still
  // works — the query core is pure JS; only arithmetic/prose/fuzzy degrade.
  function ensureEngine() {
    if (typeof window === 'undefined') return Promise.resolve(false);
    if (_enginePromise) return _enginePromise;
    const b = eoreaderBase();
    _enginePromise = (async () => {
      try {
        // compromise + math are the engine's two hard deps (same pinned
        // versions eoreader3 itself loads); everything else is window.EO*.
        if (!window.nlp) await loadScript('https://cdn.jsdelivr.net/npm/compromise@14.15.1/builds/compromise.min.js');
        if (!window.math) await loadScript('https://cdn.jsdelivr.net/npm/mathjs@13.2.3/lib/browser/math.js');
        if (!window.EOEngine) await loadScript(b + 'engine.js');
        if (!window.EOCompute) await loadScript(b + 'compute.js');
        if (!window.EOEmbed) await loadScript(b + 'embed.js');
        return !!window.EOEngine;
      } catch (e) { if (window.console) console.warn('[DataChat] engine load failed (degrading to pure-JS queries):', e.message); return false; }
    })();
    return _enginePromise;
  }
  // Optional on-device phrasing/intent model. NEVER the cloud (Anthropic)
  // backend — only wllama (CPU) keys are ever passed to EOLLM from the Ask view.
  function ensureLLM() {
    if (typeof window === 'undefined') return Promise.resolve(false);
    if (_llmPromise) return _llmPromise;
    _llmPromise = (async () => {
      await ensureEngine();
      try { if (!window.EOLLM) await loadScript(eoreaderBase() + 'llm.js'); return !!window.EOLLM; }
      catch (e) { return false; }
    })();
    return _llmPromise;
  }
  function warmEmbeddings() { try { if (window.EOEmbed && window.EOEmbed.warm) window.EOEmbed.warm(); } catch (e) {} }

  // Install the on-device intent model's WEIGHTS (the heavy part). ensureLLM
  // loads only the runtime; this downloads/initializes the chosen model so the
  // chat can actually use it. Idempotent + best-effort — returns false if the
  // model backend (eoreader3 llm.js) or the download isn't available, so a
  // failure here never blocks the deterministic query core.
  async function loadModel(key, onProgress) {
    const ready = await ensureLLM();
    if (!ready || typeof window === 'undefined' || !window.EOLLM || !window.EOLLM.load) return false;
    const k = key || defaultLLMKey();
    if (!k) return false;
    try {
      if (window.EOLLM.isLoaded && window.EOLLM.isLoaded(k)) return true;
      const ok = await window.EOLLM.load(k, onProgress);
      return ok !== false;
    } catch (e) { return false; }
  }

  // Is there heap headroom to pull in a heavy WASM runtime? This app governs a
  // memory budget and sheds caches under pressure (src/memory.js); we must not
  // OOM the tab loading Pyodide on top of a big workspace. No signal ⇒ allow.
  function memoryHeadroomOK() {
    try {
      const m = (typeof performance !== 'undefined') && performance.memory;
      if (m && typeof m.usedJSHeapSize === 'number' && typeof m.jsHeapSizeLimit === 'number' && m.jsHeapSizeLimit > 0) {
        return m.usedJSHeapSize < m.jsHeapSizeLimit * 0.85;
      }
    } catch (e) {}
    return true;
  }

  // Optional Python data-analysis runtime: Pyodide + numpy + pandas, loaded
  // lazily and only when there's headroom. Exposes window.EOPy = { pyodide,
  // ready, df(type) } on success. Best-effort: the query core never depends on
  // it. df(type) materializes a table's records as a pandas DataFrame so the
  // chat (or a future NL→pandas step) can run real analysis on the live fold.
  let _pyPromise = null;
  const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
  function ensurePython(opts) {
    if (typeof window === 'undefined') return Promise.resolve(false);
    if (_pyPromise) return _pyPromise;
    _pyPromise = (async () => {
      try {
        if (!memoryHeadroomOK()) { if (window.console) console.warn('[DataChat] skipping Python load — low memory headroom'); _pyPromise = null; return false; }
        if (opts && opts.onStatus) opts.onStatus('Loading Python runtime…');
        if (!window.loadPyodide) await loadScript(PYODIDE_CDN + 'pyodide.js');
        const pyodide = await window.loadPyodide({ indexURL: PYODIDE_CDN });
        if (opts && opts.onStatus) opts.onStatus('Loading numpy + pandas…');
        await pyodide.loadPackage(['numpy', 'pandas']);
        window.EOPy = {
          pyodide, ready: true,
          // Hand a table's live records to pandas (plain fields only).
          df(type, state) {
            const rows = entitiesOfType(state, type).map(e => {
              const o = {}; for (const k of Object.keys(e)) if (!isUnderscore(k)) o[k] = e[k]; return o;
            });
            pyodide.globals.set('__rows', pyodide.toPy(rows));
            return pyodide.runPython('import pandas as pd\npd.DataFrame(__rows.to_py() if hasattr(__rows, "to_py") else __rows)');
          },
        };
        return true;
      } catch (e) { if (window.console) console.warn('[DataChat] Python load failed:', e && e.message); _pyPromise = null; return false; }
    })();
    return _pyPromise;
  }
  function pythonReady() { return typeof window !== 'undefined' && !!(window.EOPy && window.EOPy.ready); }

  // Bring up the analysis stack in a memory-safe order: the deterministic
  // engine + math.js first (cheap, always useful), then the model weights, then
  // the Python stack (heaviest, headroom-gated). Each step is best-effort.
  async function ensureAnalysis(opts) {
    opts = opts || {};
    await ensureEngine();                       // compromise + math.js + EOCompute + EOEmbed
    let model = false, python = false;
    if (opts.loadModel !== false) model = await loadModel(opts.modelKey, opts.onModelProgress).catch(() => false);
    if (opts.loadPython) python = await ensurePython(opts).catch(() => false);
    const w = (typeof window !== 'undefined') ? window : {};
    return { engine: !!w.EOEngine, math: !!w.math, model: !!model, python: !!python };
  }

  // ── exports ───────────────────────────────────────────────────────────────
  const api = {
    interpret, buildPlan, buildPlanForType, executePlan, planWithLLM, ensureEngine, ensureLLM, warmEmbeddings,
    loadModel, ensurePython, pythonReady, ensureAnalysis, describe,
    defaultLLMKey, schemaPrompt, parsePlanJSON,
    maybeTypeConfirm, maybeFloodConfirm,
    // pure helpers (exposed for tests + the chat view's profile popup)
    recordLabel, knownTypes, fieldsForType, columnsForType, preferredColumns, entitiesOfType,
    matchType, matchTypeScored, resolveField, validateFilters, applyFilters, parseFilters,
    parseAggregate, aggregate, parseSort, parseLimit, sortRecords, relatedRecords,
    linkedTypesFor, resolveRecord, globalSearch, selectFieldsForPrompt,
    parseValueFilters, fieldForValue, displayValue, plural, _version: '3',
  };
  if (typeof window !== 'undefined') window.DataChat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
