/**
 * pickleKey.js — Non-extractable AES-GCM key stored in IndexedDB.
 *
 * The Matrix access token + device_id is encrypted with a per-user
 * AES-GCM CryptoKey generated as `extractable: false`. The CryptoKey
 * object itself is stored inside IndexedDB (browsers allow this for
 * non-extractable keys); the raw key bytes can never be exported, only
 * used via WebCrypto. This means:
 *
 *   - Even origin-attached scripts cannot exfiltrate the key.
 *   - Cold reload reads the key + decrypts the session, with no
 *     password prompt required (Element Web's pickleKey pattern).
 *
 * Storage layout (IndexedDB `mx_pickle_store`):
 *
 *   pickle_keys    keyed by userId → { key: CryptoKey }
 *   sessions       keyed by userId → { iv: Uint8Array, ct: Uint8Array }
 */

const DB_NAME = 'mx_pickle_store';
const DB_VERSION = 1;
const KEY_STORE = 'pickle_keys';
const SESSION_STORE = 'sessions';
const IV_BYTES = 12;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode) {
  const db = await openDb();
  return db.transaction(store, mode).objectStore(store);
}

async function getOrCreatePickleKey(userId) {
  let store = await tx(KEY_STORE, 'readonly');
  const existing = await reqPromise(store.get(userId));
  if (existing && existing.key) return existing.key;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,                       // non-extractable
    ['encrypt', 'decrypt']
  );
  store = await tx(KEY_STORE, 'readwrite');
  await reqPromise(store.put({ key }, userId));
  return key;
}

export async function storeSessionEncrypted(userId, session) {
  const key = await getOrCreatePickleKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );
  const store = await tx(SESSION_STORE, 'readwrite');
  await reqPromise(store.put({ iv, ct }, userId));
}

export async function loadSessionEncrypted(userId) {
  const store = await tx(SESSION_STORE, 'readonly');
  const rec = await reqPromise(store.get(userId));
  if (!rec) return null;
  const keyStore = await tx(KEY_STORE, 'readonly');
  const keyRec = await reqPromise(keyStore.get(userId));
  if (!keyRec || !keyRec.key) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: rec.iv },
      keyRec.key,
      rec.ct
    );
    return JSON.parse(new TextDecoder().decode(new Uint8Array(pt)));
  } catch (e) {
    console.warn('[pickleKey] decrypt failed:', e);
    return null;
  }
}

export async function dropSessionEncrypted(userId) {
  try {
    const store = await tx(SESSION_STORE, 'readwrite');
    await reqPromise(store.delete(userId));
  } catch (e) {
    console.warn('[pickleKey] drop session failed:', e);
  }
}

export async function hasStoredSession(userId) {
  try {
    const store = await tx(SESSION_STORE, 'readonly');
    const rec = await reqPromise(store.get(userId));
    return !!rec;
  } catch {
    return false;
  }
}

export async function wipePickleKey(userId) {
  try {
    let store = await tx(SESSION_STORE, 'readwrite');
    await reqPromise(store.delete(userId));
    store = await tx(KEY_STORE, 'readwrite');
    await reqPromise(store.delete(userId));
  } catch (e) {
    console.warn('[pickleKey] wipe failed:', e);
  }
}
