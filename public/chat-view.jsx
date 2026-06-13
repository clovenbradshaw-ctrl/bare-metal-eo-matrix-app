/* chat-view.jsx — the "Ask" view: chat with your workspace data.
 *
 * Reads the live fold `state` (entities + CON connections + schema) and routes
 * a natural-language question through window.DataChat.interpret(), which is
 * deterministic-first and consults a small ON-DEVICE model only when "Smart
 * parse" is on and the lexical parse is unsure. Results render inline as:
 *   • a table (rows clickable → a profile popup)
 *   • a single value (count / sum / arithmetic)
 *   • a profile popup with every field + related records linked by foreign key
 *   • a prose answer, or a record search
 *
 * Read-only: nothing here emits an operator. The Cleo engine is loaded lazily
 * from the eoreader3 deployment the first time you ask, and degrades gracefully
 * if it can't (the query core is pure JS and works without it).
 */
(function () {
const { useState, useEffect, useRef, useMemo, useCallback } = React;
const DC = () => window.DataChat;

// On-device intent models. CPU (wllama) only — never the cloud (Anthropic)
// backend, so phrasing/parse stay fully local. Smallest first: it's the
// auto-load default, which keeps the memory footprint sane on big workspaces.
const LOCAL_MODELS = [
  { key: 'wllama:smollm2-360m', label: 'SmolLM2 360M · light, ~270 MB' },
  { key: 'wllama:qwen25-05b',   label: 'Qwen2.5 0.5B · balanced, ~380 MB' },
  { key: 'wllama:llama32-1b',   label: 'Llama 3.2 1B · best, ~770 MB' },
];

// A short restatement of what a result actually queried, shown above the answer
// so a misread is obvious at a glance. Skips kinds where it would just be noise.
function restateOf(result) {
  if (!result || result.kind === 'confirm' || result.kind === 'empty') return '';
  if (result.kind === 'answer' && !(result.spec && result.spec.type)) return '';
  try { return (DC() && DC().describe) ? DC().describe(result.spec) : ''; } catch (e) { return ''; }
}

// ───────────────────────────────────────────────────────────────────────────
// Profile popup — a record, all its fields, and every related record reached
// by a foreign key (CON edge). Clicking a related record drills into it; a
// back-stack remembers where you came from.
// ───────────────────────────────────────────────────────────────────────────
function ProfilePopup({ state, start, onClose, onOpenTable }) {
  const [stack, setStack] = useState([start]);
  useEffect(() => { setStack([start]); }, [start && start.anchor, start && start.type]);
  const cur = stack[stack.length - 1];
  const record = cur && state.entities[cur.anchor];

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!record) {
    return (
      <div className="record-detail-backdrop" onClick={onClose}>
        <aside className="record-detail-panel dc-profile" onClick={e => e.stopPropagation()}>
          <header className="rd-head"><span className="rd-eyebrow">profile</span></header>
          <div className="dc-prof-body"><p className="dc-empty">That record is no longer in this workspace.</p></div>
        </aside>
      </div>
    );
  }

  const dc = DC();
  const fields = dc.fieldsForType(state, cur.type).filter(f => !isBlank(record[f.name]));
  const related = dc.relatedRecords(state, cur.anchor);
  const title = dc.recordLabel(record);
  const open = (anchor, type) => setStack(s => [...s, { anchor, type }]);
  const back = () => setStack(s => s.length > 1 ? s.slice(0, -1) : s);

  return (
    <div className="record-detail-backdrop" onClick={onClose}>
      <aside className="record-detail-panel dc-profile" role="dialog" aria-label="record profile" onClick={e => e.stopPropagation()}>
        <header className="rd-head">
          <div className="rd-head-top">
            <span className="rd-eyebrow">{cur.type}</span>
            <div className="rd-head-nav">
              {stack.length > 1 && (
                <button className="dc-icon-btn" title="back" onClick={back}><i className="ph ph-arrow-left" aria-hidden="true"></i></button>
              )}
              <button className="dc-icon-btn" title="close" onClick={onClose}><i className="ph ph-x" aria-hidden="true"></i></button>
            </div>
          </div>
          <h2 className="dc-prof-title">{title}</h2>
        </header>

        <div className="dc-prof-body">
          <section className="dc-prof-section">
            <div className="dc-prof-label">Fields</div>
            {fields.length === 0 && <p className="dc-empty">No fields set.</p>}
            <dl className="dc-prof-fields">
              {fields.map(f => (
                <div className="dc-prof-row" key={f.name}>
                  <dt>{f.name}</dt>
                  <dd>{dc.displayValue(record[f.name])}</dd>
                </div>
              ))}
            </dl>
          </section>

          {related.length > 0 && (
            <section className="dc-prof-section">
              <div className="dc-prof-label">Related <span className="dc-count">{related.reduce((n, g) => n + g.records.length, 0)}</span></div>
              {related.map((g, i) => (
                <div className="dc-rel-group" key={i}>
                  <div className="dc-rel-head">
                    <i className={`ph ${g.dir === 'out' ? 'ph-arrow-right' : 'ph-arrow-left'}`} aria-hidden="true"></i>
                    <span className="dc-rel-rel">{g.rel}</span>
                    <span className="dc-rel-type">{g.type}</span>
                    <span className="dc-count">{g.records.length}</span>
                  </div>
                  <div className="dc-chips">
                    {g.records.map(r => (
                      <button className="dc-chip dc-chip-link" key={r.anchor} title={`open ${r.type}`} onClick={() => open(r.anchor, r.type)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}

          {related.length === 0 && (
            <p className="dc-empty">No linked records yet. Draw a relationship in the graph or table view to connect this record to others.</p>
          )}
        </div>

        <footer className="dc-prof-foot">
          <button className="dc-btn" onClick={() => { onOpenTable(cur.type); onClose(); }}>
            <i className="ph ph-table" aria-hidden="true"></i> Open in {cur.type}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function isBlank(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0); }

// ───────────────────────────────────────────────────────────────────────────
// Inline table for a query result. Records are clickable → profile popup.
// ───────────────────────────────────────────────────────────────────────────
const MAX_ROWS = 25;
const MAX_COLS = 6;
function ChatTable({ result, onOpenProfile, onOpenTable }) {
  const cols = useMemo(() => pickColumns(result), [result]);
  const rows = result.rows || [];
  const shown = rows.slice(0, MAX_ROWS);
  const clickable = !result._noClick && rows.some(r => r._anchor && !r._agg);
  const dc = DC();

  return (
    <div className="dc-table-wrap">
      <div className="dc-table-head">
        <span className="dc-table-title">{result.title}</span>
        <span className="dc-table-count">{result.total != null ? result.total : rows.length}</span>
        {result.type && (
          <button className="dc-link-btn" onClick={() => onOpenTable(result.type)} title="open the full table">open table</button>
        )}
      </div>
      {result.note && <div className="dc-spec">{result.note}</div>}
      <div className="dc-table-scroll">
        <table className="dc-table">
          <thead>
            <tr>{cols.map(c => <th key={c.name}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r._anchor || i}
                  className={clickable && r._anchor && !r._agg ? 'dc-row-click' : ''}
                  onClick={clickable && r._anchor && !r._agg ? () => onOpenProfile(r._anchor, r._type || result.type) : undefined}>
                {cols.map(c => <td key={c.name}>{dc.displayValue(r[c.name])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <div className="dc-more">
          +{rows.length - shown.length} more
          {result.type && <> — <button className="dc-link-btn" onClick={() => onOpenTable(result.type)}>see all in table</button></>}
        </div>
      )}
      {clickable && <div className="dc-hint">Click a row to open its profile.</div>}
    </div>
  );
}

function pickColumns(result) {
  if (Array.isArray(result.columns) && result.columns.length) {
    // keep the title column + a useful spread, capped
    return result.columns.slice(0, MAX_COLS);
  }
  const keys = new Set();
  for (const r of (result.rows || [])) for (const k of Object.keys(r)) if (k[0] !== '_') keys.add(k);
  return Array.from(keys).slice(0, MAX_COLS).map(name => ({ name, type: 'text' }));
}

// ───────────────────────────────────────────────────────────────────────────
// One assistant result, rendered by kind.
// ───────────────────────────────────────────────────────────────────────────
function ResultBlock({ result, onOpenProfile, onOpenTable, onChooseConfirm }) {
  if (!result) return null;
  if (result.kind === 'value') {
    return (
      <div className="dc-value-card">
        <div className="dc-value-num">{result.value}</div>
        <div className="dc-value-label">{result.label}{result.note ? ` · ${result.note}` : ''}</div>
      </div>
    );
  }
  if (result.kind === 'table') {
    return <ChatTable result={result} onOpenProfile={onOpenProfile} onOpenTable={onOpenTable} />;
  }
  if (result.kind === 'profile') {
    return (
      <div className="dc-profile-card" onClick={() => onOpenProfile(result.anchor, result.type)}>
        <i className="ph ph-identification-card" aria-hidden="true"></i>
        <span>Open profile · <strong>{result.type}</strong></span>
        <button className="dc-link-btn">open</button>
      </div>
    );
  }
  if (result.kind === 'answer') {
    return <div className="dc-answer">{result.text}</div>;
  }
  if (result.kind === 'confirm') {
    // A check-in before flooding the thread: either "which table did you
    // mean?" (reason='type') or "this matches N records — first 25 or all?"
    // (reason='flood'). Tapping a button runs that choice's plan with
    // skipConfirm=true so the gate never re-fires on the same question.
    const icon = result.reason === 'flood' ? 'ph-warning-circle' : 'ph-question';
    return (
      <div className="dc-confirm" role="group" aria-label="confirm">
        <div className="dc-confirm-head">
          <i className={`ph ${icon}`} aria-hidden="true"></i>
          <span className="dc-confirm-text">{result.text}</span>
        </div>
        <div className="dc-confirm-choices">
          {(result.choices || []).map((c, i) => (
            <button
              key={i}
              className="dc-confirm-choice"
              onClick={() => onChooseConfirm && onChooseConfirm(c, result)}
              title={c.hint || ''}
            >
              <span className="dc-confirm-label">{c.label}</span>
              {c.hint && <span className="dc-confirm-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }
  // empty
  return (
    <div className="dc-answer dc-answer-dim">
      {result.message}
      {result.suggestions && result.suggestions.length > 0 && (
        <div className="dc-suggest">{result.suggestions.map((s, i) => <span key={i} className="dc-sugg-tag">{s}</span>)}</div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The Ask view.
// ───────────────────────────────────────────────────────────────────────────
function ChatView({ room, state, setSelection }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(null);   // {anchor,type} | null
  const [model, setModel] = useState('wllama:smollm2-360m');
  const [status, setStatus] = useState(null);      // per-question thinking text
  const [modelStage, setModelStage] = useState('off'); // 'off' | 'loading' | 'ready'
  const [modelMsg, setModelMsg] = useState('');        // status-pill text
  const scrollRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const entityCount = Object.keys(state.entities || {}).length;

  const starters = useMemo(() => {
    try { const t = (DC().knownTypes(state) || []); return suggestStarters(state, t); } catch (e) { return []; }
  }, [state && state.cursor, Object.keys(state.entities || {}).length]);

  // Auto-load the analysis stack once the workspace data is in (Smart parse is
  // always on — there's no toggle). Order is memory-conscious: the deterministic
  // engine + math.js first (cheap, always useful), THEN the on-device model
  // weights, THEN the Python (numpy/pandas) runtime — but only if there's heap
  // headroom, so we never OOM a big workspace pulling in a WASM stack. Every
  // step is best-effort: deterministic queries answer immediately regardless,
  // so a failed or skipped download never blocks asking.
  useEffect(() => {
    if (!entityCount) return; // wait until the data has loaded
    const dc = DC();
    if (!dc || !dc.ensureAnalysis) return;
    let alive = true;
    setModelStage('loading'); setModelMsg('Loading engine…');
    dc.ensureAnalysis({
      modelKey: model,
      loadPython: true,
      onModelProgress: (p) => {
        if (!alive) return;
        const pct = p && typeof p.progress === 'number' ? Math.round(p.progress * 100) : null;
        setModelMsg(`Installing model${pct != null ? ` · ${pct}%` : '…'}`);
      },
      onStatus: (s) => { if (alive) setModelMsg(s); },
    }).then((caps) => {
      if (!alive) return;
      if (dc.warmEmbeddings) dc.warmEmbeddings();
      if (caps && caps.model) { setModelStage('ready'); setModelMsg(caps.python ? 'Model + Python ready' : 'Model ready · Python off'); }
      else { setModelStage('off'); setModelMsg('Local parsing'); }
    }).catch(() => { if (alive) { setModelStage('off'); setModelMsg('Local parsing'); } });
    return () => { alive = false; };
  }, [entityCount > 0, model]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const onOpenProfile = useCallback((anchor, type) => setProfile({ anchor, type }), []);
  const onOpenTable = useCallback((type) => {
    setSelection && setSelection({ kind: 'slice', sliceId: `${type}.table`, tableId: type, sliceKind: 'table' });
  }, [setSelection]);

  // The user tapped one of a confirm card's choices: run that exact plan
  // (DataChat hands it to us pre-built) and append the result as a new
  // assistant turn. skipConfirm prevents re-prompting on the same question.
  const onChooseConfirm = useCallback(async (choice, confirmResult) => {
    if (!choice || !choice.plan || busy) return;
    const labelTrace = choice.label || (choice.plan && choice.plan.type) || 'that';
    setMessages(m => [...m, { role: 'user', text: '↳ ' + labelTrace, isChoice: true }]);
    setBusy(true);
    setStatus(null);
    try {
      const dc = DC();
      const q = (confirmResult && confirmResult.spec && confirmResult.spec.question) || '';
      const result = await dc.executePlan(stateRef.current, choice.plan, { q, opts: { skipConfirm: true } });
      setMessages(m => [...m, { role: 'assistant', result }]);
      if (result.kind === 'profile') setProfile({ anchor: result.anchor, type: result.type });
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', result: { kind: 'answer', text: 'Something went wrong: ' + e.message } }]);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const ask = useCallback(async (text) => {
    const q = String(text || '').trim();
    if (!q || busy) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setBusy(true);
    setStatus(null);
    try {
      // Restate the interpretation up front (deterministic + instant) so the
      // user sees what we're about to run BEFORE the answer comes back.
      try {
        const dc = DC();
        if (dc && dc.buildPlan && dc.describe) {
          const det = dc.buildPlan(q, stateRef.current);
          const say = dc.describe(Object.assign({ question: q, target: det.plan.record }, det.plan));
          if (say) setStatus(say);
        }
      } catch (e) { /* restatement is best-effort */ }
      if (DC().ensureEngine) await DC().ensureEngine();
      const opts = {
        useLLM: true,                 // Smart parse is always on
        llmKey: model,
        onModelProgress: (p) => {
          const pct = p && typeof p.progress === 'number' ? Math.round(p.progress * 100) : null;
          setStatus(`Loading on-device model${pct != null ? ` · ${pct}%` : '…'}`);
        },
      };
      const result = await DC().interpret(q, stateRef.current, opts);
      setStatus(null);
      setMessages(m => [...m, { role: 'assistant', result, viaLLM: !!(result.spec && result.spec.usedLLM) }]);
      if (result.kind === 'profile') setProfile({ anchor: result.anchor, type: result.type });
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', result: { kind: 'answer', text: `Something went wrong reading that: ${e.message}` } }]);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [busy, model]);

  const onSubmit = (e) => { e.preventDefault(); ask(input); };

  return (
    <div className="dc-view">
      <div className="dc-bar">
        <div className="dc-bar-title"><i className="ph ph-chat-circle-dots" aria-hidden="true"></i> Ask {room ? room.title : 'your data'}</div>
        <div className="dc-bar-right">
          <span className={`dc-status is-${modelStage === 'ready' ? 'ready' : modelStage === 'loading' ? 'loading' : 'off'}`}
                title="Smart parse is always on: a small model + a local Python (pandas) runtime run entirely in your browser. Nothing leaves the page.">
            <span className="dc-dot" aria-hidden="true"></span>
            {modelMsg || (modelStage === 'ready' ? 'Model ready' : 'Local parsing')}
          </span>
          <select className="dc-model" value={model} onChange={e => setModel(e.target.value)} title="on-device model — pick a lighter one if memory is tight">
            {LOCAL_MODELS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
      </div>

      <div className="dc-thread" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="dc-intro">
            <p className="dc-intro-lead">Ask about your records in plain language. I read the data locally and build the query — I never write anything.</p>
            <ul className="dc-intro-list">
              <li>“show all open cases sorted by priority”</li>
              <li>“how many events?” · “count cases by status”</li>
              <li>“tell me about <em>a record</em>” → a profile with everything linked to it</li>
            </ul>
            {starters.length > 0 && (
              <div className="dc-starters">
                {starters.map((s, i) => <button key={i} className="dc-starter" onClick={() => ask(s)}>{s}</button>)}
              </div>
            )}
            <p className="dc-note">Smart parse is always on. A small model ({LOCAL_MODELS.find(m => m.key === model)?.label}) and a local Python (pandas) runtime load automatically once your data is in, then run fully offline — but you can ask right away, since local parsing answers immediately.</p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`dc-msg dc-msg-${m.role}`}>
            {m.role === 'user'
              ? <div className="dc-bubble">{m.text}</div>
              : <div className="dc-assistant">
                  {m.viaLLM && <div className="dc-via">interpreted with on-device model</div>}
                  {restateOf(m.result) && (
                    <div className="dc-restate"><i className="ph ph-quotes-fill" aria-hidden="true"></i><span>{restateOf(m.result)}</span></div>
                  )}
                  <ResultBlock result={m.result} onOpenProfile={onOpenProfile} onOpenTable={onOpenTable} onChooseConfirm={onChooseConfirm} />
                </div>}
          </div>
        ))}

        {busy && <div className="dc-msg dc-msg-assistant"><div className="dc-thinking">{status || 'Reading your data…'}</div></div>}
      </div>

      <form className="dc-composer" onSubmit={onSubmit}>
        <input
          className="dc-input"
          value={input}
          placeholder="Ask about your data…"
          onChange={e => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button className="dc-send" type="submit" disabled={busy || !input.trim()} title="ask">
          <i className="ph ph-paper-plane-right" aria-hidden="true"></i>
        </button>
      </form>

      {profile && (
        <ProfilePopup
          state={state}
          start={profile}
          onClose={() => setProfile(null)}
          onOpenTable={onOpenTable}
        />
      )}
    </div>
  );
}

// A few concrete starter questions grounded in the live schema.
function suggestStarters(state, types) {
  const dc = DC();
  const out = [];
  const t0 = types[0];
  if (t0) out.push(`show all ${dc.plural(t0)}`);
  // a count over the largest table
  let big = null, bigN = -1;
  for (const t of types) { const n = dc.entitiesOfType(state, t).length; if (n > bigN) { bigN = n; big = t; } }
  if (big) out.push(`how many ${dc.plural(big)}?`);
  // a select-field group-by, if any
  for (const t of types) {
    const f = dc.fieldsForType(state, t).find(x => x.type === 'select' && x.options && x.options.length);
    if (f) { out.push(`count ${dc.plural(t)} by ${f.name}`); break; }
  }
  // a profile on a real record
  const rec = Object.values(state.entities || {}).find(e => dc.recordLabel(e));
  if (rec) out.push(`tell me about ${dc.recordLabel(rec)}`);
  return out.slice(0, 4);
}

window.ChatView = React.memo(ChatView);
})();
