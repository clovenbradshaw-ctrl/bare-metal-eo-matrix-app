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

// Must run before matrix-js-sdk opens its IDB store, so it sees the
// scoped names instead of the global `matrix-js-sdk::*` ones.
import './idbScope.js';
import * as sdk from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/key-passphrase.js';
import { vault, sessionKey, rememberLastUser, forgetLastUser, getLastUser,
         storeSecret, loadSecret } from './vault.js';
import { wipeAllRoomData } from './store.js';
import { clearAll as clearOutbox } from './outbox.js';
import { watchSync } from './network.js';
import { wipeMediaCache } from './media.js';
import { wipeManifest } from './roomManifest.js';

let client = null;
let _watchSyncUnsub = null;

// matrix-js-sdk logs at DEBUG by default, which floods the console with every
// HTTP request, perf mark, and crypto trace. We don't want any of that. Pass
// this quiet logger to createClient: it drops trace/debug/info, forwards
// real warnings/errors, and filters a couple of known-benign warnings the SDK
// emits constantly for rooms whose `m.room.create` event isn't loaded under
// our minimal sync (`[getVersion]` / `[getType]` "does not have an
// m.room.create event"). Children (getChild) stay quiet too.
const QUIET_PATTERNS = [
  'does not have an m.room.create event',
  'No membership changes detected',
  'Adding default global',            // push-rule setup noise on every login
  'GroupCallEventHandler',            // call subsystem we disable anyway
];
function makeQuietLogger() {
  const noop = () => {};
  const passes = (msg) => {
    const first = typeof msg[0] === 'string' ? msg[0] : '';
    return !QUIET_PATTERNS.some((p) => first.includes(p));
  };
  const self = {
    trace: noop, debug: noop, info: noop, log: noop,
    warn: (...m) => { if (passes(m)) console.warn(...m); },
    error: (...m) => { if (passes(m)) console.error(...m); },
    getChild: () => self,
  };
  return self;
}
const QUIET_LOGGER = makeQuietLogger();

// Sync options tuned for a small idle footprint. matrix-js-sdk's default
// MemoryStore holds the user's *entire* Matrix account in RAM — every joined
// room's state, and for E2EE the device list of every member of every
// encrypted room. For an account in large/public rooms that is the bulk of
// the tab's memory, and it sits there even when the app shows nothing.
//
//   - lazyLoadMembers: don't pull or track member lists during sync; load
//     them on demand (only when a member list is actually opened). This is
//     the single biggest reduction for member-heavy accounts. Encryption
//     still works — the crypto layer loads targets before sending.
//   - initialSyncLimit 1: this app reads history from its own OPFS store and
//     paginates the tail on demand, so the SDK never needs to hold a per-room
//     timeline. Keep the initial burst to the minimum across all rooms.
//   - disablePresence: we never render presence; skip processing it.
const SYNC_OPTS = {
  initialSyncLimit: 1,
  lazyLoadMembers: true,
  disablePresence: true,
};

// matrix-js-sdk spins up TWO call subsystems for *every room in the account*
// and re-scans them on every sync — the newer MatrixRTCSession manager and the
// older GroupCallEventHandler. Both are pure overhead for a data app with no
// calls (the "[MatrixRTCSession … No membership changes detected]" /
// "GroupCallEventHandler start()" spam). Tear both down right after
// startClient. Safe: nothing in this app touches calls.
function disableMatrixRTC(c) {
  try { c.matrixRTC?.stop?.(); } catch (e) { progress(`RTC disable skipped: ${e.message}`); }
  try { c.groupCallEventHandler?.stop?.(); } catch (e) { progress(`GroupCall disable skipped: ${e.message}`); }
}

let progress = (msg) => console.log('[matrix]', msg);
export function setProgress(fn) {
  progress = (msg) => { console.log('[matrix]', msg); fn(msg); };
}

let recoveryKeyProvider = null;
let recoveryKeyDisplayer = null;
export function setRecoveryKeyProvider(fn) { recoveryKeyProvider = fn; }
export function setRecoveryKeyDisplayer(fn) { recoveryKeyDisplayer = fn; }

