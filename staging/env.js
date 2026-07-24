/* CP.env — which environment is this page running in? (+ staging storage isolation)
 *
 * Contract (frozen — docs/superpowers/plans/2026-07-21-staging-live-split.md, A
 * and docs/superpowers/plans/2026-07-22-fix-wave-staging-live.md, CONTRACT A):
 *   Deploy injects <script>window.__CP_ENV='live'<\/script> (root build) or
 *   ='staging' (/staging/ build) into each app's <head>, next to __CP_BUILD.
 *   (Closer escaped as <\/script> so this file stays safe to INLINE into an HTML
 *   page — the standard jsdom harness method. A raw closer would end the script
 *   element early and blank the page.)
 *   This file MUST be the FIRST script in every app — before data.js,
 *   auth-gate.js and onboarding.js, all of which branch on CP.env.
 *
 * Defaults when nothing is injected:
 *   - real browser  -> 'staging'  (opening a raw prototype locally behaves like
 *                                  staging: demo data + the 1111111 gate)
 *   - jsdom         -> 'dev'      (every headless suite: gates stay INERT)
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORAGE SHIM EXISTS (root cause #1 of the 2026-07-22 fix wave)
 *
 * GitHub Pages serves LIVE at /cia-paulista-app/ and STAGING at
 * /cia-paulista-app/staging/ — the SAME ORIGIN, therefore ONE localStorage.
 * Without isolation: staging queues writes into `cp_data_queue` carrying the
 * real tenant id (any later LIVE page flushes them to production), staging
 * renders and can mutate the real `cp_members` PII, staging's fake leads land
 * in the inbox the live console drains, and the staging Reset wipes the live
 * member-app binding.
 *
 * So in STAGING ONLY this file swaps window.localStorage for a namespaced
 * Proxy over the real store: every key is transparently prefixed `stg::`.
 * Live and jsdom/dev are NEVER touched — they keep the raw store, byte for
 * byte, so the live app and all seven headless suites behave exactly as before.
 *
 * The Proxy (not a plain object) is what makes direct property access work:
 * `localStorage.cp_sync = x` / `localStorage.cp_sync` / `delete localStorage.x`
 * / `'x' in localStorage` / `Object.keys(localStorage)` all namespace too, not
 * just the getItem/setItem/removeItem/clear/key/length API.
 *
 * Fail-soft, always: if Proxy or defineProperty is unavailable (locked-down
 * embeds, ancient browsers), storage is left exactly as-is, nothing is logged,
 * and CP.env.storageIsolated stays false so the STAGING chip can say so plainly.
 *
 * Idempotent: env.js loads twice on the deployed build (head-injected safety
 * net + the app's own <script src="env.js"> tag). The second run detects the
 * shim and does not double-wrap (which would produce `stg::stg::` keys) and
 * does not double-register the reset listener.
 * ---------------------------------------------------------------------------
 *
 * Tiny, dependency-free, and safe to load first: it only reads two globals and
 * never throws, so it can never delay or break the host app.
 */
