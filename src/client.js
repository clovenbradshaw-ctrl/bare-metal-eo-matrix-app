/**
 * client.js — Matrix connection layer
 *
 * Wraps matrix-js-sdk: login, session persistence, sync, crypto init.
 * Adds vault-encrypted session storage and offline-capable unlock.
 *
 * Three entry points:
 *   - login(hs, user, password)         : first time on this device
 *   - unlock(userId, password)          : subsequent launches; works offline
 *   - restoreSession(userId)            : auto-unlock from in-memory key (no-op when locked)
 *
 * The session token is stored vault-encrypted in localStorage so that a
 * device with a locked vault cannot mint Matrix requests, and the
 * token is wiped from disk on full logout.
 */

import * as sdk from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { vault, sessionKey, rememberLastUser, forgetLastUser } from './vault.js';
import { wipeAllRoomData } from './store.js';
import { clearAll as clearOutbox } from './outbox.js';
import { watchSync } from './network.js';

let client = null;
let _watchSyncUnsub = null;

let progress = (msg) => console.log('[matrix]', msg);
export function setProgress(fn) {
  progress = (msg) => { console.log('[matrix]', msg); fn(msg); };
}

let recoveryKeyProvider = null;
let recoveryKeyDisplayer = null;
export function setRecoveryKeyProvider(fn) { recoveryKeyProvider = fn; }
export function setRecoveryKeyDisplayer(fn) { recoveryKeyDisplayer = fn; }

export function getClient() { return client; }

const CRYPTO_STORE_NAME = 'matrix-js-sdk::matrix-sdk-crypto';

function clearCryptoStore() {
  return new Promise((resolve, reject) => {
    progress('Clearing stale crypto store…');
    const req = indexedDB.deleteDatabase(CRYPTO_STORE_NAME);
    req.onsuccess = () => { progress('Crypto store cleared'); resolve(); };
    req.onerror = () => { progress('Crypto store clear failed'); reject(req.error); };
    req.onblocked = () => { progress('Crypto store clear blocked — closing connections'); resolve(); };
  });
}

function isCryptoStoreMismatch(err) {
  const msg = String(err && err.message || err || '');
  return msg.includes('account in the store doesn\'t match') ||
         msg.includes('account in the store does not match');
}

async function initCryptoWithRetry(c, timeoutMs = 30000) {
  try {
    await withTimeout(c.initRustCrypto(), timeoutMs, 'Crypto init');
  } catch (err) {
    if (isCryptoStoreMismatch(err)) {
      progress('Device ID changed — clearing old crypto store and retrying…');
      await clearCryptoStore();
      await withTimeout(c.initRustCrypto(), timeoutMs, 'Crypto init (retry)');
    } else {
      throw err;
    }
  }
}

