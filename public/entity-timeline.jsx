/* entity-timeline.jsx — per-entity timeline slice.
 *
 * Shows the event history of a single anchor: every log event that touched it,
 * ordered earliest → latest, on a vertical spine with triad-colored dots.
 * The header carries an entity-picker so you can jump between siblings of the
 * same type without going back to the grid.
 */

(function () {
const { useState, useMemo } = React;

function eventTouchesAnchor(event, anchor) {
  const c = event.content || {};
  if (c.anchor === anchor) return true;
  if (c.source_anchor === anchor || c.target_anchor === anchor) return true;
  if (Array.isArray(c.input_anchors) && c.input_anchors.includes(anchor)) return true;
  return false;
}

function eventSummary(event) {
  const op = window.MatrixEngine.parseEventType(event.type);
  if (!op) return { key: '?', triad: 'existence', body: JSON.stringify(event.content).slice(0, 120) };
  const c = event.content || {};
  let body = '';
  if (op.key === 'ins') {
    body = `entity created · type=${c.entity_type}`;
  } else if (op.key === 'def') {
    if (!c.anchor && c.path?.startsWith('_schema.')) {
      body = `schema · ${c.path.replace('_schema.', '')} = ${JSON.stringify(c.value).slice(0, 80)}`;
    } else {
      body = `${c.path} = ${JSON.stringify(c.value).slice(0, 80)}`;
    }
  } else if (op.key === 'seg') {
    body = `→ partition: ${c.partition}`;
  } else if (op.key === 'con') {
    if (c.source_anchor === event._anchorFocus) body = `→ ${c.target_anchor}  [${c.relation_type}]`;
    else                                         body = `← ${c.source_anchor}  [${c.relation_type}]`;
  } else if (op.key === 'syn') {
    body = `synthesis of ${(c.input_anchors || []).length} anchors → ${JSON.stringify(c.output).slice(0, 80)}`;
  } else if (op.key === 'eva') {
    body = `${c.criterion} ⇒ ${c.result}${c.note ? ` (${c.note})` : ''}`;
  } else if (op.key === 'rec') {
    body = `${c.scope}: ${JSON.stringify(c.before_frame).slice(0, 40)} → ${JSON.stringify(c.after_frame).slice(0, 40)}`;
  }
  return { key: op.key.toUpperCase(), triad: op.triad, body, op };
}

// ─────────────────────────────────────────────────────────────────────────
// EntityTimelineView
// ─────────────────────────────────────────────────────────────────────────

function EntityTimelineView({
  room, state, entityType, entityAnchor, scrubber, allEventsInRoom, setSelection,
}) {
  if (!room) return <div className="tv-empty">select a room</div>;

  // List of sibling entities of the same type — for the picker
  const siblings = useMemo(() => Object.values(state.entities).filter(e => e._type === entityType), [state.entities, entityType]);
  const entity = state.entities[entityAnchor];

  // Events that touched this anchor
  const events = useMemo(() => {
    if (!entityAnchor) return [];
    return allEventsInRoom
      .map((e, i) => ({ ...e, _seq: i, _anchorFocus: entityAnchor }))
      .filter(e => eventTouchesAnchor(e, entityAnchor));
  }, [allEventsInRoom, entityAnchor]);

  if (!entity) {
    if (siblings.length === 0) {
      return (
        <div className="table-view">
          {scrubber}
          <div className="tv-body single">
            <div className="tv-empty">
              <div className="glyph">⏚</div>
              <div>no rows in <b>{entityType}</b> yet — once you insert a row, its timeline appears here.</div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="table-view">
        {scrubber}
        <div className="tv-body single schema-body">
          <header className="page-hero entity-hero">
            <div className="page-hero-eyebrow">
              <span className="page-hero-kind"><span className="page-hero-glyph">⏚</span> timeline</span>
              <span className="page-hero-sep">·</span>
              <span className="page-hero-crumb">{room.title || 'workspace'}<span className="page-hero-slash">/</span>{entityType}</span>
            </div>
            <h1 className="page-hero-title">pick a row</h1>
            <div className="page-hero-sub">choose one of the {siblings.length} {entityType} row{siblings.length!==1?'s':''} below to see its event lifeline</div>
          </header>
          <section className="page-section">
            <div className="page-section-head">
              <h2 className="page-section-label">rows</h2>
              <span className="page-section-sub">click to open</span>
            </div>
            <div className="tl-picker">
              {siblings.map(s => (
                <button key={s._anchor} className="tl-picker-row" onClick={() => jumpTo(s._anchor)}>
                  <span className="tl-picker-name">{s.Name || s.title || s.body || s.claim || s.what || s._anchor}</span>
                  <span className="tl-picker-anchor">{s._anchor}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }

  const fields = Object.entries(entity).filter(([k]) => !k.startsWith('_'));

  function jumpTo(anchor) {
    const target = state.entities[anchor];
    if (!target) return;
    setSelection({ kind: 'slice', sliceId: `${target._type}.timeline.${anchor}`, sliceKind: 'timeline', tableId: target._type, entityAnchor: anchor });
  }

  return (
    <div className="table-view">
      {scrubber}
      <div className="tv-body single schema-body">
        <header className="page-hero entity-hero">
          <div className="page-hero-eyebrow">
            <span className="page-hero-kind"><span className="page-hero-glyph">⏚</span> timeline</span>
            <span className="page-hero-sep">·</span>
            <span className="page-hero-crumb">{room.title || 'workspace'}<span className="page-hero-slash">/</span>{entityType}<span className="page-hero-slash">/</span>{entity._anchor}</span>
            <button
              className="entity-back"
              onClick={() => setSelection({ kind: 'slice', sliceId: `${entityType}.table`, sliceKind: 'table', tableId: entityType })}
              title="back to table"
            >← {entityType} table</button>
          </div>
          <h1 className="page-hero-title">{entity.Name || entity.title || entity.body || entity.claim || entity.what || entity._anchor}</h1>
          <div className="page-hero-sub" style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
            <span>{events.length} event{events.length !== 1 ? 's' : ''} touched this anchor</span>
            {siblings.length > 1 && (
              <span style={{display:'flex',alignItems:'center',gap:6}}>
                <span style={{color:'var(--text-faint)',fontSize:11,textTransform:'uppercase',letterSpacing:1.2}}>jump to:</span>
                <select
                  value={entityAnchor}
                  onChange={e => jumpTo(e.target.value)}
                  style={{fontSize:12,padding:'3px 7px',border:'1px solid var(--border-strong)',background:'#fff',fontFamily:'var(--mono)'}}
                >
                  {siblings.map(s => (
                    <option key={s._anchor} value={s._anchor}>{s.Name || s.title || s.body || s.claim || s.what || s._anchor}</option>
                  ))}
                </select>
              </span>
            )}
          </div>
        </header>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">current state</h2>
            <span className="page-section-sub">fold projected at cursor</span>
          </div>
          <div className="entity-card">
            <div className="entity-card-meta">
              <span><b>_anchor</b> <code>{entity._anchor}</code></span>
              <span><b>_type</b> <code>{entity._type}</code></span>
              {entity._partition && <span><b>_partition</b> <code>{entity._partition}</code></span>}
              <span><b>_hwm</b> <code>{entity._hwm}</code></span>
              <span><b>created</b> <code>{new Date(entity._created).toLocaleString()}</code></span>
              {entity._updated && <span><b>updated</b> <code>{new Date(entity._updated).toLocaleString()}</code></span>}
              <span><b>by</b> <code>{entity._updatedBy || entity._sender}</code></span>
            </div>
            {fields.length > 0 && (
              <div className="entity-card-fields">
                {fields.map(([k, v]) => (
                  <div className="entity-card-field" key={k}>
                    <span className="entity-card-field-k">{k}</span>
                    <span className="entity-card-field-v">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                    {entity._writes?.[k] != null && (
                      <span className="entity-card-field-writes">{entity._writes[k]} write{entity._writes[k]!==1?'s':''}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">events</h2>
            <span className="page-section-sub">earliest → latest · {events.length} on this anchor</span>
          </div>
          <div className="tl-spine">
            {events.map((ev, i) => {
              const s = eventSummary(ev);
              const isRec = s.op?.key === 'rec';
              const isViol = state._violations.some(v => v._eventId === ev.event_id);
              return (
                <div key={ev.event_id} className="tl-event">
                  <div className={`tl-dot ${s.triad} ${isRec ? 'rec' : ''}`} />
                  <div className={`tl-card ${s.op?.triad === 'structure' ? 'con' : ''} ${isRec ? 'rec' : ''} ${isViol ? 'eva-fail' : ''}`}>
                    <div className="tl-card-head">
                      <span className={`tl-card-op ${s.triad}`}>{s.key}</span>
                      <span className="tl-card-ts">#{String(ev._seq).padStart(3,'0')} · {new Date(ev.origin_server_ts).toLocaleString()}</span>
                    </div>
                    <div className="tl-card-body">
                      {s.body}
                      <div className="tl-card-agent">by {ev.sender}</div>
                    </div>
                  </div>
                </div>
              );
            })}
            {events.length === 0 && <div className="tv-empty">no events have touched this anchor yet</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

window.EntityTimelineView = EntityTimelineView;

})();
