# Building on this repo

Instructions for a human or AI coder who wants to use this codebase to ship an
encrypted, federated app that **interoperates with every other app built on the
same primitives**.

This is not a chat client. It is a Matrix-backed, end-to-end encrypted,
append-only event store with a closed nine-operator algebra and a deterministic
state projection. You write the UI. Everything below it — auth, encryption,
sync, room management, event taxonomy, state projection, offline outbox,
encrypted media — is already here.

---

## 1. Read the repo in this order

You will understand the whole stack in under an hour by reading these files,
in this sequence:

1. `README.md` — one-page architecture diagram and the operator table.
2. `src/operators.js` (~180 lines) — the nine operators, the `emit()` path,
   namespace handling, content-addressed anchors.
3. `src/fold.js` (~375 lines) — the integral fold. `state(t) = fold(events[0..t])`.
   Read `dispatch()` and the dependency-ordering `_hwm` logic carefully.
4. `src/rooms.js` (~420 lines) — `createRoom`, `discoverRooms`, `getTimeline`,
   `onTimeline`, `invite`, members and power levels. Rooms are tables; room
   membership is the access model.
5. `src/client.js` (~490 lines) — login, restore, unlock, Rust-crypto init,
   sync. Most of this you never touch — call `login()`, `unlock()`, or
   `restoreSession()` and forget about it.
6. `src/media.js` — encrypted blob storage with the `__media: 2` event-content
   reference format. Anything over ~16 KB gets hoisted; the homeserver only
   ever sees ciphertext.
7. `src/outbox.js`, `src/store.js`, `src/network.js` — offline emit, local
   event cache (OPFS / IndexedDB), online/offline transitions. These exist so
   the app keeps working with no network.
8. `src/main.js` — reference wiring. Shows how a UI subscribes to live state,
   emits operators, handles optimistic echoes, and threads it all together.
9. `public/app.jsx`, `public/table-view.jsx`, `public/graph-view.jsx`,
   `public/db-view.jsx` — a working reference UI. Replace these to ship your
   own app.

After step 3 you will already be able to reason about the system. Steps 4–7
are how it stays usable in the real world (encryption, offline, large blobs,
flaky networks).

---

## 2. The mental model in one paragraph

A **room** is a table. A room's **timeline** is an append-only log of typed
events. Each event is one of seven stored operators (`INS`, `SEG`, `CON`,
`SYN`, `DEF`, `EVA`, `REC`); two more (`NUL`, `SIG`) are ephemeral and never
hit the log. The room is Megolm-encrypted, so the homeserver stores
ciphertext only. Current state is **never stored** — it is always derived by
folding the timeline through `dispatch()` (`src/fold.js`). Same events in,
same state out, on every device, in every app that uses the same namespace.
That last sentence is what makes interop work.

---

## 3. The interop contract

Two apps interoperate iff they agree on **four things**:

1. **Namespace.** The event type is `${NAMESPACE}.${op.key}`, e.g.
   `io.matrix-events.ins`. `operators.parseEventType()` ignores everything
   outside its namespace. To read another app's events you either share its
   namespace or run a second fold under that namespace.

   - **Same-app interop** (recommended default): pick one namespace per app
     family and use it everywhere. Call `setNamespace('com.acme.tasks')` at
     boot. Every install of every client in that family reads and writes the
     same room shape.
   - **Cross-app interop**: agree on a *shared* namespace for the rooms
     you want to federate (e.g. `org.eo.shared.docs`). Each app sets that
     namespace when it opens a shared room. App-private rooms keep their own
     namespace.

2. **Entity-type taxonomy.** `INS` carries `{ anchor, entity_type, payload }`.
   `entity_type` is a string — `'task'`, `'note'`, `'observation'`,
   `'message'`. Apps that agree on entity-type strings see each other's
   entities as the same kind of thing. Disagree and they coexist invisibly.

3. **Field paths under DEF.** `DEF` carries `{ anchor, path, value }` and
   sets `path` on the entity via `setPath()` (dot-notation). Two apps writing
   `def(anchor, 'status', 'done')` are talking about the same field. Two apps
   writing `'status'` vs `'state'` are not. Document your field paths; treat
   them like a public schema.

4. **Schema-as-log convention.** Schema lives in the same timeline as data,
   via `def(anchor=null, path='_schema.<...>', value)` (use
   `defSchema(roomId, path, value)`). The fold materializes it under
   `state.schema`. To onboard a new client: read `state.schema`, render UI
   accordingly. If your app wants to expose a stable schema to other apps,
   write a DEF on `_schema.tables.<entityType>.fields.*` at room creation
   time. Every cooperating client then knows the field set.

If all four match, **two clients written by different people, in different
languages, on different homeservers, see the same database.** That is the
federation guarantee. The homeserver only stores ciphertext; the agreement
lives in the namespace + taxonomy + field paths + schema log.

