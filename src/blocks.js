/**
 * blocks.js — the event block chain in the Matrix media store
 *
 * The durable system of record for a workspace. Every committed operator
 * event a user sends is (asynchronously) packed into blocks, encrypted
 * with the stable Workspace Content Key, uploaded to the homeserver
 * media store, and hash-linked to the previous block. The chain head AND
 * a manifest of every block live in room STATE:
 *
 *   "<ns>.blocks" state_key=@sender →
 *       { v, epoch, head: { mxc, sha256 }, idx, count, updated_at,
 *         manifest: [{ m: mxc, h: sha256 }, …], manifestBase }
 *
 * The manifest is what makes hydration fast: a reader fetches every block
 * at once (loadChains → fetchManifestBlocks, bounded parallelism) instead
 * of walking prev-pointers one network round-trip at a time. State events
 * are size-capped (~64 KB on Synapse), so the manifest keeps only the
 * newest blocks that fit (`manifestBase` = absolute index of its first
 * entry); any older tail is recovered by a serial prev-walk from there.
 * Heads written before manifests existed simply fall back to the walk.
 *
 * Why this exists: the megolm-encrypted timeline is fragile — a browser
 * wipe loses the device keys and (when key backup fails, which on this
 * stack it repeatedly has) the entire history with them, INCLUDING the
 * import entities whose event content carries the only pointer + key to
 * imported row blobs. State events are never megolm-encrypted and media
 * blobs never expire under E2EE rooms' retention assumptions, so
 * password → identity (account_data) → WCK (room state) → chain head
 * (room state) → blocks (media store) recovers the full event log with
 * no device, megolm session, or key backup involved.
 *
 * Per-sender chains: each user appends only their OWN events, so there
 * is no multi-writer coordination. Readers merge every member's chain
 * and dedup by event_id. The chain is a recovery layer — the room
 * timeline remains the live transport — so a rare duplicate or a fork
 * from two racing devices costs nothing (dedup on read).
 */

import { getClient } from './client.js';
import { fetchMxcBytes, cacheMediaBytes, getCachedMediaBytes } from './media.js';
import * as driveBackup from './drivebackup.js';
import {
  encodeBlock, decodeBlock, mergeChainEvents, capManifest, manifestEntry,
} from './crypto/blockcodec.js';

const BLOCKS_TYPE = (ns) => `${ns}.blocks`;

// Hard ceiling on blocks walked per chain — a corrupt prev-loop must not
// spin forever. 100k blocks × ≥1 event each is far beyond any workspace.
const MAX_CHAIN_BLOCKS = 100_000;

// Parallel block downloads per chain. The manifest in room state lets every
// block be fetched at once instead of walked one prev-pointer at a time; this
// bounds how many in-flight requests we open so a huge chain doesn't flood the
// network or the homeserver's media endpoint.
const FETCH_CONCURRENCY = 6;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Read our own chain-head state event. Null when absent. */
export async function readOwnHead(namespace, roomId, userId) {
  const client = getClient();
  if (!client) return null;
  try {
    return await client.getStateEvent(roomId, BLOCKS_TYPE(namespace), userId);
  } catch (e) {
    if (e?.errcode === 'M_NOT_FOUND' || e?.httpStatus === 404) return null;
    try {
      const ev = client.getRoom(roomId)?.currentState?.getStateEvents(BLOCKS_TYPE(namespace), userId);
      return ev ? ev.getContent() : null;
    } catch { return null; }
  }
}

/**
 * Append one block of events to our chain: encrypt, upload, advance the
 * head state event AND the block manifest. `head` is the current head
 * ({ mxc, sha256, idx }) or null for a genesis block. `manifestState` is
 * `{ manifest, base }` from the last append (or null) where `manifest[0]`
 * is the pointer for absolute block index `base`.
 *
 * The manifest lets a reader fetch the whole chain in parallel (see
 * loadChains) instead of walking prev-pointers serially. We keep `head`
 * too: it's the integrity anchor and lets older clients still walk.
 *
 * Returns `{ mxc, sha256, idx, manifest, base }` — the advanced head plus
 * the manifest state to carry into the next append. Throws on failure so
 * the caller can requeue the events.
 */
