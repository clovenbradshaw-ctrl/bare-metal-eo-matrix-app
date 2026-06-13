/* Headless test for public/schema-export.js.
 *
 * The module is a browser classic-script (assigns window.SchemaExport) but
 * also assigns module.exports when a CommonJS `module` is in scope. We load it
 * by evaluating the source with a module shim and an undefined `window`.
 *
 *   node test/schema-export.test.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'schema-export.js'), 'utf8');
const shim = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'window', src)(shim, undefined);
const SE = shim.exports;

let failures = 0;
function check(label, cond) {
  if (cond) { console.log('  ok  ' + label); }
  else { failures++; console.log('FAIL  ' + label); }
}
function contains(label, haystack, needle) {
  const ok = String(haystack).includes(needle);
  check(label + (ok ? '' : `  (missing ${JSON.stringify(needle)})`), ok);
}
function notContains(label, haystack, needle) {
  const ok = !String(haystack).includes(needle);
  check(label + (ok ? '' : `  (unexpectedly includes ${JSON.stringify(needle)})`), ok);
}

// ── Fixture: a realistic workspace state ─────────────────────────────────
function makeState() {
  return {
    schema: {
      tables: ['task', 'note'],
      fields: {
        task: [
          { name: 'title', type: 'text' },
          { name: 'priority', type: 'select', options: ['high', 'med', 'low'] },
          { name: 'estimate_h', type: 'number' },
          { name: 'completed_at', type: 'date' },
        ],
        note: [
          { name: 'body', type: 'longtext' },
        ],
      },
      partitions: {
        task: ['backlog', 'doing', 'done'],
      },
      links: [
        { from: 'task', to: 'task', rel: 'blocks' },
        { from: 'note', to: 'task', rel: 'annotates' },
      ],
      views: {
        task: [{ id: 'v1', name: 'High priority', kind: 'table' }],
      },
    },
    entities: {
      task_a: { _anchor: 'task_a', _type: 'task', title: 'Port operators.js' },
      task_b: { _anchor: 'task_b', _type: 'task', title: 'Spec' },
      note_a: { _anchor: 'note_a', _type: 'note', body: 'see §3' },
    },
    partitions: { task_a: 'doing', task_b: 'backlog' },
    connections: [],
  };
}

console.log('--- buildModel ---');
{
  const m = SE.buildModel(makeState());
  check('two tables', m.tables.length === 2);
  check('first table is task', m.tables[0].name === 'task');
  check('task is declared', m.tables[0].declared === true);
  check('task field count', m.tables[0].fields.length === 4);
  check('task partitions declared', m.tables[0].partitions.declared.length === 3);
  check('task partitions observed', m.tables[0].partitions.observed.length === 2);
  check('task has saved view', m.tables[0].views.length === 1);
  check('two link rules', m.links.length === 2);
}

console.log('--- toSQL ---');
{
  const sql = SE.toSQL(makeState());
  contains('CREATE TABLE task', sql, 'CREATE TABLE task (');
  contains('CREATE TABLE note', sql, 'CREATE TABLE note (');
  contains('_anchor primary key', sql, '_anchor TEXT PRIMARY KEY');
  contains('title TEXT column', sql, 'title TEXT');
  contains('priority TEXT column', sql, 'priority TEXT');
  contains('priority options preserved as comment', sql, 'options: high, med, low');
  contains('estimate_h NUMERIC column', sql, 'estimate_h NUMERIC');
  contains('completed_at TIMESTAMP column', sql, 'completed_at TIMESTAMP');
  contains('body TEXT column', sql, 'body TEXT');
  contains('_partition column with comment', sql, '_partition TEXT');
  contains('partitions in comment', sql, 'partitions: backlog, doing, done');
  contains('_connections table', sql, 'CREATE TABLE _connections (');
  contains('link rule task → blocks', sql, 'task → blocks → task');
  contains('source column on _connections', sql, 'source TEXT NOT NULL');
  contains('header generated timestamp', sql, '-- Schema export ·');
}

console.log('--- toJSON ---');
{
  const json = SE.toJSON(makeState());
  const parsed = JSON.parse(json);
  check('json is parsable', typeof parsed === 'object');
  check('json includes two tables', parsed.tables.length === 2);
  check('json table preserves field options', parsed.tables[0].fields[1].options.length === 3);
  check('json includes links', parsed.links.length === 2);
  check('json generatedAt present', typeof parsed.generatedAt === 'string' && parsed.generatedAt.length > 0);
}

console.log('--- toMarkdown ---');
{
  const md = SE.toMarkdown(makeState());
  contains('h1 header', md, '# Workspace Schema');
  contains('task section', md, '## task');
  contains('note section', md, '## note');
  contains('field table header', md, '| field | type | notes |');
  contains('title row', md, '| `title` | text');
  contains('priority options', md, 'options:');
  contains('partition section', md, 'Partitions:');
  contains('saved view summary', md, 'Saved views:');
  contains('link rules section', md, '## Link rules');
  contains('blocks rule', md, 'blocks');
}

console.log('--- unschematized tables (observed but not declared) ---');
{
  const state = {
    schema: { tables: ['task'], fields: { task: [{ name: 'title', type: 'text' }] } },
    entities: {
      t1: { _anchor: 't1', _type: 'task', title: 'A' },
      m1: { _anchor: 'm1', _type: 'meeting', when: 'tomorrow', topic: 'review' },
    },
    partitions: {},
    connections: [],
  };
  const m = SE.buildModel(state);
  check('declared task present', m.tables[0].name === 'task' && m.tables[0].declared);
  check('observed meeting present', m.tables[1].name === 'meeting' && !m.tables[1].declared);
  check('meeting fields inferred from data', m.tables[1].fields.every(f => f.inferred));
  check('meeting field count is 2', m.tables[1].fields.length === 2);
  check('meeting fields exclude _underscore keys',
    m.tables[1].fields.every(f => !f.name.startsWith('_')));
  const sql = SE.toSQL(state);
  contains('warns about unschematized', sql, 'is not declared in _schema.tables');
  contains('inferred-from-data comment', sql, 'inferred from data');
}

console.log('--- observed partitions (not in schema) ---');
{
  const state = {
    schema: { tables: ['task'], fields: { task: [{ name: 'title', type: 'text' }] } },
    entities: {
      t1: { _anchor: 't1', _type: 'task', title: 'A' },
      t2: { _anchor: 't2', _type: 'task', title: 'B' },
    },
    partitions: { t1: 'inbox', t2: 'inbox' },
    connections: [],
  };
  const m = SE.buildModel(state);
  check('observed partition surfaces', m.tables[0].partitions.observed.includes('inbox'));
  check('observed partition is undeclared',
    m.tables[0].partitions.undeclared.includes('inbox'));
  const sql = SE.toSQL(state);
  contains('SQL flags undeclared partition', sql, 'partitions observed (not in schema): inbox');
}

console.log('--- empty workspace ---');
{
  const m = SE.buildModel({ schema: {}, entities: {}, partitions: {}, connections: [] });
  check('no tables', m.tables.length === 0);
  check('no links', m.links.length === 0);
  const md = SE.toMarkdown({ schema: {}, entities: {}, partitions: {}, connections: [] });
  contains('empty markdown copy', md, 'No tables');
  const sql = SE.toSQL({ schema: {}, entities: {}, partitions: {}, connections: [] });
  contains('empty sql still has header', sql, '-- Schema export ·');
  notContains('empty sql has no CREATE TABLE', sql, 'CREATE TABLE ');
}

console.log('--- ident quoting on weird names ---');
{
  const state = {
    schema: {
      tables: ['order'],
      fields: { 'order': [{ name: 'select', type: 'text' }, { name: 'full name', type: 'text' }] },
    },
    entities: {},
    partitions: {},
    connections: [],
  };
  const sql = SE.toSQL(state);
  contains('quoted spaced field name', sql, '"full name" TEXT');
  // SQL reserved-ish names: our quoter only escapes non-identifier chars, but
  // a bare keyword like `select` is still a valid SQL identifier syntax-wise.
  // We don't add a reserved-words list, so just verify "select" appears.
  contains('select field name preserved', sql, 'select TEXT');
}

console.log('--- linked / formula / rollup field annotations ---');
{
  const state = {
    schema: {
      tables: ['project'],
      fields: {
        project: [
          { name: 'name', type: 'text' },
          { name: 'owner', type: 'linked', linkedTable: 'people' },
          { name: 'progress', type: 'formula', formula: 'SUM({hours})' },
          { name: 'total', type: 'rollup', rollup: { via: 'tasks', field: 'estimate', fn: 'sum' } },
        ],
      },
    },
    entities: {},
    partitions: {},
    connections: [],
  };
  const sql = SE.toSQL(state);
  contains('linked → people comment', sql, 'linked → people');
  contains('formula comment', sql, 'formula: SUM({hours})');
  contains('rollup comment', sql, 'rollup: sum(estimate) via tasks');
  const md = SE.toMarkdown(state);
  contains('markdown formula', md, 'formula');
  contains('markdown rollup', md, 'rollup');
  contains('markdown linked', md, 'linked →');
}

console.log('--- workspace name carries through ---');
{
  const state = makeState();
  state.workspace = 'My Workspace';
  const md = SE.toMarkdown(state);
  contains('markdown has workspace name', md, 'My Workspace');
  const sql = SE.toSQL(state);
  contains('sql has workspace name', sql, 'Workspace: My Workspace');
}

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll schema-export tests passed');