---

## 4. Building a new app — the minimum viable path

You only need to do five things:

### a. Pick a namespace and entity taxonomy

```js
import { setNamespace } from './src/operators.js';
setNamespace('com.acme.fieldnotes');
// entity_type values you intend to use: 'observation', 'site', 'tag'
// field paths you intend to use:        'title', 'lat', 'lng', 'body', 'status'
```

Write these down. They are your wire format. Treat changes the same way you
treat database migrations — emit a `REC` event when the meaning of a field
changes; emit `DEF` on `_schema.*` when the shape changes.

### b. Authenticate

```js
import { login, unlock, restoreSession, hasLocalAccount } from './src/client.js';

if (await hasLocalAccount(userId)) await unlock(userId, password);
else                                await login(homeserver, mxid, password);
```

You do not implement auth. You do not store credentials. There are no API
keys to leak. The user brings their own homeserver the way they bring their
own email.

### c. Create or discover a room

```js
import { createRoom, discoverRooms } from './src/rooms.js';

// First time: create a workspace
const roomId = await createRoom('Site 42 notes', 'fieldnotes.workspace');

// Returning users: enumerate
const rooms = discoverRooms('fieldnotes.workspace');
```

`discoverRooms` filters by the `${NAMESPACE}.meta` state event written at
creation time. Other apps' rooms (including DMs) are invisible. This is the
app-scoping boundary.

### d. Emit operators and listen for the fold

```js
import { ins, def, seg, con, eva } from './src/operators.js';
import { getTimeline, onTimeline, onDecrypted, loadTimelineSince } from './src/rooms.js';
import { fold, foldFrom, initial, stateHash } from './src/fold.js';

let state = initial();

// 1. Seed: paginate history, then fold
await loadTimelineSince(roomId, 0);
state = fold(getTimeline(roomId));
render(state);

// 2. Live: incremental fold on every new event (and on late decrypts)
let lastHash = stateHash(state);
const refold = () => {
  state = fold(getTimeline(roomId));   // or foldFrom for hot paths
  const h = stateHash(state);
  if (h !== lastHash) { lastHash = h; render(state); }
};
onTimeline(roomId, refold);
onDecrypted(roomId, refold);

// 3. Mutate: every UI action becomes an operator emission
async function createObservation(payload) {
  const anchor = await ins(roomId, 'observation', payload);
  return anchor;
}
async function setField(anchor, path, value) { return def(roomId, anchor, path, value); }
async function archive(anchor)               { return seg(roomId, anchor, 'archived'); }
async function link(a, b, kind)              { return con(roomId, a, b, kind); }
async function judge(anchor, criterion, ok)  { return eva(roomId, anchor, criterion, ok ? 'pass' : 'fail'); }
```

The render function only reads from `state`. It never reads the network. It
never holds a parallel cache. If you find yourself maintaining a second
source of truth alongside the fold, you have left the model.

### e. Attach large data via the media pointer pattern

```js
import { uploadFile } from './src/media.js';
const ref = await uploadFile(file);                  // encrypted, returns the __media:2 ref
await ins(roomId, 'document', { title: file.name, file: ref });
// later: getMediaBytes(ref) → decrypted Uint8Array
```

Events are small (≤ ~24 KB after hoisting). Large data is a pointer in the
event to an encrypted blob in the media repo. Both sides of the pointer are
E2EE; the key lives in the (Megolm-encrypted) event content.

That's the whole loop: **state = fold(timeline); UI = render(state); action =
emit(operator)**. There is nothing else.

---

## 5. The operators, when to use which

| Op | Glyph | Triad | Use it when |
|----|-------|-------|--------------|
| `NUL` | ∅ | existence | Observation — you're reading state, not changing it. Never emitted. |
| `SIG` | ○ | existence | Attention — typing indicator, cursor presence, read receipt. Ephemeral, no log entry. (Not exposed in `operators.js` because nothing in the fold consumes it; use Matrix typing/receipt APIs directly if you need it.) |
| `INS` | ● | existence | Creating a new entity with a permanent identity. Mints a content-addressed anchor. |
| `SEG` | ｜ | structure | Moving an entity across a partition boundary — archive, inbox, column, tag. Partition is a string. |
| `CON` | ⤫ | structure | Creating a *typed* relationship between two existing anchors. |
| `SYN` | △ | structure | Merging multiple anchors into a new synthesized one. The synthesis is a new entity, not a mutation. |
| `DEF` | ⊢ | significance | Setting a value on an existing entity within the current frame. This is the workhorse — ~80% of your emits. |
| `EVA` | ⊨ | significance | Recording a judgment: did this entity satisfy a criterion? Pass/fail/hold + a note. EVA without prior DEF is flagged as "criterionless judgment." |
| `REC` | ⊛ | significance | The frame itself changed. A schema reinterpretation. Rare. Every entity is now legible under a new context. |

