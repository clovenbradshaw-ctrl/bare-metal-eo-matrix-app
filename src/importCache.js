/**
 * importCache.js — OPFS persistence for materialised import rows
 *
 * Imported tables don't store their rows as events. The source CSV/JSON
 * blob is uploaded once to the homeserver media store and the rows are
 * reconstructed on demand from it (csv-import.jsx materializeImportRows).
 * Re-downloading a multi-megabyte blob and re-parsing it on every load —
 * and depending on the homeserver media staying reachable — is both slow
 * and fragile. This module persists the materialised rows to OPFS once,
 * vault-encrypted, keyed by import anchor, so future loads read them
 * straight from disk in binary with no network round-trip and no parse.
 *
 * File layout (one file per import anchor):
 *
 *   importrows_<fnv1a32(anchor)>.bin
 *
 *   [MAGIC(4) "MXIR"][VERSION(2)=1][BLOB]
 *
 * BLOB is vault.encryptBytes(utf8(JSON.stringify({ anchor, rows, savedAt })))
 * — i.e. [iv(12)][ciphertext+tag]. The file is opaque binary at rest; only
 * a reader holding the unlocked vault key can recover it. The anchor is
 * embedded in the plaintext as well so an fnv1a32 filename collision is
 * detected and ignored rather than served as the wrong import's rows.
 *
 * The vault must be unlocked. With a locked or absent vault these are
 * no-ops (load returns null, save silently skips) so the in-memory +
 * media-blob fallback path still works on a fresh device.
 */

import { vault } from './vault.js';
import { fnv1a32 } from './pack.js';

const MAGIC = new Uint8Array([0x4D, 0x58, 0x49, 0x52]); // "MXIR"
const VERSION = 1;
const HEADER_BYTES = 6;
const PREFIX = 'importrows_';
const SUFFIX = '.bin';

const encoder = new TextEncoder();

async function getRoot() {
  try { return await navigator.storage.getDirectory(); }
  catch { return null; }
}

function fileNameFor(anchor) {
  const h = fnv1a32(anchor);
  return `${PREFIX}${h.toString(16).padStart(8, '0')}${SUFFIX}`;
}

/**
 * Persist the materialised rows for an import. Idempotent — overwrites
 * any previous cache for the same anchor. No-op when the vault is locked
 * or OPFS is unavailable.
 */
export async function saveImportRows(anchor, rows) {
  if (!anchor || !Array.isArray(rows)) return;
  if (!vault.isUnlocked()) return;
  const root = await getRoot();
  if (!root) return;
  try {
    const blob = await vault.encryptBytes(
      encoder.encode(JSON.stringify({ anchor, rows, savedAt: Date.now() }))
    );
    const out = new Uint8Array(HEADER_BYTES + blob.length);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint16(4, VERSION);
    out.set(blob, HEADER_BYTES);

    const handle = await root.getFileHandle(fileNameFor(anchor), { create: true });
    const writable = await handle.createWritable();
    await writable.write(out);
    await writable.close();
  } catch (e) {
    console.warn('[importCache] save failed:', e?.message || e);
  }
}

/**
 * Read the cached rows for an import. Returns the row array (possibly
 * empty) on a hit, or null when there is no usable cache — absent file,
 * locked vault, wrong magic/version, decrypt failure, or an anchor
 * mismatch from a filename-hash collision. A null result tells the
 * caller to fall back to materialising from the source blob.
 */
export async function loadImportRows(anchor) {
  if (!anchor) return null;
  if (!vault.isUnlocked()) return null;
  const root = await getRoot();
  if (!root) return null;
  try {
    const handle = await root.getFileHandle(fileNameFor(anchor));
    const file = await handle.getFile();
    if (file.size <= HEADER_BYTES) return null;
    const raw = new Uint8Array(await file.arrayBuffer());
    if (raw[0] !== MAGIC[0] || raw[1] !== MAGIC[1] ||
        raw[2] !== MAGIC[2] || raw[3] !== MAGIC[3]) return null;
    const version = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint16(4);
    if (version !== VERSION) return null;

    const payload = await vault.decryptJSON(raw.subarray(HEADER_BYTES));
    if (payload?.anchor !== anchor || !Array.isArray(payload.rows)) return null;
    return payload.rows;
  } catch {
    return null;
  }
}

/**
 * Drop the cached rows for a single import (e.g. when re-importing into
 * the same anchor, though anchors are normally unique per import).
 */
export async function clearImportRows(anchor) {
  if (!anchor) return;
  const root = await getRoot();
  if (!root) return;
  try { await root.removeEntry(fileNameFor(anchor)); } catch {}
}

/**
 * Wipe every cached import-row file from OPFS. Called on a full local
 * data wipe alongside the room store and media cache.
 */
export async function wipeImportRowCache() {
  const root = await getRoot();
  if (!root) return;
  const toRemove = [];
  try {
    for await (const [name] of root) {
      if (name.startsWith(PREFIX) && name.endsWith(SUFFIX)) toRemove.push(name);
    }
    for (const n of toRemove) { try { await root.removeEntry(n); } catch {} }
  } catch (e) {
    console.warn('[importCache] wipe failed:', e?.message || e);
  }
}
