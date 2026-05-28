# Memory budget — keeping the tab under 500 MB

This app runs entirely in a browser tab, so "memory" means the tab's heap.
A page cannot ask the browser for a hard allocation cap, so the 500 MB
budget is enforced by **bounding the structures that grow** and backing
that with an **adaptive governor** that sheds early when the platform
actually reports heap pressure.

## Where the memory goes

| Source | Growth | Status |
|--------|--------|--------|
| **matrix-js-sdk sync store** — every room in the account + E2EE member/device lists | scales with the *whole account*, not just this app's rooms | **cut** by lazy-load + minimal sync (below) |
| `roomEvents` in `src/main.js` — committed op-events per visited room | one array per room, forever | **bounded** by LRU (below) |
| `EventStore._eventIdSet` — per-event dedup key per open room | one entry per event × open rooms | **bounded** by LRU |
| matrix-js-sdk live timeline — decrypted `MatrixEvent` objects | one per synced/paginated event, kept forever | **released** on room close / heavy seed |
| `progressLog` ring buffer | capped at 60 (12 under pressure) | bounded |
| Media blobs | streamed to OPFS, not retained in JS heap | bounded |
| Demo store | localStorage-backed (~5 MB ceiling) | bounded |
| `@babel/standalone`, React, crypto WASM | one-time load | fixed cost |

### The matrix-js-sdk sync store is the idle elephant

The surprising one: even with **nothing open**, the SDK runs a full Matrix
sync and keeps the user's *entire account* in its in-memory `MemoryStore` —
every joined room's state, and for end-to-end-encrypted rooms the **device
list of every member of every room**. For an account that's in a few large
or public rooms this is easily one to several GB, none of which is this
app's data. The app's own folded workspace state is tiny by comparison (it
really is just a CSV-sized fold); the SDK underneath it is what's heavy.

Mitigations in `src/client.js` (`SYNC_OPTS`), none of which touch what the
UI shows:

* **`lazyLoadMembers: true`** — the biggest lever. The SDK no longer pulls
  or tracks member lists during sync; they load on demand only when a member
  list is opened (`loadRoomMembers` / `MatrixLive.loadMembers`). Sending to
  encrypted rooms still works — the crypto layer loads its targets first.
* **`initialSyncLimit: 1`** — history comes from OPFS, so the SDK never needs
  a per-room timeline. Keep the initial sync burst to the minimum.
* **`disablePresence: true`** — presence is never rendered; skip it.
* **MatrixRTC disabled** (`client.matrixRTC.stop()` right after `startClient`).
  The SDK otherwise spins up an Element-Call membership tracker for *every
  room in the account* and re-scans them on every sync (the `[MatrixRTCSession
  … No membership changes detected]` log spam) — pure overhead for an app with
  no calls.

One room at a time, period: the app is only ever used in a single room, so
`MAX_OPEN_ROOMS = 1` and the governor releases the SDK live timeline for
**every** room (including the active one) continuously. The app renders from
OPFS + the fold, never the SDK timeline, and optimistic sends reconcile on the
*remote* echo (its `transaction_id` arrives via sync), so dropping the timeline
— even mid-bulk-write, where local/remote echoes pile up fastest — is free.

Use `window.MatrixLive.getSdkStats()` to see the breakdown live:
`{ sdkRooms, workspaceRooms, sdkLiveEvents, sdkMembers, sdkStateEvents,
roomsWithMembersLoaded, openRooms, heldEvents }`. The governor also logs this
breakdown when it sheds, so a console screenshot points at the real consumer.

Further levers, deliberately **not** taken here because they carry trade-offs
worth a decision:

* **`IndexedDBStore`** instead of `MemoryStore` would page sync state to disk
  and shrink the resident set, but it writes room metadata (names,
  membership, your room list) to IndexedDB in **plaintext** — at odds with
  this app's vault-encrypted-at-rest design. (Encrypted event bodies stay
  ciphertext either way.)
* **Sliding sync (MSC3575)** would let the client request *only* this app's
  workspace rooms instead of syncing the whole account — the real fix for
  accounts in many unrelated rooms — but it needs homeserver support.

