'use strict';
// Headless tests for public/data-chat.js — the chat-with-your-data query
// pipeline. Runs with NO engine present (no window): proves the deterministic
// core (type/field/value resolution, filters, aggregation, sort, foreign-key
// traversal, and the plan→validate→execute path the local LLM feeds) without a
// browser or a model. Domain mirrors a real case-management workspace:
// Client Info → Case Master View → Events / Case Notes, linked by CON edges.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// data-chat.js is a classic browser <script> (the repo is "type":"module", so a
// bare require() would treat it as ESM and miss window.DataChat). Load it the
// way the browser does: run it against a minimal window and read the global.
// No engine globals are provided, so every EO* path is the absent-engine path.
const DC = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'data-chat.js'), 'utf8');
  const sandbox = { window: {}, console };
  vm.runInNewContext(src, sandbox, { filename: 'data-chat.js' });
  return sandbox.window.DataChat;
})();

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
function eq(name, a, b) { assert.strictEqual(a, b, `${name}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); passed++; }

// ── a synthetic fold state ───────────────────────────────────────────────────
function ent(anchor, type, fields) { return Object.assign({ _anchor: anchor, _type: type, _created: 1, _sender: '@t:x' }, fields); }
function con(source, target, type) { return { source, target, type, _ts: 1, _sender: '@t:x', _eventId: '$' + source + target }; }

const state = {
  entities: {
    c1: ent('c1', 'Client Info', { Name: 'Acme Corp', Tier: 'Gold', City: 'Austin' }),
    c2: ent('c2', 'Client Info', { Name: 'Globex', Tier: 'Silver', City: 'Reno' }),
    k1: ent('k1', 'Case Master View', { Name: 'Acme dispute', Status: 'Open', Priority: 5 }),
    k2: ent('k2', 'Case Master View', { Name: 'Acme renewal', Status: 'Closed', Priority: 2 }),
    k3: ent('k3', 'Case Master View', { Name: 'Globex audit', Status: 'Open', Priority: 8 }),
    e1: ent('e1', 'Events', { Name: 'Kickoff call', Date: '2026-01-04' }),
    e2: ent('e2', 'Events', { Name: 'Filing', Date: '2026-02-10' }),
    n1: ent('n1', 'Case Notes', { body: 'Client wants escalation' }),
    n2: ent('n2', 'Case Notes', { body: 'Follow up next week' }),
  },
  connections: [
    con('c1', 'k1', 'has_case'), con('c1', 'k2', 'has_case'), con('c2', 'k3', 'has_case'),
    con('k1', 'e1', 'has_event'), con('k1', 'n1', 'has_note'), con('k3', 'e2', 'has_event'), con('k3', 'n2', 'has_note'),
  ],
  partitions: {},
  schema: {
    tables: ['Client Info', 'Case Master View', 'Events', 'Case Notes'],
    fields: {
      'Client Info': [{ name: 'Name', type: 'text' }, { name: 'Tier', type: 'select', options: ['Gold', 'Silver', 'Bronze'] }, { name: 'City', type: 'text' }],
      'Case Master View': [{ name: 'Name', type: 'text' }, { name: 'Status', type: 'select', options: ['Open', 'Closed'] }, { name: 'Priority', type: 'number' }],
      'Events': [{ name: 'Name', type: 'text' }, { name: 'Date', type: 'date' }],
      'Case Notes': [{ name: 'body', type: 'longtext' }],
    },
    links: [
      { from: 'Client Info', to: 'Case Master View', rel: 'has_case' },
      { from: 'Case Master View', to: 'Events', rel: 'has_event' },
      { from: 'Case Master View', to: 'Case Notes', rel: 'has_note' },
    ],
  },
  cursor: 9,
};

(async () => {
  // ── multi-word type matching (the part the user flagged) ───────────────────
  eq('matchType clients → Client Info', DC.matchType(state, 'show me all clients'), 'Client Info');
  eq('matchType notes → Case Notes', DC.matchType(state, 'list the notes'), 'Case Notes');
  eq('matchType events → Events', DC.matchType(state, 'how many events are there'), 'Events');
  eq('matchType whole phrase', DC.matchType(state, 'open the case master view'), 'Case Master View');
  ok('matchTypeScored returns candidates', DC.matchTypeScored(state, 'cases').candidates.length >= 1);

  // ── table query ────────────────────────────────────────────────────────────
  let r = await DC.interpret('show me all clients', state);
  eq('all clients → table', r.kind, 'table');
  eq('all clients type', r.type, 'Client Info');
  eq('all clients rows', r.rows.length, 2);

  // ── filtered query (select option, no explicit operator) ───────────────────
  r = await DC.interpret('show open cases', state);
  eq('open cases → table', r.kind, 'table');
  eq('open cases type', r.type, 'Case Master View');
  eq('open cases count', r.rows.length, 2);
  ok('open cases all Open', r.rows.every(x => x.Status === 'Open'));

  // ── explicit filter + operator ─────────────────────────────────────────────
  r = await DC.interpret('cases where priority > 4', state);
  eq('priority filter type', r.type, 'Case Master View');
  ok('priority>4 rows', r.rows.length === 2 && r.rows.every(x => x.Priority > 4));

  // ── sort + limit ───────────────────────────────────────────────────────────
  r = await DC.interpret('top 1 cases by priority', state);
  eq('top 1 limit', r.rows.length, 1);
  eq('top 1 is highest priority', r.rows[0].Priority, 8);

  // ── aggregation: scalar count ──────────────────────────────────────────────
  r = await DC.interpret('how many events', state);
  eq('count events → value', r.kind, 'value');
  eq('count events value', r.value, 2);

  // ── aggregation: grouped count ─────────────────────────────────────────────
  r = await DC.interpret('count cases by status', state);
  eq('grouped count → table', r.kind, 'table');
  const byStatus = Object.fromEntries(r.rows.map(x => [x.Status, x.Count]));
  eq('Open group', byStatus.Open, 2);
  eq('Closed group', byStatus.Closed, 1);

  // ── aggregation: sum of a number field ─────────────────────────────────────
  r = await DC.interpret('sum of priority in cases', state);
  eq('sum priority → value', r.kind, 'value');
  eq('sum priority value', r.value, 15);

  // ── profile intent: a specific record ──────────────────────────────────────
  r = await DC.interpret('tell me about Acme Corp', state);
  eq('profile → profile', r.kind, 'profile');
  eq('profile anchor', r.anchor, 'c1');
  eq('profile type', r.type, 'Client Info');

  // ── foreign keys: related records via CON (+ schema.links) ─────────────────
  const rel = DC.relatedRecords(state, 'c1');
  const cases = rel.find(g => g.type === 'Case Master View');
  ok('client c1 linked to cases', cases && cases.records.length === 2);
  ok('linkedTypesFor Client Info includes cases', DC.linkedTypesFor(state, 'Client Info').includes('Case Master View'));
  // second hop: a case's events and notes
  const relK1 = DC.relatedRecords(state, 'k1');
  ok('case k1 → event', relK1.some(g => g.type === 'Events' && g.records.length === 1));
  ok('case k1 → note', relK1.some(g => g.type === 'Case Notes' && g.records.length === 1));

  // ── the LLM path, simulated: a hand-built plan must validate+execute the same
  //    way (proves an on-device model can only ever drive a safe read query) ──
  let plan = { intent: 'query', type: 'Case Master View', filters: [{ field: 'status', op: 'is', value: 'Open' }], agg: null, sort: null, limit: null, source: 'llm' };
  r = await DC.executePlan(state, plan, { q: 'open cases', opts: {} });
  eq('llm-plan executes → table', r.kind, 'table');
  eq('llm-plan filtered count', r.rows.length, 2);

  // an unknown field from a hallucinating model is dropped, not executed
  plan = { intent: 'query', type: 'Case Master View', filters: [{ field: 'nonexistent_field', op: 'eq', value: 'x' }], agg: null, sort: null, limit: null, source: 'llm' };
  r = await DC.executePlan(state, plan, { q: 'junk', opts: {} });
  eq('bad field dropped → all rows', r.rows.length, 3);

  // an LLM plan naming a bad table falls through to search, never throws
  plan = { intent: 'query', type: 'Made Up Table', filters: [], agg: null, sort: null, limit: null, source: 'llm' };
  r = await DC.executePlan(state, plan, { q: 'made up', opts: {} });
  ok('bad table → safe fallback', r.kind === 'table' || r.kind === 'empty' || r.kind === 'answer');

  // ── catch-all record search ────────────────────────────────────────────────
  r = await DC.interpret('escalation', state);
  ok('search finds the note', (r.rows || []).some(x => x._anchor === 'n1'));

  // ── empty / no-data guards ─────────────────────────────────────────────────
  r = await DC.interpret('', state);
  eq('empty question', r.kind, 'empty');
  r = await DC.interpret('anything', { entities: {}, connections: [], schema: {}, cursor: 0 });
  eq('no records', r.kind, 'empty');

  console.log(`data-chat.test: ${passed} assertions passed`);
})().catch(e => { console.error(e); process.exit(1); });
