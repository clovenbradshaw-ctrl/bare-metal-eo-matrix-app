/**
 * main.js — Entry point
 *
 * Fold once from the OPFS store (or checkpoint + delta).
 * After that, every new event is foldFrom() — O(1) per event.
 * The full fold never runs again unless the store is empty.
 */

import { login, restoreSession, logout, getClient, setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider } from './client.js';
import { setNamespace, OP, ins, def, seg, con, eva, rec, getNamespace } from './operators.js';
import { fold, foldFrom, initial, entitiesOfType, stateHash } from './fold.js';
import { createRoom, discoverRooms, getTimeline, onTimeline, loadTimelineSince, invite, getMembers, acceptInvite, onRoomChanges, onDecrypted } from './rooms.js';
import { EventStore } from './store.js';

// ── Configure namespace for your app ──
setNamespace('io.matrix-events');

// ── State ──
let currentRoomId = null;
let currentState = initial();
let currentStore = null;
let unsubTimeline = null;
let unsubDecrypted = null;
let unsubRoomChanges = null;

// ── Render coalescing ──
// Fold is O(1) per event. Render (JSON.stringify of full state) is
// O(n). So we fold immediately on each event but coalesce renders
// to the next animation frame.
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderState();
    renderScheduled = false;
  });
}

// ── DOM helpers ──
const $ = (id) => document.getElementById(id);

// ── Boot ──
window.addEventListener('DOMContentLoaded', async () => {
  $('loginBtn').addEventListener('click', handleLogin);
  $('logoutBtn').addEventListener('click', handleLogout);
  $('createRoomBtn').addEventListener('click', handleCreateRoom);
  $('emitInsBtn').addEventListener('click', handleEmitIns);
  $('emitDefBtn').addEventListener('click', handleEmitDef);
  $('inviteBtn').addEventListener('click', handleInvite);

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

  const client = await restoreSession();
  if (client) {
    showApp(client.getUserId());
  }
});

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
    showApp(userId);
  } catch (e) {
    log('Login failed: ' + e.message, 'err');
  }
}

async function handleLogout() {
  // Save checkpoint before leaving
  if (currentStore && currentStore.hasData()) {
    await currentStore.saveCheckpoint(currentState);
  }
  if (unsubRoomChanges) { unsubRoomChanges(); unsubRoomChanges = null; }
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }
  await logout();
  $('authPanel').classList.remove('hidden');
  $('appPanel').classList.add('hidden');
  log('Logged out');
}

