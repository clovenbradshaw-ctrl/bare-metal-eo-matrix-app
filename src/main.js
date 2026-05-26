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

import { login, register, unlock, lock as lockSession, logout, hasLocalAccount,
         getClient, setProgress, setRecoveryKeyDisplayer, setRecoveryKeyProvider } from './client.js';
import { setNamespace, ins, def, seg, con, syn, eva, rec, getNamespace, setOptimisticHook } from './operators.js';
import { fold, foldFrom, initial } from './fold.js';
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
let currentRoomName = null;
let committedState = initial();
let displayState = initial();
let currentStore = null;
let currentEvents = []; // ordered timeline events for log view
let unsubTimeline = null;
let unsubDecrypted = null;
let unsubLocalEcho = null;
let unsubRoomChanges = null;
let outboxFlusher = null;

let currentView = 'log';
let currentTableType = null;

// Pending optimistic events keyed by localId — only those in the
// current room appear in displayState.
const pendingByLocalId = new Map();

// Map from sent eventId → localId so timeline arrivals can match
// echoes that lack unsigned.transaction_id.
const sentEventToLocalId = new Map();

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    deriveDisplayState();
    rebuildEventList();
    renderCurrentView();
    renderScrubber();
  });
}

const $ = (id) => document.getElementById(id);

// ── Boot ──
window.addEventListener('DOMContentLoaded', async () => {
  wireAuthScreen();
  wireUnlockScreen();
  wireAppShell();
  wireOpsPalette();

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

  setOptimisticHook(({ roomId, event }) => {
    pendingByLocalId.set(event.event_id, { roomId, event });
    if (roomId === currentRoomId) scheduleRender();
  });

  onOutboxChange(() => { refreshOutboxBadge(); });

  onNetworkChange((state) => {
    updateNetworkBadge(state);
    if (state === 'online' && outboxFlusher) outboxFlusher.kick();
  });
  updateNetworkBadge(getNetworkState());

  vault.onChange(() => { updateLockBadge(); });

  const lastUser = getLastUser();
  if (lastUser && hasLocalAccount(lastUser)) {
    showUnlockScreen(lastUser);
  } else {
    showAuthScreen();
  }

  if ('serviceWorker' in navigator) {
    const swUrl = `${import.meta.env.BASE_URL || '/'}sw.js`;
    navigator.serviceWorker.register(swUrl).catch((e) => {
      console.warn('[sw] register failed:', e);
    });
  }
});

// ── Screen routing ──
function showAuthScreen() {
  $('authScreen').classList.remove('hidden');
  $('unlockScreen').classList.add('hidden');
  $('appShell').classList.add('hidden');
}
function showUnlockScreen(userId) {
  $('authScreen').classList.add('hidden');
  $('unlockScreen').classList.remove('hidden');
  $('appShell').classList.add('hidden');
  $('unlockUser').textContent = userId;
  $('unlockPass').value = '';
  $('unlockError').classList.add('hidden');
  setTimeout(() => $('unlockPass').focus(), 0);
}
function showAppShell(userId) {
  $('authScreen').classList.add('hidden');
  $('unlockScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('userDisplay').textContent = userId;
}

// ── Auth screen ──
function wireAuthScreen() {
  document.querySelectorAll('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.authTab;
      document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b === btn));
      $('signinPane').classList.toggle('hidden', tab !== 'signin');
      $('registerPane').classList.toggle('hidden', tab !== 'register');
      $('authError').classList.add('hidden');
      $('authInfo').classList.add('hidden');
    });
  });

  const updateSuffix = (input, suffix, hsInput) => () => {
    const v = input.value.trim();
    if (v.includes(':')) {
      const host = v.split(':').slice(1).join(':');
      suffix.textContent = ':' + host;
      hsInput.value = host;
    } else {
      const hs = hsInput.value.trim() || 'matrix.org';
      suffix.textContent = ':' + hs;
    }
  };
  $('inUser').addEventListener('input', updateSuffix($('inUser'), $('inUserSuffix'), $('inHS')));
  $('inHS').addEventListener('input', () => {
    if (!$('inUser').value.includes(':')) {
      $('inUserSuffix').textContent = ':' + ($('inHS').value.trim() || 'matrix.org');
    }
  });
  $('regUser').addEventListener('input', updateSuffix($('regUser'), $('regUserSuffix'), $('regHS')));
  $('regHS').addEventListener('input', () => {
    if (!$('regUser').value.includes(':')) {
      $('regUserSuffix').textContent = ':' + ($('regHS').value.trim() || 'matrix.org');
    }
  });

  $('loginBtn').addEventListener('click', handleLogin);
  $('registerBtn').addEventListener('click', handleRegister);

  // Enter to submit
  [$('inUser'), $('inPass'), $('inHS')].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); }));
  [$('regUser'), $('regPass'), $('regPass2'), $('regHS')].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(); }));
}

function wireUnlockScreen() {
  $('unlockBtn').addEventListener('click', handleUnlock);
  $('useDifferentAccountBtn').addEventListener('click', showAuthScreen);
  $('unlockPass').addEventListener('keydown', e => { if (e.key === 'Enter') handleUnlock(); });
}

