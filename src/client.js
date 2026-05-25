/**
 * client.js — Matrix connection layer
 *
 * Wraps matrix-js-sdk: login, session persistence, sync, crypto init.
 * The SDK handles Megolm E2EE transparently once initRustCrypto() is called.
 * Every sendEvent() in an encrypted room is encrypted at the protocol level.
 * Every event received via sync is decrypted automatically.
 */

import * as sdk from 'matrix-js-sdk';

let client = null;

/**
 * Get the active MatrixClient instance.
 * Returns null if not logged in.
 */
export function getClient() {
  return client;
}

/**
 * Login to a Matrix homeserver.
 *
 * Creates a MatrixClient, authenticates, initializes Rust crypto (Megolm E2EE),
 * and starts the sync loop. After this call, client.sendEvent() in an encrypted
 * room produces Megolm-encrypted events that only room members can decrypt.
 *
 * @param {string} homeserver - Base URL, e.g. "https://matrix.org"
 * @param {string} username   - Local part or full MXID
 * @param {string} password
 * @returns {{ client, userId, deviceId }}
 */
export async function login(homeserver, username, password) {
  const baseUrl = homeserver.replace(/\/+$/, '');
  const user = username.replace(/^@/, '').split(':')[0];

  client = sdk.createClient({ baseUrl });

  const resp = await client.login('m.login.password', {
    identifier: { type: 'm.id.user', user },
    password,
    initial_device_display_name: 'Matrix Events',
  });

  // Recreate client with credentials for full SDK functionality
  client = sdk.createClient({
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
  });

  // Initialize Rust crypto — this is what makes Megolm real.
  // After this, every sendEvent in an encrypted room is E2EE.
  await client.initRustCrypto();

  // Start sync loop — delivers timeline events, to-device messages (key sharing),
  // and room state updates to all registered listeners.
  await client.startClient({ initialSyncLimit: 100 });

  // Wait for first sync to complete (with timeout and error handling)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timed out after 30s')), 30000);
    client.once(sdk.ClientEvent.Sync, (state, prevState, data) => {
      clearTimeout(timeout);
      if (state === 'PREPARED' || state === 'SYNCING') resolve();
      else reject(new Error(`Sync failed: ${state}`));
    });
  });

  // Persist session for reload
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

/**
 * Restore a session from sessionStorage.
 * Returns the client if successful, null otherwise.
 */
export async function restoreSession() {
  const raw = sessionStorage.getItem('mx_session');
  if (!raw) return null;

  try {
    const { baseUrl, accessToken, userId, deviceId } = JSON.parse(raw);

    client = sdk.createClient({ baseUrl, accessToken, userId, deviceId });
    await client.initRustCrypto();
    await client.startClient({ initialSyncLimit: 100 });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sync timed out')), 30000);
      client.once(sdk.ClientEvent.Sync, (state) => {
        clearTimeout(timeout);
        if (state === 'PREPARED' || state === 'SYNCING') resolve();
        else reject(new Error(`Sync failed: ${state}`));
      });
    });

    return client;
  } catch {
    sessionStorage.removeItem('mx_session');
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
}
