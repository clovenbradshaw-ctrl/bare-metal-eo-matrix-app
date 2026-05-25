/**
 * operators.js — The nine operators
 *
 * A closed algebra of transformation. Every change to application state
 * decomposes into one or more of these. Each one preserves what KIND of
 * change it was. They are dependency-ordered:
 *
 *   NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC
 *
 * NUL and SIG do not produce timeline events (observation and attention
 * are ephemeral). The remaining seven are the event types that populate
 * the room timeline and feed the fold.
 *
 * Configure the namespace per-app. Default: io.matrix-events
 */

import { getClient } from './client.js';

// ── Namespace ──

let NS = 'io.matrix-events';

/**
 * Set the event type namespace for this app.
 * Call once at startup before emitting events.
 * @param {string} namespace - e.g. "com.myapp", "io.groundtruth.vault"
 */
export function setNamespace(namespace) {
  NS = namespace;
}

export function getNamespace() {
  return NS;
}

// ── Operator definitions ──

/**
 * The nine operators.
 *
 * Each has:
 *   key    — short name, used as the event type suffix
 *   glyph  — symbolic notation
 *   triad  — which triad it belongs to (existence / structure / significance)
 *   order  — dependency position (0-8)
 *   stored — whether it produces timeline events
 */
export const OP = {
  NUL: { key: 'nul', glyph: '∅', triad: 'existence',    order: 0, stored: false },
  SIG: { key: 'sig', glyph: '○', triad: 'existence',    order: 1, stored: false },
  INS: { key: 'ins', glyph: '●', triad: 'existence',    order: 2, stored: true  },
  SEG: { key: 'seg', glyph: '｜', triad: 'structure',    order: 3, stored: true  },
  CON: { key: 'con', glyph: '⋈', triad: 'structure',    order: 4, stored: true  },
  SYN: { key: 'syn', glyph: '△', triad: 'structure',    order: 5, stored: true  },
  DEF: { key: 'def', glyph: '⊢', triad: 'significance', order: 6, stored: true  },
  EVA: { key: 'eva', glyph: '⊨', triad: 'significance', order: 7, stored: true  },
  REC: { key: 'rec', glyph: '⊛', triad: 'significance', order: 8, stored: true  },
};

/**
 * Get the full Matrix event type string for an operator.
 * @param {object} op - One of the OP constants
 * @returns {string} e.g. "io.matrix-events.ins"
 */
export function eventType(op) {
  return `${NS}.${op.key}`;
}

/**
 * Check if a Matrix event type string belongs to this app's operator set.
 * @param {string} type - Matrix event type
 * @returns {object|null} The matching OP constant, or null
 */
export function parseEventType(type) {
  if (!type.startsWith(NS + '.')) return null;
  const suffix = type.slice(NS.length + 1);
  return Object.values(OP).find((op) => op.key === suffix) || null;
}

// ── Emit ──

/**
 * Emit an operator event into a room.
 *
 * If the room has encryption enabled, the SDK encrypts the event
 * with Megolm automatically. The homeserver stores ciphertext.
 *
 * @param {string} roomId  - Target room
 * @param {object} op      - One of the OP constants (must be stored: true)
 * @param {object} content - Event content body
 * @returns {string} The event ID
 */
export async function emit(roomId, op, content) {
  if (!op.stored) {
    throw new Error(`${op.key} is ephemeral and cannot be emitted to the timeline`);
  }
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const resp = await client.sendEvent(roomId, eventType(op), content);
  return resp.event_id;
}

// ── Convenience emitters ──

/**
 * INS — Instantiate a new entity.
 * Mints a content-addressed anchor ID that never changes.
 */
export async function ins(roomId, entityType, payload = {}) {
  const anchor = `${entityType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await emit(roomId, OP.INS, { anchor, entity_type: entityType, payload });
  return anchor;
}

/** DEF — Set a value within the current frame. */
export async function def(roomId, anchor, path, value) {
  return emit(roomId, OP.DEF, { anchor, path, value });
}

/** DEF targeting schema — no anchor, path auto-prefixed with _schema. */
export async function defSchema(roomId, path, value) {
  return emit(roomId, OP.DEF, { anchor: null, path: '_schema.' + path, value });
}

/** SEG — Move an entity across a partition boundary. */
export async function seg(roomId, anchor, partition) {
  return emit(roomId, OP.SEG, { anchor, partition });
}

/** CON — Create a typed relationship between two anchors. */
export async function con(roomId, sourceAnchor, targetAnchor, relationType) {
  return emit(roomId, OP.CON, {
    source_anchor: sourceAnchor,
    target_anchor: targetAnchor,
    relation_type: relationType,
  });
}

/** SYN — Merge multiple entities into a synthesized whole. */
export async function syn(roomId, inputAnchors, output) {
  return emit(roomId, OP.SYN, { input_anchors: inputAnchors, output });
}

/** EVA — Evaluate an entity against a criterion. */
export async function eva(roomId, anchor, criterion, result, note = '') {
  return emit(roomId, OP.EVA, { anchor, criterion, result, note });
}

/** REC — Recontextualize: change what the data means. */
export async function rec(roomId, scope, beforeFrame, afterFrame) {
  return emit(roomId, OP.REC, { scope, before_frame: beforeFrame, after_frame: afterFrame });
}