export async function appendBlock(namespace, roomId, wck, events, head, manifestState = null) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const userId = client.getUserId();

  const idx = head ? (head.idx || 0) + 1 : 0;
  const { bytes, sha256, plaintext } = await encodeBlock(wck, {
    idx,
    prev: head ? { mxc: head.mxc, sha256: head.sha256 } : null,
    events,
  });

  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const resp = await client.uploadContent(blob, {
    type: 'application/octet-stream',
    name: `block_${idx}`,
  });
  const mxc = resp && resp.content_uri;
  if (!mxc) throw new Error('block upload returned no content_uri');

  // Extend the running manifest. When there's no prior manifest but a head
  // already exists (a legacy chain written before manifests, or one whose
  // older entries were trimmed), the unlisted blocks below `idx` are
  // recovered by a prev-walk — so the new manifest's base is `idx`, never 0.
  const priorManifest = manifestState?.manifest || [];
  const priorBase = manifestState
    ? (manifestState.base | 0)
    : (head ? idx : 0);
  const full = priorManifest.concat([manifestEntry(mxc, sha256)]);
  const { kept, dropped } = capManifest(full);
  const base = priorBase + dropped;

  await client.sendStateEvent(roomId, BLOCKS_TYPE(namespace), {
    v: 1,
    epoch: 0,
    head: { mxc, sha256 },
    idx,
    count: events.length,
    updated_at: Date.now(),
    manifest: kept,
    manifestBase: base,
  }, userId);

  // Mirror the decoded block locally so re-opens skip download + decrypt.
  await cacheMediaBytes(mxc, plaintext);

  // BACKUP (up): queue the SAME encrypted ciphertext for the off-site n8n →
  // Google Drive mirror, when configured. The Drive path has its own cycle —
  // it batches blocks and rewrites a binary segment file every ~100 events,
  // rolling to a new file at a size cap (drivebackup.js). Best-effort and
  // detached: the block is already in the media store, so a backup failure
  // never affects the primary append. Drive sees only opaque ciphertext.
  if (driveBackup.canBackup()) {
    driveBackup.queueBlock({ roomId, idx, sha256, mxc, bytes, events: events.length });
  }

  return { mxc, sha256, idx, manifest: kept, base };
}

/** All members' chain heads: [{ sender, head: {mxc, sha256}, idx }]. */
async function readAllHeads(namespace, roomId) {
  const client = getClient();
  if (!client) return [];
  const type = BLOCKS_TYPE(namespace);

  const fromCache = (() => {
    try {
      const evs = client.getRoom(roomId)?.currentState?.getStateEvents(type) || [];
      return evs
        .map(ev => ({ sender: ev.getStateKey(), ...sanitizeHead(ev.getContent()) }))
        .filter(h => h.head);
    } catch { return []; }
  })();
  if (fromCache.length) return fromCache;

  // Sync cache empty (fresh device mid-sync, shed room) — ask the server.
  try {
    const all = await client.roomState(roomId);
    return (all || [])
      .filter(ev => ev.type === type)
      .map(ev => ({ sender: ev.state_key, ...sanitizeHead(ev.content) }))
      .filter(h => h.head);
  } catch { return fromCache; }
}

function sanitizeHead(content) {
  const head = content?.head;
  if (!head?.mxc || !head?.sha256) {
    return { head: null, idx: 0, manifest: null, manifestBase: 0 };
  }
  // Only trust manifest entries that carry both a pointer and a hash; a
  // malformed one is dropped so a reader falls back to the prev-walk rather
  // than fetching garbage.
  const manifest = Array.isArray(content.manifest)
    ? content.manifest.filter(e => e && e.m && e.h).map(e => ({ m: e.m, h: e.h }))
    : null;
  return {
    head: { mxc: head.mxc, sha256: head.sha256 },
    idx: content.idx || 0,
    manifest: manifest && manifest.length ? manifest : null,
    manifestBase: content.manifestBase | 0,
  };
}

/**
/** Fetch a source's ciphertext and decode+verify it against `sha256`. Returns
 *  the decoded block, or null on any failure (offline, blob gone, tampered).
 *  Never throws, so it is safe to race. */
async function decodeFromSource(getCiphertext, wck, sha256, mxc) {
  let ct;
  try { ct = await getCiphertext(); } catch { return null; }
  if (!ct) return null;
  try {
    return await decodeBlock(wck, ct, sha256);
  } catch (e) {
    console.warn('[blocks] bad block at', mxc, '—', e?.message || e);
    return null;
  }
}

/** Resolve with the first promise to yield a truthy value; null if none do. */
function firstValid(promises) {
  return new Promise((resolve) => {
    let remaining = promises.length;
    if (!remaining) return resolve(null);
    let done = false;
    const lose = () => { if (!done && --remaining === 0) resolve(null); };
    for (const p of promises) {
      p.then((v) => { if (done) return; if (v) { done = true; resolve(v); } else lose(); }, lose);
    }
  });
}

/**
 * Fetch + decode one block by pointer, from the FASTEST available source.
 *
 * Order of preference is by speed, not by trust — every candidate's bytes
 * pass through decodeBlock's sha256 check, so a wrong/tampered/undecryptable
 * blob from any source is simply ignored:
 *   1. the local OPFS mirror (verified at download time) — instant;
 *   2. an already-pulled, fresh Drive chain (sync peek, no network) — so a
 *      hydration of N blocks pays a single Drive GET;
 *   3. otherwise RACE the homeserver media store against the Drive backup and
 *      take whichever returns a valid block first.
 *
 * "Latest" is guaranteed elsewhere: the block list comes from the room-state
 * manifest/head, which is always current, and Drive can only ever serve a
 * block whose sha256 the manifest already names.
 */
