/**
 * drivebackup.js — optional off-site mirror of the block chain via n8n → Google Drive
 *
 * The media-store block chain (src/blocks.js) is the durable system of
 * record: every committed op-event is packed into a WCK-encrypted block,
 * uploaded to the homeserver media store, and hash-linked. Recovery walks
 * that chain. But the media store is the homeserver's disk — if it evicts a
 * blob, those blocks are gone, and a cold device pays a round-trip per block.
 *
 * This module keeps a SECOND copy of every block somewhere the user
 * controls: a set of binary segment files in Google Drive, reached through
 * an n8n webhook. It is purely additive and opt-in — nothing here changes
 * the primary path.
 *
 * THE ENCRYPTION INVARIANT IS PRESERVED. Each backed-up record is exactly
 * one block's WCK-encrypted ciphertext — the same bytes the media store
 * already holds — so n8n and Drive see opaque blobs they cannot decrypt.
 * Every block read back is verified against its sha256 (decodeBlock, in
 * blockcodec.js) before the fold trusts it, so a malicious or buggy webhook
 * can no more inject data than a tampered media blob can.
 *
 * ── Wire format: a stream of length-prefixed binary records ───────────────
 *
 * Records are self-delimiting, so the segment boundary is irrelevant — a
 * reader concatenates every segment and parses one flat stream. Each record:
 *
 *   ┌────────────┬──────────────────────┬───────────────────────┐
 *   │ uint32 BE  │ header (UTF-8 JSON)   │ ciphertext (n bytes)  │
 *   │ headerLen  │ {room,idx,sha256,mxc, │ the WCK-encrypted block│
 *   │            │  ts, n}               │                        │
 *   └────────────┴──────────────────────┴───────────────────────┘
 *
 * The header is a few dozen bytes of metadata; the body is the opaque block.
 * `sha256` is the canonical address — it is what hydration indexes on and
 * what the reader verifies against.
 *
 * ── Segmented, client-enforced rotation ──────────────────────────────────
 *
 * Backups accumulate into one segment file (genesis = segment 0) until it
 * would exceed SEGMENT_MAX_BYTES, then roll over to a new file. THE CLIENT
 * decides rotation: it reads the latest segment's index + size once (the
 * state endpoint), tracks the size locally as it writes, and tells n8n which
 * segment to write and whether to create or append. Exact rotation is an
 * optimization, not a correctness requirement — records are content-addressed
 * and hydration dedups by sha256, so a duplicate from two racing devices
 * costs nothing.
 *
 * ── Cadence ───────────────────────────────────────────────────────────────
 *
 * Blocks are queued and flushed once BACKUP_FLUSH_EVENTS events have
 * accumulated (or after a short idle), so Drive is rewritten roughly every
 * hundred events rather than on every edit.
 *
 * ── The n8n contract (three webhook nodes) ───────────────────────────────
 *
 *   AUTH. Every request carries `Authorization: Bearer <matrix access token>`.
 *   n8n replays it to the homeserver's /account/whoami and checks the
 *   resolved user_id against an allowlist. We send the live Matrix token via
 *   the injected provider — there is no app-managed secret.
 *
 *   STATE  — GET <stateUrl>
 *     → JSON { index, bytes } of the newest segment file (or { index:0,
 *       bytes:0 } when none exists). Lets the client resume rotation.
 *
 *   BACKUP — POST <backupUrl>   (Content-Type: application/octet-stream)
 *     headers: X-Segment-Index: <n>, X-Segment-Mode: create | append
 *     body:    the binary record stream for this batch
 *     n8n upserts `segment-<n>` in the Drive folder (create = new/overwrite,
 *     append = download + concat + upload) and responds JSON { index, bytes }.
 *
 *   HYDRATE — GET <hydrateUrl>
 *     → application/octet-stream: every segment concatenated, oldest first.
 *
 * Config (stateUrl, backupUrl, hydrateUrl, fast) is stored per-user,
 * vault-encrypted at rest (vault.js storeSecret).
 */

// Per-user vault-secret name the config is stashed under.
const SECRET_NAME = 'drive_backup';

// Network timeouts. A hung webhook must never stall hydration or the flush
// loop, so every request is aborted past these bounds.
const PUT_TIMEOUT_MS = 30_000;
const GET_TIMEOUT_MS = 30_000;

