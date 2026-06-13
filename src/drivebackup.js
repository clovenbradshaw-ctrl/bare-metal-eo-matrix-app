/**
 * drivebackup.js — optional off-site mirror of the block chain via n8n → Google Drive
 *
 * The media-store block chain (src/blocks.js) is the durable system of
 * record: every committed op-event is packed into a WCK-encrypted block,
 * uploaded to the homeserver media store, and hash-linked. Recovery walks
 * that chain. But the media store is the homeserver's disk — if it evicts a
 * blob under a retention policy, those blocks are gone, and a fresh device's
 * per-block media fetches are slow.
 *
 * This module adds a SECOND copy of every block somewhere the user
 * controls: a Google Drive file reached through an n8n webhook. It is purely
 * additive and opt-in — nothing here changes the primary path.
 *
 *   append → upload to media store (primary)  ──┐
 *                                               ├─▶ both hold the SAME
 *            mirror to n8n → Drive (backup)   ──┘   encrypted ciphertext
 *
 * THE ENCRYPTION INVARIANT IS PRESERVED. Only a block's WCK-encrypted
 * ciphertext — the exact bytes the homeserver media store already holds —
 * is sent, base64-wrapped, to the webhook. n8n and Google Drive see opaque
 * blobs they cannot decrypt. Every block read back is verified against its
 * sha256 (decodeBlock, in blockcodec.js) before it is trusted, so a
 * malicious or buggy webhook can never inject anything into the fold — a
 * wrong blob is rejected exactly like a tampered media-store blob.
 *
 * Two roles, both opt-in (configured in the sync page):
 *   - BACKUP (up):  mirrorBlock() POSTs each block as it is appended.
 *   - HYDRATION (down): getBlock() resolves a block by content hash during
 *     chain load. In "fast" mode Drive is consulted BEFORE the homeserver
 *     (cold device, or a slow/lossy media store); otherwise it is the
 *     fallback for a block the media store can't serve. The whole chain is
 *     pulled in ONE request and cached, so a load of N blocks costs one GET.
 *
 * ── The n8n contract (matches the supplied workflow) ──────────────────────
 *
 *   AUTH. Every request carries `Authorization: Bearer <matrix access token>`.
 *   n8n replays it to the homeserver's `/account/whoami` and checks the
 *   resolved `user_id` against an allowlist. We therefore send the live
 *   Matrix access token (via the injected auth-token provider), never a
 *   secret of our own.
 *
 *   BACKUP — POST <backupUrl>
 *     body: { payload: { room, idx, sha256, mxc, ts, data } }   // data = base64(ciphertext)
 *     n8n appends `payload` to its own hash-chained JSON file in Drive and
 *     responds { ok, head, blockCount }.
 *
 *   HYDRATE — GET <hydrateUrl>
 *     → returns the whole chain JSON: { version, head, blocks: [ { …, payload } ] }
 *     where each `payload` is one of the objects we backed up. We index the
 *     payloads by `sha256` and serve getBlock() from that map.
 *
 * `sha256` is the canonical block address because it is what the reader
 * verifies against; `mxc`/`room` ride along only as convenience keys.
 *
 * Config (backupUrl, hydrateUrl, fast) is stored per-user, vault-encrypted
 * at rest (vault.js storeSecret). The URLs never leave the device except as
 * the request target.
 */

import { b64, unb64 } from './crypto/envelope.js';

// Per-user vault-secret name the config is stashed under.
const SECRET_NAME = 'drive_backup';

// Network timeouts. A hung webhook must never stall hydration or the block
// flush loop, so every request is aborted past these bounds.
const PUT_TIMEOUT_MS = 20_000;
const GET_TIMEOUT_MS = 30_000;

// How long a pulled chain stays usable before the next read re-fetches it.
// Hydration of a whole workspace happens in a burst well inside this window,
// so the burst costs a single GET; a mirror invalidates it immediately.
const CHAIN_TTL_MS = 60_000;

// In-memory config for the active user.
//   backupUrl  : n8n "Backup Block (POST)" webhook URL
//   hydrateUrl : n8n "Hydrate (GET)" webhook URL
//   fast       : when true, reads try Drive BEFORE the homeserver media store
let config = { backupUrl: '', hydrateUrl: '', fast: false };

// Supplies the live Matrix access token for the Authorization header. Set by
// main.js (setAuthTokenProvider) so this module never imports the client.
let authTokenProvider = null;

// Cached pull of the whole Drive chain: a Map(sha256 → ciphertext bytes),
// the promise that produced it, whether it is still in flight, and when it
// resolved (for the TTL).
let chainPromise = null;
let chainPending = false;
let chainAt = 0;

/** Normalize a raw config object into the shape we keep in memory. */
function normalize(cfg) {
  return {
    backupUrl: typeof cfg?.backupUrl === 'string' ? cfg.backupUrl.trim() : '',
    hydrateUrl: typeof cfg?.hydrateUrl === 'string' ? cfg.hydrateUrl.trim() : '',
    fast: !!cfg?.fast,
  };
}

/** Set the in-memory config directly (used by tests and the loaders). */
export function configure(cfg) {
  config = normalize(cfg);
  invalidateChain();
  return getConfig();
}

/** Current config (a copy), with derived `canBackup` / `canHydrate`. */
export function getConfig() {
  return { ...config, canBackup: !!config.backupUrl, canHydrate: !!config.hydrateUrl };
}

/** True when a block can be mirrored off-site (a backup URL is set). */
export function canBackup() {
  return !!config.backupUrl;
}

