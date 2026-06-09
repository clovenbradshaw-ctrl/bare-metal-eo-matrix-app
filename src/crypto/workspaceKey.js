/**
 * crypto/workspaceKey.js — the stable Workspace Content Key (WCK)
 *
 * Implements §1/§4 of ENCRYPTION-DESIGN.md for a single epoch: one
 * random AES-256 key per workspace room, ECIES-wrapped to every member's
 * identity public key and stored in room STATE — which is never
 * megolm-encrypted, so it survives any browser wipe and is readable the
 * moment the room syncs:
 *
 *   "<ns>.member_key"  state_key=@user → { v, alg, pub }
 *   "<ns>.wkey"        state_key=@user → { v, epoch, eph_pub, blob }
 *
 * Matrix auth rules guarantee a state event whose state_key starts with
 * "@" can only be sent by that user, so a member_key is always
 * self-published. (A malicious homeserver could still forge one — the
 * active-substitution attack §9 scopes out of v1.)
 *
 * The unwrapped WCK is cached in the local vault per room. Everything is
 * best-effort and never throws: a member who can't obtain the key (e.g.
 * no power level to publish state in a legacy room and nobody granted
 * them yet) simply runs without the block chain.
 */

import {
  generateWorkspaceKey, wrapWorkspaceKey, unwrapWorkspaceKey,
  importIdentityPublicKey, b64, unb64,
} from './envelope.js';
import { getIdentity } from './identity.js';
import { storeSecret, loadSecret } from '../vault.js';

const MEMBER_KEY_TYPE = (ns) => `${ns}.member_key`;
const WKEY_TYPE = (ns) => `${ns}.wkey`;

// roomId → Uint8Array (epoch 0). Cleared on logout.
const wckCache = new Map();

export function getCachedWorkspaceKey(roomId) { return wckCache.get(roomId) || null; }
export function clearWorkspaceKeys() { wckCache.clear(); }

function vaultName(roomId) { return `wck:${roomId}`; }

async function cacheWck(userId, roomId, wck) {
  wckCache.set(roomId, wck);
  try { await storeSecret(userId, vaultName(roomId), JSON.stringify({ v: 1, epoch0: b64(wck) })); }
  catch (e) { console.warn('[wck] vault cache write failed:', e?.message || e); }
}

async function loadWckFromVault(userId, roomId) {
  try {
    const raw = await loadSecret(userId, vaultName(roomId));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.epoch0 ? unb64(obj.epoch0) : null;
  } catch { return null; }
}

/** Read one state event's content via HTTP, null on M_NOT_FOUND. */
async function readState(client, roomId, type, stateKey) {
  try { return await client.getStateEvent(roomId, type, stateKey); }
  catch (e) {
    if (e?.errcode === 'M_NOT_FOUND' || e?.httpStatus === 404) return null;
    // Fall back to the sync cache before giving up (offline, flaky server).
    try {
      const ev = client.getRoom(roomId)?.currentState?.getStateEvents(type, stateKey);
      return ev ? ev.getContent() : null;
    } catch { return null; }
  }
}

/** All state events of a type from the sync cache: [{ stateKey, content }]. */
function readStateAll(client, roomId, type) {
  try {
    const evs = client.getRoom(roomId)?.currentState?.getStateEvents(type) || [];
    return evs.map(ev => ({ stateKey: ev.getStateKey(), content: ev.getContent() }));
  } catch { return []; }
}

/** Publish our identity public key into the room so holders can wrap to us. */
export async function publishMemberKey(client, namespace, roomId) {
  const identity = getIdentity();
  if (!identity) return false;
  try {
    const existing = await readState(client, roomId, MEMBER_KEY_TYPE(namespace), identity.userId);
    if (existing?.pub === identity.pub) return true;
    await client.sendStateEvent(roomId, MEMBER_KEY_TYPE(namespace),
      { v: 1, alg: 'ecdh-p256', pub: identity.pub }, identity.userId);
    return true;
  } catch (e) {
    console.warn('[wck] member_key publish failed:', e?.message || e);
    return false;
  }
}

/**
 * Obtain the room's WCK for this user, in preference order: memory →
 * vault cache → unwrap own `<ns>.wkey` from room state → mint a fresh
 * key and publish it (creator / first-writer path). Returns the raw key
 * bytes or null when none of those is possible.
 */
