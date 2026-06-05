# Design: stable-key envelope encryption ("database E2EE")

Status: **proposal, for review.** No code yet.

## Why this exists

This app is a **database synced over Matrix**, not a chat. It stores **one
event per cell edit**, and the events *are* the data — losing history means
losing the table. We have repeatedly broken on Matrix's room encryption
(megolm) because megolm is built for chat and its core properties fight this
use case:

| megolm assumes… | this app needs… |
|---|---|
| forward secrecy — new devices *shouldn't* read old messages | every authorised device reads **all** history forever |
| keys live in one device's crypto store | survival across a browser wipe and the fresh device every login mints |
| a modest number of messages | one event per edit → potentially 10⁵–10⁶ megolm sessions |
| losing some scrollback is fine | losing history = losing the database |

A browser wipe destroys the device-scoped megolm store; the next login is a
new device that can only recover history from a **server-side key backup** —
a fragile stack (cross-signing + SSSS + interactive-auth on
`/keys/device_signing/upload`) that has never worked end-to-end on
hyphae.social. The symptom (`HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED`,
"key backup is not working") is the model leaking through, not a bug we are
one patch away from.

## Threat model (agreed)

- **Server-blind (hard requirement).** The homeserver operator must not be
  able to read workspace data at rest or in transit. *Passive* confidentiality
  against the homeserver is the bar.
- **Small trusted team** per workspace — a handful of invited members.
- **Out of scope for v1:** an *actively malicious* homeserver that substitutes
  a member's public key to MITM key distribution. We close the passive-read
  hole completely; the active-substitution hole is documented and left for a
  later key-verification step (§9).

## Core idea

Stop using megolm. Treat Matrix purely as an **untrusted sync transport** and
do our own envelope encryption with a **stable, non-rotating key per
workspace**. Any member who can obtain that key decrypts the entire history —
which is exactly a database's requirement and exactly what megolm refuses to
give.

Everything needed to recover after a wipe lives **on the server, encrypted**:
the wrapped workspace key in **room state**, and the key that unwraps it in
the user's **account data**, unlocked by the **login password**. No device
identity, no cross-signing, no key backup, no SSSS, no megolm sessions.

## 1. Key hierarchy

```
password ──PBKDF2(salt, iters)──▶ Account Key (AK)          per user, never stored
                                     │
                                     ▼ AES-GCM wrap
        account_data["<ns>.identity"] = { salt, iters, pub, iv, wrapped_priv }
                                     │
                                     ▼ unwrap
                            User Identity Key (UIK)          ECDH P-256 keypair, long-lived
                                     │
                  ECIES(member UIK_pub) per member           wrap, stored in room state
                                     │
              room_state["<ns>.wkey", state_key=@member] = { epoch, eph_pub, iv, ct }
                                     │
                                     ▼ unwrap
                         Workspace Content Key (WCK)          AES-256-GCM, per workspace+epoch
                                     │
                                     ▼ AES-GCM
                  every event payload  (the actual cell edits)
```

- **Account Key (AK):** `PBKDF2-SHA256(password, salt, iters≥600k)`. Derived on
  demand, never persisted. Root of recovery. (Same primitive `vault.js`
  already uses.)
- **User Identity Key (UIK):** an ECDH P-256 keypair, one per user, long-lived
  across devices and logins. Private key is wrapped by AK and stored in the
  user's `account_data` (server-side, only that user can read it). Public key
  is published both in `account_data` and — so other members can wrap to it —
  in room state when the user joins a workspace.
- **Workspace Content Key (WCK):** a random 256-bit AES-GCM key per workspace.
  Encrypts every event payload. **Stable** — rotates only when a member is
  removed (§6). Identified by `(workspace, epoch)`.

Why an identity keypair instead of a shared workspace passphrase? It means
members need **no secret beyond their login password** — onboarding is "you
were invited, you can read it," not "someone DMs you a passphrase out of
band." The passphrase variant is simpler to build and is noted as a fallback
in §10.

## 2. Wire format

Events go to an **unencrypted** Matrix room as a single opaque type, so the
server can't even see which operator fired or how the table is shaped:

