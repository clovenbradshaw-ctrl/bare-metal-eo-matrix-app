/**
 * engine.js — bare-metal port of operators.js + fold.js
 *
 * The full app uses matrix-js-sdk + Megolm + a real homeserver. This file
 * keeps the algebra and strips the transport: events live in a plain JS
 * array, "rooms" are arrays inside an object, and the fold is the same
 * permissive nine-case dispatch. Enough to demonstrate that the database
 * IS the append-only event log, and state IS its fold.
 */

// ─────────────────────────────────────────────────────────────────────────
// Operators
// ─────────────────────────────────────────────────────────────────────────

const OP = {
  NUL: { key: 'nul', glyph: '∅', name: 'Null',            triad: 'existence',    order: 0, stored: false },
  SIG: { key: 'sig', glyph: '○', name: 'Signal',          triad: 'existence',    order: 1, stored: false },
  INS: { key: 'ins', glyph: '●', name: 'Instantiate',     triad: 'existence',    order: 2, stored: true  },
  SEG: { key: 'seg', glyph: '｜', name: 'Segment',         triad: 'structure',    order: 3, stored: true  },
  CON: { key: 'con', glyph: '⤫', name: 'Connect',         triad: 'structure',    order: 4, stored: true  },
  SYN: { key: 'syn', glyph: '△', name: 'Synthesize',      triad: 'structure',    order: 5, stored: true  },
  DEF: { key: 'def', glyph: '⊢', name: 'Define',          triad: 'significance', order: 6, stored: true  },
  EVA: { key: 'eva', glyph: '⊨', name: 'Evaluate',        triad: 'significance', order: 7, stored: true  },
  REC: { key: 'rec', glyph: '⊛', name: 'Recontextualize', triad: 'significance', order: 8, stored: true  },
};

const STORED_OPS = Object.values(OP).filter(o => o.stored);
const ALL_OPS = Object.values(OP);

let NS = 'demo.tasks';
function setNamespace(ns) { NS = ns; }
function eventType(op) { return `${NS}.${op.key}`; }
function parseEventType(type) {
  if (!type || !type.startsWith(NS + '.')) return null;
  const suffix = type.slice(NS.length + 1);
  return Object.values(OP).find(o => o.key === suffix) || null;
}

