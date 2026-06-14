/* airtable-sync.js — ongoing inbound sync, Airtable → this workspace.
 *
 * The import (airtable-import.jsx) is a one-shot snapshot: it streams a base's
 * records into immutable, chunked media blobs. This module keeps that snapshot
 * live. It does NOT re-pull whole tables on a timer. It watches Airtable's
 * webhook payload stream — a true field-level diff — and folds each change into
 * the event log as operators:
 *
 *     created record   → INS (deterministic anchor) with its cell values
 *     changed cell     → DEF on that record's anchor (copy-on-write promote
 *                        from the blob the first time a blob-only row diverges)
 *     destroyed record → SEG to the `_deleted` partition (append-only tombstone)
 *
 * The blob stays the cold baseline for the bulk of unchanged rows (zero events
 * forever). Only what actually changed since the last snapshot costs events, so
 * the heap budget the import was built around is preserved. renderState shadows
 * a blob row with the folded entity that claims the same `_recordId`, so a
 * promoted/edited/created row wins and a `_deleted` one disappears.
 *
 * WHY WEBHOOK PAYLOADS, NOT POLLING list-records:
 *   - the payload IS the diff (changed cells, keyed by record + field id), so we
 *     never diff a whole row against a baseline;
 *   - `fromSources: ["client"]` excludes API writes server-side, so a future
 *     push back to Airtable won't echo into this stream;
 *   - `destroyedRecordIds` makes deletes visible (list-records can't see them);
 *   - the cursor + baseTransactionNumber give exactly-once, gap-proof replay.
 *
 * FULL SWEEP (the "too much change" path). Webhook payloads are retained 7 days
 * and a PAT-created webhook expires after 7 days unless refreshed. If we've been
 * away too long (cursor invalid / webhook gone) OR a single catch-up cycle would
 * have to replay more changes than MAX_CHANGES_BEFORE_SWEEP (or keep paging past
 * MAX_PAGES_PER_CYCLE with mightHaveMore still true), replaying the diff is the
 * wrong tool: we throw it away, re-snapshot every watched table through the
 * existing chunked importer (a new `import_seq` supersedes the old generation —
 * no duplicates), recreate the webhook so its cursor starts at "now", and resume
 * incrementally. Changes that land mid-sweep are caught by the fresh webhook and
 * re-applied idempotently (deterministic anchors + last-write-wins DEF).
 *
 * SILENT-EXPIRY GUARDS (the gap a burst/cursor-invalid sweep does NOT close).
 * The dangerous case is not a burst — the payloads endpoint returns 50 payloads
 * per call, each batching many record changes, and catchUp pages the cursor to
 * mightHaveMore:false, so a burst is just a couple of pages. The dangerous case
 * is coming back online after payloads quietly expired: the cursor may still
 * resolve, so you'd resume PAST the head you missed and never know. Three
 * additions close it (all routing to a full sweep, which is the one safe answer
 * to "too far behind to trust"):
 *   1. getWebhook() health check on every arm — sweep if the hook is missing or
 *      its isHookEnabled / areNotificationsEnabled flags went false (payload
 *      generation stopped), instead of trusting a cached expiresAt.
 *   2. a retention guard atop catchUp — sweep if the last good sync OR sweep is
 *      older than six days (inside the 7-day retention), so a long offline
 *      stretch never resumes mid-stream.
 *   3. the refresh path reads the hook's REAL expirationTime, not the cached one.
 *
 * WHERE IT RUNS. Browser-only by design, same posture as the import: the PAT is
 * passed to start() and held in memory for the life of the tab, sent only to
 * api.airtable.com. The webhook id + cursor are persisted in the encrypted log
 * (not the token). Consequences: sync only advances while a tab is open, and the
 * webhook/payload endpoints must send CORS headers (the data API does; verify
 * the webhooks endpoints in your environment). For always-on sync, run this same
 * loop in the n8n relay that already backs getDriveBackup — it holds the token
 * server-side and writes events into the room as a bot. The translation below is
 * transport-agnostic; only `atFetch` would move.
 *
 *   window.AirtableSync.start({ roomId, baseId, token, getState, emit, log })
 *   window.AirtableSync.stop()
 *   window.AirtableSync.sweepNow()      // force a full re-snapshot (all tables)
 *   window.AirtableSync.sweepTable(name)// re-snapshot one watched table now
 *   window.AirtableSync.status()        // { running, cursor, lastSync, lastError, ... }
 *
 * This module is PULL only. The symmetric push (operator log → Airtable upsert
 * on a `_anchor` merge field) is a separate drain; the provenance hooks it needs
 * are noted inline (`_origin` on synced entities, `fromSources` on the webhook).
 */