// In-memory password cache, alive only for the span of a login()/unlock()
// flow. Used by `getSecretStorageKey` to derive the SSSS key from the
// account's stored passphrase parameters without prompting the user.
// Cleared as soon as the secure-backup setup finishes, and on lock/logout.
let _currentPassword = null;
const VAULT_SECRET_SSSS_KEY = 'ssss_private_key_b64';
const VAULT_SECRET_RECOVERY_KEY = 'recovery_key_encoded';

export function getClient() { return client; }

const CRYPTO_STORE_NAME = 'matrix-js-sdk::matrix-sdk-crypto';
const CRYPTO_OWNER_KEY = 'eomx:crypto-owner';

function clearCryptoStore() {
  return new Promise((resolve) => {
    progress('Clearing stale crypto store…');
    const req = indexedDB.deleteDatabase(CRYPTO_STORE_NAME);
    let blockedTimer = null;
    const settle = () => {
      if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
      resolve();
    };
    req.onsuccess = () => { progress('Crypto store cleared'); settle(); };
    req.onerror = () => {
      progress('Crypto store clear failed: ' + (req.error?.message || 'unknown'));
      settle();
    };
    // onblocked means another connection is still open. Don't resolve
    // synchronously — that would race the caller's next initRustCrypto
    // against an in-flight delete and produce confusing failures. Wait
    // briefly for the lingering connection to close, then give up.
    req.onblocked = () => {
      progress('Crypto store delete blocked — waiting for connections to close');
      blockedTimer = setTimeout(() => {
        progress('Crypto store delete still blocked — proceeding anyway');
        settle();
      }, 3000);
    };
  });
}

/**
 * Safari/WebKit cold-start IndexedDB workaround.
 *
 * On a fresh page load WebKit can leave its IndexedDB subsystem asleep: the
 * *first* `indexedDB.open()` after load sometimes fires neither `onsuccess`
 * nor `onerror`, hanging forever (long-standing WebKit cold-start bug). The
 * SDK opens its Rust-crypto store over IndexedDB during initRustCrypto, so the
 * stall surfaces as "login never resolves on first load, but a refresh logs
 * straight in" — on the reload IDB is already warm. The same stalled init is
 * why the session/crypto never become ready and data views show 0 records.
 *
 * Poke IDB with a throwaway open before the SDK touches it. If a poke doesn't
 * answer within a short window, re-issue it — re-opening is what actually
 * shakes the subsystem awake — up to a bounded budget, then proceed regardless
 * so bootstrap is never blocked for more than the budget. A no-op on engines
 * that answer the first poke immediately (Chrome/Firefox).
 */
function warmUpIndexedDB({ tries = 12, intervalMs = 250 } = {}) {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let attempt = 0;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const poke = () => {
      if (settled) return;
      attempt++;
      let req;
      try { req = indexedDB.open('__eomx_idb_warmup__'); }
      catch { finish(); return; }
      req.onsuccess = () => { try { req.result.close(); } catch {} finish(); };
      req.onerror = () => finish();
      req.onblocked = () => finish();
      // No response within the window — the cold-start stall. Re-poke until
      // the subsystem wakes or the budget (tries × intervalMs) is spent.
      timer = setTimeout(() => {
        if (settled) return;
        if (attempt >= tries) { finish(); return; }
        poke();
      }, intervalMs);
    };
    poke();
  });
}

/**
 * Pre-empt the "account in the store doesn't match" failure by wiping
 * the crypto store before init when we know it belongs to a different
 * user. Avoids hitting the exception-based retry path inside
 * initCryptoWithRetry, which has worse timing characteristics.
 */
