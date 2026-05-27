/**
 * client.js — Matrix connection layer
 *
 * Wraps matrix-js-sdk: login, session persistence, sync, crypto init.
 *
 * Four entry points:
 *   - login(hs, user, password)         : first time on this device
 *   - unlock(userId, password)          : subsequent launches; works offline
 *   - restoreSession(userId)            : restart sync from a saved blob
 *   - tryAutoRestore()                  : cold-boot path, no password
 *
 * The Matrix access token + device_id live in IndexedDB encrypted with a
 * non-extractable AES-GCM key (see ./pickleKey.js). Cold reloads restore
 * the session silently — the user's vault password is no longer required
 * just to bring up the client. The vault still encrypts OPFS / outbox at
 * rest; unlocking it enables saves and decrypts cached events.
 */

import * as sdk from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { vault, sessionKey, rememberLastUser, forgetLastUser, getLastUser } from './vault.js';
import { wipeAllRoomData } from './store.js';
import { clearAll as clearOutbox } from './outbox.js';
import { watchSync } from './network.js';
import { wipeMediaCache } from './media.js';
import { wipeManifest } from './roomManifest.js';
import {
  storeSessionEncrypted, loadSessionEncrypted, dropSessionEncrypted,
  hasStoredSession as hasIdbSession, wipePickleKey,
} from './pickleKey.js';

let client = null;
let _watchSyncUnsub = null;

// ── Encryption status (consumed by the UI banner) ──
// 'unknown'   — not yet checked
// 'ok'        — cross-signing ready, key backup attached
// 'verifying' — bootstrap / restore in progress
// 'history-locked' — backup exists on server but we couldn't restore it
//                    (user needs to enter recovery key)
// 'no-backup' — account has no key backup yet (first-ever login)
let _encryptionStatus = 'unknown';
const _encryptionListeners = new Set();
export function getEncryptionStatus() { return _encryptionStatus; }
export function onEncryptionStatus(fn) {
  _encryptionListeners.add(fn);
  return () => _encryptionListeners.delete(fn);
}
function setEncryptionStatus(s) {
  if (_encryptionStatus === s) return;
  _encryptionStatus = s;
  for (const fn of _encryptionListeners) {
    try { fn(s); } catch (e) { console.warn('[matrix] encryption listener failed:', e); }
  }
}

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
    // Any failure here — known mismatch, corrupted indexed DB, or partial
    // wipe from a previous session — recovers the same way: drop the
    // crypto store and let the SDK rebuild it from the server. Without
    // this fallback, users hit "wipe local data to log in" loops.
    progress('Crypto init failed — clearing crypto store and retrying: ' + err.message);
    try { await clearCryptoStore(); } catch {}
    await withTimeout(c.initRustCrypto(), timeoutMs, 'Crypto init (retry)');
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

  setEncryptionStatus('verifying');

  if (await crypto.isCrossSigningReady()) {
    try { await crypto.checkKeyBackupAndEnable(); } catch (e) {
      progress(`Key backup check failed: ${e.message}`);
    }
    setEncryptionStatus('ok');
    return;
  }

  const accountHasCrossSigning = await crypto.userHasCrossSigningKeys(userMxid, true);

  if (accountHasCrossSigning) {
    progress('Restoring encryption keys from recovery…');
    let backupRestored = false;
    try {
      await crypto.bootstrapCrossSigning({});
      try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      } catch (e) {
        progress(`Could not load backup key: ${e.message}`);
        throw new Error('history-locked');
      }
      try {
        await crypto.restoreKeyBackup();
        backupRestored = true;
      } catch (e) {
        progress(`Key backup restore failed: ${e.message}`);
        throw new Error('history-locked');
      }
      try { await crypto.checkKeyBackupAndEnable(); } catch {}
    } catch (e) {
      if (e.message === 'history-locked') {
        setEncryptionStatus('history-locked');
        return;
      }
      throw e;
    }
    setEncryptionStatus(backupRestored ? 'ok' : 'history-locked');
    return;
  }

  if (!password) {
    progress('Skipping encryption setup: no password available (login again to enable history backup)');
    setEncryptionStatus('no-backup');
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

  setEncryptionStatus('ok');
}