function waitForSync(c, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const current = c.getSyncState && c.getSyncState();
    if (current === 'PREPARED' || current === 'SYNCING') {
      resolve();
      return;
    }

    const onSync = (state, prevState, data) => {
      progress(`sync state: ${state}`);
      if (state === 'PREPARED' || state === 'SYNCING') {
        cleanup();
        resolve();
      } else if (state === 'ERROR' && data && data.error) {
        const err = data.error;
        if (err.httpStatus === 401 || err.httpStatus === 403 ||
            err.errcode === 'M_UNKNOWN_TOKEN') {
          cleanup();
          reject(new Error('Session expired — please log in again'));
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Sync did not become ready within ${timeoutMs / 1000}s (last state: ${c.getSyncState && c.getSyncState()})`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      c.off(sdk.ClientEvent.Sync, onSync);
    };

    c.on(sdk.ClientEvent.Sync, onSync);
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function getSecretStorageKey({ keys }) {
  if (!recoveryKeyProvider) {
    progress('Recovery key required but no UI provider registered');
    return null;
  }
  const keyId = Object.keys(keys)[0];
  if (!keyId) return null;

  const encoded = await recoveryKeyProvider();
  if (!encoded) return null;

  try {
    const privateKey = decodeRecoveryKey(encoded.trim());
    return [keyId, privateKey];
  } catch (e) {
    progress(`Recovery key invalid: ${e.message}`);
    return null;
  }
}

async function ensureEncryptionSetUp({ userMxid, password }) {
  const crypto = client.getCrypto();
  if (!crypto) return;

  if (await crypto.isCrossSigningReady()) {
    try { await crypto.checkKeyBackupAndEnable(); } catch (e) {
      progress(`Key backup check failed: ${e.message}`);
    }
    return;
  }

  const accountHasCrossSigning = await crypto.userHasCrossSigningKeys(userMxid, true);

  if (accountHasCrossSigning) {
    progress('Restoring encryption keys from recovery…');
    await crypto.bootstrapCrossSigning({});
    try { await crypto.loadSessionBackupPrivateKeyFromSecretStorage(); } catch (e) {
      progress(`Could not load backup key: ${e.message}`);
    }
    try {
      await crypto.restoreKeyBackup();
    } catch (e) {
      progress(`Key backup restore failed: ${e.message}`);
    }
    try { await crypto.checkKeyBackupAndEnable(); } catch {}
    return;
  }

  if (!password) {
    progress('Skipping encryption setup: no password available (login again to enable history backup)');
    return;
  }

  progress('Setting up encryption + recovery key…');
  const localUser = userMxid.replace(/^@/, '').split(':')[0];
  const generatedKey = await crypto.createRecoveryKeyFromPassphrase();

  await crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: localUser },
        password,
      });
    },
  });

  await crypto.bootstrapSecretStorage({
    createSecretStorageKey: async () => generatedKey,
    setupNewKeyBackup: true,
    setupNewSecretStorage: true,
  });

  try { await crypto.checkKeyBackupAndEnable(); } catch {}

  if (recoveryKeyDisplayer && generatedKey.encodedPrivateKey) {
    await recoveryKeyDisplayer(generatedKey.encodedPrivateKey);
  } else {
    progress(`Recovery key: ${generatedKey.encodedPrivateKey}`);
  }
}

async function discoverBaseUrl(rawHs, mxid) {
  const serverName = mxid && mxid.includes(':')
    ? mxid.split(':').slice(1).join(':')
    : new URL(rawHs).hostname;

  try {
    const config = await withTimeout(
      sdk.AutoDiscovery.findClientConfig(serverName),
      10000,
      'Homeserver discovery'
    );
    const action = config['m.homeserver'] && config['m.homeserver'].state;
    const discovered = config['m.homeserver'] && config['m.homeserver'].base_url;
    if (action === 'SUCCESS' && discovered) {
      progress(`Discovered homeserver: ${discovered}`);
      return discovered.replace(/\/+$/, '');
    }
  } catch (e) {
    progress(`Discovery skipped: ${e.message}`);
  }
  return rawHs.replace(/\/+$/, '');
}

// ── Vault-encrypted session storage ──

async function persistSession(userId, session) {
  if (!vault.isUnlocked()) throw new Error('Vault locked — cannot persist session');
  const blob = await vault.encryptJSON(session);
  // localStorage can't store Uint8Array directly — base64 it.
  let s = '';
  for (let i = 0; i < blob.length; i++) s += String.fromCharCode(blob[i]);
  localStorage.setItem(sessionKey(userId), btoa(s));
}

async function loadSession(userId) {
  const raw = localStorage.getItem(sessionKey(userId));
  if (!raw) return null;
  if (!vault.isUnlocked()) throw new Error('Vault locked — cannot read session');
  const bin = atob(raw);
  const blob = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) blob[i] = bin.charCodeAt(i);
  return vault.decryptJSON(blob);
}

function dropSession(userId) {
  localStorage.removeItem(sessionKey(userId));
}

// ── Public API ──

export async function login(homeserver, username, password) {
  const user = username.replace(/^@/, '').split(':')[0];

  progress('Resolving homeserver…');
  const baseUrl = await discoverBaseUrl(homeserver, username);
  progress(`Using ${baseUrl}`);

  progress('Authenticating…');
  const tmp = sdk.createClient({ baseUrl });
  const resp = await withTimeout(
    tmp.login('m.login.password', {
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: 'Matrix Events',
    }),
    30000,
    'Login request'
  );
  progress(`Authenticated as ${resp.user_id}`);

  // Bootstrap or unlock the vault using the Matrix password. The vault
  // key never leaves memory; the password is only used here for KDF.
  if (!vault.hasMeta(resp.user_id)) {
    progress('Initializing local vault…');
    await vault.initialize(resp.user_id, password);
  } else if (!vault.isUnlocked() || vault.getUserId() !== resp.user_id) {
    progress('Unlocking local vault…');
    const ok = await vault.unlock(resp.user_id, password);
    if (!ok) {
      // Password changed on the server; reset the vault so the new
      // password becomes the unlock. This loses access to any locally
      // encrypted data — surface clearly to the caller.
      progress('Vault password mismatch — rotating to current password (local data will be reset)');
      vault.wipe(resp.user_id);
      try { await wipeAllRoomData(); } catch {}
      try { await clearOutbox(); } catch {}
      await vault.initialize(resp.user_id, password);
    }
  }

  rememberLastUser(resp.user_id);

  // Persist session (encrypted) immediately so a reload mid-bootstrap
  // doesn't drop us back to the login form with a new device id.
  await persistSession(resp.user_id, {
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
  });

  client = sdk.createClient({
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
    cryptoCallbacks: { getSecretStorageKey },
  });

  progress('Initializing encryption…');
  await initCryptoWithRetry(client);

  progress('Starting sync…');
  await client.startClient({ initialSyncLimit: 100 });
  if (_watchSyncUnsub) _watchSyncUnsub();
  _watchSyncUnsub = watchSync(client);
  await waitForSync(client);
  progress('Sync ready');

  try {
    await ensureEncryptionSetUp({ userMxid: resp.user_id, password });
  } catch (e) {
    progress(`Encryption setup failed: ${e.message}`);
  }

  return { client, userId: resp.user_id, deviceId: resp.device_id };
}

/**
 * Restore a previously saved session. Vault must already be unlocked
 * for `userId`. Returns the client (online or offline-shimmed) or
 * null if there is no saved session for this user.
 *
 * If the network is reachable, this brings up sync. If not, the
 * client is left "offline" — startClient is still called but sync
 * will be in RECONNECTING. The local store + outbox keep functioning.
 */
export async function restoreSession(userId) {
  if (!vault.isUnlocked() || vault.getUserId() !== userId) {
    return null;
  }

  let session;
  try {
    session = await loadSession(userId);
  } catch (e) {
    console.warn('[matrix] could not load session:', e);
    return null;
  }
  if (!session) return null;

  const { baseUrl, accessToken, userId: sid, deviceId } = session;

  client = sdk.createClient({
    baseUrl,
    accessToken,
    userId: sid,
    deviceId,
    cryptoCallbacks: { getSecretStorageKey },
  });
  progress('Restoring session…');
  try {
    await initCryptoWithRetry(client);
  } catch (e) {
    progress(`Crypto init failed (continuing offline): ${e.message}`);
  }

  try {
    await client.startClient({ initialSyncLimit: 100 });
    if (_watchSyncUnsub) _watchSyncUnsub();
    _watchSyncUnsub = watchSync(client);
    // Best-effort wait for sync — short timeout so offline boots fast.
    try { await waitForSync(client, 12000); }
    catch (e) { progress(`Sync deferred (${e.message}); local data available`); }
  } catch (e) {
    progress(`Sync start failed (continuing offline): ${e.message}`);
  }

  try {
    await ensureEncryptionSetUp({ userMxid: sid, password: null });
  } catch (e) {
    progress(`Encryption restore failed: ${e.message}`);
  }

  return client;
}

/**
 * Offline-capable unlock: derive the vault key from the password and
 * (if we have a saved session) bring up the client without requiring
 * network. Returns { userId, online } where online indicates whether
 * sync reached a ready state.
 */
export async function unlock(userId, password) {
  const ok = await vault.unlock(userId, password);
  if (!ok) throw new Error('Invalid password');
  rememberLastUser(userId);
  const c = await restoreSession(userId);
  if (!c) return { userId, online: false };
  const state = c.getSyncState && c.getSyncState();
  return { userId, online: state === 'PREPARED' || state === 'SYNCING' };
}

/**
 * Lock the device: clear the in-memory key + stop the client, but
 * keep the encrypted session token, OPFS data, and outbox on disk.
 * The user can re-enter their password to resume.
 */
export async function lock() {
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    client = null;
  }
  vault.lock();
}

/**
 * Full logout: server-side logout, wipe encrypted session, wipe vault
 * metadata, wipe OPFS room data, wipe outbox, drop the crypto store.
 * Everything on disk for this user is gone after this resolves.
 */
export async function logout() {
  const uid = vault.getUserId();
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    try { await client.logout(true); } catch {}
    client = null;
  }
  if (uid) {
    dropSession(uid);
    vault.wipe(uid);
  }
  try { await wipeAllRoomData(); } catch {}
  try { await clearOutbox(); } catch {}
  try { await clearCryptoStore(); } catch {}
  forgetLastUser();
}

/**
 * Does the local device have a saved session + vault for this user?
 * Used to decide between login form and unlock form on boot.
 */
export function hasLocalAccount(userId) {
  return !!localStorage.getItem(sessionKey(userId)) && vault.hasMeta(userId);
}
