/**
 * main.js — Entry point
 *
 * Three views layered on top of the modules:
 *
 *   committedState  = fold(store events)          // canonical, persisted
 *   pendingEvents   = unsent ops from the outbox  // queued locally
 *   displayState    = foldFrom(committedState, pending)  // what the UI shows
 *
 * The display always shows local edits, even when offline. The outbox
 * flushes them to Matrix when the network returns; the echoed event
 * gets stored in OPFS and (when matched by txnId) drops the pending
 * entry from the display.
 */

import { login, unlock, restoreSession, lock as lockSession, logout, hasLocalAccount,
         getClient, setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider } from './client.js';
import { setNamespace, OP, ins, def, seg, con, eva, rec, getNamespace, setOptimisticHook } from './operators.js';
import { fold, foldFrom, initial, entitiesOfType, stateHash } from './fold.js';
import { createRoom, discoverRooms, getTimeline, onTimeline, loadTimelineSince,
         invite, getMembers, acceptInvite, onRoomChanges, onDecrypted,
         onLocalEchoUpdated, EventStatus } from './rooms.js';
import { EventStore } from './store.js';
import { vault, getLastUser } from './vault.js';
import { OutboxFlusher, listAll as outboxListAll, pendingCount, onChange as onOutboxChange,
         remove as outboxRemove } from './outbox.js';
import { onNetworkChange, getNetworkState } from './network.js';

setNamespace('io.matrix-events');

// ── State ──
let currentRoomId = null;
let committedState = initial();
let displayState = initial();
let currentStore = null;
let unsubTimeline = null;
let unsubDecrypted = null;
let unsubLocalEcho = null;
let unsubRoomChanges = null;
let outboxFlusher = null;

// Pending optimistic events keyed by localId — only those in the
// current room appear in displayState.
const pendingByLocalId = new Map();

// Map from sent eventId → localId so timeline arrivals can match
// echoes that lack unsigned.transaction_id (some homeservers strip it
// from cross-federation events).
const sentEventToLocalId = new Map();

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    deriveDisplayState();
    renderState();
  });
}

const $ = (id) => document.getElementById(id);

// ── Boot ──
window.addEventListener('DOMContentLoaded', async () => {
  $('loginBtn').addEventListener('click', handleLogin);
  $('unlockBtn').addEventListener('click', handleUnlock);
  $('useDifferentAccountBtn').addEventListener('click', showLoginForm);
  $('logoutBtn').addEventListener('click', handleLogout);
  $('lockBtn').addEventListener('click', handleLock);
  $('createRoomBtn').addEventListener('click', handleCreateRoom);
  $('emitInsBtn').addEventListener('click', handleEmitIns);
  $('emitDefBtn').addEventListener('click', handleEmitDef);
  $('inviteBtn').addEventListener('click', handleInvite);
  $('syncNowBtn').addEventListener('click', () => outboxFlusher && outboxFlusher.kick());
  $('clearOutboxBtn').addEventListener('click', handleClearDeadOutbox);

  setProgress((msg) => log(msg));

  setRecoveryKeyDisplayer((key) => new Promise((resolve) => {
    $('recoveryKeyText').textContent = key;
    $('recoveryDisplayModal').classList.remove('hidden');
    const ack = () => {
      $('recoveryDisplayModal').classList.add('hidden');
      $('recoveryDisplayAck').removeEventListener('click', ack);
      resolve();
    };
    $('recoveryDisplayAck').addEventListener('click', ack);
  }));

  setRecoveryKeyProvider(() => new Promise((resolve) => {
    $('recoveryKeyInput').value = '';
    $('recoveryEntryModal').classList.remove('hidden');
    const cleanup = () => {
      $('recoveryEntryModal').classList.add('hidden');
      $('recoveryEntrySubmit').removeEventListener('click', submit);
      $('recoveryEntrySkip').removeEventListener('click', skip);
    };
    const submit = () => {
      const v = $('recoveryKeyInput').value.trim();
      cleanup();
      resolve(v || null);
    };
    const skip = () => { cleanup(); resolve(null); };
    $('recoveryEntrySubmit').addEventListener('click', submit);
    $('recoveryEntrySkip').addEventListener('click', skip);
  }));

  // Hook optimistic emits.
  setOptimisticHook(({ roomId, event }) => {
    pendingByLocalId.set(event.event_id, { roomId, event });
    if (roomId === currentRoomId) scheduleRender();
  });

  // React to outbox queue updates (status changes, retries, dead).
  onOutboxChange(() => {
    refreshOutboxBadge();
  });

  // Network status surface.
  onNetworkChange((state) => {
    updateNetworkBadge(state);
    if (state === 'online' && outboxFlusher) outboxFlusher.kick();
  });
  updateNetworkBadge(getNetworkState());

  // Vault state surface.
  vault.onChange(() => {
    updateLockBadge();
  });

  // Decide first screen.
  const lastUser = getLastUser();
  if (lastUser && hasLocalAccount(lastUser)) {
    showUnlockForm(lastUser);
  } else {
    showLoginForm();
  }

  // Register service worker for PWA install + offline shell.
  if ('serviceWorker' in navigator) {
    const swUrl = `${import.meta.env.BASE_URL || '/'}sw.js`;
    navigator.serviceWorker.register(swUrl).catch((e) => {
      console.warn('[sw] register failed:', e);
    });
  }
});