async function ensureCryptoStoreOwner(userId) {
  // Wake IndexedDB before any crypto-store access (delete below or the SDK's
  // own open in initRustCrypto). On Safari the first cold open can hang, which
  // is what stalls login until a manual refresh — see warmUpIndexedDB.
  await warmUpIndexedDB();
  const prior = localStorage.getItem(CRYPTO_OWNER_KEY);
  if (prior && prior !== userId) {
    progress(`Crypto store belonged to ${prior}; resetting for ${userId}`);
    await clearCryptoStore();
  }
  localStorage.setItem(CRYPTO_OWNER_KEY, userId);
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

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function getSecretStorageKey({ keys }) {
  const keyId = Object.keys(keys)[0];
  if (!keyId) return null;
  const keyInfo = keys[keyId];
  const uid = vault.getUserId();

  // Fast path: a previous successful login stashed the raw SSSS key in
  // the vault. Use it directly so the user never sees a prompt.
  if (uid) {
    const stashed = await loadSecret(uid, VAULT_SECRET_SSSS_KEY);
    if (stashed) {
      try { return [keyId, b64ToBytes(stashed)]; }
      catch { /* fall through */ }
    }
  }

  // Password-derived path: account_data carries the PBKDF2 salt+iterations
  // for the SSSS key. If the user's Matrix password is currently in scope
  // (login or unlock flow), derive the key transparently and cache it.
  if (_currentPassword && keyInfo?.passphrase?.algorithm === 'm.pbkdf2'
      && keyInfo.passphrase.salt && keyInfo.passphrase.iterations) {
    try {
      const privateKey = await deriveRecoveryKeyFromPassphrase(
        _currentPassword,
        keyInfo.passphrase.salt,
        keyInfo.passphrase.iterations,
      );
      if (uid) {
        try { await storeSecret(uid, VAULT_SECRET_SSSS_KEY, bytesToB64(privateKey)); }
        catch { /* non-fatal */ }
      }
      return [keyId, privateKey];
    } catch (e) {
      progress(`Passphrase-derived secret-storage key failed: ${e.message}`);
    }
  }

  // Last resort: ask the user for their encoded recovery key.
  if (!recoveryKeyProvider) {
    progress('Recovery key required but no UI provider registered');
    return null;
  }
  const encoded = await recoveryKeyProvider();
  if (!encoded) return null;

  try {
    const privateKey = decodeRecoveryKey(encoded.trim());
    if (uid) {
      try { await storeSecret(uid, VAULT_SECRET_SSSS_KEY, bytesToB64(privateKey)); }
      catch { /* non-fatal */ }
    }
    return [keyId, privateKey];
  } catch (e) {
    progress(`Recovery key invalid: ${e.message}`);
    return null;
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

// ── Secure backup (cross-signing + SSSS + key backup) ──

/**
 * Idempotent setup of cross-signing, secret storage, and key backup.
 *
 * Three scenarios converge into one call:
 *   - Fresh account: creates cross-signing keys, creates SSSS with a
 *     passphrase = the user's Matrix password, creates a new key backup
 *     version, stashes the encoded recovery key in the local vault.
 *   - Returning device, vault intact: a fast no-op; just makes sure
 *     this device is cross-signed and the backup engine is running.
 *   - Post-wipe re-login: SSSS exists on the server but the local
 *     crypto store is fresh. The password derives the SSSS key (via
 *     the server-stored PBKDF2 parameters); the SDK pulls cross-signing
 *     and backup secrets out of SSSS; we restore the Megolm key backup
 *     so historical messages decrypt; this device gets cross-signed.
 *
 * The password is held in module state for the duration of this call
 * because `getSecretStorageKey` may fire multiple times during bootstrap.
 *
 * Failures are non-fatal — the user can still send and read live messages.
 */
async function ensureSecureBackup(password, userId) {
  if (!client) return;
  const crypto = client.getCrypto?.();
  if (!crypto) return;

  _currentPassword = password;
  try {
    const ssssOnServer = await client.secretStorage.hasKey();

    progress(ssssOnServer ? 'Linking secure backup…' : 'Initializing secure backup…');

    // Bootstrap cross-signing. If keys already exist on the server, this
    // pulls them out of SSSS into the local store (via getSecretStorageKey).
    // If they don't, it creates and uploads them; UIA below replays the
    // Matrix password we already have.
    //
    // CRITICAL: this is isolated in its own try/catch. Some homeservers
    // (e.g. hyphae.social) gate /keys/device_signing/upload behind an
    // interactive-auth flow we can't always satisfy, and importing
    // cross-signing keys on a fresh device can warn "No public identity
    // found" until the self device-list has synced. None of that must
    // abort the key-backup restore below — historical messages decrypt
    // from the server backup via the cached decryption key, which is
    // independent of cross-signing trust. Previously a throw here skipped
    // restore + enable entirely, leaving every old event undecryptable
    // with "key backup is not working" (HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED).
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => {
          const user = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
          await makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user },
            password,
            // Some homeservers require user/password at the top level too.
            user,
          });
        },
      });
    } catch (e) {
      progress(`Cross-signing setup skipped (continuing to key backup): ${e.message}`);
    }

    let generatedKey = null;
    try {
      await crypto.bootstrapSecretStorage({
        setupNewKeyBackup: !ssssOnServer,
        createSecretStorageKey: ssssOnServer ? undefined : async () => {
          generatedKey = await crypto.createRecoveryKeyFromPassphrase(password);
          return generatedKey;
        },
      });
    } catch (e) {
      progress(`Secret storage setup skipped (continuing to key backup): ${e.message}`);
    }

    if (generatedKey?.encodedPrivateKey) {
      // Stash the key in the local vault so users can view it later from
      // a settings screen if they want a copy outside the browser. We
      // deliberately do NOT surface it on first login — the user's Matrix
      // password derives the same SSSS key on demand, so the recovery key
      // is a belt-and-suspenders backup, not a thing every user has to
      // memorise during onboarding.
      try {
        await storeSecret(userId, VAULT_SECRET_RECOVERY_KEY, generatedKey.encodedPrivateKey);
        if (generatedKey.privateKey) {
          await storeSecret(userId, VAULT_SECRET_SSSS_KEY, bytesToB64(generatedKey.privateKey));
        }
      } catch (e) {
        progress(`Could not stash recovery key locally: ${e.message}`);
      }
    }

    // ── Key backup: the actual wipe-resilience path ──
    //
    // This block is what makes a browser wipe non-destructive, so it runs
    // independently of whether cross-signing succeeded above. The steps
    // must happen in order:
    //
    //   1. Load the backup decryption key from SSSS into the crypto store.
    //      This makes the server backup "trusted by key" (matchesDecryptionKey)
    //      even when cross-signing trust isn't established, and it's a
    //      prerequisite for both the bulk restore and the per-session
    //      on-demand key downloader.
    //   2. checkKeyBackupAndEnable() — enable the backup engine. This sets
    //      the active backup version, which CONFIGURES the per-session key
    //      downloader. Without this, individual undecryptable events can't
    //      pull their key on demand and surface as "key backup is not working".
    //   3. restoreKeyBackup() — bulk-pull historical Megolm keys so the whole
    //      visible history decrypts at once rather than trickling in per event.

    // Step 1: cache the backup decryption key. On first login the key was
    // just created and cached by bootstrapSecretStorage; on the post-wipe
    // path we load it back out of SSSS (the password derived the SSSS key).
    if (ssssOnServer) {
      try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      } catch (e) {
        progress(`Loading session backup key: ${e.message}`);
      }
    }

    // Step 2: enable the backup engine BEFORE restoring. checkKeyBackupAndEnable
    // forces a fresh trust re-check (now that the decryption key is cached) and,
    // when the backup is usable, starts the engine and configures the
    // per-session downloader. Verify it actually came up.
    let activeBackupVersion = null;
    try {
      await crypto.checkKeyBackupAndEnable();
      activeBackupVersion = await crypto.getActiveSessionBackupVersion();
    } catch (e) {
      progress(`Enabling key backup: ${e.message}`);
    }

    // Step 3: bulk-restore historical Megolm keys so old encrypted rooms
    // decrypt. Cheap if the backup is empty; potentially long if the user
    // has years of history. Don't fail login if it stumbles partway through.
    if (activeBackupVersion) {
      try {
        await crypto.restoreKeyBackup();
        progress('Historical message keys restored');
      } catch (e) {
        progress(`Key backup restore: ${e.message}`);
      }
    } else {
      // No active backup after setup. Either the server has no backup, or
      // the decryption key couldn't be loaded — surface it so a wipe that
      // *should* have recovered but didn't is visible rather than silent.
      const backupInfo = await crypto.getKeyBackupInfo().catch(() => null);
      if (backupInfo?.version) {
        progress('Key backup present on server but could not be enabled — historical messages may stay locked. Re-enter your recovery key from settings to restore.');
      } else {
        progress('No key backup on server yet — history from before this device will not be recoverable.');
      }
    }

    // Sign this device with the master cross-signing key so other devices
    // trust it. Idempotent if the device is already signed. Best effort —
    // failure here doesn't affect local decryption.
    try {
      const deviceId = client.getDeviceId();
      if (deviceId) await crypto.crossSignDevice(deviceId);
    } catch (e) {
      progress(`Cross-signing this device: ${e.message}`);
    }
  } catch (e) {
    progress(`Secure backup setup failed (continuing): ${e.message}`);
  } finally {
    _currentPassword = null;
  }
}

