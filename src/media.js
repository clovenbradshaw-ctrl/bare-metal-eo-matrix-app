/**
 * media.js — Large-payload hoisting via Matrix media endpoint
 *
 * Matrix room events cap out around 64KB on the wire; after Megolm
 * encryption the practical content budget is ~30KB. When a DEF (or any
 * operator content) carries a value larger than that — a screenshot, a
 * PDF, a long markdown blob — we upload it to the homeserver's media
 * store and replace the inline value with a small mxc:// reference.
 *
 * The reference format is intentionally tagged so the fold can
 * transparently dereference it later:
 *
 *   { __media: 1, mxc: "mxc://server/...", mime: "...", size: N, name: "..." }
 *
 * Media uploads sit OUTSIDE the room E2EE envelope. This module does
 * not implement encrypted-media (m.encrypted file attachments) — that
 * is a follow-up. For now, mark sensitive rooms as such and avoid
 * hoisting confidential blobs into unencrypted media.
 */

import { getClient } from './client.js';

// Soft and hard limits chosen below the Matrix v1.0 cap (65,535 bytes
// for the serialized event after encryption overhead).
const HOIST_THRESHOLD = 16 * 1024;       // hoist any string >= 16KB
const CONTENT_SIZE_LIMIT = 24 * 1024;    // total content target after hoist
const MAX_HOIST_PER_EVENT = 8;

const encoder = new TextEncoder();

function byteLength(str) {
  return encoder.encode(str).length;
}

export function contentSize(content) {
  return byteLength(JSON.stringify(content));
}

/**
 * Walk a content object; for every string field whose UTF-8 size is
 * above the hoist threshold, upload it to media and replace the value
 * with a media reference. Mutates a copy.
 */
export async function hoistLargeFields(content) {
  if (!content || typeof content !== 'object') return { content, hoisted: 0 };
  if (contentSize(content) <= CONTENT_SIZE_LIMIT) return { content, hoisted: 0 };

  const client = getClient();
  if (!client) return { content, hoisted: 0 };

  // Deep-clone so we never mutate caller's object.
  const out = structuredClone(content);
  let hoisted = 0;

  const candidates = [];
  collectCandidates(out, [], candidates);

  // Largest first — gives us the most relief per upload.
  candidates.sort((a, b) => b.size - a.size);

  for (const cand of candidates) {
    if (hoisted >= MAX_HOIST_PER_EVENT) break;
    if (contentSize(out) <= CONTENT_SIZE_LIMIT) break;

    try {
      const bytes = encoder.encode(cand.value);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const resp = await client.uploadContent(blob, {
        type: 'application/octet-stream',
        name: cand.path.join('.') || 'value',
      });
      const mxc = resp && resp.content_uri;
      if (!mxc) continue;

      setPath(out, cand.path, {
        __media: 1,
        mxc,
        mime: 'text/plain;charset=utf-8',
        size: bytes.length,
        name: cand.path.join('.'),
      });
      hoisted++;
    } catch (e) {
      // Swallow per-field upload failures and try the next — better to
      // succeed with partial hoisting than block the whole send.
      console.warn('[media] hoist failed for', cand.path, e?.message || e);
    }
  }

  return { content: out, hoisted };
}

/**
 * Resolve mxc media references back to their original strings. Called
 * by readers that want the inline data. Returns content unchanged if
 * nothing needs resolving.
 */
export async function resolveMediaReferences(content) {
  if (!content || typeof content !== 'object') return content;
  const client = getClient();
  if (!client) return content;

  const out = structuredClone(content);
  const refs = [];
  collectMediaRefs(out, [], refs);
  if (refs.length === 0) return content;

  for (const r of refs) {
    try {
      const url = client.mxcUrlToHttp(r.ref.mxc, undefined, undefined, undefined, true);
      if (!url) continue;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const text = await resp.text();
      setPath(out, r.path, text);
    } catch (e) {
      console.warn('[media] resolve failed for', r.path, e?.message || e);
    }
  }
  return out;
}

function collectCandidates(node, path, out) {
  if (typeof node === 'string') {
    const sz = byteLength(node);
    if (sz >= HOIST_THRESHOLD) out.push({ path: [...path], value: node, size: sz });
    return;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      collectCandidates(node[k], [...path, k], out);
    }
  }
}

function collectMediaRefs(node, path, out) {
  if (node && typeof node === 'object') {
    if (node.__media === 1 && typeof node.mxc === 'string') {
      out.push({ path: [...path], ref: node });
      return;
    }
    for (const k of Object.keys(node)) {
      collectMediaRefs(node[k], [...path, k], out);
    }
  }
}

function setPath(root, path, value) {
  if (path.length === 0) return;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
}

export { HOIST_THRESHOLD, CONTENT_SIZE_LIMIT };
