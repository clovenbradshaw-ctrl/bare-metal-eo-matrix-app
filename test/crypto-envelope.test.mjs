/* Tests for src/crypto/envelope.js — the stable-key envelope crypto core.
 *
 * Runs on Node's WebCrypto (no browser, no Matrix). The headline test is
 * the post-wipe recovery round trip: a user with nothing but their
 * password and the server-side (account_data + room state) blobs must
 * reconstruct the Workspace Content Key and decrypt history.
 *
 *   node test/crypto-envelope.test.mjs
 */
import assert from 'node:assert';
import {
  deriveAccountKey,
  generateIdentityKeyPair, exportIdentityPublicKey, importIdentityPublicKey,
  wrapIdentityPrivateKey, unwrapIdentityPrivateKey,
  generateWorkspaceKey, wrapWorkspaceKey, unwrapWorkspaceKey,
  encryptPayload, decryptPayload,
  b64, unb64,
} from '../src/crypto/envelope.js';

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
async function test(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const eq = (a, b) => assert.deepStrictEqual(a, b);
const bytesEq = (a, b) => assert.strictEqual(b64(a), b64(b));

await test('base64 round trips arbitrary bytes', () => {
  const r = globalThis.crypto.getRandomValues(new Uint8Array(257));
  bytesEq(unb64(b64(r)), r);
});

await test('Account Key is deterministic for (password, salt, iters)', async () => {
  const a = await deriveAccountKey('hunter2');
  const b = await deriveAccountKey('hunter2', a.salt, a.iterations);
  // Same salt+password ⇒ same key ⇒ can decrypt what the other encrypted.
  const priv = (await generateIdentityKeyPair()).privateKey;
  const wrapped = await wrapIdentityPrivateKey(a.key, priv);
  const back = await unwrapIdentityPrivateKey(b.key, wrapped);
  assert.ok(back, 'unwrapped key with a freshly-derived Account Key');
});

await test('wrong password cannot unwrap the identity key', async () => {
  const good = await deriveAccountKey('correct horse');
  const bad = await deriveAccountKey('battery staple', good.salt, good.iterations);
  const priv = (await generateIdentityKeyPair()).privateKey;
  const wrapped = await wrapIdentityPrivateKey(good.key, priv);
  await assert.rejects(() => unwrapIdentityPrivateKey(bad.key, wrapped));
});

await test('identity public key exports/imports as SPKI base64', async () => {
  const kp = await generateIdentityKeyPair();
  const spki = await exportIdentityPublicKey(kp.publicKey);
  const reimported = await importIdentityPublicKey(spki);
  // Re-export and compare; SPKI is canonical so the bytes match.
  eq(await exportIdentityPublicKey(reimported), spki);
});

await test('ECIES wrap/unwrap returns the same Workspace Content Key', async () => {
  const recipient = await generateIdentityKeyPair();
  const wck = generateWorkspaceKey();
  const wrapped = await wrapWorkspaceKey(recipient.publicKey, wck);
  const back = await unwrapWorkspaceKey(recipient.privateKey, wrapped);
  bytesEq(back, wck);
});

await test('a different recipient cannot unwrap the WCK', async () => {
  const recipient = await generateIdentityKeyPair();
  const attacker = await generateIdentityKeyPair();
  const wck = generateWorkspaceKey();
  const wrapped = await wrapWorkspaceKey(recipient.publicKey, wck);
  await assert.rejects(() => unwrapWorkspaceKey(attacker.privateKey, wrapped));
});

await test('payload encrypt/decrypt preserves operator + content', async () => {
  const wck = generateWorkspaceKey();
  const content = { anchor: 'r1', path: 'cells.name', value: 'Ada Lovelace', n: 42, nested: { a: [1, 2, 3] } };
  const env = await encryptPayload(wck, 0, 'def', content);
  eq(env.v, 1); eq(env.epoch, 0);
  assert.ok(env.iv && env.ct, 'has iv + ct');
  const out = await decryptPayload(wck, env);
  eq(out.op, 'def');
  eq(out.content, content);
});

await test('ciphertext is opaque — no plaintext leaks into the envelope', async () => {
  const wck = generateWorkspaceKey();
  const env = await encryptPayload(wck, 3, 'ins', { secret: 'TOPSECRETVALUE' });
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes('TOPSECRETVALUE'), 'no plaintext value');
  assert.ok(!serialized.includes('ins'), 'operator key hidden inside ciphertext');
  assert.ok(!serialized.includes('secret'), 'field names hidden');
});