function setAuthError(msg) {
  const el = $('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('authInfo').classList.add('hidden');
}
function setAuthInfo(msg) {
  const el = $('authInfo');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('authError').classList.add('hidden');
}
function clearAuthMsg() {
  $('authError').classList.add('hidden');
  $('authInfo').classList.add('hidden');
}

async function handleLogin() {
  clearAuthMsg();
  const rawUser = $('inUser').value.trim();
  const pass = $('inPass').value;
  let hs = $('inHS').value.trim() || 'matrix.org';

  if (!rawUser || !pass) { setAuthError('Username and password are required.'); return; }
  if (rawUser.includes(':')) hs = rawUser.split(':').slice(1).join(':');
  if (!hs.startsWith('http')) hs = 'https://' + hs;

  const btn = $('loginBtn');
  btn.disabled = true; btn.textContent = 'signing in…';
  log('Logging in…');
  try {
    const { userId } = await login(hs, rawUser, pass);
    await afterAuth(userId);
  } catch (e) {
    setAuthError(e.message || 'Login failed');
    log('Login failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'sign in';
  }
}

async function handleRegister() {
  clearAuthMsg();
  const rawUser = $('regUser').value.trim();
  const pass = $('regPass').value;
  const pass2 = $('regPass2').value;
  let hs = $('regHS').value.trim() || 'matrix.org';

  if (!rawUser || !pass) { setAuthError('Username and password are required.'); return; }
  if (pass.length < 8) { setAuthError('Password must be at least 8 characters.'); return; }
  if (pass !== pass2) { setAuthError('Passwords do not match.'); return; }
  if (rawUser.includes(':')) hs = rawUser.split(':').slice(1).join(':');
  if (!hs.startsWith('http')) hs = 'https://' + hs;

  const btn = $('registerBtn');
  btn.disabled = true; btn.textContent = 'creating…';
  setAuthInfo('Creating account…');
  log('Registering…');
  try {
    const { userId } = await register(hs, rawUser, pass);
    await afterAuth(userId);
  } catch (e) {
    setAuthError(e.message || 'Registration failed');
    log('Register failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'create account';
  }
}

async function handleUnlock() {
  const pass = $('unlockPass').value;
  const userId = $('unlockUser').textContent.trim();
  if (!pass || !userId) return;
  $('unlockError').classList.add('hidden');
  const btn = $('unlockBtn');
  btn.disabled = true; btn.textContent = 'unlocking…';
  log('Unlocking…');
  try {
    const { online } = await unlock(userId, pass);
    log(online ? 'Unlocked (online)' : 'Unlocked (offline mode)', 'ok');
    await afterAuth(userId);
  } catch (e) {
    const el = $('unlockError');
    el.textContent = e.message || 'Unlock failed';
    el.classList.remove('hidden');
    log('Unlock failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'unlock';
  }
}

async function afterAuth(userId) {
  showAppShell(userId);
  log('Connected as ' + userId, 'ok');
  updateLockBadge();
  updateNetworkBadge(getNetworkState());

  if (outboxFlusher) outboxFlusher.stop();
  outboxFlusher = new OutboxFlusher({
    getClient,
    onAck: ({ localId, eventId }) => {
      sentEventToLocalId.set(eventId, localId);
    },
    onProgress: (e) => {
      if (e.type === 'hoisted') log(`Sync: hoisted ${e.count} field(s) to media`, 'ok');
      else if (e.type === 'sent') log(`Sync: event sent (${e.eventId.slice(0, 12)}…)`, 'ok');
      else if (e.type === 'retry') log(`Sync: retry #${e.attempts}${e.tooLarge ? ' (too large)' : ''} — ${e.error}`, 'err');
      else if (e.type === 'dead') {
        log(`Sync: gave up — ${e.error}`, 'err');
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
  currentRoomName = null;
  currentStore = null;
  committedState = initial();
  displayState = initial();
  currentEvents = [];
  const lastUser = getLastUser();
  if (lastUser) showUnlockScreen(lastUser);
  else showAuthScreen();
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
  currentRoomName = null;
  currentStore = null;
  committedState = initial();
  displayState = initial();
  currentEvents = [];
  showAuthScreen();
  log('Logged out');
}

// ── App shell wiring ──
function wireAppShell() {
  $('logoutBtn').addEventListener('click', handleLogout);
  $('lockBtn').addEventListener('click', handleLock);
  $('createRoomBtn').addEventListener('click', handleCreateRoom);
  $('inviteBtn').addEventListener('click', handleInvite);
  $('syncNowBtn').addEventListener('click', () => outboxFlusher && outboxFlusher.kick());
  $('clearOutboxBtn').addEventListener('click', handleClearDeadOutbox);

  $('newRoomName').addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateRoom(); });
  $('newRoomType').addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateRoom(); });

  document.querySelectorAll('.modes button').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('currentRoomBtn').addEventListener('click', openRoomPicker);

  // Sidebar toggle (mobile)
  $('sidebarToggle').addEventListener('click', () => {
    $('sidebar').classList.toggle('show');
  });

  // Modal close handlers
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.closeModal;
      $(id).classList.add('hidden');
    });
  });
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', (e) => { if (e.target === bd) bd.classList.add('hidden'); });
  });
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.modes button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  ['viewLog', 'viewState', 'viewTables'].forEach(id =>
    $(id).classList.toggle('active', id === 'view' + view[0].toUpperCase() + view.slice(1)));
  renderCurrentView();
}

function renderCurrentView() {
  if (currentView === 'log') renderLogView();
  else if (currentView === 'state') renderStateView();
  else if (currentView === 'tables') renderTablesView();
}

// ── Status badges ──
function updateNetworkBadge(state) {
  const el = $('netBadge'); if (!el) return;
  el.className = 'badge ' + state;
  el.textContent = state === 'online' ? '● online'
    : state === 'degraded' ? '● degraded' : '● offline';
}
function updateLockBadge() {
  const el = $('lockBadge'); if (!el) return;
  const unlocked = vault.isUnlocked();
  el.className = 'badge ' + (unlocked ? 'unlocked' : 'locked');
  el.textContent = unlocked ? '🔓 unlocked' : '🔒 locked';
}
async function refreshOutboxBadge() {
  const el = $('outboxBadge'); if (!el) return;
  try {
    const n = await pendingCount();
    el.textContent = n > 0 ? `↻ ${n} queued` : '✓ in sync';
    el.className = 'badge ' + (n > 0 ? 'queued' : 'idle');
    scheduleRender();
  } catch {
    el.textContent = '? outbox';
    el.className = 'badge';
  }
}