/** Read the local copy of the user's encoded recovery key, if any. */
export async function getStashedRecoveryKey(userId) {
  if (!userId) userId = vault.getUserId();
  if (!userId) return null;
  return loadSecret(userId, VAULT_SECRET_RECOVERY_KEY);
}

/**
 * Inspect every link in the wipe-recovery chain and return a plain
 * object describing it. Run from the console as
 * `await window.MatrixLive.diagnoseBackup()` when historical messages
 * won't decrypt after a wipe.
 *
 * The decisive field is `serverBackupCount`: if it is 0 (or null) the
 * server-side backup is empty, so the keys for old messages were never
 * uploaded by a previous device and the history is genuinely
 * unrecoverable — no client-side fix can bring it back. A non-zero count
 * with `activeBackupVersion: null` instead points at a local
 * trust/enable problem, which `restoreFromRecoveryKey()` can repair.
 */
export async function diagnoseBackup() {
  const out = { ok: false };
  if (!client) { out.error = 'No Matrix client (not logged in)'; return out; }
  const crypto = client.getCrypto?.();
  if (!crypto) { out.error = 'Crypto not initialized'; return out; }
  try {
    out.userId = client.getUserId();
    out.deviceId = client.getDeviceId();
    out.ssssOnServer = await client.secretStorage.hasKey();
    out.hasStashedSsssKey = !!(out.userId && await loadSecret(out.userId, VAULT_SECRET_SSSS_KEY));

    let info = null;
    try { info = await crypto.getKeyBackupInfo(); }
    catch (e) { out.getKeyBackupInfoError = e.message; }
    out.serverBackupVersion = info?.version || null;
    out.serverBackupAlgorithm = info?.algorithm || null;
    out.serverBackupCount = typeof info?.count === 'number' ? info.count : null;

    out.activeBackupVersion = await crypto.getActiveSessionBackupVersion();

    if (info) {
      try {
        const trust = await crypto.isKeyBackupTrusted(info);
        out.backupTrusted = trust.trusted;
        out.backupMatchesDecryptionKey = trust.matchesDecryptionKey;
      } catch (e) { out.trustError = e.message; }
    }

    try { out.crossSigningReady = await crypto.isCrossSigningReady(); }
    catch (e) { out.crossSigningError = e.message; }

    out.ok = !!(out.activeBackupVersion
      && (out.backupMatchesDecryptionKey || out.backupTrusted));

    if (!out.serverBackupVersion) {
      out.diagnosis = 'No key backup on the server — history from before this device is unrecoverable.';
    } else if (!out.serverBackupCount) {
      out.diagnosis = 'Backup exists but contains 0 keys — previous devices never uploaded them; history is unrecoverable.';
    } else if (out.ok) {
      out.diagnosis = 'Backup is active and trusted; historical keys should be restorable.';
    } else {
      out.diagnosis = 'Backup has keys but is not enabled locally — try restoreFromRecoveryKey(<your recovery key>).';
    }
  } catch (e) {
    out.error = e.message;
  }
  progress(`Backup diagnosis: ${out.diagnosis || out.error}`);
  return out;
}