(function () {
  'use strict';

  const AT_BASE = 'https://api.airtable.com/v0';

  // Browser-polite. Rate limit is 5 req/s per base; one cycle is a handful of
  // calls, so 15s between cycles never gets near it.
  const POLL_INTERVAL_MS = 15_000;
  // Catch-up budget per cycle. Past either bound we stop replaying and sweep.
  const MAX_PAGES_PER_CYCLE = 8;
  const MAX_CHANGES_BEFORE_SWEEP = 1_500;
  // Refresh the webhook when it's within a day of its 7-day expiry.
  const REFRESH_BEFORE_MS = 24 * 60 * 60 * 1_000;
  // Payloads retain 7 days; if our last good sync/sweep is older than this we
  // can't trust the cursor (silent-expiry guard) and re-snapshot instead.
  const RETENTION_SWEEP_MS = 6 * 24 * 60 * 60 * 1_000;
  // A poll loop only runs if it holds the lease or the lease has gone stale —
  // stops two open tabs from racing the cursor and burning rate limit.
  const LEASE_STALE_MS = POLL_INTERVAL_MS * 3;

  // Identity stamped on synced entities. Coarse provenance for auditing and for
  // the future push drain to recognise rows that originated upstream.
  const ORIGIN = 'airtable';
  const DELETED_PARTITION = '_deleted';

  // ── Authed fetch to Airtable, with 429 backoff ───────────────────────────
  async function atFetch(token, method, path, body) {
    const url = path.startsWith('http') ? path : AT_BASE + path;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        throw new Error('could not reach Airtable (api.airtable.com must be allowed, incl. CORS on the webhooks endpoints)');
      }
      if (res.status === 429) { await sleep(30_000); continue; } // Airtable says wait ~30s
      if (res.status === 401) throw new Error('unauthorized — the token is invalid or expired');
      if (res.status === 403) throw new Error('forbidden — the token lacks a scope (webhook:manage · schema.bases:read · data.records:read)');
      if (res.status === 404) { const e = new Error('not found'); e.status = 404; throw e; }
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = j?.error?.message || j?.error?.type || j?.error || ''; } catch { /* ignore */ }
        const e = new Error(`Airtable ${res.status}${detail ? ' — ' + detail : ''}`);
        e.status = res.status;
        throw e;
      }
      if (res.status === 204) return null;
      return res.json();
    }
    throw new Error('Airtable rate limit — gave up after repeated 429s');
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── Webhook lifecycle ────────────────────────────────────────────────────
  // One webhook per base, watching record data on the tables we imported.
  // fromSources:["client"] keeps human edits and excludes API writes, so our
  // own pushes never come back as inbound diffs. includeCellValuesInFieldIds
  // (all watched fields) makes the payload carry the new values directly.
  function webhookSpec(tableIds) {
    const filters = {
      dataTypes: ['tableData'],
      changeTypes: ['add', 'update', 'remove'],
      fromSources: ['client'],
    };
    if (tableIds && tableIds.length === 1) filters.recordChangeScope = tableIds[0];
    return {
      // notificationUrl omitted: poll-only. We never receive the ping; we drive
      // entirely off the cursor, which is the durable mechanism anyway.
      specification: {
        options: {
          filters,
          includes: { includeCellValuesInFieldIds: 'all' },
        },
      },
    };
  }

  async function createWebhook(token, baseId, tableIds) {
    const j = await atFetch(token, 'POST', `/bases/${baseId}/webhooks`, webhookSpec(tableIds));
    return { id: j.id, expiresAt: j.expirationTime ? Date.parse(j.expirationTime) : 0 };
  }
  async function refreshWebhook(token, baseId, webhookId) {
    const j = await atFetch(token, 'POST', `/bases/${baseId}/webhooks/${webhookId}/refresh`, {});
    return j?.expirationTime ? Date.parse(j.expirationTime) : 0;
  }
  async function deleteWebhook(token, baseId, webhookId) {
    try { await atFetch(token, 'DELETE', `/bases/${baseId}/webhooks/${webhookId}`); } catch { /* best effort */ }
  }
  // GUARD 1 (silent-expiry): read the hook's REAL state rather than trusting a
  // cached expiresAt. Airtable has no GET-by-id, so list and find. Returns null
  // when the hook is gone (it expired or was deleted) — the caller sweeps.
  async function getWebhook(token, baseId, webhookId) {
    const j = await atFetch(token, 'GET', `/bases/${baseId}/webhooks`);
    const wh = (j?.webhooks || []).find(w => w.id === webhookId);
    if (!wh) return null;
    return {
      id: wh.id,
      // Default to "healthy" only when Airtable affirmatively says so; a hook
      // that stopped generating payloads flips one of these to false.
      isHookEnabled: wh.isHookEnabled !== false,
      areNotificationsEnabled: wh.areNotificationsEnabled !== false,
      expiresAt: wh.expirationTime ? Date.parse(wh.expirationTime) : 0,
      cursorForNextPayload: wh.cursorForNextPayload || 0,
    };
  }
  // { payloads:[…], cursor:<next>, mightHaveMore:bool }
  function listPayloads(token, baseId, webhookId, cursor) {
    const q = cursor ? `?cursor=${cursor}` : '';
    return atFetch(token, 'GET', `/bases/${baseId}/webhooks/${webhookId}/payloads${q}`);
  }
  // Full single record (fields keyed by NAME) — for copy-on-write promotion.
  function fetchRecord(token, baseId, tableIdOrName, recordId) {
    return atFetch(token, 'GET', `/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}`);
  }

  // ── Persisted sync state (rides in the encrypted log, under _schema.*) ─────
  // Anchorless DEF only survives the fold under a `_schema.` path, so sync
  // bookkeeping lives at _schema.sync.airtable.<baseId>. The PAT is NOT stored.
  function readSyncState(state, baseId) {
    return state?.schema?.sync?.airtable?.[baseId] || null;
  }
  function writeSyncState(emit, state, baseId, patch) {
    const prev = readSyncState(state, baseId) || {};
    const next = { ...prev, ...patch };
    emit(window.MatrixEngine.OP.DEF, {
      anchor: null,
      path: `_schema.sync.airtable.${baseId}`,
      value: next,
    });
    return next;
  }

  // ── Maps derived from the base schema + the existing import entities ───────
  // Webhook payloads key tables and cells by ID; the workspace keys by NAME.
  function buildMaps(parsedSchema) {
    const tableNameById = new Map();   // tblXXX → "People"
    const fieldNameById = new Map();   // per-table: tblXXX → (fldYYY → "Status")
    const primaryByTable = new Map();  // tblXXX → primary field name
    for (const t of parsedSchema.tables || []) {
      if (t.id) tableNameById.set(t.id, t.name);
    }
    return { tableNameById, fieldNameById, primaryByTable };
  }

  // Tables this workspace imported from `baseId`, as { id, name } — the watch
  // set. Derived from import entities so sync follows exactly what was imported.
  function watchedTables(state, baseId) {
    const out = new Map();
    for (const e of Object.values(state?.entities || {})) {
      if (e?._type !== 'import') continue;
      if (e.source !== 'airtable' || e.airtable_base !== baseId) continue;
      if (!e.derived_set) continue;
      out.set(e.airtable_table || e.derived_set, e.derived_set);
    }
    return out; // tableId (or name) → set/_type name
  }

  // App field-type lookup so we never write computed/linked values as data.
  function fieldType(state, tableName, fieldName) {
    const fields = state?.schema?.fields?.[tableName];
    if (!Array.isArray(fields)) return null;
    const f = fields.find(x => x && x.name === fieldName);
    return f ? f.type : null;
  }
  const SKIP_TYPES = new Set(['formula', 'rollup', 'linked']);

  // Attachment cell → short text summary (their URLs expire; we don't re-host).
  function summarize(value) {
    if (!Array.isArray(value) || value.length === 0) return value;
    const isAtt = value.every(v => v && typeof v === 'object' && typeof v.url === 'string' && ('filename' in v || 'type' in v));
    if (!isAtt) return value;
    const names = value.map(v => v.filename || v.type || 'file');
    const shown = names.slice(0, 5).join(', ');
    return `${value.length} file${value.length === 1 ? '' : 's'}: ${shown}${names.length > 5 ? ` +${names.length - 5} more` : ''}`;
  }

  // Deterministic, content-addressed anchor per Airtable record. Pure function
  // of (tableName, recordId): re-deriving it on a later change finds the same
  // entity, so updates land as DEF on the row a create already made — no map to
  // store, idempotent under replay.
  function anchorFor(tableName, recordId) {
    return window.MatrixEngine.makeAnchor(tableName, { __at: recordId }, '@' + ORIGIN, 0);
  }

  // ── Apply one record's cells (id-keyed) onto an entity, as DEFs ────────────
  function applyCells(ctx, tableName, anchor, cellsByFieldId) {
    const fnById = ctx.maps.fieldNameById.get(ctx.tableIdOf(tableName));
    for (const fid of Object.keys(cellsByFieldId || {})) {
      const name = fnById ? fnById.get(fid) : null;
      if (!name) continue;                              // unknown/new field → next sweep
      const type = fieldType(ctx.state(), tableName, name);
      if (type && SKIP_TYPES.has(type)) continue;       // computed derive; linked deferred
      let value = summarize(cellsByFieldId[fid]);
      if (value === undefined) value = null;
      ctx.emit(window.MatrixEngine.OP.DEF, { anchor, path: name, value });
      ctx.changes++;
    }
  }

  // Create (or copy-on-write promote) a record as a first-class entity that
  // shadows its blob row by _recordId. `seed` is a NAME-keyed field object
  // (from the create payload or a fetched full record); `_origin`/`_recordId`
  // go in the INS payload so the entity carries them.
  function instantiate(ctx, tableName, recordId, seedByName) {
    const anchor = anchorFor(tableName, recordId);
    const payload = { _recordId: recordId, _origin: ORIGIN };
    for (const name of Object.keys(seedByName || {})) {
      const type = fieldType(ctx.state(), tableName, name);
      if (type && SKIP_TYPES.has(type)) continue;
      const v = summarize(seedByName[name]);
      if (v !== undefined && v !== null && v !== '') payload[name] = v;
    }
    ctx.emit(window.MatrixEngine.OP.INS, { anchor, entity_type: tableName, payload });
    ctx.justInstantiated.add(anchor);
    ctx.changes++;
    return anchor;
  }

  // Does a first-class entity for this record already exist in the fold?
  function existsFolded(ctx, anchor) {
    return ctx.justInstantiated.has(anchor) || !!ctx.state().entities?.[anchor];
  }

  // ── Translate one payload's record changes into operators ──────────────────
  async function applyPayload(ctx, payload) {
    const tables = payload.changedTablesById || {};
    for (const tableId of Object.keys(tables)) {
      const tableName = ctx.maps.tableNameById.get(tableId) || ctx.watch.get(tableId);
      if (!tableName || !ctx.watchNames.has(tableName)) continue; // not a watched table
      const t = tables[tableId];

      // Created records: the payload carries their full cell set.
      const created = t.createdRecordsById || {};
      for (const rid of Object.keys(created)) {
        const cells = created[rid].cellValuesByFieldId || {};
        instantiate(ctx, tableName, rid, namesFromIds(ctx, tableId, cells));
      }

      // Changed records: DEF the changed cells. If the record isn't a folded
      // entity yet (it lives only in the blob), promote it copy-on-write: fetch
      // the full row once and INS it whole, so unchanged columns survive.
      const changed = t.changedRecordsById || {};
      for (const rid of Object.keys(changed)) {
        const anchor = anchorFor(tableName, rid);
        const cur = changed[rid].current?.cellValuesByFieldId || {};
        if (existsFolded(ctx, anchor)) {
          applyCells(ctx, tableName, anchor, cur);
        } else {
          let full = null;
          try { full = await fetchRecord(ctx.token, ctx.baseId, tableId, rid); }
          catch (e) { ctx.log(`sync: could not fetch ${rid} for promote: ${e.message}`); }
          const seed = full?.fields || namesFromIds(ctx, tableId, cur);
          instantiate(ctx, tableName, rid, seed);
        }
      }

      // Destroyed records: tombstone. Promote a stub first if the row was
      // blob-only, so renderState can shadow + hide it by _recordId.
      const destroyed = t.destroyedRecordIds || [];
      for (const rid of destroyed) {
        const anchor = anchorFor(tableName, rid);
        if (!existsFolded(ctx, anchor)) instantiate(ctx, tableName, rid, {});
        ctx.emit(window.MatrixEngine.OP.SEG, { anchor, partition: DELETED_PARTITION });
        ctx.changes++;
      }
    }
  }

  // id-keyed cells → name-keyed object (computed/linked dropped downstream).
  function namesFromIds(ctx, tableId, cellsByFieldId) {
    const fnById = ctx.maps.fieldNameById.get(tableId);
    const out = {};
    if (!fnById) return out;
    for (const fid of Object.keys(cellsByFieldId || {})) {
      const name = fnById.get(fid);
      if (name) out[name] = cellsByFieldId[fid];
    }
    return out;
  }

  // ── Engine ─────────────────────────────────────────────────────────────--
  let RUN = null; // single active run

  async function start(opts) {
    const { roomId, baseId, token, getState, emit, log = () => {} } = opts || {};
    if (!roomId || !baseId || !token || typeof getState !== 'function' || typeof emit !== 'function') {
      throw new Error('start needs { roomId, baseId, token, getState, emit }');
    }
    if (!window.MatrixEngine || !window.AirtableAPI) {
      throw new Error('engine.js and airtable-import.jsx must load before airtable-sync.js');
    }
    stop();

    const deviceId = 's' + Math.random().toString(36).slice(2, 9);
    const run = {
      roomId, baseId, token, getState, emit, log, deviceId,
      timer: null, busy: false, stopped: false,
      lastSync: 0, lastError: null, cursor: 0, webhookId: null,
    };
    RUN = run;

    // Resolve the watch set + schema maps once.
    const state0 = getState();
    const watch = watchedTables(state0, baseId);
    if (watch.size === 0) {
      RUN = null;
      throw new Error(`no Airtable import found for base ${baseId} — import it once before enabling sync`);
    }
    let parsed;
    try {
      const schemaJson = await window.AirtableAPI.fetchBaseSchema(token, baseId);
      parsed = window.AirtableSchema.parse(schemaJson);
      // field-id → name per table
      const maps = buildMaps(parsed);
      for (const t of schemaJson.tables || []) {
        const m = new Map();
        for (const f of (t.fields || [])) if (f.id && f.name) m.set(f.id, f.name);
        maps.fieldNameById.set(t.id, m);
      }
      run.maps = maps;
      run.parsed = parsed;
    } catch (e) {
      RUN = null;
      throw new Error('could not read base schema: ' + e.message);
    }
    run.watch = watch;
    run.watchNames = new Set(watch.values());
    run.tableIdByName = invert(watch); // name → id (for fetchRecord/scope)

    // Ensure a live webhook + a cursor.
    await ensureWebhook(run);

    // Kick the loop.
    run.timer = setInterval(() => tick(run), POLL_INTERVAL_MS);
    tick(run); // run one immediately
    log(`sync: watching ${watch.size} table(s) of ${baseId}`);
    return status();
  }

  function stop() {
    if (RUN?.timer) clearInterval(RUN.timer);
    if (RUN) RUN.stopped = true;
    RUN = null;
  }

  function status() {
    if (!RUN) return { running: false };
    return {
      running: true, baseId: RUN.baseId, webhookId: RUN.webhookId,
      cursor: RUN.cursor, lastSync: RUN.lastSync, lastError: RUN.lastError,
      watching: RUN.watch ? [...RUN.watch.values()] : [],
    };
  }

  async function ensureWebhook(run) {
    const st = readSyncState(run.getState(), run.baseId);
    const tableIds = [...run.watch.keys()];
    if (st?.webhookId) {
      run.webhookId = st.webhookId;
      run.cursor = st.cursor || 0;
      try {
        // GUARDS 1 & 3 (silent-expiry): don't trust the cached expiresAt — ask
        // the hook for its real state. A hook that's gone, disabled, or with
        // notifications off has stopped generating payloads: that's a dead
        // stream, so sweep rather than resume past a head we can no longer see.
        const hook = await getWebhook(run.token, run.baseId, run.webhookId);
        if (!hook) {
          run.log('sync: webhook missing/expired — recreating + full sweep');
          await recreateAndSweep(run);
          return;
        }
        if (!hook.isHookEnabled || !hook.areNotificationsEnabled) {
          run.log('sync: webhook disabled (payload generation stopped) — recreating + full sweep');
          await recreateAndSweep(run);
          return;
        }
        // Refresh against the hook's REAL expiry, not the cached value.
        let expiresAt = hook.expiresAt;
        if (!expiresAt || (expiresAt - Date.now()) < REFRESH_BEFORE_MS) {
          expiresAt = await refreshWebhook(run.token, run.baseId, run.webhookId);
        }
        writeSyncState(run.emit, run.getState(), run.baseId, { expiresAt });
        return;
      } catch (e) {
        if (e.status === 404) { run.log('sync: webhook expired/gone — recreating + full sweep'); }
        else { run.log('sync: webhook check failed (' + e.message + ') — recreating'); }
        await recreateAndSweep(run);
        return;
      }
    }
    // First time for this base: blob already exists from the import, so just
    // arm the webhook at "now" — no immediate sweep.
    const wh = await createWebhook(run.token, run.baseId, tableIds);
    run.webhookId = wh.id;
    run.cursor = 0;
    writeSyncState(run.emit, run.getState(), run.baseId, {
      webhookId: wh.id, expiresAt: wh.expiresAt, cursor: 0, lastSweep: Date.now(),
    });
  }

  async function tick(run) {
    if (run.stopped || run.busy) return;
    // Soft lease: only the holder (or anyone, if the lease is stale) polls.
    const st = readSyncState(run.getState(), run.baseId);
    const lease = st?.runner;
    const mine = lease?.id === run.deviceId;
    const stale = !lease || (Date.now() - (lease.ts || 0)) > LEASE_STALE_MS;
    if (!mine && !stale) return;
    run.busy = true;
    try {
      writeSyncState(run.emit, run.getState(), run.baseId, { runner: { id: run.deviceId, ts: Date.now() } });
      await catchUp(run);
      run.lastError = null;
    } catch (e) {
      run.lastError = e.message;
      run.log('sync error: ' + e.message);
    } finally {
      run.busy = false;
    }
  }

  // Drain payloads from the stored cursor. Within budget, translate them. Over
  // budget (or on an invalid cursor), abandon the diff and full-sweep instead.
  async function catchUp(run) {
    // GUARD 2 (silent-expiry): payloads retain 7 days. If the last good sync OR
    // sweep is older than the retention window, the cursor may resolve yet point
    // PAST a head that already expired — we'd resume mid-stream and silently
    // drop the gap. Re-snapshot instead of trusting it.
    const stRet = readSyncState(run.getState(), run.baseId);
    const lastGood = Math.max(stRet?.lastSync || 0, stRet?.lastSweep || 0);
    if (lastGood && (Date.now() - lastGood) > RETENTION_SWEEP_MS) {
      run.log('sync: last good sync > 6d ago — payloads may have expired, full sweep');
      await recreateAndSweep(run);
      return;
    }

    const ctx = makeCtx(run);
    let cursor = run.cursor || undefined;
    let pages = 0;

    while (true) {
      let res;
      try {
        res = await listPayloads(run.token, run.baseId, run.webhookId, cursor);
      } catch (e) {
        // Cursor too old / webhook gone → re-snapshot from scratch.
        run.log('sync: payload fetch failed (' + e.message + ') — full sweep');
        await recreateAndSweep(run);
        return;
      }
      const payloads = res.payloads || [];
      for (const p of payloads) await applyPayload(ctx, p);
      pages++;
      cursor = res.cursor;

      // Persist the cursor as we go, so an interrupted catch-up resumes cleanly.
      run.cursor = cursor;
      writeSyncState(run.emit, run.getState(), run.baseId, { cursor });

      if (!res.mightHaveMore) break;
      if (pages >= MAX_PAGES_PER_CYCLE || ctx.changes >= MAX_CHANGES_BEFORE_SWEEP) {
        run.log(`sync: backlog too large (${ctx.changes} changes, mightHaveMore) — full sweep`);
        await recreateAndSweep(run);
        return;
      }
    }

    run.lastSync = Date.now();
    if (ctx.changes > 0) {
      run.log(`sync: applied ${ctx.changes} change(s)`);
    }
    // Stamp lastSync even on a no-op cycle: it's what the retention guard reads
    // to know the stream is still healthy and the cursor still trustworthy.
    writeSyncState(run.emit, run.getState(), run.baseId, { lastSync: run.lastSync });
  }

  // ── Full sweep ─────────────────────────────────────────────────────────--
  // Re-snapshot every watched table through the existing chunked importer (new
  // import_seq supersedes the prior blob generation), then recreate the webhook
  // so its cursor restarts at "now". The delta entities from before remain in
  // the log but are harmless: they carry the same _recordId as the fresh blob
  // rows, so renderState still shadows by record — converging, not duplicating.
  async function recreateAndSweep(run) {
    if (!window.AirtableAPI.importTableChunked) {
      throw new Error('importTableChunked not exposed — apply the airtable-import.jsx patch');
    }
    run.log('sync: full sweep — re-importing watched tables');
    const state = run.getState();
    const byName = new Map((run.parsed.tables || []).map(t => [t.name, t]));
    for (const setName of run.watch.values()) {
      const table = byName.get(setName);
      if (!table) { run.log(`sweep: ${setName} not in current schema, skipped`); continue; }
      try {
        await window.AirtableAPI.importTableChunked({
          token: run.token, baseId: run.baseId, table, roomId: run.roomId, state,
          onProgress: (n) => run.log(`sweep ${setName}: ${n} rows`),
        });
      } catch (e) {
        run.log(`sweep ${setName} failed: ${e.message}`);
      }
    }
    // Fresh webhook → cursor restarts at now. Old one is best-effort deleted.
    const old = run.webhookId;
    const wh = await createWebhook(run.token, run.baseId, [...run.watch.keys()]);
    run.webhookId = wh.id;
    run.cursor = 0;
    run.lastSync = Date.now();
    writeSyncState(run.emit, run.getState(), run.baseId, {
      webhookId: wh.id, expiresAt: wh.expiresAt, cursor: 0,
      lastSweep: Date.now(), lastSync: run.lastSync,
    });
    if (old && old !== wh.id) deleteWebhook(run.token, run.baseId, old);
    run.log('sync: sweep complete, webhook re-armed');
  }

  async function sweepNow() {
    if (!RUN) throw new Error('sync not running');
    await recreateAndSweep(RUN);
    return status();
  }

  // ── Single-table manual refresh ──────────────────────────────────────────-
  // Re-snapshot ONE watched table through the chunked importer (a new import_seq
  // supersedes that table's prior blob generation — no duplicates) and leave the
  // webhook + cursor UNTOUCHED, so the diff stream for every OTHER watched table
  // keeps flowing. Pending diffs for this table replay idempotently onto the
  // fresh blob (deterministic anchors + last-write-wins DEF), so they converge
  // rather than duplicate. This is the per-table analogue of recreateAndSweep —
  // it deliberately does NOT recreate the webhook (that would reset the cursor to
  // "now" and silently drop pending changes for the tables we didn't sweep).
  async function sweepOneTable(run, setName) {
    if (!window.AirtableAPI.importTableChunked) {
      throw new Error('importTableChunked not exposed — apply the airtable-import.jsx patch');
    }
    const byName = new Map((run.parsed.tables || []).map(t => [t.name, t]));
    const table = byName.get(setName);
    if (!table) throw new Error(`"${setName}" is not in the base's current schema`);
    run.log(`sync: manual re-import of ${setName}`);
    const res = await window.AirtableAPI.importTableChunked({
      token: run.token, baseId: run.baseId, table, roomId: run.roomId,
      state: run.getState(),
      onProgress: (n) => run.log(`re-import ${setName}: ${n} rows`),
    });
    run.log(`sync: ${setName} re-imported (${res?.rows ?? 0} row(s))`);
    return res;
  }

  async function sweepTable(setName) {
    if (!RUN) throw new Error('sync not running');
    if (!setName) throw new Error('sweepTable needs a table name');
    if (!RUN.watchNames.has(setName)) throw new Error(`"${setName}" is not a watched table`);
    await sweepOneTable(RUN, setName);
    return status();
  }

  // Per-cycle context handed to the translators.
  function makeCtx(run) {
    return {
      token: run.token, baseId: run.baseId, maps: run.maps,
      watch: run.watch, watchNames: run.watchNames,
      state: () => run.getState(),
      emit: run.emit, log: run.log,
      tableIdOf: (name) => run.tableIdByName.get(name),
      justInstantiated: new Set(),
      changes: 0,
    };
  }

  function invert(map) {
    const out = new Map();
    for (const [k, v] of map.entries()) out.set(v, k);
    return out;
  }

  window.AirtableSync = { start, stop, sweepNow, sweepTable, status, anchorFor, ORIGIN, DELETED_PARTITION };
})();