async function handleClearDeadOutbox() {
  const all = await outboxListAll();
  const dead = all.filter(r => r.status === 'dead');
  if (dead.length === 0) { log('No failed entries to clear'); return; }
  for (const r of dead) await outboxRemove(r.localId);
  log(`Cleared ${dead.length} failed entries`, 'ok');
}

// ── Rooms ──
async function refreshRooms() {
  const rooms = discoverRooms();
  const list = $('roomList');
  list.innerHTML = '';
  $('roomsCount').textContent = rooms.length;

  if (rooms.length === 0) {
    list.innerHTML = '<div class="sb-empty">no rooms yet</div>';
    return;
  }

  rooms.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'room' + (r.roomId === currentRoomId ? ' active' : '') + (r.membership === 'invite' ? ' invite' : '');
    if (r.membership === 'invite') {
      const from = r.inviter ? `from ${r.inviter}` : '';
      el.innerHTML = `
        <div class="rname">${escapeHtml(r.name)}</div>
        <div class="rmeta"><span class="pill" style="color:var(--signal);border-color:var(--signal)">invite</span><span>${escapeHtml(from)}</span></div>
        <div class="rmeta">click to accept</div>`;
      el.addEventListener('click', () => handleAcceptInvite(r.roomId, r.name));
    } else {
      el.innerHTML = `
        <div class="rname">${escapeHtml(r.name)}</div>
        <div class="rmeta"><span class="pill">${escapeHtml(r.roomType || 'general')}</span></div>`;
      el.addEventListener('click', () => openRoom(r.roomId, r.name));
    }
    list.appendChild(el);
  });
}

function openRoomPicker() {
  const rooms = discoverRooms();
  const body = $('roomPickerBody');
  body.innerHTML = '';
  if (rooms.length === 0) {
    body.innerHTML = '<p>no rooms yet — create one from the sidebar.</p>';
  } else {
    rooms.forEach(r => {
      const row = document.createElement('div');
      row.className = 'room' + (r.roomId === currentRoomId ? ' active' : '');
      row.style.borderBottom = '1px solid var(--border)';
      const inv = r.membership === 'invite';
      row.innerHTML = `<div class="rname">${escapeHtml(r.name)}</div><div class="rmeta">${inv ? '<span class="pill" style="color:var(--signal);border-color:var(--signal)">invite</span>' : `<span class="pill">${escapeHtml(r.roomType || 'general')}</span>`}</div>`;
      row.addEventListener('click', () => {
        $('roomPickerModal').classList.add('hidden');
        if (inv) handleAcceptInvite(r.roomId, r.name);
        else openRoom(r.roomId, r.name);
      });
      body.appendChild(row);
    });
  }
  $('roomPickerModal').classList.remove('hidden');
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
    log('Created: ' + name, 'ok');
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
  if (currentStore && currentStore.hasData()) {
    try { await currentStore.saveCheckpoint(committedState); } catch {}
  }
  if (unsubTimeline) { unsubTimeline(); unsubTimeline = null; }
  if (unsubDecrypted) { unsubDecrypted(); unsubDecrypted = null; }
  if (unsubLocalEcho) { unsubLocalEcho(); unsubLocalEcho = null; }

  currentRoomId = roomId;
  currentRoomName = name;
  committedState = initial();
  displayState = initial();
  currentEvents = [];
  currentTableType = null;

  $('currentRoomName').textContent = name;
  $('currentRoomDot').classList.remove('off');
  $('logCrumb').textContent = `room · ${name}`;
  $('stateCrumb').textContent = `room · ${name}`;
  $('tablesCrumb').textContent = `room · ${name}`;
  refreshRooms();

  currentStore = new EventStore(roomId, getNamespace());
  await currentStore.open();

  const storedCount = currentStore.getCount();
  const cursor = currentStore.getCursor();

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
        log(`Restored checkpoint (${checkpoint.count} events)`, 'ok');
      }
    } else {
      log(`Full replay of ${storedCount} events from OPFS…`);
      const allEvents = await currentStore.getAll();
      committedState = fold(allEvents);
      log('Fold complete', 'ok');
      await currentStore.saveCheckpoint(committedState);
    }
  }

  scheduleRender();

  const client = getClient();
  if (!client) {
    log('Offline — using local data only', 'ok');
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
      const filtered = freshNew.filter(e => !isOwnLocalEcho(e));
      const added = await currentStore.append(filtered);
      for (const e of freshNew) reconcilePendingByTxn(e);
      if (added.length > 0) {
        committedState = foldFrom(committedState, added);
        log(`${added.length} new events synced + folded`, 'ok');
      }
      scheduleRender();
    } else if (storedCount === 0) {
      log('Room is empty', 'ok');
    } else {
      log(`${storedCount} events, all up to date`, 'ok');
    }
  } catch (e) {
    log('Sync failed (continuing offline): ' + e.message, 'err');
  }

  unsubTimeline = onTimeline(roomId, async (event) => {
    if (!currentStore) return;
    if (isOwnLocalEcho(event)) return;
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

  unsubLocalEcho = onLocalEchoUpdated(roomId, async (event) => {
    if (!currentStore) return;
    const status = event.status;
    if (status === EventStatus.SENT) {
      const added = await currentStore.append([event]);
      if (added.length > 0) committedState = foldFrom(committedState, added);
      reconcilePendingByTxn(event);
      scheduleRender();
    } else if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) {
      scheduleRender();
    }
  });
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
    scheduleRender();
  }
}

function deriveDisplayState() {
  const pending = [];
  for (const { roomId, event } of pendingByLocalId.values()) {
    if (roomId === currentRoomId) pending.push(event);
  }
  if (pending.length === 0) {
    displayState = committedState;
    return;
  }
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
  for (const p of pending) {
    if (p.content && p.content.anchor && displayState.entities[p.content.anchor]) {
      displayState.entities[p.content.anchor]._pending = true;
    }
  }
}

