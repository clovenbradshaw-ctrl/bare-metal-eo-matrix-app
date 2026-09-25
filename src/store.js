/**
 * store.js — OPFS persistence layer (vault-encrypted)
 *
 * Binary append-only event store. One file per room.
 *
 * File layout (v2):
 *
 *   [MAGIC(4) "MXEV"]
 *   [VERSION(2)]                  // 2 = vault-encrypted chunks
 *   [NS_LEN(2)][NS(NS_LEN)]
 *   [chunk]*                      // 0..N append chunks
 *
 * Each chunk is:
 *
 *   [IV(12)][CT_LEN(4)][CT(CT_LEN)]   // CT decrypts to packBatch bytes
 *
 * The chunk plaintext is exactly what packBatch() emits — a stream of
 * fixed-header + body records. Each chunk is an independent AES-GCM blob
 * (its own IV, no state shared with any other chunk), so a chunk is
 * decryptable on its own the moment you know its byte offset. The chunk
 * boundary itself carries no offset, though — [IV][CT_LEN] is only
 * readable once you already know where the chunk starts, so on its own
 * this file format still forces a sequential walk from byte 0 to find
 * anything past the first chunk.
 *
 * Two more files close that gap, both vault-encrypted, both O(rooms this
 * app has, not events in them) to read:
 *
 *   room_<hash>_index.bin        offset index — one small fixed-size
 *                                 record every INDEX_EVENT_INTERVAL events
 *                                 (see packIndexEntries below), regardless
 *                                 of how those events were batched into
 *                                 chunks. Says "event count N was reached
 *                                 at byte offset B" so opening the store
 *                                 can seek near the end of a long history
 *                                 instead of decrypting from the start.
 *   room_<hash>_checkpoint.bin   the folded application state as of some
 *                                 cursor, PLUS the dedup id-set as of that
 *                                 cursor (see saveCheckpoint). Together
 *                                 with the index, this is what lets
 *                                 open() skip both re-decrypting and
 *                                 re-folding a room's old history: restore
 *                                 the checkpoint's state and id-set
 *                                 directly, decrypt only the file's tail
 *                                 (found via the index), fold only that
 *                                 tail onto the checkpoint's state
 *                                 (foldFrom, O(new events) — see fold.js).
 *
 * Without a checkpoint (first open, or one that's missing/stale/corrupt)
 * this falls back to the original behaviour: _scanFromOPFS decrypts the
 * whole file once to rebuild cursor/count/dedup-set, and the caller folds
 * the whole history with fold(). The fast path is a pure optimization: a
 * store that never reaches it is exactly as correct as one that always
 * takes it, just slower on room open at scale. getFoldBasis() is written
 * so a caller (main.js's openRoom) never has to know which path ran.
 *
 * v1 (unencrypted) files from before this change are silently dropped
 * on open — the room re-downloads from the server.
 *
 * Vault must be unlocked before open(). If the vault is locked or
 * absent the store falls back to in-memory only (no persistence) so
 * the UI still works on a fresh device that has not unlocked yet.
 */

import { packBatch, unpackAll, unpackSince, HEADER_SIZE, fnv1a32, fnv1a64 } from './pack.js';
import { parseEventType } from './operators.js';
import { vault } from './vault.js';

const MAGIC = new Uint8Array([0x4D, 0x58, 0x45, 0x56]);
const VERSION = 2;
const LEGACY_VERSION = 1;
const CHECKPOINT_INTERVAL = 200;
const IV_BYTES = 12;
const CHUNK_HEADER_BYTES = IV_BYTES + 4;

// One offset-index mark every this many events, independent of write-batch
// size — a bulk import of 50,000 events in one call advances the count by
// 50,000 and gets exactly the marks that interval implies, never one mark
// per write; many single-event live edits eventually cross the same
// boundaries just as surely, just over more calls. This is what keeps the
// index small (~total events / this constant) regardless of how ragged the
// real write pattern is. 1000 was chosen to keep a million-event room's
// index at ~1000 entries (14KB plaintext, trivial to decrypt as one blob)
// while keeping the worst-case post-checkpoint tail-decrypt bounded to a
// few thousand events even when a checkpoint is somewhat stale.
const INDEX_EVENT_INTERVAL = 1000;
// eventCount(4) + tsHi(2) + tsLo(4) + byteOffset(4)
const INDEX_ENTRY_SIZE = 14;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let opfsAvailable = null;
async function checkOPFS() {
  if (opfsAvailable !== null) return opfsAvailable;
  try {
    const root = await navigator.storage.getDirectory();
    const probe = await root.getFileHandle('__probe__', { create: true });
    await root.removeEntry('__probe__');
    opfsAvailable = true;
  } catch {
    opfsAvailable = false;
  }
  return opfsAvailable;
}