await test('tampered ciphertext is rejected (AES-GCM auth)', async () => {
  const wck = generateWorkspaceKey();
  const env = await encryptPayload(wck, 0, 'ins', { x: 1 });
  const ctBytes = unb64(env.ct);
  ctBytes[0] ^= 0xff;
  const tampered = { ...env, ct: b64(ctBytes) };
  await assert.rejects(() => decryptPayload(wck, tampered));
});

await test('the wrong Workspace Content Key cannot decrypt a payload', async () => {
  const env = await encryptPayload(generateWorkspaceKey(), 0, 'ins', { x: 1 });
  await assert.rejects(() => decryptPayload(generateWorkspaceKey(), env));
});

// ── The headline test: full post-wipe recovery from password + server blobs ──
await test('post-wipe recovery: password + account_data + room state ⇒ history', async () => {
  const password = 'the user types this at login';

  // ---- BEFORE THE WIPE: set up identity, workspace, and write an edit ----
  const setup = await deriveAccountKey(password);
  const idk = await generateIdentityKeyPair();

  // What the server persists, all unreadable without the password:
  const accountData = {                                   // account_data["<ns>.identity"]
    salt: b64(setup.salt),
    iters: setup.iterations,
    pub: await exportIdentityPublicKey(idk.publicKey),
    wrapped_priv: await wrapIdentityPrivateKey(setup.key, idk.privateKey),
  };
  const wck = generateWorkspaceKey();
  const selfPub = await importIdentityPublicKey(accountData.pub);
  const roomStateWkey = await wrapWorkspaceKey(selfPub, wck);   // room_state["<ns>.wkey", self]
  const timelineEvent = await encryptPayload(wck, 0, 'def', {   // a cell edit on the timeline
    anchor: 'row-7', path: 'cells.title', value: 'recovered!',
  });

  // ---- THE WIPE: every local byte is gone. We keep only `password`
  //      and what the homeserver holds: accountData, roomStateWkey, timelineEvent.
  //      (No device, no crypto store, no megolm, no key backup.) ----

  // ---- AFTER THE WIPE: reconstruct everything from the password ----
  const recovered = await deriveAccountKey(password, accountData.salt, accountData.iters);
  const recoveredPriv = await unwrapIdentityPrivateKey(recovered.key, accountData.wrapped_priv);
  const recoveredWck = await unwrapWorkspaceKey(recoveredPriv, roomStateWkey);
  const decrypted = await decryptPayload(recoveredWck, timelineEvent);

  eq(decrypted.op, 'def');
  eq(decrypted.content, { anchor: 'row-7', path: 'cells.title', value: 'recovered!' });
});

// ── Member onboarding: granter wraps the WCK for a new member ──
await test('member onboarding: granter wraps WCK to a new member', async () => {
  const wck = generateWorkspaceKey();
  const member = await generateIdentityKeyPair();              // the invitee
  // Member publishes its public key; a holder wraps the existing WCK to it.
  const memberPubB64 = await exportIdentityPublicKey(member.publicKey);
  const grant = await wrapWorkspaceKey(await importIdentityPublicKey(memberPubB64), wck);
  // Member unwraps with its private key and reads history.
  const got = await unwrapWorkspaceKey(member.privateKey, grant);
  bytesEq(got, wck);
});

// ── Epoch rotation on member removal ──
await test('epoch rotation: old events use old key, new events use new key', async () => {
  const remaining = await generateIdentityKeyPair();
  const wck0 = generateWorkspaceKey();
  const wck1 = generateWorkspaceKey();                          // minted on member removal
  const grant0 = await wrapWorkspaceKey(remaining.publicKey, wck0);
  const grant1 = await wrapWorkspaceKey(remaining.publicKey, wck1);

  const oldEvent = await encryptPayload(wck0, 0, 'ins', { v: 'old' });
  const newEvent = await encryptPayload(wck1, 1, 'ins', { v: 'new' });

  // A remaining member holds both epochs and reads the full history.
  const k0 = await unwrapWorkspaceKey(remaining.privateKey, grant0);
  const k1 = await unwrapWorkspaceKey(remaining.privateKey, grant1);
  const byEpoch = { 0: k0, 1: k1 };
  eq((await decryptPayload(byEpoch[oldEvent.epoch], oldEvent)).content, { v: 'old' });
  eq((await decryptPayload(byEpoch[newEvent.epoch], newEvent)).content, { v: 'new' });
});

console.log(`\nall ${passed} envelope-crypto checks passed`);