// ── Build a unified event list (committed + pending) for the log view ──
function rebuildEventList() {
  const ns = getNamespace();
  const committed = [];
  if (currentStore) {
    // Use the timeline events the SDK has; the store has the encrypted blob
    // and we already folded them. For display we walk the SDK timeline.
    const client = getClient();
    if (client && currentRoomId) {
      const events = getTimeline(currentRoomId) || [];
      for (const e of events) {
        const type = typeof e.getType === 'function' ? e.getType() : e.type;
        if (!type || !type.startsWith(ns + '.')) continue;
        if (isOwnLocalEcho(e)) continue;
        committed.push({
          type,
          op: type.slice(ns.length + 1),
          content: typeof e.getContent === 'function' ? e.getContent() : e.content,
          sender: typeof e.getSender === 'function' ? e.getSender() : e.sender,
          ts: typeof e.getTs === 'function' ? e.getTs() : e.origin_server_ts,
          eventId: typeof e.getId === 'function' ? e.getId() : e.event_id,
          pending: false,
        });
      }
    }
  }
  const pending = [];
  for (const { roomId, event } of pendingByLocalId.values()) {
    if (roomId !== currentRoomId) continue;
    const type = event.type;
    if (!type || !type.startsWith(ns + '.')) continue;
    pending.push({
      type,
      op: type.slice(ns.length + 1),
      content: event.content,
      sender: event.sender,
      ts: event.origin_server_ts || Date.now(),
      eventId: event.event_id,
      pending: true,
    });
  }
  currentEvents = [...committed, ...pending].sort((a, b) => a.ts - b.ts);
}

// ── Ops palette ──
const OP_LIST = [
  { key: 'nul', glyph: '∅', triad: 'existence',    label: 'NUL', stored: false, hint: 'absence · null signal' },
  { key: 'sig', glyph: '○', triad: 'existence',    label: 'SIG', stored: false, hint: 'transient ping · not recorded' },
  { key: 'ins', glyph: '●', triad: 'existence',    label: 'INS', stored: true,  hint: 'create entity' },
  { key: 'seg', glyph: '｜', triad: 'structure',    label: 'SEG', stored: true,  hint: 'partition · move entity into a bucket' },
  { key: 'con', glyph: '⋈', triad: 'structure',    label: 'CON', stored: true,  hint: 'connect · link two entities' },
  { key: 'syn', glyph: '△', triad: 'structure',    label: 'SYN', stored: true,  hint: 'synthesize · merge entities' },
  { key: 'def', glyph: '⊢', triad: 'significance', label: 'DEF', stored: true,  hint: 'define · set a value on an entity' },
  { key: 'eva', glyph: '⊨', triad: 'significance', label: 'EVA', stored: true,  hint: 'evaluate against a criterion' },
  { key: 'rec', glyph: '⊛', triad: 'significance', label: 'REC', stored: true,  hint: 'recontextualize the frame' },
];

function wireOpsPalette() {
  const grid = $('opsGrid');
  grid.innerHTML = '';
  for (const op of OP_LIST) {
    const btn = document.createElement('button');
    btn.className = 'op-btn ' + op.triad + (op.stored ? '' : ' ephemeral');
    btn.dataset.op = op.key;
    btn.innerHTML = `<span class="gly">${op.glyph}</span><span class="key">${op.label}</span>`;
    btn.title = op.hint;
    btn.addEventListener('click', () => openOpForm(op));
    grid.appendChild(btn);
  }
}

function openOpForm(op) {
  if (!currentRoomId) {
    $('opsHint').textContent = 'select a room first';
    setTimeout(() => { $('opsHint').textContent = 'select an op · or click ∅/○ to flash an ephemeral signal'; }, 2000);
    return;
  }

  // Ephemeral ops just flash and exit.
  if (!op.stored) {
    flashEphemeral(op);
    return;
  }

  // Highlight active.
  document.querySelectorAll('.op-btn').forEach(b => b.classList.toggle('active', b.dataset.op === op.key));

  const form = $('opForm');
  form.classList.remove('hidden');

  const anchors = Object.keys(displayState.entities);
  const anchorOptions = anchors.map(a => {
    const ent = displayState.entities[a];
    const t = ent._type || 'item';
    const title = ent.title || ent.name || '';
    const label = title ? `${a} — ${title}` : a;
    return `<option value="${escapeAttr(a)}">${escapeHtml(label)}</option>`;
  }).join('');

  let formHtml = `<div class="head"><span class="gly" style="color:var(--triad-${op.triad})">${op.glyph}</span> <b>${op.label}</b> — ${op.hint}</div>`;

  if (op.key === 'ins') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>Entity type</label><input data-op-input="type" placeholder="task" value="task"></div>
        <div class="field"><label>Title</label><input data-op-input="title" placeholder="Port operators.js to Rust"></div>
      </div>`;
  } else if (op.key === 'def') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>Anchor</label>${anchors.length ? `<select data-op-input="anchor">${anchorOptions}</select>` : '<input data-op-input="anchor" placeholder="no entities — INS one first" disabled>'}</div>
        <div class="field"><label>Path</label><input data-op-input="path" placeholder="status" value="status"></div>
        <div class="field"><label>Value</label><input data-op-input="value" placeholder="done"></div>
      </div>`;
  } else if (op.key === 'seg') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>Anchor</label>${anchors.length ? `<select data-op-input="anchor">${anchorOptions}</select>` : '<input data-op-input="anchor" disabled placeholder="no entities">'}</div>
        <div class="field"><label>Partition</label><input data-op-input="partition" placeholder="backlog"></div>
      </div>`;
  } else if (op.key === 'con') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>From</label>${anchors.length ? `<select data-op-input="source">${anchorOptions}</select>` : '<input data-op-input="source" disabled>'}</div>
        <div class="field"><label>To</label>${anchors.length ? `<select data-op-input="target">${anchorOptions}</select>` : '<input data-op-input="target" disabled>'}</div>
        <div class="field"><label>Relation</label><input data-op-input="relation" placeholder="depends_on"></div>
      </div>`;
  } else if (op.key === 'syn') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>Inputs (comma)</label><input data-op-input="inputs" placeholder="task_aaa,task_bbb"></div>
        <div class="field"><label>Output type</label><input data-op-input="outputType" placeholder="synthesis"></div>
        <div class="field"><label>Output title</label><input data-op-input="outputTitle" placeholder="merged result"></div>
      </div>`;
  } else if (op.key === 'eva') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>Anchor</label>${anchors.length ? `<select data-op-input="anchor">${anchorOptions}</select>` : '<input data-op-input="anchor" disabled>'}</div>
        <div class="field"><label>Criterion</label><input data-op-input="criterion" placeholder="quality"></div>
        <div class="field"><label>Result</label>
          <select data-op-input="result">
            <option value="pass">pass</option>
            <option value="fail">fail</option>
            <option value="defer">defer</option>
          </select>
        </div>
        <div class="field"><label>Note</label><input data-op-input="note"></div>
      </div>`;
  } else if (op.key === 'rec') {
    formHtml += `
      <div class="grid">
        <div class="field"><label>Scope</label><input data-op-input="scope" placeholder="proj_alpha"></div>
        <div class="field"><label>Before frame</label><input data-op-input="before" placeholder="exploration"></div>
        <div class="field"><label>After frame</label><input data-op-input="after" placeholder="commitment"></div>
      </div>`;
  }

  formHtml += `
    <div class="err hidden" id="opFormErr"></div>
    <div class="actions">
      <span class="hint">runs through outbox · safe offline</span>
      <button class="ghost" data-op-cancel>cancel</button>
      <button data-op-submit>emit ${op.label}</button>
    </div>`;
  form.innerHTML = formHtml;

  form.querySelector('[data-op-cancel]').addEventListener('click', () => closeOpForm());
  form.querySelector('[data-op-submit]').addEventListener('click', () => submitOp(op));
  // Enter key in any input submits
  form.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitOp(op); });
  });
  const firstInput = form.querySelector('input:not([disabled]), select');
  if (firstInput) firstInput.focus();
}