The dominant *unbounded* sink was the first one: switching between rooms
used to leave every visited room's events, dedup set, and SDK timeline
pinned for the rest of the session. This app stores **one event per cell
edit**, so a large workspace is hundreds of thousands of events — a few
visited rooms could blow past 500 MB on their own.

## The two mechanisms

### 1. Structural caps (the real guarantee) — `src/main.js`

* **`MAX_OPEN_ROOMS` (default 3).** Only the active room and a tiny LRU
  stay hydrated. `openRoom()` touches the LRU and `enforceRoomCap()`
  closes the least-recently-used rooms beyond the cap. The UI only ever
  reads the active room (`useLiveStore` in `public/app.jsx`), so this is
  invisible — switching back re-hydrates from OPFS in one decrypt pass.

* **SDK timeline release.** `closeRoom()` and a first-time heavy seed both
  call `resetLiveTimeline()`, dropping the decrypted `MatrixEvent` objects
  the SDK accumulated. History is re-derived from the OPFS store, never
  the SDK cache, so nothing is lost — only re-read on demand. This matches
  the existing architecture note in `src/rooms.js` (`loadTimelineSince`).

Steady-state footprint is therefore bounded by
`MAX_OPEN_ROOMS × (one room's events)` no matter how many rooms exist.

### 2. Adaptive governor (catches the rest) — `src/memory.js`

Samples the heap on an interval and sheds before the budget is hit:

* Reads `performance.measureUserAgentSpecificMemory()` (accurate, but only
  in cross-origin-isolated contexts) or the legacy Chromium
  `performance.memory.usedJSHeapSize`. When neither exists the governor is
  inert and the structural caps carry the budget alone.
* **Soft threshold (80% ≈ 400 MB):** closes every non-active room and
  hard-trims the progress log.
* **Critical threshold (92% ≈ 460 MB):** additionally runs any evictors
  registered at `level: 'critical'` (reserved for view-layer caches).

Anything can plug in:

```js
const off = window.MatrixLive.onMemoryPressure((level, sample) => {
  if (level === 'critical') dropExpensiveCaches();
});

window.MatrixLive.getMemoryStats();   // { bytes, source, budgetBytes, fractionUsed, … }
window.MatrixLive.setMemoryBudget(300 * 1024 * 1024);  // tighten to 300 MB
window.MatrixLive.checkMemory();       // force a sample + shed now
```

Register an evictor from any module:

```js
import { registerEvictor } from './memory.js';
const off = registerEvictor('my-cache', () => myCache.clear() || true,
  { priority: 50, level: 'critical' });
```

## Honest limits

* `performance.memory` reports only the JS heap — it undercounts WASM,
  detached DOM, and GPU memory. Treat the governor's reading as a signal,
  not ground truth. The structural caps are what actually hold the line.
* A **single** room with more than roughly a million op-events can exceed
  the budget on its own, because the active room's full event log must be
  in memory for the time-travel scrubber and log view to fold to any
  cursor. Bounding that further means windowing the event log behind a
  persisted fold checkpoint (the `EventStore` already has the checkpoint
  primitives) — a larger change tracked as future work.

## Folding is incremental (speed, not memory)

The active room's state is derived by folding its event log. Re-folding the
whole log on every edit is `O(events)` per keystroke, so the UI
(`public/app.jsx`) caches the fold of the **append-only committed prefix**
and extends the cached accumulator with only the new tail on each render
(`O(new events)`). The small, volatile **pending** (optimistic) tail is
folded fresh on top of a copy that leaves the cache intact, and
time-travelling behind the live head folds that prefix from scratch without
disturbing the warm cache. This is a CPU/latency win — the events still
reside in memory, so the single-huge-room note above still stands; the
persisted fold checkpoint is what would address that.

## Tuning

Edit the constants in `src/main.js` (`MAX_OPEN_ROOMS`, `MEMORY_BUDGET_BYTES`)
and `src/memory.js` (`SOFT_FRACTION`, `CRITICAL_FRACTION`,
`SAMPLE_INTERVAL_MS`). Lower `MAX_OPEN_ROOMS` to 1 if your rooms are very
large; raise the budget if you target desktop-only and want fewer reloads.
