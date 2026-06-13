/* Tests for src/drivebackup.js — the off-site n8n → Google Drive mirror.
 *
 * Runs on Node (global fetch is stubbed). The headline test is the
 * end-to-end round trip: a real WCK-encrypted block (blockcodec.js) is
 * mirrored to the backup webhook as base64 ciphertext, served back from a
 * simulated whole-chain hydrate response, and decoded — proving the backup
 * carries only opaque ciphertext and that a fast hydrate reconstructs the
 * exact events.
 *
 *   node test/drivebackup.test.mjs
 */
import assert from 'node:assert';
import {
  configure, getConfig, canBackup, canHydrate, isFast,
  setAuthTokenProvider, mirrorBlock, getBlock, invalidateChain,
  loadConfig, saveConfig, testConnection,
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

const BACKUP = 'https://n8n.example/webhook/backup';
const HYDRATE = 'https://n8n.example/webhook/hydrate';

// ── fetch stub ──────────────────────────────────────────────────────────
// Records every call and replies from a programmable handler. The handler
// receives (url, init) and returns { status, json?, bytes?, contentType? }.
let calls = [];
let handler = () => ({ status: 200, json: {} });
function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  const r = handler(url, init);
  return jsonResp(r.status ?? 200, r.json ?? {});
};
function reset() { calls = []; handler = () => ({ status: 200, json: {} }); invalidateChain(); }

const NS = 'io.matrix-events';
const ev = (id, type, content, ts) =>
  ({ type: `${NS}.${type}`, content, origin_server_ts: ts, sender: '@alice:example.org', event_id: id });

// ── config ──────────────────────────────────────────────────────────────

await test('config normalizes, trims, and derives capability flags', () => {
  configure({ backupUrl: '  ' + BACKUP + ' ', hydrateUrl: HYDRATE, fast: 1 });
  const c = getConfig();
  eq(c.backupUrl, BACKUP);          // trimmed
  eq(c.hydrateUrl, HYDRATE);
  eq(c.fast, true);                  // coerced
  eq(c.canBackup, true);
  eq(c.canHydrate, true);
  assert.ok(canBackup() && canHydrate() && isFast());
});

await test('an empty config disables both directions', () => {
  configure({});
  assert.ok(!canBackup() && !canHydrate() && !isFast());
});

await test('fast requires a hydrate URL', () => {
  configure({ backupUrl: BACKUP, fast: true });
  assert.ok(canBackup() && !canHydrate() && !isFast());
});

// ── backup (up) ─────────────────────────────────────────────────────────

await test('mirrorBlock POSTs { payload } with the Matrix bearer token', async () => {
  reset();
  configure({ backupUrl: BACKUP, hydrateUrl: HYDRATE });
  setAuthTokenProvider(() => 'syt_mytoken');
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const okFlag = await mirrorBlock({ roomId: '!r:hs', idx: 0, sha256: 'HASH', mxc: 'mxc://hs/b0', bytes });
  assert.ok(okFlag);
  eq(calls.length, 1);
  eq(calls[0].url, BACKUP);
  eq(calls[0].init.method, 'POST');
  eq(calls[0].init.headers.Authorization, 'Bearer syt_mytoken');
  const body = JSON.parse(calls[0].init.body);
  eq(body.payload.room, '!r:hs');
  eq(body.payload.sha256, 'HASH');
  eq(body.payload.mxc, 'mxc://hs/b0');
  eq(body.payload.data, Buffer.from(bytes).toString('base64'));   // ciphertext, base64
});

await test('mirrorBlock is a no-op (no throw) when no backup URL is set', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  const okFlag = await mirrorBlock({ roomId: '!r:hs', idx: 0, sha256: 'H', bytes: new Uint8Array([9]) });
  assert.ok(okFlag === false);
  eq(calls.length, 0);
});

await test('mirrorBlock returns false on a webhook error and never throws', async () => {
  reset();
  configure({ backupUrl: BACKUP });
  handler = () => ({ status: 401, json: { ok: false } });
  const okFlag = await mirrorBlock({ roomId: '!r:hs', idx: 0, sha256: 'H', bytes: new Uint8Array([9]) });
  assert.ok(okFlag === false);
});

// ── hydration (down) ──────────────────────────────────────────────────────

function chainResponse(payloads) {
  return { version: 1, head: null, blocks: payloads.map((p, i) => ({ index: i, payload: p })) };
}

await test('getBlock resolves a block by sha256 from the whole-chain pull', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  setAuthTokenProvider(() => 'tok');
  const data = Buffer.from([5, 6, 7]).toString('base64');
  handler = () => ({ status: 200, json: chainResponse([{ sha256: 'AAA', data }]) });
  const got = await getBlock({ sha256: 'AAA' });
  eq([...got], [5, 6, 7]);
  eq(calls[0].init.headers.Authorization, 'Bearer tok');   // bearer sent on GET too
  assert.ok(await getBlock({ sha256: 'MISSING' }) === null);
});

