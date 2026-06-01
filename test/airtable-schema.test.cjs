/* Headless test for public/airtable-schema.js.
 *
 * The module is a browser classic-script (assigns window.AirtableSchema) but
 * also assigns module.exports when a CommonJS `module` is in scope. We load it
 * by evaluating the source with a module shim and an undefined `window`, so the
 * same file we ship to the browser is the file under test.
 *
 *   node test/airtable-schema.test.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'airtable-schema.js'), 'utf8');
const shim = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'window', src)(shim, undefined);
const AirtableSchema = shim.exports;

let failures = 0;
function check(label, cond) {
  if (cond) { console.log('  ok  ' + label); }
  else { failures++; console.log('FAIL  ' + label); }
}
function eq(label, a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  check(label + (A === B ? '' : `  (got ${A}, want ${B})`), A === B);
}

// A realistic slice of the Airtable Metadata API response
// (GET /v0/meta/bases/{baseId}/tables), including the computed field types
// that are the whole reason this importer exists.
const sample = {
  tables: [
    {
      id: 'tblProjects', name: 'Projects', primaryFieldId: 'fldPName',
      fields: [
        { id: 'fldPName', name: 'Name', type: 'singleLineText' },
        { id: 'fldNotes', name: 'Notes', type: 'multilineText' },
        { id: 'fldBudget', name: 'Budget', type: 'currency', options: { precision: 2, symbol: '$' } },
        { id: 'fldDone', name: 'Done?', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
        { id: 'fldStatus', name: 'Status', type: 'singleSelect',
          options: { choices: [ { id: 's1', name: 'Todo' }, { id: 's2', name: 'Doing' }, { id: 's3', name: 'Done' } ] } },
        { id: 'fldTags', name: 'Tags', type: 'multipleSelects',
          options: { choices: [ { id: 't1', name: 'urgent' }, { id: 't2', name: 'backend' } ] } },
        { id: 'fldDue', name: 'Due', type: 'date', options: { dateFormat: { name: 'iso' } } },
        { id: 'fldCreated', name: 'Created', type: 'createdTime' },
        // formula referencing fields BY ID (the tricky case) — must rewrite to names
        { id: 'fldLabel', name: 'Label', type: 'formula',
          options: { isValid: true, formula: 'CONCATENATE({fldPName}, " — ", {fldStatus})', referencedFieldIds: ['fldPName', 'fldStatus'], result: { type: 'singleLineText' } } },
        // formula referencing fields BY NAME (passes through untouched)
        { id: 'fldRemain', name: 'Remaining', type: 'formula',
          options: { isValid: true, formula: 'IF({Done?}, 0, {Budget})', result: { type: 'number' } } },
        // record link to Tasks
        { id: 'fldTasks', name: 'Tasks', type: 'multipleRecordLinks',
          options: { linkedTableId: 'tblTasks', prefersSingleRecordLink: false } },
        // rollup over the linked Tasks' Hours
        { id: 'fldHours', name: 'Total Hours', type: 'rollup',
          options: { isValid: true, recordLinkFieldId: 'fldTasks', fieldIdInLinkedTable: 'fldHrs', formula: 'SUM(values)', result: { type: 'number' } } },
        // count of linked Tasks
        { id: 'fldCount', name: 'Task Count', type: 'count',
          options: { isValid: true, recordLinkFieldId: 'fldTasks' } },
        // lookup of the linked Tasks' names
        { id: 'fldLookup', name: 'Task Names', type: 'multipleLookupValues',
          options: { isValid: true, recordLinkFieldId: 'fldTasks', fieldIdInLinkedTable: 'fldTName' } },
        // a button — should be skipped, not imported as data
        { id: 'fldBtn', name: 'Open', type: 'button', options: {} },
      ],
    },
    {
      id: 'tblTasks', name: 'Tasks', primaryFieldId: 'fldTName',
      fields: [
        { id: 'fldTName', name: 'Task', type: 'singleLineText' },
        { id: 'fldHrs', name: 'Hours', type: 'number', options: { precision: 1 } },
        { id: 'fldEmail', name: 'Owner', type: 'email' },
      ],
    },
  ],
};

const r = AirtableSchema.parse(sample);
check('parse ok', r.ok === true);
eq('two tables', r.tables.map(t => t.name), ['Projects', 'Tasks']);

const proj = r.tables[0];
const byName = Object.fromEntries(proj.fields.map(f => [f.name, f]));

eq('primary field resolved', proj.primary, 'Name');
eq('button field skipped (15 in → 14 out)', proj.fields.length, 14);

// simple types
eq('currency → number', byName['Budget'].type, 'number');
eq('multilineText → longtext', byName['Notes'].type, 'longtext');
eq('checkbox → boolean', byName['Done?'].type, 'boolean');

// selects carry their choices
eq('singleSelect → select', byName['Status'].type, 'select');
eq('select options', byName['Status'].options, ['Todo', 'Doing', 'Done']);
eq('multipleSelects → multiselect', byName['Tags'].type, 'multiselect');
eq('multiselect options', byName['Tags'].options, ['urgent', 'backend']);

// computed: created time → runtime formula (wrapped so it renders as a date)
eq('createdTime → DATESTR(CREATED_TIME())', byName['Created'], { name: 'Created', type: 'formula', formula: 'DATESTR(CREATED_TIME())' });

// formula with ID refs rewritten to names
eq('formula id-refs rewritten to names', byName['Label'].formula, 'CONCATENATE({Name}, " — ", {Status})');
// formula with name refs passes through
eq('formula name-refs unchanged', byName['Remaining'].formula, 'IF({Done?}, 0, {Budget})');

// rollup / count / lookup → rollup configs that point at the link relation
eq('rollup via link name', byName['Total Hours'], { name: 'Total Hours', type: 'rollup', rollup: { via: 'Tasks', fn: 'sum', field: 'Hours' } });
eq('count → rollup count', byName['Task Count'], { name: 'Task Count', type: 'rollup', rollup: { via: 'Tasks', fn: 'count' } });
eq('lookup → rollup list', byName['Task Names'], { name: 'Task Names', type: 'rollup', rollup: { via: 'Tasks', fn: 'list', field: 'Task' } });

// record link → linked field + a links row
eq('link field type', byName['Tasks'].type, 'linked');
eq('link target table', byName['Tasks'].linkedTable, 'Tasks');
eq('links row emitted', r.links, [{ from: 'Projects', to: 'Tasks', rel: 'Tasks' }]);

// computed tally drives the preview's "N computed" badge
eq('computed count = Created+Label+Remaining+Hours+Count+Lookup', proj.counts.computed, 6);

// input-shape tolerance
check('accepts a bare array of tables', AirtableSchema.parse(sample.tables).ok === true);
check('accepts a single table object', AirtableSchema.parse(sample.tables[1]).ok === true);
check('rejects junk with a message', AirtableSchema.parse('{"nope":1}').ok === false);
check('rejects invalid JSON string', AirtableSchema.parse('{not json').ok === false);

// ── End-to-end: the generated schema must COMPUTE at runtime via formula.js ──
// Load the real formula.js (a browser IIFE that assigns window.Formula) with a
// window shim, then evaluate the very fields the importer produced — proving we
// carry expressions, not Airtable's pre-computed values.
const win = {};
const formulaSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'formula.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', formulaSrc)(win);
const Formula = win.Formula;
check('formula.js loaded', !!(Formula && Formula.evaluate));

// A tiny fold state: one Project linked to two Tasks via a CON of type "Tasks"
// (the relation name the importer derived from the link field).
const projAnchor = 'a_proj1';
const state = {
  entities: {
    [projAnchor]: { _anchor: projAnchor, _type: 'Projects', _created: Date.parse('2026-06-01T12:00:00Z'), Name: 'Apollo', 'Done?': false, Budget: 1000, Status: 'Doing' },
    a_t1: { _anchor: 'a_t1', _type: 'Tasks', Task: 'design', Hours: 3 },
    a_t2: { _anchor: 'a_t2', _type: 'Tasks', Task: 'build', Hours: 5 },
  },
  connections: [
    { source: projAnchor, target: 'a_t1', type: 'Tasks' },
    { source: projAnchor, target: 'a_t2', type: 'Tasks' },
  ],
};
const record = state.entities[projAnchor];

// formula field "Label" → CONCATENATE({Name}, " — ", {Status})
const label = Formula.evaluate(byName['Label'].formula, { record, state });
eq('formula Label computes from data', [label.ok, label.value], [true, 'Apollo — Doing']);

// formula field "Remaining" → IF({Done?}, 0, {Budget})
const remaining = Formula.evaluate(byName['Remaining'].formula, { record, state });
eq('formula Remaining branches on checkbox', [remaining.ok, remaining.value], [true, 1000]);

// formula field "Created" → DATESTR(CREATED_TIME()) renders a date, not epoch ms
const created = Formula.evaluate(byName['Created'].formula, { record, state });
eq('createdTime formula renders a date', [created.ok, created.value], [true, '2026-06-01']);

// rollup field "Total Hours" → sum(Hours) via the "Tasks" link
const hours = Formula.evaluateRollup(byName['Total Hours'].rollup, { record, state });
eq('rollup sums linked Hours (3+5)', [hours.ok, hours.value], [true, 8]);

// rollup field "Task Count" → count via "Tasks"
const count = Formula.evaluateRollup(byName['Task Count'].rollup, { record, state });
eq('rollup counts linked rows', [count.ok, count.value], [true, 2]);

console.log('');
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('all airtable-schema checks passed');
