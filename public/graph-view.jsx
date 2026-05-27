/* graph-view.jsx — Force-directed node/edge graph.
 * Nodes = entities. Edges = CON connections. Edge labels = relation_type.
 * Drag a node to pin it. Click to inspect / highlight neighbors.
 */

(function() {
const { useState, useEffect, useRef, useMemo } = React;
const { OP: GV_OP } = window.MatrixEngine;

// ─────────────────────────────────────────────────────────────────────────
// Tiny force-directed sim
// ─────────────────────────────────────────────────────────────────────────

function simulate(nodes, edges, opts = {}) {
  const {
    width = 1000, height = 700,
    repel = 9000, springLen = 110, springK = 0.04,
    centerK = 0.0008, damping = 0.78,
    iter = 220,
  } = opts;

  const adjEdges = edges.map(e => ({
    a: nodes.find(n => n.id === e.source),
    b: nodes.find(n => n.id === e.target),
    rel: e.rel,
  })).filter(e => e.a && e.b);

  for (const n of nodes) {
    if (!n.x) n.x = width / 2 + (Math.random() - 0.5) * 200;
    if (!n.y) n.y = height / 2 + (Math.random() - 0.5) * 200;
    n.vx = 0; n.vy = 0;
  }

  for (let it = 0; it < iter; it++) {
    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy + 0.01;
        const f = repel / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx += dx * f * 0.01;
        a.vy += dy * f * 0.01;
        b.vx -= dx * f * 0.01;
        b.vy -= dy * f * 0.01;
      }
    }
    // springs
    for (const e of adjEdges) {
      let dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const ext = d - springLen;
      const f = springK * ext;
      const ux = dx / d, uy = dy / d;
      e.a.vx += ux * f; e.a.vy += uy * f;
      e.b.vx -= ux * f; e.b.vy -= uy * f;
    }
    // centering
    for (const n of nodes) {
      n.vx += (width / 2 - n.x) * centerK;
      n.vy += (height / 2 - n.y) * centerK;
      n.vx *= damping; n.vy *= damping;
      if (!n.pinned) {
        n.x += n.vx; n.y += n.vy;
      }
    }
  }
  return nodes;
}

// ─────────────────────────────────────────────────────────────────────────
// Visual constants — colors come from CSS vars at render time
// ─────────────────────────────────────────────────────────────────────────

function nodeStyleFor(entity) {
  const isSyn = entity._type === '_synthesis';
  const r = isSyn ? 22 : 18;
  return { r };
}

function colorForType(type, typeIndex) {
  // Pick from a palette using a stable index
  const palette = [
    'var(--accent)',          // 0
    'var(--blue)',            // 1
    'var(--green)',           // 2
    'var(--yellow)',          // 3
    'var(--red)',             // 4
    'var(--triad-significance)', // 5
  ];
  return palette[typeIndex % palette.length];
}

// ─────────────────────────────────────────────────────────────────────────
// Graph view
// ─────────────────────────────────────────────────────────────────────────

// Restrict the room state to one set: the set's own entities plus any
// entity reachable in one CON hop (the "explicitly connected" rule).
// Connections only ride along if at least one endpoint is in the set.
// The `_connections` meta set is cross-set by nature, so it pulls the
// whole room.
function scopedSubgraph(state, entityType) {
  if (!entityType) return { entities: [], connections: [] };
  if (entityType === '_connections') {
    return { entities: Object.values(state.entities), connections: state.connections };
  }
  const inSet = new Set();
  for (const a of Object.keys(state.entities)) {
    if (state.entities[a]._type === entityType) inSet.add(a);
  }
  const touching = state.connections.filter(c => inSet.has(c.source) || inSet.has(c.target));
  const reachable = new Set(inSet);
  for (const c of touching) {
    if (state.entities[c.source]) reachable.add(c.source);
    if (state.entities[c.target]) reachable.add(c.target);
  }
  const entities = [];
  for (const a of reachable) {
    const e = state.entities[a];
    if (e) entities.push(e);
  }
  return { entities, connections: touching };
}

