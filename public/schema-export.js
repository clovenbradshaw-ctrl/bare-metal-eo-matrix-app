/* schema-export.js — render this workspace's schema in portable formats.
 *
 * A workspace's schema lives in `state.schema` (DEFs with anchor=null and
 * path starting "_schema."). This module renders it three ways:
 *
 *   window.SchemaExport.toJSON(state)     → canonical JSON
 *   window.SchemaExport.toSQL(state)      → CREATE TABLE … statements
 *   window.SchemaExport.toMarkdown(state) → human-readable report
 *
 * Pure — no DOM, no globals other than the assignment at the bottom. Loaded
 * as a classic script alongside airtable-schema.js so it's testable from
 * Node with a `module` shim.
 */

(function () {
  'use strict';

  // Field type → SQL column type. Matches table-view.jsx's sqlType().
  // For computed / structured types we still pick the closest scalar so the
  // emitted DDL is loadable; the original type lives on as a comment.
  const SQL_TYPE = {
    text: 'TEXT',
    longtext: 'TEXT',
    number: 'NUMERIC',
    boolean: 'BOOLEAN',
    date: 'TIMESTAMP',
    json: 'JSONB',
    select: 'TEXT',
    multiselect: 'TEXT[]',
    url: 'TEXT',
    email: 'TEXT',
    linked: 'TEXT',
    formula: 'TEXT',
    rollup: 'TEXT',
  };

  function sqlType(t) {
    return SQL_TYPE[t] || 'TEXT';
  }

  // SQL identifier quoting. Safe alphanumerics pass through; anything else is
  // wrapped in double quotes with embedded quotes doubled (Postgres rules).
  function quoteIdent(name) {
    const s = String(name == null ? '' : name);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  // Collect every set the user would consider a "table":
  //   declared — listed in state.schema.tables
  //   observed — has at least one entity in state.entities (excluding _types
  //              that start with "_", e.g. _synthesis)
  // Returns an array of { name, declared, observed, rowCount } in stable order
  // (declared first, in declaration order; then observed-only, alphabetical).
  function listTables(state) {
    const schema = (state && state.schema) || {};
    const entities = (state && state.entities) || {};
    const declared = Array.isArray(schema.tables) ? schema.tables.slice() : [];
    const observedSet = new Set();
    const rowCounts = Object.create(null);
    for (const e of Object.values(entities)) {
      const t = e && e._type;
      if (!t || t.startsWith('_')) continue;
      observedSet.add(t);
      rowCounts[t] = (rowCounts[t] || 0) + 1;
    }
    const declaredSet = new Set(declared);
    const observedOnly = Array.from(observedSet).filter(t => !declaredSet.has(t)).sort();
    const out = [];
    for (const name of declared) {
      out.push({
        name,
        declared: true,
        observed: observedSet.has(name),
        rowCount: rowCounts[name] || 0,
      });
    }
    for (const name of observedOnly) {
      out.push({ name, declared: false, observed: true, rowCount: rowCounts[name] || 0 });
    }
    return out;
  }

  // Fields-with-fallback: schema.fields[name] is authoritative when present;
  // otherwise we infer from observed entity keys so unschematized sets still
  // emit usable DDL. Inferred fields are flagged with `inferred: true`.
  function fieldsFor(state, tableName) {
    const schema = (state && state.schema) || {};
    const declared = schema.fields && schema.fields[tableName];
    if (Array.isArray(declared) && declared.length > 0) {
      return declared.map(f => ({ ...f, inferred: false }));
    }
    // Infer column names from the union of keys across rows. Skip
    // underscore-prefixed bookkeeping (_anchor, _hwm, _created, …).
    const entities = (state && state.entities) || {};
    const seen = new Map(); // name → first-seen index, for stable order
    let i = 0;
    for (const e of Object.values(entities)) {
      if (!e || e._type !== tableName) continue;
      for (const k of Object.keys(e)) {
        if (k.startsWith('_')) continue;
        if (!seen.has(k)) seen.set(k, i++);
      }
    }
    return Array.from(seen.keys()).map(name => ({ name, type: 'text', inferred: true }));
  }

  // Partitions declared in _schema.partitions.<table>, plus a list of any
  // partitions actually observed on entities of that type but not declared.
  function partitionsFor(state, tableName) {
    const schema = (state && state.schema) || {};
    const declared = (schema.partitions && schema.partitions[tableName]) || null;
    const observed = new Set();
    const partitions = (state && state.partitions) || {};
    const entities = (state && state.entities) || {};
    for (const [anchor, part] of Object.entries(partitions)) {
      const e = entities[anchor];
      if (e && e._type === tableName && part) observed.add(part);
    }
    const declaredList = Array.isArray(declared) ? declared.slice() : [];
    const declaredSet = new Set(declaredList);
    const undeclared = Array.from(observed).filter(p => !declaredSet.has(p)).sort();
    return {
      declared: declaredList,
      observed: Array.from(observed).sort(),
      undeclared,
      hasPartitions: declaredList.length > 0 || observed.size > 0,
    };
  }

  // Saved views (table presentations) per set.
  function viewsFor(state, tableName) {
    const schema = (state && state.schema) || {};
    const views = schema.views && schema.views[tableName];
    return Array.isArray(views) ? views.slice() : [];
  }

  // Link rules: _schema.links is [{from, to, rel}]. We carry it as-is.
  function links(state) {
    const schema = (state && state.schema) || {};
    return Array.isArray(schema.links) ? schema.links.slice() : [];
  }

  // The intermediate model — the same shape every renderer reads. Exposed
  // separately so callers (and tests) can inspect what's about to be rendered
  // without parsing the formatted output.
  function buildModel(state) {
    const tables = listTables(state).map(t => {
      const fields = fieldsFor(state, t.name);
      const partitions = partitionsFor(state, t.name);
      const views = viewsFor(state, t.name);
      return { ...t, fields, partitions, views };
    });
    return {
      workspace: (state && state.workspace) || null,
      tables,
      links: links(state),
      generatedAt: new Date().toISOString(),
    };
  }

  // ── JSON ──────────────────────────────────────────────────────────────────
  // Canonical form. Includes the intermediate model so it round-trips through
  // tooling without losing the declared/observed distinction.
  function toJSON(state, { pretty = true } = {}) {
    const model = buildModel(state);
    return pretty ? JSON.stringify(model, null, 2) : JSON.stringify(model);
  }

  // ── SQL ────────────────────────────────────────────────────────────────────
  // CREATE TABLE per set + a _connections relation when _schema.links is
  // populated. Comments preserve the things SQL can't carry — select options,
  // formula text, link targets — so a reader gets both runnable DDL and the
  // semantics that don't survive the translation.
  function toSQL(state, opts = {}) {
    const dialect = opts.dialect || 'postgres';
    const model = buildModel(state);
    const out = [];

    out.push(`-- Schema export · ${model.generatedAt}`);
    if (model.workspace) out.push(`-- Workspace: ${model.workspace}`);
    out.push(`-- ${model.tables.length} table${model.tables.length === 1 ? '' : 's'}` +
             (model.links.length ? `, ${model.links.length} link rule${model.links.length === 1 ? '' : 's'}` : ''));
    out.push('');

    for (const t of model.tables) {
      if (!t.declared) {
        out.push(`-- ! ${quoteIdent(t.name)} is not declared in _schema.tables (present because of data)`);
      }
      out.push(`CREATE TABLE ${quoteIdent(t.name)} (`);
      // Build (col, comment) pairs first. Commas have to go BEFORE the inline
      // `--` comment so the line comment doesn't swallow them and break the
      // parser. The last column has no trailing comma.
      const items = [];
      items.push({ col: `  ${quoteIdent('_anchor')} TEXT PRIMARY KEY`, comment: '' });
      for (const f of t.fields) {
        const ty = sqlType(f.type);
        const comments = [];
        if (f.inferred) comments.push('inferred from data');
        // Annotate semantically rich types that SQL flattens to TEXT.
        if (f.type === 'select' || f.type === 'multiselect') {
          if (Array.isArray(f.options) && f.options.length) {
            comments.push(`${f.type} options: ${f.options.join(', ')}`);
          } else {
            comments.push(`${f.type}`);
          }
        } else if (f.type === 'longtext' || f.type === 'url' || f.type === 'email') {
          comments.push(f.type);
        }
        if (f.formula) comments.push(`formula: ${f.formula}`);
        if (f.rollup) {
          const r = f.rollup;
          comments.push(`rollup: ${r.fn || 'count'}(${r.field || ''}) via ${r.via || ''}`);
        }
        if (f.linkedTable) comments.push(`linked → ${f.linkedTable}`);
        items.push({
          col: `  ${quoteIdent(f.name)} ${ty}`,
          comment: comments.join('; '),
        });
      }
      if (t.partitions.hasPartitions) {
        const note = t.partitions.declared.length
          ? `partitions: ${t.partitions.declared.join(', ')}`
          : `partitions observed (not in schema): ${t.partitions.observed.join(', ')}`;
        items.push({ col: `  ${quoteIdent('_partition')} TEXT`, comment: note });
      }
      for (let i = 0; i < items.length; i++) {
        const sep = i < items.length - 1 ? ',' : '';
        const tail = items[i].comment ? `${sep}  -- ${items[i].comment}` : sep;
        out.push(items[i].col + tail);
      }
      out.push(`);`);
      out.push('');
    }

    if (model.links.length) {
      out.push(`-- typed relationships emitted by CON events`);
      out.push(`CREATE TABLE ${quoteIdent('_connections')} (`);
      out.push(`  ${quoteIdent('source')} TEXT NOT NULL,  -- anchor`);
      out.push(`  ${quoteIdent('rel')} TEXT NOT NULL,`);
      out.push(`  ${quoteIdent('target')} TEXT NOT NULL   -- anchor`);
      out.push(`);`);
      out.push('-- declared link rules:');
      for (const l of model.links) {
        out.push(`--   ${l.from} → ${l.rel} → ${l.to}`);
      }
      out.push('');
    }

    // dialect note (mostly for future-proofing — for now SQL is Postgres-ish)
    if (dialect !== 'postgres') {
      out.unshift(`-- (dialect "${dialect}" requested — emitted as portable SQL)`);
    }

    return out.join('\n').replace(/\n+$/, '\n');
  }

  // ── Markdown ───────────────────────────────────────────────────────────────
  // Reading order: workspace title (when known), one section per table with a
  // field table, then a section for partitions + links if either is present.
  function toMarkdown(state) {
    const model = buildModel(state);
    const out = [];

    out.push(`# Workspace Schema`);
    if (model.workspace) out.push(`*${model.workspace}*`);
    out.push('');
    out.push(`_${model.tables.length} table${model.tables.length === 1 ? '' : 's'}_  ·  generated ${model.generatedAt}`);
    out.push('');

    if (model.tables.length === 0) {
      out.push('_No tables declared or observed in this workspace._');
      return out.join('\n') + '\n';
    }

    for (const t of model.tables) {
      const flag = t.declared ? '' : ' _(unschematized — observed in data)_';
      out.push(`## ${t.name}${flag}`);
      out.push('');
      const rowMeta = `**${t.rowCount}** row${t.rowCount === 1 ? '' : 's'}`;
      const fieldMeta = `**${t.fields.length}** field${t.fields.length === 1 ? '' : 's'}`;
      out.push(`${rowMeta}  ·  ${fieldMeta}`);
      out.push('');

      out.push('| field | type | notes |');
      out.push('| --- | --- | --- |');
      out.push('| `_anchor` | TEXT | primary key (content-addressed) |');
      for (const f of t.fields) {
        const notes = [];
        if (f.inferred) notes.push('inferred from data');
        if (Array.isArray(f.options) && f.options.length) {
          notes.push('options: ' + f.options.map(o => '`' + o + '`').join(', '));
        }
        if (f.formula) notes.push('formula `' + f.formula + '`');
        if (f.rollup) {
          const r = f.rollup;
          notes.push('rollup `' + (r.fn || 'count') + '(' + (r.field || '') + ')` via `' + (r.via || '') + '`');
        }
        if (f.linkedTable) notes.push('linked → `' + f.linkedTable + '`');
        out.push(`| \`${f.name}\` | ${f.type || 'text'} | ${notes.join('; ') || ''} |`);
      }
      out.push('');

      if (t.partitions.hasPartitions) {
        if (t.partitions.declared.length) {
          out.push(`**Partitions:** ${t.partitions.declared.map(p => '`' + p + '`').join(', ')}`);
        }
        if (t.partitions.undeclared.length) {
          out.push(`**Observed but undeclared partitions:** ${t.partitions.undeclared.map(p => '`' + p + '`').join(', ')}`);
        }
        out.push('');
      }

      if (t.views.length) {
        out.push(`**Saved views:** ${t.views.map(v => '`' + v.name + '` (' + (v.kind || 'table') + ')').join(', ')}`);
        out.push('');
      }
    }

    if (model.links.length) {
      out.push('## Link rules');
      out.push('');
      for (const l of model.links) {
        out.push(`- \`${l.from}\` → **${l.rel}** → \`${l.to}\``);
      }
      out.push('');
    }

    return out.join('\n');
  }

  const api = {
    buildModel,
    listTables,
    fieldsFor,
    partitionsFor,
    viewsFor,
    links,
    sqlType,
    quoteIdent,
    toJSON,
    toSQL,
    toMarkdown,
    version: 1,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SchemaExport = api;
})();
