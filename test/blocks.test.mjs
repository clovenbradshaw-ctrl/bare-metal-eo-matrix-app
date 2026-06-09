/* Tests for src/crypto/blockcodec.js — the media-store block chain codec.
 *
 * Runs on Node's WebCrypto (no browser, no Matrix). The headline test is
 * the import-permanence round trip: an imported dataset's op-events
 * (including the media ref + key for its row blob) survive a total
 * browser wipe via password → identity → workspace key → block chain,
 * with no megolm session or key backup anywhere in the path.
 *
 *   node test/blocks.test.mjs
 */
import assert from 'node:assert';
import {
  encodeBlock, decodeBlock, mergeChainEvents, plainEventForBlock, sha256B64,
} from '../src/crypto/blockcodec.js';
import {
  deriveAccountKey,
  generateIdentityKeyPair, exportIdentityPublicKey, importIdentityPublicKey,
  wrapIdentityPrivateKey, unwrapIdentityPrivateKey,
  generateWorkspaceKey, wrapWorkspaceKey, unwrapWorkspaceKey,
  b64, unb64,
} from '../src/crypto/envelope.js';

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
async function test(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const eq = (a, b) => assert.deepStrictEqual(a, b);

const NS = 'io.matrix-events';
function ev(id, type, content, ts, sender = '@alice:example.org') {
  return { type: `${NS}.${type}`, content, origin_server_ts: ts, sender, event_id: id };
}

await test('block encode/decode round-trips events and chain metadata', async () => {
  const wck = generateWorkspaceKey();
  const events = [
    ev('$a1', 'ins', { anchor: 'import_1', entity_type: 'import', payload: { derived_set: 'Tasks' } }, 1000),
    ev('$a2', 'def', { anchor: 'import_1', path: 'file', value: { __media: 2, mxc: 'mxc://hs/rows0', file: { v: 'v2' } } }, 1001),
  ];
  const prev = { mxc: 'mxc://hs/block0', sha256: 'abc' };
  const { bytes, sha256 } = await encodeBlock(wck, { idx: 1, prev, events, ts: 5 });

  const block = await decodeBlock(wck, bytes, sha256);
  eq(block.v, 1);
  eq(block.idx, 1);
  eq(block.ts, 5);
  eq(block.prev, prev);
  eq(block.events, events);
});

await test('ciphertext is opaque — no event content visible to the server', async () => {
  const wck = generateWorkspaceKey();
  const { bytes } = await encodeBlock(wck, {
    idx: 0, prev: null,
    events: [ev('$s', 'def', { anchor: 'r', path: 'cells.ssn', value: 'TOPSECRET' }, 1)],
  });
  const raw = Buffer.from(bytes).toString('latin1');
  assert.ok(!raw.includes('TOPSECRET'), 'value hidden');
  assert.ok(!raw.includes('cells.ssn'), 'paths hidden');
  assert.ok(!raw.includes('def'), 'operator hidden');
});

await test('hash check rejects a substituted or corrupted block', async () => {
  const wck = generateWorkspaceKey();
  const { bytes, sha256 } = await encodeBlock(wck, { idx: 0, prev: null, events: [ev('$x', 'ins', { anchor: 'a' }, 1)] });

  const tampered = bytes.slice();
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(() => decodeBlock(wck, tampered, sha256), /hash mismatch/);

  const { bytes: other } = await encodeBlock(wck, { idx: 0, prev: null, events: [ev('$y', 'ins', { anchor: 'b' }, 2)] });
  await assert.rejects(() => decodeBlock(wck, other, sha256), /hash mismatch/);
});

await test('the wrong workspace key cannot decrypt a block', async () => {
  const { bytes, sha256 } = await encodeBlock(generateWorkspaceKey(), { idx: 0, prev: null, events: [] });
  await assert.rejects(() => decodeBlock(generateWorkspaceKey(), bytes, sha256));
});

await test('plainEventForBlock strips fold-irrelevant fields', () => {
  const stripped = plainEventForBlock({
    type: `${NS}.def`, content: { x: 1 }, origin_server_ts: 7, sender: '@a:b', event_id: '$e',
    _pending: true, unsigned: { transaction_id: 'm123' }, extra: 'junk',
  });
  eq(stripped, { type: `${NS}.def`, content: { x: 1 }, origin_server_ts: 7, sender: '@a:b', event_id: '$e' });
});

await test('a three-block chain walks head→genesis with per-link verification', async () => {
  const wck = generateWorkspaceKey();
  const mediaStore = new Map();           // mxc → uploaded ciphertext
  let head = null;

  // Append three blocks the way blocks.js does: each links { mxc, sha256 }
  // of the previous upload.
  for (let i = 0; i < 3; i++) {
    const { bytes, sha256 } = await encodeBlock(wck, {
      idx: i,
      prev: head ? { mxc: head.mxc, sha256: head.sha256 } : null,
      events: [ev(`$e${i}`, 'def', { anchor: 'r', path: 'n', value: i }, 100 + i)],
    });
    const mxc = `mxc://hs/block${i}`;
    mediaStore.set(mxc, bytes);
    head = { mxc, sha256, idx: i };
  }

  // Walk like walkChain: fetch, verify against the expected hash, follow prev.
  const blocks = [];
  let ptr = { mxc: head.mxc, sha256: head.sha256 };
  while (ptr) {
    const block = await decodeBlock(wck, mediaStore.get(ptr.mxc), ptr.sha256);
    blocks.push(block);
    ptr = block.prev;
  }
  eq(blocks.map(b => b.idx), [2, 1, 0]);
  eq(mergeChainEvents([blocks]).map(e => e.content.value), [0, 1, 2]); // ts-ordered

  // Substituting any interior block breaks the walk at that link.
  const { bytes: forged } = await encodeBlock(wck, { idx: 1, prev: null, events: [] });
  mediaStore.set('mxc://hs/block1', forged);
  const top = await decodeBlock(wck, mediaStore.get(head.mxc), head.sha256);
  await assert.rejects(() => decodeBlock(wck, mediaStore.get(top.prev.mxc), top.prev.sha256), /hash mismatch/);
});

await test('mergeChainEvents dedups by event_id across senders and devices', () => {
  const a = [{ events: [ev('$1', 'ins', { anchor: 'a' }, 3), ev('$2', 'def', { anchor: 'a', path: 'x' }, 1)] }];
  const b = [{ events: [ev('$2', 'def', { anchor: 'a', path: 'x' }, 1), ev('$3', 'def', { anchor: 'a', path: 'y' }, 2)] }];
  const merged = mergeChainEvents([a, b]);
  eq(merged.map(e => e.event_id), ['$2', '$3', '$1']);   // deduped + ts-sorted
});

// ── The headline test: an Airtable import survives a full browser wipe ──
//
// The import's row blob lives in the media store; the ONLY pointer to it
// (and its decryption key) rides inside op-events. Pre-block-chain those
// events lived solely in the megolm timeline and died with the device.
// Here the whole path is reconstructed from the password + server-side
// blobs alone.
await test('post-wipe recovery: password ⇒ identity ⇒ WCK ⇒ chain ⇒ imported data', async () => {
  const password = 'correct horse battery staple';

  // ---- BEFORE THE WIPE ----
  const setup = await deriveAccountKey(password);
  const idk = await generateIdentityKeyPair();
  const accountData = {                                    // account_data["<ns>.identity"]
    salt: b64(setup.salt),
    iters: setup.iterations,
    pub: await exportIdentityPublicKey(idk.publicKey),
    wrapped_priv: await wrapIdentityPrivateKey(setup.key, idk.privateKey),
  };
  const wck = generateWorkspaceKey();
  const roomStateWkey = await wrapWorkspaceKey(             // room_state["<ns>.wkey", @self]
    await importIdentityPublicKey(accountData.pub), wck);

  // The Airtable import: rows uploaded as an encrypted chunk blob, the
  // import entity's events carry the ref + key. These events go into a
  // block; the head pointer goes into room state.
  const importEvents = [
    ev('$ins', 'ins', {
      anchor: 'import_42', entity_type: 'import',
      payload: { derived_set: 'Projects', rows_imported: 9000, shape: 'json',
                 field_plan: [{ name: 'Name', type: 'text', jsonKey: 'Name' }],
                 import_group: 'at:appX:tblY', import_seq: 0, chunk_index: 0 },
    }, 1000),
    ev('$file', 'def', {
      anchor: 'import_42', path: 'file',
      value: { __media: 2, mxc: 'mxc://hs/rowchunk0', mime: 'application/json',
               file: { v: 'v2', key: { k: 'THE-BLOB-KEY' }, iv: 'iv', hashes: { sha256: 'h' } } },
    }, 1001),
  ];
  const { bytes: blockBytes, sha256 } = await encodeBlock(wck, { idx: 0, prev: null, events: importEvents });
  const mediaStore = new Map([['mxc://hs/block0', blockBytes]]);
  const roomStateBlocks = { head: { mxc: 'mxc://hs/block0', sha256 }, idx: 0 };  // room_state["<ns>.blocks", @self]

  // ---- THE WIPE: device, vault, OPFS, megolm sessions — all gone. ----
  // Survives: password (the user), accountData + room state + media store (the server).

  // ---- AFTER THE WIPE ----
  const ak = await deriveAccountKey(password, accountData.salt, accountData.iters);
  const priv = await unwrapIdentityPrivateKey(ak.key, accountData.wrapped_priv);
  const recoveredWck = await unwrapWorkspaceKey(priv, roomStateWkey);
  const block = await decodeBlock(recoveredWck, mediaStore.get(roomStateBlocks.head.mxc), roomStateBlocks.head.sha256);
  const events = mergeChainEvents([[block]]);

  eq(events.length, 2);
  const fileDef = events.find(e => e.event_id === '$file');
  eq(fileDef.content.value.mxc, 'mxc://hs/rowchunk0');          // the row blob is findable again
  eq(fileDef.content.value.file.key.k, 'THE-BLOB-KEY');          // …and decryptable again
  const ins = events.find(e => e.event_id === '$ins');
  eq(ins.content.payload.derived_set, 'Projects');               // …and the table rebuilds
});

console.log(`\nall ${passed} block-chain checks passed`);
