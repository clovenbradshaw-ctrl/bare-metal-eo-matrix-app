/**
 * crypto/blockcodec.js — block format for the media-store event chain
 *
 * The durable system of record for a workspace is a hash-linked chain of
 * encrypted blocks in the Matrix media store ("the block chain"):
 *
 *   room state "<ns>.blocks" (state_key = @sender)
 *        │ head: { mxc, sha256 }              ← state events are NEVER
 *        ▼                                       megolm-encrypted, so the
 *   block N  ──prev──▶  block N-1  ──▶ … ──▶ block 0   head always survives
 *
 * Each block is AES-GCM encrypted with the stable Workspace Content Key
 * (see ENCRYPTION-DESIGN.md), so recovery needs only the user's password:
 * password → identity key (account_data) → WCK (room state) → walk the
 * chain. No megolm, no device keys, no key backup.
 *
 * Block plaintext (JSON):
 *
 *   { v: 1, idx, ts, prev: { mxc, sha256 } | null,
 *     events: [{ type, content, origin_server_ts, sender, event_id }] }
 *
 * `prev.sha256` is the SHA-256 of the PREVIOUS block's ciphertext, so a
 * reader walking head → genesis detects any substituted or truncated
 * block (tamper-evident, git-style). The head's own hash lives in the
 * state event that points at it.
 *
 * This module is pure — no Matrix, no DOM — so it runs under Node's
 * WebCrypto for tests. Upload/download and state I/O live in
 * src/blocks.js.
 */

import { encryptBytesWithKey, decryptBytesWithKey, b64 } from './envelope.js';

const BLOCK_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** SHA-256 of bytes, base64 (unpadded not required — compared verbatim). */
export async function sha256B64(bytes) {
  return b64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

/** Strip an event to the exact fields the fold consumes. */
export function plainEventForBlock(ev) {
  return {
    type: ev.type,
    content: ev.content,
    origin_server_ts: ev.origin_server_ts || 0,
    sender: ev.sender || null,
    event_id: ev.event_id || null,
  };
}

/**
 * Encode + encrypt one block. `prev` is `{ mxc, sha256 }` of the previous
 * block's uploaded ciphertext, or null for a genesis block. Returns the
 * ciphertext to upload (`bytes`), its hash for the next link / the head
 * pointer (`sha256`), and the serialized plaintext (`plaintext`) so the
 * caller can mirror the decoded form locally without re-deriving it.
 */
export async function encodeBlock(wck, { idx, prev, events, ts = Date.now() }) {
  const payload = {
    v: BLOCK_VERSION,
    idx,
    ts,
    prev: prev ? { mxc: prev.mxc, sha256: prev.sha256 } : null,
    events: events.map(plainEventForBlock),
  };
  const plaintext = encoder.encode(JSON.stringify(payload));
  const bytes = await encryptBytesWithKey(wck, plaintext);
  return { bytes, sha256: await sha256B64(bytes), plaintext };
}

/**
 * Decrypt + parse one block's ciphertext. When `expectedSha256` is given
 * (always, except for cache hits that were verified at download time) the
 * ciphertext hash is checked first, so a tampered or wrong blob is
 * rejected before decryption. Throws on any mismatch or auth failure.
 */
export async function decodeBlock(wck, bytes, expectedSha256 = null) {
  if (expectedSha256) {
    const actual = await sha256B64(bytes);
    if (actual !== expectedSha256) {
      throw new Error('block hash mismatch — chain is broken or tampered');
    }
  }
  const plain = await decryptBytesWithKey(wck, bytes);
  const block = JSON.parse(decoder.decode(plain));
  if (block.v !== BLOCK_VERSION) throw new Error(`unknown block version ${block.v}`);
  if (!Array.isArray(block.events)) throw new Error('block has no events array');
  return block;
}

/**
 * Merge the events of several decoded chains (one per sender) into a
 * single deduped, ts-ordered list. Dedup is by event_id — the same event
 * can legitimately appear twice when two devices of one user raced a
 * block append; the chain is a recovery layer, so duplicates are dropped
 * on read rather than prevented on write.
 */
export function mergeChainEvents(chains) {
  const seen = new Set();
  const out = [];
  for (const blocks of chains) {
    for (const block of blocks) {
      for (const ev of block.events) {
        const id = ev.event_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(ev);
      }
    }
  }
  out.sort((a, b) => (a.origin_server_ts || 0) - (b.origin_server_ts || 0));
  return out;
}

export { BLOCK_VERSION };