// cyrb53 — fast 53-bit content hash, not crypto
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function makeAnchor(entityType, payload, sender, ts) {
  const input = `${entityType}\0${JSON.stringify(payload)}\0${sender}\0${ts}`;
  return `${entityType}_${cyrb53(input).toString(16).padStart(13, '0').slice(0, 10)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Fold — same nine-case dispatch, mutating accumulator
// ─────────────────────────────────────────────────────────────────────────

function initial() {
  return {
    entities: {},
    partitions: {},
    connections: [],
    frames: [],
    schema: {},
    cursor: 0,
    _violations: [],
  };
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function dispatch(state, event) {
  const op = parseEventType(event.type);
  if (!op) return state;
  const { content, sender, origin_server_ts: ts, event_id: eventId } = event;
  state.cursor = ts;

  switch (op) {
    case OP.INS: {
      const { anchor, entity_type, payload, rows } = content;
      // Bulk import — one event carrying many rows. Each row gets its own
      // entity, but the source-of-truth is the single event. Bulk events
      // also leave behind the original "import" entity at `anchor` so the
      // import shows up in the timeline / file index.
      if (Array.isArray(rows) && entity_type) {
        // Optional: materialize an "import" wrapper at `anchor` so the file
        // upload shows in the log/audit.
        if (anchor) {
          state.entities[anchor] = {
            ...(payload || {}),
            _anchor: anchor,
            _type: payload?._type || 'import',
            _created: ts,
            _sender: sender,
            _eventId: eventId,
            _hwm: OP.INS.order,
            _writes: {},
            _bulkCount: rows.length,
            _bulkTarget: entity_type,
          };
        }
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const rAnchor = r._anchor || r.anchor || makeAnchor(entity_type, r, sender, ts + i);
          if (!rAnchor) continue;
          const { _anchor: __a, anchor: __ax, ...row } = r;
          state.entities[rAnchor] = {
            ...row,
            _anchor: rAnchor,
            _type: entity_type,
            _created: ts,
            _sender: sender,
            _eventId: eventId,
            _hwm: OP.INS.order,
            _writes: {},
            _importedFrom: anchor || null,
          };
        }
        break;
      }
      if (!anchor) break;
      state.entities[anchor] = {
        ...payload,
        _anchor: anchor,
        _type: entity_type,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
        _hwm: OP.INS.order,
        _writes: {},
      };
      break;
    }
    case OP.SEG: {
      const { anchor, partition } = content;
      const entity = state.entities[anchor];
      if (!entity) {
        state._violations.push({ type: 'missing_ins', op: 'SEG', anchor, _eventId: eventId, _ts: ts });
        break;
      }
      state.partitions[anchor] = partition;
      entity._partition = partition;
      entity._updated = ts;
      if (OP.SEG.order > entity._hwm) entity._hwm = OP.SEG.order;
      break;
    }
    case OP.CON: {
      const { source_anchor, target_anchor, relation_type } = content;
      const srcMissing = !state.entities[source_anchor];
      const tgtMissing = !state.entities[target_anchor];
      if (srcMissing || tgtMissing) {
        state._violations.push({
          type: 'cartesian_product', op: 'CON',
          source: source_anchor, target: target_anchor,
          missing: srcMissing && tgtMissing ? 'both' : srcMissing ? 'source' : 'target',
          _eventId: eventId, _ts: ts,
        });
      }
      state.connections.push({
        source: source_anchor, target: target_anchor, type: relation_type,
        _eventId: eventId, _ts: ts, _sender: sender,
      });
      const src = state.entities[source_anchor];
      const tgt = state.entities[target_anchor];
      if (src && OP.CON.order > src._hwm) src._hwm = OP.CON.order;
      if (tgt && OP.CON.order > tgt._hwm) tgt._hwm = OP.CON.order;
      break;
    }
    case OP.SYN: {
      const { input_anchors, output } = content;
      const synAnchor = `syn_${(eventId || ts).toString(16)}`;
      if (input_anchors) {
        for (const ia of input_anchors) {
          if (!state.entities[ia]) {
            state._violations.push({ type: 'missing_ins', op: 'SYN', anchor: ia, _eventId: eventId, _ts: ts });
          }
        }
      }
      state.entities[synAnchor] = {
        ...output,
        _anchor: synAnchor,
        _type: '_synthesis',
        _inputs: input_anchors,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
        _hwm: OP.SYN.order,
      };
      break;
    }
    case OP.DEF: {
      const { anchor, path, value } = content;
      if (!anchor && path?.startsWith('_schema.')) {
        setPath(state.schema, path.slice('_schema.'.length), value);
        break;
      }
      if (!anchor) break;
      const entity = state.entities[anchor];
      if (!entity) {
        state._violations.push({ type: 'missing_ins', op: 'DEF', anchor, _eventId: eventId, _ts: ts });
        break;
      }
      if (path) {
        setPath(entity, path, value);
        entity._updated = ts;
        entity._updatedBy = sender;
        if (!entity._writes) entity._writes = {};
        entity._writes[path] = (entity._writes[path] || 0) + 1;
      }
      if (OP.DEF.order > entity._hwm) entity._hwm = OP.DEF.order;
      break;
    }
    case OP.EVA: {
      const { anchor, criterion, result, note } = content;
      const entity = state.entities[anchor];
      if (!entity) {
        state._violations.push({ type: 'missing_ins', op: 'EVA', anchor, _eventId: eventId, _ts: ts });
        break;
      }
      if (entity._hwm < OP.DEF.order) {
        state._violations.push({
          type: 'criterionless_judgment', op: 'EVA', anchor,
          hwm: entity._hwm, required: OP.DEF.order, _eventId: eventId, _ts: ts,
        });
      }
      if (!entity._evaluations) entity._evaluations = [];
      entity._evaluations.push({ criterion, result, note, _ts: ts, _sender: sender });
      if (OP.EVA.order > entity._hwm) entity._hwm = OP.EVA.order;
      break;
    }
    case OP.REC: {
      const hasAnyEva = Object.values(state.entities).some(e => e._hwm >= OP.EVA.order);
      if (!hasAnyEva && state.frames.length === 0) {
        state._violations.push({ type: 'blind_restructuring', op: 'REC', _eventId: eventId, _ts: ts });
      }
      state.frames.push({ ...content, _ts: ts, _sender: sender, _eventId: eventId });
      break;
    }
  }
  return state;
}

function fold(events) {
  return events.reduce(dispatch, initial());
}

// ─────────────────────────────────────────────────────────────────────────
// Seed data — task-tracker style, two rooms
// ─────────────────────────────────────────────────────────────────────────

function seedData() {
  // We use deterministic timestamps so the demo is reproducible
  let t = 1716600000000;
  const next = () => (t += 1000 + Math.floor(Math.random() * 4000));
  let n = 0;
  const id = () => `$evt_${(n++).toString().padStart(3, '0')}`;
  const ev = (roomId, op, content, sender = '@alice:demo') => ({
    event_id: id(),
    type: eventType(op),
    content,
    sender,
    origin_server_ts: next(),
    roomId,
  });

  setNamespace('demo.tasks');
  const events = [];

  // ── Room 1: !proj_alpha — a project ─────────────────────────────────────
  // SCHEMA FIRST — every column, partition, and link rule lives in the log.
  events.push(ev('!proj_alpha', OP.DEF, { anchor: null, path: '_schema.tables', value: ['task', 'note'] }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: null, path: '_schema.fields.task', value: [
    { name: 'title',      type: 'text'   },
    { name: 'priority',   type: 'select', options: ['high', 'med', 'low'] },
    { name: 'estimate_h', type: 'number' },
  ]}));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: null, path: '_schema.fields.note', value: [
    { name: 'body', type: 'text' },
  ]}));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: null, path: '_schema.partitions.task',
    value: ['backlog', 'doing', 'done'] }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: null, path: '_schema.links',
    value: [
      { from: 'task', to: 'task', rel: 'blocks'      },
      { from: 'task', to: 'task', rel: 'depends_on'  },
      { from: 'note', to: 'task', rel: 'annotates'   },
    ]}));

  // Three tasks — INS creates the bare thing, DEFs put parameters on it
  const taskA = makeAnchor('task', {}, '@alice:demo', t);
  events.push(ev('!proj_alpha', OP.INS, { anchor: taskA, entity_type: 'task', payload: {} }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskA, path: 'title', value: 'Port operators.js to Rust' }));

  const taskB = makeAnchor('task', {}, '@bob:demo', t);
  events.push(ev('!proj_alpha', OP.INS, { anchor: taskB, entity_type: 'task', payload: {} }, '@bob:demo'));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskB, path: 'title', value: 'Benchmark fold vs SQL' }, '@bob:demo'));

  const taskC = makeAnchor('task', {}, '@alice:demo', t);
  events.push(ev('!proj_alpha', OP.INS, { anchor: taskC, entity_type: 'task', payload: {} }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskC, path: 'title', value: 'Write the spec' }));

  // More DEFs — parameters
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskA, path: 'priority',   value: 'high' }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskA, path: 'estimate_h', value: 16 }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskB, path: 'priority',   value: 'med' }, '@bob:demo'));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskC, path: 'priority',   value: 'low' }));

  // SEG — move across partitions
  events.push(ev('!proj_alpha', OP.SEG, { anchor: taskA, partition: 'doing' }));
  events.push(ev('!proj_alpha', OP.SEG, { anchor: taskC, partition: 'doing' }));
  events.push(ev('!proj_alpha', OP.SEG, { anchor: taskB, partition: 'backlog' }, '@bob:demo'));

  // CON — typed relationships
  events.push(ev('!proj_alpha', OP.CON, { source_anchor: taskA, target_anchor: taskC, relation_type: 'blocks' }));
  events.push(ev('!proj_alpha', OP.CON, { source_anchor: taskB, target_anchor: taskA, relation_type: 'depends_on' }, '@bob:demo'));

  // Notes — INS then DEF
  const noteA = makeAnchor('note', {}, '@alice:demo', t);
  events.push(ev('!proj_alpha', OP.INS, { anchor: noteA, entity_type: 'note', payload: {} }));
  events.push(ev('!proj_alpha', OP.DEF, { anchor: noteA, path: 'body', value: 'See RFC 9111 §5' }));
  events.push(ev('!proj_alpha', OP.CON, { source_anchor: noteA, target_anchor: taskA, relation_type: 'annotates' }));

  // Update — second DEF on same path
  events.push(ev('!proj_alpha', OP.DEF, { anchor: taskA, path: 'estimate_h', value: 24 }));

  // SEG — task A → done
  events.push(ev('!proj_alpha', OP.SEG, { anchor: taskA, partition: 'done' }));

  // EVA — evaluate
  events.push(ev('!proj_alpha', OP.EVA, { anchor: taskA, criterion: 'spec_compliance', result: 'pass', note: 'matches §3' }, '@bob:demo'));
  events.push(ev('!proj_alpha', OP.EVA, { anchor: taskC, criterion: 'completeness', result: 'fail', note: 'missing §2 examples' }));

  // SYN — synthesize a summary
  events.push(ev('!proj_alpha', OP.SYN, {
    input_anchors: [taskA, taskC],
    output: { type: 'sprint_summary', title: 'Spec + port shipped', highlights: ['port done', 'spec needs §2'] },
  }));

  // REC — paradigm shift
  events.push(ev('!proj_alpha', OP.REC, {
    scope: 'priority_model',
    before_frame: { priority: 'fixed scalar' },
    after_frame: { priority: 'WSJF score' },
  }));

  // ── Room 2: !lab_notes — research notebook ──────────────────────────────
  events.push(ev('!lab_notes', OP.DEF, { anchor: null, path: '_schema.tables',
    value: ['observation', 'hypothesis'] }));
  events.push(ev('!lab_notes', OP.DEF, { anchor: null, path: '_schema.fields.observation', value: [
    { name: 'what', type: 'text' },
  ]}));
  events.push(ev('!lab_notes', OP.DEF, { anchor: null, path: '_schema.fields.hypothesis', value: [
    { name: 'claim',  type: 'text' },
    { name: 'status', type: 'select', options: ['open', 'supported', 'refuted'] },
  ]}));
  events.push(ev('!lab_notes', OP.DEF, { anchor: null, path: '_schema.links', value: [
    { from: 'hypothesis', to: 'observation', rel: 'explains' },
  ]}));
  const obsA = makeAnchor('observation', {}, '@alice:demo', t);
  events.push(ev('!lab_notes', OP.INS, { anchor: obsA, entity_type: 'observation', payload: {} }));
  events.push(ev('!lab_notes', OP.DEF, { anchor: obsA, path: 'what', value: 'fold runtime grows linearly with events' }));
  const hypA = makeAnchor('hypothesis', {}, '@alice:demo', t);
  events.push(ev('!lab_notes', OP.INS, { anchor: hypA, entity_type: 'hypothesis', payload: {} }));
  events.push(ev('!lab_notes', OP.DEF, { anchor: hypA, path: 'claim', value: 'O(1) per event via _hwm short-circuit' }));
  events.push(ev('!lab_notes', OP.CON, { source_anchor: hypA, target_anchor: obsA, relation_type: 'explains' }));
  events.push(ev('!lab_notes', OP.DEF, { anchor: hypA, path: 'status', value: 'open' }));

  return events;
}

window.MatrixEngine = {
  OP, STORED_OPS, ALL_OPS,
  setNamespace, eventType, parseEventType,
  cyrb53, makeAnchor,
  initial, fold, dispatch,
  seedData,
};
