// scratch-verify-store.mjs — standalone Node verification for the
// checkpoint+index fast-open path in src/store.js. Not part of the app;
// run directly with `node scratch-verify-store.mjs`. Mocks OPFS with an
// in-memory filesystem; uses REAL Web Crypto (Node's built-in
// crypto.subtle) through the real, unmodified vault.js, so the AES-GCM
// encrypt/decrypt path is genuinely exercised, not stubbed.

import assert from 'node:assert/strict';

// ---- Mock OPFS (navigator.storage.getDirectory()) ----------------------
class MockFile {
  constructor(bytes) { this._bytes = bytes; this.size = bytes.length; }
  slice(start, end) {
    const s = start ?? 0;
    const e = end ?? this._bytes.length;
    return new MockFile(this._bytes.slice(s, e));
  }
  async arrayBuffer() { return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength); }
}

class MockWritable {
  constructor(fileHandle, keepExisting) {
    this._fh = fileHandle;
    this._buf = keepExisting ? Array.from(fileHandle._bytes) : [];
    this._pos = keepExisting ? fileHandle._bytes.length : 0;
  }
  async write(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) this._buf[this._pos + i] = arr[i];
    this._pos += arr.length;
  }
  async seek(pos) { this._pos = pos; }
  async close() { this._fh._bytes = new Uint8Array(this._buf); }
}

class MockFileHandle {
  constructor(name, dir) { this.name = name; this._dir = dir; this._bytes = new Uint8Array(0); }
  async getFile() { return new MockFile(this._bytes); }
  async createWritable(opts = {}) { return new MockWritable(this, !!opts.keepExistingData); }
}

class MockDirHandle {
  constructor() { this._files = new Map(); }
  async getFileHandle(name, opts = {}) {
    if (this._files.has(name)) return this._files.get(name);
    if (!opts.create) throw new Error(`not found: ${name}`);
    const fh = new MockFileHandle(name, this);
    this._files.set(name, fh);
    return fh;
  }
  async removeEntry(name) { this._files.delete(name); }
  async *[Symbol.asyncIterator]() {
    for (const [name, handle] of this._files) yield [name, handle];
  }
}

// store.js pulls in operators.js -> client.js -> network.js purely for
// emit()/optimistic-dispatch machinery this test never calls; those files
// still reference a few browser globals at MODULE LOAD time. Minimal stubs
// so the import graph resolves — nothing here is exercised by the actual
// test scenarios below, which only touch EventStore/fold/foldFrom.
if (typeof window === 'undefined') {
  globalThis.window = new EventTarget();
}
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
}
if (typeof localStorage === 'undefined') globalThis.localStorage = makeStorage();
if (typeof sessionStorage === 'undefined') globalThis.sessionStorage = makeStorage();

const sharedDir = new MockDirHandle();
// Node 21+ ships a read-only `navigator` global — override it via
// defineProperty rather than a plain assignment, which throws.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    storage: {
      getDirectory: async () => sharedDir,
      persist: async () => true,
      persisted: async () => true,
    },
  },
  writable: true,
  configurable: true,
});

// ---- Real modules --------------------------------------------------------
const { vault } = await import('./src/vault.js');
const { fold, foldFrom, initial } = await import('./src/fold.js');
const { setNamespace, OP, eventType } = await import('./src/operators.js');
const storeMod = await import('./src/store.js');
const { EventStore, packIndexEntries, unpackIndexEntries } = storeMod;

setNamespace('test.ns');
await vault.initialize('@tester:example.org', 'correct horse battery staple');
assert.ok(vault.isUnlocked(), 'vault should be unlocked after initialize');

// ---- Pure pack/unpack round-trip -----------------------------------------
{
  const entries = [
    { eventCount: 1000, ts: 1700000000000, byteOffset: 42 },
    { eventCount: 2000, ts: 1700000001234, byteOffset: 99999 },
    { eventCount: 3000, ts: 1700000009999, byteOffset: 4294967295 - 10 }, // near uint32 max, still safe here
  ];
  const packed = packIndexEntries(entries);
  const unpacked = unpackIndexEntries(packed);
  assert.deepEqual(unpacked, entries, 'index pack/unpack round-trip must be exact');
  console.log('✓ index pack/unpack round-trip');
}