// Flush once this many events have queued, or after this idle gap, whichever
// comes first ("rewrite every ~100 events").
const BACKUP_FLUSH_EVENTS = 100;
const BACKUP_IDLE_FLUSH_MS = 8_000;
const BACKUP_RETRY_MS = 20_000;
const MAX_BACKUP_FAILURES = 6;

// Roll over to a new segment file once the current one would exceed this.
const SEGMENT_MAX_BYTES = 25 * 1024 * 1024;

// How long a pulled hydrate stays usable before the next read re-fetches it.
const CHAIN_TTL_MS = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// In-memory config for the active user.
//   stateUrl   : n8n GET — latest segment { index, bytes }
//   backupUrl  : n8n POST — write a binary record batch to a segment
//   hydrateUrl : n8n GET — every segment concatenated (binary)
let config = { stateUrl: '', backupUrl: '', hydrateUrl: '' };

// Supplies the live Matrix access token for the Authorization header. Set by
// main.js (setAuthTokenProvider) so this module never imports the client.
let authTokenProvider = null;

// Backup batching state.
let queue = [];               // [{ frame: Uint8Array, events: number }]
let queuedEvents = 0;
let flushTimer = null;
let flushing = false;
let backupFailures = 0;
let seg = null;               // { index, bytes } of the current segment; null = unread

// Cached hydrate pull: the in-flight promise, the resolved Map(sha256 →
// ciphertext bytes) for synchronous peeks, whether it is still pending, and
// when it resolved (for the TTL).
let chainPromise = null;
let chainMap = null;
let chainPending = false;
let chainAt = 0;

// ── config ────────────────────────────────────────────────────────────────

function normalize(cfg) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    stateUrl: s(cfg?.stateUrl),
    backupUrl: s(cfg?.backupUrl),
    hydrateUrl: s(cfg?.hydrateUrl),
  };
}

/** Set the in-memory config directly (used by tests and the loaders). */
export function configure(cfg) {
  config = normalize(cfg);
  seg = null;                 // re-read segment state under the new endpoints
  invalidateChain();
  return getConfig();
}

/** Current config (a copy), with derived `canBackup` / `canHydrate`. */
export function getConfig() {
  return {
    ...config,
    canBackup: !!(config.backupUrl && config.stateUrl),
    canHydrate: !!config.hydrateUrl,
  };
}

/** True when blocks can be mirrored off-site (write + state endpoints set). */
export function canBackup() {
  return !!(config.backupUrl && config.stateUrl);
}

/** True when blocks can be served from Drive (a hydrate URL is set). */
export function canHydrate() {
  return !!config.hydrateUrl;
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

/** Load this user's config from the vault secret store into memory. */
export async function loadConfig(userId, loadSecret) {
  try {
    const raw = await loadSecret(userId, SECRET_NAME);
    configure(raw ? JSON.parse(raw) : {});
  } catch {
    configure({});
  }
  return getConfig();
}

/** Persist this user's config (vault-encrypted) and apply it in memory. */
export async function saveConfig(userId, cfg, { storeSecret, removeSecret }) {
  const next = normalize(cfg);
  configure(next);
  if (next.backupUrl || next.hydrateUrl || next.stateUrl) {
    await storeSecret(userId, SECRET_NAME, JSON.stringify(next));
  } else if (removeSecret) {
    removeSecret(userId, SECRET_NAME);
  }
  return getConfig();
}

/** Forget the in-memory config, pending batch, and cached hydrate. */
export function clearConfig() {
  config = { stateUrl: '', backupUrl: '', hydrateUrl: '' };
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  queue = [];
  queuedEvents = 0;
  backupFailures = 0;
  seg = null;
  invalidateChain();
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

// ── binary record framing ──────────────────────────────────────────────────

/** Frame one block as `[uint32 headerLen][header JSON][ciphertext]`. */
export function frameRecord({ room, idx, sha256, mxc, ts, bytes }) {
  const header = encoder.encode(JSON.stringify({ room, idx, sha256, mxc, ts, n: bytes.length }));
  const out = new Uint8Array(4 + header.length + bytes.length);
  new DataView(out.buffer).setUint32(0, header.length, false);   // big-endian
  out.set(header, 4);
  out.set(bytes, 4 + header.length);
  return out;
}

function concatFrames(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out;
}

/** Parse a concatenated record stream into [{ sha256, data }]. Stops cleanly
 *  at the first malformed/truncated frame (a partial trailing write). */
export function parseRecords(buf) {
  const records = [];
  if (!buf || !buf.length) return records;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 4 <= buf.length) {
    const headerLen = view.getUint32(off, false);
    off += 4;
    if (headerLen <= 0 || off + headerLen > buf.length) break;
    let header;
    try { header = JSON.parse(decoder.decode(buf.subarray(off, off + headerLen))); }
    catch { break; }
    off += headerLen;
    const n = header?.n | 0;
    if (n < 0 || off + n > buf.length) break;
    const data = buf.subarray(off, off + n);
    off += n;
    if (header?.sha256) records.push({ sha256: header.sha256, data });
  }
  return records;
}

// ── backup (up) ─────────────────────────────────────────────────────────

/** Queue one committed block for the off-site backup. Non-blocking; flushes
 *  when ~BACKUP_FLUSH_EVENTS events have accumulated, else after an idle gap. */
export function queueBlock({ roomId, idx, sha256, mxc, bytes, events = 0, ts = Date.now() }) {
  if (!canBackup() || !bytes) return;
  queue.push({ frame: frameRecord({ room: roomId, idx, sha256, mxc, ts, bytes }), events: events | 0 });
  queuedEvents += events | 0;
  if (queuedEvents >= BACKUP_FLUSH_EVENTS) void flushBackup();
  else scheduleFlush();
}

function scheduleFlush(delay = BACKUP_IDLE_FLUSH_MS) {
  if (flushTimer || !queue.length) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushBackup(); }, delay);
}