/** True when blocks can be served from Drive (a hydrate URL is set). */
export function canHydrate() {
  return !!config.hydrateUrl;
}

/** True when reads should prefer Drive over the homeserver media store. */
export function isFast() {
  return !!config.hydrateUrl && config.fast;
}

/** Inject the Matrix-access-token accessor used for the Authorization header. */
export function setAuthTokenProvider(fn) {
  authTokenProvider = typeof fn === 'function' ? fn : null;
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  let token = null;
  try { token = authTokenProvider ? authTokenProvider() : null; } catch { token = null; }
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Load this user's config from the vault secret store into memory. Safe to
 * call when the vault is locked or no config exists — it just leaves Drive
 * disabled. Returns the resulting config.
 */
export async function loadConfig(userId, loadSecret) {
  try {
    const raw = await loadSecret(userId, SECRET_NAME);
    configure(raw ? JSON.parse(raw) : {});
  } catch {
    configure({});
  }
  return getConfig();
}

/**
 * Persist this user's config (vault-encrypted) and apply it in memory. Pass
 * `storeSecret`/`removeSecret` from vault.js so this module stays free of a
 * hard dependency on the vault singleton (and testable).
 */
export async function saveConfig(userId, cfg, { storeSecret, removeSecret }) {
  const next = normalize(cfg);
  configure(next);
  if (next.backupUrl || next.hydrateUrl) {
    await storeSecret(userId, SECRET_NAME, JSON.stringify(next));
  } else if (removeSecret) {
    removeSecret(userId, SECRET_NAME);
  }
  return getConfig();
}

/** Forget the in-memory config + cached chain (e.g. on logout). */
export function clearConfig() {
  config = { backupUrl: '', hydrateUrl: '', fast: false };
  invalidateChain();
}

/** Drop the cached chain pull so the next read re-fetches from Drive. */
export function invalidateChain() {
  chainPromise = null;
  chainPending = false;
  chainAt = 0;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Mirror one block's ciphertext to the backup webhook. Best-effort: returns
 * true on a 2xx, false on any failure (disabled, offline, webhook error).
 * Never throws — a mirror failure must not break the primary append path.
 */
export async function mirrorBlock({ roomId, idx, sha256, mxc, bytes, ts = Date.now() }) {
  if (!config.backupUrl || !bytes) return false;
  try {
    const resp = await fetchWithTimeout(config.backupUrl, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        payload: { room: roomId, idx, sha256, mxc, ts, data: b64(bytes) },
      }),
    }, PUT_TIMEOUT_MS);
    if (!resp.ok) {
      console.warn(`[drivebackup] mirror ${resp.status} for block ${idx} (${sha256})`);
      return false;
    }
    invalidateChain();          // the chain in Drive just grew
    return true;
  } catch (e) {
    console.warn('[drivebackup] mirror failed:', e?.message || e);
    return false;
  }
}

/**
 * Pull the whole chain from Drive and index its payloads by sha256. Cached
 * for CHAIN_TTL_MS and de-duplicated while in flight, so a burst of getBlock
 * calls (the parallel manifest fetch) costs a single GET. Returns a
 * Map(sha256 → ciphertext bytes); an empty map on any failure.
 */
function pullChain() {
  // Reuse a pull that is still in flight, or one that resolved within the TTL.
  if (chainPromise && (chainPending || (Date.now() - chainAt) < CHAIN_TTL_MS)) {
    return chainPromise;
  }
  chainPending = true;
  chainPromise = (async () => {
    try {
      const resp = await fetchWithTimeout(config.hydrateUrl, {
        method: 'GET',
        headers: authHeaders(),
      }, GET_TIMEOUT_MS);
      if (!resp.ok) return new Map();
      const chain = await resp.json();
      const map = new Map();
      for (const block of chain?.blocks || []) {
        const p = block?.payload;
        if (p && typeof p.sha256 === 'string' && typeof p.data === 'string') {
          try { map.set(p.sha256, unb64(p.data)); } catch { /* skip bad entry */ }
        }
      }
      return map;
    } catch (e) {
      console.warn('[drivebackup] chain pull failed:', e?.message || e);
      return new Map();
    } finally {
      chainAt = Date.now();
      chainPending = false;
    }
  })();
  return chainPromise;
}

/**
 * Resolve one block's ciphertext from the Drive chain by content hash.
 * Returns a Uint8Array or null (disabled, offline, or absent). The caller
 * verifies the bytes against `sha256` via decodeBlock — this function does
 * NOT trust the response, it only retrieves it.
 */
export async function getBlock({ sha256 }) {
  if (!config.hydrateUrl || !sha256) return null;
  const map = await pullChain();
  return map.get(sha256) || null;
}

/**
 * Liveness check for the settings UI. Hits the hydrate endpoint (a safe,
 * idempotent read that exercises auth + Drive) and reports the outcome.
 * Returns { ok, status, blocks?, error? }.
 */
export async function testConnection() {
  if (!config.hydrateUrl) {
    return { ok: false, status: 0, error: 'No hydrate URL configured' };
  }
  try {
    const resp = await fetchWithTimeout(config.hydrateUrl, {
      method: 'GET',
      headers: authHeaders(),
    }, GET_TIMEOUT_MS);
    if (!resp.ok) return { ok: false, status: resp.status };
    let blocks = null;
    try { blocks = (await resp.json())?.blocks?.length ?? null; } catch {}
    return { ok: true, status: resp.status, blocks };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}
