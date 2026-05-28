/* db-view.jsx — Database view: rooms, timeline, operator palette, projected state */

(function() {
const { useState, useMemo, useEffect, useRef } = React;
const { OP, STORED_OPS, ALL_OPS } = window.MatrixEngine;

// ─────────────────────────────────────────────────────────────────────────
// Timeline row — one event in the append-only log
// ─────────────────────────────────────────────────────────────────────────

function TimelineRow({ event, idx, scrubbed, future, isViolation, onClick }) {
  const op = window.MatrixEngine.parseEventType(event.type);
  if (!op) return null;
  const c = event.content || {};
  let body;
  if (op === OP.INS) {
    body = (
      <span className="tl-line">
        <span className="tl-anchor">{c.anchor}</span>
        <span className="muted"> · </span>
        <span className="tl-path">{c.entity_type}</span>
        <span className="muted"> { JSON.stringify(c.payload || {}).slice(0, 80) }</span>
      </span>
    );
  } else if (op === OP.DEF) {
    if (!c.anchor && c.path?.startsWith('_schema.')) {
      body = (
        <span className="tl-line">
          <span className="muted">schema</span>
          <span className="muted"> · </span>
          <span className="tl-path">{c.path.replace('_schema.', '')}</span>
          <span className="muted"> = </span>
          <span className="tl-val">{JSON.stringify(c.value)}</span>
        </span>
      );
    } else {
      body = (
        <span className="tl-line">
          <span className="tl-anchor">{c.anchor}</span>
          <span className="muted"> · </span>
          <span className="tl-path">{c.path}</span>
          <span className="muted"> = </span>
          <span className="tl-val">{JSON.stringify(c.value)}</span>
        </span>
      );
    }
  } else if (op === OP.SEG) {
    body = (
      <span className="tl-line">
        <span className="tl-anchor">{c.anchor}</span>
        <span className="muted"> → </span>
        <span className="tl-rel">{c.partition}</span>
      </span>
    );
  } else if (op === OP.CON) {
    body = (
      <span className="tl-line">
        <span className="tl-anchor">{c.source_anchor}</span>
        <span className="muted"> -[</span>
        <span className="tl-rel">{c.relation_type}</span>
        <span className="muted">]→ </span>
        <span className="tl-anchor">{c.target_anchor}</span>
      </span>
    );
  } else if (op === OP.SYN) {
    body = (
      <span className="tl-line">
        <span className="muted">[{(c.input_anchors || []).length} inputs] → </span>
        <span className="tl-val">{JSON.stringify(c.output).slice(0, 80)}</span>
      </span>
    );
  } else if (op === OP.EVA) {
    body = (
      <span className="tl-line">
        <span className="tl-anchor">{c.anchor}</span>
        <span className="muted"> · </span>
        <span className="tl-path">{c.criterion}</span>
        <span className="muted"> ⇒ </span>
        <span className={c.result === 'pass' ? 'tl-val' : 'tl-rel'} style={{color: c.result==='fail'?'var(--red)':'var(--green)'}}>{c.result}</span>
      </span>
    );
  } else if (op === OP.REC) {
    body = (
      <span className="tl-line">
        <span className="tl-path">{c.scope}</span>
        <span className="muted"> recontextualized</span>
      </span>
    );
  } else {
    body = <span className="tl-line muted">{JSON.stringify(c).slice(0, 90)}</span>;
  }

  return (
    <div className={`tl-row ${future ? 'future' : ''} ${scrubbed ? 'scrubbed' : ''} ${isViolation ? 'violation' : ''}`} onClick={onClick}>
      <div className="tl-idx">#{String(idx).padStart(3, '0')}</div>
      <div className={`tl-glyph ${op.triad}`}>{op.glyph}</div>
      <div className="tl-key">{op.key}</div>
      <div className="tl-body">
        {body}
        <div className="tl-sender">{event.sender}{event._pending ? <span className="tl-pending"> · pending</span> : ''}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Operator palette + inline forms
// ─────────────────────────────────────────────────────────────────────────

function OpForm({ op, entities, onSubmit, onCancel }) {
  const [form, setForm] = useState({});
  const anchors = Object.keys(entities);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function submit() {
    const ops = [];
    if (op === OP.NUL) {
      ops.push([op, { target: form.target || '', note: form.note || '' }]);
    } else if (op === OP.SIG) {
      ops.push([op, { target: form.target || anchors[0] || '', intensity: form.intensity || 'med' }]);
    } else if (op === OP.INS) {
      // INS creates the bare thing — payload is empty.
      // If the user supplied a title, follow up with a DEF.
      const entityType = form.entity_type || 'task';
      const sender = '@you:demo';
      const ts = Date.now();
      const anchor = window.MatrixEngine.makeAnchor(entityType, {}, sender, ts);
      ops.push([OP.INS, { anchor, entity_type: entityType, payload: {} }]);
      if (form.title) ops.push([OP.DEF, { anchor, path: 'title', value: form.title }]);
    } else if (op === OP.DEF) {
      ops.push([op, { anchor: form.anchor || anchors[0] || null, path: form.path || 'status', value: tryParse(form.value) }]);
    } else if (op === OP.SEG) {
      ops.push([op, { anchor: form.anchor || anchors[0], partition: form.partition || 'done' }]);
    } else if (op === OP.CON) {
      ops.push([op, { source_anchor: form.source_anchor || anchors[0], target_anchor: form.target_anchor || anchors[1] || anchors[0], relation_type: form.relation_type || 'related_to' }]);
    } else if (op === OP.SYN) {
      ops.push([op, { input_anchors: (form.input_anchors || '').split(',').map(s => s.trim()).filter(Boolean), output: tryParse(form.output) || { summary: form.output || '' } }]);
    } else if (op === OP.EVA) {
      ops.push([op, { anchor: form.anchor || anchors[0], criterion: form.criterion || 'completeness', result: form.result || 'pass', note: form.note || '' }]);
    } else if (op === OP.REC) {
      ops.push([op, { scope: form.scope || 'priority_model', before_frame: tryParse(form.before_frame) || form.before_frame, after_frame: tryParse(form.after_frame) || form.after_frame }]);
    }
    onSubmit(ops);
  }

  function tryParse(s) {
    if (s === undefined || s === null || s === '') return s;
    try { return JSON.parse(s); } catch { return s; }
  }

  const fields = {
    NUL: [
      ['target', '(anything you noticed)'],
      ['note', 'something observed'],
    ],
    SIG: [
      ['target', anchors[0] || '', 'select'],
      ['intensity', 'med', 'enum', ['low', 'med', 'high']],
    ],
    INS: [
      ['entity_type', 'task'],
      ['title', 'optional — will follow INS with a DEF'],
    ],
    DEF: [
      ['anchor', anchors[0] || '', 'select'],
      ['path', 'status'],
      ['value', '"active"'],
    ],
    SEG: [
      ['anchor', anchors[0] || '', 'select'],
      ['partition', 'done'],
    ],
    CON: [
      ['source_anchor', anchors[0] || '', 'select'],
      ['target_anchor', anchors[1] || anchors[0] || '', 'select'],
      ['relation_type', 'blocks'],
    ],
    SYN: [
      ['input_anchors', anchors.slice(0, 2).join(', ')],
      ['output', '{"summary":"…"}'],
    ],
    EVA: [
      ['anchor', anchors[0] || '', 'select'],
      ['criterion', 'completeness'],
      ['result', 'pass', 'enum', ['pass', 'fail', 'partial']],
      ['note', ''],
    ],
    REC: [
      ['scope', 'priority_model'],
      ['before_frame', '{"priority":"scalar"}'],
      ['after_frame', '{"priority":"WSJF"}'],
    ],
  }[op.key.toUpperCase()];

  return (
    <div className="op-form">
      <div className="hint">
        <span className={`tl-glyph ${op.triad}`} style={{display:'inline',fontSize:13,marginRight:6}}>{op.glyph}</span>
        <b className="bright">{op.name}</b> · {opDescription(op)}
      </div>
      {fields.map(([k, ph, kind, opts]) => (
        <div className="row" key={k}>
          <label>{k}</label>
          {kind === 'select' && anchors.length ? (
            <select value={form[k] || ph} onChange={e => set(k, e.target.value)}>
              {anchors.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          ) : kind === 'enum' ? (
            <select value={form[k] || ph} onChange={e => set(k, e.target.value)}>
              {opts.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input value={form[k] ?? ph} onChange={e => set(k, e.target.value)} placeholder={ph} />
          )}
        </div>
      ))}
      <div className="actions">
        <button onClick={submit}>emit</button>
        <button className="ghost" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Ephemeral lane — NUL and SIG flashes (never written to the log)
// ─────────────────────────────────────────────────────────────────────────

function EphemeralLane({ ephemerals }) {
  if (!ephemerals || ephemerals.length === 0) {
    return (
      <div className="eph-lane empty">
        <span className="eph-label">ephemeral</span>
        <span className="eph-hint">∅ NUL / ○ SIG fire here but never persist</span>
      </div>
    );
  }
  return (
    <div className="eph-lane">
      <span className="eph-label">ephemeral</span>
      <div className="eph-flashes">
        {ephemerals.map(e => {
          const op = window.MatrixEngine.OP[e.opKey.toUpperCase()];
          return (
            <div key={e.id} className={`eph-flash ${op.triad}`}>
              <span className="eph-gly">{op.glyph}</span>
              <span className="eph-key">{op.key}</span>
              {e.content.target && <span className="eph-target">{e.content.target}</span>}
              {e.content.intensity && <span className="eph-meta">·{e.content.intensity}</span>}
              {e.content.note && <span className="eph-meta">·{e.content.note}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function opDescription(op) {
  return {
    nul: 'observation — ephemeral, not written to the log',
    sig: 'attention — ephemeral, not written to the log',
    ins: 'create a new entity with a content-addressed anchor',
    seg: 'move an entity into a partition (column / bucket)',
    con: 'create a typed relationship between two anchors',
    syn: 'merge multiple anchors into a synthesized output',
    def: 'set a value at a path within an entity (or schema)',
    eva: 'evaluate an entity against a named criterion',
    rec: 'change the frame the data is interpreted in',
  }[op.key];
}

function OpPalette({ entities, onEmit, onEphemeral }) {
  const [active, setActive] = useState(null);
  return (
    <div className="ops">
      <div className="ops-head">
        <span className="label">Emit operator</span>
        <span className="faint" style={{fontSize:10.5}}>
          7 stored · 2 ephemeral
        </span>
      </div>
      <div className="ops-grid nine">
        {ALL_OPS.map(op => (
          <button
            key={op.key}
            className={`op-btn ${op.triad} ${op.stored ? '' : 'ephemeral'}`}
            onClick={() => setActive(active === op.key ? null : op.key)}
            title={op.stored ? 'stored — appended to room timeline' : 'ephemeral — never persisted'}
          >
            <span className="gly">{op.glyph}</span>
            <span className="key">{op.key}</span>
          </button>
        ))}
      </div>
      {active && (
        <OpForm
          op={ALL_OPS.find(o => o.key === active)}
          entities={entities}
          onSubmit={(ops) => {
            for (const [op, content] of ops) {
              if (op.stored) onEmit(op, content);
              else onEphemeral(op, content);
            }
            setActive(null);
          }}
          onCancel={() => setActive(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// State view — projected entities, partitions, connections, schema, frames, violations
// ─────────────────────────────────────────────────────────────────────────

function StateView({ state, highlight, setHighlight, showViolations, showHwm }) {
  const entities = Object.values(state.entities);
  const hasSchema = Object.keys(state.schema).length > 0;

  return (
    <>
      {hasSchema && (
        <div className="state-section">
          <h3>schema <span className="count">{Object.keys(state.schema).length}</span></h3>
          {Object.entries(state.schema).map(([k, v]) => (
            <div className="schema-row" key={k}><span className="k">{k}</span> = <span className="v">{JSON.stringify(v)}</span></div>
          ))}
        </div>
      )}

      <div className="state-section">
        <h3>entities <span className="count">{entities.length}</span></h3>
        {entities.length === 0 && <div className="muted" style={{fontSize:11,fontStyle:'italic'}}>(fold an INS to materialize an entity)</div>}
        {entities.map(e => {
          const fields = Object.entries(e).filter(([k]) => !k.startsWith('_'));
          return (
            <div
              key={e._anchor}
              className={`entity ${state.partitions[e._anchor] ? 'partitioned' : ''} ${highlight === e._anchor ? 'highlight' : ''}`}
              onClick={() => setHighlight(highlight === e._anchor ? null : e._anchor)}
            >
              <div className="e-head">
                <span className="e-anchor">{e._anchor}</span>
                {showHwm && <span className="e-hwm">hwm {e._hwm}</span>}
              </div>
              <div className="e-row"><span className="e-key">_type</span><span className="e-val muted">{e._type}</span></div>
              {state.partitions[e._anchor] && (
                <div className="e-row"><span className="e-key">_partition</span><span className="e-val" style={{color:'var(--blue)'}}>{state.partitions[e._anchor]}</span></div>
              )}
              {fields.map(([k, v]) => (
                <div className="e-row" key={k}>
                  <span className="e-key">{k}</span>
                  <span className="e-val">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                </div>
              ))}
              {e._evaluations && (
                <div className="e-row"><span className="e-key">_evaluations</span><span className="e-val muted">[{e._evaluations.length}]</span></div>
              )}
              <div className="e-meta">
                <span>by {e._sender}</span>
                <span>{new Date(e._created).toLocaleTimeString()}</span>
              </div>
            </div>
          );
        })}
      </div>

      {state.connections.length > 0 && (
        <div className="state-section">
          <h3>connections <span className="count">{state.connections.length}</span></h3>
          {state.connections.map((c, i) => (
            <div className="conn" key={i}>
              <span className="accent">{c.source}</span>
              <span className="arrow">-[{c.type}]→</span>
              <span className="accent">{c.target}</span>
            </div>
          ))}
        </div>
      )}

      {state.frames.length > 0 && (
        <div className="state-section">
          <h3>frames (REC) <span className="count">{state.frames.length}</span></h3>
          {state.frames.map((f, i) => (
            <div className="frame" key={i}>
              <span className="scope">{f.scope}</span>
              <div style={{marginTop:4,fontSize:10.5}} className="muted">
                {JSON.stringify(f.before_frame)} <span className="arrow">→</span> {JSON.stringify(f.after_frame)}
              </div>
            </div>
          ))}
        </div>
      )}

      {showViolations && state._violations.length > 0 && (
        <div className="state-section">
          <h3 style={{color:'var(--red)'}}>violations <span className="count">{state._violations.length}</span></h3>
          {state._violations.map((v, i) => (
            <div className="viol" key={i}>
              <span className="v-type">{v.type}</span>
              {v.op} {v.anchor || ''}
              {v.source && <span> · src={v.source} tgt={v.target} ({v.missing})</span>}
              {v.hwm !== undefined && <span> · hwm {v.hwm} &lt; {v.required}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DB view root
// ─────────────────────────────────────────────────────────────────────────

function DbView({ rooms, currentRoomId, setCurrentRoomId, createRoom, eventsUpTo, allEventsInRoom, state, cursor, setCursor, onEmit, onEphemeral, ephemerals, highlight, setHighlight, tweaks, scrubber }) {
  const allEvents = allEventsInRoom;
  const violationEvtIds = useMemo(() => new Set(state._violations.map(v => v._eventId).filter(Boolean)), [state._violations]);
  const room = rooms.find(r => r.id === currentRoomId);
  const [subview, setSubview] = useState('timeline'); // 'timeline' | 'state' (mobile only)

  return (
    <div className="db-view">
      <div className="subtabs">
        <button className={subview === 'timeline' ? 'active' : ''} onClick={() => setSubview('timeline')}>
          timeline ({allEvents.length})
        </button>
        <button className={subview === 'state' ? 'active' : ''} onClick={() => setSubview('state')}>
          projected state
        </button>
      </div>
      {scrubber}
      <div className="db">
        {/* Timeline + ops column */}
        <div className={`col ${subview !== 'timeline' ? 'hidden-sub' : ''}`}>
          <div className="col-head">
            <span className="label">Timeline</span>
            <span className="muted" title={room?.id}>append-only event log</span>
            <span className="meta">{allEvents.length} events</span>
          </div>
          <EphemeralLane ephemerals={ephemerals} />
          <div className="col-body" id="tl-body">
            {allEvents.length === 0 && <div className="tl-empty">no events yet — emit one below</div>}
            {[...allEvents].map((ev, _i, arr) => {
              // most-recent-first: render reversed but keep idx tied to actual log position
              const i = arr.length - 1 - _i;
              const ev2 = arr[i];
              return (
              <TimelineRow
                key={ev2.event_id}
                event={ev2}
                idx={i}
                scrubbed={i === cursor - 1 && cursor > 0}
                future={i >= cursor}
                isViolation={violationEvtIds.has(ev2.event_id)}
                onClick={() => setCursor(i + 1)}
              />
              );
            })}
          </div>
          <OpPalette entities={state.entities} onEmit={onEmit} onEphemeral={onEphemeral} />
        </div>

        {/* State column */}
        <div className={`col ${subview !== 'state' ? 'hidden-sub' : ''}`}>
          <div className="col-head">
            <span className="label">Projected state</span>
            <span className="muted">fold(events[0..{cursor}])</span>
            <span className="meta">hash {window.MatrixEngine.cyrb53(JSON.stringify(Object.keys(state.entities).sort())).toString(16).slice(0, 8)}</span>
          </div>
          <div className="col-body">
            <StateView state={state} highlight={highlight} setHighlight={setHighlight} showViolations={tweaks.showViolations} showHwm={tweaks.showHwm} />
          </div>
        </div>
      </div>
    </div>
  );
}

window.DbView = DbView;
})();
