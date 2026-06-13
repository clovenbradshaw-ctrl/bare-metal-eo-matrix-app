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

  // ── airtable-style table names: better English in chat copy ────────────────
  eq('plural Client Info', DC.plural('Client Info'), 'clients');
  eq('plural Case Master View', DC.plural('Case Master View'), 'cases');
  eq('plural case_notes', DC.plural('case_notes'), 'case notes');
  eq('plural Events', DC.plural('Events'), 'events');
  eq('plural Activities', DC.plural('Activities'), 'activities');
  eq('plural Company', DC.plural('Company'), 'companies');

  // ── big-schema fixture: a real Amino-shaped workspace stress-tests the
  //    prompt-trimmer and the column orderer. Case Master View has 200+ text
  //    fields with the first ~6 being administrative ("Meta Data",
  //    "Last Modified By", …) — exactly what the chat would otherwise show. ──
  const fbiFieldNames = [
    'Meta Data', 'Last Modified By', 'Update Tracker EAD Pers', 'Client Name Help',
    'Case Notes', 'clio_contact_id', 'clio_matter_id', 'Matter_Flatpack',
    'Description', 'File Case Status', 'EOIR VERIF', 'Case Tags',
    'FBI Record Stage', 'FBI Print Record Sent', 'FBI Record Date', 'FBI Hyperlink',
    'FBI Mail Tracking #', 'FBI Req Type', 'FBI E-REQ Pin', 'FBI notes',
    'FBI Record Sent', 'NTA Date', 'USCIS Receipt Date', 'Bond Status',
    'Bond Amt Collected', 'Bond Receipt #', 'Bond Type', 'Bond Notes',
  ];
  // pad to 220 fields so the cap really has to choose
  const padded = fbiFieldNames.concat(
    Array.from({ length: 220 - fbiFieldNames.length }, (_, i) => 'filler_field_' + i)
  );
  const bigFields = [{ name: 'Matter', type: 'text' }, { name: 'Status', type: 'select', options: ['Open', 'Closed', 'Pending'] }]
    .concat(padded.map(name => ({ name, type: 'text' })));
  const bigState = {
    entities: {
      r1: ent('r1', 'Case Master View', { Matter: 'Acme Bond', Status: 'Open', 'FBI Record Stage': 'Sent' }),
      r2: ent('r2', 'Case Master View', { Matter: 'Globex 360', Status: 'Closed', 'FBI Record Stage': 'Received' }),
    },
    connections: [],
    partitions: {},
    schema: { tables: ['Case Master View'], fields: { 'Case Master View': bigFields }, links: [] },
    cursor: 2,
  };

  // selectFieldsForPrompt keeps it small AND keeps the fields the question
  // actually mentions, even if they sit at index 14 in declaration order.
  let picked = DC.selectFieldsForPrompt(bigFields, 'show me FBI record dates', 14);
  ok('prompt picker capped at 14', picked.length === 14);
  ok('prompt picker keeps FBI Record Date', picked.some(f => f.name === 'FBI Record Date'));
  ok('prompt picker keeps Status (select)', picked.some(f => f.name === 'Status'));
  ok('prompt picker keeps Matter (label)', picked.some(f => f.name === 'Matter'));

  // schemaPrompt surfaces those same fields and notes the rest are hidden.
  let prompt = DC.schemaPrompt(bigState, 'how many cases by FBI Record Stage');
  ok('schemaPrompt mentions FBI Record Stage', prompt.indexOf('FBI Record Stage') >= 0);
  ok('schemaPrompt mentions Status options', prompt.indexOf('[Open|Closed|Pending]') >= 0);
  ok('schemaPrompt advertises the rest', /\+\d+ more fields/.test(prompt));
  // Without a question, the trimmer still keeps labels + selects up front.
  let promptNoQ = DC.schemaPrompt(bigState);
  ok('schemaPrompt(no q) still keeps Matter label', promptNoQ.indexOf('Matter') >= 0);
  ok('schemaPrompt(no q) still keeps Status options', promptNoQ.indexOf('[Open|Closed|Pending]') >= 0);

  // preferredColumns puts a label first, then spec-touched fields, then
  // typed/enumerable ones — so a 6-col preview is actually informative.
  let cols = DC.preferredColumns(bigState, 'Case Master View', { filters: [{ field: 'FBI Record Stage' }], sort: null, agg: null });
  eq('preferredColumns first is label', cols[0].name, 'Matter');
  ok('preferredColumns front-loads the filter field',
     cols.slice(0, 4).some(c => c.name === 'FBI Record Stage'));
  ok('preferredColumns puts the typed select up front',
     cols.slice(0, 4).some(c => c.name === 'Status'));
  // and the preview the chat-view actually paints (first MAX_COLS=6) is sane:
  const preview = cols.slice(0, 6).map(c => c.name);
  ok('first 6 columns include Matter', preview.includes('Matter'));
  ok('first 6 columns include Status', preview.includes('Status'));
  ok('first 6 columns include FBI Record Stage', preview.includes('FBI Record Stage'));

  // End-to-end: a table query returns the preferred column order, not the raw
  // schema order, so what the user sees up top is the useful columns.
  r = await DC.interpret('cases where FBI Record Stage is Sent', bigState);
  eq('big-schema query → table', r.kind, 'table');
  eq('big-schema first column is label', r.columns[0].name, 'Matter');
  ok('big-schema cols include the filtered field',
     r.columns.slice(0, 6).some(c => c.name === 'FBI Record Stage'));

  // ── confirmation gate: type ambiguity ──────────────────────────────────────
  // Real Airtable bases often split one concept across several tables that
  // share a content word — here "Bond Hearings" and "Bond Motions". A bare
  // "show bond records" can't tell which the user means; the chat should ASK
  // before silently picking one.
  const aminoState = {
    entities: {
      bh1: ent('bh1', 'Bond Hearings', { Matter: 'Doe v. State', Outcome: 'Granted' }),
      bh2: ent('bh2', 'Bond Hearings', { Matter: 'Roe v. State', Outcome: 'Denied' }),
      bm1: ent('bm1', 'Bond Motions', { Matter: 'Doe v. State', Status: 'Pending' }),
      cm1: ent('cm1', 'Case Master View', { Matter: 'Doe v. State', Status: 'Open' }),
    },
    connections: [],
    partitions: {},
    schema: {
      tables: ['Client Info', 'Bond Hearings', 'Bond Motions', 'Case Master View'],
      fields: {
        'Client Info': [{ name: 'Name', type: 'text' }],
        'Bond Hearings': [{ name: 'Matter', type: 'text' }, { name: 'Outcome', type: 'select', options: ['Granted', 'Denied'] }],
        'Bond Motions': [{ name: 'Matter', type: 'text' }, { name: 'Status', type: 'select', options: ['Pending', 'Filed'] }],
        'Case Master View': [{ name: 'Matter', type: 'text' }, { name: 'Status', type: 'select', options: ['Open', 'Closed'] }],
      },
      links: [],
    },
    cursor: 4,
  };
  // "show bond records" → Bond Hearings (1.1) and Bond Motions (1.1) tie.
  r = await DC.interpret('show bond records', aminoState);
  eq('ambiguous → confirm', r.kind, 'confirm');
  eq('confirm reason is type', r.reason, 'type');
  ok('confirm offers Bond Hearings', r.choices.some(c => c.label === 'Bond Hearings'));
  ok('confirm offers Bond Motions', r.choices.some(c => c.label === 'Bond Motions'));
  // each choice carries a ready-to-run plan (no re-parsing needed)
  ok('every choice has a plan', r.choices.every(c => c.plan && c.plan.type && c.plan.intent));
  // hints show row counts so the user can pick by size
  ok('choice hints carry a count', r.choices.every(c => /record/.test(c.hint || '')));

  // Picking a choice executes the plan straight through (skipConfirm=true ⇒
  // we never re-prompt for the same question).
  const chosen = r.choices.find(c => c.label === 'Bond Hearings');
  const after = await DC.executePlan(aminoState, chosen.plan, { q: 'show bond records', opts: { skipConfirm: true } });
  eq('chosen plan → table', after.kind, 'table');
  eq('chosen plan type', after.type, 'Bond Hearings');
  eq('chosen plan rows', after.rows.length, 2);

  // The deterministic-leader case must NOT confirm — when one table is the
  // clear winner ("show open cases" → Case Master View), just answer.
  r = await DC.interpret('show open cases', aminoState);
  eq('clear winner → table', r.kind, 'table');
  eq('clear winner type', r.type, 'Case Master View');

  // A question that names the table outright also bypasses the gate.
  r = await DC.interpret('list bond motions', aminoState);
  eq('whole-phrase match → table', r.kind, 'table');
  eq('whole-phrase type', r.type, 'Bond Motions');

  // ── confirmation gate: flood (broad query, large table) ────────────────────
  // 250 records of a single type, no filter, no limit → chat should ask
  // "first 25 or all of them?" before flooding.
  const bigEntities = {};
  for (let i = 0; i < 250; i++) bigEntities['p' + i] = ent('p' + i, 'Pings', { name: 'ping ' + i, Stage: i % 2 ? 'A' : 'B' });
  const floodState = {
    entities: bigEntities,
    connections: [],
    partitions: {},
    schema: { tables: ['Pings'], fields: { 'Pings': [{ name: 'name', type: 'text' }, { name: 'Stage', type: 'select', options: ['A', 'B'] }] }, links: [] },
    cursor: 250,
  };
  r = await DC.interpret('show all pings', floodState);
  eq('broad query on big table → confirm', r.kind, 'confirm');
  eq('confirm reason is flood', r.reason, 'flood');
  ok('flood confirm advertises the count', /250/.test(r.text));
  ok('flood confirm offers first-25', r.choices.some(c => c.plan.limit === 25));
  ok('flood confirm offers all', r.choices.some(c => !c.plan.limit));

  // A narrowed query against the same table runs straight through — the user
  // has already said which slice they want.
  r = await DC.interpret('pings where Stage is A', floodState);
  eq('narrowed query → table', r.kind, 'table');
  eq('narrowed query rows', r.rows.length, 125);

  // Aggregates bypass flood — they're never row dumps.
  r = await DC.interpret('how many pings', floodState);
  eq('aggregate bypasses flood', r.kind, 'value');
  eq('aggregate value', r.value, 250);

  // opts.skipConfirm lets the chat-view re-run the same question without the
  // gate (so tapping "show all" never re-prompts).
  r = await DC.interpret('show all pings', floodState, { skipConfirm: true });
  eq('skipConfirm bypasses flood gate', r.kind, 'table');

  // ── arithmetic on top of an aggregate (no engine, no Smart-parse toggle) ────
  // "total number of clients times 2" used to mis-read as Count(Phone Number)
  // and silently drop "times 2". It must now count rows and apply the math.
  const phoneState = {
    entities: {
      z1: ent('z1', 'Client Info', { Name: 'A', 'Phone Number': '555-0001' }),
      z2: ent('z2', 'Client Info', { Name: 'B', 'Phone Number': '555-0002' }),
    },
    connections: [], partitions: {},
    schema: { tables: ['Client Info'], fields: { 'Client Info': [{ name: 'Name', type: 'text' }, { name: 'Phone Number', type: 'text' }] }, links: [] },
    cursor: 2,
  };
  r = await DC.interpret('what is my total number of clients times 2', phoneState);
  eq('count×2 → value', r.kind, 'value');
  eq('count×2 value is 2×2=4', r.value, 4);
  eq('count label has no phantom field', r.label, 'Count of clients');   // not "Count (Phone Number) of clients"
  ok('count×2 records the math in spec', r.spec.arith && r.spec.arith.base === 2 && r.spec.arith.result === 4 && r.spec.arith.symbol === '×');
  ok('count×2 note shows the computation', /2\s*×\s*2\s*=\s*4/.test(r.note || ''));

  // "total number of X" alone is a plain count (no Sum, no field binding).
  r = await DC.interpret('total number of clients', state);
  eq('total number → count', r.kind, 'value');
  eq('total number value', r.value, 2);
  eq('total number label', r.label, 'Count of clients');

  // other arithmetic ops, all deterministic
  r = await DC.interpret('how many cases divided by 3', state);
  eq('count÷3 value', r.value, 1);                                       // 3 cases / 3
  r = await DC.interpret('sum of priority in cases plus 5', state);
  eq('sum+5 value', r.value, 20);                                        // 15 + 5

  // ── value-anchored filters: a value with no explicit field ──────────────────
  // "clients in austin" — the location is the anchor; bind it to a location-like
  // text field instead of dropping the whole clause.
  r = await DC.interpret('clients in austin', state);
  eq('value-anchored → table', r.kind, 'table');
  eq('value-anchored type', r.type, 'Client Info');
  ok('value-anchored filtered to Austin', r.rows.length === 1 && r.rows[0].City === 'Austin');
  ok('value-anchored bound the City field', (r.spec.filters || []).some(f => f.field === 'City'));

  // "from mexico" binds to a select OPTION when one matches — the screenshot case.
  const geoState = {
    entities: {
      g1: ent('g1', 'Client Info', { Name: 'Uno', Country: 'Mexico' }),
      g2: ent('g2', 'Client Info', { Name: 'Dos', Country: 'Canada' }),
      g3: ent('g3', 'Client Info', { Name: 'Tres', Country: 'Mexico' }),
    },
    connections: [], partitions: {},
    schema: { tables: ['Client Info'], fields: { 'Client Info': [{ name: 'Name', type: 'text' }, { name: 'Country', type: 'select', options: ['Mexico', 'Canada', 'USA'] }] }, links: [] },
    cursor: 3,
  };
  r = await DC.interpret('how many clients are from mexico', geoState);
  eq('from-option → value', r.kind, 'value');
  eq('from-option count is filtered (2 of 3)', r.value, 2);
  ok('from-option bound Country', (r.spec.filters || []).some(f => f.field === 'Country'));

  // No matching field ⇒ don't pretend: count everything BUT surface the miss.
  const plainState = {
    entities: { w1: ent('w1', 'Widget', { Name: 'A' }), w2: ent('w2', 'Widget', { Name: 'B' }) },
    connections: [], partitions: {},
    schema: { tables: ['Widget'], fields: { 'Widget': [{ name: 'Name', type: 'text' }] }, links: [] },
    cursor: 2,
  };
  r = await DC.interpret('how many widgets from mexico', plainState);
  eq('unmapped still answers', r.kind, 'value');
  eq('unmapped counts all', r.value, 2);
  ok('unmapped phrase recorded', (r.spec.unmapped || []).some(u => /mexico/.test(u)));
  ok('unmapped surfaced in note', /mexico/.test(r.note || ''));

  // ── EO notation: every answer carries the query, decomposed into operators ──
  r = await DC.interpret('how many cases times 2', state);
  ok('result carries an eo trace', Array.isArray(r.spec.eo) && r.spec.eo.length > 0);
  let eops = r.spec.eo.map(s => s.op);
  ok('eo scopes with SEG', eops[0] === 'SEG');
  ok('eo aggregates with SYN', eops.includes('SYN'));
  ok('eo shows the math as REC', eops.includes('REC'));
  ok('eo steps carry glyph + name + word', r.spec.eo.every(s => s.glyph && s.name && s.word));
  eq('SEG glyph', r.spec.eo.find(s => s.op === 'SEG').glyph, '｜');

  r = await DC.interpret('cases where priority > 4', state);
  ok('filter shows as EVA', r.spec.eo.some(s => s.op === 'EVA' && /priority/i.test(s.label)));

  r = await DC.interpret('count cases by status', state);
  ok('group-by shows as REC', r.spec.eo.some(s => s.op === 'REC' && /status/i.test(s.label)));

  r = await DC.interpret('tell me about Acme Corp', state);
  eops = r.spec.eo.map(s => s.op);
  ok('profile eo: SEG + CON (follow links)', eops.includes('SEG') && eops.includes('CON'));

  r = await DC.interpret('escalation', state);
  ok('search eo: NUL scan', r.spec.eo.some(s => s.op === 'NUL'));

  // the unmapped widget query exposes the miss as an unbound NUL step
  r = await DC.interpret('how many widgets from mexico', plainState);
  ok('unmapped eo: a dim NUL step', r.spec.eo.some(s => s.op === 'NUL' && /mexico/.test(s.label) && s.dim));

  // eoTrace is exported and works on a raw plan (what the confirm cards render)
  const trace = DC.eoTrace({ intent: 'aggregate', type: 'Case Master View', filters: [{ field: 'Status', op: 'eq', value: 'Open' }], agg: { agg: 'count', field: null, groupBy: null } });
  ok('eoTrace(plan): SEG then EVA then SYN', trace[0].op === 'SEG' && trace.some(s => s.op === 'EVA') && trace.some(s => s.op === 'SYN'));
  ok('EO_OPS catalog has the nine glyphs', Object.keys(DC.EO_OPS).length === 9 && DC.EO_OPS.SEG.glyph === '｜');

  console.log(`data-chat.test: ${passed} assertions passed`);
})().catch(e => { console.error(e); process.exit(1); });
