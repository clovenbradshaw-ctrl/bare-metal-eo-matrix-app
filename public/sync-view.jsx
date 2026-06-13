/* sync-view.jsx — "Sync & storage" page.
 *
 * The transparency surface the rest of the app was missing: for the open
 * workspace it answers three questions concretely —
 *
 *   1. How many records should each table have, and how many are actually
 *      downloaded to THIS device right now?  (the tables section)
 *   2. Is the local copy preserved across a refresh / tab close, or can the
 *      browser evict it?  (the device section — persistent storage + OPFS)
 *   3. Is the durable system of record (the encrypted media-store block chain)
 *      in sync, and is anything still queued / unsent?  (the workspace section)
 *
 * It reads folded/materialized record counts from props (app.jsx is the only
 * place that knows what's been reconstructed from import blobs) and pulls the
 * infrastructure status — storage estimate, block-chain stats, outbox, network
 * — live from window.MatrixLive. Controls let the user pin storage against
 * eviction, re-pull every workspace from durable storage, and force a single
 * room's block-chain resync.
 */

(function () {
const { useState, useEffect, useCallback, useRef } = React;

function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtNum(n) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString();
}

function pct(part, whole) {
  if (!whole || whole <= 0) return part > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

function relTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 0 || diff < 5000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// A labelled meter row: label · counts · a fill bar. `tone` colours the fill.
function Meter({ label, sub, part, whole, tone = 'ok', right }) {
  const p = pct(part, whole);
  return (
    <div className="sync-meter">
      <div className="sync-meter-top">
        <span className="sync-meter-label">{label}</span>
        {right != null && <span className="sync-meter-right">{right}</span>}
      </div>
      <div className="sync-meter-bar">
        <span className={`sync-meter-fill tone-${tone}`} style={{ width: `${p}%` }} />
      </div>
      {sub && <div className="sync-meter-sub">{sub}</div>}
    </div>
  );
}

// One key/value stat tile.
function Stat({ label, value, tone, hint }) {
  return (
    <div className={`sync-stat ${tone ? `tone-${tone}` : ''}`} title={hint || ''}>
      <div className="sync-stat-value">{value}</div>
      <div className="sync-stat-label">{label}</div>
    </div>
  );
}

function StatusDot({ tone, label }) {
  return (
    <span className={`sync-status-pill tone-${tone}`}>
      <span className="sync-status-dot" />
      {label}
    </span>
  );
}

function SyncView({
  room, isLive, session, tables = [],
  committedCount = 0, pendingPart = 0, eventsTotal = 0, scrubber,
  onRefreshTables, reclaimableMedia = [], onReclaimMedia,
}) {
  const ML = (typeof window !== 'undefined' && window.MatrixLive) || null;
  const live = isLive && !!ML;
  const roomId = room?.id || null;
  const stale = !!session?.stale;

  const [storage, setStorage] = useState(null);
  const [block, setBlock] = useState(null);
  const [sync, setSync] = useState(null);
  const [net, setNet] = useState(null);
  const [syncState, setSyncState] = useState(null);
  const [outbox, setOutbox] = useState(0);
  const [hasIdentity, setHasIdentity] = useState(true);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(null);     // 'persist' | 'resync' | 'block' | 'reclaim' | null
  const [lastRefreshed, setLastRefreshed] = useState(0);
  const [reclaimed, setReclaimed] = useState(null);   // { removed, bytes } after a reclaim
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!live) return;
    try {
      const [storageStatus] = await Promise.all([
        ML.getStorageStatus ? ML.getStorageStatus() : Promise.resolve(null),
      ]);
      if (!mounted.current) return;
      setStorage(storageStatus);
      setBlock(roomId && ML.getBlockStats ? ML.getBlockStats(roomId) : null);
      setSync(ML.getSyncStatus ? ML.getSyncStatus() : null);
      setNet(ML.getNetwork ? ML.getNetwork() : null);
      setSyncState(ML.getSyncState ? ML.getSyncState() : null);
      setOutbox(ML.getPendingCount ? ML.getPendingCount() : 0);
      setHasIdentity(ML.hasEnvelopeIdentity ? ML.hasEnvelopeIdentity() : true);
      setLog(ML.getProgressLog ? ML.getProgressLog().slice(-8).reverse() : []);
      setLastRefreshed(Date.now());
    } catch (e) {
      console.warn('[sync-view] refresh failed:', e);
    }
  }, [live, ML, roomId]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    if (!live) return () => { mounted.current = false; };
    const unsub = ML.subscribe ? ML.subscribe((reason) => {
      if (['sync', 'events', 'rooms', 'network', 'outbox', 'pending', 'log', 'session'].includes(reason)) {
        refresh();
      }
    }) : null;
    const iv = setInterval(refresh, 5000);   // storage estimate isn't event-driven
    return () => { mounted.current = false; clearInterval(iv); if (unsub) unsub(); };
  }, [refresh, live, ML]);

  async function onPersist() {
    if (!ML?.requestPersistentStorage) return;
    setBusy('persist');
    try { await ML.requestPersistentStorage(); await refresh(); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function onResync() {
    if (!ML?.resync) return;
    setBusy('resync');
    try { await ML.resync(); await refresh(); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function onForceBlock() {
    if (!ML?.forceBlockSync || !roomId) return;
    setBusy('block');
    try { await ML.forceBlockSync(roomId); await refresh(); }
    catch (e) { console.warn('[sync-view] force block sync failed:', e); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function onReclaim() {
    if (!onReclaimMedia || !reclaimableMedia.length) return;
    setBusy('reclaim');
    try {
      const r = await onReclaimMedia();
      if (mounted.current && r) setReclaimed(r);
      await refresh();
    } catch (e) { console.warn('[sync-view] reclaim failed:', e); }
    finally { if (mounted.current) setBusy(null); }
  }

  // ── derived status ──
  const syncing = sync?.phase === 'syncing';
  const online = net === 'online';
  const prepared = syncState === 'PREPARED' || syncState === 'SYNCING';

  const totalExpected = tables.reduce((s, t) => s + (t.expected || 0), 0);
  const totalLocal = tables.reduce((s, t) => s + (t.localRows || 0), 0);
  const anyIncomplete = tables.some(t => t.expected > t.localRows);

  // ── storage breakdown (origin buckets) ──
  // OPFS is just this app's own cache; the encryption store (IndexedDB) and the
  // app shell (Cache Storage) are usually the larger, otherwise-invisible
  // buckets — the answer to "why is the origin so much bigger than 'cache used'".
  const ud = storage?.usageDetails || null;
  const idbBytes = ud && typeof ud.indexedDB === 'number' ? ud.indexedDB : null;
  const cacheBytes = storage?.caches?.bytes != null
    ? storage.caches.bytes
    : (ud && typeof ud.caches === 'number' ? ud.caches : null);
  const opfsBytes = storage?.opfs?.totalBytes ?? null;
  const estimateOk = storage?.estimateReliable !== false;
  const measuredBytes = storage?.measuredBytes || 0;
  // The crypto store carries every megolm session + device key for the WHOLE
  // account, so it usually dominates and is the surprise in "why so large".
  const idbDominates = idbBytes != null &&
    idbBytes > (opfsBytes || 0) && idbBytes > (cacheBytes || 0);

  return (
    <div className="table-view sync-view">
      {scrubber}
      <div className="sync-scroll">
      <div className="page-hero">
        <div className="page-hero-eyebrow">
          <span className="page-hero-kind"><span className="page-hero-glyph">⟲</span> sync</span>
          <span className="page-hero-sep">/</span>
          <span className="page-hero-crumb">{room?.title || 'workspace'}</span>
        </div>
        <div className="page-hero-title">Sync &amp; storage</div>
        <div className="page-hero-sub">
          What this workspace <em>should</em> hold, what's actually downloaded to this
          device, and whether it survives a refresh. History lives in three places:
          the live encrypted timeline, this device's local cache (OPFS), and the durable
          encrypted block chain on the homeserver — the copy that always comes back.
        </div>
      </div>

      {!live && (
        <div className="page-section">
          <div className="sync-note">
            <b>Demo mode.</b> You're not signed in to a homeserver, so there's no
            device cache or durable storage to report. Demo spaces are kept in this
            browser's <code>localStorage</code> and are cleared with the “Clear all”
            tweak. Sign in with a Matrix account to get real sync &amp; storage.
          </div>
          {tables.length > 0 && (
            <div className="sync-tables">
              {tables.map(t => (
                <div className="sync-table-row" key={t.name}>
                  <div className="sync-table-name">{t.name}</div>
                  <div className="sync-table-counts">{fmtNum(t.localRows)} records</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {live && (
        <>
          {/* ── This device ── */}
          <div className="page-section">
            <div className="page-section-head">
              <span className="page-section-label">This device</span>
              <span className="page-section-sub">local cache · persistence</span>
            </div>

            <div className="sync-persist">
              {storage?.persisted ? (
                <StatusDot tone="ok" label="Persistent storage granted" />
              ) : storage?.persistSupported ? (
                <StatusDot tone="warn" label="Storage is evictable" />
              ) : (
                <StatusDot tone="muted" label="Persistence not supported here" />
              )}
              <span className="sync-persist-text">
                {storage?.persisted
                  ? 'The browser has promised to keep this workspace on the device across refreshes and tab closes (until you clear site data).'
                  : storage?.persistSupported
                    ? 'The browser may evict the local cache under storage pressure. Your data still comes back from the durable block chain — but as a re-download. Pin it to keep it local.'
                    : 'This browser can’t guarantee local storage. The durable block chain remains the safety net.'}
              </span>
              {!storage?.persisted && storage?.persistSupported && (
                <button className="sync-btn primary" onClick={onPersist} disabled={busy === 'persist'}>
                  {busy === 'persist' ? 'requesting…' : 'Keep data on this device'}
                </button>
              )}
            </div>

            <div className="sync-stats">
              <Stat label="cache used" value={fmtBytes(opfsBytes)} hint="total bytes this app holds in OPFS (event logs + dataset blobs)" />
              <Stat label="event logs" value={fmtBytes(storage?.opfs?.room?.bytes)} hint={`${fmtNum(storage?.opfs?.room?.files || 0)} room file(s)`} />
              <Stat label="dataset blobs" value={fmtBytes(storage?.opfs?.media?.bytes)} hint={`${fmtNum(storage?.opfs?.media?.files || 0)} cached media blob(s) — imported rows live here`} />
              <Stat
                label="origin total"
                value={estimateOk && storage?.usage != null ? fmtBytes(storage.usage) : fmtBytes(measuredBytes)}
                tone={estimateOk ? undefined : 'warn'}
                hint={estimateOk
                  ? 'browser-reported usage across this whole origin'
                  : 'browser estimate looks fuzzed — showing the bytes this app measured directly'}
              />
            </div>

            {/* Where the origin's bytes actually sit. The 'cache used' tile is
                only this app's OPFS; these are the bigger, invisible buckets. */}
            {(idbBytes != null || cacheBytes != null) && (
              <div className="sync-substats">
                <span>workspace cache (OPFS): <b>{fmtBytes(opfsBytes)}</b></span>
                {idbBytes != null && <span>encryption + queues (IndexedDB): <b>{fmtBytes(idbBytes)}</b></span>}
                {cacheBytes != null && <span>app shell (Cache): <b>{fmtBytes(cacheBytes)}</b></span>}
              </div>
            )}

            {estimateOk && storage?.quota ? (
              <Meter label="origin storage" part={storage.usage || 0} whole={storage.quota}
                tone="neutral" right={`${pct(storage.usage, storage.quota)}%`} />
            ) : null}

            {!estimateOk && (
              <div className="sync-note muted">
                This browser reports <b>{fmtBytes(storage?.usage)}</b> used against a{' '}
                <b>{fmtBytes(storage?.quota)}</b> quota — usage above quota is impossible, so
                the figure is being fuzzed for fingerprint resistance (Brave and Tor do this).
                The bytes above are what this app actually measured on disk.
              </div>
            )}

            {idbDominates && (
              <div className="sync-note muted">
                Most of the origin is the <b>Matrix encryption store</b> — every megolm
                session and device key for your <em>whole</em> account, not just this
                workspace. It rebuilds from the homeserver, so signing out and back in
                (or “Clear all” in tweaks) reclaims it; this workspace’s history still
                comes back from the durable chain.
              </div>
            )}

            {reclaimableMedia.length > 0 && (
              <div className="sync-actions">
                {/* The superseded import *entities* stay in the log after a
                    reclaim (only their mirrored blobs are deleted), so gate the
                    button on the result — a second click would free nothing. */}
                {reclaimed ? (
                  <span className="sync-actions-meta">
                    reclaimed {fmtBytes(reclaimed.bytes)} from {fmtNum(reclaimed.removed)} stale import blob{reclaimed.removed === 1 ? '' : 's'}
                  </span>
                ) : (
                  <button className="sync-btn" onClick={onReclaim} disabled={busy === 'reclaim'}
                    title="delete the mirrored source blobs of import generations that a later re-sync superseded — they re-download if ever needed">
                    {busy === 'reclaim'
                      ? 'reclaiming…'
                      : `Reclaim ${fmtNum(reclaimableMedia.length)} stale import blob${reclaimableMedia.length === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── This workspace ── */}
          <div className="page-section">
            <div className="page-section-head">
              <span className="page-section-label">This workspace</span>
              <span className="page-section-sub">live sync · durable storage · outbox</span>
            </div>

            <div className="sync-pills">
              <StatusDot tone={online ? 'ok' : 'warn'} label={online ? 'online' : (net || 'offline')} />
              <StatusDot tone={prepared ? 'ok' : 'muted'} label={`server sync: ${syncState || (stale ? 'local-only' : '…')}`} />
              {block && (
                <StatusDot
                  tone={block.enabled ? 'ok' : 'warn'}
                  label={block.enabled ? 'durable chain active' : 'durable chain dormant'}
                />
              )}
              {outbox > 0
                ? <StatusDot tone="warn" label={`${fmtNum(outbox)} unsent edit${outbox === 1 ? '' : 's'}`} />
                : <StatusDot tone="ok" label="all edits sent" />}
              {syncing && <StatusDot tone="busy" label="restoring from durable storage…" />}
            </div>

            <div className="sync-stats">
              <Stat label="events downloaded" value={fmtNum(committedCount)} hint="committed op-events cached locally for this room" />
              <Stat label="pending (optimistic)" value={fmtNum(pendingPart)} tone={pendingPart > 0 ? 'warn' : null} hint="edits you've made that aren't server-acked yet" />
              <Stat label="chain head" value={block?.headIdx != null ? `#${block.headIdx}` : '—'} hint="index of your latest durable block in the homeserver media store" />
              <Stat label="recovered" value={fmtNum(block?.recovered ?? sync?.recovered ?? 0)} hint="events pulled back from the durable chain this session" />
            </div>

            {block && (
              <div className="sync-substats">
                <span>chained: <b>{fmtNum(block.chainedEvents)}</b></span>
                <span>queued to chain: <b>{fmtNum(block.queued)}</b></span>
                {block.failures > 0 && <span className="warn">failures: <b>{block.failures}</b></span>}
                {!hasIdentity && <span className="warn">no envelope identity — sign in with your password to enable durable storage</span>}
              </div>
            )}

            <div className="sync-actions">
              <button className="sync-btn" onClick={onResync} disabled={busy === 'resync' || syncing || !online}>
                {busy === 'resync' || syncing ? 'syncing…' : 'Re-sync from durable storage'}
              </button>
              <button className="sync-btn" onClick={onForceBlock} disabled={busy === 'block' || !online || !block}
                title="re-read this room's block chain from the homeserver and back-fill anything missing">
                {busy === 'block' ? 'resyncing…' : 'Force chain resync (this room)'}
              </button>
              <span className="sync-actions-meta">
                {lastRefreshed ? `updated ${relTime(lastRefreshed)}` : ''}
              </span>
            </div>
          </div>

          {/* ── Tables ── */}
          <div className="page-section">
            <div className="page-section-head">
              <span className="page-section-label">Tables · records on this device</span>
              <span className="page-section-sub">
                {totalExpected > totalLocal
                  ? `${fmtNum(totalLocal)} of ${fmtNum(totalExpected)} records downloaded — the rest stream in automatically`
                  : `${fmtNum(totalLocal)} records`}
                {onRefreshTables && totalExpected > totalLocal && (
                  <button className="sync-link" onClick={onRefreshTables} title="restart the download retry loop now"> · retry now</button>
                )}
              </span>
            </div>

            {tables.length === 0 && (
              <div className="sync-note muted">No tables in this workspace yet.</div>
            )}

            <div className="sync-tables">
              {tables.map(t => {
                const expected = t.isImport ? Math.max(t.expected || 0, t.localRows) : t.localRows;
                const complete = !t.isImport || (t.localRows >= expected && t.chunksReady >= t.chunksTotal);
                const tone = complete ? 'ok' : (online || syncing ? 'busy' : 'warn');
                const statusLabel = !t.isImport
                  ? 'local'
                  : complete
                    ? 'complete'
                    : (t.chunksTotal > 1
                        ? `downloading · ${t.chunksReady}/${t.chunksTotal} chunks`
                        : 'downloading…');
                const sub = t.isImport
                  ? (complete
                      ? `all ${fmtNum(expected)} imported rows reconstructed locally`
                      : `${fmtNum(t.localRows)} of ${fmtNum(expected)} imported rows materialized — the rest stream from the cached source blob`)
                  : `${fmtNum(t.localRows)} record${t.localRows === 1 ? '' : 's'}, derived from this workspace’s event log`;
                return (
                  <div className="sync-table-card" key={t.name}>
                    <div className="sync-table-card-head">
                      <span className="sync-table-name">
                        {t.name}
                        {!t.declared && <span className="sync-table-flag" title="observed, not in declared schema">?</span>}
                        {t.isImport && <span className="sync-table-tag">imported</span>}
                      </span>
                      <StatusDot tone={tone} label={statusLabel} />
                    </div>
                    <Meter
                      label={`${fmtNum(t.localRows)} / ${fmtNum(expected)} records`}
                      sub={sub}
                      part={t.localRows}
                      whole={expected}
                      tone={tone}
                      right={`${pct(t.localRows, expected)}%`}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Recent activity ── */}
          {log.length > 0 && (
            <div className="page-section">
              <div className="page-section-head">
                <span className="page-section-label">Recent sync activity</span>
              </div>
              <div className="sync-log">
                {log.map((l, i) => (
                  <div className="sync-log-row" key={i}>
                    <span className="sync-log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
                    <span className="sync-log-msg">{l.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}

window.SyncView = React.memo(SyncView);

})();