/**
 * Ask the browser to make this origin's storage persistent. By default OPFS
 * and IndexedDB are "best-effort" and the browser may evict them under
 * storage pressure or when the last tab closes — which for a database app
 * means the local copy of your data can vanish on tab close. A granted
 * persist() exempts the origin from that automatic eviction (it can still
 * be cleared by the user explicitly). Idempotent and best-effort: returns
 * `{ supported, persisted }`, never throws.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return { supported: false, persisted: false };
    const already = navigator.storage.persisted
      ? await navigator.storage.persisted()
      : false;
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: !!granted };
  } catch (e) {
    return { supported: false, persisted: false, error: e?.message || String(e) };
  }
}

function roomFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}.bin`;
}

function checkpointFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}_checkpoint.bin`;
}

function indexFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}_index.bin`;
}

function makeHeader(namespace) {
  const nsBytes = encoder.encode(namespace);
  const buf = new ArrayBuffer(8 + nsBytes.length);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr.set(MAGIC, 0);
  view.setUint16(4, VERSION);
  view.setUint16(6, nsBytes.length);
  arr.set(nsBytes, 8);
  return arr;
}

function parseHeader(data) {
  if (data.length < 8) return null;
  if (data[0] !== 0x4D || data[1] !== 0x58 || data[2] !== 0x45 || data[3] !== 0x56) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint16(4);
  const nsLen = view.getUint16(6);
  if (data.length < 8 + nsLen) return null;
  const namespace = decoder.decode(data.subarray(8, 8 + nsLen));
  return { version, namespace, headerSize: 8 + nsLen };
}

/** Decrypt every chunk in the given bytes into one contiguous plaintext.
 *  Takes the chunk STREAM starting at any chunk boundary — the caller
 *  decides whether that's the whole file body (full scan) or a tail
 *  found via the offset index (fast open). */
async function decryptAllChunks(body) {
  if (!body || body.length === 0) return new Uint8Array(0);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const parts = [];
  let offset = 0;
  while (offset + CHUNK_HEADER_BYTES <= body.length) {
    const iv = body.subarray(offset, offset + IV_BYTES);
    const ctLen = view.getUint32(offset + IV_BYTES);
    const ctStart = offset + CHUNK_HEADER_BYTES;
    const ctEnd = ctStart + ctLen;
    if (ctEnd > body.length) break;
    // Re-pack [iv][ct] as the format vault.decryptBytes expects.
    const blob = new Uint8Array(IV_BYTES + ctLen);
    blob.set(iv, 0);
    blob.set(body.subarray(ctStart, ctEnd), IV_BYTES);
    try {
      const plain = await vault.decryptBytes(blob);
      parts.push(plain);
    } catch (e) {
      console.warn('[store] chunk decrypt failed at offset', offset, e?.message || e);
    }
    offset = ctEnd;
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function encryptChunk(plaintext) {
  // vault.encryptBytes returns [iv][ct]. Repackage with explicit
  // length prefix so the file remains parseable without re-decrypting.
  const blob = await vault.encryptBytes(plaintext);
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES);
  const out = new Uint8Array(CHUNK_HEADER_BYTES + ct.length);
  out.set(iv, 0);
  new DataView(out.buffer).setUint32(IV_BYTES, ct.length);
  out.set(ct, CHUNK_HEADER_BYTES);
  return out;
}

/** Pack the in-memory index (array of {eventCount, ts, byteOffset}) into
 *  fixed-size records. Exported for tests — production code only ever
 *  reaches it through EventStore's own save/load pair. */
export function packIndexEntries(entries) {
  const buf = new ArrayBuffer(entries.length * INDEX_ENTRY_SIZE);
  const view = new DataView(buf);
  entries.forEach((entry, i) => {
    const o = i * INDEX_ENTRY_SIZE;
    view.setUint32(o, entry.eventCount);
    const tsHi = (entry.ts / 0x100000000) & 0xFFFF;
    const tsLo = entry.ts >>> 0;
    view.setUint16(o + 4, tsHi);
    view.setUint32(o + 6, tsLo);
    view.setUint32(o + 10, entry.byteOffset);
  });
  return new Uint8Array(buf);
}

/** Inverse of packIndexEntries. */
export function unpackIndexEntries(bytes) {
  const out = [];
  if (!bytes || bytes.length < INDEX_ENTRY_SIZE) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 0; o + INDEX_ENTRY_SIZE <= bytes.length; o += INDEX_ENTRY_SIZE) {
    const eventCount = view.getUint32(o);
    const tsHi = view.getUint16(o + 4);
    const tsLo = view.getUint32(o + 6);
    const byteOffset = view.getUint32(o + 10);
    out.push({ eventCount, ts: tsHi * 0x100000000 + tsLo, byteOffset });
  }
  return out;
}

