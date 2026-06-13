/* airtable-coordinator.js — turn-taking for Airtable sync over Matrix.
 *
 * Two directions, two policies (per the product rule "all changes sync TO
 * Airtable; raise your hand to sync FROM Airtable, so as not to spam either db"):
 *
 *   PUSH  (workspace → Airtable):  every member drains their OWN local changes
 *         automatically. No hand needed — each change is authored once, so it's
 *         pushed once; nobody duplicates anyone. Implemented as a pluggable
 *         `window.AirtablePush` drain (staged — see the seam at bottom).
 *
 *   PULL  (Airtable → workspace):  turn-based. A member RAISES A HAND to claim
 *         the puller role; exactly one member pulls at a time so N clients don't
 *         all replay the same webhook diff and race the cursor. airtable-sync.js
 *         already serializes a single member's TABS via its `runner` lease; this
 *         layer elects ONE MEMBER among the raised hands and only starts the
 *         sync loop there.
 *
 * Election (deterministic, off the fold so every client agrees):
 *   - raised hands live at `_schema.airtable_hands.<baseId>.<userId> = {raised,ts}`
 *     (anchorless DEF survives the fold only under `_schema.`);
 *   - the HEAD is the earliest raiser (min ts, tiebreak userId) — your turn is
 *     granted in the order hands went up;
 *   - the head runs the loop. Its `tick` renews the sync `runner` lease, which
 *     is the liveness signal. If that lease goes stale (head's tab closed /
 *     crashed) for a grace window, the next raised hand takes over — so an
 *     offline head can't wedge the queue. When the head lowers its hand, the
 *     turn passes to the next automatically.
 *
 * The token itself never lives here or in the log: it's pulled on demand from
 * MatrixLive.getSharedAirtableToken (WCK-unsealed from room state, memory-only).
 *
 *   window.AirtableCoord.attach({ roomId, baseId, userId, displayName,
 *                                 getState, emit, log })
 *   window.AirtableCoord.detach()
 *   window.AirtableCoord.raiseHand() / lowerHand()
 *   window.AirtableCoord.status()        // for the sync page UI
 *   window.AirtableCoord.onChange(fn)    // re-render hook
 */

