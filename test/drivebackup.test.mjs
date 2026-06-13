/* Tests for src/drivebackup.js — the off-site n8n → Google Drive mirror.
 *
 * Runs on Node (global fetch is stubbed). Covers the Drive-specific block
 * cycle: length-prefixed binary record framing, ~100-event batched flushes,
 * client-enforced segment rotation, and a hydrate that parses the
 * concatenated segments back by content hash. The headline test is the
 * end-to-end round trip — a real WCK-encrypted block (blockcodec.js) is
 * queued, flushed to Drive as binary, served back from a simulated whole-
 * chain hydrate, and decoded — proving the backup carries only opaque
 * ciphertext and reconstructs the exact events.
 *
 *   node test/drivebackup.test.mjs
 */
import assert from 'node:assert';
import {
  configure, getConfig, canBackup, canHydrate,
  setAuthTokenProvider, queueBlock, flushBackup, getBlock, peekBlock,
  invalidateChain, loadConfig, saveConfig, testConnection,
  ensureBackupInitialized, frameRecord, parseRecords,
} from '../src/drivebackup.js';
import { encodeBlock, decodeBlock, mergeChainEvents } from '../src/crypto/blockcodec.js';
import { generateWorkspaceKey } from '../src/crypto/envelope.js';

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
async function test(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

const STATE = 'https://n8n.example/webhook/state';
const BACKUP = 'https://n8n.example/webhook/backup';
const HYDRATE = 'https://n8n.example/webhook/hydrate';
const enc = new TextEncoder();

// ── fetch stub ──────────────────────────────────────────────────────────
// Records every call; replies from a programmable handler keyed on URL. The
// handler returns { status?, json? } or { status?, bytes? (Uint8Array) }.
let calls = [];
let handler = () => ({ status: 200, json: {} });
function makeResp(r) {
  const status = r.status ?? 200;
  const bytes = r.bytes ?? (r.json !== undefined ? enc.encode(JSON.stringify(r.json)) : new Uint8Array());
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => (r.json !== undefined ? r.json : JSON.parse(new TextDecoder().decode(bytes))),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
globalThis.fetch = async (url, init) => { calls.push({ url, init }); return makeResp(handler(url, init)); };
function reset() { calls = []; handler = () => ({ status: 200, json: {} }); invalidateChain(); }
const callsTo = (url) => calls.filter(c => c.url === url);

function concatU8(arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const NS = 'io.matrix-events';
const ev = (id, type, content, ts) =>
  ({ type: `${NS}.${type}`, content, origin_server_ts: ts, sender: '@alice:example.org', event_id: id });

// ── config ──────────────────────────────────────────────────────────────

await test('canBackup needs both write + state URLs; canHydrate needs hydrate', () => {
  configure({ backupUrl: '  ' + BACKUP + ' ', stateUrl: STATE, hydrateUrl: HYDRATE });
  const c = getConfig();
  eq(c.backupUrl, BACKUP);                  // trimmed
  eq(c.canBackup, true);
  eq(c.canHydrate, true);
  assert.ok(canBackup() && canHydrate());

  configure({ backupUrl: BACKUP });          // no state URL
  assert.ok(!canBackup());
  configure({ stateUrl: STATE, hydrateUrl: HYDRATE });  // no backup URL
  assert.ok(!canBackup() && canHydrate());
  configure({});
  assert.ok(!canBackup() && !canHydrate());
});

// ── binary record framing ─────────────────────────────────────────────────

await test('frameRecord / parseRecords round-trips a record stream', () => {
  const r0 = frameRecord({ room: '!a', idx: 0, sha256: 'H0', mxc: 'mxc://0', ts: 1, bytes: new Uint8Array([10, 20]) });
  const r1 = frameRecord({ room: '!a', idx: 1, sha256: 'H1', mxc: 'mxc://1', ts: 2, bytes: new Uint8Array([30]) });
  const recs = parseRecords(concatU8([r0, r1]));
  eq(recs.map(r => r.sha256), ['H0', 'H1']);
  eq([...recs[0].data], [10, 20]);
  eq([...recs[1].data], [30]);
});

await test('parseRecords stops cleanly at a truncated trailing frame', () => {
  const full = frameRecord({ room: '!a', idx: 0, sha256: 'H', mxc: 'm', ts: 1, bytes: new Uint8Array([1, 2, 3]) });
  const recs = parseRecords(concatU8([full, full.slice(0, 5)]));   // 2nd frame cut off
  eq(recs.map(r => r.sha256), ['H']);                              // the whole one survives
  eq(parseRecords(new Uint8Array()), []);
});

// ── backup (up): batching + rotation ───────────────────────────────────────

await test('flushBackup sends a binary record batch with auth + segment headers', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE, hydrateUrl: HYDRATE });
  setAuthTokenProvider(() => 'syt_tok');
  handler = (url) => url === STATE ? { json: { index: 0, bytes: 0 } } : { json: { index: 0, bytes: 999 } };

  queueBlock({ roomId: '!r:hs', idx: 0, sha256: 'AAA', mxc: 'mxc://b0', bytes: new Uint8Array([1, 2, 3]), events: 1 });
  const okFlag = await flushBackup();
  assert.ok(okFlag);

  eq(callsTo(STATE).length, 1);                       // read segment state once
  const post = callsTo(BACKUP)[0];
  eq(post.init.method, 'POST');
  eq(post.init.headers.Authorization, 'Bearer syt_tok');
  eq(post.init.headers['Content-Type'], 'application/octet-stream');
  eq(post.init.headers['X-Segment-Index'], '0');
  eq(post.init.headers['X-Segment-Mode'], 'create');  // empty genesis ⇒ create
  const recs = parseRecords(post.init.body);
  eq(recs.map(r => r.sha256), ['AAA']);
  eq([...recs[0].data], [1, 2, 3]);                   // ciphertext shipped verbatim
});