await test('a burst of getBlock calls costs a single GET (cached chain)', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  const mk = (n) => Buffer.from([n]).toString('base64');
  handler = () => ({ status: 200, json: chainResponse([
    { sha256: 'a', data: mk(1) }, { sha256: 'b', data: mk(2) }, { sha256: 'c', data: mk(3) },
  ]) });
  const [a, b, c] = await Promise.all([
    getBlock({ sha256: 'a' }), getBlock({ sha256: 'b' }), getBlock({ sha256: 'c' }),
  ]);
  eq([[...a], [...b], [...c]], [[1], [2], [3]]);
  eq(calls.length, 1);                                       // one pull served all three
});

await test('getBlock returns null when hydration is not configured', async () => {
  reset();
  configure({ backupUrl: BACKUP });                          // no hydrate URL
  assert.ok(await getBlock({ sha256: 'x' }) === null);
  eq(calls.length, 0);
});

await test('a successful mirror invalidates the cached chain', async () => {
  reset();
  configure({ backupUrl: BACKUP, hydrateUrl: HYDRATE });
  handler = (url) => url === HYDRATE
    ? { status: 200, json: chainResponse([]) }
    : { status: 200, json: { ok: true } };
  await getBlock({ sha256: 'none' });                        // pull #1
  await getBlock({ sha256: 'none' });                        // cached, no pull
  eq(calls.filter(c => c.url === HYDRATE).length, 1);
  await mirrorBlock({ roomId: '!r', idx: 1, sha256: 'H', bytes: new Uint8Array([1]) });
  await getBlock({ sha256: 'none' });                        // cache invalidated → pull #2
  eq(calls.filter(c => c.url === HYDRATE).length, 2);
});

// ── persistence ──────────────────────────────────────────────────────────

await test('saveConfig persists via storeSecret; loadConfig restores it', async () => {
  const store = new Map();
  const storeSecret = async (uid, name, val) => { store.set(`${uid}:${name}`, val); };
  const loadSecret = async (uid, name) => store.get(`${uid}:${name}`) || null;
  const removeSecret = (uid, name) => { store.delete(`${uid}:${name}`); };

  await saveConfig('@u:hs', { backupUrl: BACKUP, hydrateUrl: HYDRATE, fast: true },
    { storeSecret, removeSecret });
  configure({});                                            // wipe memory
  assert.ok(!canHydrate());
  await loadConfig('@u:hs', loadSecret);
  const c = getConfig();
  eq(c.backupUrl, BACKUP);
  eq(c.hydrateUrl, HYDRATE);
  eq(c.fast, true);
});

await test('saveConfig with empty URLs removes the stored secret', async () => {
  const store = new Map([['@u:hs:drive_backup', '{"backupUrl":"x"}']]);
  const removed = [];
  const storeSecret = async () => {};
  const removeSecret = (uid, name) => { removed.push(`${uid}:${name}`); store.delete(`${uid}:${name}`); };
  await saveConfig('@u:hs', {}, { storeSecret, removeSecret });
  eq(removed, ['@u:hs:drive_backup']);
});

await test('testConnection reports ok + block count from the hydrate endpoint', async () => {
  reset();
  configure({ hydrateUrl: HYDRATE });
  handler = () => ({ status: 200, json: chainResponse([{ sha256: 'a', data: 'AA==' }]) });
  const res = await testConnection();
  eq(res.ok, true);
  eq(res.status, 200);
  eq(res.blocks, 1);
});

// ── headline: real ciphertext round-trips backup → hydrate → decode ───────

await test('round trip: a WCK block mirrored to Drive hydrates and decodes', async () => {
  reset();
  configure({ backupUrl: BACKUP, hydrateUrl: HYDRATE });
  setAuthTokenProvider(() => 'syt_live');
  const wck = generateWorkspaceKey();

  // Encode a real block exactly as blocks.js appendBlock would.
  const events = [
    ev('$ins', 'ins', { anchor: 'import_1', entity_type: 'import', payload: { derived_set: 'Cases' } }, 1000),
    ev('$file', 'def', { anchor: 'import_1', path: 'file', value: { __media: 2, mxc: 'mxc://hs/rows0' } }, 1001),
  ];
  const { bytes, sha256 } = await encodeBlock(wck, { idx: 0, prev: null, events });

  // BACKUP: mirror it. Capture what was sent to Drive.
  let stored = null;
  handler = () => ({ status: 200, json: { ok: true } });
  await mirrorBlock({ roomId: '!case:hs', idx: 0, sha256, mxc: 'mxc://hs/block0', bytes });
  stored = JSON.parse(calls.at(-1).init.body).payload;
  eq(stored.sha256, sha256);

  // The bytes in Drive are opaque ciphertext — no plaintext leaks.
  const raw = Buffer.from(stored.data, 'base64').toString('latin1');
  assert.ok(!raw.includes('Cases') && !raw.includes('import') && !raw.includes('ins'));

  // HYDRATE: the whole-chain GET returns that payload; getBlock serves it.
  handler = () => ({ status: 200, json: chainResponse([stored]) });
  const ct = await getBlock({ sha256 });
  const block = await decodeBlock(wck, ct, sha256);           // verifies hash + decrypts
  eq(mergeChainEvents([[block]]), events);                    // exact events recovered
});

console.log(`\nall ${passed} drive-backup checks passed`);