/**
 * Read the latest segment's { index, bytes, exists } from the state endpoint.
 * Returns null when the state can't be determined (offline / endpoint error)
 * so callers can avoid acting on a false "empty". `exists` defaults to
 * "there is a segment" when the endpoint omits the flag.
 */
async function readSegState() {
  try {
    const resp = await fetchWithTimeout(config.stateUrl, { method: 'GET', headers: authHeaders() }, GET_TIMEOUT_MS);
    if (!resp.ok) return null;
    const j = await resp.json();
    const index = Math.max(0, j?.index | 0);
    const bytes = Math.max(0, j?.bytes | 0);
    const exists = typeof j?.exists === 'boolean' ? j.exists : (bytes > 0 || index > 0);
    return { index, bytes, exists };
  } catch {
    return null;
  }
}

/** Latest segment { index, bytes } for a flush; defaults to genesis on error. */
async function fetchSegState() {
  const st = await readSegState();
  return st ? { index: st.index, bytes: st.bytes } : { index: 0, bytes: 0 };
}

/**
 * If Drive holds no segment yet, create the genesis hydration file (an empty
 * segment 0) so the structure exists before any data is backed up. Only acts
 * on a CONFIRMED-empty state — if the state endpoint can't be reached we do
 * nothing, so a transient error never overwrites an existing chain. Safe and
 * idempotent: a no-op once any segment exists. Returns true if it created it.
 */
export async function ensureBackupInitialized() {
  if (!canBackup()) return false;
  const st = await readSegState();
  if (!st) return false;                       // couldn't confirm — don't touch Drive
  seg = { index: st.index, bytes: st.bytes };
  if (st.exists) return false;                 // already initialized
  try {
    const resp = await fetchWithTimeout(config.backupUrl, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/octet-stream',
        'X-Segment-Index': '0',
        'X-Segment-Mode': 'create',
      }),
      body: new Uint8Array(0),                 // empty genesis; first real flush fills it
    }, PUT_TIMEOUT_MS);
    if (!resp.ok) return false;
    seg = { index: 0, bytes: 0 };
    invalidateChain();
    return true;
  } catch (e) {
    console.warn('[drivebackup] genesis init failed:', e?.message || e);
    return false;
  }
}

/**
 * Flush the queued batch to Drive as one binary write. Returns true on a
 * 2xx. Best-effort and self-healing: on failure the batch is requeued and a
 * retry is scheduled. The CLIENT enforces rotation — it advances to a new
 * segment when the current one would exceed SEGMENT_MAX_BYTES.
 */