export class EventStore {
  constructor(roomId, namespace) {
    this.roomId = roomId;
    this.namespace = namespace;
    this.fileName = roomFileName(roomId);
    this.checkpointName = checkpointFileName(roomId);
    this.indexName = indexFileName(roomId);

    this._headerSize = 0;
    this._cursor = 0;
    this._count = 0;
    this._byteSize = 0;
    this._eventIdSet = null;
    this._useOPFS = false;
    this._dirHandle = null;
    this._fileHandle = null;
    this._appendsSinceCheckpoint = 0;
    this._appendQueue = Promise.resolve();
    this._encrypted = false;

    // Offset-index bookkeeping (see the file header comment).
    this._index = [];
    this._pendingIndexSave = false;
    // Set by the fast-open path (_tryFastOpen) when it succeeds; consumed
    // by getFoldBasis(). null means "no usable checkpoint — caller folds
    // from scratch", which is also the correct state before open() runs
    // and after clear().
    this._checkpointState = null;
    this._tailFoldEvents = null;
    // Set by _scanFromOPFS (the full-scan path) once it has already paid
    // for decrypting and unpacking the whole file — getAll() reuses it
    // instead of decrypting a second time. Invalidated (null) by anything
    // that could make it stale: an append, or clear(). Only the full-scan
    // path populates this; the fast-open path never has "all events" in
    // hand, by design, so getAll() after a fast open still reads fresh —
    // correct, just not the thing this cache speeds up.
    this._scannedEvents = null;
  }

  async open() {
    this._useOPFS = await checkOPFS();
    this._eventIdSet = new Set();

    if (!vault.isUnlocked()) {
      // No vault key — refuse to touch OPFS files so we don't write
      // unencrypted data or corrupt encrypted ones. The room still
      // functions, just without persistence until unlocked.
      console.warn('[store] vault locked — running in memory-only mode');
      this._useOPFS = false;
      return this;
    }

    if (this._useOPFS) {
      try {
        this._dirHandle = await navigator.storage.getDirectory();
        const fast = await this._tryFastOpen();
        if (!fast) await this._scanFromOPFS();
      } catch (e) {
        console.warn('[store] OPFS open failed:', e);
        this._useOPFS = false;
      }
    }

    return this;
  }