```
type:    "<ns>.enc"
content: { v: 1, epoch: <int>, iv: <b64>, ct: <b64> }
```

`ct = AES-GCM(WCK_epoch, iv, JSON({ t: "<op-key>", c: <operator-content> }))`

The real operator key (`ins`/`def`/…) and its payload live **inside** the
ciphertext. `sender` and `origin_server_ts` stay on the cleartext Matrix event
— they are server-assigned metadata, not secret, and the fold already treats
them as such.

Key-distribution state events:

```
type "<ns>.member_key", state_key=@user  →  { pub: <b64 spki>, alg: "ecdh-p256" }
type "<ns>.wkey",       state_key=@user  →  { epoch, eph_pub: <b64>, iv, ct }      // ct = ECIES-wrapped WCK
```

`account_data` identity blob:

```
type "<ns>.identity"  →  { v:1, salt, iters, alg:"ecdh-p256", pub, iv, wrapped_priv }
```

## 3. Lifecycle

### First login on a fresh account
1. Generate UIK (ECDH P-256). Derive AK from password + new salt.
2. Write `account_data["<ns>.identity"]` with the AK-wrapped private key + public key.

### Creating a workspace
1. Create the room **without** `m.room.encryption` (plain room).
2. Generate WCK (epoch 0). Cache it in the local vault (encrypted at rest).
3. Publish own `<ns>.member_key` (public key) into the room.
4. Wrap WCK to self → `<ns>.wkey` (state_key = self). (So a wipe recovers it.)

### Sending an edit (replaces megolm send)
`emit → outbox → ` encrypt `{t,c}` with the current-epoch WCK →
`client.sendEvent(roomId, "<ns>.enc", envelope, txnId)`. No
`prepareToEncrypt`, no `isEncryptionEnabledInRoom` gating.

### Receiving an edit (replaces megolm decrypt)
Timeline/`onTimeline` handler sees a `<ns>.enc` event → look up `WCK[epoch]`
→ decrypt → reconstruct `{ type: "<ns>."+t, content: c }` as a plain object →
hand to `store.append` (which already accepts plain objects). Fold unchanged.

### Recovery after a browser wipe ← the whole point
1. Log in (password in scope). Vault unlocks as today.
2. Read `account_data["<ns>.identity"]`, derive AK from password, unwrap UIK
   private key. **No device, megolm, backup, or cross-signing involved.**
3. For each workspace: read `<ns>.wkey` (state_key = self) from room state,
   ECDH-unwrap every epoch's WCK, cache locally.
4. Re-sync the room's `<ns>.enc` events and decrypt. Full history restored.

Both server-side inputs (wrapped WCK in room state, wrapped UIK in account
data) always survive a wipe because they live on the homeserver, and both are
unlocked by the password. This is the property megolm could never give us
reliably.

## 4. Onboarding a new member (small trusted team)
1. Existing member invites `@m`; `@m` joins the plain room.
2. On join, `@m`'s client publishes its `<ns>.member_key` (public key).
3. Any member holding the WCK sees the new `member_key`, ECIES-wraps **every
   current-epoch WCK** to `@m`, and writes `<ns>.wkey` (state_key = `@m`).
4. `@m` reads its own `<ns>.wkey`, unwraps, and can now read history.

ECIES wrap (per recipient): ephemeral ECDH keypair `E`; `shared = ECDH(E_priv,
m_pub)`; `wk = HKDF-SHA256(shared)`; `ct = AES-GCM(wk, WCK)`; store
`{eph_pub: E_pub, iv, ct}`. Recipient: `shared = ECDH(m_priv, E_pub)` → same
`wk` → unwrap.

## 5. Access control
Unchanged and orthogonal: Matrix room membership + power levels still gate who
can join and post. Encryption only changes *who can read the bytes*. Someone
removed from the room can no longer fetch new events at all; §6 also stops
them reading any that leak.

## 6. Removing a member (key rotation)
A removed member already saw all data up to removal — unavoidable, same as
megolm. To protect **future** edits:
1. Generate `WCK[epoch+1]`.
2. Re-wrap it to every **remaining** member (new `<ns>.wkey` at the new epoch).
3. New sends use `epoch+1`. Remaining members keep all epochs to read the full
   history; the per-event `epoch` field selects the key.

