# matrix-events

Rooms are tables. Events are rows. The fold is the query. Synapse is the backend.

A minimal foundation for building applications on Matrix as a database. Every app built on top of this shares the same data layer: an append-only, end-to-end encrypted event stream with typed operators and a deterministic state projection.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Your App UI                │
├─────────────────────────────────────────────┤
│   operators.js    │   fold.js               │
│   emit(INS/DEF/…) │   state = fold(events)  │
├─────────────────────────────────────────────┤
│   rooms.js        │   client.js             │
│   create/discover │   auth / sync / crypto  │
├─────────────────────────────────────────────┤
│            matrix-js-sdk + Rust Crypto      │
│         (Megolm E2EE handled by the SDK)    │
├─────────────────────────────────────────────┤
│               Matrix Homeserver             │
│     (Synapse / Conduit / Dendrite)           │
└─────────────────────────────────────────────┘
```

**You write the top layer.** Everything below it is this repo.

## The operators

Nine operators. A closed algebra. Every change to application state decomposes into one or more:

| Op | Glyph | What it does |
|----|-------|-------------|
| NUL | ∅ | Observation (ephemeral, not stored) |
| SIG | ○ | Attention (ephemeral, not stored) |
| **INS** | ● | Instantiate — create a new entity with a permanent anchor ID |
| **SEG** | ｜ | Segment — move an entity across a partition boundary |
| **CON** | ⋈ | Connect — typed relationship between two anchors |
| **SYN** | △ | Synthesize — merge inputs into a whole |
| **DEF** | ⊢ | Define — set a value within the current frame |
| **EVA** | ⊨ | Evaluate — test a particular against a general |
| **REC** | ⊛ | Recontextualize — change what the data means |

The seven stored operators become Matrix timeline events. The fold replays them into current state.

## The fold

State is never stored. It is always derived:

```
state(t) = fold(dispatch, initial, events[0..t])
```

Replay to any cursor position → see what was true then. Same events in, same state out. Deterministic.

## Modules

### `client.js`
```js
import { login, restoreSession, logout, getClient } from './src/client.js';

await login('https://matrix.org', '@user:matrix.org', 'password');
// SDK initializes Rust crypto → Megolm E2EE active
// Sync loop running → timeline events arrive automatically
```

### `operators.js`
```js
import { setNamespace, ins, def, seg, con, eva, rec } from './src/operators.js';

setNamespace('com.myapp');                          // set once at startup
const anchor = await ins(roomId, 'task', { title: 'Do thing' });  // create entity
await def(roomId, anchor, 'status', 'active');      // set a field
await seg(roomId, anchor, 'done');                  // move to partition
await con(roomId, anchor, otherAnchor, 'blocks');   // create relationship
await eva(roomId, anchor, 'completeness', 'pass');  // evaluate
```

### `fold.js`
```js
import { fold, foldFrom, entitiesOfType } from './src/fold.js';

const state = fold(timelineEvents);               // full replay
const updated = foldFrom(state, newEvents);        // incremental
const tasks = entitiesOfType(state, 'task');        // query
```

### `rooms.js`
```js
import { createRoom, discoverRooms, getTimeline, onTimeline } from './src/rooms.js';

const roomId = await createRoom('My Project', 'project');
const rooms = discoverRooms('project');            // find app rooms
const events = getTimeline(roomId);                // feed the fold
onTimeline(roomId, (event) => recomputeState());   // live updates
```

## Run locally

```
npm install
npm run dev
```

## Memory

The app holds the tab under a 500 MB heap budget: only a small LRU of rooms
stays in memory (history is re-read from OPFS on demand), the matrix-js-sdk
timeline is released for closed rooms, and an adaptive governor sheds
inactive state when the platform reports heap pressure. See
[`MEMORY.md`](./MEMORY.md) for the model, tuning knobs, and the
`window.MatrixLive` memory API.

## Deploy

Push to GitHub. The Action builds and deploys to GitHub Pages. That's it.

## Build your app

Replace `src/main.js` and `index.html` with your app. Import from the four foundation modules. Everything else — auth, encryption, sync, room management, event types, state projection — is handled.