(function () {
  'use strict';

  const POLL_MS = 15_000;                 // mirror airtable-sync's cadence
  const LEASE_STALE_MS = POLL_MS * 3;     // a runner lease older than this is dead
  const GRACE_MS = 45_000;                // wait this long before a non-head takes a dead head's turn
  const EVAL_DEBOUNCE_MS = 400;

  const HANDS_PATH = (baseId) => `_schema.airtable_hands.${baseId}`;

  function readHands(state, baseId) {
    return state?.schema?.airtable_hands?.[baseId] || {};
  }
  function raisedSorted(state, baseId) {
    const hands = readHands(state, baseId);
    return Object.keys(hands)
      .map(userId => ({ userId, ...(hands[userId] || {}) }))
      .filter(h => h.raised)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.userId.localeCompare(b.userId));
  }
  function syncRunner(state, baseId) {
    return state?.schema?.sync?.airtable?.[baseId]?.runner || null;
  }

  const Coord = {
    _ctx: null,            // { roomId, baseId, userId, displayName, getState, emit, log }
    _unsub: null,          // MatrixLive subscription
    _evalTimer: null,
    _pollTimer: null,
    _running: false,       // are WE currently driving AirtableSync?
    _token: null,          // resolved shared token (memory only)
    _badSince: 0,          // first time we saw the head's lease unhealthy while non-head
    _listeners: new Set(),
    _lastStatus: null,
    _pushStarted: false,

    attach(ctx) {
      if (!ctx || !ctx.roomId || !ctx.baseId || !ctx.userId ||
          typeof ctx.getState !== 'function' || typeof ctx.emit !== 'function') {
        throw new Error('attach needs { roomId, baseId, userId, getState, emit }');
      }
      // Re-attaching to the same (room, base) is a no-op refresh of the ctx.
      const same = this._ctx && this._ctx.roomId === ctx.roomId && this._ctx.baseId === ctx.baseId;
      if (!same) this.detach();
      this._ctx = { log: () => {}, displayName: null, ...ctx };
      if (!same) {
        this._badSince = 0;
        this._token = null;
        const ML = window.MatrixLive;
        if (ML?.subscribe) {
          this._unsub = ML.subscribe((reason) => {
            // 'airtable' → a PAT share changed (new / revoked); drop the cached
            // token so we re-resolve. 'events' → the fold changed (hands/lease).
            if (reason === 'airtable') this._token = null;
            if (['events', 'airtable', 'members'].includes(reason)) this._scheduleEval();
          });
        }
        // The lease can go stale with no event firing (a head tab simply
        // closes), so re-evaluate on a slow timer too.
        this._pollTimer = setInterval(() => this._scheduleEval(), POLL_MS);
      }
      this._scheduleEval();
      return this.status();
    },

    detach() {
      if (this._unsub) { try { this._unsub(); } catch {} this._unsub = null; }
      if (this._evalTimer) { clearTimeout(this._evalTimer); this._evalTimer = null; }
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      if (this._running && window.AirtableSync?.stop) { try { window.AirtableSync.stop(); } catch {} }
      if (this._pushStarted && window.AirtablePush?.stop) { try { window.AirtablePush.stop(); } catch {} }
      this._running = false;
      this._pushStarted = false;
      this._ctx = null;
      this._token = null;
      this._badSince = 0;
    },

    // ── Hand controls (emit into the fold; every client re-elects) ──
    raiseHand() {
      const c = this._ctx; if (!c) return;
      this._writeHand(true);
    },
    lowerHand() {
      const c = this._ctx; if (!c) return;
      this._writeHand(false);
    },
    _writeHand(raised) {
      const c = this._ctx;
      const ME = window.MatrixEngine;
      const state = c.getState();
      const hands = { ...readHands(state, c.baseId) };
      hands[c.userId] = { raised, ts: Date.now(), name: c.displayName || undefined };
      c.emit(ME.OP.DEF, { anchor: null, path: HANDS_PATH(c.baseId), value: hands });
      this._scheduleEval();
      this._emitChange();
    },
    myHandRaised() {
      const c = this._ctx; if (!c) return false;
      return !!readHands(c.getState(), c.baseId)[c.userId]?.raised;
    },

    // ── Election ──
    // Who SHOULD be pulling right now, accounting for a dead head.
    _electedRunner() {
      const c = this._ctx; if (!c) return null;
      const state = c.getState();
      const raised = raisedSorted(state, c.baseId);
      if (!raised.length) return null;
      const runner = syncRunner(state, c.baseId);
      const leaseHealthy = runner && (Date.now() - (runner.ts || 0)) < LEASE_STALE_MS;
      const head = raised[0].userId;
      if (leaseHealthy) { this._badSince = 0; return head; }
      // No healthy lease. The head should (re)claim it; give it a grace window
      // before a non-head takes over, so a head that's merely starting up wins.
      if (!this._badSince) this._badSince = Date.now();
      if ((Date.now() - this._badSince) > GRACE_MS && raised.length > 1) {
        return raised[1].userId; // head looks gone — promote the next in line
      }
      return head;
    },

    // Resolve the shared token, retrying until it succeeds: a freshly-arrived
    // share can't be unsealed until our workspace key syncs, so a null result is
    // NOT cached as final — the 15s poll + fold events re-attempt. Once held, we
    // short-circuit until an 'airtable' notify (re-share / revoke) clears it.
    async _resolveToken() {
      if (this._token) return this._token;
      const ML = window.MatrixLive;
      const c = this._ctx;
      if (!ML?.getSharedAirtableToken || !c) return null;
      try { this._token = await ML.getSharedAirtableToken(c.roomId); }
      catch { this._token = null; }
      return this._token;
    },

    _scheduleEval() {
      if (this._evalTimer) return;
      this._evalTimer = setTimeout(() => { this._evalTimer = null; this._evaluate(); }, EVAL_DEBOUNCE_MS);
    },

    async _evaluate() {
      const c = this._ctx;
      if (!c) return;
      const token = await this._resolveToken();
      // ── PUSH: every member drains their own changes, token permitting. ──
      this._drivePush(token);
      // ── PULL: only the elected member runs the inbound loop. ──
      const elected = this._electedRunner();
      const iAmElected = elected === c.userId;
      const wantPull = iAmElected && !!token;
      if (wantPull && !this._running) this._startPull(token);
      else if (!wantPull && this._running) this._stopPull();
      this._emitChange();
    },

    _startPull(token) {
      const c = this._ctx;
      if (!window.AirtableSync?.start) { c.log('airtable: sync engine not loaded'); return; }
      this._running = true;
      Promise.resolve(window.AirtableSync.start({
        roomId: c.roomId, baseId: c.baseId, token,
        getState: c.getState, emit: c.emit, log: c.log,
      })).catch(e => {
        this._running = false;
        c.log('airtable: could not start sync — ' + (e?.message || e));
        this._emitChange();
      });
    },
    _stopPull() {
      this._running = false;
      if (window.AirtableSync?.stop) { try { window.AirtableSync.stop(); } catch {} }
    },

    // ── PUSH seam ──
    // The symmetric "operator log → Airtable" drain is a SEPARATE module
    // (window.AirtablePush), the same way airtable-sync.js plugs in for PULL.
    // When it's present we start it for THIS member's own changes (no hand —
    // push is automatic for everyone). Until then this is a no-op and status()
    // reports `pushPending` so the UI can say push isn't wired yet.
    _drivePush(token) {
      const c = this._ctx;
      const can = !!token && !!window.AirtablePush?.start;
      if (can && !this._pushStarted) {
        this._pushStarted = true;
        Promise.resolve(window.AirtablePush.start({
          roomId: c.roomId, baseId: c.baseId, token,
          getState: c.getState, emit: c.emit, log: c.log,
        })).catch(e => {
          this._pushStarted = false;
          c.log('airtable: push drain failed to start — ' + (e?.message || e));
        });
      } else if (!token && this._pushStarted && window.AirtablePush?.stop) {
        try { window.AirtablePush.stop(); } catch {}
        this._pushStarted = false;
      }
    },

    // ── Status / subscription for the UI ──
    status() {
      const c = this._ctx;
      if (!c) return { attached: false };
      const state = c.getState();
      const raised = raisedSorted(state, c.baseId);
      const elected = this._electedRunner();
      const pushAvailable = !!window.AirtablePush?.start;
      const st = {
        attached: true,
        roomId: c.roomId,
        baseId: c.baseId,
        userId: c.userId,
        tokenShared: !!this._token,
        myHandRaised: !!readHands(state, c.baseId)[c.userId]?.raised,
        hands: raised.map(h => ({
          userId: h.userId,
          name: h.name || null,
          ts: h.ts || 0,
          active: h.userId === elected,
          me: h.userId === c.userId,
        })),
        elected,
        iAmActive: elected === c.userId && this._running,
        pull: (window.AirtableSync?.status && window.AirtableSync.status()) || { running: false },
        push: {
          available: pushAvailable,
          running: this._pushStarted,
          pending: !pushAvailable,   // the drain module hasn't been added yet
        },
      };
      this._lastStatus = st;
      return st;
    },

    onChange(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    },
    _emitChange() {
      const st = this.status();
      for (const fn of this._listeners) { try { fn(st); } catch {} }
    },
  };

  window.AirtableCoord = Coord;
})();
