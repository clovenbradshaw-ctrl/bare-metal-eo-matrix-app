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
import { login as mxLogin, unlock as mxUnlock,
         logout as mxLogout, hasLocalAccount, getClient,
         tryAutoUnlock, wipeLocalData,
         setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider } from './client.js';
import { setNamespace, OP, ins, def, seg, con, syn, eva, rec, defSchema, getNamespace,
         setOptimisticHook, eventType as opEventType, emit as rawEmit } from './operators.js';
import { planLazyImport } from './dataset.js';
import { fold, foldFrom, initial, stateHash } from './fold.js';
import { createRoom as mxCreateRoom, discoverRooms, getTimeline, onTimeline,
         loadTimelineSince, invite, getMembers, loadRoomMembers, myPowerLevel, kickMember,
         setMemberPowerLevel, onMembersChange, acceptInvite, onRoomChanges,
         onDecrypted, onLocalEchoUpdated, EventStatus,
         setName as mxSetRoomName, getDisplayName as mxGetDisplayName } from './rooms.js';
import { EventStore } from './store.js';
import { vault, getLastUser } from './vault.js';
import { OutboxFlusher, listAll as outboxListAll, pendingCount,
         onChange as onOutboxChange, remove as outboxRemove } from './outbox.js';
import { onNetworkChange, getNetworkState } from './network.js';
import { uploadFile as mediaUploadFile, getMediaBytes } from './media.js';
import { loadManifest, saveManifest } from './roomManifest.js';
import * as memory from './memory.js';

const NAMESPACE = 'io.matrix-events';
const ROOM_TYPE = 'eo.workspace';

// Hard heap budget for the whole tab. The governor sheds inactive state
// before this is reached; the LRU room cap below keeps steady-state
// footprint bounded regardless of how many rooms the user visits.
const MEMORY_BUDGET_BYTES = 500 * 1024 * 1024;

// How many rooms stay hydrated in memory at once. The app is used one room
// at a time, period — so we keep exactly one. Switching rooms closes the
// previous one (dropping its events, dedup set, and SDK timeline) and
// re-hydrates the new one from OPFS in a single decrypt pass. There is never
// a reason to hold a second room's working set in memory.
const MAX_OPEN_ROOMS = 1;

setNamespace(NAMESPACE);

// ── Live state ──
const subscribers = new Set();
const roomStores = new Map();           // roomId → EventStore
const roomEvents = new Map();           // roomId → Array<plainEvent> (committed)
const roomUnsubs = new Map();           // roomId → cleanup fns
const openOrder = [];                   // roomIds, least→most recently touched (LRU)
const pendingByLocalId = new Map();     // localId → { roomId, event }
const sentEventToLocalId = new Map();

let outboxFlusher = null;
let unsubRoomChanges = null;
let unregisterRoomEvictor = null;
let netState = 'offline';
let activeSession = null;               // { mxid, homeserver, device_id, ... }
let progressLog = [];                   // ring buffer of recent log lines
let booting = true;                     // true until cold-boot auto-restore settles

// In-memory mirror of the persisted room manifest. Lets `listRooms`
// return something useful when the SDK hasn't synced yet (offline boot,
// stale token). Refreshed from live data whenever the SDK delivers
// rooms, and persisted on change.
let roomManifest = [];
let roomManifestKey = '';
let manifestSaveTimer = null;

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
async function loginWithMatrix({ homeserver, username, password, keepSignedIn = false }) {
  // When set, the vault key is stashed in localStorage so the session
  // survives a browser restart instead of being forgotten on tab close.
  const persist = !!keepSignedIn;
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

  // If we already have a vault for this user, prefer offline-capable unlock.
  // After this attempt, `vaultUnlockedForUser` tells us whether the password
  // was correct against local data — even if the server can't be reached.
  let vaultUnlockedForUser = false;
  if (hasLocalAccount(user)) {
    try {
      const { online, needsLogin } = await mxUnlock(user, password, { persist });
      vaultUnlockedForUser = vault.isUnlocked() && vault.getUserId() === user;
      if (!needsLogin) {
        logProgress(online ? 'Unlocked (online)' : 'Unlocked (offline)');
        return await afterAuth(user, hs);
      }
      logProgress('Saved session expired — refreshing credentials…');
    } catch (e) {
      logProgress('Unlock failed, attempting full login: ' + e.message);
    }
  }

  try {
    const { userId } = await mxLogin(hs, user, password, { persist });
    return await afterAuth(userId, hs);
  } catch (e) {
    // Couldn't reach the homeserver (or it refused). If the vault is
    // already unlocked for this user, the password is correct against
    // local data — enter local-only mode so they can read what's on
    // disk and queue edits until the homeserver is reachable.
    if (vaultUnlockedForUser) {
      logProgress(`Couldn't reach homeserver (${e.message}); continuing in local-only mode`);
      return await afterAuthStale(user, hs);
    }
    throw e;
  }
}

