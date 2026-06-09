/**
 * crypto/identity.js — the user's envelope-encryption identity
 *
 * Implements §1/§3 of ENCRYPTION-DESIGN.md: a long-lived ECDH P-256
 * keypair per user whose private half is wrapped by the password-derived
 * Account Key and stored in Matrix account_data — so it survives a full
 * browser wipe and is recoverable from the password alone.
 *
 *   account_data["<ns>.identity"] =
 *     { v:1, alg:"ecdh-p256", salt, iters, pub, wrapped_priv }
 *
 * The unwrapped private key is cached in the local vault (encrypted at
 * rest) so cold boots that auto-restore the session — where no password
 * is in scope — can still use it. The vault copy is a cache; the
 * account_data blob is the source of truth.
 *
 * Everything here is best-effort: a failure leaves the identity absent
 * and callers degrade (the block chain just doesn't run) rather than
 * breaking login.
 */

import {
  deriveAccountKey,
  generateIdentityKeyPair, exportIdentityPublicKey,
  wrapIdentityPrivateKey, unwrapIdentityPrivateKey,
  exportIdentityPrivateKey, importIdentityPrivateKey,
  b64,
} from './envelope.js';
import { storeSecret, loadSecret } from '../vault.js';

const ACCOUNT_DATA_TYPE = (ns) => `${ns}.identity`;
const VAULT_SECRET_NAME = 'envelope_identity';

// The active identity: { userId, pub (b64 spki), privateKey (CryptoKey) }.
let current = null;

export function getIdentity() { return current; }
export function clearIdentity() { current = null; }

async function cacheInVault(userId, pub, privateKey) {
  try {
    const priv = await exportIdentityPrivateKey(privateKey);
    await storeSecret(userId, VAULT_SECRET_NAME, JSON.stringify({ v: 1, pub, priv }));
  } catch (e) {
    console.warn('[identity] vault cache write failed:', e?.message || e);
  }
}

/**
 * Load the identity from the local vault cache only. For cold-boot
 * session restores where the password is not available. Returns the
 * identity or null.
 */
export async function loadIdentityFromVault(userId) {
  try {
    const raw = await loadSecret(userId, VAULT_SECRET_NAME);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.pub || !obj?.priv) return null;
    current = {
      userId,
      pub: obj.pub,
      privateKey: await importIdentityPrivateKey(obj.priv),
    };
    return current;
  } catch (e) {
    console.warn('[identity] vault cache read failed:', e?.message || e);
    return null;
  }
}

async function readAccountData(client, type) {
  try {
    if (typeof client.getAccountDataFromServer === 'function') {
      return await client.getAccountDataFromServer(type);
    }
  } catch (e) {
    console.warn('[identity] account_data fetch failed:', e?.message || e);
  }
  try { return client.getAccountData?.(type)?.getContent?.() || null; }
  catch { return null; }
}

/**
 * Ensure this user has an envelope identity, with the password in scope
 * (login / unlock path):
 *
 *   1. account_data exists and the password unwraps it → load (and refresh
 *      the vault cache).
 *   2. account_data exists but the password does NOT unwrap it (password
 *      changed) → if the vault cache still has the key, re-wrap it under
 *      the new password and overwrite account_data; otherwise give up.
 *   3. no account_data → generate a keypair, wrap, publish.
 *
 * Returns the identity or null. Never throws.
 */
export async function ensureIdentity(client, namespace, userId, password) {
  if (!client || !userId || !password) return current;
  const type = ACCOUNT_DATA_TYPE(namespace);

  try {
    const existing = await readAccountData(client, type);

    if (existing && existing.wrapped_priv && existing.salt) {
      try {
        const { key } = await deriveAccountKey(password, existing.salt, existing.iters);
        const privateKey = await unwrapIdentityPrivateKey(key, existing.wrapped_priv);
        current = { userId, pub: existing.pub, privateKey };
        await cacheInVault(userId, existing.pub, privateKey);
        return current;
      } catch {
        // Password changed since the blob was written. Recover from the
        // vault cache when we can; the re-wrap keeps recovery working
        // after the NEXT wipe too.
        const cached = await loadIdentityFromVault(userId);
        if (cached) {
          await publishIdentity(client, type, password, cached.pub, cached.privateKey);
          return current;
        }
        console.warn('[identity] account_data identity is locked by an old password and no local copy exists');
        return null;
      }
    }

    // No server-side identity yet. Prefer a vault-cached key (so existing
    // chains stay readable) and publish it; otherwise mint a fresh one.
    const cached = await loadIdentityFromVault(userId);
    if (cached) {
      await publishIdentity(client, type, password, cached.pub, cached.privateKey);
      return current;
    }

    const pair = await generateIdentityKeyPair();
    const pub = await exportIdentityPublicKey(pair.publicKey);
    current = { userId, pub, privateKey: pair.privateKey };
    await publishIdentity(client, type, password, pub, pair.privateKey);
    await cacheInVault(userId, pub, pair.privateKey);
    return current;
  } catch (e) {
    console.warn('[identity] ensureIdentity failed:', e?.message || e);
    return current;
  }
}

async function publishIdentity(client, type, password, pub, privateKey) {
  const { key, salt, iterations } = await deriveAccountKey(password);
  const wrapped = await wrapIdentityPrivateKey(key, privateKey);
  await client.setAccountData(type, {
    v: 1,
    alg: 'ecdh-p256',
    salt: b64(salt),
    iters: iterations,
    pub,
    wrapped_priv: wrapped,
  });
}
