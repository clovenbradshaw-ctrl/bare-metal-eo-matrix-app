/* airtable-schema.js — turn an Airtable schema JSON into this app's schema,
 * WITHOUT importing a single row of data.
 *
 * The whole point: an Airtable base is a set of tables whose columns include
 * computed fields (formula, rollup, lookup, count, created/modified time).
 * Those are DEFINITIONS, not data. This module maps them onto
 * `_schema.fields.<table>` entries so that — once you import real rows into the
 * table — formula.js derives every computed value at render time. We never
 * carry Airtable's pre-computed cell values across; we carry the expression.
 *
 *   window.AirtableSchema.parse(jsonOrString)
 *     -> { ok, tables, links, warnings, error }
 *
 *   tables: [{
 *     name,                         // table name (used as the entity set)
 *     id,                           // Airtable table id (tbl…) when known —
 *                                   //   lets the PAT widget fetch its records
 *     primary,                      // name of the primary field (or undefined)
 *     fields: [ { name, type, options?, formula?, rollup?, linkedTable? } ],
 *     counts: { total, computed },  // field tallies for the preview
 *   }]
 *   links:  [{ from, to, rel }]      // record-link relations → _schema.links
 *   warnings: string[]               // fields downgraded / skipped, etc.
 *
 * Accepts any of:
 *   - the Metadata API response   { tables: [ {id,name,fields:[…]}, … ] }
 *   - a bare array of table objects   [ {id?,name,fields:[…]}, … ]
 *   - a single table object           { id?, name, fields:[…] }
 *
 * The mapped shapes match what table-view.jsx/buildTable + formula.js expect:
 *   formula field → { name, type:'formula', formula:'<expr>' }
 *   rollup/lookup → { name, type:'rollup',  rollup:{ via, field?, fn } }
 *   select        → { name, type:'select',  options:[ '<choice>', … ] }
 *   record link   → { name, type:'linked',  linkedTable:'<table>' }  + a link row
 */

