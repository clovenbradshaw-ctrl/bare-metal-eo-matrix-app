/**
 * blocks.js — the event block chain in the Matrix media store
 *
 * The durable system of record for a workspace. Every committed operator
 * event a user sends is (asynchronously) packed into blocks, encrypted
 * with the stable Workspace Content Key, uploaded to the homeserver
 * media store, and hash-linked to the previous block. The chain head
 * lives in room STATE:
 *
 *   "<ns>.blocks" state_key=@sender →
 *       { v, epoch, head: { mxc, sha256 }, idx, count, updated_at }
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
import { encodeBlock, decodeBlock, mergeChainEvents } from './crypto/blockcodec.js';

const BLOCKS_TYPE = (ns) => `${ns}.blocks`;

// Hard ceiling on blocks walked per chain — a corrupt prev-loop must not
// spin forever. 100k blocks × ≥1 event each is far beyond any workspace.
const MAX_CHAIN_BLOCKS = 100_000;

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
 * head state event. `head` is the current head ({ mxc, sha256, idx }) or
 * null for a genesis block. Returns the new head. Throws on failure so
 * the caller can requeue the events.
 */
export async function appendBlock(namespace, roomId, wck, events, head) {
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

  await client.sendStateEvent(roomId, BLOCKS_TYPE(namespace), {
    v: 1,
    epoch: 0,
    head: { mxc, sha256 },
    idx,
    count: events.length,
    updated_at: Date.now(),
  }, userId);

  // Mirror the decoded block locally so re-opens skip download + decrypt.
  await cacheMediaBytes(mxc, plaintext);

  return { mxc, sha256, idx };
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
  if (!head?.mxc || !head?.sha256) return { head: null, idx: 0 };
  return { head: { mxc: head.mxc, sha256: head.sha256 }, idx: content.idx || 0 };
}

/** Walk one chain head → genesis. Returns { blocks, complete }. */
async function walkChain(wck, head) {
  const blocks = [];
  let ptr = head;
  let guard = 0;
  while (ptr && guard++ < MAX_CHAIN_BLOCKS) {
    let block = null;
    const cached = await getCachedMediaBytes(ptr.mxc);
    if (cached) {
      // Verified against the chain hash when first downloaded; the local
      // mirror is vault-encrypted, so parse directly.
      try { block = JSON.parse(decoder.decode(cached)); } catch { block = null; }
    }
    if (!block) {
      const ct = await fetchMxcBytes(ptr.mxc);
      if (!ct) return { blocks, complete: false };           // offline / blob gone
      try {
        block = await decodeBlock(wck, ct, ptr.sha256);
      } catch (e) {
        console.warn('[blocks] bad block at', ptr.mxc, '—', e?.message || e);
        return { blocks, complete: false };
      }
      try {
        await cacheMediaBytes(ptr.mxc, new TextEncoder().encode(JSON.stringify(block)));
      } catch { /* mirror is best-effort */ }
    }
    blocks.push(block);
    ptr = block.prev;
  }
  return { blocks, complete: !ptr };
}

/**
 * Load every member's chain and merge into one deduped, ts-ordered event
 * list. Returns:
 *   {
 *     events,             // plain events, ready for store.append / fold
 *     chainedIds,         // Set of every event_id present in any chain
 *     ownHead,            // this user's head { mxc, sha256, idx } | null
 *     partial,            // true if any chain couldn't be fully walked
 *   }
 */
export async function loadChains(namespace, roomId, wck) {
  const client = getClient();
  const me = client?.getUserId?.() || null;
  const heads = await readAllHeads(namespace, roomId);

  const chains = [];
  let ownHead = null;
  let partial = false;

  for (const { sender, head, idx } of heads) {
    const { blocks, complete } = await walkChain(wck, head);
    if (!complete) partial = true;
    chains.push(blocks);
    if (sender === me) ownHead = { ...head, idx };
  }

  const events = mergeChainEvents(chains);
  const chainedIds = new Set();
  for (const chain of chains) {
    for (const block of chain) {
      for (const ev of block.events) if (ev.event_id) chainedIds.add(ev.event_id);
    }
  }

  return { events, chainedIds, ownHead, partial };
}
