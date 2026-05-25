/**
 * client.js — Matrix connection layer
 *
 * Wraps matrix-js-sdk: login, session persistence, sync, crypto init.
 * The SDK handles Megolm E2EE transparently once initRustCrypto() is called.
 */

import * as sdk from 'matrix-js-sdk';

let client = null;

// Optional progress reporter — main.js can set this to surface step progress
// to the user instead of leaving them staring at "Logging in…".
let progress = (msg) => console.log('[matrix]', msg);

export function setProgress(fn) {
  progress = (msg) => { console.log('[matrix]', msg); fn(msg); };
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

// Wipe the Rust crypto IndexedDB stores. matrix-js-sdk binds a store to the
// (user_id, device_id) tuple it was created with; on a fresh login the server
// hands out a new device_id, so any leftover store from a prior session will
// fail initRustCrypto with "the account in the store doesn't match the
// account in the constructor". Clearing on fresh login (and on logout) keeps
// the flow idempotent. Old Megolm sessions are inaccessible by the new device
// anyway, so nothing useful is lost.
async function clearCryptoStores() {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return;
  }
  let dbs;
  try {
    dbs = await indexedDB.databases();
  } catch {
    return;
  }
  await Promise.all(
    dbs
      .filter((db) => db.name && (db.name.startsWith('matrix-') || db.name.includes('matrix-sdk-crypto')))
      .map((db) => new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }))
  );
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

  // Step 2: real client with credentials.
  client = sdk.createClient({
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
  });

  // Step 3: crypto. This loads wasm + opens IndexedDB; it can stall in
  // private-browsing modes or when storage is blocked. The timeout makes
  // that visible instead of leaving the UI frozen.
  // Drop any prior crypto store first — its device_id won't match the one
  // we just got from the server, and initRustCrypto refuses to reuse a
  // mismatched store.
  progress('Clearing prior crypto store…');
  await clearCryptoStores();
  progress('Initializing encryption…');
  await withTimeout(client.initRustCrypto(), 30000, 'Crypto init');

  // Step 4: sync.
  progress('Starting sync…');
  await client.startClient({ initialSyncLimit: 100 });
  await waitForSync(client);
  progress('Sync ready');

  sessionStorage.setItem(
    'mx_session',
    JSON.stringify({
      baseUrl,
      accessToken: resp.access_token,
      userId: resp.user_id,
      deviceId: resp.device_id,
    })
  );

  return {
    client,
    userId: resp.user_id,
    deviceId: resp.device_id,
  };
}

export async function restoreSession() {
  const raw = sessionStorage.getItem('mx_session');
  if (!raw) return null;

  try {
    const { baseUrl, accessToken, userId, deviceId } = JSON.parse(raw);

    client = sdk.createClient({ baseUrl, accessToken, userId, deviceId });
    progress('Restoring session…');
    await withTimeout(client.initRustCrypto(), 30000, 'Crypto init');
    await client.startClient({ initialSyncLimit: 100 });
    await waitForSync(client);

    return client;
  } catch (e) {
    console.warn('[matrix] session restore failed:', e);
    sessionStorage.removeItem('mx_session');
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
  sessionStorage.removeItem('mx_session');
  // Drop the crypto store so the next fresh login doesn't collide with it.
  await clearCryptoStores();
}