## 7. Storage / at-rest
No change to the OPFS event store: it still persists **decrypted** operator
events (the receive path decrypts before `store.append`, exactly as it does
after a megolm decrypt today), and the vault keeps encrypting those bytes at
rest. Undecryptable events are still simply skipped, so a missing WCK degrades
gracefully (blank until the key arrives) instead of corrupting the store.

## 8. What we delete
- `m.room.encryption` from `createRoom`; `confirmEncryption`/`prepareToEncrypt`.
- `ensureSecureBackup`, cross-signing bootstrap, key-backup restore/enable, the
  per-session downloader reliance, SSSS-for-backup, `getSecretStorageKey`'s
  megolm paths. (`diagnoseBackup`/`restoreFromRecoveryKey` become legacy-only.)
- The "every login is a new device, hope the backup caught up" failure surface
  disappears entirely.

We keep a **read-only megolm fallback** only for legacy rooms that predate this
change *and* still have keys; rooms whose megolm keys are already lost stay
lost and must be recreated (documented in the migration note).

## 9. Known limitation (v1)
A malicious homeserver could serve a forged `<ns>.member_key` for `@m`, causing
a granter to wrap the WCK to the attacker. This breaks confidentiality only
under an **active** server attack, not passive reading. v2 mitigation: short
authentication-string / fingerprint verification of member public keys (the
team confirms fingerprints out of band, once per member), stored as a signed
`<ns>.member_key_verified` marker.

## 10. Simpler alternative (if we want less crypto)
**Workspace passphrase:** `WCK = PBKDF2(workspace_passphrase, room_salt)`,
passphrase shared out of band; each user stores it wrapped by their AK in
account data for wipe-recovery. No identity keys, no ECIES, no per-member
state. Cost: a second secret to manage and fully manual rotation on member
removal. Recommended only if the identity-key machinery feels too heavy.

## 11. Migration
- New rooms get `<ns>.meta.crypto = "envelope-v1"` and use this scheme.
- Rooms without that marker are treated as legacy megolm: read-only if keys
  exist, otherwise surfaced as "unrecoverable — recreate." No silent data loss.
- Optional one-time migrator: on a device that still has megolm keys for a
  legacy room, re-emit its decrypted history under envelope-v1 into a new room.

## 12. Phased implementation plan
1. **`crypto/identity.js`** — AK derivation, UIK generate/wrap/unwrap, account
   data read/write. Unit-testable in isolation.
2. **`crypto/workspaceKey.js`** — WCK generate/cache, ECIES wrap/unwrap, epoch
   handling, room-state read/write. Unit tests with known vectors.
3. **Send path** — envelope-encrypt in the outbox flusher; drop the megolm
   gating. Behind a per-room `crypto: "envelope-v1"` flag.
4. **Receive path** — decrypt `<ns>.enc` in the timeline handlers before
   `store.append`; keep the legacy megolm path for legacy rooms.
5. **`createRoom`** — plain room + WCK bootstrap + self-wrap + publish key.
6. **Membership** — on-join key publish; granter watches membership and wraps.
7. **Rotation** — re-key on member removal.
8. **Rip out** the megolm/backup stack once envelope-v1 is the only writer.

Each phase is independently shippable; 1–5 already deliver a fully
wipe-resilient single-user-and-their-devices experience, with multi-member
(6–7) layered on top.

---

### Open questions for review
- **Workspace vs. room granularity** for the WCK — one key per Matrix room is
  assumed here; confirm a "workspace" never spans multiple rooms.
- **PBKDF2 iteration count / Argon2** — WebCrypto gives us PBKDF2 only; is
  600k acceptable, or do we want a WASM Argon2 for the password-derived AK?
- **v1 member-key verification** — ship without it (§9) and add fingerprints in
  v2, or require it from day one?
- **Identity keys vs. passphrase** (§1 vs §10) — confirm the identity-key model
  is worth the extra code for the UX win.
