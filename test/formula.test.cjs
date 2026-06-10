/* Headless test for public/formula.js — the runtime evaluator that derives
 * computed (formula/rollup) cells lazily from fold state. The Airtable importer
 * carries EXPRESSIONS across, not Airtable's pre-computed values, so the bar is:
 * the functions a real base reaches for must actually evaluate here.
 *
 * formula.js is a browser IIFE that assigns window.Formula; we load it with a
 * window shim so the shipped file is the file under test.
 *
 *   node test/formula.test.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const win = {};
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'formula.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const Formula = win.Formula;

let failures = 0;
function check(label, cond) {
  if (cond) { console.log('  ok  ' + label); }
  else { failures++; console.log('FAIL  ' + label); }
}
function eq(label, a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  check(label + (A === B ? '' : `  (got ${A}, want ${B})`), A === B);
}
// Evaluate against a fixed record/state and return the {ok,value}.
const RECORD = {
  _anchor: 'r1',
  _created: Date.parse('2026-01-15T12:00:00Z'),
  Name: 'Apollo', Status: 'Doing', Hours: 5, Done: true,
  Tags: ['urgent', 'backend'], Names: ['a', 'b', 'c'],
  // fields whose NAMES collide with function names — the tricky case
  Value: 42, Count: 7, Day: 'Monday', Left: 'port',
};
const STATE = { entities: { r1: RECORD }, connections: [] };
function ev(expr) { return Formula.evaluate(expr, { record: RECORD, state: STATE }); }
function val(expr) { const r = ev(expr); return r.ok ? r.value : ('ERR:' + r.error); }

// ── ARRAYJOIN — Airtable hands arrays (rollups/lookups/multi-selects) across ──
eq('ARRAYJOIN with separator', val('ARRAYJOIN({Tags}, ", ")'), 'urgent, backend');
eq('ARRAYJOIN default separator', val('ARRAYJOIN({Names})'), 'a,b,c');
eq('ARRAYJOIN of a scalar', val('ARRAYJOIN({Name}, "-")'), 'Apollo');
eq('ARRAYJOIN skips blanks', val('ARRAYJOIN({Missing}, ",")'), '');

// ── EXACT — case-sensitive equality ──
eq('EXACT true', val('EXACT({Name}, "Apollo")'), true);
eq('EXACT is case-sensitive', val('EXACT({Name}, "apollo")'), false);

// ── TRUE()/FALSE() — Airtable's boolean literals are function calls ──
eq('TRUE() call form', val('IF(TRUE(), "y", "n")'), 'y');
eq('FALSE() call form', val('IF(FALSE(), "y", "n")'), 'n');
eq('TRUE bare identifier still works', val('IF(TRUE, 1, 0)'), 1);
eq('FALSE bare identifier still works', val('IF(FALSE, 1, 0)'), 0);

// ── Date helpers a project base leans on ──
eq('WEEKNUM (Jan 15 2026 → week 3)', val('WEEKNUM({_created})'), 3);
eq('WORKDAY skips the weekend', val('DATESTR(WORKDAY("2026-01-15", 1))'), '2026-01-16'); // Thu→Fri
eq('WORKDAY rolls over Sat/Sun', val('DATESTR(WORKDAY("2026-01-16", 1))'), '2026-01-19'); // Fri→Mon
eq('WORKDAY honors holidays', val('DATESTR(WORKDAY("2026-01-16", 1, "2026-01-19"))'), '2026-01-20'); // skip Mon holiday
eq('WORKDAY_DIFF Mon→Fri = 4', val('WORKDAY_DIFF("2026-01-19", "2026-01-23")'), 4);
eq('WORKDAY_DIFF ignores the weekend', val('WORKDAY_DIFF("2026-01-19", "2026-01-26")'), 5); // Mon→next Mon
// SET_TIMEZONE / SET_LOCALE pass the instant through so DATETIME_FORMAT renders
eq('SET_TIMEZONE passes through to format', val('DATETIME_FORMAT(SET_TIMEZONE({_created}, "America/New_York"), "YYYY-MM-DD")'), '2026-01-15');
eq('SET_LOCALE passes through to format', val('DATETIME_FORMAT(SET_LOCALE({_created}, "en"), "YYYY-MM-DD")'), '2026-01-15');

// ── Case-insensitive function names (Airtable formulas are case-insensitive) ──
eq('lower-case function name resolves', val('sum(1, 2, 3)'), 6);
eq('mixed-case If resolves and stays lazy', val('If(1 > 0, "a", nope())'), 'a'); // untaken branch never evaluated

// ── Field names that collide with function names must NOT be corrupted ──
// (regression: the old uppercasing pass rewrote __f("Value") → __f("VALUE").)
eq('field {Value} resolves to data, not VALUE()', val('{Value} + 1'), 43);
eq('field {Count} resolves to data, not COUNT()', val('{Count} * 2'), 14);
eq('field {Day} resolves to data, not DAY()', val('{Day}'), 'Monday');
eq('field {Left} resolves to data, not LEFT()', val('{Left} & "!"'), 'port!');
// …and the function of the same name still works alongside the field
eq('DAY() function still callable', Formula.evaluate('DAY("2026-03-09")', { record: RECORD, state: STATE }).value, 9);
eq('LEFT() function still callable', val('LEFT({Name}, 3)'), 'Apo');

// ── Airtable uses single `=` for equality (== / <= / >= still tokenize first) ──
eq('single = is equality', val('IF({Status} = "Done", "y", "n")'), 'n'); // Status="Doing"
eq('= on numbers', val('{Hours} = 5'), true);
eq('NOT(x = y)', val('NOT({Hours} = 0)'), true);
eq('== still works alongside =', val('IF({Hours} == 5, "a", "b")'), 'a');
eq('>= unaffected by = support', val('{Hours} >= 5'), true);

// ── ISERROR / IFERROR catch errors in their argument (ref: ISERROR(2/0) => 1) ──
eq('ISERROR catches divide-by-zero', val('ISERROR(2/0)'), true);
eq('ISERROR catches ERROR()', val('ISERROR(ERROR())'), true);
eq('ISERROR false on a good value', val('ISERROR(1 + 1)'), false);
eq('IFERROR returns fallback on ERROR()', val('IFERROR(ERROR(), "fallback")'), 'fallback');
eq('IFERROR returns fallback on 2/0', val('IFERROR(2/0, -1)'), -1);
eq('IFERROR passes a good value through', val('IFERROR(2 + 2, -1)'), 4);

// ── Exact-match checks against Airtable's published reference examples ──
eq('REPLACE is positional (ref: "dose")', val('REPLACE("database", 2, 5, "o")'), 'dose');
eq('EVEN(2.2) => 4 (ref)', val('EVEN(2.2)'), 4);
eq('EVEN(5) => 6 (ref)', val('EVEN(5)'), 6);
eq('ODD(1.1) => 3 (ref)', val('ODD(1.1)'), 3);
eq('ODD(-1.1) => -3 (ref)', val('ODD(-1.1)'), -3);
eq('CEILING(1.05, 0.1) => 1.1 (ref)', val('CEILING(1.05, 0.1)'), 1.1);
eq('FLOOR(1.99, 0.1) => 1.9 (ref)', val('FLOOR(1.99, 0.1)'), 1.9);
eq('WEEKNUM(02/17/2013) => 8 (ref)', Formula.evaluate('WEEKNUM("2013-02-17")', { record: RECORD, state: STATE }).value, 8);
// WORKDAY / WORKDAY_DIFF are inverses; both pinned to the reference example.
eq('WORKDAY(ref) => 2020-11-02', val('DATESTR(WORKDAY("2020-10-16", 10, "2020-10-16, 2020-10-19"))'), '2020-11-02');
eq('WORKDAY_DIFF(ref) => 10', val('WORKDAY_DIFF("2020-10-16", "2020-11-02", "2020-10-16, 2020-10-19")'), 10);

// ── Security: the allowlist must not be escapable via inherited props ──
// resolveKey uses hasOwnProperty, so prototype members never resolve.
check('bare "constructor" is unknown', ev('constructor').ok === false);
check('"constructor()" is not callable', ev('constructor("return 1")').ok === false);
check('"__proto__" does not resolve', ev('__proto__').ok === false);
check('"toString()" is not callable', ev('toString()').ok === false);
check('"valueOf()" is not callable', ev('valueOf()').ok === false);

// ── Newly added functions are advertised in the FUNCTIONS list (UI autocomplete) ──
const FNS = Formula.FUNCTIONS || [];
for (const name of ['ARRAYJOIN', 'EXACT', 'TRUE', 'FALSE', 'WEEKNUM', 'WORKDAY', 'WORKDAY_DIFF', 'SET_TIMEZONE', 'SET_LOCALE']) {
  check(`FUNCTIONS advertises ${name}`, FNS.includes(name));
}

// ── Rollups & lookups — aggregate across CON edges (the Airtable link flow) ──
// Imported Airtable record-links resolve into typed connections (relation =
// the link field's name). A rollup/lookup on a row follows those edges and
// aggregates the linked rows' field values. This is the path that makes
// Airtable links flow through to rollups/lookups, so pin it down end-to-end.
//
// Shape: one Project linked to three Tasks via the "Tasks" relation; the edges
// are written in BOTH source/target directions to prove traversal is
// undirected. Tasks carry an Hours number and a Status select; one Task has no
// Hours so blanks are exercised.
const proj = { _anchor: 'p1', _type: 'Projects', Name: 'Apollo' };
const taskA = { _anchor: 't1', _type: 'Tasks', Name: 'Design',  Hours: 5, Status: 'Done',  Done: true };
const taskB = { _anchor: 't2', _type: 'Tasks', Name: 'Build',   Hours: 8, Status: 'Doing', Done: true };
const taskC = { _anchor: 't3', _type: 'Tasks', Name: 'Ship',              Status: 'Todo',  Done: false };
const ROLLUP_STATE = {
  entities: { p1: proj, t1: taskA, t2: taskB, t3: taskC },
  connections: [
    // Project → Task (the direction an import of Projects produces)…
    { source: 'p1', target: 't1', type: 'Tasks' },
    { source: 'p1', target: 't2', type: 'Tasks' },
    // …and Task → Project (the reciprocal direction) — traversal is undirected.
    { source: 't3', target: 'p1', type: 'Tasks' },
    // An edge of a DIFFERENT relation must never leak into a "Tasks" rollup.
    { source: 'p1', target: 't1', type: 'Blocks' },
  ],
};
function roll(cfg) {
  const r = Formula.evaluateRollup(cfg, { record: proj, state: ROLLUP_STATE });
  return r.ok ? r.value : ('ERR:' + r.error);
}

eq('rollup count follows the relation (both directions)', roll({ via: 'Tasks', fn: 'count' }), 3);
eq('rollup count ignores other relations', roll({ via: 'Blocks', fn: 'count' }), 1);
eq('rollup sum over a linked field', roll({ via: 'Tasks', field: 'Hours', fn: 'sum' }), 13);
eq('rollup avg skips the blank Hours', roll({ via: 'Tasks', field: 'Hours', fn: 'avg' }), 6.5);
eq('rollup min over linked field', roll({ via: 'Tasks', field: 'Hours', fn: 'min' }), 5);
eq('rollup max over linked field', roll({ via: 'Tasks', field: 'Hours', fn: 'max' }), 8);

// LOOKUP (multipleLookupValues → fn:'list' WITH a field): surfaces THAT field's
// value from each linked record — the regression this change fixes (it used to
// return each record's label, ignoring `field`).
eq('lookup of a field lists that field, not the label', roll({ via: 'Tasks', field: 'Status', fn: 'list' }), 'Done, Doing, Todo');
eq('lookup of a numeric field skips blanks', roll({ via: 'Tasks', field: 'Hours', fn: 'list' }), '5, 8');
// A bare list with no field falls back to the linked records' labels.
eq('list with no field falls back to labels', roll({ via: 'Tasks', fn: 'list' }), 'Design, Build, Ship');
// concat / and / or aggregations
eq('rollup concat of a field', roll({ via: 'Tasks', field: 'Name', fn: 'concat' }), 'Design, Build, Ship');
eq('rollup and over a boolean field', roll({ via: 'Tasks', field: 'Done', fn: 'and' }), false);
eq('rollup or over a boolean field', roll({ via: 'Tasks', field: 'Done', fn: 'or' }), true);

// A lookup that pulls a multi-value field flattens its members rather than
// emitting a JSON blob.
const MULTI_STATE = {
  entities: {
    p1: proj,
    t1: { _anchor: 't1', _type: 'Tasks', Tags: ['urgent', 'backend'] },
    t2: { _anchor: 't2', _type: 'Tasks', Tags: ['frontend'] },
  },
  connections: [
    { source: 'p1', target: 't1', type: 'Tasks' },
    { source: 'p1', target: 't2', type: 'Tasks' },
  ],
};
eq('lookup flattens a multi-value field',
  Formula.evaluateRollup({ via: 'Tasks', field: 'Tags', fn: 'list' }, { record: proj, state: MULTI_STATE }).value,
  'urgent, backend, frontend');

// Guard rails: a rollup needs a relation, and a removed linked row drops out.
check('rollup without `via` errors', Formula.evaluateRollup({ fn: 'count' }, { record: proj, state: ROLLUP_STATE }).ok === false);
const REMOVED_STATE = {
  entities: { p1: proj, t1: { ...taskA, _removed: true }, t2: taskB },
  connections: [
    { source: 'p1', target: 't1', type: 'Tasks' },
    { source: 'p1', target: 't2', type: 'Tasks' },
  ],
};
eq('rollup excludes _removed linked rows',
  Formula.evaluateRollup({ via: 'Tasks', fn: 'count' }, { record: proj, state: REMOVED_STATE }).value, 1);

// ROLLUP_FNS advertises every aggregation the UI offers.
const RFNS = Formula.ROLLUP_FNS || [];
for (const fn of ['sum', 'count', 'avg', 'min', 'max', 'list', 'concat', 'and', 'or']) {
  check(`ROLLUP_FNS advertises ${fn}`, RFNS.includes(fn));
}

console.log('');
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('all formula checks passed');