function closeOpForm() {
  $('opForm').classList.add('hidden');
  $('opForm').innerHTML = '';
  document.querySelectorAll('.op-btn').forEach(b => b.classList.remove('active'));
}

function readOp(key) {
  const el = document.querySelector(`#opForm [data-op-input="${key}"]`);
  return el ? el.value.trim() : '';
}

function opError(msg) {
  const el = $('opFormErr');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

async function submitOp(op) {
  if (!currentRoomId) return;
  try {
    if (op.key === 'ins') {
      const type = readOp('type') || 'item';
      const title = readOp('title') || 'Untitled';
      const anchor = await ins(currentRoomId, type, { title });
      log(`INS → ${anchor.slice(0, 18)}… (queued)`, 'ok');
    } else if (op.key === 'def') {
      const anchor = readOp('anchor');
      const path = readOp('path');
      const value = readOp('value');
      if (!anchor) return opError('Anchor required (INS an entity first).');
      if (!path) return opError('Path required.');
      if (!displayState.entities[anchor]) return opError('Anchor does not exist.');
      const coerced = coerceValue(value);
      await def(currentRoomId, anchor, path, coerced);
      log(`DEF → ${anchor.slice(0, 14)}…${path} = ${JSON.stringify(coerced)} (queued)`, 'ok');
    } else if (op.key === 'seg') {
      const anchor = readOp('anchor');
      const partition = readOp('partition');
      if (!anchor || !partition) return opError('Anchor and partition required.');
      await seg(currentRoomId, anchor, partition);
      log(`SEG → ${anchor.slice(0, 14)}… → ${partition} (queued)`, 'ok');
    } else if (op.key === 'con') {
      const source = readOp('source');
      const target = readOp('target');
      const relation = readOp('relation');
      if (!source || !target || !relation) return opError('All fields required.');
      if (source === target) return opError('Source and target must differ.');
      await con(currentRoomId, source, target, relation);
      log(`CON → ${source.slice(0, 10)}…→${target.slice(0, 10)}… (${relation})`, 'ok');
    } else if (op.key === 'syn') {
      const inputs = readOp('inputs').split(',').map(s => s.trim()).filter(Boolean);
      const outputType = readOp('outputType') || 'synthesis';
      const outputTitle = readOp('outputTitle') || 'merged';
      if (inputs.length < 2) return opError('Need at least two input anchors (comma-separated).');
      await syn(currentRoomId, inputs, { type: outputType, title: outputTitle });
      log(`SYN → merged ${inputs.length} entities (queued)`, 'ok');
    } else if (op.key === 'eva') {
      const anchor = readOp('anchor');
      const criterion = readOp('criterion');
      const result = readOp('result') || 'pass';
      const note = readOp('note');
      if (!anchor || !criterion) return opError('Anchor and criterion required.');
      await eva(currentRoomId, anchor, criterion, result, note);
      log(`EVA → ${anchor.slice(0, 14)}…[${criterion}]=${result}`, 'ok');
    } else if (op.key === 'rec') {
      const scope = readOp('scope');
      const before = readOp('before');
      const after = readOp('after');
      if (!scope || !after) return opError('Scope and after-frame required.');
      await rec(currentRoomId, scope, before, after);
      log(`REC → ${scope} (${before} → ${after})`, 'ok');
    }
    closeOpForm();
  } catch (e) {
    opError(e.message || 'failed');
    log(`${op.label} failed: ${e.message}`, 'err');
  }
}

function coerceValue(s) {
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch {}
  }
  return s;
}