/**
 * Manually restore the Megolm key backup using the user's encoded
 * recovery key (the "EsT…"/base58 string the app generated at first
 * login). This is the escape hatch when the automatic, password-derived
 * recovery doesn't kick in.
 *
 * The app's recovery key IS the secret-storage (4S) key, so we stash it
 * as the SSSS key, pull the backup decryption key out of secret storage,
 * enable the backup engine, and bulk-restore. Returns the SDK's
 * KeyBackupRestoreResult ({ total, imported }).
 */
export async function restoreFromRecoveryKey(encodedRecoveryKey) {
  if (!client) throw new Error('No Matrix client (not logged in)');
  const crypto = client.getCrypto?.();
  if (!crypto) throw new Error('Crypto not initialized');
  if (!encodedRecoveryKey || !encodedRecoveryKey.trim()) {
    throw new Error('A recovery key is required');
  }

  const info = await crypto.getKeyBackupInfo();
  if (!info?.version) throw new Error('No key backup on the server to restore from');

  // Decode the recovery key to the raw SSSS private key and stash it so
  // getSecretStorageKey serves it without a prompt.
  const ssssKey = decodeRecoveryKey(encodedRecoveryKey.trim());
  const uid = vault.getUserId() || client.getUserId();
  if (uid) {
    try { await storeSecret(uid, VAULT_SECRET_SSSS_KEY, bytesToB64(ssssKey)); }
    catch { /* non-fatal; the load below will fall back to the live key */ }
  }

  // Pull the Megolm backup decryption key out of secret storage, enable
  // the backup engine (configures the per-session downloader), then
  // bulk-restore. Throws DecryptionKeyDoesNotMatchError if the key is wrong.
  await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  await crypto.checkKeyBackupAndEnable();
  const result = await crypto.restoreKeyBackup();
  progress(`Restored ${result?.imported ?? '?'}/${result?.total ?? '?'} keys from backup`);
  return result;
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

export async function login(homeserver, username, password, { persist = false } = {}) {
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
    await vault.initialize(resp.user_id, password, { persist });
  } else if (!vault.isUnlocked() || vault.getUserId() !== resp.user_id) {
    progress('Unlocking local vault…');
    const ok = await vault.unlock(resp.user_id, password, { persist });
    if (!ok) {
      // Password changed on the server; the old key can't decrypt this
      // user's local data anymore. Reset the vault so the new password
      // becomes the unlock. The OPFS room files and outbox entries are
      // left in place — they're dead bytes (unreadable without the old
      // key) but other users' files on this device stay intact.
      progress('Vault password mismatch — rotating to current password (prior local data is no longer readable)');
      vault.wipe(resp.user_id);
      wipeManifest(resp.user_id);
      await vault.initialize(resp.user_id, password, { persist });
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
    logger: QUIET_LOGGER,
  });

  await ensureCryptoStoreOwner(resp.user_id);
  progress('Initializing encryption…');
  await initCryptoWithRetry(client);

  progress('Starting sync…');
  await client.startClient(SYNC_OPTS);
  disableMatrixRTC(client);
  if (_watchSyncUnsub) _watchSyncUnsub();
  _watchSyncUnsub = watchSync(client);
  await waitForSync(client);
  progress('Sync ready');

  await ensureSecureBackup(password, resp.user_id);

  return { client, userId: resp.user_id, deviceId: resp.device_id };
}