await test('an existing non-empty segment is appended, not recreated', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = (url) => url === STATE ? { json: { index: 2, bytes: 4096 } } : { json: { index: 2, bytes: 4108 } };
  queueBlock({ roomId: '!r', idx: 9, sha256: 'Z', mxc: 'm', bytes: new Uint8Array([7]), events: 1 });
  await flushBackup();
  const post = callsTo(BACKUP)[0];
  eq(post.init.headers['X-Segment-Index'], '2');
  eq(post.init.headers['X-Segment-Mode'], 'append');
});

await test('client rolls to a new segment when the cap would be exceeded', async () => {
  reset();
  const CAP = 25 * 1024 * 1024;
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = (url) => url === STATE ? { json: { index: 5, bytes: CAP } } : { json: { index: 6, bytes: 12 } };
  queueBlock({ roomId: '!r', idx: 1, sha256: 'Z', mxc: 'm', bytes: new Uint8Array([1, 2, 3]), events: 1 });
  await flushBackup();
  const post = callsTo(BACKUP)[0];
  eq(post.init.headers['X-Segment-Index'], '6');       // rolled 5 → 6
  eq(post.init.headers['X-Segment-Mode'], 'create');   // new file
});

await test('a full ~100-event batch auto-flushes without an explicit call', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = (url) => url === STATE ? { json: { index: 0, bytes: 10 } } : { json: { index: 0, bytes: 20 } };
  queueBlock({ roomId: '!r', idx: 0, sha256: 'A', mxc: 'm', bytes: new Uint8Array([1]), events: 100 });
  await tick();
  eq(callsTo(BACKUP).length, 1);
});

await test('a failed flush requeues the batch and does not lose it', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = (url) => url === STATE ? { json: { index: 0, bytes: 0 } } : { status: 500 };
  queueBlock({ roomId: '!r', idx: 0, sha256: 'A', mxc: 'm', bytes: new Uint8Array([1]), events: 1 });
  eq(await flushBackup(), false);
  // Now let the next attempt succeed — the same record must still be there.
  let body = null;
  handler = (url) => url === STATE ? { json: { index: 0, bytes: 0 } } : (body = url, { json: { index: 0, bytes: 5 } });
  const post = () => callsTo(BACKUP).at(-1);
  eq(await flushBackup(), true);
  eq(parseRecords(post().init.body).map(r => r.sha256), ['A']);
});

