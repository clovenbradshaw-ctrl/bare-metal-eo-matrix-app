/**
 * vault.js — Local-at-rest encryption
 *
 * Every byte we persist (OPFS event files, checkpoints, outbox payloads,
 * session token) is AES-GCM encrypted with a key derived from the user's
 * Matrix password via PBKDF2. The key lives only in memory.
 *
 * Three states:
 *   - sealed   : no key in memory. Local data is opaque.
 *   - unlocked : key in memory. Reads and writes succeed.
 *   - absent   : no vault metadata at all (first launch or post-logout).
 *
 * Lock clears the key, keeps the data. Logout wipes everything.
 *
 * Per-user vault metadata (salt + verifier ciphertext) lives in
 * localStorage. It is small and non-secret — knowing the salt and an
 * encrypted "userId" string does not help an attacker recover the key
 * without the password.
 */

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;
const VAULT_META_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function metaKey(userId) {
  return `vault:${userId}`;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

function loadMeta(userId) {
  const raw = localStorage.getItem(metaKey(userId));
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj.v !== VAULT_META_VERSION) return null;
    return {
      salt: unb64(obj.salt),
      verifierIv: unb64(obj.verifierIv),
      verifierCt: unb64(obj.verifierCt),
    };
  } catch {
    return null;
  }
}

function saveMeta(userId, salt, verifierIv, verifierCt) {
  localStorage.setItem(metaKey(userId), JSON.stringify({
    v: VAULT_META_VERSION,
    salt: b64(salt),
    verifierIv: b64(verifierIv),
    verifierCt: b64(verifierCt),
  }));
}

class Vault {
  constructor() {
    this._key = null;
    this._userId = null;
    this._listeners = new Set();
  }

  isUnlocked() { return this._key !== null; }
  getUserId() { return this._userId; }
  hasMeta(userId) { return loadMeta(userId) !== null; }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn({ unlocked: this.isUnlocked(), userId: this._userId }); }
      catch (e) { console.warn('[vault] listener error:', e); }
    }
  }

  /**
   * First-time setup. Generates a salt and verifier from `password`,
   * stores the metadata locally, and unlocks the vault in memory.
   *
   * Called on the first successful Matrix login for a given user on
   * this device. Subsequent logins use unlock() instead.
   */
  async initialize(userId, password) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await deriveKey(password, salt);

    const verifierIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const verifierPlain = encoder.encode(`verify:${userId}`);
    const verifierCt = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: verifierIv }, key, verifierPlain)
    );

    saveMeta(userId, salt, verifierIv, verifierCt);
    this._key = key;
    this._userId = userId;
    this._notify();
  }

  /**
   * Unlock an existing vault. Returns true on success, false on bad
   * password. Works fully offline — no network calls.
   */
  async unlock(userId, password) {
    const meta = loadMeta(userId);
    if (!meta) return false;
    const candidate = await deriveKey(password, meta.salt);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: meta.verifierIv },
        candidate,
        meta.verifierCt
      );
      if (decoder.decode(new Uint8Array(plain)) !== `verify:${userId}`) return false;
      this._key = candidate;
      this._userId = userId;
      this._notify();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-key after a password change. Existing data stays decryptable
   * with the old key until callers rewrite it; this is intentionally
   * not handled here.
   */
  async rekey(userId, newPassword) {
    if (!this.isUnlocked() || this._userId !== userId) {
      throw new Error('Vault must be unlocked for the same user to rekey');
    }
    await this.initialize(userId, newPassword);
  }

  /** Lock: clear key from memory, keep data on disk. */
  lock() {
    this._key = null;
    this._notify();
  }

  /**
   * Wipe vault metadata for this user. Caller is responsible for
   * deleting the encrypted payloads themselves (OPFS files, outbox DB,
   * encrypted session). Use clearAll() for a full nuke.
   */
  wipe(userId) {
    localStorage.removeItem(metaKey(userId));
    if (this._userId === userId) {
      this._key = null;
      this._userId = null;
      this._notify();
    }
  }

  /**
   * Encrypt arbitrary bytes. Returns a single Uint8Array of
   * [iv(12)][ciphertext+tag].
   */
  async encryptBytes(plaintext) {
    if (!this._key) throw new Error('Vault is locked');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, plaintext)
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return out;
  }

  /** Decrypt an [iv][ct] blob produced by encryptBytes. */
  async decryptBytes(blob) {
    if (!this._key) throw new Error('Vault is locked');
    const iv = blob.subarray(0, IV_BYTES);
    const ct = blob.subarray(IV_BYTES);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this._key, ct);
    return new Uint8Array(pt);
  }

  async encryptJSON(obj) {
    return this.encryptBytes(encoder.encode(JSON.stringify(obj)));
  }

  async decryptJSON(blob) {
    const bytes = await this.decryptBytes(blob);
    return JSON.parse(decoder.decode(bytes));
  }

  async encryptString(str) {
    return this.encryptBytes(encoder.encode(str));
  }

  async decryptString(blob) {
    return decoder.decode(await this.decryptBytes(blob));
  }
}

export const vault = new Vault();

/**
 * Convenience: encode an encrypted blob as base64 for localStorage.
 * Use for small values (session token, single-record stores).
 */
export async function encryptToB64(plaintextStr) {
  const bytes = await vault.encryptString(plaintextStr);
  return b64(bytes);
}

export async function decryptFromB64(b64Str) {
  return vault.decryptString(unb64(b64Str));
}

/** Per-user encrypted-session key in localStorage. */
export function sessionKey(userId) {
  return `mx_session_enc:${userId}`;
}

/** Public list of users that have a vault on this device. */
export function listVaultUsers() {
  const ids = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('vault:')) ids.push(k.slice('vault:'.length));
  }
  return ids;
}

/** Track which user last logged in so the unlock UI can prefill. */
const LAST_USER_KEY = 'vault:last_user';
export function rememberLastUser(userId) {
  localStorage.setItem(LAST_USER_KEY, userId);
}
export function getLastUser() {
  return localStorage.getItem(LAST_USER_KEY) || null;
}
export function forgetLastUser() {
  localStorage.removeItem(LAST_USER_KEY);
}