// ── Auth flow surfaces ──

function showLoginForm() {
  $('authPanel').classList.remove('hidden');
  $('unlockPanel').classList.add('hidden');
  $('appPanel').classList.add('hidden');
}

function showUnlockForm(userId) {
  $('authPanel').classList.add('hidden');
  $('unlockPanel').classList.remove('hidden');
  $('appPanel').classList.add('hidden');
  $('unlockUser').textContent = userId;
  $('unlockPass').value = '';
  setTimeout(() => $('unlockPass').focus(), 0);
}

async function handleLogin() {
  const rawUser = $('inUser').value.trim();
  const pass = $('inPass').value;
  let hs = $('inHS').value.trim();

  if (rawUser.includes(':')) {
    hs = 'https://' + rawUser.split(':').slice(1).join(':');
  }
  if (!hs) {
    log('Homeserver required', 'err');
    return;
  }

  log('Logging in…');
  try {
    const { userId } = await login(hs, rawUser, pass);
    await afterAuth(userId);
  } catch (e) {
    log('Login failed: ' + e.message, 'err');
  }
}

async function handleUnlock() {
  const pass = $('unlockPass').value;
  const userId = $('unlockUser').textContent.trim();
  if (!pass || !userId) return;
  log('Unlocking…');
  try {
    const { online } = await unlock(userId, pass);
    log(online ? 'Unlocked (online)' : 'Unlocked (offline mode)', 'ok');
    await afterAuth(userId);
  } catch (e) {
    log('Unlock failed: ' + e.message, 'err');
  }
}

async function afterAuth(userId) {
  $('authPanel').classList.add('hidden');
  $('unlockPanel').classList.add('hidden');
  $('appPanel').classList.remove('hidden');
  $('userDisplay').textContent = userId;
  log('Connected as ' + userId, 'ok');
  updateLockBadge();
  updateNetworkBadge(getNetworkState());

  // Start the outbox flusher.
  if (outboxFlusher) outboxFlusher.stop();
  outboxFlusher = new OutboxFlusher({
    getClient,
    onAck: ({ localId, eventId }) => {
      sentEventToLocalId.set(eventId, localId);
      // Pending stays until echo arrives via timeline and drops it.
    },
    onProgress: (e) => {
      if (e.type === 'hoisted') log(`Sync: hoisted ${e.count} field(s) to media`, 'ok');
      else if (e.type === 'sent') log(`Sync: event sent (${e.eventId.slice(0, 12)}…)`, 'ok');
      else if (e.type === 'retry') log(`Sync: retry #${e.attempts}${e.tooLarge ? ' (too large)' : ''} — ${e.error}`, 'err');
      else if (e.type === 'dead') {
        log(`Sync: gave up — ${e.error}`, 'err');
        // Drop dead entries from optimistic state so the UI stops
        // claiming an unsynced change exists. The IDB record stays
        // until Clear failed so the user can inspect it.
        if (pendingByLocalId.has(e.localId)) {
          pendingByLocalId.delete(e.localId);
          scheduleRender();
        }
      }
    },
  });
  outboxFlusher.start();

  if (unsubRoomChanges) unsubRoomChanges();
  unsubRoomChanges = onRoomChanges(() => refreshRooms());

  await hydratePendingFromOutbox();
  await refreshOutboxBadge();
  refreshRooms();
}