(function () {
  window.CP = window.CP || {};

  var isJsdom = false;
  try { isJsdom = /jsdom/i.test(navigator.userAgent || ''); } catch (e) {}
  var name = window.__CP_ENV || (isJsdom ? 'dev' : 'staging');

  var PREFIX = 'stg::';           // frozen: staging namespace for every key
  var MARK = '__cpStagingShim';   // shim self-identification (value = PREFIX)
  var RAWREF = '__cpRaw';         // shim -> underlying real Storage

  var env = {
    name: name,
    isStaging: name === 'staging',
    isLive: name === 'live',
    isJsdom: isJsdom,
    // true only once the staging namespacing shim is actually installed.
    // Always false on live / dev (nothing to isolate: they own the origin).
    storageIsolated: false,
  };
  window.CP.env = env;

  // The REAL store. Reading it can throw (cookies disabled, sandboxed iframe).
  // If a previous env.js run already shimmed it, unwrap back to the real one so
  // reset/enumeration always operate on true `stg::`-prefixed keys.
  var rawLS = null;
  try { rawLS = window.localStorage; } catch (e) { rawLS = null; }
  try { if (rawLS && rawLS[MARK] === PREFIX && rawLS[RAWREF]) rawLS = rawLS[RAWREF]; } catch (e) {}

  // Real keys currently in the staging namespace, returned UNPREFIXED
  // (i.e. as the app sees them).
  function stagingKeys() {
    var out = [];
    try {
      for (var i = 0; i < rawLS.length; i++) {
        var k = rawLS.key(i);
        if (k != null && String(k).indexOf(PREFIX) === 0) out.push(String(k).slice(PREFIX.length));
      }
    } catch (e) {}
    return out;
  }

  /* CP.env.resetStaging() — wipe this staging environment and start over.
   * Removes every `stg::` key (and NOTHING else — live data is untouched by
   * construction) then reloads. No-op returning false on live / dev. */
  env.resetStaging = function () {
    if (!window.CP.env.isStaging) return false;
    if (rawLS) {
      var doomed = [];
      try {
        for (var i = 0; i < rawLS.length; i++) {
          var k = rawLS.key(i);
          if (k != null && String(k).indexOf(PREFIX) === 0) doomed.push(k);
        }
      } catch (e) {}
      for (var j = 0; j < doomed.length; j++) {
        try { rawLS.removeItem(doomed[j]); } catch (e) {}
      }
    }
    try { window.location.reload(); } catch (e) {}
    return true;
  };

  /* The generic staging reset channel. Registered in EVERY app (that is the
   * point — four apps had no listener of their own, so the shell's Reset button
   * silently did nothing there). ACK first, then reset, so the shell can show a
   * truthful "Reset ✓" instead of an optimistic one. Inert on live/dev. */
  /* Only the shell that framed us may drive this: the message must come from our
   * OWN parent window and from this same origin. Without both checks any window
   * holding a handle to this page could wipe the staging namespace (auth-gate.js
   * applies the identical rule to its own listener). '' / 'null' are allowed so a
   * file:// copy — which reports an opaque origin — still works locally. */
  function trustedReset(ev) {
    try {
      if (!ev || ev.source !== window.parent || window.parent === window) return false;
      var o = ev.origin;
      return o === window.location.origin || o === '' || o === 'null';
    } catch (e) { return false; }
  }

  if (!window.__CP_ENV_RESET_WIRED) {
    window.__CP_ENV_RESET_WIRED = true;
    try {
      window.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || typeof d !== 'object' || d.type !== 'cp-staging-reset') return;
        if (!window.CP || !window.CP.env || !window.CP.env.isStaging) return;
        if (!trustedReset(ev)) return;
        try {
          if (ev.source && typeof ev.source.postMessage === 'function') {
            ev.source.postMessage({ type: 'cp-staging-reset-ack' }, '*');
          }
        } catch (e) {}
        try { window.CP.env.resetStaging(); } catch (e) {}
      }, false);
    } catch (e) {}
  }

  // ---- staging only from here down -----------------------------------------
  if (!env.isStaging || !rawLS) return;

  // Already shimmed by an earlier env.js run in this document: do not re-wrap.
  try {
    if (window.localStorage && window.localStorage[MARK] === PREFIX) {
      env.storageIsolated = true;
      return;
    }
  } catch (e) {}

  var hasOwn = function (o, p) { return Object.prototype.hasOwnProperty.call(o, p); };

  // The Storage API surface, every key transparently prefixed.
  var api = {
    getItem: function (k) {
      try { return rawLS.getItem(PREFIX + String(k)); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try { rawLS.setItem(PREFIX + String(k), String(v)); } catch (e) {}
    },
    removeItem: function (k) {
      try { rawLS.removeItem(PREFIX + String(k)); } catch (e) {}
    },
    // Scoped: clears the staging namespace only, never a live key.
    clear: function () {
      var ks = stagingKeys();
      for (var i = 0; i < ks.length; i++) {
        try { rawLS.removeItem(PREFIX + ks[i]); } catch (e) {}
      }
    },
    // Scoped: enumerates the staging namespace only.
    key: function (i) {
      var ks = stagingKeys();
      var n = Number(i);
      if (!isFinite(n)) n = 0;
      n = n < 0 ? Math.ceil(n) : Math.floor(n);
      return n >= 0 && n < ks.length ? ks[n] : null;
    },
  };

  var shim = null;
  try {
    shim = new Proxy(api, {
      get: function (t, prop) {
        if (typeof prop === 'symbol') return t[prop];
        if (prop === MARK) return PREFIX;
        if (prop === RAWREF) return rawLS;
        if (prop === 'length') return stagingKeys().length;
        if (hasOwn(api, prop)) return api[prop];
        var v = api.getItem(prop);
        return v === null ? undefined : v;   // property access: missing => undefined
      },
      set: function (t, prop, val) {
        if (typeof prop === 'symbol') { t[prop] = val; return true; }
        if (prop === 'length' || prop === MARK || prop === RAWREF || hasOwn(api, prop)) return true;
        api.setItem(prop, val);
        return true;
      },
      has: function (t, prop) {
        if (typeof prop === 'symbol') return prop in t;
        if (prop === 'length' || hasOwn(api, prop)) return true;
        return api.getItem(prop) !== null;
      },
      deleteProperty: function (t, prop) {
        if (typeof prop === 'symbol') { delete t[prop]; return true; }
        api.removeItem(prop);
        return true;
      },
      ownKeys: function () { return stagingKeys(); },
      getOwnPropertyDescriptor: function (t, prop) {
        if (typeof prop === 'symbol' || hasOwn(api, prop)) {
          return Object.getOwnPropertyDescriptor(t, prop);
        }
        var v = api.getItem(prop);
        if (v === null) return undefined;
        return { value: v, writable: true, enumerable: true, configurable: true };
      },
      defineProperty: function (t, prop, desc) {
        if (typeof prop === 'symbol') { Object.defineProperty(t, prop, desc); return true; }
        if (desc && hasOwn(desc, 'value')) api.setItem(prop, desc.value);
        return true;
      },
    });
  } catch (e) { shim = null; }   // no Proxy in this engine -> fail soft

  if (!shim) return;

  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
    env.storageIsolated = (window.localStorage === shim);
  } catch (e) {
    env.storageIsolated = false;  // log nothing; staging still runs, just unisolated
  }
})();
