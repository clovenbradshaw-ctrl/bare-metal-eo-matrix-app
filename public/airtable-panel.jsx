/* airtable-panel.jsx — the Airtable two-way-sync surface on the Sync page.
 *
 * Reads live state from window.AirtableCoord (attached by app.jsx for the open
 * room) and window.MatrixLive. It does NOT own the sync lifecycle — it only:
 *   - shows / shares / revokes the WCK-sealed PAT (one member's token enables
 *     the whole room; the homeserver never sees it);
 *   - lets a member RAISE / LOWER their hand to take a turn pulling FROM
 *     Airtable, and shows the turn queue + who's actively syncing;
 *   - reports that local changes push TO Airtable automatically.
 *
 * Mounted by sync-view.jsx:  <window.AirtableSyncPanel room state session />
 */

(function () {
  const { useState, useEffect, useCallback, useRef } = React;

  function relTime(ts) {
    if (!ts) return null;
    const d = Date.now() - ts;
    if (d < 5000) return 'just now';
    if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  }
  function shortId(userId) {
    if (!userId) return '?';
    return userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  }

  function AirtableSyncPanel({ room, session }) {
    const ML = (typeof window !== 'undefined' && window.MatrixLive) || null;
    const Coord = (typeof window !== 'undefined' && window.AirtableCoord) || null;
    const roomId = room?.id || null;
    const live = !!session && !session.demo && !!ML;

    const [, setTick] = useState(0);
    const bump = useCallback(() => setTick(t => t + 1), []);
    const [token, setToken] = useState('');
    const [busy, setBusy] = useState('');     // 'share' | 'revoke' | 'sweep' | ''
    const [error, setError] = useState('');
    const mounted = useRef(true);

    // Re-render on coordinator changes, on Matrix 'airtable'/'events' notifies,
    // and on a slow timer (relative times + lease staleness aren't event-driven).
    useEffect(() => {
      mounted.current = true;
      const offCoord = Coord?.onChange ? Coord.onChange(() => mounted.current && bump()) : null;
      const offML = ML?.subscribe ? ML.subscribe((r) => {
        if (mounted.current && ['airtable', 'events', 'members'].includes(r)) bump();
      }) : null;
      const iv = setInterval(() => mounted.current && bump(), 5000);
      return () => { mounted.current = false; if (offCoord) offCoord(); if (offML) offML(); clearInterval(iv); };
    }, [Coord, ML, bump]);

    if (!live) return null;

    const cs = Coord?.status ? Coord.status() : { attached: false };
    const info = ML?.getAirtableTokenInfo ? ML.getAirtableTokenInfo(roomId) : { shared: false };
    const baseId = cs.attached ? cs.baseId : (info.base || null);
    const myId = session?.mxid || cs.userId || null;
    const iSharedIt = info.shared && (info.sharers || []).includes(myId);

    async function onShare() {
      const t = token.trim();
      if (!t || !ML?.shareAirtableToken) return;
      setBusy('share'); setError('');
      try {
        await ML.shareAirtableToken(roomId, t, baseId);
        if (mounted.current) { setToken(''); bump(); }
      } catch (e) { if (mounted.current) setError(e?.message || String(e)); }
      finally { if (mounted.current) setBusy(''); }
    }
    async function onRevoke() {
      if (!ML?.revokeAirtableToken) return;
      setBusy('revoke'); setError('');
      try { await ML.revokeAirtableToken(roomId); if (mounted.current) bump(); }
      catch (e) { if (mounted.current) setError(e?.message || String(e)); }
      finally { if (mounted.current) setBusy(''); }
    }
    async function onSweep() {
      if (!window.AirtableSync?.sweepNow) return;
      setBusy('sweep'); setError('');
      try { await window.AirtableSync.sweepNow(); if (mounted.current) bump(); }
      catch (e) { if (mounted.current) setError(e?.message || String(e)); }
      finally { if (mounted.current) setBusy(''); }
    }

    const pull = cs.pull || { running: false };
    const push = cs.push || { pending: true };
    const elected = cs.elected;

    return (
      <div className="page-section">
        <div className="page-section-head">
          <span className="page-section-label">Airtable two-way sync</span>
          <span className="page-section-sub">
            shared token · push to Airtable · raise a hand to pull from Airtable
          </span>
        </div>

        {/* ── Shared token ── */}
        <div className="sync-persist">
          {info.shared ? (
            <>
              <span className={`sync-status-pill tone-${info.haveToken ? 'ok' : 'warn'}`}>
                <span className="sync-status-dot" />
                {info.haveToken ? 'Token shared & unsealed' : 'Token shared — unsealing…'}
              </span>
              <span className="sync-persist-text">
                Shared by <b>{shortId(info.by)}</b>{info.base ? <> for base <code>{info.base}</code></> : null}
                {info.ts ? <> · {relTime(info.ts)}</> : null}.{' '}
                {info.haveToken
                  ? 'The token is sealed under the workspace key — the homeserver only ever sees the ciphertext, and it never enters the event log.'
                  : "It's encrypted with this workspace's key; it'll unseal on this device once your key syncs."}
              </span>
              {iSharedIt && (
                <button className="sync-btn" onClick={onRevoke} disabled={busy === 'revoke'}>
                  {busy === 'revoke' ? 'revoking…' : 'Revoke my shared token'}
                </button>
              )}
            </>
          ) : (
            <>
              <span className="sync-status-pill tone-muted">
                <span className="sync-status-dot" />
                No Airtable token shared
              </span>
              <span className="sync-persist-text">
                Paste a personal-access token to share it with everyone in this workspace.
                It's sealed with the workspace key before it leaves this tab — the homeserver
                stores only ciphertext, and the token is never written into the event log.
                Needs <span className="kbd">schema.bases:read</span> · <span className="kbd">data.records:read</span> · <span className="kbd">webhook:manage</span>.
              </span>
            </>
          )}
          {(!info.shared || iSharedIt) && (
            <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 8 }}>
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && token.trim() && !busy) onShare(); }}
                placeholder={info.shared ? 'pat… (replace the shared token)' : 'pat… (share with the workspace)'}
                spellCheck={false}
                autoComplete="off"
                style={{
                  flex: 1, boxSizing: 'border-box', fontFamily: 'var(--mono)', fontSize: 12,
                  padding: '8px 10px', background: 'var(--bg-elev, #fff)', color: 'var(--text-bright)',
                  border: '1px solid var(--border, #ddd)', borderRadius: 0,
                }}
              />
              <button className="sync-btn primary" onClick={onShare} disabled={!token.trim() || busy === 'share'}>
                {busy === 'share' ? 'sharing…' : 'Share token'}
              </button>
            </div>
          )}
          {error && <div className="sync-persist-text" style={{ color: 'var(--danger, #c33)' }}>⚠ {error}</div>}
        </div>

        {!cs.attached && (
          <div className="sync-note muted">
            Import an Airtable base into this workspace first — sync follows exactly the
            tables you imported. Once a base is imported, sharing a token here lights up
            two-way sync.
          </div>
        )}

        {cs.attached && (
          <>
            {/* ── Push (TO Airtable) ── */}
            <div className="sync-stats">
              <div className="sync-stat">
                <div className="sync-stat-value" style={{ fontSize: 13 }}>
                  {push.running ? 'active' : push.pending ? 'staged' : 'idle'}
                </div>
                <div className="sync-stat-label">push → Airtable</div>
              </div>
              <div className="sync-stat">
                <div className="sync-stat-value" style={{ fontSize: 13 }}>
                  {pull.running ? (cs.iAmActive ? 'you' : 'a teammate') : (cs.myHandRaised ? 'queued' : 'off')}
                </div>
                <div className="sync-stat-label">pull ← Airtable</div>
              </div>
              <div className="sync-stat">
                <div className="sync-stat-value" style={{ fontSize: 13 }}>{pull.watching?.length || 0}</div>
                <div className="sync-stat-label">tables watched</div>
              </div>
              <div className="sync-stat">
                <div className="sync-stat-value" style={{ fontSize: 13 }}>
                  {pull.lastSync ? relTime(pull.lastSync) : '—'}
                </div>
                <div className="sync-stat-label">last pull</div>
              </div>
            </div>

            <div className="sync-substats">
              <span>
                Your changes sync <b>TO Airtable</b> automatically — everyone pushes their own edits.{' '}
                {push.pending
                  ? <span className="warn">push drain not loaded yet (staged)</span>
                  : push.running ? 'drain active.' : 'idle.'}
              </span>
            </div>

            {/* ── Pull (FROM Airtable) — raise hand ── */}
            <div className="sync-persist" style={{ marginTop: 4 }}>
              <span className={`sync-status-pill tone-${cs.iAmActive ? 'ok' : cs.myHandRaised ? 'busy' : 'muted'}`}>
                <span className="sync-status-dot" />
                {cs.iAmActive ? "You're syncing from Airtable"
                  : cs.myHandRaised ? 'Hand raised — waiting your turn'
                  : 'Hand down'}
              </span>
              <span className="sync-persist-text">
                Pulling FROM Airtable is turn-based so clients don't all replay the same
                changes and race the cursor. Raise your hand to take a turn — exactly one
                member pulls at a time, and the turn passes on automatically if they drop off.
              </span>
              <button
                className={`sync-btn ${cs.myHandRaised ? '' : 'primary'}`}
                onClick={() => { cs.myHandRaised ? Coord.lowerHand() : Coord.raiseHand(); bump(); }}
                disabled={!info.shared && !cs.myHandRaised}
                title={!info.shared ? 'share an Airtable token first' : ''}
              >
                {cs.myHandRaised ? 'Lower hand' : 'Raise hand to pull from Airtable'}
              </button>
              {cs.iAmActive && (
                <button className="sync-btn" onClick={onSweep} disabled={busy === 'sweep'}
                  title="discard the diff stream and re-snapshot every watched table now">
                  {busy === 'sweep' ? 'sweeping…' : 'Force full re-sync now'}
                </button>
              )}
            </div>

            {/* turn queue */}
            {cs.hands && cs.hands.length > 0 && (
              <div className="sync-substats">
                <span>turn queue:</span>
                {cs.hands.map((h, i) => (
                  <span key={h.userId} className={h.active ? 'ok' : ''}>
                    {i + 1}. <b>{h.me ? 'you' : (h.name ? h.name : shortId(h.userId))}</b>
                    {h.active ? ' ◀ syncing' : ''}
                  </span>
                ))}
              </div>
            )}

            {pull.lastError && (
              <div className="sync-note muted" style={{ color: 'var(--danger, #c33)' }}>
                last pull error: {pull.lastError}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  window.AirtableSyncPanel = AirtableSyncPanel;
})();