// ── genesis init: "if there's nothing in drive, add the hydration file" ────

await test('ensureBackupInitialized creates an empty genesis when Drive is empty', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = (url) => url === STATE ? { json: { index: 0, bytes: 0, exists: false } } : { json: { index: 0, bytes: 0 } };
  eq(await ensureBackupInitialized(), true);
  const post = callsTo(BACKUP)[0];
  eq(post.init.headers['X-Segment-Index'], '0');
  eq(post.init.headers['X-Segment-Mode'], 'create');
  eq(post.init.body.length, 0);                          // empty genesis
});

await test('ensureBackupInitialized is a no-op when a segment already exists', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = () => ({ json: { index: 3, bytes: 4096, exists: true } });
  eq(await ensureBackupInitialized(), false);
  eq(callsTo(BACKUP).length, 0);                          // nothing written
});

await test('ensureBackupInitialized never writes when state is unreachable', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE });
  handler = (url) => url === STATE ? { status: 502 } : { json: {} };
  eq(await ensureBackupInitialized(), false);
  eq(callsTo(BACKUP).length, 0);                          // no risk of overwrite
});

// ── hydration (down) ──────────────────────────────────────────────────────

function hydrateBytes(records) {
  return concatU8(records.map(r => frameRecord({
    room: '!r', idx: 0, sha256: r.sha256, mxc: 'm', ts: 1, bytes: r.bytes,
  })));
}

await test('getBlock resolves a block by sha256 from the concatenated segments', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  setAuthTokenProvider(() => 'tok');
  handler = () => ({ bytes: hydrateBytes([{ sha256: 'AAA', bytes: new Uint8Array([5, 6, 7]) }]) });
  const got = await getBlock({ sha256: 'AAA' });
  eq([...got], [5, 6, 7]);
  eq(callsTo(HYDRATE)[0].init.headers.Authorization, 'Bearer tok');
  assert.ok(await getBlock({ sha256: 'MISSING' }) === null);
});

await test('a burst of getBlock calls costs a single GET (cached chain)', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  handler = () => ({ bytes: hydrateBytes([
    { sha256: 'a', bytes: new Uint8Array([1]) },
    { sha256: 'b', bytes: new Uint8Array([2]) },
    { sha256: 'c', bytes: new Uint8Array([3]) },
  ]) });
  const [a, b, c] = await Promise.all([getBlock({ sha256: 'a' }), getBlock({ sha256: 'b' }), getBlock({ sha256: 'c' })]);
  eq([[...a], [...b], [...c]], [[1], [2], [3]]);
  eq(callsTo(HYDRATE).length, 1);
});

await test('peekBlock serves from the resolved chain with no extra fetch', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  handler = () => ({ bytes: hydrateBytes([{ sha256: 'a', bytes: new Uint8Array([9]) }]) });
  assert.ok(peekBlock({ sha256: 'a' }) === null);        // nothing pulled yet
  await getBlock({ sha256: 'a' });                        // pulls + caches
  eq([...peekBlock({ sha256: 'a' })], [9]);              // now synchronous
  eq(callsTo(HYDRATE).length, 1);                         // no second GET
});

await test('a successful flush invalidates the cached chain ("check for latest")', async () => {
  reset();
  configure({ backupUrl: BACKUP, stateUrl: STATE, hydrateUrl: HYDRATE });
  handler = (url) => {
    if (url === HYDRATE) return { bytes: hydrateBytes([]) };
    if (url === STATE) return { json: { index: 0, bytes: 0 } };
    return { json: { index: 0, bytes: 5 } };
  };
  await getBlock({ sha256: 'x' });                        // pull #1
  await getBlock({ sha256: 'x' });                        // cached
  eq(callsTo(HYDRATE).length, 1);
  queueBlock({ roomId: '!r', idx: 0, sha256: 'y', mxc: 'm', bytes: new Uint8Array([1]), events: 1 });
  await flushBackup();                                    // invalidates
  await getBlock({ sha256: 'x' });                        // pull #2
  eq(callsTo(HYDRATE).length, 2);
});