/**
 * Repopulate pendingByLocalId from the on-disk outbox so a reload
 * (or an offline unlock) still shows queued local edits in the UI.
 */
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
    console.warn('[main] hydrate outbox failed:', e);
  }
}

async function handleLock() {
  log('Locking…');
  if (currentStore && currentStore.hasData()) {
    try { await currentStore.saveCheckpoint(committedState); } catch {}
  }
  if (outboxFlusher) { outboxFlusher.stop(); outboxFlusher = null; }
  if (unsubRoomChanges) { unsubRoomChanges(); unsubRoomChanges = null; }
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }
  if (unsubLocalEcho) { unsubLocalEcho(); unsubLocalEcho = null; }
  await lockSession();
  pendingByLocalId.clear();
  sentEventToLocalId.clear();
  currentRoomId = null;
  currentStore = null;
  committedState = initial();
  displayState = initial();
  const lastUser = getLastUser();
  if (lastUser) showUnlockForm(lastUser);
  else showLoginForm();
  log('Locked');
}

async function handleLogout() {
  const sure = confirm('Logout will wipe ALL local data on this device. Continue?');
  if (!sure) return;
  log('Logging out…');
  if (outboxFlusher) { outboxFlusher.stop(); outboxFlusher = null; }
  if (unsubRoomChanges) { unsubRoomChanges(); unsubRoomChanges = null; }
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }
  if (unsubLocalEcho) { unsubLocalEcho(); unsubLocalEcho = null; }
  await logout();
  pendingByLocalId.clear();
  sentEventToLocalId.clear();
  currentRoomId = null;
  currentStore = null;
  committedState = initial();
  displayState = initial();
  showLoginForm();
  log('Logged out');
}

// ── Status badges ──

function updateNetworkBadge(state) {
  const el = $('netBadge');
  if (!el) return;
  el.className = 'badge ' + state;
  el.textContent = state === 'online' ? '● online'
    : state === 'degraded' ? '● degraded'
    : '● offline';
}

function updateLockBadge() {
  const el = $('lockBadge');
  if (!el) return;
  const unlocked = vault.isUnlocked();
  el.className = 'badge ' + (unlocked ? 'unlocked' : 'locked');
  el.textContent = unlocked ? '🔓 vault unlocked' : '🔒 vault locked';
}

async function refreshOutboxBadge() {
  const el = $('outboxBadge');
  if (!el) return;
  try {
    const n = await pendingCount();
    el.textContent = n > 0 ? `↻ ${n} queued` : '✓ in sync';
    el.className = 'badge ' + (n > 0 ? 'queued' : 'idle');
    // Always re-derive: pending may have moved between rooms.
    scheduleRender();
  } catch (e) {
    el.textContent = '? outbox';
    el.className = 'badge';
  }
}

async function handleClearDeadOutbox() {
  const all = await outboxListAll();
  const dead = all.filter(r => r.status === 'dead');
  if (dead.length === 0) {
    log('No failed entries to clear');
    return;
  }
  for (const r of dead) await outboxRemove(r.localId);
  log(`Cleared ${dead.length} failed entries`, 'ok');
}

// ── Rooms ──

async function refreshRooms() {
  const rooms = discoverRooms();
  const list = $('roomList');
  list.innerHTML = '';

  if (rooms.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim)">No rooms yet</div>';
    return;
  }

  rooms.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'room-item' + (r.roomId === currentRoomId ? ' active' : '');
    if (r.membership === 'invite') {
      const from = r.inviter ? ` from ${r.inviter}` : '';
      el.textContent = `${r.name} (invite${from}) — click to accept`;
      el.style.color = 'var(--accent)';
      el.addEventListener('click', () => handleAcceptInvite(r.roomId, r.name));
    } else {
      el.textContent = `${r.name} (${r.roomType})`;
      el.addEventListener('click', () => openRoom(r.roomId, r.name));
    }
    list.appendChild(el);
  });
}