function showApp(userId) {
  $('authPanel').classList.add('hidden');
  $('appPanel').classList.remove('hidden');
  $('userDisplay').textContent = userId;
  log('Connected as ' + userId, 'ok');

  if (unsubRoomChanges) unsubRoomChanges();
  unsubRoomChanges = onRoomChanges(() => refreshRooms());

  refreshRooms();
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
    // Let onRoomChanges handle the refresh once state syncs.
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

/**
 * openRoom — the core flow.
 *
 * 1. Open OPFS store
 * 2. Try checkpoint → delta fold (fastest cold start)
 * 3. If no checkpoint → full fold from store (one-time O(n))
 * 4. If no store data → load full timeline from Matrix, persist, fold
 * 5. Sync delta from Matrix for events between sessions
 * 6. Wire live listeners with incremental fold
 */
async function openRoom(roomId, name) {
  // ── Cleanup previous room ──
  if (currentStore && currentStore.hasData()) {
    await currentStore.saveCheckpoint(currentState);
  }
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }

  currentRoomId = roomId;
  currentState = initial();
  $('currentRoomName').textContent = name;
  $('roomControls').classList.remove('hidden');
  refreshRooms();

  // ── 1. Open store ──
  currentStore = new EventStore(roomId, getNamespace());
  await currentStore.open();

  const storedCount = currentStore.getCount();
  const cursor = currentStore.getCursor();

  // ── 2. Fold from local (checkpoint + delta OR full replay) ──
  if (storedCount > 0) {
    const checkpoint = await currentStore.loadCheckpoint();

    if (checkpoint && checkpoint.cursor <= cursor) {
      currentState = checkpoint.state;
      if (currentState._undecryptable === undefined) currentState._undecryptable = 0;
      if (!currentState._violations) currentState._violations = [];

      const delta = await currentStore.getEventsSince(checkpoint.cursor);
      if (delta.length > 0) {
        currentState = foldFrom(currentState, delta);
        log(`Restored checkpoint + ${delta.length} delta events`, 'ok');
      } else {
        log(`Restored checkpoint (${checkpoint.count} events, no delta)`, 'ok');
      }
    } else {
      log(`Full replay of ${storedCount} events from OPFS…`);
      const allEvents = await currentStore.getAll();
      currentState = fold(allEvents);
      log(`Fold complete`, 'ok');
      await currentStore.saveCheckpoint(currentState);
    }

    renderState();
    refreshMembers();
  }

  // ── 3. Sync delta from Matrix ──
  // The SDK sync loop has already delivered recent events to the
  // in-memory timeline. We check what's there that isn't in our store.
  if (cursor > 0) {
    log('Checking for new server events…');
  } else {
    log('Loading full timeline from server…');
  }

  const { total, newEvents } = await loadTimelineSince(roomId, cursor);

  if (newEvents.length > 0) {
    // Brief pause for decryption on the batch
    await new Promise(r => setTimeout(r, 1500));

    // Re-fetch timeline — some events may have decrypted during wait
    const freshTimeline = getTimeline(roomId);
    const freshNew = cursor > 0
      ? freshTimeline.filter(e => {
          const ts = typeof e.getTs === 'function' ? e.getTs() : e.origin_server_ts || 0;
          return ts >= cursor; // >= not > to catch same-timestamp events; dedup handles dupes
        })
      : freshTimeline;

    const added = await currentStore.append(freshNew);
    if (added.length > 0) {
      // Incremental fold — O(delta), not O(total)
      currentState = foldFrom(currentState, added);
      log(`${added.length} new events synced + folded`, 'ok');
      renderState();
    }
  } else if (storedCount === 0) {
    log('Room is empty', 'ok');
    renderState();
  } else {
    log(`${storedCount} events, all up to date`, 'ok');
  }

  // ── 4. Wire live listeners (incremental) ──

  // New events from the sync loop — each one is O(1) fold
  unsubTimeline = onTimeline(roomId, async (event) => {
    if (!currentStore) return;
    const added = await currentStore.append([event]);
    if (added.length > 0) {
      currentState = foldFrom(currentState, added);
      scheduleRender();

      // Periodic checkpoint
      if (currentStore.shouldCheckpoint()) {
        await currentStore.saveCheckpoint(currentState);
      }
    }
  });

  // Late decryption — event was encrypted when first seen, now has keys.
  // The event object itself has been updated in place by the SDK.
  // Pass it to append (dedup prevents double-storing if already known).
  unsubDecrypted = onDecrypted(roomId, async (event) => {
    if (!currentStore) return;
    const added = await currentStore.append([event]);
    if (added.length > 0) {
      currentState = foldFrom(currentState, added);
      scheduleRender();
    }
  });
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
    log(`INS → ${anchor}`, 'ok');
  } catch (e) {
    log('Failed: ' + e.message, 'err');
  }
}

async function handleEmitDef() {
  if (!currentRoomId) return;
  const anchors = Object.keys(currentState.entities);
  if (anchors.length === 0) {
    // Dependency enforcement: DEF requires INS
    log('No entities to update — create one first', 'err');
    return;
  }

  const anchor = prompt('Anchor:\n' + anchors.join('\n'), anchors[0]);
  if (!anchor) return;

  // Validate anchor exists — dependency check
  if (!currentState.entities[anchor]) {
    log(`Anchor ${anchor} does not exist — INS must precede DEF`, 'err');
    return;
  }

  const path = prompt('Path:', 'status');
  const value = prompt('Value:', 'active');

  log('Emitting DEF…');
  try {
    await def(currentRoomId, anchor, path, value);
    log(`DEF → ${anchor}.${path} = ${value}`, 'ok');
  } catch (e) {
    log('Failed: ' + e.message, 'err');
  }
}

// ── Members ──
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

  // Git-style change detection: skip render if state hasn't changed
  const currentHash = stateHash(currentState);
  if (lastStateHash !== 0 && currentHash === lastStateHash) return;
  lastStateHash = currentHash;

  const undecryptable = currentState._undecryptable || 0;
  const violations = currentState._violations || [];
  let display = JSON.stringify(currentState, null, 2);

  const lines = [];
  if (currentStore && currentStore.hasData()) {
    const bytes = currentStore.getByteSize();
    const count = currentStore.getCount();
    lines.push(`📦 ${count} events in OPFS (${(bytes / 1024).toFixed(1)} KB)`);
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

// ── Log ──
function log(msg, cls = '') {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.innerHTML += `<div class="${cls}">[${t}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}