export async function flushBackup() {
  if (flushing || !canBackup() || !queue.length) return false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushing = true;

  const batch = queue;
  queue = [];
  const batchEvents = queuedEvents;
  queuedEvents = 0;
  const body = concatFrames(batch.map(b => b.frame));

  try {
    if (!seg) seg = await fetchSegState();
    // Roll over before a non-empty segment would exceed the cap.
    if (seg.bytes > 0 && seg.bytes + body.length > SEGMENT_MAX_BYTES) {
      seg = { index: seg.index + 1, bytes: 0 };
    }
    const mode = seg.bytes === 0 ? 'create' : 'append';

    const resp = await fetchWithTimeout(config.backupUrl, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/octet-stream',
        'X-Segment-Index': String(seg.index),
        'X-Segment-Mode': mode,
      }),
      body,
    }, PUT_TIMEOUT_MS);
    if (!resp.ok) throw new Error('backup ' + resp.status);

    let newBytes = seg.bytes + body.length;
    try { const j = await resp.json(); if (Number.isFinite(j?.bytes)) newBytes = j.bytes | 0; } catch {}
    seg = { index: seg.index, bytes: newBytes };
    backupFailures = 0;
    invalidateChain();                          // Drive grew; re-pull next read
    return true;
  } catch (e) {
    queue = batch.concat(queue);                // preserve order, retry later
    queuedEvents += batchEvents;
    backupFailures++;
    console.warn('[drivebackup] flush failed:', e?.message || e);
    if (backupFailures < MAX_BACKUP_FAILURES) scheduleFlush(BACKUP_RETRY_MS);
    return false;
  } finally {
    flushing = false;
    if (canBackup() && queuedEvents >= BACKUP_FLUSH_EVENTS && backupFailures < MAX_BACKUP_FAILURES) {
      void flushBackup();                       // more piled up during the await
    }
  }
}

// ── hydration (down) ──────────────────────────────────────────────────────

/** Drop the cached hydrate pull so the next read re-fetches from Drive. */
export function invalidateChain() {
  chainPromise = null;
  chainMap = null;
  chainPending = false;
  chainAt = 0;
}

/** True when a fresh whole-chain pull is already resolved in memory. */
function chainFresh() {
  return !!chainMap && (Date.now() - chainAt) < CHAIN_TTL_MS;
}

/**
 * Pull every segment from Drive (one GET, concatenated binary) and index its
 * records by sha256. Cached for CHAIN_TTL_MS and de-duplicated while in
 * flight, so a burst of getBlock calls costs a single GET. Returns a
 * Map(sha256 → ciphertext bytes); an empty map on any failure.
 */
function pullChain() {
  if (chainPromise && (chainPending || (Date.now() - chainAt) < CHAIN_TTL_MS)) {
    return chainPromise;
  }
  chainPending = true;
  chainPromise = (async () => {
    try {
      const resp = await fetchWithTimeout(config.hydrateUrl, { method: 'GET', headers: authHeaders() }, GET_TIMEOUT_MS);
      if (!resp.ok) return new Map();
      const buf = new Uint8Array(await resp.arrayBuffer());
      const map = new Map();
      for (const rec of parseRecords(buf)) map.set(rec.sha256, rec.data);
      chainMap = map;
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
 * Synchronous, no-network resolve of a block from an already-pulled, fresh
 * chain. Returns the ciphertext bytes, or null when the chain isn't loaded
 * yet (the caller should then fall back to the async race in getBlock). This
 * is what lets a hydration of N blocks pay a single Drive GET: once the pull
 * lands, every remaining block is served from memory.
 */
export function peekBlock({ sha256 }) {
  if (!config.hydrateUrl || !sha256 || !chainFresh()) return null;
  return chainMap.get(sha256) || null;
}

/**
 * Resolve one block's ciphertext from the Drive segments by content hash,
 * pulling the whole chain (one GET, cached) if needed. Returns a Uint8Array
 * or null. The caller verifies the bytes against `sha256` via decodeBlock —
 * this function only retrieves, it does not trust.
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
    const resp = await fetchWithTimeout(config.hydrateUrl, { method: 'GET', headers: authHeaders() }, GET_TIMEOUT_MS);
    if (!resp.ok) return { ok: false, status: resp.status };
    let blocks = null;
    try { blocks = parseRecords(new Uint8Array(await resp.arrayBuffer())).length; } catch {}
    return { ok: true, status: resp.status, blocks };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}