async function handleAcceptInvite(roomId, name) {
  log(`Accepting invite to ${name}…`);
  try {
    await acceptInvite(roomId);
    log(`Joined ${name}`, 'ok');
  } catch (e) {
    log('Accept failed: ' + e.message, 'err');
  }
}

async function handleCreateRoom() {
  const name = $('newRoomName').value.trim();
  const type = $('newRoomType').value.trim() || 'general';
  if (!name) return;

  log('Creating room…');
  try {
    const roomId = await createRoom(name, type);
    log('Created: ' + roomId, 'ok');
    $('newRoomName').value = '';
    setTimeout(() => {
      refreshRooms();
      openRoom(roomId, name);
    }, 1000);
  } catch (e) {
    log('Failed: ' + e.message, 'err');
  }
}

async function openRoom(roomId, name) {
  // Cleanup previous room.
  if (currentStore && currentStore.hasData()) {
    try { await currentStore.saveCheckpoint(committedState); } catch {}
  }
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }
  if (unsubLocalEcho) { unsubLocalEcho(); unsubLocalEcho = null; }

  currentRoomId = roomId;
  committedState = initial();
  displayState = initial();
  $('currentRoomName').textContent = name;
  $('roomControls').classList.remove('hidden');
  refreshRooms();

  // 1. Open store.
  currentStore = new EventStore(roomId, getNamespace());
  await currentStore.open();

  const storedCount = currentStore.getCount();
  const cursor = currentStore.getCursor();

  // 2. Fold from local.
  if (storedCount > 0) {
    const checkpoint = await currentStore.loadCheckpoint();
    if (checkpoint && checkpoint.cursor <= cursor) {
      committedState = checkpoint.state;
      if (committedState._undecryptable === undefined) committedState._undecryptable = 0;
      if (!committedState._violations) committedState._violations = [];
      const delta = await currentStore.getEventsSince(checkpoint.cursor);
      if (delta.length > 0) {
        committedState = foldFrom(committedState, delta);
        log(`Restored checkpoint + ${delta.length} delta events`, 'ok');
      } else {
        log(`Restored checkpoint (${checkpoint.count} events, no delta)`, 'ok');
      }
    } else {
      log(`Full replay of ${storedCount} events from OPFS…`);
      const allEvents = await currentStore.getAll();
      committedState = fold(allEvents);
      log(`Fold complete`, 'ok');
      await currentStore.saveCheckpoint(committedState);
    }
    deriveDisplayState();
    renderState();
    refreshMembers();
  }

  // 3. Sync delta from Matrix (best-effort; may be offline).
  const client = getClient();
  if (!client) {
    log('Offline — using local data only', 'ok');
    deriveDisplayState();
    renderState();
    return;
  }

  if (cursor > 0) log('Checking for new server events…');
  else log('Loading full timeline from server…');

  try {
    const { newEvents } = await loadTimelineSince(roomId, cursor);

    if (newEvents.length > 0) {
      await new Promise(r => setTimeout(r, 1500));
      const freshTimeline = getTimeline(roomId);
      const freshNew = cursor > 0
        ? freshTimeline.filter(e => {
            const ts = typeof e.getTs === 'function' ? e.getTs() : e.origin_server_ts || 0;
            return ts >= cursor;
          })
        : freshTimeline;

      // Skip our own in-flight local echoes; the LocalEchoUpdated path
      // will commit them when SENT.
      const filtered = freshNew.filter(e => !isOwnLocalEcho(e));
      const added = await currentStore.append(filtered);
      // Drop any pending entries that this initial batch acknowledged
      // via unsigned.transaction_id.
      for (const e of freshNew) reconcilePendingByTxn(e);

      if (added.length > 0) {
        committedState = foldFrom(committedState, added);
        log(`${added.length} new events synced + folded`, 'ok');
      }
      deriveDisplayState();
      renderState();
    } else if (storedCount === 0) {
      log('Room is empty', 'ok');
      deriveDisplayState();
      renderState();
    } else {
      log(`${storedCount} events, all up to date`, 'ok');
    }
  } catch (e) {
    log('Sync failed (continuing offline): ' + e.message, 'err');
    deriveDisplayState();
    renderState();
  }

  // 4. Live listeners.
  //
  // Three Matrix event paths arrive here:
  //   - Timeline: new events from /sync, plus the SDK's local-echo
  //     placeholders (event_id "~..."). We skip our own placeholders
  //     and let the LocalEchoUpdated path commit them once they're
  //     SENT with a real id.
  //   - Decrypted: an encrypted event got its keys and is now readable.
  //   - LocalEchoUpdated: status/id transitions for events we sent.
  unsubTimeline = onTimeline(roomId, async (event) => {
    if (!currentStore) return;
    if (isOwnLocalEcho(event)) return; // wait for LocalEchoUpdated → SENT
    const added = await currentStore.append([event]);
    if (added.length > 0) {
      committedState = foldFrom(committedState, added);
      scheduleRender();
      if (currentStore.shouldCheckpoint()) {
        try { await currentStore.saveCheckpoint(committedState); } catch {}
      }
    }
  });

  unsubDecrypted = onDecrypted(roomId, async (event) => {
    if (!currentStore) return;
    if (isOwnLocalEcho(event)) return;
    const added = await currentStore.append([event]);
    if (added.length > 0) {
      committedState = foldFrom(committedState, added);
      scheduleRender();
    }
  });

  unsubLocalEcho = onLocalEchoUpdated(roomId, async (event, oldEventId, oldStatus) => {
    if (!currentStore) return;
    const status = event.status;
    if (status === EventStatus.SENT) {
      // SDK swapped the placeholder for the real event_id. Persist and
      // drop the optimistic pending entry.
      const added = await currentStore.append([event]);
      if (added.length > 0) {
        committedState = foldFrom(committedState, added);
      }
      reconcilePendingByTxn(event);
      scheduleRender();
    } else if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) {
      // The send failed at the SDK layer (not the outbox layer). Leave
      // the pending entry in place; the outbox will retry it.
      scheduleRender();
    }
  });
}