// ---- Synthetic event generator -------------------------------------------
let evtCounter = 0;
function makeEvent(op, content, ts) {
  evtCounter++;
  return {
    type: eventType(op),
    content,
    origin_server_ts: ts,
    sender: '@tester:example.org',
    event_id: `$evt-${evtCounter}`,
  };
}

function insEvent(anchor, ts) {
  return makeEvent(OP.INS, { anchor, entity_type: 'thing', payload: { n: anchor } }, ts);
}
function defEvent(anchor, path, value, ts) {
  return makeEvent(OP.DEF, { anchor, path, value }, ts);
}

// ---- Scenario A: many-small-batch writes across several index intervals -
// 2,600 INS events, one event per append() call (worst case for index
// granularity — should still land marks at 1000/2000, never one per write).
{
  const roomId = '!room-a:example.org';
  let ts = 1_700_000_000_000;
  const store1 = new EventStore(roomId, 'test.ns');
  await store1.open(); // no data file yet — should NOT crash, should be empty
  assert.equal(store1.getCount(), 0);

  const N = 2600;
  for (let i = 0; i < N; i++) {
    ts += 1;
    await store1.append([insEvent(`a${i}`, ts)]);
  }
  assert.equal(store1.getCount(), N, 'count after N single-event appends');

  // No checkpoint yet — a fresh store instance on the same dir must fall
  // back to a full scan and reproduce identical bookkeeping.
  const store2 = new EventStore(roomId, 'test.ns');
  await store2.open();
  assert.equal(store2.getCount(), N, 'full-scan count matches');
  assert.equal(store2.getCursor(), store1.getCursor(), 'full-scan cursor matches');
  assert.equal(store2._checkpointState, null, 'no checkpoint existed yet — fast path must not have fired');

  const allViaScan = await store2.getAll();
  assert.equal(allViaScan.length, N, 'getAll after full scan returns all events');
  const stateFull = fold(allViaScan);
  assert.equal(Object.keys(stateFull.entities).length, N, 'fold produced one entity per INS');

  // store2's own full scan should have rebuilt a real index (>=1 mark for N=2600 at interval 1000).
  assert.ok(store2._index.length >= 2, `expected >=2 index marks for ${N} events at interval 1000, got ${store2._index.length}`);

  // Now save a checkpoint from store2's fully-scanned state, then open a
  // THIRD fresh instance — this one should take the fast path.
  await store2.saveCheckpoint(stateFull);

  const store3 = new EventStore(roomId, 'test.ns');
  await store3.open();
  assert.equal(store3.getCount(), N, 'fast-open count matches full scan');
  assert.equal(store3.getCursor(), store2.getCursor(), 'fast-open cursor matches full scan');
  assert.notEqual(store3._checkpointState, null, 'fast path SHOULD have fired this time (checkpoint + index both exist)');

  const basis = await store3.getFoldBasis();
  assert.equal(basis.tailEvents.length, 0, 'checkpoint covers everything written before it — tail must be empty');
  const stateFast = foldFrom(structuredCloneCompat(basis.checkpointState), basis.tailEvents);

  assert.deepEqual(
    normalizeStateForCompare(stateFast),
    normalizeStateForCompare(stateFull),
    'FAST-OPEN fold must be byte-identical to FULL-SCAN fold'
  );
  console.log(`✓ scenario A (${N} single-event writes, ${store2._index.length} index marks): fast-open matches full-scan exactly`);
}

