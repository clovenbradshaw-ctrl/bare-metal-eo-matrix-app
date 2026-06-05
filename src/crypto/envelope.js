/**
 * crypto/envelope.js — primitives for stable-key envelope encryption.
 *
 * This is the cryptographic core of the "database E2EE" model
 * (see ENCRYPTION-DESIGN.md). It is deliberately free of any Matrix or
 * app dependency so it can be reasoned about and unit-tested in isolation;
 * the glue that reads/writes Matrix account_data and room state lives
 * elsewhere.
 *
 * Key hierarchy implemented here:
 *
 *   password ─PBKDF2─▶ Account Key (AES-GCM)         deriveAccountKey
 *                         │ wrap
 *                         ▼
 *                 User Identity Key (ECDH P-256)       generate/​wrap/​unwrapIdentityKey
 *                         │ ECIES
 *                         ▼
 *                 Workspace Content Key (32 raw bytes) generate/​wrap/​unwrapWorkspaceKey
 *                         │ AES-GCM
 *                         ▼
 *                 event payloads                       encrypt/​decryptPayload
 *
 * All AES-GCM blobs are laid out as [iv(12)][ciphertext+tag] and base64'd,
 * matching vault.js so the two stay mentally interchangeable.
 */

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;
const WCK_BYTES = 32;
const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── base64 helpers (binary-safe, no spread on large arrays) ──

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// ── low-level AES-GCM with a CryptoKey ──

async function aesEncrypt(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

async function aesDecrypt(key, blob) {
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

async function importAesKey(rawBytes) {
  return subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ── Account Key: password → AES-GCM key, with a fresh or given salt ──

/**
 * Derive the Account Key from the user's password. Pass an existing salt
 * (post-wipe, read from account_data) or omit it to mint a new one
 * (first login). Returns { key, salt, iterations }.
 */
export async function deriveAccountKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const saltBytes = salt ? (salt instanceof Uint8Array ? salt : unb64(salt)) : randomBytes(PBKDF2_SALT_BYTES);
  const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, salt: saltBytes, iterations };
}

// ── User Identity Key: ECDH P-256 keypair, private wrapped by the Account Key ──

/** Generate a fresh, extractable ECDH P-256 identity keypair. */
export async function generateIdentityKeyPair() {
  return subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
}

/** Export the public half as base64 SPKI for publishing to room state. */
export async function exportIdentityPublicKey(publicKey) {
  return b64(new Uint8Array(await subtle.exportKey('spki', publicKey)));
}

/** Import a peer's base64 SPKI public key. */
export async function importIdentityPublicKey(spkiB64) {
  return subtle.importKey('spki', unb64(spkiB64), ECDH_PARAMS, true, []);
}

/**
 * Wrap an identity private key under the Account Key for storage in
 * account_data. Returns base64 of [iv][ct] over the PKCS8 export.
 */
export async function wrapIdentityPrivateKey(accountKey, privateKey) {
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', privateKey));
  return b64(await aesEncrypt(accountKey, pkcs8));
}

/** Unwrap an identity private key produced by wrapIdentityPrivateKey. */
export async function unwrapIdentityPrivateKey(accountKey, wrappedB64) {
  const pkcs8 = await aesDecrypt(accountKey, unb64(wrappedB64));
  return subtle.importKey('pkcs8', pkcs8, ECDH_PARAMS, true, ['deriveBits']);
}

// ── Workspace Content Key: 32 random bytes, distributed via ECIES ──

/** Mint a new Workspace Content Key (raw bytes). */
export function generateWorkspaceKey() {
  return randomBytes(WCK_BYTES);
}

/**
 * Derive an AES-GCM wrapping key from an ECDH shared secret via HKDF.
 * `info` domain-separates this use ("eo-wck-wrap") from any other.
 */
async function deriveWrapKey(privateKey, publicKey) {
  const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, KEY_BITS);
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('eo-wck-wrap') },
    hkdfKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * ECIES-wrap a Workspace Content Key for a recipient's identity public
 * key. Uses an ephemeral ECDH keypair so the wrap is one-shot and
 * forward-secure with respect to the sender. Returns
 * { eph_pub, blob } (both base64), suitable for an `<ns>.wkey` state event.
 */
export async function wrapWorkspaceKey(recipientPublicKey, wckBytes) {
  const ephemeral = await subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipientPublicKey);
  return {
    eph_pub: await exportIdentityPublicKey(ephemeral.publicKey),
    blob: b64(await aesEncrypt(wrapKey, wckBytes)),
  };
}

/** Unwrap a Workspace Content Key with the recipient's identity private key. */
export async function unwrapWorkspaceKey(recipientPrivateKey, { eph_pub, blob }) {
  const ephPub = await importIdentityPublicKey(eph_pub);
  const wrapKey = await deriveWrapKey(recipientPrivateKey, ephPub);
  return aesDecrypt(wrapKey, unb64(blob));
}

// ── Event payloads: AES-GCM under the Workspace Content Key ──

/**
 * Encrypt an operator event for the wire. `op` is the operator key
 * (e.g. "ins") and `content` its payload; both are hidden inside the
 * ciphertext so the homeserver sees only an opaque blob. Returns the
 * `content` for an `<ns>.enc` event: { v, epoch, iv, ct }.
 */
export async function encryptPayload(wckBytes, epoch, op, content) {
  const key = await importAesKey(wckBytes);
  const plaintext = encoder.encode(JSON.stringify({ t: op, c: content }));
  const blob = await aesEncrypt(key, plaintext);
  return {
    v: 1,
    epoch,
    iv: b64(blob.subarray(0, IV_BYTES)),
    ct: b64(blob.subarray(IV_BYTES)),
  };
}

/**
 * Decrypt an `<ns>.enc` event content back to { op, content }. Throws if
 * the key is wrong or the blob is tampered (AES-GCM auth failure).
 */
export async function decryptPayload(wckBytes, envelope) {
  const key = await importAesKey(wckBytes);
  const iv = unb64(envelope.iv);
  const ct = unb64(envelope.ct);
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  const plain = await aesDecrypt(key, blob);
  const { t, c } = JSON.parse(decoder.decode(plain));
  return { op: t, content: c };
}