// ── Password reset & change ──────────────────────────────────────────────
//
// Two distinct flows live here:
//
//   1. Reset-when-locked-out (login screen "forgot password"): the user is
//      NOT signed in, so we talk to the homeserver with a throwaway client
//      and no access token. The homeserver emails a verification link; once
//      the user clicks it, the validated email 3PID is the UI-auth that
//      authorizes the new password. This only works if the account has a
//      verified email and the homeserver has email support configured.
//
//   2. Change-while-signed-in (account dashboard): the live client re-auths
//      with the current password (m.login.password UI-auth) to set a new one.
//
// matrix-js-sdk's setPassword() doesn't drive User-Interactive Auth on its
// own — a homeserver may answer the first POST with a 401 carrying a UIA
// `session` id that must be threaded back into the auth dict. uiaSetPassword
// handles that one retry for both flows.

function friendlyMatrixError(e, fallback) {
  const code = e?.errcode || e?.data?.errcode;
  switch (code) {
    case 'M_THREEPID_NOT_FOUND':
      return new Error('No account has that email address on this homeserver.');
    case 'M_THREEPID_DENIED':
      return new Error('This homeserver does not allow password reset by email.');
    case 'M_THREEPID_AUTH_FAILED':
      return new Error("Email not verified yet — open the link the homeserver emailed you, then try again.");
    case 'M_UNAUTHORIZED':
      return new Error('Current password is incorrect.');
    case 'M_FORBIDDEN':
      return new Error('Current password is incorrect.');
    case 'M_WEAK_PASSWORD':
      return new Error(e?.data?.error || 'That password is too weak for this homeserver.');
    case 'M_EXCLUSIVE':
      return new Error('Password reset is not available for this account.');
    default:
      return new Error(e?.data?.error || e?.message || fallback);
  }
}

async function uiaSetPassword(c, authStage, newPassword, logoutDevices) {
  try {
    return await withTimeout(c.setPassword(authStage, newPassword, logoutDevices), 30000, 'Set password');
  } catch (e) {
    // Homeserver wants the UIA session id threaded back into the auth dict.
    if (e?.httpStatus === 401 && e?.data?.session) {
      return await withTimeout(
        c.setPassword({ ...authStage, session: e.data.session }, newPassword, logoutDevices),
        30000,
        'Set password'
      );
    }
    throw e;
  }
}