export async function retryKeyBackupRestore() {
  if (!client) throw new Error('Not signed in');
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Crypto not initialized');
  setEncryptionStatus('verifying');
  try {
    await crypto.bootstrapCrossSigning({});
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    await crypto.restoreKeyBackup();
    try { await crypto.checkKeyBackupAndEnable(); } catch {}
    setEncryptionStatus('ok');
    return true;
  } catch (e) {
    setEncryptionStatus('history-locked');
    throw e;
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

// ── Session storage ──
//
// The Matrix access token + device_id lives in IndexedDB encrypted with a
// non-extractable AES-GCM CryptoKey (the "pickle key"). The key itself is
// stored as a CryptoKey object in IndexedDB and is generated with
// `extractable: false`, so it cannot be read out of the browser even by
// origin-attached scripts — only used to encrypt/decrypt via the WebCrypto
// API. This mirrors Element Web's pickleKey design and lets cold reloads
// auto-restore the session without requiring the user's Matrix password.
//
// Legacy: earlier versions stored a vault-encrypted blob in localStorage
// under `mx_session_enc:{userId}`. We still drop that key on logout, but
// new sessions go only into IndexedDB.

async function persistSession(userId, session) {
  await storeSessionEncrypted(userId, session);
}

async function loadSession(userId) {
  return loadSessionEncrypted(userId);
}

async function dropSession(userId) {
  // Drop both the IndexedDB-stored session and the legacy localStorage
  // blob, so a re-login on a device that had pre-pickle-key data starts
  // clean.
  try { localStorage.removeItem(sessionKey(userId)); } catch {}
  await dropSessionEncrypted(userId);
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
  // Note: the vault encrypts OPFS/outbox data at rest. The session token
  // itself goes into the IndexedDB pickle-key store (see persistSession),
  // so cold-reload auto-restore does NOT require the vault to unlock.
  if (!vault.hasMeta(resp.user_id)) {
    progress('Initializing local vault…');
    await vault.initialize(resp.user_id, password);
  } else if (!vault.isUnlocked() || vault.getUserId() !== resp.user_id) {
    progress('Unlocking local vault…');
    const ok = await vault.unlock(resp.user_id, password);
    if (!ok) {
      // The Matrix homeserver accepted this password (`tmp.login` above
      // succeeded), but the local vault was bootstrapped with a different
      // one — the user rotated their password on another device, or the
      // local data was written by a previous account with a coincidentally
      // matching username. Either way: do NOT silently nuke OPFS / outbox.
      // Throw so the caller can surface "your local cache is locked,
      // either enter the original password or explicitly reset" instead
      // of destroying the user's data.
      throw new Error(
        'Local cache password does not match this Matrix password. ' +
        'Sign out from the menu to clear local data, then sign in again.'
      );
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
  await client.startClient({ initialSyncLimit: 1000 });
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
  // The session blob is encrypted with the IndexedDB pickle key — vault
  // does NOT need to be unlocked to restore. (Vault unlock is still
  // required to read cached OPFS data; without it the SDK will repopulate
  // rooms from a fresh /sync.)
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

  let sessionExpired = false;
  try {
    await client.startClient({ initialSyncLimit: 1000 });
    if (_watchSyncUnsub) _watchSyncUnsub();
    _watchSyncUnsub = watchSync(client);
    // Best-effort wait for sync. 30s tolerates slow homeservers and big
    // initial syncs; if the server is actually unreachable, getSyncState()
    // settles on ERROR sooner and we drop straight into local-only mode.
    try { await waitForSync(client, 30000); }
    catch (e) {
      if (/Session expired/i.test(e.message)) sessionExpired = true;
      progress(`Sync deferred (${e.message}); local data available`);
    }
  } catch (e) {
    progress(`Sync start failed (continuing offline): ${e.message}`);
  }

  if (sessionExpired) {
    // The homeserver rejected the saved access token. Drop the blob
    // (it's dead bytes) but leave the vault, manifest, and OPFS data
    // intact — caller can either mint a fresh token via mxLogin or
    // fall back to local-only mode if the network is unreachable.
    try { client.stopClient(); } catch {}
    if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
    client = null;
    await dropSession(userId);
    progress('Saved session was rejected by the server — log in again to refresh credentials.');
    return null;
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

  // No session in either store → vault is unlocked but we have no Matrix
  // token. Caller must try a fresh online login (and may fall back to
  // local-only mode if the homeserver is unreachable).
  const haveSession = (await hasIdbSession(userId)) ||
                      !!localStorage.getItem(sessionKey(userId));
  if (!haveSession) {
    return { userId, online: false, needsLogin: true };
  }

  // If a client is already running (auto-restored at cold boot before
  // the user typed their password), no need to restart it — just confirm
  // online state.
  if (client) {
    const state = client.getSyncState && client.getSyncState();
    return { userId, online: state === 'PREPARED' || state === 'SYNCING', needsLogin: false };
  }

  const c = await restoreSession(userId);
  if (!c) {
    // restoreSession either failed or dropped a rejected token — vault
    // is still unlocked, so local data is accessible, but the caller
    // needs to refresh credentials to talk to the server again.
    return { userId, online: false, needsLogin: true };
  }
  const state = c.getSyncState && c.getSyncState();
  return { userId, online: state === 'PREPARED' || state === 'SYNCING', needsLogin: false };
}

/**
 * Cold-boot auto-restore: attempt to bring up the Matrix client for the
 * last-known user using the IndexedDB pickle key, WITHOUT requiring the
 * vault password. Returns the active session info or null.
 *
 * Vault remains locked, which means OPFS-cached events are unreadable
 * until the user enters their password — but the SDK will rehydrate
 * from a fresh /sync, so the user sees their rooms regardless. Writes
 * to the outbox still require a vault unlock (the outbox encrypts each
 * record with the vault key).
 */
export async function tryAutoRestore() {
  const uid = getLastUser();
  if (!uid) return null;
  if (!(await hasIdbSession(uid))) return null;
  const c = await restoreSession(uid);
  if (!c) return null;
  return { userId: uid, client: c };
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
  // Capture the user id BEFORE wiping the vault; we need it to clean up
  // per-user blobs even when the vault is currently locked (cold-reload
  // auto-restore case).
  const uid = vault.getUserId() || getLastUser();
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    try { await client.logout(true); } catch {}
    client = null;
  }
  if (uid) {
    await dropSession(uid);
    wipeManifest(uid);
    vault.wipe(uid);
    try { await wipePickleKey(uid); } catch {}
  }
  try { await wipeAllRoomData(); } catch {}
  try { await wipeMediaCache(); } catch {}
  try { await clearOutbox(); } catch {}
  try { await clearCryptoStore(); } catch {}
  setEncryptionStatus('unknown');
  forgetLastUser();
}

/**
 * Does the local device have a vault for this user? If true, the
 * Matrix password can unlock local data even when the homeserver is
 * unreachable or the saved token has been revoked. The session blob
 * may or may not still be present; that's the bridge's problem to
 * sort out.
 */
export function hasLocalAccount(userId) {
  return vault.hasMeta(userId);
}

/** Does the user have a usable saved access token (legacy localStorage)? */
export function hasSavedSession(userId) {
  return !!localStorage.getItem(sessionKey(userId));
}

/** Does the user have a saved access token in the new IDB pickle store? */
export async function hasSavedSessionAsync(userId) {
  if (await hasIdbSession(userId)) return true;
  return !!localStorage.getItem(sessionKey(userId));
}