function GraphView({ room, state, onEmit, scrubber, entityType }) {
  const svgRef = useRef(null);
  const positionsRef = useRef({});   // anchor -> {x,y,pinned}
  const [, setBumper] = useState(0);  // force re-render after drag/sim
  const [selected, setSelected] = useState(null);
  const [hoverEdge, setHoverEdge] = useState(null);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const wrapRef = useRef(null);

  // Pan / zoom (applied via viewBox)
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const panDragRef = useRef(null);

  // Tool modes
  const [mode, setMode] = useState('select'); // 'select' | 'addEntity' | 'connect'
  const [addEntityType, setAddEntityType] = useState('');
  const [connectFrom, setConnectFrom] = useState(null);
  const [connectPrompt, setConnectPrompt] = useState(null); // { from, to, x, y }
  const [mousePos, setMousePos] = useState(null);

  // Derive nodes + edges from state, scoped to the set + its one-hop neighbors.
  const { nodes, edges, typeIndex } = useMemo(() => {
    const sub = scopedSubgraph(state, entityType);
    const types = Array.from(new Set(sub.entities.map(e => e._type))).sort();
    const typeIndex = Object.fromEntries(types.map((t, i) => [t, i]));
    const nodes = sub.entities.map(e => {
      const prev = positionsRef.current[e._anchor];
      return {
        id: e._anchor,
        label: e.Name || e.title || e.body || e.claim || e.what || e._anchor.slice(-8),
        type: e._type,
        partition: state.partitions[e._anchor],
        entity: e,
        x: prev?.x,
        y: prev?.y,
        pinned: prev?.pinned || false,
      };
    });
    const edges = sub.connections.map((c, i) => ({
      id: `e${i}`,
      source: c.source,
      target: c.target,
      rel: c.type,
    }));
    return { nodes, edges, typeIndex };
  }, [state.entities, state.connections, state.partitions, entityType]);

  // Run simulation when graph topology changes
  useEffect(() => {
    if (nodes.length === 0) return;
    simulate(nodes, edges, { width: size.w, height: size.h });
    // store positions
    const next = {};
    for (const n of nodes) next[n.id] = { x: n.x, y: n.y, pinned: n.pinned };
    positionsRef.current = next;
    setBumper(x => x + 1);
  }, [nodes.length, edges.length, size.w, size.h]); // eslint-disable-line

  // Track wrapper size
  useEffect(() => {
    if (!wrapRef.current) return;
    const obs = new ResizeObserver(() => {
      const r = wrapRef.current.getBoundingClientRect();
      setSize({ w: Math.max(400, r.width), h: Math.max(300, r.height) });
    });
    obs.observe(wrapRef.current);
    return () => obs.disconnect();
  }, []);

  // When a node is selected, re-center the viewport on it.
  // Also relax the simulation around it so neighbors gather close.
  useEffect(() => {
    if (!selected) return;
    const n = nodes.find(x => x.id === selected);
    if (!n || n.x == null) return;
    // Center the viewBox on (n.x, n.y) at current zoom
    const vbw = size.w / view.zoom;
    const vbh = size.h / view.zoom;
    const targetPanX = n.x - vbw / 2;
    const targetPanY = n.y - vbh / 2;
    // Smoothly animate over ~250ms
    const startPanX = view.panX;
    const startPanY = view.panY;
    const startTime = performance.now();
    const dur = 280;
    let raf;
    function step(now) {
      const t = Math.min(1, (now - startTime) / dur);
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setView(v => ({ ...v, panX: startPanX + (targetPanX - startPanX) * ease, panY: startPanY + (targetPanY - startPanY) * ease }));
      if (t < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line
  }, [selected]);

  // Drag handling
  const dragRef = useRef(null);
  function onNodeDown(e, node) {
    e.preventDefault();
    e.stopPropagation();

    // Connect mode: tap to pick source, then target
    if (mode === 'connect') {
      if (!connectFrom) {
        setConnectFrom(node.id);
      } else if (connectFrom === node.id) {
        setConnectFrom(null); // tap same node again to cancel
      } else {
        // Got a pair — open relation prompt
        setConnectPrompt({ from: connectFrom, to: node.id, x: node.x, y: node.y });
      }
      return;
    }

    setSelected(node.id);
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    function clientToSvg(clientX, clientY) {
      pt.x = clientX; pt.y = clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }
    const start = clientToSvg(e.clientX, e.clientY);
    const origX = node.x, origY = node.y;
    dragRef.current = { id: node.id, startX: start.x, startY: start.y, origX, origY };

    function move(ev) {
      const p = clientToSvg(ev.clientX, ev.clientY);
      const dx = p.x - dragRef.current.startX;
      const dy = p.y - dragRef.current.startY;
      const pos = positionsRef.current[node.id];
      pos.x = origX + dx;
      pos.y = origY + dy;
      pos.pinned = true;
      const liveNode = nodes.find(n => n.id === node.id);
      if (liveNode) { liveNode.x = pos.x; liveNode.y = pos.y; liveNode.pinned = true; }
      setBumper(x => x + 1);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragRef.current = null;
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Click on empty canvas — used by addEntity mode to drop a new node
  function onSvgClick(e) {
    if (mode !== 'addEntity') return;
    if (e.target.tagName !== 'svg' && !e.target.classList?.contains?.('bg-rect')) return;
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    createEntityAt(p.x, p.y);
  }

  function onSvgMove(e) {
    if (mode !== 'connect' || !connectFrom) return;
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    setMousePos({ x: p.x, y: p.y });
  }

  function createEntityAt(x, y) {
    const declared = state.schema?.tables || [];
    // Stay inside the scoped set; for the cross-set _connections projection
    // there's no single "home" set, so fall back to the dropdown / first declared.
    const scopeDefault = entityType && entityType !== '_connections' ? entityType : null;
    const typeName = (scopeDefault || addEntityType || declared[0] || 'node').trim();
    if (!typeName) return;
    const sender = '@you:demo';
    const ts = Date.now();
    const anchor = window.MatrixEngine.makeAnchor(typeName, {}, sender, ts);
    // Pre-position the node so it lands where the user clicked
    positionsRef.current[anchor] = { x, y, pinned: true };
    onEmit(window.MatrixEngine.OP.INS, { anchor, entity_type: typeName, payload: {} });
    setMode('select');
  }

  function commitConnection(rel) {
    if (!connectPrompt) return;
    const { from, to } = connectPrompt;
    onEmit(window.MatrixEngine.OP.CON, { source_anchor: from, target_anchor: to, relation_type: rel || 'related_to' });
    setConnectPrompt(null);
    setConnectFrom(null);
    setMode('select');
  }

  function cancelConnect() {
    setConnectFrom(null);
    setConnectPrompt(null);
    setMode('select');
  }

  function unpinAll() {
    for (const k of Object.keys(positionsRef.current)) {
      positionsRef.current[k].pinned = false;
    }
    simulate(nodes, edges, { width: size.w, height: size.h });
    const next = {};
    for (const n of nodes) next[n.id] = { x: n.x, y: n.y, pinned: false };
    positionsRef.current = next;
    setBumper(x => x + 1);
  }

  // Neighbor set for highlighting
  const neighbors = useMemo(() => {
    if (!selected) return new Set();
    const set = new Set([selected]);
    for (const e of edges) {
      if (e.source === selected) set.add(e.target);
      if (e.target === selected) set.add(e.source);
    }
    return set;
  }, [selected, edges]);

  const types = Array.from(new Set(nodes.map(n => n.type))).sort();

  if (!room) return <div className="tv-empty">select a room</div>;
  if (!entityType) return <div className="tv-empty">pick a set to graph</div>;

  return (
    <div className="graph-view">
      <div className="tv-head">
        <h2>{room.title || 'untitled workspace'}</h2>
        <span className="crumb">{nodes.length} node{nodes.length!==1?'s':''} · {edges.length} edge{edges.length!==1?'s':''}</span>
        <div className="gv-toolbar">
          <button className={mode === 'select' ? 'active' : ''} onClick={() => { setMode('select'); cancelConnect(); }} title="select / drag">select</button>
          <button
            className={mode === 'addEntity' ? 'active' : ''}
            onClick={() => { setMode(mode === 'addEntity' ? 'select' : 'addEntity'); setConnectFrom(null); }}
            title="click empty canvas to drop a new entity (INS)"
          >+ entity</button>
          <button
            className={mode === 'connect' ? 'active' : ''}
            onClick={() => { setMode(mode === 'connect' ? 'select' : 'connect'); setConnectFrom(null); }}
            title="click source node, then target node, to create a CON edge"
          >+ edge</button>
          <button onClick={unpinAll} title="re-run physics">↻ relax</button>
        </div>
        <div className="right">
          nodes = INS · edges = CON · drag to move · click to inspect
        </div>
      </div>

      {scrubber}

      {/* Mode hint banner */}
      {mode !== 'select' && (
        <div className="gv-modebar">
          {mode === 'addEntity' && (
            <>
              <span>click empty canvas to drop a new </span>
              {entityType && entityType !== '_connections' ? (
                <b>{entityType}</b>
              ) : (
                <select value={addEntityType} onChange={e => setAddEntityType(e.target.value)}>
                  {(state.schema?.tables || ['node']).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <span> · emits <b>INS</b></span>
              <button className="gv-cancel" onClick={() => setMode('select')}>esc</button>
            </>
          )}
          {mode === 'connect' && (
            <>
              {!connectFrom && <span>click <b>source</b> node…</span>}
              {connectFrom && !connectPrompt && <span>source: <b>{nodes.find(n=>n.id===connectFrom)?.label || connectFrom}</b> · now click <b>target</b> node…</span>}
              {connectPrompt && <span>name the relation:</span>}
              <button className="gv-cancel" onClick={cancelConnect}>esc</button>
            </>
          )}
        </div>
      )}

      <div className="graph-canvas" ref={wrapRef}>
        <div className="gv-zoom">
          <button onClick={() => setView(v => ({ ...v, zoom: Math.min(8, v.zoom * 1.25) }))} title="zoom in">+</button>
          <span className="gv-zoom-val">{Math.round(view.zoom * 100)}%</span>
          <button onClick={() => setView(v => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.25) }))} title="zoom out">−</button>
          <button onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })} title="reset zoom + pan">fit</button>
        </div>
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          viewBox={`${view.panX} ${view.panY} ${size.w / view.zoom} ${size.h / view.zoom}`}
          onClick={onSvgClick}
          onMouseMove={onSvgMove}
          onWheel={(e) => {
            // wheel zoom centered on cursor
            e.preventDefault();
            const svg = svgRef.current;
            if (!svg) return;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX; pt.y = e.clientY;
            const p = pt.matrixTransform(svg.getScreenCTM().inverse());
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const newZoom = Math.min(8, Math.max(0.2, view.zoom * factor));
            // Keep the point under the cursor fixed:
            // newPan = oldPan + p - (p - oldPan) * (oldZoom/newZoom)
            const vbw = size.w / view.zoom;
            const vbh = size.h / view.zoom;
            const newVbw = size.w / newZoom;
            const newVbh = size.h / newZoom;
            const newPanX = p.x - (p.x - view.panX) * (newVbw / vbw);
            const newPanY = p.y - (p.y - view.panY) * (newVbh / vbh);
            setView({ zoom: newZoom, panX: newPanX, panY: newPanY });
          }}
          onPointerDown={(e) => {
            // Pan when:
            // - middle-click / right-click
            // - alt or meta + drag (always)
            // - plain left-drag on background (no node) in select mode
            const isBackground = e.target.tagName === 'svg' || e.target.classList?.contains?.('bg-rect');
            const wantPan = (e.button === 1) || (e.button === 2) || e.altKey || e.metaKey
                         || (e.button === 0 && mode === 'select' && isBackground);
            if (!wantPan) return;
            e.preventDefault();
            // Clear selection if panning empty canvas
            if (e.button === 0 && mode === 'select' && isBackground) setSelected(null);
            panDragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              startPanX: view.panX,
              startPanY: view.panY,
              zoom: view.zoom,
              moved: false,
            };
            const onMove = (ev) => {
              if (!panDragRef.current) return;
              const dx = (ev.clientX - panDragRef.current.startX) / panDragRef.current.zoom;
              const dy = (ev.clientY - panDragRef.current.startY) / panDragRef.current.zoom;
              if (Math.abs(dx) + Math.abs(dy) > 1) panDragRef.current.moved = true;
              setView(v => ({ ...v, panX: panDragRef.current.startPanX - dx, panY: panDragRef.current.startPanY - dy }));
            };
            const onUp = () => {
              panDragRef.current = null;
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          }}
          onContextMenu={(e) => e.preventDefault()}
          style={{cursor: panDragRef.current ? 'grabbing' : (mode === 'addEntity' ? 'crosshair' : (mode === 'connect' ? 'crosshair' : 'grab'))}}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* Background rect for empty-canvas clicks in addEntity mode */}
          <rect className="bg-rect" x="0" y="0" width={size.w} height={size.h} fill="transparent" />

          {/* Preview line for connect mode */}
          {mode === 'connect' && connectFrom && mousePos && !connectPrompt && (
            <g className="edge connect-preview" style={{pointerEvents:'none'}}>
              <line
                x1={(nodes.find(n => n.id === connectFrom) || {}).x}
                y1={(nodes.find(n => n.id === connectFrom) || {}).y}
                x2={mousePos.x}
                y2={mousePos.y}
                stroke="#000"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
            </g>
          )}

          {/* edges first so they sit under nodes */}
          <g className="edges">
            {edges.map(e => {
              const a = nodes.find(n => n.id === e.source);
              const b = nodes.find(n => n.id === e.target);
              if (!a || !b) return null;
              const dim = selected && !(neighbors.has(a.id) && neighbors.has(b.id));
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              return (
                <g key={e.id} className={`edge ${dim ? 'dim' : ''} ${hoverEdge === e.id ? 'hover' : ''}`}
                   onMouseEnter={() => setHoverEdge(e.id)} onMouseLeave={() => setHoverEdge(null)}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#arrow)" />
                  <rect x={mx - e.rel.length * 3.2 - 4} y={my - 8} width={e.rel.length * 6.4 + 8} height={15} rx="3" />
                  <text x={mx} y={my + 3} textAnchor="middle">{e.rel}</text>
                </g>
              );
            })}
          </g>

          <g className="nodes">
            {nodes.map(n => {
              const { r } = nodeStyleFor(n.entity);
              const col = colorForType(n.type, typeIndex[n.type]);
              const isSelected = selected === n.id;
              const isConnSrc  = connectFrom === n.id;
              const dim = (selected || connectFrom) && !neighbors.has(n.id) && connectFrom !== n.id;
              return (
                <g key={n.id} className={`node ${dim ? 'dim' : ''} ${isSelected ? 'selected' : ''} ${isConnSrc ? 'conn-src' : ''} ${n.pinned ? 'pinned' : ''}`}
                   transform={`translate(${n.x},${n.y})`}
                   onPointerDown={(e) => onNodeDown(e, n)}>
                  <circle r={r + 4} fill="none" stroke={col} strokeOpacity="0.18" strokeWidth="3" className="halo" />
                  <circle r={r} fill={col} fillOpacity="0.18" stroke={col} strokeWidth="1.5" />
                  {n.entity._type === '_synthesis' && (
                    <text className="ngly" y={4} textAnchor="middle">△</text>
                  )}
                  <text className="nlabel" y={r + 14} textAnchor="middle">{n.label.length > 22 ? n.label.slice(0, 22) + '…' : n.label}</text>
                  <text className="nsub" y={r + 26} textAnchor="middle">{n.type}{n.partition ? ' · ' + n.partition : ''}</text>
                  {n.pinned && <text className="npin" x={r - 4} y={-r + 8} textAnchor="end">📌</text>}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Legend */}
        <div className="gv-legend">
          <div className="gv-leg-title">entity types</div>
          {types.map(t => (
            <div key={t} className="gv-leg-row">
              <span className="dot" style={{background: colorForType(t, typeIndex[t])}} />
              <span>{t}</span>
              <span className="ct">{nodes.filter(n => n.type === t).length}</span>
            </div>
          ))}
        </div>

        {/* Detail card */}
        {selected && (() => {
          const node = nodes.find(n => n.id === selected);
          if (!node) return null;
          const e = node.entity;
          const inEdges = edges.filter(x => x.target === selected);
          const outEdges = edges.filter(x => x.source === selected);
          return (
            <div className="gv-detail">
              <div className="gv-detail-head">
                <span className="anchor">{e._anchor}</span>
                <button onClick={() => setSelected(null)}>×</button>
              </div>
              <div className="gv-detail-row"><span className="k">_type</span><span className="v">{e._type}</span></div>
              {Object.entries(e).filter(([k]) => !k.startsWith('_')).map(([k, v]) => (
                <div className="gv-detail-row" key={k}>
                  <span className="k">{k}</span>
                  <span className="v">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                </div>
              ))}
              {node.partition && <div className="gv-detail-row"><span className="k">_partition</span><span className="v" style={{color:'var(--blue)'}}>{node.partition}</span></div>}
              {(outEdges.length > 0 || inEdges.length > 0) && <div className="gv-detail-sep">relations</div>}
              {outEdges.map((x, i) => (
                <div className="gv-detail-row" key={'o'+i}><span className="k">→ {x.rel}</span>
                  <span className="v" style={{color:'var(--accent)',cursor:'pointer'}} onClick={() => setSelected(x.target)}>
                    {nodes.find(n => n.id === x.target)?.label || x.target}
                  </span>
                </div>
              ))}
              {inEdges.map((x, i) => (
                <div className="gv-detail-row" key={'i'+i}><span className="k">← {x.rel}</span>
                  <span className="v" style={{color:'var(--accent)',cursor:'pointer'}} onClick={() => setSelected(x.source)}>
                    {nodes.find(n => n.id === x.source)?.label || x.source}
                  </span>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Relation prompt for connect mode */}
        {connectPrompt && (
          <RelationPrompt
            from={nodes.find(n => n.id === connectPrompt.from)}
            to={nodes.find(n => n.id === connectPrompt.to)}
            existingRels={Array.from(new Set(state.connections.map(c => c.type)))}
            onCommit={commitConnection}
            onCancel={cancelConnect}
          />
        )}

        {nodes.length === 0 && (
          <div className="tv-empty" style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
            {entityType && entityType !== '_connections'
              ? `no ${entityType} rows yet — emit INS to create nodes`
              : 'no entities yet — emit INS to create nodes'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Relation-type prompt for the connect flow
// ─────────────────────────────────────────────────────────────────────────

function RelationPrompt({ from, to, existingRels, onCommit, onCancel }) {
  const [rel, setRel] = React.useState('');
  const inputRef = React.useRef(null);
  React.useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="gv-relprompt" onClick={(e) => e.stopPropagation()}>
      <div className="gv-relprompt-title">name the relation</div>
      <div className="gv-relprompt-pair">
        <span className="src">{from?.label || from?.id}</span>
        <span className="arrow">-[?]→</span>
        <span className="tgt">{to?.label || to?.id}</span>
      </div>
      <input
        ref={inputRef}
        value={rel}
        onChange={e => setRel(e.target.value)}
        placeholder="blocks, depends_on, annotates…"
        onKeyDown={e => {
          if (e.key === 'Enter') onCommit(rel.trim() || 'related_to');
          else if (e.key === 'Escape') onCancel();
        }}
      />
      {existingRels.length > 0 && (
        <div className="gv-relprompt-suggest">
          {existingRels.map(r => (
            <button key={r} onClick={() => onCommit(r)}>{r}</button>
          ))}
        </div>
      )}
      <div className="gv-relprompt-actions">
        <button className="primary" onClick={() => onCommit(rel.trim() || 'related_to')}>emit CON</button>
        <button onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

window.GraphView = GraphView;
})();
