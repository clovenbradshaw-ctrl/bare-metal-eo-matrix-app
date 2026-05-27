/* recovery-modal.jsx — Recovery-key + vault-unlock UI
 *
 * Three pieces:
 *
 *   <window.RecoveryHost />      — registers the global recovery-key
 *                                  callbacks that the Matrix bridge
 *                                  triggers during cross-signing setup
 *                                  and key-backup restore. Renders
 *                                  blocking modals so the user actually
 *                                  saves / supplies the recovery key
 *                                  instead of dismissing a browser alert.
 *
 *   <window.EncryptionBanner />  — surfaces `MatrixLive.getEncryptionStatus()`
 *                                  with a "history locked — restore"
 *                                  prompt when the SDK has Megolm
 *                                  ciphertext it cannot decrypt.
 *
 *   <window.VaultUnlockBanner /> — when the bridge auto-restored the
 *                                  Matrix session at cold boot but the
 *                                  vault password isn't entered yet,
 *                                  prompts the user to unlock so saves
 *                                  can flow to disk.
 */

(function () {
const { useState, useEffect, useRef, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────────
// RecoveryHost
// ─────────────────────────────────────────────────────────────────────────

function SaveRecoveryKeyModal({ keyText, onConfirm }) {
  const [echo, setEcho] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();
  const matches = normalize(echo) === normalize(keyText);

  async function copy() {
    try {
      await navigator.clipboard.writeText(keyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Browser blocked clipboard; the textarea fallback is still selectable.
    }
  }

  function download() {
    const blob = new Blob([
      'Matrix recovery key — keep this safe.\n\n',
      keyText,
      '\n\nIf you lose access to this device, you will need this exact key ',
      'to recover your end-to-end encrypted history.\n',
    ], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'matrix-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function confirm() {
    if (!matches || busy) return;
    setBusy(true);
    onConfirm();
  }

  return (
    <div className="share-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="share-card" style={{maxWidth:520}} onClick={e => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">save your recovery key</div>
            <div className="share-sub">
              This is the only way to read your encrypted history if you
              clear browser data, lose this device, or sign in elsewhere.
              Anyone with this key can read your messages — store it like
              a password.
            </div>
          </div>
        </div>
        <div className="share-section">
          <textarea
            readOnly
            value={keyText}
            onFocus={(e) => e.target.select()}
            style={{
              width:'100%', minHeight:80, padding:'10px 12px',
              fontFamily:'var(--mono)', fontSize:13, fontWeight:600,
              border:'1px solid var(--border-strong)',
              background:'var(--surface-2)', resize:'none',
              wordBreak:'break-all',
            }}
          />
          <div style={{display:'flex', gap:8, marginTop:8}}>
            <button className="topbar-members" onClick={copy}>
              {copied ? 'copied ✓' : 'copy'}
            </button>
            <button className="topbar-members" onClick={download}>
              download .txt
            </button>
          </div>
        </div>
        <div className="share-section">
          <div className="share-section-label">
            paste it back to confirm you've saved it
          </div>
          <input
            value={echo}
            onChange={(e) => setEcho(e.target.value)}
            placeholder="paste your recovery key here"
            spellCheck={false}
            autoComplete="off"
            style={{
              width:'100%', fontFamily:'var(--mono)', fontSize:13,
              padding:'8px 11px',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches) confirm(); }}
          />
          <div className="login-hint" style={{marginTop:6}}>
            {matches
              ? '✓ matches — click "I\'ve saved it" below'
              : echo ? 'doesn\'t match yet' : ''}
          </div>
        </div>
        <div className="share-section" style={{borderTop:'1px solid var(--border)'}}>
          <div className="login-actions">
            <button
              className="login-primary"
              disabled={!matches || busy}
              onClick={confirm}
            >
              {busy ? '…' : 'I\'ve saved it'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PromptRecoveryKeyModal({ onSubmit, onSkip }) {
  const [val, setVal] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit() {
    const trimmed = val.trim();
    if (!trimmed) { setErr('Paste your recovery key, or skip.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setErr(e?.message || 'Invalid recovery key — try again.');
      setBusy(false);
    }
  }

  return (
    <div className="share-overlay">
      <div className="share-card" style={{maxWidth:480}} onClick={e => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">unlock encrypted history</div>
            <div className="share-sub">
              Paste the recovery key you saved when this account was set
              up. Without it, messages encrypted on previous devices will
              show as unreadable.
            </div>
          </div>
        </div>
        <div className="share-section">
          <textarea
            ref={inputRef}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="paste your recovery key"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            style={{
              width:'100%', minHeight:60, fontFamily:'var(--mono)',
              fontSize:13, padding:'9px 12px',
              border:'1px solid var(--border-strong)',
              background:'#fff', resize:'none', wordBreak:'break-all',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                e.preventDefault(); submit();
              }
            }}
          />
          {err && <div className="login-err" style={{marginTop:6}}>{err}</div>}
          <div className="login-actions" style={{marginTop:10, display:'flex', gap:8}}>
            <button className="login-primary" disabled={busy || !val.trim()} onClick={submit}>
              {busy ? 'restoring…' : 'unlock'}
            </button>
            <button
              className="topbar-members"
              disabled={busy}
              onClick={() => onSkip()}
              title="continue without decrypting old messages — new messages will still work"
            >skip — keep history locked</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecoveryHost() {
  const [displayKey, setDisplayKey] = useState(null);
  const [displayResolve, setDisplayResolve] = useState(null);
  const [promptResolve, setPromptResolve] = useState(null);

  useEffect(() => {
    window.__matrixLiveRecoveryDisplay = (key, resolve) => {
      setDisplayKey(key);
      // wrap so a single state update stores the resolver function
      setDisplayResolve(() => resolve);
    };
    window.__matrixLiveRecoveryPrompt = (resolve) => {
      setPromptResolve(() => resolve);
    };
    return () => {
      delete window.__matrixLiveRecoveryDisplay;
      delete window.__matrixLiveRecoveryPrompt;
    };
  }, []);

  function onSaveConfirm() {
    if (displayResolve) displayResolve();
    setDisplayKey(null);
    setDisplayResolve(null);
  }
  async function onPromptSubmit(val) {
    const resolve = promptResolve;
    setPromptResolve(null);
    if (resolve) resolve(val);
  }
  function onPromptSkip() {
    const resolve = promptResolve;
    setPromptResolve(null);
    if (resolve) resolve(null);
  }

  return (
    <>
      {displayKey && (
        <SaveRecoveryKeyModal keyText={displayKey} onConfirm={onSaveConfirm} />
      )}
      {promptResolve && (
        <PromptRecoveryKeyModal onSubmit={onPromptSubmit} onSkip={onPromptSkip} />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// EncryptionBanner — surfaces history-locked / no-backup states
// ─────────────────────────────────────────────────────────────────────────

function EncryptionBanner() {
  const [status, setStatus] = useState(() =>
    window.MatrixLive?.getEncryptionStatus?.() || 'unknown'
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const ML = window.MatrixLive;
    if (!ML?.subscribe) return;
    return ML.subscribe((reason) => {
      if (reason === 'encryption') {
        setStatus(ML.getEncryptionStatus?.() || 'unknown');
      }
    });
  }, []);

  if (status !== 'history-locked') return null;

  async function retry() {
    setBusy(true); setErr(null);
    try {
      await window.MatrixLive.retryKeyBackup();
    } catch (e) {
      setErr(e?.message || 'Could not unlock history. Recovery key may be wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="enc-banner">
      <div className="enc-banner-body">
        <div className="enc-banner-title">encrypted history locked</div>
        <div className="enc-banner-sub">
          messages from previous sessions are stored on the server but
          encrypted with keys this browser doesn't have. paste your
          recovery key to decrypt them.
        </div>
        {err && <div className="enc-banner-err">{err}</div>}
      </div>
      <button
        className="enc-banner-btn"
        onClick={retry}
        disabled={busy}
      >{busy ? 'restoring…' : 'unlock history'}</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// VaultUnlockBanner — auto-restored session, vault locked
// ─────────────────────────────────────────────────────────────────────────

function VaultUnlockBanner({ session }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  if (!session || !session.vaultLocked || session.demo) return null;

  async function submit() {
    const password = pw;
    if (!password) { setErr('enter your matrix password'); return; }
    setBusy(true); setErr(null);
    try {
      // Re-running login walks through `mxUnlock` first; that derives
      // the vault key and brings up live writes without restarting the
      // already-running client.
      await window.MatrixLive.login({
        homeserver: session.homeserver || '',
        username: session.mxid,
        password,
      });
      setOpen(false);
      setPw('');
    } catch (e) {
      setErr(e?.message || 'unlock failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="enc-banner enc-banner-warn">
        <div className="enc-banner-body">
          <div className="enc-banner-title">local cache locked</div>
          <div className="enc-banner-sub">
            you're signed in and can read your spaces, but saves are
            paused until you enter your password.
          </div>
        </div>
        <button className="enc-banner-btn" onClick={() => setOpen(true)}>
          unlock
        </button>
      </div>
      {open && (
        <div className="share-overlay" onClick={() => !busy && setOpen(false)}>
          <div className="share-card" style={{maxWidth:380}} onClick={e => e.stopPropagation()}>
            <div className="share-head">
              <div>
                <div className="share-title">unlock local cache</div>
                <div className="share-sub">enter your matrix password</div>
              </div>
              <button className="share-close" onClick={() => !busy && setOpen(false)}>×</button>
            </div>
            <div className="share-section">
              <input
                ref={inputRef}
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="••••••••"
                disabled={busy}
                style={{width:'100%', padding:'8px 11px', fontSize:13}}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) submit(); }}
              />
              {err && <div className="login-err" style={{marginTop:6}}>{err}</div>}
              <div className="login-actions" style={{marginTop:10}}>
                <button className="login-primary" disabled={busy || !pw} onClick={submit}>
                  {busy ? 'unlocking…' : 'unlock'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

Object.assign(window, {
  RecoveryHost,
  EncryptionBanner,
  VaultUnlockBanner,
});

})();