(function () {
  'use strict';

  // Airtable field type → this app's field type. Computed types are handled
  // specially in mapField (they need options); everything here is 1:1.
  const SIMPLE_TYPE_MAP = {
    singleLineText: 'text',
    phoneNumber: 'text',
    barcode: 'text',
    singleCollaborator: 'text',
    createdBy: 'text',
    lastModifiedBy: 'text',
    externalSyncSource: 'text',
    multilineText: 'longtext',
    richText: 'longtext',
    aiText: 'longtext',
    email: 'email',
    url: 'url',
    number: 'number',
    percent: 'number',
    currency: 'number',
    rating: 'number',
    duration: 'number',
    autoNumber: 'number',
    checkbox: 'boolean',
    date: 'date',
    dateTime: 'date',
    // Attachment files aren't re-hosted (their Airtable URLs expire); the PAT
    // importer stores a short text summary, so the column is plain text.
    multipleAttachments: 'text',
  };

  // Airtable rollup/lookup aggregations → formula.js ROLLUP_FNS.
  function rollupFn(formula) {
    const m = String(formula || '').trim().match(/^([A-Za-z_]+)\s*\(/);
    const head = (m ? m[1] : '').toUpperCase();
    const map = {
      SUM: 'sum',
      AVERAGE: 'avg', AVG: 'avg',
      MIN: 'min', MAX: 'max',
      COUNT: 'count', COUNTA: 'count', COUNTALL: 'count',
      ARRAYJOIN: 'concat', CONCATENATE: 'concat',
      ARRAYUNIQUE: 'list', ARRAYCOMPACT: 'list',
      AND: 'and', OR: 'or',
    };
    return map[head] || 'list';
  }

  function choiceNames(options) {
    const choices = options && Array.isArray(options.choices) ? options.choices : [];
    return choices.map(c => (c && c.name != null ? String(c.name) : '')).filter(Boolean);
  }

  // Rewrite field references inside an Airtable formula so they match this
  // app's field names. Airtable returns references wrapped in braces; the
  // token inside is usually the human field NAME, but can be a field ID
  // (fld…). We map any {fld…} to {Name}; name-based refs pass through. The
  // braces themselves are exactly what formula.js's {field} syntax expects.
  function rewriteRefs(expr, fieldIdToName) {
    if (!expr) return '';
    return String(expr).replace(/\{([^}]+)\}/g, (whole, inner) => {
      const token = inner.trim();
      // Rewrite only tokens that are a known field ID (fld…). A name-based
      // ref — even one that oddly starts with "fld" — won't be in the id map,
      // so it passes through untouched and resolves by name at render time.
      if (/^fld[A-Za-z0-9]+$/.test(token) && fieldIdToName.has(token)) {
        return '{' + fieldIdToName.get(token) + '}';
      }
      return whole;
    });
  }

  function isComputed(type) {
    return type === 'formula' || type === 'rollup';
  }

  // ── Map ONE Airtable field to this app's field shape (or null to skip). ──
  function mapField(f, ctx) {
    const name = f.name;
    const at = f.type;
    const opts = f.options || {};

    if (Object.prototype.hasOwnProperty.call(SIMPLE_TYPE_MAP, at)) {
      return { name, type: SIMPLE_TYPE_MAP[at] };
    }

    switch (at) {
      case 'singleSelect':
        return { name, type: 'select', options: choiceNames(opts) };
      case 'multipleSelects':
        return { name, type: 'multiselect', options: choiceNames(opts) };
      case 'multipleCollaborators':
        return { name, type: 'multiselect', options: [] };

      // Airtable's created/modified time are computed; this app derives the
      // same thing at runtime from the INS / last-DEF timestamps. DATESTR keeps
      // the cell a readable date instead of raw epoch milliseconds.
      case 'createdTime':
        return { name, type: 'formula', formula: 'DATESTR(CREATED_TIME())' };
      case 'lastModifiedTime':
        return { name, type: 'formula', formula: 'DATESTR(LAST_MODIFIED_TIME())' };

      case 'formula':
        return { name, type: 'formula', formula: rewriteRefs(opts.formula || '', ctx.fieldIdToName) };

      case 'rollup': {
        const via = ctx.fieldIdToName.get(opts.recordLinkFieldId) || '';
        const field = ctx.fieldIdToName.get(opts.fieldIdInLinkedTable) || undefined;
        const rollup = { via, fn: rollupFn(opts.formula) };
        if (field) rollup.field = field;
        if (!via) ctx.warnings.push(`rollup "${name}": couldn't resolve its link field — set "via" in the schema view`);
        return { name, type: 'rollup', rollup };
      }
      case 'count': {
        const via = ctx.fieldIdToName.get(opts.recordLinkFieldId) || '';
        if (!via) ctx.warnings.push(`count "${name}": couldn't resolve its link field — set "via" in the schema view`);
        return { name, type: 'rollup', rollup: { via, fn: 'count' } };
      }
      case 'multipleLookupValues': {
        const via = ctx.fieldIdToName.get(opts.recordLinkFieldId) || '';
        const field = ctx.fieldIdToName.get(opts.fieldIdInLinkedTable) || undefined;
        const rollup = { via, fn: 'list' };
        if (field) rollup.field = field;
        if (!via) ctx.warnings.push(`lookup "${name}": couldn't resolve its link field — set "via" in the schema view`);
        return { name, type: 'rollup', rollup };
      }

      case 'singleRecordLink':
      case 'multipleRecordLinks': {
        const to = ctx.tableNameById.get(opts.linkedTableId);
        if (to) ctx.links.push({ from: ctx.tableName, to, rel: name });
        else ctx.warnings.push(`link "${name}": linked table not in this schema`);
        const out = { name, type: 'linked' };
        if (to) out.linkedTable = to;
        return out;
      }

      case 'button':
        ctx.warnings.push(`skipped button field "${name}" — no data equivalent`);
        return null;

      default:
        ctx.warnings.push(`unknown Airtable type "${at}" for "${name}" — imported as text`);
        return { name, type: 'text' };
    }
  }

  function coerceTables(json) {
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.tables)) return json.tables;
    if (json && Array.isArray(json.fields) && json.name) return [json];
    return null;
  }

  function parse(input) {
    let json = input;
    if (typeof input === 'string') {
      const text = input.trim();
      if (!text) return { ok: false, error: 'paste your Airtable schema JSON first' };
      try { json = JSON.parse(text); }
      catch (e) { return { ok: false, error: 'invalid JSON: ' + (e && e.message ? e.message : String(e)) }; }
    }

    const rawTables = coerceTables(json);
    if (!rawTables) {
      return { ok: false, error: 'expected an Airtable schema — { "tables": [ … ] }, an array of tables, or one table object with a "fields" array' };
    }
    if (rawTables.length === 0) {
      return { ok: false, error: 'the schema has no tables' };
    }

    // Base-wide id → name maps. Field ids are unique across the base, so a
    // single map resolves both same-table formula refs and cross-table
    // rollup/lookup target fields.
    const fieldIdToName = new Map();
    const tableNameById = new Map();
    for (const t of rawTables) {
      if (t && t.id && t.name) tableNameById.set(t.id, t.name);
      const fields = t && Array.isArray(t.fields) ? t.fields : [];
      for (const f of fields) if (f && f.id && f.name) fieldIdToName.set(f.id, f.name);
    }

    const warnings = [];
    const links = [];
    const tables = [];

    for (const t of rawTables) {
      if (!t || !t.name || !Array.isArray(t.fields)) {
        warnings.push('skipped a table with no name or no fields array');
        continue;
      }
      const ctx = { fieldIdToName, tableNameById, tableName: t.name, links, warnings };
      const fields = [];
      const seen = new Set();
      for (const f of t.fields) {
        if (!f || !f.name) continue;
        const mapped = mapField(f, ctx);
        if (!mapped) continue;
        if (seen.has(mapped.name)) { warnings.push(`table "${t.name}": duplicate field name "${mapped.name}" skipped`); continue; }
        seen.add(mapped.name);
        fields.push(mapped);
      }
      const computed = fields.filter(x => isComputed(x.type)).length;
      tables.push({
        name: t.name,
        id: t.id || undefined,
        primary: t.primaryFieldId ? fieldIdToName.get(t.primaryFieldId) : undefined,
        fields,
        counts: { total: fields.length, computed },
      });
    }

    // De-dupe links (both link directions can name the same relation).
    const seenLink = new Set();
    const uniqueLinks = links.filter(l => {
      const key = l.from + ' ' + l.to + ' ' + l.rel;
      if (seenLink.has(key)) return false;
      seenLink.add(key);
      return true;
    });

    return { ok: true, tables, links: uniqueLinks, warnings };
  }

  const api = {
    parse,
    isComputed,
    rollupFn,
    rewriteRefs,
    SIMPLE_TYPE_MAP,
    version: 1,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AirtableSchema = api;
})();