function flashEphemeral(op) {
  const lane = $('ephLane');
  const flashes = $('ephFlashes');
  lane.classList.remove('empty');
  const el = document.createElement('span');
  el.className = 'eph-flash';
  el.innerHTML = `<span class="gly" style="color:var(--triad-${op.triad})">${op.glyph}</span><span class="eph-key">${op.label}</span><span>${new Date().toLocaleTimeString()}</span>`;
  flashes.appendChild(el);
  setTimeout(() => {
    el.remove();
    if (!flashes.children.length) lane.classList.add('empty');
  }, 4600);
  log(`${op.label} (ephemeral · not stored)`, 'ok');
}

function refreshMembers() {
  if (!currentRoomId) return '—';
  const members = getMembers(currentRoomId);
  return members.map(m => m.displayName).join(', ') || 'just you';
}

async function handleInvite() {
  if (!currentRoomId) {
    log('Select a room before inviting', 'err');
    return;
  }
  const userId = prompt('User ID to invite:', '@user:matrix.org');
  if (!userId || !userId.includes(':')) return;
  log('Inviting ' + userId + '…');
  try {
    await invite(currentRoomId, userId);
    log('Invited ' + userId, 'ok');
  } catch (e) {
    log('Invite failed: ' + e.message, 'err');
  }
}

// ── Renders ──

function renderLogView() {
  const body = $('logBody');
  if (!currentRoomId) {
    body.innerHTML = '<div class="log-empty"><span class="glyph">∅</span>select or create a room to begin.</div>';
    return;
  }
  if (currentEvents.length === 0) {
    body.innerHTML = '<div class="log-empty"><span class="glyph">○</span>no operators yet — emit one from the palette below.</div>';
    return;
  }
  const html = currentEvents.map((e, idx) => renderEventRow(e, idx)).join('');
  body.innerHTML = html;
}

function renderEventRow(e, idx) {
  const op = OP_LIST.find(o => o.key === e.op);
  const triad = op ? op.triad : 'existence';
  const glyph = op ? op.glyph : '?';
  const label = op ? op.label : e.op.toUpperCase();
  const idxStr = '#' + String(idx).padStart(3, '0');
  const sender = e.sender ? `<div class="tl-sender">@${escapeHtml(e.sender.replace(/^@/, '').split(':')[0])} · ${formatTime(e.ts)}</div>` : '';
  const pendBadge = e.pending ? ' <span class="tl-pending">pending</span>' : '';
  const cls = 'tl-row' + (e.pending ? ' pending' : '');
  return `
    <div class="${cls}">
      <div class="tl-idx">${idxStr}</div>
      <div class="tl-glyph ${triad}">${glyph}</div>
      <div class="tl-key">${label}${pendBadge}</div>
      <div class="tl-body">
        <div class="tl-line">${renderEventBody(e)}</div>
        ${sender}
      </div>
    </div>`;
}

function renderEventBody(e) {
  const c = e.content || {};
  if (e.op === 'ins') {
    const title = c.payload && (c.payload.title || c.payload.name) || '';
    return `<span class="tl-anchor">${escapeHtml(c.anchor || '?')}</span> · <span class="tl-rel">${escapeHtml(c.entity_type || 'item')}</span>${title ? ' · ' + escapeHtml(title) : ''}`;
  }
  if (e.op === 'def') {
    return `<span class="tl-anchor">${escapeHtml(c.anchor || 'schema')}</span><span class="tl-path">.${escapeHtml(c.path || '')}</span> = <span class="tl-val">${escapeHtml(JSON.stringify(c.value))}</span>`;
  }
  if (e.op === 'seg') return `<span class="tl-anchor">${escapeHtml(c.anchor || '?')}</span> → <span class="tl-rel">${escapeHtml(c.partition || '?')}</span>`;
  if (e.op === 'con') return `<span class="tl-anchor">${escapeHtml(c.source_anchor || '?')}</span> <span class="tl-rel">${escapeHtml(c.relation_type || '~')}</span>→ <span class="tl-anchor">${escapeHtml(c.target_anchor || '?')}</span>`;
  if (e.op === 'syn') return `<span class="tl-rel">${(c.input_anchors || []).length} inputs</span> △ <span class="tl-anchor">${escapeHtml((c.output && c.output.title) || 'merged')}</span>`;
  if (e.op === 'eva') return `<span class="tl-anchor">${escapeHtml(c.anchor || '?')}</span>[<span class="tl-rel">${escapeHtml(c.criterion || '')}</span>] = <span class="tl-val">${escapeHtml(c.result || '?')}</span>`;
  if (e.op === 'rec') return `<span class="tl-rel">${escapeHtml(c.scope || '')}</span>: <span class="tl-anchor">${escapeHtml(c.before_frame || '∅')}</span> → <span class="tl-val">${escapeHtml(c.after_frame || '?')}</span>`;
  return escapeHtml(JSON.stringify(c));
}