// ---- Scenario B: fast-open store gets MORE events appended afterward, ----
// including one duplicate (already-seen) event id, and a real DEF mutating
// an entity created before the checkpoint — proves the tail correctly
// extends the checkpoint's state rather than replacing or duplicating it.
{
  const roomId = '!room-b:example.org';
  let ts = 1_800_000_000_000;
  const store1 = new EventStore(roomId, 'test.ns');
  await store1.open();

  const first50 = [];
  for (let i = 0; i < 1500; i++) { ts += 1; first50.push(insEvent(`b${i}`, ts)); }
  await store1.append(first50);
  const stateAfterFirst = fold(await store1.getAll());
  await store1.saveCheckpoint(stateAfterFirst);

  // A duplicate of an event id already inside the checkpoint's own coverage.
  const dup = first50[10];

  const store2 = new EventStore(roomId, 'test.ns');
  await store2.open();
  assert.notEqual(store2._checkpointState, null, 'fast path should fire (checkpoint exists)');

  const dupResult = await store2.append([dup]);
  assert.deepEqual(dupResult, [], 'an already-seen event id must be rejected as a no-op, even after a fast open');
  assert.equal(store2.getCount(), 1500, 'count unchanged after a rejected duplicate');

  ts += 1;
  const newIns = insEvent('b-new', ts);
  ts += 1;
  const newDef = defEvent('b0', 'status', 'done', ts); // mutates an entity from BEFORE the checkpoint
  const added = await store2.append([newIns, newDef]);
  assert.equal(added.length, 2, 'two genuinely new events accepted');
  assert.equal(store2.getCount(), 1502);

  // Ground truth: fold every real event directly, from scratch.
  const allRaw = [...first50, newIns, newDef];
  const groundTruth = fold(allRaw);

  const basis2 = await store2.getFoldBasis();
  const stateB = foldFrom(structuredCloneCompat(basis2.checkpointState), basis2.tailEvents);

  // Targeted diagnostic before the (very large, truncated-in-output) full
  // deepEqual, so a real mismatch is pinpointed rather than dumped as one
  // giant unreadable diff.
  {
    const ak = Object.keys(stateB.entities).sort();
    const bk = Object.keys(groundTruth.entities).sort();
    const onlyA = ak.filter(k => !bk.includes(k));
    const onlyB = bk.filter(k => !ak.includes(k));
    if (onlyA.length || onlyB.length) {
      console.log('entity keys only in fast-open state:', onlyA.slice(0, 10));
      console.log('entity keys only in ground truth:', onlyB.slice(0, 10));
    }
    for (const k of ak) {
      if (bk.includes(k)) {
        const av = JSON.stringify(sortObj(stateB.entities[k]));
        const bv = JSON.stringify(sortObj(groundTruth.entities[k]));
        if (av !== bv) { console.log(`entity ${k} differs:\n  fast: ${av}\n  truth: ${bv}`); }
      }
    }
    console.log('cursor fast/truth:', stateB.cursor, groundTruth.cursor);
    console.log('connections fast/truth:', stateB.connections.length, groundTruth.connections.length);
    console.log('violations fast/truth:', stateB._violations.length, groundTruth._violations.length);
  }
  function sortObj(o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out; }

  assert.deepEqual(
    normalizeStateForCompare(stateB),
    normalizeStateForCompare(groundTruth),
    'post-checkpoint appends (including a DEF mutating a pre-checkpoint entity) must fold identically to a from-scratch full fold'
  );
  assert.equal(stateB.entities['b0'].status, 'done', 'the DEF actually landed on the pre-checkpoint entity');
  console.log('✓ scenario B (append after fast-open, dedup + cross-checkpoint mutation): matches ground truth');
}

// ---- Scenario C: double-decrypt cache -------------------------------------
{
  const roomId = '!room-c:example.org';
  let ts = 1_900_000_000_000;
  const store1 = new EventStore(roomId, 'test.ns');
  await store1.open();
  for (let i = 0; i < 50; i++) { ts += 1; await store1.append([insEvent(`c${i}`, ts)]); }

  const store2 = new EventStore(roomId, 'test.ns'); // fresh instance -> full scan -> _scannedEvents populated
  await store2.open();
  assert.ok(store2._scannedEvents, '_scannedEvents should be populated by the full scan');
  const first = await store2.getAll();
  const second = await store2.getAll();
  assert.equal(first, second, 'getAll() must return the SAME cached array reference on a second call, not re-decrypt');

  ts += 1;
  await store2.append([insEvent('c-extra', ts)]);
  assert.equal(store2._scannedEvents, null, 'append() must invalidate the cache');
  const third = await store2.getAll();
  assert.equal(third.length, 51, 'getAll() after append reflects the new event (cache correctly rebuilt, not stale)');
  console.log('✓ scenario C: double-decrypt cache correct (reused on repeat getAll, invalidated on append)');
}

console.log('\nALL VERIFICATION SCENARIOS PASSED');

// ---- helpers ----
function structuredCloneCompat(obj) { return JSON.parse(JSON.stringify(obj)); }
// Normalize before deepEqual: real fold() vs a JSON-round-tripped
// checkpoint state can differ in key insertion order without differing in
// content — sort keys recursively before stringifying for comparison.
function normalizeStateForCompare(state) {
  const sorter = (obj) => {
    if (Array.isArray(obj)) return obj.map(sorter);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj).sort()) out[k] = sorter(obj[k]);
      return out;
    }
    return obj;
  };
  return JSON.stringify(sorter(state));
}