  /**
   * Fast open: restore bookkeeping and folded state from a checkpoint +
   * offset index instead of decrypting the whole file. Returns true when
   * this succeeded (open() then skips _scanFromOPFS entirely); false when
   * there is no usable checkpoint/index — the caller falls back to the
   * original full scan, and that scan's own results are what the NEXT
   * open() will find a checkpoint for, once one is saved.
   *
   * Deliberately conservative: any doubt (missing index, checkpoint count
   * beyond what the index has recorded, a decrypt failure) returns false
   * rather than risk restoring a state that doesn't match the log.
   */
  async _tryFastOpen() {
    let fileHandle;
    try {
      fileHandle = await this._dirHandle.getFileHandle(this.fileName);
    } catch {
      return false; // no data file yet — nothing to fast-open
    }
    const file = await fileHandle.getFile();
    if (file.size === 0) return false;

    // Read just the header — a bounded, small slice, never the whole file
    // however large it's grown. Blob#slice is a view, not a copy; only the
    // bytes actually read cost anything.
    const headBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 256)).arrayBuffer());
    const header = parseHeader(headBytes);
    if (!header || header.version !== VERSION) return false; // legacy/corrupt — let the full scan decide

    const checkpoint = await this.loadCheckpoint();
    if (!checkpoint) return false;

    const index = await this._loadIndex();
    if (!index.length) return false; // no marks recorded — checkpoint predates the index, or it's missing

    if (checkpoint.count > index[index.length - 1].eventCount + INDEX_EVENT_INTERVAL) {
      // The checkpoint claims to be further along than the index has any
      // record of, by more than one interval's slack — inconsistent state,
      // don't trust it.
      console.warn('[store] checkpoint ahead of index — falling back to full scan');
      return false;
    }

    // The last mark at or before the checkpoint's own count: a byte offset
    // we know is safe to decrypt FROM, even though it may be slightly
    // earlier than the checkpoint (marks land every INDEX_EVENT_INTERVAL,
    // checkpoints every CHECKPOINT_INTERVAL — different cadences by
    // design, see their own constants). Events between the mark and the
    // checkpoint are re-encountered during the tail walk below and
    // correctly recognized as already-counted via the restored dedup set.
    let markOffset = header.headerSize;
    for (const entry of index) {
      if (entry.eventCount <= checkpoint.count) markOffset = entry.byteOffset;
      else break;
    }

    let tailPlain;
    try {
      const tailBody = new Uint8Array(await file.slice(markOffset).arrayBuffer());
      tailPlain = await decryptAllChunks(tailBody);
    } catch (e) {
      console.warn('[store] fast-open tail decrypt failed:', e);
      return false;
    }

    this._headerSize = header.headerSize;
    this._fileHandle = fileHandle;
    this._byteSize = file.size;
    this._encrypted = true;
    this._index = index;

    // Restore bookkeeping from the checkpoint, then advance over the tail —
    // the same per-event header walk _scanFromOPFS uses, just starting from
    // the checkpoint's own counts instead of zero, and skipping anything
    // the dedup set already recognizes (the mark-vs-checkpoint slack above).
    this._eventIdSet = checkpoint.eventIdSet;
    this._cursor = checkpoint.cursor;
    this._count = checkpoint.count;

    if (tailPlain.length) {
      const view = new DataView(tailPlain.buffer, tailPlain.byteOffset, tailPlain.byteLength);
      let offset = 0;
      while (offset + HEADER_SIZE <= tailPlain.length) {
        const tsHi = view.getUint16(offset + 2);
        const tsLo = view.getUint32(offset + 4);
        const ts = tsHi * 0x100000000 + tsLo;
        const eidLo = view.getUint32(offset + 8);
        const eidHi = view.getUint32(offset + 12);
        const key = `${eidLo}:${eidHi}`;
        const bodyLength = view.getUint32(offset + 20);
        if (offset + HEADER_SIZE + bodyLength > tailPlain.length) break;

        if (!this._eventIdSet.has(key)) {
          this._eventIdSet.add(key);
          if (ts > this._cursor) this._cursor = ts;
          this._count++;
        }
        offset += HEADER_SIZE + bodyLength;
      }
    }

    // The fold basis: the checkpoint's own folded state, plus only the
    // events strictly after its cursor (unpackSince, reused as-is — this
    // is exactly the "skip body-decode for anything already covered"
    // query it already exists for, just run against the tail bytes we
    // already have in memory instead of the whole file).
    this._checkpointState = checkpoint.state;
    this._tailFoldEvents = tailPlain.length
      ? unpackSince(tailPlain, this.namespace, checkpoint.cursor + 1).map(EventStore._unwrap)
      : [];

    return true;
  }

  /**
   * Decrypt every chunk in the file once and rebuild the dedup set,
   * cursor, and count. Body decode is required to walk per-event
   * headers (the headers live inside the encrypted chunks, not in the
   * clear). The fallback path when _tryFastOpen can't run — see the file
   * header comment for when that is.
   */
  async _scanFromOPFS() {
    let fileHandle;
    try {
      fileHandle = await this._dirHandle.getFileHandle(this.fileName);
    } catch {
      return;
    }

    const file = await fileHandle.getFile();
    if (file.size === 0) return;

    const raw = new Uint8Array(await file.arrayBuffer());
    const header = parseHeader(raw);
    if (!header) {
      console.warn('[store] invalid file header — discarding');
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      return;
    }

    if (header.version === LEGACY_VERSION) {
      console.warn('[store] unencrypted legacy file — discarding (will re-sync from server)');
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      try { await this._dirHandle.removeEntry(this.checkpointName); } catch {}
      // Older checkpoints used .json; remove that too in case it lingers.
      try { await this._dirHandle.removeEntry(this.checkpointName.replace('.bin', '.json')); } catch {}
      return;
    }

    if (header.version !== VERSION) {
      console.warn('[store] unknown file version', header.version, '— discarding');
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      return;
    }

    this._headerSize = header.headerSize;
    this._fileHandle = fileHandle;
    this._byteSize = file.size;
    this._encrypted = true;

    const body = raw.subarray(header.headerSize);
    const plain = await decryptAllChunks(body);
    if (plain.length === 0) return;

    // getAll() right after open() (main.js's openRoom does exactly this)
    // would otherwise decrypt this same file a second time from scratch —
    // unpackAll on already-decrypted plaintext is cheap; the AES-GCM work
    // above is what actually costs, and it's already paid for.
    this._scannedEvents = unpackAll(plain, this.namespace).map(EventStore._unwrap);

    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    let offset = 0;
    while (offset + HEADER_SIZE <= plain.length) {
      const tsHi = view.getUint16(offset + 2);
      const tsLo = view.getUint32(offset + 4);
      const ts = tsHi * 0x100000000 + tsLo;

      const eidLo = view.getUint32(offset + 8);
      const eidHi = view.getUint32(offset + 12);
      this._eventIdSet.add(`${eidLo}:${eidHi}`);

      const bodyLength = view.getUint32(offset + 20);
      if (offset + HEADER_SIZE + bodyLength > plain.length) break;

      if (ts > this._cursor) this._cursor = ts;
      this._count++;
      offset += HEADER_SIZE + bodyLength;
    }

    // Rebuild the offset index too while we're already paying for the full
    // decrypt above, so the NEXT open (once a checkpoint is saved) has one
    // to use. This re-walks the still-encrypted body against real chunk
    // boundaries (distinct from the plaintext walk just above, since a
    // mark's byte offset must point at a CHUNK start, and plaintext offsets
    // don't map 1:1 to ciphertext ones).
    await this._reindexChunks(body, header.headerSize);
  }

  /**
   * Rebuild the offset index against REAL chunk boundaries: decrypt each
   * chunk, count its events, and emit an index mark at the start of the
   * first chunk whose cumulative event count crosses each
   * INDEX_EVENT_INTERVAL boundary. Only runs after a full scan (open()'s
   * fallback path), so this is O(events) exactly once — the thing the fast
   * path exists to avoid on every SUBSEQUENT open.
   */
  async _reindexChunks(body, headerSize) {
    this._index = [];
    if (!body || body.length === 0) return;
    const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    let runningCount = 0;
    let runningTs = 0;
    let lastMarked = 0;
    while (o + CHUNK_HEADER_BYTES <= body.length) {
      const chunkStart = headerSize + o;
      const iv = body.subarray(o, o + IV_BYTES);
      const ctLen = bodyView.getUint32(o + IV_BYTES);
      const ctStart = o + CHUNK_HEADER_BYTES;
      const ctEnd = ctStart + ctLen;
      if (ctEnd > body.length) break;

      const blob = new Uint8Array(IV_BYTES + ctLen);
      blob.set(iv, 0);
      blob.set(body.subarray(ctStart, ctEnd), IV_BYTES);
      let chunkPlain;
      try {
        chunkPlain = await vault.decryptBytes(blob);
      } catch {
        break;
      }

      const pv = chunkPlain.length >= HEADER_SIZE
        ? new DataView(chunkPlain.buffer, chunkPlain.byteOffset, chunkPlain.byteLength)
        : null;
      let po = 0;
      let sawEventInChunk = false;
      while (pv && po + HEADER_SIZE <= chunkPlain.length) {
        const tsHi = pv.getUint16(po + 2);
        const tsLo = pv.getUint32(po + 4);
        const ts = tsHi * 0x100000000 + tsLo;
        const bodyLength = pv.getUint32(po + 20);
        if (po + HEADER_SIZE + bodyLength > chunkPlain.length) break;
        runningCount++;
        if (ts > runningTs) runningTs = ts;
        sawEventInChunk = true;
        po += HEADER_SIZE + bodyLength;
      }

      if (sawEventInChunk && runningCount - lastMarked >= INDEX_EVENT_INTERVAL) {
        this._index.push({ eventCount: runningCount, ts: runningTs, byteOffset: chunkStart });
        lastMarked = runningCount;
      }

      o = ctEnd;
    }

    await this._saveIndex();
  }

  async append(matrixEvents) {
    const result = this._appendQueue.then(() => this._doAppend(matrixEvents));
    this._appendQueue = result.catch(() => {});
    return result;
  }

  async _doAppend(matrixEvents) {
    const toPack = [];
    const forFold = [];

    for (const event of matrixEvents) {
      const type = typeof event.getType === 'function' ? event.getType() : event.type;
      const content = typeof event.getContent === 'function' ? event.getContent() : event.content;
      const ts = typeof event.getTs === 'function' ? event.getTs() : event.origin_server_ts || 0;
      const sender = typeof event.getSender === 'function' ? event.getSender() : event.sender;
      const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id || '';

      const op = parseEventType(type);
      if (!op) continue;
      if (!content || Object.keys(content).length === 0) continue;

      const [eidLo, eidHi] = fnv1a64(eventId);
      const key = `${eidLo}:${eidHi}`;
      if (this._eventIdSet.has(key)) continue;

      toPack.push({ opOrder: op.order, ts, eventId, sender,
        content: { _c: content, _s: sender, _e: eventId },
      });
      forFold.push({ type, content, origin_server_ts: ts, sender, event_id: eventId });

      this._eventIdSet.add(key);
      if (ts > this._cursor) this._cursor = ts;
    }

    if (toPack.length === 0) return [];

    const packed = packBatch(toPack);
    this._count += toPack.length;
    this._appendsSinceCheckpoint += toPack.length;
    this._scannedEvents = null; // stale the instant new events land — see getAll()
    // getFoldBasis()'s tail is a running total, not a one-time snapshot: if
    // the fast-open path is active (_tailFoldEvents non-null), every batch
    // accepted here must extend it, the same way main.js's own roomEvents
    // is extended by concatenation on every append. Caught by
    // scratch-verify-store.mjs: without this, getFoldBasis() called after
    // ANY post-open append silently returned the tail as it was AT OPEN
    // TIME, missing every event appended since.
    if (this._tailFoldEvents) this._tailFoldEvents = this._tailFoldEvents.concat(forFold);

    if (this._useOPFS && vault.isUnlocked()) {
      try {
        await this._writeToOPFS(packed);
        if (this._pendingIndexSave) {
          this._pendingIndexSave = false;
          await this._saveIndex();
        }
      } catch (e) {
        console.warn('[store] OPFS write failed:', e);
      }
    }

    return forFold;
  }

  async _writeToOPFS(newBytes) {
    const chunk = await encryptChunk(newBytes);

    if (!this._fileHandle) {
      this._fileHandle = await this._dirHandle.getFileHandle(this.fileName, { create: true });
      const header = makeHeader(this.namespace);
      this._headerSize = header.length;

      const writable = await this._fileHandle.createWritable();
      await writable.write(header);
      await writable.write(chunk);
      await writable.close();
      this._byteSize = header.length + chunk.length;
      this._encrypted = true;
      this._maybeMarkIndex(header.length);
    } else {
      const file = await this._fileHandle.getFile();
      const writable = await this._fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(file.size);
      await writable.write(chunk);
      await writable.close();
      this._maybeMarkIndex(file.size);
      this._byteSize = file.size + chunk.length;
    }
  }

  /** Record one index mark at `chunkStartOffset` (the byte position this
   *  chunk STARTS at, before it was written) if `_count` — already updated
   *  by _doAppend before _writeToOPFS runs — has crossed a new
   *  INDEX_EVENT_INTERVAL boundary since the last mark. Never more than one
   *  mark per write call, whatever the batch size: a single mark covers a
   *  whole bulk-import batch that crosses many boundaries at once, and a
   *  string of one-event live edits accumulates marks one per crossing,
   *  same as any other write pattern would. */
  _maybeMarkIndex(chunkStartOffset) {
    const lastMarked = this._index.length ? this._index[this._index.length - 1].eventCount : 0;
    if (this._count - lastMarked < INDEX_EVENT_INTERVAL) return;
    this._index.push({ eventCount: this._count, ts: this._cursor, byteOffset: chunkStartOffset });
    this._pendingIndexSave = true;
  }

  async _loadIndex() {
    if (!this._dirHandle) return [];
    try {
      const handle = await this._dirHandle.getFileHandle(this.indexName);
      const file = await handle.getFile();
      if (file.size === 0) return [];
      const bytes = new Uint8Array(await file.arrayBuffer());
      const plain = await vault.decryptBytes(bytes);
      return unpackIndexEntries(plain);
    } catch {
      return [];
    }
  }

  async _saveIndex() {
    if (!this._useOPFS || !this._dirHandle) return;
    if (!vault.isUnlocked()) return;
    try {
      const packed = packIndexEntries(this._index);
      const payload = await vault.encryptBytes(packed);
      const handle = await this._dirHandle.getFileHandle(this.indexName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
    } catch (e) {
      console.warn('[store] index save failed:', e);
    }
  }

  async getAll() {
    if (this._scannedEvents) return this._scannedEvents;
    const data = await this._readDecryptedBody();
    if (!data || data.length === 0) return [];
    return unpackAll(data, this.namespace).map(EventStore._unwrap);
  }

  async getEventsSince(sinceTs) {
    const data = await this._readDecryptedBody();
    if (!data || data.length === 0) return [];
    return unpackSince(data, this.namespace, sinceTs).map(EventStore._unwrap);
  }

  /**
   * The basis for this room's current fold WITHOUT re-folding all of its
   * history on every call: { checkpointState, tailEvents }. When open()'s
   * fast path ran, checkpointState is the last-saved folded state and
   * tailEvents are only the events after it — the caller does
   * foldFrom(checkpointState, tailEvents), O(new events). When it didn't
   * (first-ever open, or a missing/stale checkpoint), checkpointState is
   * null and tailEvents is the FULL history via getAll() — the caller
   * folds from scratch exactly as it always has: fold(tailEvents).
   * Either way the caller's own code doesn't need to know which path ran.
   */
  async getFoldBasis() {
    if (this._checkpointState) {
      return { checkpointState: this._checkpointState, tailEvents: this._tailFoldEvents || [] };
    }
    const all = await this.getAll();
    return { checkpointState: null, tailEvents: all };
  }

  async _readDecryptedBody() {
    if (!this._useOPFS || !this._fileHandle) return null;
    if (!vault.isUnlocked()) return null;
    try {
      const file = await this._fileHandle.getFile();
      if (file.size <= this._headerSize) return null;
      const raw = new Uint8Array(await file.arrayBuffer());
      const body = raw.subarray(this._headerSize);
      return await decryptAllChunks(body);
    } catch (e) {
      console.warn('[store] read failed:', e);
      return null;
    }
  }

  static _unwrap(e) {
    if (e.content && e.content._c !== undefined) {
      return {
        type: e.type,
        content: e.content._c,
        origin_server_ts: e.origin_server_ts,
        sender: e.content._s || null,
        event_id: e.content._e || null,
      };
    }
    return e;
  }

  /**
   * Persist the current folded state AND the dedup id-set at this store's
   * current cursor/count. Both are what let a later open() skip straight
   * past the history this checkpoint covers — see getFoldBasis and
   * _tryFastOpen. `state` is the caller's folded application state
   * (fold.js's FoldState); _violations is stripped since it's re-derived
   * on replay, not data.
   */
  async saveCheckpoint(state) {
    if (!this._useOPFS || !this._dirHandle) return;
    if (!vault.isUnlocked()) return;
    try {
      const clean = { ...state, _violations: [] };
      const payload = await vault.encryptJSON({
        cursor: this._cursor,
        count: this._count,
        savedAt: Date.now(),
        state: clean,
        // Packed as a plain array — this IS the thing that lets the next
        // open skip decrypting every event body just to rebuild dedup.
        eventIds: [...this._eventIdSet],
      });
      const handle = await this._dirHandle.getFileHandle(this.checkpointName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
      this._appendsSinceCheckpoint = 0;
    } catch (e) {
      console.warn('[store] Checkpoint save failed:', e);
    }
  }

  /**
   * Load the persisted checkpoint, with its dedup set unpacked back into a
   * real Set. No freshness check against `this._cursor` here on purpose —
   * this is now called from _tryFastOpen BEFORE any scan has set _cursor,
   * so "checkpoint.cursor > this._cursor" would misfire on every valid
   * checkpoint. _tryFastOpen validates it against the offset index instead
   * (see there). Returns null on any read/decrypt failure — never throws.
   */
  async loadCheckpoint() {
    if (!this._useOPFS || !this._dirHandle) return null;
    if (!vault.isUnlocked()) return null;
    try {
      const handle = await this._dirHandle.getFileHandle(this.checkpointName);
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const obj = await vault.decryptJSON(bytes);
      return { ...obj, eventIdSet: new Set(obj.eventIds || []) };
    } catch {
      return null;
    }
  }

  shouldCheckpoint() {
    return this._appendsSinceCheckpoint >= CHECKPOINT_INTERVAL;
  }

  getCursor()   { return this._cursor; }
  getCount()    { return this._count; }
  getByteSize() { return this._byteSize; }
  hasData()     { return this._count > 0; }

  async clear() {
    this._cursor = 0;
    this._count = 0;
    this._byteSize = 0;
    this._eventIdSet = new Set();
    this._fileHandle = null;
    this._appendsSinceCheckpoint = 0;
    this._index = [];
    this._pendingIndexSave = false;
    this._checkpointState = null;
    this._tailFoldEvents = null;
    this._scannedEvents = null;
    if (this._useOPFS && this._dirHandle) {
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      try { await this._dirHandle.removeEntry(this.checkpointName); } catch {}
      try { await this._dirHandle.removeEntry(this.indexName); } catch {}
    }
  }
}

export async function listStoredRooms() {
  if (!await checkOPFS()) return [];
  const dir = await navigator.storage.getDirectory();
  const names = [];
  for await (const [name] of dir) {
    if (name.startsWith('room_') && name.endsWith('.bin') && !name.endsWith('_checkpoint.bin') && !name.endsWith('_index.bin')) {
      names.push(name);
    }
  }
  return names;
}

export async function getStorageUsage() {
  if (!await checkOPFS()) return { files: 0, bytes: 0 };
  const dir = await navigator.storage.getDirectory();
  let files = 0, bytes = 0;
  for await (const [name, handle] of dir) {
    if (name.startsWith('room_') && name.endsWith('.bin')) {
      files++;
      bytes += (await handle.getFile()).size;
    }
  }
  return { files, bytes };
}

/**
 * Walk the OPFS root once and bucket every file by what produced it, so the
 * UI can show where the local copy of a workspace actually lives:
 *   - room        — per-room append-only event logs (room_*.bin)
 *   - checkpoint  — folded-state snapshots (room_*_checkpoint.bin)
 *   - index       — offset indexes (room_*_index.bin)
 *   - media       — vault-encrypted media mirror (imported dataset blobs,
 *                   uploaded files) keyed by mxc (media_*)
 *   - other       — anything else this origin parked in OPFS
 *
 * Returns byte + file counts per bucket plus a grand total. Best-effort:
 * resolves to all-zeros when OPFS is unavailable rather than throwing.
 */
export async function getOpfsBreakdown() {
  const empty = () => ({ files: 0, bytes: 0 });
  const out = {
    room: empty(), checkpoint: empty(), index: empty(), media: empty(), other: empty(),
    totalFiles: 0, totalBytes: 0,
  };
  if (!await checkOPFS()) return out;
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const [name, handle] of dir) {
      let size = 0;
      try { size = (await handle.getFile()).size; } catch { continue; }
      let bucket = out.other;
      if (name.startsWith('room_') && name.endsWith('_checkpoint.bin')) bucket = out.checkpoint;
      else if (name.startsWith('room_') && name.endsWith('_index.bin'))  bucket = out.index;
      else if (name.startsWith('room_') && name.endsWith('.bin'))        bucket = out.room;
      else if (name.startsWith('media_'))                                 bucket = out.media;
      bucket.files++;
      bucket.bytes += size;
      out.totalFiles++;
      out.totalBytes += size;
    }
  } catch (e) {
    console.warn('[store] OPFS breakdown failed:', e?.message || e);
  }
  return out;
}