// ── persistence ──────────────────────────────────────────────────────────

await test('saveConfig persists via storeSecret; loadConfig restores it', async () => {
  const store = new Map();
  const storeSecret = async (uid, name, val) => { store.set(`${uid}:${name}`, val); };
  const loadSecret = async (uid, name) => store.get(`${uid}:${name}`) || null;
  const removeSecret = (uid, name) => { store.delete(`${uid}:${name}`); };

  await saveConfig('@u:hs', { stateUrl: STATE, backupUrl: BACKUP, hydrateUrl: HYDRATE }, { storeSecret, removeSecret });
  configure({});
  assert.ok(!canHydrate());
  await loadConfig('@u:hs', loadSecret);
  const c = getConfig();
  eq([c.stateUrl, c.backupUrl, c.hydrateUrl], [STATE, BACKUP, HYDRATE]);
});

await test('saveConfig with empty URLs removes the stored secret', async () => {
  const removed = [];
  const storeSecret = async () => {};
  const removeSecret = (uid, name) => removed.push(`${uid}:${name}`);
  await saveConfig('@u:hs', {}, { storeSecret, removeSecret });
  eq(removed, ['@u:hs:drive_backup']);
});

await test('testConnection reports ok + record count from the hydrate endpoint', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  handler = () => ({ bytes: hydrateBytes([
    { sha256: 'a', bytes: new Uint8Array([1]) }, { sha256: 'b', bytes: new Uint8Array([2]) },
  ]) });
  const res = await testConnection();
  eq(res.ok, true);
  eq(res.status, 200);
  eq(res.blocks, 2);
});

// ── headline: real ciphertext round-trips backup → hydrate → decode ───────

await test('round trip: a queued WCK block flushes to Drive, hydrates, and decodes', async () => {
  reset();
  configure({ stateUrl: STATE, backupUrl: BACKUP, hydrateUrl: HYDRATE });
  setAuthTokenProvider(() => 'syt_live');
  const wck = generateWorkspaceKey();

  const events = [
    ev('$ins', 'ins', { anchor: 'import_1', entity_type: 'import', payload: { derived_set: 'Cases' } }, 1000),
    ev('$file', 'def', { anchor: 'import_1', path: 'file', value: { __media: 2, mxc: 'mxc://hs/rows0' } }, 1001),
  ];
  const { bytes, sha256 } = await encodeBlock(wck, { idx: 0, prev: null, events });

  // BACKUP: queue + flush, capturing the binary stream sent to Drive.
  handler = (url) => url === STATE ? { json: { index: 0, bytes: 0 } } : { json: { index: 0, bytes: bytes.length } };
  queueBlock({ roomId: '!case:hs', idx: 0, sha256, mxc: 'mxc://hs/block0', bytes, events: events.length });
  await flushBackup();
  const sent = callsTo(BACKUP)[0].init.body;             // the binary record stream

  // The bytes in Drive are opaque ciphertext — no plaintext leaks.
  const raw = Buffer.from(sent).toString('latin1');
  assert.ok(!raw.includes('Cases') && !raw.includes('import_1') && !raw.includes('rows0'));

  // HYDRATE: that exact stream is what the whole-chain GET returns.
  handler = () => ({ bytes: sent });
  const ct = await getBlock({ sha256 });
  const block = await decodeBlock(wck, ct, sha256);      // verifies hash + decrypts
  eq(mergeChainEvents([[block]]), events);               // exact events recovered
});

console.log(`\nall ${passed} drive-backup checks passed`);