/**
 * Detect the SDK's local-echo placeholder for one of our outbox sends.
 * The placeholder has a synthetic event_id ("~roomId:txnId"), no real
 * server origin, and event.getTxnId() returns the txnId we passed in.
 *
 * We skip these from the store + fold; the LocalEchoUpdated event
 * commits the real version once the server accepts it.
 */
function isOwnLocalEcho(event) {
  const txn = typeof event.getTxnId === 'function' ? event.getTxnId() : null;
  if (txn && pendingByLocalId.has(txn)) return true;
  const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id;
  return typeof eventId === 'string' && eventId.startsWith('~');
}

/**
 * Drop a pending optimistic entry by either txnId or by event_id (for
 * /sync echoes that arrive without a local placeholder, e.g. on a
 * cold start while the outbox flusher is still racing).
 */
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
    scheduleRender();
  }
}

/**
 * Recompute the display state: committed + the pending events for the
 * current room. structuredClone keeps the committed state intact so
 * stale pendings don't pollute it.
 */
function deriveDisplayState() {
  const pending = [];
  for (const { roomId, event } of pendingByLocalId.values()) {
    if (roomId === currentRoomId) pending.push(event);
  }
  if (pending.length === 0) {
    displayState = committedState;
    return;
  }
  // Clone only what fold mutates — entities, partitions, connections,
  // frames, schema. _violations is fine.
  const cloned = {
    ...committedState,
    entities: structuredClone(committedState.entities),
    partitions: { ...committedState.partitions },
    connections: [...committedState.connections],
    frames: [...committedState.frames],
    schema: structuredClone(committedState.schema),
    _violations: [...(committedState._violations || [])],
  };
  pending.sort((a, b) => (a.origin_server_ts || 0) - (b.origin_server_ts || 0));
  displayState = foldFrom(cloned, pending);
  // Tag entities created/touched by pending so the UI can show them.
  for (const p of pending) {
    if (p.content && p.content.anchor && displayState.entities[p.content.anchor]) {
      displayState.entities[p.content.anchor]._pending = true;
    }
  }
}