**Dependency rule** (enforced as advisory `_violations` by the fold, not as
hard errors): an entity's high-water mark cannot retreat. `EVA` on an entity
that has never had `DEF` raises a `criterionless_judgment`. `CON` to a
non-existent anchor raises `cartesian_product`. `REC` with no prior `EVA`
anywhere raises `blind_restructuring`. The fold records; your linter
diagnoses.

---

## 6. Federation, in practice

- **Inviting users.** `invite(roomId, '@kevin:matrix.org')`. The SDK shares
  Megolm keys with the new member automatically. They can be on any
  homeserver — federation handles the rest. No DNS for you to configure.
- **Cross-homeserver writes.** Identical to single-homeserver writes. The
  member's homeserver forwards events to every other homeserver in the room.
  Eventual consistency, milliseconds in practice.
- **Bots / AI agents.** A Matrix user (including a bot) joining the room is
  the agent-in-loop pattern. The bot sees the same E2EE event stream as
  humans; its emitted operators live in the same log. There is no separate
  AI backend to secure.
- **Provenance.** Every event is signed by its sender's device key.
  `state.entities[anchor]._sender` and `_eventId` are preserved by the fold.
  The room timeline is the audit trail; redaction (not deletion) is the only
  way to remove an event, and redactions are themselves events.

---

## 7. What to *not* do

- **Do not invent a backend.** No API server. No database. No edge function.
  No environment-variable secret. If you find yourself reaching for one,
  you've left the model — find the operator that fits instead.
- **Do not cache state outside the fold.** If a render needs derived data,
  derive it from `state` in a memoized selector. The fold result is the only
  source of truth; everything else is a projection of it.
- **Do not write to `_anchor`, `_type`, `_created`, `_hwm`, or any
  underscore-prefixed field** via `def()`. The fold owns those.
- **Do not delete events.** You cannot. The timeline is append-only.
  Redaction (`client.redactEvent`) tombstones an event but the position is
  retained. Model "deletion" as `seg(anchor, 'trash')` or as a `DEF`
  setting a `deleted_at` field.
- **Do not store secrets in event content.** The room is encrypted, but the
  contract here is "data the room's members may see," not "private to you."
  Per-user secrets belong in `vault.js` (vault-encrypted, never leaves the
  device).
- **Do not assume event size is unbounded.** ≥ ~16 KB string fields get
  hoisted to encrypted media automatically; oversized inline payloads will
  bounce off the homeserver's `max_event_size`. Use media refs for blobs.

---

## 8. Run it, deploy it

```bash
npm install
npm run dev          # http://localhost:5173, default homeserver matrix.org
npm run build        # produces ./dist
```

The `dist/` is plain static files. Drop them on GitHub Pages (the included
Action does this automatically on push to `main`), Netlify, Cloudflare Pages,
S3+CloudFront, a thumb drive, anywhere. There is no server side.

To target your own homeserver: change the homeserver URL in the login UI
(`public/matrix-auth.jsx`) or just type it into the field at runtime. To
host the homeserver too: install Synapse, Dendrite, or Conduit; nothing in
this codebase pins you to matrix.org.

---

## 9. Cross-app interoperability checklist

Before shipping, verify you've answered each of these — yes for an app
intended to interoperate, deliberately no for an isolated one:

- [ ] Namespace is documented and stable. (Versioning lives in the log via
      `DEF _schema.version`, not in the namespace.)
- [ ] Entity-type strings are documented (`'task'`, `'observation'`, etc.).
- [ ] Field paths are documented per entity type.
- [ ] The `_schema.tables.*` events are emitted on room creation so a fresh
      client can render without prior knowledge.
- [ ] Your UI degrades gracefully on unknown entity types and unknown field
      paths — never throws. Other apps in the room will emit operators you
      haven't seen.
- [ ] You preserve operator semantics. Do not overload `SEG` to mean
      "renaming" or `DEF` to mean "deleting." The whole interop guarantee
      depends on the operator algebra being shared vocabulary.
- [ ] If you redefine what a field means, emit `REC` with `before_frame` and
      `after_frame` so other clients can reproject.

When two apps respect this list, they can share rooms and each will see the
other's entities, edits, links, and judgments as first-class data — without
ever exchanging a line of code.

---

## 10. Where to put your code

- Replace `public/app.jsx` and its sibling views with your UI.
- Keep `src/*` intact. Treat it as a library. If you find you need to fork
  it, file an issue first — the goal is for every app to share this exact
  layer so the interop contract above actually holds.
- Custom entity types and field paths are app data, not library code: they
  belong in your UI's domain module, not in `operators.js`.

That is the entire job. Pick a namespace, pick a taxonomy, write a renderer
of `state`, emit operators on user input. The Matrix homeserver, the
encryption, the federation, the offline outbox, the encrypted media, and the
state projection are already done.