async function fetchBlock(wck, mxc, sha256, roomId) {
  const cached = await getCachedMediaBytes(mxc);
  if (cached) {
    try { return JSON.parse(decoder.decode(cached)); } catch { /* fall through */ }
  }

  // Drive's whole-chain pull is shared across the hydration; once it lands,
  // serve from memory and skip a redundant media round-trip entirely.
  let block = null;
  const peeked = driveBackup.canHydrate() ? driveBackup.peekBlock({ sha256 }) : null;
  if (peeked) {
    try { block = await decodeBlock(wck, peeked, sha256); } catch { block = null; }
  }

  if (!block) {
    const racers = [decodeFromSource(() => fetchMxcBytes(mxc), wck, sha256, mxc)];
    if (driveBackup.canHydrate()) {
      racers.push(decodeFromSource(() => driveBackup.getBlock({ sha256 }), wck, sha256, mxc));
    }
    block = await firstValid(racers);
  }
  if (!block) return null;

  try {
    await cacheMediaBytes(mxc, encoder.encode(JSON.stringify(block)));
  } catch { /* mirror is best-effort */ }
  return block;
}

/** Walk one chain head → genesis serially. Returns { blocks, complete }. */
async function walkChain(wck, head, roomId) {
  const blocks = [];
  let ptr = head;
  let guard = 0;
  while (ptr && guard++ < MAX_CHAIN_BLOCKS) {
    const block = await fetchBlock(wck, ptr.mxc, ptr.sha256, roomId);
    if (!block) return { blocks, complete: false };
    blocks.push(block);
    ptr = block.prev;
  }
  return { blocks, complete: !ptr };
}

/**
 * Fetch every block listed in a manifest in parallel (bounded concurrency).
 * Returns { blocks, complete } where complete is false if any entry failed.
 * `onBlock` is called once per resolved entry for progress reporting.
 */
async function fetchManifestBlocks(wck, manifest, onBlock, roomId) {
  const out = new Array(manifest.length).fill(null);
  let complete = true;
  let next = 0;
  async function worker() {
    while (next < manifest.length) {
      const k = next++;
      const block = await fetchBlock(wck, manifest[k].m, manifest[k].h, roomId);
      if (block) out[k] = block; else complete = false;
      if (onBlock) onBlock();
    }
  }
  const n = Math.min(FETCH_CONCURRENCY, manifest.length);
  await Promise.all(Array.from({ length: n }, worker));
  return { blocks: out.filter(Boolean), complete };
}

/**
 * Load one member's chain. Prefers the manifest (parallel fetch of every
 * block at once); when the manifest is trimmed (`manifestBase > 0`) the
 * older tail it omits is recovered by a serial prev-walk from the oldest
 * listed block. Falls back entirely to the serial walk for legacy heads
 * that predate manifests.
 */
async function loadChainBlocks(wck, info, onBlock, roomId) {
  const { head, manifest, manifestBase } = info;
  if (!manifest) return walkChain(wck, head, roomId);

  const { blocks, complete } = await fetchManifestBlocks(wck, manifest, onBlock, roomId);
  if (!complete || !(manifestBase > 0)) return { blocks, complete };

  // The manifest dropped its oldest entries to fit room state. Walk the
  // remaining tail from the oldest listed block's prev pointer.
  const oldest = blocks.reduce((m, b) => (b.idx < m.idx ? b : m), blocks[0]);
  const tail = oldest?.prev ? await walkChain(wck, oldest.prev, roomId) : { blocks: [], complete: true };
  return { blocks: blocks.concat(tail.blocks), complete: tail.complete };
}

/**
 * Load every member's chain and merge into one deduped, ts-ordered event
 * list. `onProgress(done, total)` is called as blocks resolve so callers can
 * drive a loading indicator (`total` is the count of manifest-listed blocks;
 * legacy walked chains contribute to `done` only). Returns:
 *   {
 *     events,             // plain events, ready for store.append / fold
 *     chainedIds,         // Set of every event_id present in any chain
 *     ownHead,            // this user's head { mxc, sha256, idx } | null
 *     ownManifest,        // { manifest, base } for the next append | null
 *     partial,            // true if any chain couldn't be fully loaded
 *   }
 */
export async function loadChains(namespace, roomId, wck, onProgress) {
  const client = getClient();
  const me = client?.getUserId?.() || null;
  const heads = await readAllHeads(namespace, roomId);

  const total = heads.reduce((n, h) => n + (h.manifest?.length || 0), 0);
  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done, total); };
  if (onProgress) onProgress(0, total);

  const chains = [];
  let ownHead = null;
  let ownManifest = null;
  let partial = false;

  for (const info of heads) {
    const { blocks, complete } = await loadChainBlocks(wck, info, tick);
    if (!complete) partial = true;
    chains.push(blocks);
    if (info.sender === me) {
      ownHead = { ...info.head, idx: info.idx };
      ownManifest = info.manifest
        ? { manifest: info.manifest, base: info.manifestBase | 0 }
        : null;
    }
  }

  const events = mergeChainEvents(chains);
  const chainedIds = new Set();
  for (const chain of chains) {
    for (const block of chain) {
      for (const ev of block.events) if (ev.event_id) chainedIds.add(ev.event_id);
    }
  }

  return { events, chainedIds, ownHead, ownManifest, partial };
}
