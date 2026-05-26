/* workspace-picker.jsx — landing screen between sign-in and the workbench.
 *
 * Mirrors the Airtable "bases" home page: a grid of your existing
 * workspaces (Matrix rooms with our app's room_type), pending invites
 * with an accept button, and a small templates row that includes one
 * pre-made demo workspace plus a blank slot.
 *
 * Picking a card sets currentRoomId in App; template/blank both call
 * onCreate(name, template?) which provisions the room (real Matrix room
 * in live mode, in-memory pseudo-room in demo mode) and seeds the
 * template's schema events into it before entering.
 */

(function () {
const { useState, useRef } = React;

const TEMPLATES = [
  {
    id: 'demo-project',
    name: 'Demo project',
    description: 'tasks with priority and estimate, partitioned backlog → doing → done, plus notes that annotate tasks.',
    sigil: 'D',
    defaultName: 'Demo project',
    async seed(emit) {
      const OP = window.MatrixEngine.OP;
      await emit(OP.DEF, { anchor: null, path: '_schema.tables', value: ['task', 'note'] });
      await emit(OP.DEF, { anchor: null, path: '_schema.fields.task', value: [
        { name: 'title',      type: 'text' },
        { name: 'priority',   type: 'select', options: ['high', 'med', 'low'] },
        { name: 'estimate_h', type: 'number' },
      ]});
      await emit(OP.DEF, { anchor: null, path: '_schema.fields.note', value: [
        { name: 'body', type: 'text' },
      ]});
      await emit(OP.DEF, { anchor: null, path: '_schema.partitions.task',
        value: ['backlog', 'doing', 'done'] });
      await emit(OP.DEF, { anchor: null, path: '_schema.links', value: [
        { from: 'note', to: 'task', rel: 'annotates' },
      ]});
    },
  },
];

function WorkspacePicker({ session, rooms, isLive, onPick, onCreate, onAcceptInvite, onSignOut }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr]   = useState(null);
  const [newName, setNewName] = useState('');
  const nameRef = useRef(null);

  const joined  = rooms.filter(r => r.membership !== 'invite');
  const invites = rooms.filter(r => r.membership === 'invite');

  async function pickTemplate(tpl) {
    setErr(null);
    setBusy('tpl:' + tpl.id);
    try {
      await onCreate(tpl.defaultName, tpl);
    } catch (e) {
      setErr(e?.message || 'create failed');
      setBusy(null);
    }
  }

  async function createBlank() {
    const name = newName.trim();
    if (!name) { nameRef.current?.focus(); return; }
    setErr(null);
    setBusy('blank');
    try {
      await onCreate(name, null);
      setNewName('');
    } catch (e) {
      setErr(e?.message || 'create failed');
      setBusy(null);
    }
  }

  async function accept(roomId) {
    setErr(null);
    setBusy('inv:' + roomId);
    try { await onAcceptInvite(roomId); }
    catch (e) { setErr(e?.message || 'accept failed'); setBusy(null); }
  }

  const userLocal = (session?.mxid || '@?').replace(/^@/, '').split(':')[0];
  const initial   = userLocal.slice(0, 1).toUpperCase();
  const userLabel = session?.demo ? 'demo · @you' : session?.mxid;
  const stale     = !!session?.stale;

  return (
    <div className="wp-shell">
      <div className="wp-topbar">
        <span className="wp-brand">
          <span className="wp-brand-mark">▦</span>matrix-events
          <span className="wp-brand-sub">bare metal</span>
        </span>
        <span className="wp-spacer" />
        <span className="wp-user" title={userLabel}>
          <span className="wp-user-avatar">{initial}</span>
          <span className="wp-user-mxid">
            {userLabel}
            {stale && <span className="wp-user-stale"> · local-only</span>}
          </span>
          <button className="wp-signout" onClick={onSignOut}>sign out</button>
        </span>
      </div>

      <div className="wp-body">
        <div className="wp-hero">
          <h1 className="wp-title">
            welcome{session?.demo ? '' : `, ${userLocal}`}
          </h1>
          <p className="wp-sub">pick a workspace, start from a template, or create a new one.</p>
        </div>

        {invites.length > 0 && (
          <div className="wp-section">
            <div className="wp-section-head">pending invites · {invites.length}</div>
            <div className="wp-grid">
              {invites.map(r => (
                <div key={r.id} className="wp-card wp-invite">
                  <div className="wp-card-sigil" style={{background: 'var(--signal)'}}>?</div>
                  <div className="wp-card-body">
                    <div className="wp-card-name">{r.title || r.name || r.id}</div>
                    <div className="wp-card-meta">
                      invite{r.inviter ? ` · from ${r.inviter}` : ''}
                    </div>
                  </div>
                  <button
                    className="wp-card-action"
                    disabled={busy === 'inv:' + r.id}
                    onClick={() => accept(r.id)}
                  >{busy === 'inv:' + r.id ? 'joining…' : 'accept'}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="wp-section">
          <div className="wp-section-head">your workspaces · {joined.length}</div>
          {joined.length === 0 ? (
            <div className="wp-empty">
              no workspaces yet — start from the demo template below, or create a blank one.
            </div>
          ) : (
            <div className="wp-grid">
              {joined.map(r => {
                const name = r.title || r.name || r.id;
                const sigil = name.replace(/^!/, '').slice(0, 1).toUpperCase() || '·';
                return (
                  <button key={r.id} className="wp-card wp-existing" onClick={() => onPick(r.id)}>
                    <div className="wp-card-sigil">{sigil}</div>
                    <div className="wp-card-body">
                      <div className="wp-card-name">{name}</div>
                      <div className="wp-card-meta">
                        {r.eventCount || 0} events{r.offlineCache ? ' · cached' : ''}
                      </div>
                    </div>
                    <span className="wp-card-arrow">→</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="wp-section">
          <div className="wp-section-head">start from a template</div>
          <div className="wp-grid">
            {TEMPLATES.map(tpl => (
              <button
                key={tpl.id}
                className="wp-card wp-template"
                disabled={busy === 'tpl:' + tpl.id || stale}
                title={stale ? 'reconnect to the homeserver to create workspaces' : ''}
                onClick={() => pickTemplate(tpl)}
              >
                <div className="wp-card-sigil" style={{background: 'var(--triad-significance)'}}>
                  {tpl.sigil}
                </div>
                <div className="wp-card-body">
                  <div className="wp-card-name">{tpl.name}</div>
                  <div className="wp-card-meta">{tpl.description}</div>
                </div>
                <span className="wp-card-arrow">
                  {busy === 'tpl:' + tpl.id ? '…' : '+'}
                </span>
              </button>
            ))}
            <div className="wp-card wp-blank">
              <div className="wp-card-sigil" style={{background: '#000'}}>+</div>
              <div className="wp-card-body">
                <div className="wp-card-name">new blank workspace</div>
                <input
                  ref={nameRef}
                  className="wp-blank-input"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="workspace name"
                  onKeyDown={e => { if (e.key === 'Enter') createBlank(); }}
                  disabled={busy === 'blank' || stale}
                />
              </div>
              <button
                className="wp-card-action"
                disabled={busy === 'blank' || !newName.trim() || stale}
                title={stale ? 'reconnect to the homeserver to create workspaces' : ''}
                onClick={createBlank}
              >{busy === 'blank' ? 'creating…' : 'create'}</button>
            </div>
          </div>
        </div>

        {err && <div className="wp-err">{err}</div>}
      </div>
    </div>
  );
}

window.WorkspacePicker = WorkspacePicker;
window.WorkspaceTemplates = TEMPLATES;

})();
