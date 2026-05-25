/**
 * main.js — Entry point
 *
 * Minimal proof-of-life UI. Login, pick/create a room, emit events,
 * see the fold. Replace this file with your app's UI.
 * The foundation (client, operators, fold, rooms) stays the same.
 */

import { login, restoreSession, logout, getClient, setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider } from './client.js';
import { setNamespace, OP, ins, def, seg, con, eva, rec } from './operators.js';
import { fold, foldFrom, initial, entitiesOfType } from './fold.js';
import { createRoom, discoverRooms, getTimeline, onTimeline, loadFullTimeline, invite, getMembers, acceptInvite, onRoomChanges, onDecrypted } from './rooms.js';

// ── Configure namespace for your app ──
setNamespace('io.matrix-events');

// ── State ──
let currentRoomId = null;
let currentState = initial();
let unsubTimeline = null; // cleanup handle for room listener
let unsubDecrypted = null; // cleanup handle for late-decryption listener
let unsubRoomChanges = null; // cleanup handle for room-list listener

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

  // Surface per-step progress from client.js into the UI log so a stalled
  // login shows which phase it's stuck in (auth / crypto / sync).
  setProgress((msg) => log(msg));

  // Recovery-key display: shown once, after first-time bootstrap.
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

  // Recovery-key entry: shown on a new device that needs to unlock secret
  // storage. Resolves to the entered key string or null if skipped.
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

  // Try session restore
  const client = await restoreSession();
  if (client) {
    showApp(client.getUserId());
  }
});

async function handleLogin() {
  const rawUser = $('inUser').value.trim();
  const pass = $('inPass').value;
  let hs = $('inHS').value.trim();

  // Extract homeserver from username if present
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
    // refreshRooms fires automatically via onRoomChanges once membership flips,
    // but call it directly so the click feels responsive.
    refreshRooms();
    openRoom(roomId, name);
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

    // Wait a tick for sync to pick up the new room
    setTimeout(() => {
      refreshRooms();
      openRoom(roomId, name);
    }, 1000);
  } catch (e) {
    log('Failed: ' + e.message, 'err');
  }
}

async function openRoom(roomId, name) {
  // Clean up previous room listeners
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }

  currentRoomId = roomId;
  $('currentRoomName').textContent = name;
  $('roomControls').classList.remove('hidden');
  refreshRooms();

  // Load complete history before folding — the fold needs ALL events
  log('Loading full timeline…');
  const count = await loadFullTimeline(roomId);
  log(`${count} events loaded`, 'ok');

  recomputeState();

  // Listen for new events — recompute state on each
  unsubTimeline = onTimeline(roomId, () => recomputeState());
  // Re-fold when keys arrive later and previously-encrypted events
  // become readable. Without this, the fold permanently ignores any
  // event that was still encrypted at first load.
  unsubDecrypted = onDecrypted(roomId, () => recomputeState());
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
    log('No entities to update — create one first', 'err');
    return;
  }

  const anchor = prompt('Anchor:\n' + anchors.join('\n'), anchors[0]);
  if (!anchor) return;
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

// ── Fold ──
function recomputeState() {
  if (!currentRoomId) return;
  const events = getTimeline(currentRoomId);
  currentState = fold(events);
  renderState();
  refreshMembers();
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

function renderState() {
  const el = $('stateView');
  el.textContent = JSON.stringify(currentState, null, 2);
}

// ── Log ──
function log(msg, cls = '') {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.innerHTML += `<div class="${cls}">[${t}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}
