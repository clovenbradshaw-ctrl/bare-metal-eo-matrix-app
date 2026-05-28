/* toast.jsx
 *
 * A tiny global notification (toast) system.
 *
 * Why a global store rather than React context: notifications are fired
 * from places that aren't React components (the bridge, async effects,
 * import materialisation) and need to outlive the component that raised
 * them. `window.Toast` is a plain pub/sub store; `window.ToastHost` is a
 * single subscriber that renders the current set.
 *
 *   const id = window.Toast.push({ kind: 'progress', title: 'loading…' });
 *   window.Toast.update(id, { kind: 'success', title: 'done', message: '…' });
 *   window.Toast.dismiss(id);
 *
 * kinds: 'info' | 'progress' | 'success' | 'error'
 *   - 'progress' toasts never auto-dismiss (something is still happening);
 *     update them to 'success'/'error' when the work finishes.
 *   - 'error' lingers longer than info/success; pass `sticky: true` to keep
 *     any toast until the user (or code) dismisses it.
 */

(function () {
  const { useState, useEffect } = React;

  let toasts = [];
  let seq = 1;
  const listeners = new Set();
  const timers = new Map();

  function emit() {
    for (const fn of listeners) { try { fn(toasts); } catch (e) { console.warn('[toast] listener', e); } }
  }

  function scheduleAutoDismiss(t) {
    if (timers.has(t.id)) { clearTimeout(timers.get(t.id)); timers.delete(t.id); }
    if (t.sticky || t.kind === 'progress') return; // keep until resolved
    const ttl = t.kind === 'error' ? 9000 : 4500;
    timers.set(t.id, setTimeout(() => dismiss(t.id), ttl));
  }

  function push(t) {
    const id = t.id || `t${seq++}`;
    const existing = toasts.find(x => x.id === id);
    const merged = { id, kind: 'info', createdAt: Date.now(), ...t };
    toasts = existing
      ? toasts.map(x => (x.id === id ? { ...x, ...merged } : x))
      : [...toasts, merged];
    scheduleAutoDismiss(toasts.find(x => x.id === id));
    emit();
    return id;
  }

  function update(id, patch) {
    const existing = toasts.find(x => x.id === id);
    if (!existing) return push({ id, ...patch });
    toasts = toasts.map(x => (x.id === id ? { ...x, ...patch } : x));
    scheduleAutoDismiss(toasts.find(x => x.id === id));
    emit();
    return id;
  }

  function dismiss(id) {
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    toasts = toasts.filter(x => x.id !== id);
    emit();
  }

  window.Toast = {
    push,
    update,
    dismiss,
    subscribe(fn) { listeners.add(fn); fn(toasts); return () => listeners.delete(fn); },
  };

  function glyphFor(kind) {
    if (kind === 'error')    return '⚠';
    if (kind === 'success')  return '✓';
    if (kind === 'progress') return '⟳';
    return '•';
  }

  function ToastHost() {
    const [items, setItems] = useState(toasts);
    useEffect(() => window.Toast.subscribe(setItems), []);
    if (!items.length) return null;
    return (
      <div className="toast-host">
        {items.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`} role="status">
            <div className={`toast-glyph ${t.kind === 'progress' ? 'spin' : ''}`}>{glyphFor(t.kind)}</div>
            <div className="toast-body">
              {t.title && <div className="toast-title">{t.title}</div>}
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            <button className="toast-x" onClick={() => window.Toast.dismiss(t.id)} title="dismiss">×</button>
          </div>
        ))}
      </div>
    );
  }

  window.ToastHost = ToastHost;
})();
