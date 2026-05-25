/**
 * client.js — Matrix connection layer
 *
 * Wraps matrix-js-sdk: login, session persistence, sync, crypto init.
 * The SDK handles Megolm E2EE transparently once initRustCrypto() is called.
 */

import * as sdk from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';

let client = null;

// Optional progress reporter — main.js can set this to surface step progress
// to the user instead of leaving them staring at "Logging in…".
let progress = (msg) => console.log('[matrix]', msg);

export function setProgress(fn) {
  progress = (msg) => { console.log('[matrix]', msg); fn(msg); };
}

// UI callbacks for the recovery key flow. The UI registers these before
// login so the client layer can request the key from the user (on a new
// device) or hand back a newly-generated key for them to save.
let recoveryKeyProvider = null; // async () => string (the user's recovery key)
let recoveryKeyDisplayer = null; // async (string) => void (show + acknowledge)

export function setRecoveryKeyProvider(fn) {
  recoveryKeyProvider = fn;
}

export function setRecoveryKeyDisplayer(fn) {
  recoveryKeyDisplayer = fn;
}

export function getClient() {
  return client;
}

// Wait until the sync state reaches a "ready" value. Uses `on` (not `once`)
// because the SDK can emit intermediate states (RECONNECTING, ERROR with
// retry) before reaching PREPARED. The previous `once` listener rejected on
// the first non-ready state and timed out if it had already fired.
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
        // Surface persistent errors immediately. Transient errors that the
        // SDK retries will move back to RECONNECTING/SYNCING on their own.
        const err = data.error;
        if (err.httpStatus === 401 || err.errcode === 'M_UNKNOWN_TOKEN') {
          cleanup();
          reject(new Error('Access token rejected'));
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

// Promisified timeout wrapper so a stuck network or stuck wasm load surfaces
// as a real error instead of an endless spinner.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// Cryptocallback bridging the SDK's secret-storage requests to the UI.
// The SDK calls this whenever it needs to unlock secret storage (e.g. on
// a new device that has cross-signing on the server but no local keys).
// We ask the UI for the user's recovery key string, decode it, and hand
// back [keyId, privateKey] for the first key the SDK lists.
async function getSecretStorageKey({ keys }) {
  if (!recoveryKeyProvider) {
    progress('Recovery key required but no UI provider registered');
    return null;
  }
  const keyId = Object.keys(keys)[0];
  if (!keyId) return null;

  // The provider may resolve to null/empty if the user cancels — surface
  // that as "no key" rather than throwing inside the SDK.
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

// Make sure cross-signing, secret storage, and key backup are all set up
// for this account. Called after sync on first login (when we still have
// the password for the UIA challenge cross-signing key upload requires).
// On a new device with an existing account, this restores from secret
// storage using the user's recovery key.
async function ensureEncryptionSetUp({ userMxid, password }) {
  const crypto = client.getCrypto();
  if (!crypto) return;

  if (await crypto.isCrossSigningReady()) {
    // Local cross-signing is already populated. Make sure backup is on.
    try { await crypto.checkKeyBackupAndEnable(); } catch (e) {
      progress(`Key backup check failed: ${e.message}`);
    }
    return;
  }

  const accountHasCrossSigning = await crypto.userHasCrossSigningKeys(userMxid, true);

  if (accountHasCrossSigning) {
    // New device on an existing account. Need the user's recovery key to
    // unlock secret storage; bootstrapCrossSigning will call our
    // getSecretStorageKey callback to fetch the private keys.
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

  // First-time setup for this account. Requires the password for the UIA
  // challenge on /keys/device_signing/upload.
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

// Resolve the actual client API URL via .well-known/matrix/client. Many
// homeservers (matrix.org, EMS-hosted, etc.) advertise an API host that
// differs from the server name. Without this discovery step, login POSTs
// to the wrong origin and the request can hang or be CORS-blocked.
async function discoverBaseUrl(rawHs, mxid) {
  // If the user supplied an explicit URL, try well-known on that hostname.
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

export async function login(homeserver, username, password) {
  const user = username.replace(/^@/, '').split(':')[0];

  progress('Resolving homeserver…');
  const baseUrl = await discoverBaseUrl(homeserver, username);
  progress(`Using ${baseUrl}`);

  // Step 1: authenticate. Wrap in a timeout so a hung network surfaces.
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

  // Persist credentials immediately, before any step that can block or
  // hang. The access token + device id are valid the moment auth
  // succeeds; everything after this point is recoverable on next load.
  // Saving later (after sync, after the recovery-key modal) meant a
  // reload mid-bootstrap dropped the session and forced the homeserver
  // to mint a new device on the next login — the duplicate-session-ID
  // symptom we keep seeing.
  localStorage.setItem(
    'mx_session',
    JSON.stringify({
      baseUrl,
      accessToken: resp.access_token,
      userId: resp.user_id,
      deviceId: resp.device_id,
    })
  );

  // Step 2: real client with credentials.
  client = sdk.createClient({
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
    cryptoCallbacks: { getSecretStorageKey },
  });

  // Step 3: crypto. This loads wasm + opens IndexedDB; it can stall in
  // private-browsing modes or when storage is blocked. The timeout makes
  // that visible instead of leaving the UI frozen.
  progress('Initializing encryption…');
  await withTimeout(client.initRustCrypto(), 30000, 'Crypto init');

  // Step 4: sync.
  progress('Starting sync…');
  await client.startClient({ initialSyncLimit: 100 });
  await waitForSync(client);
  progress('Sync ready');

  // Step 5: cross-signing + key backup. First login bootstraps a recovery
  // key; new devices on the same account restore from one.
  try {
    await ensureEncryptionSetUp({ userMxid: resp.user_id, password });
  } catch (e) {
    progress(`Encryption setup failed: ${e.message}`);
  }

  return {
    client,
    userId: resp.user_id,
    deviceId: resp.device_id,
  };
}

export async function restoreSession() {
  const raw = localStorage.getItem('mx_session');
  if (!raw) return null;

  try {
    const { baseUrl, accessToken, userId, deviceId } = JSON.parse(raw);

    client = sdk.createClient({
      baseUrl,
      accessToken,
      userId,
      deviceId,
      cryptoCallbacks: { getSecretStorageKey },
    });
    progress('Restoring session…');
    await withTimeout(client.initRustCrypto(), 30000, 'Crypto init');
    await client.startClient({ initialSyncLimit: 100 });
    await waitForSync(client);

    // Restore-only path: no password, so first-time bootstrap is skipped.
    // If the account already has cross-signing on the server, this will
    // prompt the UI for the recovery key to pull it down to this device.
    try {
      await ensureEncryptionSetUp({ userMxid: userId, password: null });
    } catch (e) {
      progress(`Encryption restore failed: ${e.message}`);
    }

    return client;
  } catch (e) {
    console.warn('[matrix] session restore failed:', e);
    // Only wipe the saved session when the homeserver has actually
    // rejected the token. Transient failures (sync timeout, slow wasm
    // load, IndexedDB hiccup, recovery-key modal dismissed) leave the
    // credentials intact so the next reload tries again instead of
    // forcing a fresh login and a new device id.
    const msg = String(e && e.message || '');
    const fatal = msg.includes('Access token rejected') ||
                  e?.httpStatus === 401 ||
                  e?.errcode === 'M_UNKNOWN_TOKEN';
    if (fatal) {
      localStorage.removeItem('mx_session');
    }
    client = null;
    return null;
  }
}

/**
 * Logout and clear session.
 */
export async function logout() {
  if (client) {
    client.stopClient();
    try {
      await client.logout(true);
    } catch {
      // Server may reject — clear local state anyway
    }
    client = null;
  }
  localStorage.removeItem('mx_session');
}
