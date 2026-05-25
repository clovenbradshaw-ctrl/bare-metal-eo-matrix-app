/**
 * rooms.js — Room management
 *
 * Rooms are tables. Room membership is access control.
 * E2EE scope is per-room. Each room is an independent data boundary.
 *
 * Rooms created by this module get:
 *   - m.room.encryption enabled (Megolm, handled by the SDK)
 *   - A state event marking them as app rooms (for discovery)
 *   - Private visibility (invite-only)
 */

import { getClient } from './client.js';
import { getNamespace } from './operators.js';
import { RoomEvent } from 'matrix-js-sdk';

const META_TYPE = () => `${getNamespace()}.meta`;

/**
 * Create a new room for this app.
 *
 * @param {string} name     - Human-readable room name
 * @param {string} roomType - App-level type (e.g. "project", "journal", "board")
 * @param {object} [meta]   - Additional metadata stored in the room state event
 * @returns {string} The room ID
 */
export async function createRoom(name, roomType, meta = {}) {
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const resp = await client.createRoom({
    name,
    visibility: 'private',
    preset: 'private_chat',
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
      {
        type: META_TYPE(),
        state_key: '',
        content: {
          app: getNamespace(),
          room_type: roomType,
          created_at: new Date().toISOString(),
          ...meta,
        },
      },
    ],
  });

  return resp.room_id;
}

/**
 * Discover all rooms belonging to this app.
 * Scans joined rooms for the app metadata state event.
 *
 * @param {string} [roomType] - Optional filter by room type
 * @returns {Array<{ roomId, name, roomType, meta }>}
 */
export function discoverRooms(roomType = null) {
  const client = getClient();
  if (!client) return [];

  const rooms = client.getRooms();
  const appRooms = [];

  for (const room of rooms) {
    const metaEvent = room.currentState.getStateEvents(META_TYPE(), '');
    if (!metaEvent) continue;

    const content = metaEvent.getContent();
    if (content.app !== getNamespace()) continue;
    if (roomType && content.room_type !== roomType) continue;

    appRooms.push({
      roomId: room.roomId,
      name: room.name,
      roomType: content.room_type,
      meta: content,
    });
  }

  return appRooms;
}

/**
 * Get all timeline events from a room, in chronological order.
 * These are the events that feed the fold.
 *
 * NOTE: After initial sync, the timeline may be incomplete (only the
 * last N events). Call loadFullTimeline() first if the fold needs
 * the complete history.
 *
 * @param {string} roomId
 * @returns {Array} MatrixEvent objects
 */
export function getTimeline(roomId) {
  const client = getClient();
  if (!client) return [];

  const room = client.getRoom(roomId);
  if (!room) return [];

  const timeline = room.getLiveTimeline();
  return timeline.getEvents();
}

/**
 * Paginate backwards until the entire room history is loaded.
 * Call this before folding if you need the complete event stream.
 * The SDK decrypts each page as it arrives.
 *
 * @param {string} roomId
 * @returns {number} Total events loaded
 */
export async function loadFullTimeline(roomId) {
  const client = getClient();
  if (!client) return 0;

  const room = client.getRoom(roomId);
  if (!room) return 0;

  const timeline = room.getLiveTimeline();
  let hasMore = true;
  while (hasMore) {
    hasMore = await client.paginateEventTimeline(timeline, { backwards: true, limit: 100 });
  }
  return timeline.getEvents().length;
}

/**
 * Listen for new timeline events in a room.
 * Calls the handler whenever new events arrive via sync.
 *
 * @param {string} roomId
 * @param {function} handler - Called with (event, room)
 * @returns {function} Unsubscribe function
 */
export function onTimeline(roomId, handler) {
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const listener = (event, room) => {
    if (room?.roomId === roomId) {
      handler(event, room);
    }
  };

  client.on(RoomEvent.Timeline, listener);
  return () => client.removeListener(RoomEvent.Timeline, listener);
}

/**
 * Paginate backwards to load more history.
 * The SDK fetches, decrypts, and appends to the timeline automatically.
 *
 * @param {string} roomId
 * @param {number} [limit=50]
 * @returns {boolean} True if more history is available
 */
export async function loadMore(roomId, limit = 50) {
  const client = getClient();
  if (!client) return false;

  const room = client.getRoom(roomId);
  if (!room) return false;

  const timeline = room.getLiveTimeline();
  return client.paginateEventTimeline(timeline, { backwards: true, limit });
}

/**
 * Invite a user to a room.
 * The SDK shares Megolm keys with new members automatically.
 *
 * @param {string} roomId
 * @param {string} userId - Full MXID, e.g. "@kevin:app.aminoimmigration.com"
 */
export async function invite(roomId, userId) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  await client.invite(roomId, userId);
}

/**
 * Get current room members.
 *
 * @param {string} roomId
 * @returns {Array<{ userId, displayName, membership }>}
 */
export function getMembers(roomId) {
  const client = getClient();
  if (!client) return [];

  const room = client.getRoom(roomId);
  if (!room) return [];

  return room.getJoinedMembers().map((m) => ({
    userId: m.userId,
    displayName: m.name || m.userId,
    membership: 'join',
  }));
}
