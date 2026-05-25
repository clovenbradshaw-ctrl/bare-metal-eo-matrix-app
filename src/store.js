/**
 * store.js — OPFS persistence layer
 *
 * Binary append-only event store. One file per room.
 * OPFS is the Given-Log. No in-memory duplicate.
 *
 * Write path (live):  append() → pack → OPFS write → return forFold objects
 * Read path (cold):   getAll() / getEventsSince() → OPFS read → unpack
 * Fold path (live):   caller does foldFrom(state, append()'s return value)
 *
 * The file IS the database. The fold output IS the projected state.
 * Nothing else exists.
 */

import { packBatch, unpackAll, unpackSince, scanMeta, HEADER_SIZE, fnv1a32, fnv1a64 } from './pack.js';
import { parseEventType } from './operators.js';

const MAGIC = new Uint8Array([0x4D, 0x58, 0x45, 0x56]); // "MXEV"
const VERSION = 1;
const CHECKPOINT_INTERVAL = 200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── OPFS availability ──

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

// ── Room file naming ──

function roomFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}.bin`;
}

function checkpointFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}_checkpoint.json`;
}

// ── File header ──

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

// ── Store class ──

export class EventStore {
  constructor(roomId, namespace) {
    this.roomId = roomId;
    this.namespace = namespace;
    this.fileName = roomFileName(roomId);
    this.checkpointName = checkpointFileName(roomId);

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
  }

  async open() {
    this._useOPFS = await checkOPFS();
    this._eventIdSet = new Set();

    if (this._useOPFS) {
      try {
        this._dirHandle = await navigator.storage.getDirectory();
        await this._scanFromOPFS();
      } catch (e) {
        console.warn('[store] OPFS open failed:', e);
        this._useOPFS = false;
      }
    }

    return this;
  }

  /**
   * Scan the OPFS file: read headers only to build the dedup set,
   * cursor, and count. No body decode. No in-memory copy.
   */
  async _scanFromOPFS() {
    let fileHandle;
    try {
      fileHandle = await this._dirHandle.getFileHandle(this.fileName);
    } catch {
      return; // No file yet — fresh room
    }

    const file = await fileHandle.getFile();
    if (file.size === 0) return;

    const raw = new Uint8Array(await file.arrayBuffer());
    const header = parseHeader(raw);
    if (!header) {
      console.warn('[store] Invalid file header');
      return;
    }

    this._headerSize = header.headerSize;
    this._fileHandle = fileHandle;
    this._byteSize = file.size;

    // Scan event headers for dedup set + metadata
    const events = raw.subarray(header.headerSize);
    const view = new DataView(events.buffer, events.byteOffset, events.byteLength);
    let offset = 0;
    while (offset + HEADER_SIZE <= events.length) {
      const tsHi = view.getUint16(offset + 2);
      const tsLo = view.getUint32(offset + 4);
      const ts = tsHi * 0x100000000 + tsLo;

      const eidLo = view.getUint32(offset + 8);
      const eidHi = view.getUint32(offset + 12);
      this._eventIdSet.add(`${eidLo}:${eidHi}`);

      const bodyLength = view.getUint32(offset + 20);
      if (offset + HEADER_SIZE + bodyLength > events.length) break;

      if (ts > this._cursor) this._cursor = ts;
      this._count++;
      offset += HEADER_SIZE + bodyLength;
    }
  }

  // ── Write path ──

  /**
   * Append new events. Serialized via queue.
   * Returns plain event objects for foldFrom() — the ONLY thing
   * the caller needs. No buffer, no re-read.
   */
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

    if (this._useOPFS) {
      try {
        await this._writeToOPFS(packed);
      } catch (e) {
        console.warn('[store] OPFS write failed:', e);
      }
    }

    return forFold;
  }

  async _writeToOPFS(newBytes) {
    if (!this._fileHandle) {
      // First write — create file with header
      this._fileHandle = await this._dirHandle.getFileHandle(this.fileName, { create: true });
      const header = makeHeader(this.namespace);
      this._headerSize = header.length;

      const writable = await this._fileHandle.createWritable();
      await writable.write(header);
      await writable.write(newBytes);
      await writable.close();
      this._byteSize = header.length + newBytes.length;
    } else {
      // Append to existing file
      const file = await this._fileHandle.getFile();
      const writable = await this._fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(file.size);
      await writable.write(newBytes);
      await writable.close();
      this._byteSize = file.size + newBytes.length;
    }
  }

  // ── Read path (cold start only) ──

  /**
   * Read the OPFS file once, unpack all events.
   * Called once on cold start when no checkpoint exists.
   */
  async getAll() {
    const data = await this._readEventsFromFile();
    if (!data || data.length === 0) return [];
    return unpackAll(data, this.namespace).map(EventStore._unwrap);
  }

  /**
   * Read the OPFS file once, unpack events after sinceTs.
   * Called once on cold start for checkpoint delta.
   */
  async getEventsSince(sinceTs) {
    const data = await this._readEventsFromFile();
    if (!data || data.length === 0) return [];
    return unpackSince(data, this.namespace, sinceTs).map(EventStore._unwrap);
  }

  async _readEventsFromFile() {
    if (!this._useOPFS || !this._fileHandle) return null;
    try {
      const file = await this._fileHandle.getFile();
      if (file.size <= this._headerSize) return null;
      const raw = new Uint8Array(await file.arrayBuffer());
      return raw.subarray(this._headerSize);
    } catch {
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

  // ── Checkpoint ──

  async saveCheckpoint(state) {
    if (!this._useOPFS || !this._dirHandle) return;
    try {
      const clean = { ...state, _violations: [] };
      const handle = await this._dirHandle.getFileHandle(this.checkpointName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify({
        cursor: this._cursor,
        count: this._count,
        savedAt: Date.now(),
        state: clean,
      }));
      await writable.close();
      this._appendsSinceCheckpoint = 0;
    } catch (e) {
      console.warn('[store] Checkpoint save failed:', e);
    }
  }

  async loadCheckpoint() {
    if (!this._useOPFS || !this._dirHandle) return null;
    try {
      const handle = await this._dirHandle.getFileHandle(this.checkpointName);
      const file = await handle.getFile();
      const text = await file.text();
      const checkpoint = JSON.parse(text);
      if (checkpoint.cursor > this._cursor) {
        console.warn('[store] Checkpoint cursor ahead of log — discarding');
        return null;
      }
      return checkpoint;
    } catch {
      return null;
    }
  }

  shouldCheckpoint() {
    return this._appendsSinceCheckpoint >= CHECKPOINT_INTERVAL;
  }

  // ── Accessors ──

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
    if (this._useOPFS && this._dirHandle) {
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      try { await this._dirHandle.removeEntry(this.checkpointName); } catch {}
    }
  }
}

export async function listStoredRooms() {
  if (!await checkOPFS()) return [];
  const dir = await navigator.storage.getDirectory();
  const names = [];
  for await (const [name] of dir) {
    if (name.startsWith('room_') && name.endsWith('.bin')) names.push(name);
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