// ── Emit ──
async function handleEmitIns() {
  if (!currentRoomId) return;
  const type = prompt('Entity type:', 'item');
  if (!type) return;
  const title = prompt('Title:', '');

  log('Emitting INS…');
  try {
    const anchor = await ins(currentRoomId, type, { title: title || 'Untitled' });
    log(`INS → ${anchor} (queued)`, 'ok');
  } catch (e) {
    log('Failed: ' + e.message, 'err');
  }
}

async function handleEmitDef() {
  if (!currentRoomId) return;
  const anchors = Object.keys(displayState.entities);
  if (anchors.length === 0) {
    log('No entities to update — create one first', 'err');
    return;
  }

  const anchor = prompt('Anchor:\n' + anchors.join('\n'), anchors[0]);
  if (!anchor) return;

  if (!displayState.entities[anchor]) {
    log(`Anchor ${anchor} does not exist — INS must precede DEF`, 'err');
    return;
  }

  const path = prompt('Path:', 'status');
  const value = prompt('Value:', 'active');

  log('Emitting DEF…');
  try {
    await def(currentRoomId, anchor, path, value);
    log(`DEF → ${anchor}.${path} = ${value} (queued)`, 'ok');
  } catch (e) {
    log('Failed: ' + e.message, 'err');
  }
}

function refreshMembers() {
  if (!currentRoomId) return;
  const members = getMembers(currentRoomId);
  const el = $('memberList');
  el.textContent = members.map((m) => m.displayName).join(', ') || 'just you';
}

async function handleInvite() {
  if (!currentRoomId) return;
  const userId = prompt('User ID to invite:', '@user:homeserver.com');
  if (!userId || !userId.includes(':')) return;

  log('Inviting ' + userId + '…');
  try {
    await invite(currentRoomId, userId);
    log('Invited ' + userId, 'ok');
    refreshMembers();
  } catch (e) {
    log('Invite failed: ' + e.message, 'err');
  }
}

// ── Render ──
let lastStateHash = 0;

function renderState() {
  const el = $('stateView');
  const currentHash = stateHash(displayState);
  if (lastStateHash !== 0 && currentHash === lastStateHash) return;
  lastStateHash = currentHash;

  const undecryptable = displayState._undecryptable || 0;
  const violations = displayState._violations || [];
  let display = JSON.stringify(displayState, null, 2);

  const lines = [];
  if (currentStore && currentStore.hasData()) {
    const bytes = currentStore.getByteSize();
    const count = currentStore.getCount();
    lines.push(`📦 ${count} events in OPFS (${(bytes / 1024).toFixed(1)} KB, encrypted)`);
  }
  let pendingForRoom = 0;
  for (const { roomId } of pendingByLocalId.values()) {
    if (roomId === currentRoomId) pendingForRoom++;
  }
  if (pendingForRoom > 0) {
    lines.push(`↻ ${pendingForRoom} pending local change(s) — will sync when online`);
  }
  if (undecryptable > 0) {
    lines.push(`⚠ ${undecryptable} event(s) still encrypted (waiting for keys)`);
  }
  if (violations.length > 0) {
    lines.push(`⚡ ${violations.length} dependency violation(s):`);
    const recent = violations.slice(-5);
    for (const v of recent) {
      if (v.type === 'criterionless_judgment') {
        lines.push(`  EVA on ${v.anchor} — no prior DEF (hwm=${v.hwm})`);
      } else if (v.type === 'cartesian_product') {
        lines.push(`  CON ${v.source}→${v.target} — ${v.missing} missing`);
      } else if (v.type === 'blind_restructuring') {
        lines.push(`  REC without prior EVA`);
      } else if (v.type === 'missing_ins') {
        lines.push(`  ${v.op} on ${v.anchor} — not yet INS'd`);
      }
    }
  }
  if (lines.length > 0) {
    display = lines.join('\n') + '\n\n' + display;
  }

  el.textContent = display;
  refreshMembers();
}

function log(msg, cls = '') {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.innerHTML += `<div class="${cls}">[${t}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}
