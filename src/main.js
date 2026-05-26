/**
 * main.js — Live Matrix bridge for the React UI
 *
 * Exposes `window.MatrixLive` so the JSX views (compiled by Babel
 * standalone at runtime) can drive a real homeserver: login, room
 * discovery filtered to this app's room type, live event streams,
 * and optimistic emit through the outbox.
 *
 *   committedState  = fold(events persisted in OPFS / IndexedDB)
 *   pendingEvents   = unsent ops from the outbox
 *   displayed events = committed ∪ pending, folded by the React layer
 *                      via window.MatrixEngine.fold(...)
 *
 * Rooms in this app are workspaces: each one declares its own
 * _schema.tables and partitions in the event log. We only surface
 * rooms with `room_type === 'eo.workspace'` — the user's other Matrix
 * rooms (DMs, etc.) are hidden by design.
 */
import { login as mxLogin, unlock as mxUnlock, lock as lockSession,
         logout as mxLogout, hasLocalAccount, getClient,
         setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider } from './client.js';
import { setNamespace, OP, ins, def, seg, con, syn, eva, rec, getNamespace,
         setOptimisticHook, eventType as opEventType, emit as rawEmit } from './operators.js';
import { fold, foldFrom, initial, stateHash } from './fold.js';
import { createRoom as mxCreateRoom, discoverRooms, getTimeline, onTimeline,
         loadTimelineSince, invite, getMembers, acceptInvite, onRoomChanges,
         onDecrypted, onLocalEchoUpdated, EventStatus } from './rooms.js';
import { EventStore } from './store.js';
import { vault, getLastUser } from './vault.js';
import { OutboxFlusher, listAll as outboxListAll, pendingCount,
         onChange as onOutboxChange, remove as outboxRemove } from './outbox.js';
import { onNetworkChange, getNetworkState } from './network.js';

const NAMESPACE = 'io.matrix-events';
const ROOM_TYPE = 'eo.workspace';

setNamespace(NAMESPACE);

// ── Live state ──
const subscribers = new Set();
const roomStores = new Map();           // roomId → EventStore
const roomEvents = new Map();           // roomId → Array<plainEvent> (committed)
const roomUnsubs = new Map();           // roomId → cleanup fns
const pendingByLocalId = new Map();     // localId → { roomId, event }
const sentEventToLocalId = new Map();

let outboxFlusher = null;
let unsubRoomChanges = null;
let netState = 'offline';
let activeSession = null;               // { mxid, homeserver, device_id, ... }
let progressLog = [];                   // ring buffer of recent log lines

function logProgress(msg) {
  progressLog.push({ ts: Date.now(), msg });
  if (progressLog.length > 60) progressLog.shift();
  notify('log');
}

function notify(reason) {
  for (const fn of subscribers) {
    try { fn(reason); } catch (e) { console.warn('[bridge] subscriber failed:', e); }
  }
}

setProgress(logProgress);

// ── Plain-event conversion ──
//
// Convert matrix-js-sdk's MatrixEvent into the {type,content,sender,
// origin_server_ts,event_id} shape that engine.js's fold consumes.
// Already-plain events (e.g. pending) pass through.
function toPlain(ev) {
  if (!ev) return null;
  if (typeof ev.getType !== 'function') return ev;
  return {
    event_id: ev.getId ? ev.getId() : ev.event_id,
    type: ev.getType(),
    content: ev.getContent ? ev.getContent() : ev.content,
    sender: ev.getSender ? ev.getSender() : ev.sender,
    origin_server_ts: ev.getTs ? ev.getTs() : ev.origin_server_ts,
  };
}

function isOpEvent(ev) {
  const t = ev?.type || (ev?.getType && ev.getType());
  return typeof t === 'string' && t.startsWith(NAMESPACE + '.');
}

function isOwnLocalEcho(event) {
  const txn = typeof event.getTxnId === 'function' ? event.getTxnId() : null;
  if (txn && pendingByLocalId.has(txn)) return true;
  const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id;
  return typeof eventId === 'string' && eventId.startsWith('~');
}