/**
 * Step 1 of an email-based password reset (used from the login screen when
 * the user is locked out). Asks the homeserver to email a verification link
 * to `email`. Returns an opaque `creds` object the caller holds and passes
 * back to completePasswordReset() once the user has clicked that link.
 */
export async function requestPasswordReset(homeserver, email) {
  const addr = String(email || '').trim();
  if (!addr) throw new Error('Email required');
  if (!homeserver) throw new Error('Homeserver required');
  const baseUrl = await discoverBaseUrl(homeserver, null);
  const tmp = sdk.createClient({ baseUrl, logger: QUIET_LOGGER });
  const clientSecret = tmp.generateClientSecret();
  let res;
  try {
    res = await withTimeout(
      tmp.requestPasswordEmailToken(addr, clientSecret, 1),
      30000,
      'Password reset email'
    );
  } catch (e) {
    throw friendlyMatrixError(e, 'Could not send the reset email.');
  }
  return { sid: res?.sid, clientSecret, baseUrl };
}

/**
 * Step 2 of an email-based password reset. Once the user has clicked the
 * link the homeserver emailed, this sets the new password using the now-
 * validated email identity as UI-auth. `creds` is the object returned by
 * requestPasswordReset(). Other sessions are revoked so a leaked old token
 * can't outlive the reset.
 */
export async function completePasswordReset(creds, newPassword) {
  if (!newPassword) throw new Error('New password required');
  const { sid, clientSecret, baseUrl } = creds || {};
  if (!sid || !clientSecret || !baseUrl) {
    throw new Error('Reset expired — start again from the email step.');
  }
  const tmp = sdk.createClient({ baseUrl, logger: QUIET_LOGGER });
  const threepid = { sid, client_secret: clientSecret };
  const authStage = {
    type: 'm.login.email.identity',
    // Newer spec key plus the legacy camelCase key some homeservers still read.
    threepid_creds: threepid,
    threepidCreds: threepid,
  };
  try {
    await uiaSetPassword(tmp, authStage, newPassword, true);
  } catch (e) {
    throw friendlyMatrixError(e, 'Could not set the new password.');
  }
}

/**
 * Change the password of the signed-in account. Re-authenticates with the
 * current password (m.login.password UI-auth) and sets the new one. By
 * default other devices keep their sessions (logoutDevices=false) so this
 * doesn't silently sign the user out everywhere.
 *
 * Note: the local vault key is derived from the Matrix password, so after a
 * change the on-device cache can only be unlocked with the NEW password. The
 * next cold login with the new password rotates the vault automatically (see
 * the mismatch handling in login()); cached history re-syncs from the server.
 */
export async function changePassword(oldPassword, newPassword, { logoutDevices = false } = {}) {
  if (!client) throw new Error('Not connected');
  if (!oldPassword) throw new Error('Current password required');
  if (!newPassword) throw new Error('New password required');
  const userId = client.getUserId();
  const authStage = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: userId },
    user: userId,
    password: oldPassword,
  };
  try {
    await uiaSetPassword(client, authStage, newPassword, logoutDevices);
  } catch (e) {
    throw friendlyMatrixError(e, 'Could not change the password.');
  }
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
    logger: QUIET_LOGGER,
  });
  await ensureCryptoStoreOwner(sid);
  progress('Restoring session…');
  try {
    await initCryptoWithRetry(client);
  } catch (e) {
    progress(`Crypto init failed (continuing offline): ${e.message}`);
  }

  let sessionExpired = false;
  try {
    await client.startClient(SYNC_OPTS);
    disableMatrixRTC(client);
    if (_watchSyncUnsub) _watchSyncUnsub();
    _watchSyncUnsub = watchSync(client);
    // Best-effort wait for sync — short timeout so offline boots fast.
    try { await waitForSync(client, 12000); }
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
    dropSession(userId);
    progress('Saved session was rejected by the server — log in again to refresh credentials.');
    return null;
  }

  return client;
}

/**
 * Offline-capable unlock: derive the vault key from the password and
 * (if we have a saved session) bring up the client without requiring
 * network. Returns { userId, online } where online indicates whether
 * sync reached a ready state.
 */