/**
 * Measure the Cache Storage (Service Worker app-shell cache) footprint.
 *
 * This is part of "what this app holds locally" but lives outside OPFS, so
 * getOpfsBreakdown never sees it — the sync page would otherwise undercount
 * the real on-device total. Sizes come from each cached response's
 * Content-Length header (the SW only caches same-origin `basic` responses,
 * which carry it); we avoid reading bodies so this stays cheap enough to call
 * on the sync page's refresh interval. Best-effort: resolves to zeros when the
 * Cache API is unavailable rather than throwing.
 */
export async function getCacheStorageUsage() {
  const out = { bytes: 0, entries: 0, caches: [] };
  if (typeof caches === 'undefined') return out;
  try {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const reqs = await cache.keys();
      let bytes = 0;
      for (const req of reqs) {
        try {
          const resp = await cache.match(req);
          if (!resp) continue;
          const len = resp.headers.get('content-length');
          if (len) bytes += parseInt(len, 10) || 0;
          else { try { bytes += (await resp.clone().blob()).size; } catch {} }
        } catch {}
      }
      out.caches.push({ name, entries: reqs.length, bytes });
      out.bytes += bytes;
      out.entries += reqs.length;
    }
  } catch (e) {
    console.warn('[store] cache-storage measure failed:', e?.message || e);
  }
  return out;
}

/**
 * Wipe every room file and checkpoint from OPFS. Called on logout.
 */
export async function wipeAllRoomData() {
  if (!await checkOPFS()) return;
  const dir = await navigator.storage.getDirectory();
  const toRemove = [];
  for await (const [name] of dir) {
    if (name.startsWith('room_') && (name.endsWith('.bin') || name.endsWith('.json'))) {
      toRemove.push(name);
    }
  }
  for (const n of toRemove) {
    try { await dir.removeEntry(n); } catch {}
  }
}
