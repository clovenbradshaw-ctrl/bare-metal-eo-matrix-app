# matrix-events

**Delete the backend.** Rooms are tables. Events are rows. The fold is the query. There is no database to leave open, no API to expose, and no keys to leak — because those layers are not here.

Most "AI built it in a weekend" breaches share one root cause, and it is never the app logic — the model writes app logic fine. It is the layer underneath: the auth tier, the database tier, the API tier. The exact part of the stack where one wrong default is fatal, and the exact part a model configures worst. A Row-Level-Security toggle left off. A key shipped in the client bundle. An endpoint that returns every user's record if you just ask.

This repo removes that layer. The app is a single client that talks to a commodity Matrix homeserver, and that homeserver only ever holds ciphertext. Every app built on top shares the same data layer: an append-only, end-to-end encrypted event stream with typed operators and a deterministic state projection.

> **Try it:** [live demo](https://clovenbradshaw-ctrl.github.io/bare-metal-eo-matrix-app/) — runs entirely in your browser against any Matrix homeserver you point it at.

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

**You write the top layer.** Everything below it is this repo — and the homeserver below *that* is stock software you never wrote, storing data it cannot read.

## What you don't write

Run the checklist that every weekend-app breach failed against this architecture:

- **Authentication.** You don't write it. The user already has a Matrix account, or makes one on any homeserver. No login system, no OAuth, no credential store. **There are no API keys to leak because there are none.**
- **Encryption.** You don't write it. The Olm/Megolm ratchet encrypts every event on the device before it leaves. With encryption on, the homeserver stores ciphertext it cannot read. This repo enforces end-to-end encryption on every room it creates.
- **A database.** You don't write it, and there is none to misconfigure. A room is an ordered, append-only event log; **membership is the access model.** There is no Row Level Security to leave off — if you are not in the room, you do not see the events. The table that gets left open does not exist.
- **File storage, real-time sync, federation.** You don't write them. The content repository takes encrypted uploads and hands back a pointer; the sync loop pushes events to every device in a room; if two members are on different homeservers, the homeservers talk to each other.

Running the homeserver is not the same as reading the data. With E2EE set up correctly you operate a service that stores ciphertext you cannot decrypt — the keys live with the members of each room, derived from their passwords, held on their devices. Server access and data access decouple. What's left for you to get wrong is the part the model is actually good at: the app itself.

## The operators

Nine operators. A closed algebra. Every change to application state decomposes into one or more:

| Op | Glyph | What it does |
|----|-------|-------------|
| NUL | ∅ | Observation (ephemeral, not stored) |
| SIG | ○ | Attention (ephemeral, not stored) |
| **INS** | ● | Instantiate — create a new entity with a permanent anchor ID |
| **SEG** | ｜ | Segment — move an entity across a partition boundary |
| **CON** | ⤫ | Connect — typed relationship between two anchors |
| **SYN** | △ | Synthesize — merge inputs into a whole |
| **DEF** | ⊢ | Define — set a value within the current frame |
| **EVA** | ⊨ | Evaluate — test a particular against a general |
| **REC** | ⊛ | Recontextualize — change what the data means |

The seven stored operators become Matrix timeline events. The fold replays them into current state. They are dependency-ordered (`NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC`): each operator's preconditions are satisfied by the ones before it, and the fold flags transformations that skip a dependency. This is what a relational schema can't represent about its own evolution — the kind of a change, ordered so the ordering rejects malformed ones.

## The fold

State is never stored. It is always derived:

```
state(t) = fold(dispatch, initial, events[0..t])
```

Replay to any cursor position → see what was true then. Same events in, same state out. Deterministic. Schema lives in the same log as data (a schema change is a `DEF` aimed at a schema path), so there is no separate migration system and no second source of truth to drift.

## What you'd build on it

The sweet spot is anywhere the unit of relationship is small — which is most business software, once you stop modeling everything as if it were Twitter.

- **A CRM the customer can leave.** Each customer relationship is a room, and the customer is a member of it. Your sales team's dashboard is not a query against a central database — it is a *fold across every customer room they belong to*, projected client-side. The customer can audit every change (each `DEF` carries a sender and a timestamp), and when they leave, your access ends because membership ended. The room's event log is signed JSON they can take with them. No central store to leak; no data held hostage.
- **An encrypted field-investigation / case tool.** One investigation per room. Observations are `INS`, a link from source to claim is a `CON`, and when the theory of the case changes that is a `REC` that *preserves the old frame in the log* — replay to the day before it shifted and see how it looked then. The homeserver can't read any of it, so it can't be compelled to hand over plaintext it never had.
- **Trackers, journals, research tools, multi-party provenance** — anywhere each subject of the data should have a seat at the table.

An AI agent joins any of these as an ordinary room member: it sees the same encrypted event stream everyone else does and emits operators into the same log — `CON` suggestions, `EVA` flags pointing at a needed `REC` — inside the encrypted boundary, not behind an API that sees everything in the clear. There is no separate AI backend to secure.

## Honest scope

This removes the backend-as-a-service tier wherever the unit of trust is small. It does **not** replace large public consumer apps, and pretending otherwise would be dishonest:

- **Search over encrypted data is client-side** — the server can't index what it can't read. Fine at small membership; a real engineering problem at million-user scale.
- **There is no hard delete** — the protocol can ask other servers to redact but can't compel them. The log is append-only by design; model "deletion" as a `SEG` to a trash partition or a `DEF` setting `deleted_at`.
- **A single room with hundreds of thousands of members** has unsolved performance edges. For containers in the dozens to low hundreds these limits don't bite. (See [`MEMORY.md`](./MEMORY.md) for the in-browser memory budget and the single-large-room note.)

The honest target: CRMs, case management, trust verticals, trackers, journals, private and small-team apps — anywhere the membership of any one container stays small. When you outgrow it, the exit is clean: every event is a signed JSON object you own, replayable into anything that reads JSON.

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

Push to GitHub. The Action builds and deploys to GitHub Pages. The `dist/` is
plain static files — drop them on any static host, a folder, or a thumb drive.
There is no server side.

## Build your app

Replace `src/main.js` and `index.html` with your app. Import from the four
foundation modules. Everything else — auth, encryption, sync, room management,
event types, state projection — is handled. [`BUILDING.md`](./BUILDING.md) is
the full guide, including the cross-app interop contract (namespace + entity
taxonomy + field paths + schema-as-log) that lets two clients written by
different people see the same database.