export async function unlock(userId, password, { persist = false } = {}) {
  const ok = await vault.unlock(userId, password, { persist });
  if (!ok) throw new Error('Invalid password');
  rememberLastUser(userId);

  // No session blob → vault is unlocked but we have no Matrix token.
  // Caller must try a fresh online login (and may fall back to
  // local-only mode if the homeserver is unreachable).
  if (!localStorage.getItem(sessionKey(userId))) {
    return { userId, online: false, needsLogin: true };
  }

  const c = await restoreSession(userId);
  if (!c) {
    // restoreSession either failed or dropped a rejected token — vault
    // is still unlocked, so local data is accessible, but the caller
    // needs to refresh credentials to talk to the server again.
    return { userId, online: false, needsLogin: true };
  }
  const state = c.getSyncState && c.getSyncState();
  const online = state === 'PREPARED' || state === 'SYNCING';

  // We have the password in scope right now. If secret storage isn't
  // ready locally (post-wipe re-login on the same homeserver), this
  // derives the SSSS key from the password, pulls cross-signing and
  // backup secrets out of SSSS, and restores the Megolm key backup.
  if (online) {
    try { await ensureSecureBackup(password, userId); }
    catch (e) { progress(`Secure backup link skipped: ${e.message}`); }
  }

  return { userId, online, needsLogin: false };
}

/**
 * Cold-boot auto-restore. If a previous unlock in this tab stashed the
 * vault key in sessionStorage, adopt it back into the vault and bring
 * the Matrix client online. Returns null when there's nothing to
 * resume (no stash, no last user, or the stash is stale).
 *
 * sessionStorage is per-tab, so closing the tab/browser forgets the
 * key and the next launch requires the password again.
 */
export async function tryAutoUnlock() {
  const lastUser = getLastUser();
  if (!lastUser) return null;
  if (!vault.hasMeta(lastUser)) return null;

  const adopted = await vault.tryAdoptStashedKey(lastUser);
  if (!adopted) return null;

  progress('Resuming session…');

  let online = false;
  try {
    const c = await restoreSession(lastUser);
    if (c) {
      const state = c.getSyncState && c.getSyncState();
      online = state === 'PREPARED' || state === 'SYNCING';
    }
  } catch (e) {
    progress(`Auto-restore: ${e.message}`);
  }

  return { userId: lastUser, online };
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
 * Sign out: revoke the access token on the server, drop the cached
 * session token, and lock the vault. Local data (OPFS rooms, media,
 * outbox, vault metadata, room manifest) is kept on disk so the same
 * user can sign back in later without losing their workspace, and so
 * a different user signing in on this device doesn't blow away the
 * previous user's encrypted-at-rest data.
 *
 * The crypto store is left alone; if a different user signs in next,
 * `initCryptoWithRetry` detects the mismatch and rebuilds from the
 * server's key backup.
 *
 * Call `wipeLocalData()` separately for a full device clean.
 */
export async function logout() {
  const uid = vault.getUserId();
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    try { await client.logout(true); } catch {}
    client = null;
  }
  if (uid) dropSession(uid);
  vault.lock();
  // Keep `getLastUser()` so the login form can pre-fill the username.
  // The next sign-in will re-derive the vault key from the password.
}

/**
 * Destructive wipe: removes every byte of local state this app owns —
 * OPFS room files, media cache, outbox, every vault, every saved
 * session, room manifests, and the matrix-js-sdk crypto store. The
 * `getLastUser()` hint is forgotten too.
 *
 * Call this when the user explicitly asks to "clear local data" or
 * when the local vault has been irrecoverably corrupted.
 */
export async function wipeLocalData() {
  const uid = vault.getUserId();
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    try { await client.logout(true); } catch {}
    client = null;
  }
  if (uid) {
    dropSession(uid);
    wipeManifest(uid);
    vault.wipe(uid);
  }
  try { await wipeAllRoomData(); } catch {}
  try { await wipeMediaCache(); } catch {}
  try { await clearOutbox(); } catch {}
  try { await clearCryptoStore(); } catch {}
  localStorage.removeItem(CRYPTO_OWNER_KEY);
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

/** Does the user have a usable saved access token? */
export function hasSavedSession(userId) {
  return !!localStorage.getItem(sessionKey(userId));
}