function reconcilePendingByTxn(event) {
  const txn = typeof event.getTxnId === 'function' ? event.getTxnId() : null;
  const unsigned = typeof event.getUnsigned === 'function' ? event.getUnsigned() : event.unsigned;
  const unsignedTxn = unsigned && unsigned.transaction_id;
  const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id;

  let localId = null;
  if (txn && pendingByLocalId.has(txn)) localId = txn;
  else if (unsignedTxn && pendingByLocalId.has(unsignedTxn)) localId = unsignedTxn;
  else if (eventId && sentEventToLocalId.has(eventId)) localId = sentEventToLocalId.get(eventId);

  if (localId) {
    pendingByLocalId.delete(localId);
    if (eventId) sentEventToLocalId.delete(eventId);
    notify('pending');
  }
}

// ── Optimistic dispatch hook ──
setOptimisticHook(({ roomId, event }) => {
  pendingByLocalId.set(event.event_id, { roomId, event });
  notify('pending');
});

// ── Network surface ──
onNetworkChange((state) => {
  netState = state;
  if (state === 'online' && outboxFlusher) outboxFlusher.kick();
  notify('network');
});
netState = getNetworkState();

// ── Outbox surface ──
onOutboxChange(() => notify('outbox'));

// ── Auth ──
async function loginWithMatrix({ homeserver, username, password }) {
  // Accept either "alice" + "matrix.org" or full "@alice:matrix.org"
  let hs = homeserver;
  let user = username;
  if (user.includes(':')) {
    hs = 'https://' + user.split(':').slice(1).join(':');
    user = user.startsWith('@') ? user : '@' + user;
  } else if (!hs.startsWith('http')) {
    hs = 'https://' + hs;
    if (!user.startsWith('@')) user = '@' + user + ':' + homeserver.replace(/^https?:\/\//, '');
  }

  logProgress('Signing in…');
  // If we already have a local account for this user, prefer offline-capable unlock.
  if (hasLocalAccount(user)) {
    try {
      const { online } = await mxUnlock(user, password);
      logProgress(online ? 'Unlocked (online)' : 'Unlocked (offline)');
      return await afterAuth(user, hs);
    } catch (e) {
      logProgress('Unlock failed, attempting full login: ' + e.message);
    }
  }

  const { userId } = await mxLogin(hs, user, password);
  return await afterAuth(userId, hs);
}

async function afterAuth(userId, homeserver) {
  activeSession = {
    mxid: userId,
    homeserver,
    device_id: getClient()?.getDeviceId?.() || null,
    signed_in_at: Date.now(),
  };

  if (outboxFlusher) outboxFlusher.stop();
  outboxFlusher = new OutboxFlusher({
    getClient,
    onAck: ({ localId, eventId }) => { sentEventToLocalId.set(eventId, localId); },
    onProgress: (e) => {
      if (e.type === 'sent') logProgress(`sent ${e.eventId.slice(0, 12)}…`);
      else if (e.type === 'retry') logProgress(`retry #${e.attempts}: ${e.error}`);
      else if (e.type === 'dead') {
        logProgress(`gave up: ${e.error}`);
        if (pendingByLocalId.has(e.localId)) {
          pendingByLocalId.delete(e.localId);
          notify('pending');
        }
      }
    },
  });
  outboxFlusher.start();

  if (unsubRoomChanges) unsubRoomChanges();
  unsubRoomChanges = onRoomChanges(() => notify('rooms'));

  await hydratePendingFromOutbox();
  notify('session');
  return activeSession;
}

async function hydratePendingFromOutbox() {
  try {
    const all = await outboxListAll();
    const senderId = vault.getUserId();
    for (const r of all) {
      if (r.status !== 'pending' && r.status !== 'inflight') continue;
      if (pendingByLocalId.has(r.localId)) continue;
      pendingByLocalId.set(r.localId, {
        roomId: r.roomId,
        event: {
          type: r.eventType,
          content: r.content,
          origin_server_ts: r.createdAt,
          sender: senderId,
          event_id: r.localId,
          _pending: true,
        },
      });
    }
  } catch (e) {
    console.warn('[bridge] hydrate outbox failed:', e);
  }
}

async function unlockOnly(userId, password) {
  await mxUnlock(userId, password);
  const hs = getClient()?.getHomeserverUrl?.() || '';
  return afterAuth(userId, hs);
}

async function logout() {
  if (outboxFlusher) { outboxFlusher.stop(); outboxFlusher = null; }
  if (unsubRoomChanges) { unsubRoomChanges(); unsubRoomChanges = null; }
  for (const [, fns] of roomUnsubs) fns.forEach(fn => { try { fn(); } catch {} });
  roomUnsubs.clear();
  roomStores.clear();
  roomEvents.clear();
  pendingByLocalId.clear();
  sentEventToLocalId.clear();
  await mxLogout();
  activeSession = null;
  notify('session');
}

// ── Rooms — filtered to ROOM_TYPE only ──
function listRooms() {
  const rooms = discoverRooms().filter(r =>
    r.membership === 'invite' || r.roomType === ROOM_TYPE || r.roomType === '…');
  return rooms.map(r => ({
    id: r.roomId,
    name: r.name,
    eventCount: roomEvents.get(r.roomId)?.length || 0,
    namespace: NAMESPACE,
    title: r.name,
    membership: r.membership,
    roomType: r.roomType,
    inviter: r.inviter,
  }));
}

async function createWorkspace(name) {
  const cleanName = String(name || '').trim() || 'workspace';
  const roomId = await mxCreateRoom(cleanName, ROOM_TYPE);
  logProgress(`Created workspace: ${cleanName}`);
  notify('rooms');
  return roomId;
}

async function joinRoom(roomId) {
  await acceptInvite(roomId);
  notify('rooms');
}

// ── Per-room timeline ──
async function openRoom(roomId) {
  if (roomStores.has(roomId)) return; // already open

  const store = new EventStore(roomId, NAMESPACE);
  await store.open();
  roomStores.set(roomId, store);

  const stored = store.getCount();
  let events = [];
  if (stored > 0) {
    const all = await store.getAll();
    events = all.map(toPlain).filter(isOpEvent);
  }
  roomEvents.set(roomId, events);
  notify('events');

  // Sync new from server (best-effort)
  const client = getClient();
  if (client) {
    try {
      const { newEvents } = await loadTimelineSince(roomId, store.getCursor());
      const filtered = newEvents.filter(e => !isOwnLocalEcho(e));
      const added = await store.append(filtered);
      for (const e of newEvents) reconcilePendingByTxn(e);
      if (added.length > 0) {
        const plain = added.map(toPlain).filter(isOpEvent);
        const cur = roomEvents.get(roomId) || [];
        roomEvents.set(roomId, cur.concat(plain));
        notify('events');
      }
    } catch (e) {
      logProgress(`Sync ${roomId}: ${e.message}`);
    }
  }

  const fns = [];
  fns.push(onTimeline(roomId, async (event) => {
    if (isOwnLocalEcho(event)) return;
    const added = await store.append([event]);
    if (added.length > 0) {
      const plain = added.map(toPlain).filter(isOpEvent);
      const cur = roomEvents.get(roomId) || [];
      roomEvents.set(roomId, cur.concat(plain));
      notify('events');
    }
  }));
  fns.push(onDecrypted(roomId, async (event) => {
    if (isOwnLocalEcho(event)) return;
    const added = await store.append([event]);
    if (added.length > 0) {
      const plain = added.map(toPlain).filter(isOpEvent);
      const cur = roomEvents.get(roomId) || [];
      roomEvents.set(roomId, cur.concat(plain));
      notify('events');
    }
  }));
  fns.push(onLocalEchoUpdated(roomId, async (event) => {
    if (event.status === EventStatus.SENT) {
      const added = await store.append([event]);
      if (added.length > 0) {
        const plain = added.map(toPlain).filter(isOpEvent);
        const cur = roomEvents.get(roomId) || [];
        roomEvents.set(roomId, cur.concat(plain));
      }
      reconcilePendingByTxn(event);
      notify('events');
    }
  }));
  roomUnsubs.set(roomId, fns);
}

function getEventsForRoom(roomId) {
  const committed = roomEvents.get(roomId) || [];
  const pending = [];
  for (const { roomId: rid, event } of pendingByLocalId.values()) {
    if (rid === roomId) pending.push(event);
  }
  if (pending.length === 0) return committed;
  pending.sort((a, b) => (a.origin_server_ts || 0) - (b.origin_server_ts || 0));
  return committed.concat(pending);
}

// ── Emit operator ──
const opByKey = {
  ins, def, seg, con, syn, eva, rec,
};
async function emit(roomId, op, content) {
  if (!op || !op.stored) {
    logProgress(`Cannot emit ephemeral op ${op?.key || '?'} to timeline`);
    return null;
  }
  // The React layer hands us engine.js's OP records; route to operators.js by key.
  try {
    switch (op.key) {
      case 'ins': {
        // Engine pre-computes the anchor; emit a single INS with the same payload shape.
        const { anchor, entity_type, payload } = content;
        if (anchor) {
          return await rawEmit(roomId, OP.INS, { anchor, entity_type, payload });
        }
        return await ins(roomId, entity_type, payload || {});
      }
      case 'def':
        return await def(roomId, content.anchor, content.path, content.value);
      case 'seg':
        return await seg(roomId, content.anchor, content.partition);
      case 'con':
        return await con(roomId, content.source_anchor, content.target_anchor, content.relation_type);
      case 'syn':
        return await syn(roomId, content.input_anchors, content.output);
      case 'eva':
        return await eva(roomId, content.anchor, content.criterion, content.result, content.note || '');
      case 'rec':
        return await rec(roomId, content.scope, content.before_frame, content.after_frame);
    }
  } catch (e) {
    logProgress(`Emit ${op.key} failed: ${e.message}`);
    throw e;
  }
}

async function inviteUser(roomId, userId) {
  await invite(roomId, userId);
  notify('members');
}

function membersOf(roomId) { return getMembers(roomId); }

// ── Recovery key prompts: relay to React via a window slot ──
setRecoveryKeyDisplayer((key) => new Promise((resolve) => {
  if (typeof window.__matrixLiveRecoveryDisplay === 'function') {
    window.__matrixLiveRecoveryDisplay(key, resolve);
  } else {
    // No UI hook yet; fall back to alert so the user still sees the key.
    alert('Save your Matrix recovery key:\n\n' + key);
    resolve();
  }
}));
setRecoveryKeyProvider(() => new Promise((resolve) => {
  if (typeof window.__matrixLiveRecoveryPrompt === 'function') {
    window.__matrixLiveRecoveryPrompt(resolve);
  } else {
    const v = prompt('Enter your Matrix recovery key (or cancel to skip):');
    resolve(v || null);
  }
}));

// ── Public surface ──
window.MatrixLive = {
  NAMESPACE, ROOM_TYPE,
  // Auth
  login: loginWithMatrix,
  unlock: unlockOnly,
  logout,
  hasLocalAccount,
  getLastUser,
  getSession: () => activeSession,
  isAuthed: () => !!activeSession,
  // Rooms
  listRooms,
  createRoom: createWorkspace,
  joinRoom,
  openRoom,
  getEventsForRoom,
  inviteUser,
  membersOf,
  // Net status
  getNetwork: () => netState,
  getPendingCount: pendingCount,
  outboxList: outboxListAll,
  outboxRemove,
  // Subscription
  subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  // Progress log
  getProgressLog: () => progressLog.slice(),
};

// ── Service worker (PWA shell) ──
if ('serviceWorker' in navigator) {
  const swUrl = `${import.meta.env.BASE_URL || '/'}sw.js`;
  navigator.serviceWorker.register(swUrl).catch((e) => {
    console.warn('[sw] register failed:', e);
  });
}

// Vault is locked at cold boot; the login screen handles unlock/login.
// Surface the last-remembered user so the UI can pre-fill it.
notify('session');