function makeOutboxFlusher() {
  return new OutboxFlusher({
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
}

// Reset the matrix-js-sdk live timeline for EVERY synced room, reclaiming the
// decrypted MatrixEvent objects the SDK accumulates — both account-wide (every
// room rides the full sync) and, crucially, in the active room during bulk
// writes, where local + remote echoes pile up fastest.
//
// This is safe even for the active room and even mid-send: the UI renders
// from OPFS + the fold, never the SDK timeline, and optimistic sends are
// reconciled when the *remote* echo arrives via sync (its unsigned
// transaction_id flows through onTimeline → reconcilePendingByTxn), which is
// independent of whatever the local timeline holds. So dropping the timeline
// costs nothing but frees the bytes.
const SDK_TIMELINE_RESET_THRESHOLD = 400;
function shedSdkTimelines() {
  const client = getClient();
  if (!client) return false;
  let freed = false;
  for (const room of client.getRooms()) {
    try {
      // Only reset rooms that have actually accumulated a meaningful timeline
      // (the active room during a bulk write). Resetting recreates the
      // timeline — which re-reads the room version etc. — so blindly doing it
      // to every quiet background room every interval was wasteful and noisy.
      if (room.getLiveTimeline().getEvents().length > SDK_TIMELINE_RESET_THRESHOLD) {
        room.resetLiveTimeline(null, null);
        freed = true;
      }
    } catch {}
  }
  return freed;
}

// Start the heap governor and register the evictors + diagnostics it runs
// under pressure. Idempotent — safe to call on every (re)auth.
function startMemoryGovernor() {
  memory.start({ budgetBytes: MEMORY_BUDGET_BYTES });
  if (unregisterRoomEvictor) unregisterRoomEvictor();

  const offs = [];

  // Soft: drop this app's inactive hydrated rooms + trim the log. Self-
  // throttled — closing a room forces an OPFS re-read on return, so we don't
  // want it firing every interval; the cheap SDK sweep below carries the
  // continuous shedding.
  let lastInactiveCloseAt = 0;
  offs.push(memory.registerEvictor('inactive-rooms', () => {
    const now = Date.now();
    if (now - lastInactiveCloseAt < 30_000) return false;
    lastInactiveCloseAt = now;
    const active = activeRoomId();
    let freed = false;
    for (const rid of [...openOrder]) {
      if (rid !== active) { closeRoom(rid); freed = true; }
    }
    if (progressLog.length > 12) { progressLog = progressLog.slice(-12); freed = true; }
    if (freed) notify('events');
    return freed;
  }, { priority: 100, level: 'soft' }));

  // Soft: release the SDK's timeline objects across all rooms. Cheap and
  // non-disruptive (the app never renders from the SDK timeline), so it runs
  // every interval and is the main continuous bound on SDK growth.
  offs.push(memory.registerEvictor('sdk-timelines', () => shedSdkTimelines(),
    { priority: 90, level: 'soft' }));

  // Diagnostic: when under pressure, log where the memory actually is, so a
  // console screenshot points straight at the real consumer instead of just
  // "shed inactive state". Rate-limited by the governor's shed cooldown.
  offs.push(memory.onPressure((level, sample) => {
    try {
      const s = getSdkStats();
      console.warn(
        `[memory] breakdown @ ${(sample.bytes / (1024 * 1024)).toFixed(0)}MB — ` +
        `sdkRooms=${s.sdkRooms} (workspaces=${s.workspaceRooms}), ` +
        `sdkMembers=${s.sdkMembers}, sdkStateEvents=${s.sdkStateEvents}, ` +
        `sdkLiveEvents=${s.sdkLiveEvents}, membersLoaded=${s.roomsWithMembersLoaded}, ` +
        `heldEvents=${s.heldEvents}, openRooms=${s.openRooms}`
      );
    } catch {}
  }));

  unregisterRoomEvictor = () => { for (const off of offs) { try { off(); } catch {} } };
}

async function afterAuth(userId, homeserver) {
  const liveClient = getClient();
  activeSession = {
    mxid: userId,
    homeserver: liveClient?.getHomeserverUrl?.() || homeserver,
    device_id: liveClient?.getDeviceId?.() || null,
    signed_in_at: Date.now(),
    stale: false,
  };

  if (outboxFlusher) outboxFlusher.stop();
  outboxFlusher = makeOutboxFlusher();
  outboxFlusher.start();

  startMemoryGovernor();

  if (unsubRoomChanges) unsubRoomChanges();
  unsubRoomChanges = onRoomChanges(() => {
    refreshManifestFromLive();
    notify('rooms');
  });

  // Prime the manifest cache from disk so listRooms() has something to
  // return immediately, even before the first sync completes.
  roomManifest = await loadManifest(userId);
  roomManifestKey = JSON.stringify(roomManifest);
  refreshManifestFromLive();

  await hydratePendingFromOutbox();
  notify('session');
  return activeSession;
}

/**
 * "Stale" session: vault is unlocked for `userId`, but the Matrix
 * client is not connected (no token, or homeserver unreachable). The
 * user can read OPFS-cached events + media and queue edits to the
 * outbox; the flusher will drain when a fresh login restores the
 * client.
 */
async function afterAuthStale(userId, homeserver) {
  activeSession = {
    mxid: userId,
    homeserver,
    device_id: null,
    signed_in_at: Date.now(),
    stale: true,
  };

  if (outboxFlusher) outboxFlusher.stop();
  outboxFlusher = makeOutboxFlusher();
  outboxFlusher.start();  // kick() is a no-op until getClient() comes back

  startMemoryGovernor();

  if (unsubRoomChanges) { unsubRoomChanges(); unsubRoomChanges = null; }

  roomManifest = await loadManifest(userId);
  roomManifestKey = JSON.stringify(roomManifest);

  await hydratePendingFromOutbox();
  notify('session');
  return activeSession;
}

function refreshManifestFromLive() {
  const userId = activeSession?.mxid;
  if (!userId) return;
  const live = discoverRooms(ROOM_TYPE);
  if (live.length === 0) return;
  // Only persist rooms we've actually joined. Pending invites are
  // attacker-controllable (anyone can stamp the meta event and invite us),
  // so caching them into the offline manifest would let a stranger's room
  // survive in the workspace list even offline. Invites still surface live
  // via discoverRooms; they just never get baked into the cache.
  const snapshot = live
    .filter(r => (r.membership || 'join') === 'join')
    .map(r => ({
      roomId: r.roomId,
      name: r.name || null,
      roomType: r.roomType || null,
      membership: 'join',
    }));
  if (snapshot.length === 0) return;
  const key = JSON.stringify(snapshot);
  if (key === roomManifestKey) return;
  roomManifest = snapshot;
  roomManifestKey = key;
  if (manifestSaveTimer) clearTimeout(manifestSaveTimer);
  manifestSaveTimer = setTimeout(() => {
    saveManifest(userId, snapshot).catch(e => console.warn('[bridge] manifest save failed:', e));
  }, 500);
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

/**
 * Re-attempt a full online login from local-only mode. Preserves the
 * vault, manifest, OPFS data, and outbox — just mints a fresh access
 * token and restarts sync. Throws if the password is wrong or the
 * homeserver still can't be reached.
 */
async function reconnect(password) {
  if (!activeSession || !activeSession.stale) {
    throw new Error('Not in local-only mode');
  }
  const userId = activeSession.mxid;
  const hs = activeSession.homeserver || '';
  if (!hs) throw new Error('No saved homeserver — sign out and back in');
  logProgress('Reconnecting…');
  // Keep whatever persistence the user chose at sign-in.
  const { userId: refreshedId } = await mxLogin(hs, userId, password, { persist: vault.isPersistent() });
  return await afterAuth(refreshedId, hs);
}

async function tearDownLiveState() {
  if (outboxFlusher) { outboxFlusher.stop(); outboxFlusher = null; }
  if (unsubRoomChanges) { unsubRoomChanges(); unsubRoomChanges = null; }
  if (manifestSaveTimer) { clearTimeout(manifestSaveTimer); manifestSaveTimer = null; }
  if (unregisterRoomEvictor) { unregisterRoomEvictor(); unregisterRoomEvictor = null; }
  memory.stop();
  for (const [, fns] of roomUnsubs) fns.forEach(fn => { try { fn(); } catch {} });
  roomUnsubs.clear();
  roomStores.clear();
  roomEvents.clear();
  openOrder.length = 0;
  pendingByLocalId.clear();
  sentEventToLocalId.clear();
  roomManifest = [];
  roomManifestKey = '';
}

async function logout() {
  await tearDownLiveState();
  await mxLogout();
  activeSession = null;
  notify('session');
}

/**
 * Hard reset: signs out AND wipes every byte of local state. Use when
 * the user explicitly asks to clear local data.
 */
async function clearLocalData() {
  await tearDownLiveState();
  await wipeLocalData();
  activeSession = null;
  notify('session');
}

// ── Rooms — filtered to ROOM_TYPE only ──
//
// When the SDK has rooms (sync ran), they're the source of truth and
// the manifest is refreshed from them. When the SDK is empty (cold
// offline boot, stale token), the manifest fills in so the user can
// still see the rooms they had before.
function listRooms() {
  const live = discoverRooms(ROOM_TYPE);
  if (live.length > 0) {
    refreshManifestFromLive();
    return live.map(r => ({
      id: r.roomId,
      name: r.name,
      eventCount: roomEvents.get(r.roomId)?.length || 0,
      namespace: NAMESPACE,
      title: r.name,
      membership: r.membership,
      roomType: r.roomType,
      inviter: r.inviter,
      encrypted: r.encrypted,
    }));
  }
  return roomManifest.map(r => ({
    id: r.roomId,
    name: r.name,
    eventCount: roomEvents.get(r.roomId)?.length || 0,
    namespace: NAMESPACE,
    title: r.name,
    membership: r.membership || 'join',
    roomType: r.roomType,
    inviter: null,
    offlineCache: true,
  }));
}

async function createWorkspace(name) {
  if (!getClient()) {
    throw new Error('Local-only mode — connect to the homeserver to create spaces');
  }
  const cleanName = String(name || '').trim() || 'space';
  const roomId = await mxCreateRoom(cleanName, ROOM_TYPE);
  logProgress(`Created space: ${cleanName}`);
  notify('rooms');
  return roomId;
}

async function joinRoom(roomId) {
  await acceptInvite(roomId);
  notify('rooms');
}

// ── Per-room lifecycle (bounded LRU) ──
//
// The UI only ever reads the active room (useLiveStore), but switching
// rooms used to leave every visited room's events + dedup set + SDK
// timeline pinned in memory for the rest of the session. We instead keep
// a small LRU: the most-recently-touched room is "active" and never
// evicted; rooms beyond MAX_OPEN_ROOMS are closed, freeing their memory.

function touchRoom(roomId) {
  const i = openOrder.indexOf(roomId);
  if (i >= 0) openOrder.splice(i, 1);
  openOrder.push(roomId);
}

function activeRoomId() {
  return openOrder.length ? openOrder[openOrder.length - 1] : null;
}

/**
 * Drop a room from memory: stop its listeners, release its events +
 * dedup set, and reset the matrix-js-sdk live timeline so the decrypted
 * MatrixEvent objects the SDK accumulated are reclaimed. History is
 * re-derived from OPFS on reopen, so nothing is lost — only re-read.
 */
function closeRoom(roomId) {
  const fns = roomUnsubs.get(roomId);
  if (fns) { fns.forEach(fn => { try { fn(); } catch {} }); roomUnsubs.delete(roomId); }
  roomStores.delete(roomId);
  roomEvents.delete(roomId);
  const i = openOrder.indexOf(roomId);
  if (i >= 0) openOrder.splice(i, 1);
  resetSdkTimeline(roomId);
}

/**
 * Release the SDK's in-memory timeline for a room. Best-effort: this app
 * reads history from OPFS, not the SDK cache, so a fresh empty live
 * timeline (re-paginated on demand) costs nothing but reclaims what can
 * be hundreds of MB of decrypted events for a large room.
 */
function resetSdkTimeline(roomId) {
  try {
    const room = getClient()?.getRoom?.(roomId);
    if (room && typeof room.resetLiveTimeline === 'function') {
      room.resetLiveTimeline(null, null);
    }
  } catch (e) {
    console.warn('[bridge] timeline reset failed:', e?.message || e);
  }
}

/**
 * Close least-recently-used rooms until at most `max` remain open. Skips
 * the active room and any room still mid-hydration (not yet in roomStores),
 * so a burst of room switches can't evict a room out from under its own
 * in-flight openRoom().
 */
function enforceRoomCap(max = MAX_OPEN_ROOMS) {
  const active = activeRoomId();
  for (let i = 0; i < openOrder.length && openOrder.length > max; ) {
    const victim = openOrder[i];
    if (victim === active || !roomStores.has(victim)) { i++; continue; }
    closeRoom(victim); // removes victim from openOrder — keep i fixed
    logProgress(`Closed inactive room to free memory`);
  }
}

// ── Per-room timeline ──
async function openRoom(roomId) {
  touchRoom(roomId);
  if (roomStores.has(roomId)) { enforceRoomCap(); return; } // already open

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
      // A first-time seed paginates the room's entire history into the SDK
      // timeline (one event per cell edit → potentially hundreds of MB of
      // decrypted MatrixEvent objects). Those bytes are now safely in OPFS,
      // so drop the SDK copy; live updates land in a fresh timeline and are
      // captured by the listeners attached below.
      if (newEvents.length > 2000) resetSdkTimeline(roomId);
    } catch (e) {
      logProgress(`Sync ${roomId}: ${e.message}`);
    }
  }

  // Without a Matrix client (local-only mode) we can't subscribe to
  // live events. The OPFS-loaded history above is still served to the
  // UI; new edits queue in the outbox and flush when the client returns.
  const fns = [];
  if (client) {
    try {
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
      fns.push(onMembersChange(roomId, () => notify('members')));
    } catch (e) {
      logProgress(`Subscribe ${roomId}: ${e.message}`);
    }
  }
  roomUnsubs.set(roomId, fns);
  enforceRoomCap();
}

// Committed (server-acked) events only. This list is strictly append-only
// per room — events are concatenated as they arrive and deduped, never
// reordered or removed — which is exactly what lets the UI fold it
// incrementally and cache the result. The array reference changes on
// append, but the event_id at any given index never does.
function getCommittedForRoom(roomId) {
  return roomEvents.get(roomId) || [];
}

// Pending (optimistic, not-yet-acked) events for a room, ts-sorted. Small
// and volatile: entries appear on emit and disappear on echo/reconcile, so
// the UI folds these fresh on top of the cached committed state rather than
// into the cache.
function getPendingForRoom(roomId) {
  const pending = [];
  for (const { roomId: rid, event } of pendingByLocalId.values()) {
    if (rid === roomId) pending.push(event);
  }
  pending.sort((a, b) => (a.origin_server_ts || 0) - (b.origin_server_ts || 0));
  return pending;
}

function getEventsForRoom(roomId) {
  const committed = getCommittedForRoom(roomId);
  const pending = getPendingForRoom(roomId);
  if (pending.length === 0) return committed;
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

// ── File import ──
//
// Encrypt the file in the browser, upload the ciphertext to the
// homeserver's media store, mirror the plaintext locally for offline
// reads, and emit timeline events that point to the blob. The
// decryption key travels inside the Megolm-encrypted event content,
// so the homeserver only ever sees opaque bytes.
//
// Layout: every import creates an `import` entity with the file ref +
// metadata. For CSV / JSON we additionally infer a schema and record a
// per-field extraction plan on that entity, then declare the derived set.
// The rows themselves are NOT emitted as events — they live in the uploaded
// blob and are reconstructed lazily on read (csv-import.jsx's
// materializeImportRows). A 10k-row import therefore costs a handful of
// events, not one INS + N DEFs per row. Callers can opt out of the dataset
// treatment with `materialize: false` (e.g. the CSV modal, which builds its
// own field plan from the user's column mapping and passes it via payload).
async function importFileToRoom(roomId, file, opts = {}) {
  if (!roomId) throw new Error('importFileToRoom needs a roomId');
  if (!file) throw new Error('importFileToRoom needs a file');
  if (!getClient()) {
    throw new Error('Offline — file imports need a live homeserver connection');
  }

  const entityType = opts.entityType || 'import';
  const displayName = opts.name || file.name || 'file';

  // Plan before upload so we can fail soft on malformed CSV/JSON and so the
  // derived set name is in hand by the time we INS the import entity.
  // Planning reads the file bytes from a fresh stream — uploading does not
  // consume the File.
  let plan = null;
  if (opts.materialize !== false) {
    try {
      plan = await planLazyImport(file, {
        existingTables: existingTablesIn(roomId),
      });
    } catch (e) {
      logProgress(`Could not parse ${displayName} as a dataset: ${e.message}`);
    }
  }

  logProgress(`Uploading ${displayName} (${file.size} bytes)…`);
  const ref = await mediaUploadFile(file, { name: displayName });
  logProgress(`Uploaded ${displayName} → ${ref.mxc}`);

  const payload = {
    name: displayName,
    size: ref.size,
    mime: ref.mime,
    ...(plan ? {
      derived_set: plan.setName,
      rows_imported: plan.totalRows,
      has_header: true,
      shape: plan.shape,
      field_plan: plan.fieldPlan,
    } : {}),
    ...(opts.payload || {}),
  };
  const anchor = await ins(roomId, entityType, payload);
  await def(roomId, anchor, 'file', ref);
  await def(roomId, anchor, 'imported_at', new Date().toISOString());

  // Declare the derived set's schema so the table view knows its columns
  // before any row is materialized. No per-row events.
  if (plan) {
    const tables = existingTablesIn(roomId);
    if (!tables.includes(plan.setName)) {
      await defSchema(roomId, 'tables', [...tables, plan.setName]);
    }
    await defSchema(roomId, `fields.${plan.setName}`, plan.fields);
    logProgress(`Set "${plan.setName}" ready · ${plan.totalRows} rows materialize on demand`);
  }

  notify('events');
  return { anchor, ref, derivedSet: plan?.setName || null };
}

// Read the current room timeline, fold it, and return the list of
// declared + observed set names. Used at import time so a derived set
// can claim a unique name without clobbering the existing schema.
function existingTablesIn(roomId) {
  try {
    const events = roomEvents.get(roomId) || [];
    const state = fold(events);
    const declared = state.schema?.tables || [];
    const observed = Array.from(new Set(
      Object.values(state.entities)
        .map(e => e._type)
        .filter(t => t && !t.startsWith('_'))
    ));
    return Array.from(new Set([...declared, ...observed]));
  } catch (e) {
    console.warn('[import] could not read existing tables:', e);
    return [];
  }
}

/**
 * Read the bytes referenced by a `__media` envelope. Tries the local
 * (vault-encrypted) mirror first, then falls back to the homeserver
 * media store (decrypting if needed). Returns null when unavailable.
 */
async function readMedia(ref) {
  return await getMediaBytes(ref);
}

async function inviteUser(roomId, userId) {
  await invite(roomId, userId);
  notify('members');
}

async function kickUser(roomId, userId, reason) {
  await kickMember(roomId, userId, reason);
  notify('members');
}

async function setUserPowerLevel(roomId, userId, level) {
  await setMemberPowerLevel(roomId, userId, level);
  notify('members');
}

function membersOf(roomId) { return getMembers(roomId); }
function myPowerLevelIn(roomId) { return myPowerLevel(roomId); }

// Pull a room's full member list into the SDK on demand (members are
// lazy-loaded to keep idle memory down). Notifies so the open members view
// re-renders with the complete list once it arrives.
async function loadMembers(roomId) {
  await loadRoomMembers(roomId);
  notify('members');
}

// Diagnostic: a rough breakdown of where in-memory state lives, so memory
// can be reasoned about from the console (window.MatrixLive.getSdkStats()).
// `sdkRooms` is every room the SDK syncs (all of the account's rooms, not
// just this app's workspaces); `sdkLiveEvents` is decrypted MatrixEvents the
// SDK holds across live timelines; `heldEvents` is this app's own committed
// op-events across open rooms.
function getSdkStats() {
  const client = getClient();
  let sdkRooms = 0, sdkLiveEvents = 0, membersLoaded = 0;
  let sdkMembers = 0, sdkStateEvents = 0, workspaceRooms = 0;
  if (client) {
    const rooms = client.getRooms();
    sdkRooms = rooms.length;
    const metaType = `${NAMESPACE}.meta`;
    for (const r of rooms) {
      try { sdkLiveEvents += r.getLiveTimeline().getEvents().length; } catch {}
      try { if (r.membersLoaded?.()) membersLoaded++; } catch {}
      // Member objects are the classic JS-heap hog for big accounts; counting
      // them (even lazily-loaded ones the SDK already has) tells us if that's
      // where the bytes are.
      try { sdkMembers += r.getMembers().length; } catch {}
      try {
        // Sum state events across the room (members, power levels, etc.).
        const cs = r.currentState;
        if (cs?.events) for (const m of cs.events.values()) sdkStateEvents += m.size || 0;
      } catch {}
      // How many of the synced rooms are actually this app's workspaces vs.
      // unrelated Matrix rooms riding along in the full-account sync.
      try { if (r.currentState?.getStateEvents(metaType, '')) workspaceRooms++; } catch {}
    }
  }
  let heldEvents = 0;
  for (const arr of roomEvents.values()) heldEvents += arr.length;
  return {
    sdkRooms,
    workspaceRooms,           // app rooms; sdkRooms - workspaceRooms = freeloaders
    sdkLiveEvents,
    sdkMembers,               // total RoomMember objects the SDK holds
    sdkStateEvents,
    roomsWithMembersLoaded: membersLoaded,
    openRooms: openOrder.length,
    heldEvents,               // this app's own committed op-events in memory
  };
}

async function renameRoom(roomId, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name required');
  await mxSetRoomName(roomId, clean);
  refreshManifestFromLive();
  notify('rooms');
}

function getMyDisplayName() {
  if (!activeSession) return null;
  return mxGetDisplayName(activeSession.mxid);
}

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
  reconnect,
  logout,
  clearLocalData,
  hasLocalAccount,
  getLastUser,
  getSession: () => activeSession,
  isAuthed: () => !!activeSession,
  isStale: () => !!(activeSession && activeSession.stale),
  isBooting: () => booting,
  // Rooms
  listRooms,
  createRoom: createWorkspace,
  joinRoom,
  openRoom,
  getEventsForRoom,
  getCommittedForRoom,
  getPendingForRoom,
  emit,
  inviteUser,
  kickUser,
  setUserPowerLevel,
  renameRoom,
  membersOf,
  loadMembers,
  myPowerLevelIn,
  getMyDisplayName,
  // File import / media
  importFile: importFileToRoom,
  readMedia,
  // Memory governor
  getMemoryStats: () => memory.getStats(),
  getSdkStats,
  setMemoryBudget: (bytes) => memory.setBudget(bytes),
  onMemoryPressure: (fn) => memory.onPressure(fn),
  checkMemory: () => memory.checkPressure(),
  // Net status
  getNetwork: () => netState,
  getSyncState: () => getClient()?.getSyncState?.() || null,
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

// Cold-boot auto-restore. If a previous unlock in this tab stashed the
// vault key in sessionStorage, we resume the Matrix session without
// returning to the login screen. The first `notify('session')` fires
// either when restore succeeds or when we conclude there's nothing to
// resume, so the React layer can mount immediately and show a "resuming"
// state instead of flashing the login portal.
(async () => {
  try {
    const result = await tryAutoUnlock();
    if (result) {
      const c = getClient();
      const hs = c?.getHomeserverUrl?.() || '';
      // Having a client at all is enough to call afterAuth — that
      // matches how loginWithMatrix routes the unlock path. If the
      // sync state is still RECONNECTING we'll show as online with
      // the network watcher; afterAuthStale is only for the no-client
      // case (vault unlocked but no usable Matrix token).
      if (c) await afterAuth(result.userId, hs);
      else   await afterAuthStale(result.userId, hs);
    }
  } catch (e) {
    console.warn('[bridge] auto-restore failed:', e);
    logProgress('Auto-restore failed: ' + (e?.message || e));
  } finally {
    booting = false;
    notify('session');
  }
})();