export async function ensureWorkspaceKey(client, namespace, roomId) {
  const identity = getIdentity();
  const userId = identity?.userId || client?.getUserId?.();

  const inMemory = wckCache.get(roomId);
  if (inMemory) return inMemory;

  if (userId) {
    const fromVault = await loadWckFromVault(userId, roomId);
    if (fromVault) {
      wckCache.set(roomId, fromVault);
      // The vault copy may predate our wkey state (e.g. it was minted
      // offline) — make sure the server-side wrap exists for wipe recovery.
      if (identity) await selfWrapIfMissing(client, namespace, roomId, fromVault, identity);
      return fromVault;
    }
  }

  if (!client || !identity) return null;

  // Recover from room state (the post-wipe path).
  const wrapped = await readState(client, roomId, WKEY_TYPE(namespace), identity.userId);
  if (wrapped?.eph_pub && wrapped?.blob) {
    try {
      const wck = await unwrapWorkspaceKey(identity.privateKey, wrapped);
      await cacheWck(identity.userId, roomId, wck);
      return wck;
    } catch (e) {
      console.warn('[wck] could not unwrap own wkey (identity changed?):', e?.message || e);
    }
  }

  // No key anywhere — mint one. Publish our member_key first so other
  // members can be granted, then wrap to ourselves (and anyone who has
  // already published a key). Requires state power level; on failure we
  // leave a member_key behind so a holder can grant us instead.
  const published = await publishMemberKey(client, namespace, roomId);
  try {
    const wck = generateWorkspaceKey();
    const selfWrap = await wrapWorkspaceKey(await importIdentityPublicKey(identity.pub), wck);
    await client.sendStateEvent(roomId, WKEY_TYPE(namespace),
      { v: 1, epoch: 0, ...selfWrap }, identity.userId);
    await cacheWck(identity.userId, roomId, wck);
    await grantWorkspaceKey(client, namespace, roomId, wck);
    return wck;
  } catch (e) {
    console.warn('[wck] could not mint a workspace key' +
      (published ? ' (member_key published — waiting for a grant)' : '') + ':', e?.message || e);
    return null;
  }
}

async function selfWrapIfMissing(client, namespace, roomId, wck, identity) {
  try {
    const existing = await readState(client, roomId, WKEY_TYPE(namespace), identity.userId);
    if (existing?.blob) return;
    const selfWrap = await wrapWorkspaceKey(await importIdentityPublicKey(identity.pub), wck);
    await client.sendStateEvent(roomId, WKEY_TYPE(namespace),
      { v: 1, epoch: 0, ...selfWrap }, identity.userId);
  } catch (e) {
    console.warn('[wck] self wkey publish failed:', e?.message || e);
  }
}

/**
 * Grant pass (§4): wrap the WCK we hold for every member who has
 * published a member_key but has no key yet. Matrix auth rules forbid
 * sending a state event whose state_key is ANOTHER user's mxid (an
 * "@"-prefixed state_key must equal the sender), so a grant cannot be
 * written at `<ns>.wkey` state_key=@them. Grants therefore ride on OUR
 * own wkey state event, in a `grants` map keyed by recipient; the
 * recipient adopts theirs via adoptGrantedKey() and then self-publishes
 * a normal wkey under their own state_key.
 */
export async function grantWorkspaceKey(client, namespace, roomId, wck) {
  const identity = getIdentity();
  if (!identity || !wck) return 0;
  const members = readStateAll(client, roomId, MEMBER_KEY_TYPE(namespace));
  if (!members.length) return 0;

  // Existing grants live on OUR wkey state event under `grants`.
  const own = await readState(client, roomId, WKEY_TYPE(namespace), identity.userId) || {};
  const grants = { ...(own.grants || {}) };
  let added = 0;

  for (const { stateKey: member, content } of members) {
    if (!member || member === identity.userId || !content?.pub) continue;
    // Skip members who already unwrapped their own wkey or have a grant.
    const theirs = await readState(client, roomId, WKEY_TYPE(namespace), member);
    if (theirs?.blob) continue;
    if (grants[member]?.pub === content.pub) continue;
    try {
      const wrap = await wrapWorkspaceKey(await importIdentityPublicKey(content.pub), wck);
      grants[member] = { v: 1, epoch: 0, pub: content.pub, ...wrap };
      added++;
    } catch (e) {
      console.warn('[wck] grant wrap failed for', member, e?.message || e);
    }
  }

  if (added > 0) {
    try {
      await client.sendStateEvent(roomId, WKEY_TYPE(namespace),
        { ...own, v: 1, epoch: 0, grants }, identity.userId);
    } catch (e) {
      console.warn('[wck] grant publish failed:', e?.message || e);
      return 0;
    }
  }
  return added;
}

/**
 * Pick up a grant another member published for us (counterpart of
 * grantWorkspaceKey): scan every member's wkey state event for a
 * `grants[@me]` entry, unwrap it, cache it, and self-publish our own
 * wkey so future recoveries don't depend on the granter's event.
 */
export async function adoptGrantedKey(client, namespace, roomId) {
  const identity = getIdentity();
  if (!identity) return null;
  const all = readStateAll(client, roomId, WKEY_TYPE(namespace));
  for (const { stateKey: sender, content } of all) {
    const grant = content?.grants?.[identity.userId];
    if (!grant?.blob) continue;
    if (grant.pub && grant.pub !== identity.pub) continue; // wrapped to an old key of ours
    try {
      const wck = await unwrapWorkspaceKey(identity.privateKey, grant);
      await cacheWck(identity.userId, roomId, wck);
      await selfWrapIfMissing(client, namespace, roomId, wck, identity);
      return wck;
    } catch (e) {
      console.warn('[wck] grant unwrap failed (from', sender + '):', e?.message || e);
    }
  }
  return null;
}