function renderStateView() {
  const body = $('stateBody');
  if (!currentRoomId) {
    body.innerHTML = '<div class="log-empty"><span class="glyph">∅</span>select a room to see its projected state.</div>';
    return;
  }
  const s = displayState;
  const entities = s.entities || {};
  const partitions = s.partitions || {};
  const connections = s.connections || [];
  const violations = s._violations || [];
  const schema = s.schema || {};
  const frames = s.frames || [];

  const entityKeys = Object.keys(entities);
  let html = '';

  // Storage banner
  const stat = currentStore ? `${currentStore.getCount()} events · ${(currentStore.getByteSize()/1024).toFixed(1)} KB encrypted` : '';
  const pendingCount = countPendingForRoom();
  html += `<div class="state-section bar-w">
    <h3>storage <span class="count">${escapeHtml(stat)}</span></h3>
    <div class="schema-row"><span class="k">members</span> <span class="v">${escapeHtml(refreshMembers())}</span></div>
    ${pendingCount > 0 ? `<div class="schema-row" style="color:var(--signal)">↻ ${pendingCount} pending local change(s) — will sync when online</div>` : ''}
    ${s._undecryptable > 0 ? `<div class="schema-row" style="color:var(--red)">⚠ ${s._undecryptable} event(s) still encrypted (waiting for keys)</div>` : ''}
  </div>`;

  // Schema
  if (Object.keys(schema).length > 0) {
    const rows = Object.entries(schema).map(([k, v]) =>
      `<div class="schema-row"><span class="k">${escapeHtml(k)}</span> = <span class="v">${escapeHtml(JSON.stringify(v))}</span></div>`
    ).join('');
    html += `<div class="state-section bar-g"><h3>schema <span class="count">${Object.keys(schema).length}</span></h3>${rows}</div>`;
  }

  // Entities
  if (entityKeys.length > 0) {
    const cards = entityKeys.map(a => renderEntityCard(a, entities[a])).join('');
    html += `<div class="state-section bar-e"><h3>entities <span class="count">${entityKeys.length}</span></h3>${cards}</div>`;
  } else {
    html += `<div class="state-section bar-e"><h3>entities <span class="count">0</span></h3><div class="schema-row" style="color:var(--text-dim);font-style:italic">no entities yet · emit INS</div></div>`;
  }

  // Partitions
  const partKeys = Object.keys(partitions);
  if (partKeys.length > 0) {
    const rows = partKeys.map(p => {
      const items = partitions[p] || [];
      return `<div class="schema-row"><span class="k">${escapeHtml(p)}</span> <span class="v">${items.length} items</span></div>`;
    }).join('');
    html += `<div class="state-section bar-s"><h3>partitions <span class="count">${partKeys.length}</span></h3>${rows}</div>`;
  }

  // Connections
  if (connections.length > 0) {
    const rows = connections.slice(-20).map(c =>
      `<div class="conn">${escapeHtml(shortAnchor(c.source_anchor || c.source || ''))}<span class="arrow">${escapeHtml(c.relation_type || c.relation || '→')}</span>${escapeHtml(shortAnchor(c.target_anchor || c.target || ''))}</div>`
    ).join('');
    html += `<div class="state-section bar-s"><h3>connections <span class="count">${connections.length}</span></h3>${rows}</div>`;
  }

  // Frames
  if (frames.length > 0) {
    const rows = frames.slice(-10).map(f => `<div class="conn">${escapeHtml(f.scope || '')} <span class="arrow">→</span> <span class="tl-val">${escapeHtml(f.after_frame || '?')}</span></div>`).join('');
    html += `<div class="state-section bar-g"><h3>frames <span class="count">${frames.length}</span></h3>${rows}</div>`;
  }

  // Violations
  if (violations.length > 0) {
    const rows = violations.slice(-10).map(v => {
      let msg = '';
      if (v.type === 'criterionless_judgment') msg = `EVA on ${shortAnchor(v.anchor)} — no prior DEF (hwm=${v.hwm})`;
      else if (v.type === 'cartesian_product') msg = `CON ${shortAnchor(v.source)}→${shortAnchor(v.target)} — ${v.missing} missing`;
      else if (v.type === 'blind_restructuring') msg = `REC without prior EVA`;
      else if (v.type === 'missing_ins') msg = `${v.op} on ${shortAnchor(v.anchor)} — not yet INS'd`;
      else msg = JSON.stringify(v);
      return `<div class="viol"><span class="v-type">${escapeHtml(v.type)}</span>${escapeHtml(msg)}</div>`;
    }).join('');
    html += `<div class="state-section bar-g"><h3>violations <span class="count">${violations.length}</span></h3>${rows}</div>`;
  }

  body.innerHTML = html;

  // Wire entity card clicks → modal
  body.querySelectorAll('.entity[data-anchor]').forEach(el => {
    el.addEventListener('click', () => openEntityModal(el.dataset.anchor));
  });
}

function renderEntityCard(anchor, ent) {
  const partition = findPartition(anchor);
  const hwm = ent._hwm || 0;
  const type = ent._type || 'item';
  const pending = ent._pending;
  const cls = 'entity' + (pending ? ' pending' : '') + (partition ? ' partitioned' : '');
  const rows = Object.entries(ent)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `<div class="e-row"><span class="e-key">${escapeHtml(k)}</span><span class="e-val">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span></div>`)
    .join('');
  const meta = [
    `type=${escapeHtml(type)}`,
    partition ? `partition=${escapeHtml(partition)}` : null,
    `hwm=${hwm}`,
    pending ? '<span class="tl-pending">pending</span>' : null,
  ].filter(Boolean).join(' · ');
  return `<div class="${cls}" data-anchor="${escapeAttr(anchor)}">
    <div class="e-head">
      <div class="e-anchor">${escapeHtml(anchor)}</div>
      <div class="e-hwm">hwm ${hwm}</div>
    </div>
    ${rows || '<div class="e-row"><span class="e-val" style="color:var(--text-dim);font-style:italic">no DEF yet</span></div>'}
    <div class="e-meta">${meta}</div>
  </div>`;
}

function findPartition(anchor) {
  const parts = displayState.partitions || {};
  for (const [name, items] of Object.entries(parts)) {
    if (Array.isArray(items) && items.includes(anchor)) return name;
  }
  return null;
}

