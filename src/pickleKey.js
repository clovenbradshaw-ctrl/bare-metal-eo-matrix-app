/**
 * pickleKey.js — Non-extractable AES-GCM key in IndexedDB.
 *
 * Wraps and persists the (extractable) vault key so a browser restart
 * can re-adopt it without prompting for the password. The vault key
 * itself encrypts everything-at-rest (OPFS rooms, outbox payloads,
 * the localStorage session blob); persisting it under a non-extractable
 * "pickle" key — same pattern Element Web uses — lets us tier our two
 * "stay signed in" mechanisms:
 *
 *   1. sessionStorage stash  (tab refresh, vault.js)
 *      Fast path. Cleared when the tab/browser closes.
 *
 *   2. IDB pickle-wrapped vault key  (browser restart, this file)
 *      Slower path. Persists until the user explicitly signs out or
 *      clears local data. Decrypted in memory only via WebCrypto; the
 *      raw pickle key is non-extractable, so even origin-attached
 *      scripts can't read it out of the browser.
 *
 * IDB layout (`mx_pickle_store`):
 *
 *   pickle_keys   userId → { key: CryptoKey }              non-extractable
 *   vault_keys    userId → { iv: Uint8Array, ct: Uint8Array }
 *
 * The session token + device_id is NOT stored here. It lives
 * vault-encrypted in localStorage (`mx_session_enc:{userId}`) as
 * before; once the vault key is back in memory, `restoreSession()`
 * reads it directly.
 */

const DB_NAME = 'mx_pickle_store';
const DB_VERSION = 1;
const KEY_STORE = 'pickle_keys';
const VAULT_STORE = 'vault_keys';
const IV_BYTES = 12;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
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

async function txStore(store, mode) {
  const db = await openDb();
  return db.transaction(store, mode).objectStore(store);
}

async function getOrCreatePickleKey(userId) {
  let store = await txStore(KEY_STORE, 'readonly');
  const existing = await reqPromise(store.get(userId));
  if (existing && existing.key) return existing.key;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,                       // non-extractable
    ['encrypt', 'decrypt']
  );
  store = await txStore(KEY_STORE, 'readwrite');
  await reqPromise(store.put({ key }, userId));
  return key;
}

/**
 * Persist `keyBytes` (the raw bytes of the extractable vault key) under
 * the user's pickle key. Idempotent — re-stashing overwrites cleanly.
 */
export async function storeVaultKey(userId, keyBytes) {
  if (!keyBytes) return false;
  try {
    const pickle = await getOrCreatePickleKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, pickle, keyBytes)
    );
    const store = await txStore(VAULT_STORE, 'readwrite');
    await reqPromise(store.put({ iv, ct }, userId));
    return true;
  } catch (e) {
    console.warn('[pickleKey] storeVaultKey failed:', e);
    return false;
  }
}

/**
 * Read the user's vault key bytes back. Returns null when there is no
 * stash or the pickle key is missing / can't decrypt.
 */
export async function loadVaultKey(userId) {
  try {
    const store = await txStore(VAULT_STORE, 'readonly');
    const rec = await reqPromise(store.get(userId));
    if (!rec) return null;
    const keyStore = await txStore(KEY_STORE, 'readonly');
    const keyRec = await reqPromise(keyStore.get(userId));
    if (!keyRec || !keyRec.key) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: rec.iv },
      keyRec.key,
      rec.ct
    );
    return new Uint8Array(pt);
  } catch (e) {
    console.warn('[pickleKey] loadVaultKey failed:', e);
    return null;
  }
}

export async function dropVaultKey(userId) {
  try {
    const store = await txStore(VAULT_STORE, 'readwrite');
    await reqPromise(store.delete(userId));
  } catch (e) {
    console.warn('[pickleKey] dropVaultKey failed:', e);
  }
}

export async function hasStoredVaultKey(userId) {
  try {
    const store = await txStore(VAULT_STORE, 'readonly');
    const rec = await reqPromise(store.get(userId));
    return !!rec;
  } catch {
    return false;
  }
}

export async function wipePickleKey(userId) {
  try {
    let store = await txStore(VAULT_STORE, 'readwrite');
    await reqPromise(store.delete(userId));
    store = await txStore(KEY_STORE, 'readwrite');
    await reqPromise(store.delete(userId));
  } catch (e) {
    console.warn('[pickleKey] wipe failed:', e);
  }
}
