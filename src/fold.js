/**
 * fold.js — The integral fold
 *
 * State is never stored. It is always derived by folding the event stream.
 *
 *   state(t) = fold(dispatch, initial, events[0..t])
 *
 * The fold is a nine-case dispatch. Each event carries its operator type.
 * The fold applies each event to the accumulator and produces the current
 * state at any cursor position.
 *
 * The output is deterministic: same events in, same state out.
 * Replay to any point in the timeline and you see what was true then.
 */

import { parseEventType, OP } from './operators.js';

/**
 * @typedef {Object} FoldState
 * @property {Object<string, Entity>} entities   - Anchor → entity
 * @property {Object<string, string>} partitions - Anchor → partition name
 * @property {Array<Connection>}      connections - Typed links between anchors
 * @property {Array<Frame>}           frames      - REC events (paradigm shifts)
 * @property {Object}                 schema      - DEF events targeting _schema.* paths
 * @property {number}                 cursor      - Timestamp of last processed event
 */

/**
 * Create an empty initial state.
 */
export function initial() {
  return {
    entities: {},
    partitions: {},
    connections: [],
    frames: [],
    schema: {},
    cursor: 0,
  };
}

/**
 * Set a nested value on an object by dot-path.
 * "status" sets obj.status.
 * "_schema.tasks.fields.priority" sets obj._schema.tasks.fields.priority.
 */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Get a nested value from an object by dot-path.
 */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Dispatch a single event into the accumulator.
 * Returns the mutated state (mutates in place for performance).
 */
function dispatch(state, event) {
  const type = typeof event.getType === 'function' ? event.getType() : event.type;
  const content = typeof event.getContent === 'function' ? event.getContent() : event.content;
  const ts = typeof event.getTs === 'function' ? event.getTs() : event.origin_server_ts || 0;
  const sender = typeof event.getSender === 'function' ? event.getSender() : event.sender;
  const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id || null;

  // Skip redacted events (empty content)
  if (!content || Object.keys(content).length === 0) return state;

  const op = parseEventType(type);
  if (!op) return state; // Not one of ours

  state.cursor = ts;

  switch (op) {
    case OP.INS: {
      const { anchor, entity_type, payload } = content;
      if (!anchor) break;
      state.entities[anchor] = {
        ...payload,
        _anchor: anchor,
        _type: entity_type,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
      };
      break;
    }

    case OP.DEF: {
      const { anchor, path, value } = content;
      // Schema DEF: path starts with _schema AND no anchor targeted
      if (!anchor && path?.startsWith('_schema.')) {
        setPath(state.schema, path.slice('_schema.'.length), value);
        break;
      }
      // Entity DEF: update a field on an existing entity
      if (anchor) {
        const entity = state.entities[anchor];
        if (entity && path) {
          setPath(entity, path, value);
          entity._updated = ts;
          entity._updatedBy = sender;
        }
      }
      break;
    }

    case OP.SEG: {
      const { anchor, partition } = content;
      if (anchor) {
        state.partitions[anchor] = partition;
        const entity = state.entities[anchor];
        if (entity) {
          entity._partition = partition;
          entity._updated = ts;
        }
      }
      break;
    }

    case OP.CON: {
      const { source_anchor, target_anchor, relation_type } = content;
      state.connections.push({
        source: source_anchor,
        target: target_anchor,
        type: relation_type,
        _ts: ts,
        _sender: sender,
        _eventId: eventId,
      });
      break;
    }

    case OP.SYN: {
      const { input_anchors, output } = content;
      // Anchor derived from event_id (guaranteed unique) or ts fallback
      const synAnchor = eventId ? `syn_${eventId}` : `syn_${ts}_${sender || 'anon'}`;
      state.entities[synAnchor] = {
        ...output,
        _anchor: synAnchor,
        _type: '_synthesis',
        _inputs: input_anchors,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
      };
      break;
    }

    case OP.EVA: {
      const { anchor, criterion, result, note } = content;
      const entity = state.entities[anchor];
      if (entity) {
        if (!entity._evaluations) entity._evaluations = [];
        entity._evaluations.push({ criterion, result, note, _ts: ts, _sender: sender });
      }
      break;
    }

    case OP.REC: {
      state.frames.push({
        ...content,
        _ts: ts,
        _sender: sender,
      });
      break;
    }
  }

  return state;
}

/**
 * Fold an array of events into state from scratch.
 *
 * Events should be in chronological order.
 * Accepts either matrix-js-sdk MatrixEvent objects or plain objects
 * with { type, content, origin_server_ts, sender }.
 *
 * @param {Array} events
 * @returns {FoldState}
 */
export function fold(events) {
  return events.reduce(dispatch, initial());
}

/**
 * Incremental fold: apply new events onto an existing state.
 * Use when the sync loop delivers a batch of new events.
 *
 * @param {FoldState} state - Previous state (will be mutated)
 * @param {Array} newEvents - New events in chronological order
 * @returns {FoldState}
 */
export function foldFrom(state, newEvents) {
  return newEvents.reduce(dispatch, state);
}

/**
 * Query helpers — operate on folded state
 */

/** Get all entities of a given type. */
export function entitiesOfType(state, entityType) {
  return Object.values(state.entities).filter((e) => e._type === entityType);
}

/** Get all entities in a given partition. */
export function entitiesInPartition(state, partition) {
  return Object.values(state.entities).filter((e) => state.partitions[e._anchor] === partition);
}

/** Get all connections from or to a given anchor. */
export function connectionsFor(state, anchor) {
  return state.connections.filter((c) => c.source === anchor || c.target === anchor);
}

/** Get the current frame (most recent REC, or null). */
export function currentFrame(state) {
  return state.frames.length > 0 ? state.frames[state.frames.length - 1] : null;
}