function renderTablesView() {
  const tabs = $('tvTabs');
  const body = $('tvBody');
  if (!currentRoomId) {
    tabs.innerHTML = '';
    body.innerHTML = '<div class="tv-empty"><span class="glyph">∅</span>select a room to see its tables.</div>';
    return;
  }
  const entities = displayState.entities || {};
  const byType = new Map();
  for (const [anchor, ent] of Object.entries(entities)) {
    const t = ent._type || 'item';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push({ anchor, ...ent });
  }
  if (byType.size === 0) {
    tabs.innerHTML = '';
    body.innerHTML = '<div class="tv-empty"><span class="glyph">●</span>no entities yet — emit <b>INS</b> to create one.</div>';
    return;
  }
  if (!currentTableType || !byType.has(currentTableType)) {
    currentTableType = byType.keys().next().value;
  }
  // Tabs
  tabs.innerHTML = [...byType.entries()].map(([t, rows]) => {
    const cls = 'tv-tab' + (t === currentTableType ? ' active' : '');
    return `<button class="${cls}" data-type="${escapeAttr(t)}"><span class="tname">${escapeHtml(t)}</span><span class="trows">${rows.length}</span></button>`;
  }).join('');
  tabs.querySelectorAll('.tv-tab').forEach(btn => {
    btn.addEventListener('click', () => { currentTableType = btn.dataset.type; renderTablesView(); });
  });
  // Table
  const rows = byType.get(currentTableType);
  const columns = new Set(['_anchor', '_partition']);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (k.startsWith('_') || k === 'anchor') continue;
      columns.add(k);
    }
  }
  const colArr = [...columns];
  const head = colArr.map(c => {
    const cls = c === '_anchor' ? ' class="pk"' : '';
    return `<th${cls}>${escapeHtml(c)}</th>`;
  }).join('');
  const trs = rows.map(r => {
    const cells = colArr.map(c => {
      if (c === '_anchor') return `<td class="anchor">${escapeHtml(r.anchor)}</td>`;
      if (c === '_partition') {
        const p = findPartition(r.anchor);
        return p ? `<td>${escapeHtml(p)}</td>` : '<td class="null">NULL</td>';
      }
      const v = r[c];
      if (v === undefined || v === null) return '<td class="null">NULL</td>';
      if (typeof v === 'number') return `<td class="num">${v}</td>`;
      if (typeof v === 'object') return `<td class="json">${escapeHtml(JSON.stringify(v))}</td>`;
      return `<td>${escapeHtml(String(v))}</td>`;
    }).join('');
    return `<tr class="${r._pending ? 'pending' : ''}">${cells}</tr>`;
  }).join('');
  body.innerHTML = `
    <div class="dbtable">
      <div class="dbtable-head">
        <div class="name">${escapeHtml(currentTableType)}</div>
        <div class="meta">${rows.length} rows · ${colArr.length - 2} fields</div>
      </div>
      <div class="dbtable-scroll">
        <table class="dbgrid">
          <thead><tr>${head}</tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    </div>`;
}

function openEntityModal(anchor) {
  const ent = displayState.entities[anchor];
  if (!ent) return;
  $('entityModalAnchor').textContent = anchor;
  const ns = getNamespace();
  // Find events touching this anchor.
  const touching = currentEvents.filter(e => {
    const c = e.content || {};
    return c.anchor === anchor || c.source_anchor === anchor || c.target_anchor === anchor
      || (c.input_anchors && c.input_anchors.includes(anchor));
  });
  const fieldRows = Object.entries(ent)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `<div class="e-row"><span class="e-key">${escapeHtml(k)}</span><span class="e-val">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span></div>`)
    .join('');
  const partition = findPartition(anchor);
  const meta = [
    `type=<b>${escapeHtml(ent._type || 'item')}</b>`,
    `hwm=<b>${ent._hwm || 0}</b>`,
    partition ? `partition=<b>${escapeHtml(partition)}</b>` : null,
  ].filter(Boolean).join(' · ');

  const events = touching.map((e, idx) => {
    const op = OP_LIST.find(o => o.key === e.op);
    const triad = op ? op.triad : 'existence';
    return `
      <div class="tl-row" style="grid-template-columns:24px 50px 1fr">
        <div class="tl-glyph ${triad}">${op ? op.glyph : '?'}</div>
        <div class="tl-key">${op ? op.label : e.op.toUpperCase()}</div>
        <div class="tl-body">
          <div class="tl-line">${renderEventBody(e)}</div>
          <div class="tl-sender">${formatTime(e.ts)}${e.pending ? ' · <span class="tl-pending">pending</span>' : ''}</div>
        </div>
      </div>`;
  }).join('') || '<div class="schema-row" style="color:var(--text-dim);font-style:italic">no events touch this anchor in the current window</div>';

  $('entityModalBody').innerHTML = `
    <div style="font-size:11.5px;color:var(--text-dim);margin-bottom:10px">${meta}</div>
    ${fieldRows || '<div class="schema-row" style="color:var(--text-dim);font-style:italic">no DEF yet</div>'}
    <div style="margin-top:14px;font-size:10.5px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-dim);font-weight:700;padding-bottom:6px;border-bottom:1px solid var(--border)">event history · ${touching.length}</div>
    ${events}`;
  $('entityModal').classList.remove('hidden');
}

// ── Scrubber ──
function renderScrubber() {
  const n = currentEvents.length;
  $('foldCount').textContent = n;
  $('scrubFill').style.width = '100%';
  $('scrubCursor').style.left = '100%';
  if (n > 0) {
    $('foldTs').textContent = formatTime(currentEvents[n - 1].ts);
  } else {
    $('foldTs').textContent = '—';
  }
}

// ── Activity log ──
const recentLog = [];
function log(msg, cls = '') {
  const t = new Date().toLocaleTimeString();
  recentLog.push({ msg, cls, t });
  if (recentLog.length > 60) recentLog.shift();
  const el = $('logList');
  if (el) {
    el.innerHTML = recentLog.slice().reverse().slice(0, 40).map(l =>
      `<div class="line ${l.cls}"><span class="ts">[${l.t}]</span>${escapeHtml(l.msg)}</div>`).join('');
  }
  console.log('[ev]', msg);
}

// ── Helpers ──
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }
function shortAnchor(a) {
  if (!a) return '';
  return a.length > 22 ? a.slice(0, 18) + '…' : a;
}
function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString();
  return d.toLocaleString();
}
function countPendingForRoom() {
  let n = 0;
  for (const { roomId } of pendingByLocalId.values()) if (roomId === currentRoomId) n++;
  return n;
}
