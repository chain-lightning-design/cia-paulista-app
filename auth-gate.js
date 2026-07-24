/* CP auth gate — RBAC sign-in overlay for the STAFF apps.
 *
 * Contract (frozen — docs/superpowers/plans/2026-07-20-rbac-member-pwa.md):
 *   <script src="auth-gate.js" data-app="Owner Console" data-roles="owner,admin"><\/script>
 *   (escaped closer so this file stays safe to inline into an HTML page)
 *   - Inert when !window.CP?.data?.configured()  (pure-local pilot + every jsdom run).
 *   - When configured: full-screen OPAQUE overlay (Tatame theme) until CP.data.status()
 *     shows a signed-in user whose role is in data-roles. Subscribes to CP.data.onStatus.
 *   - Fail-soft: cached session + cached role (cp_role) => allowed through even with the
 *     cloud unreachable. The gate must never blank an already-authorized device.
 *   - No app code depends on the gate; on authorize it fades out and removes itself.
 *
 * Set a password (LIVE only, 2026-07-22 fix wave, Fix B item 8):
 *   After a magic-link sign-in the gate offers "Set a password for next time"
 *   (CP.data.client().auth.updateUser). An already-signed-in user reaches the same
 *   panel via `CP.authGate.setPassword()` or the `#set-password` hash. Never in
 *   staging (that path returns long before), never under jsdom.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var APP = (script && script.getAttribute('data-app')) || 'this app';
  var ROLES = ((script && script.getAttribute('data-roles')) || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);

  /* ---------------------------------------------------------- environment ---
   * Contract B (2026-07-21-staging-live-split): the gate behaves differently per
   * environment. The jsdom/dev guard below is deliberately the FIRST thing after
   * the tag attributes — every headless suite and the smoke run must see NO
   * overlay, in EITHER build, whatever __CP_ENV the deploy injected. isJsdom is
   * independent of the injected name for exactly this reason.
   * env.js missing (older page, direct file open) => ENV null => IS_STAGING false
   * => we fall through to the unchanged live path, which is inert unless the
   * cloud is configured. Backward-safe by construction.
   */
  var ENV = null;
  try { ENV = (window.CP && window.CP.env) || null; } catch (e) { ENV = null; }
  var IS_JSDOM = ENV ? !!ENV.isJsdom : false;
  if (!ENV) { try { IS_JSDOM = /jsdom/i.test(navigator.userAgent || ''); } catch (e) {} }
  if (IS_JSDOM || (ENV && ENV.name === 'dev')) return;
  var IS_STAGING = !!(ENV && ENV.isStaging);

  // Staging runs on demo data with the cloud OFF, so the live gate below would be
  // inert exactly where we most want a gate. Branch out before that check. The
  // staging code is never reachable from the live build, and the live path never
  // learns the staging code.
  if (IS_STAGING) { runStagingGate(); return; }

  // Password setup is a LIVE-only affordance. Staging returned above and jsdom/dev
  // returned above that, so this is belt-and-braces: it can only ever be true on
  // the real build (or a raw local copy with no env.js, where the cloud config
  // decides anyway).
  var ALLOW_PW = !IS_STAGING && !IS_JSDOM && !(ENV && (ENV.isStaging || ENV.name === 'dev'));
  var MIN_PW = 8;
  var PW_KEY = 'cp_pw_setup';           // {user_id, state:'set'|'later', at}
  var PW_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

  function data() { try { return (window.CP && window.CP.data) || null; } catch (e) { return null; } }

  // Shared DOM-ready helper (the staging gate below uses it too).
  function whenDomReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // ---- inert unless the shared data layer is present AND configured ----
  var d0 = data();
  try {
    if (!d0 || typeof d0.configured !== 'function' || !d0.configured() ||
        typeof d0.status !== 'function' || typeof d0.onStatus !== 'function' || !d0.auth) return;
  } catch (e) { return; }

  function allowed(role) { return !!role && ROLES.indexOf(String(role).toLowerCase()) !== -1; }

  function lsJson(k) {
    try { var v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); }
    catch (e) { return null; }
  }

  // Fail-soft check, fully synchronous: a cached Supabase session token plus the
  // cached cp_role (written by data.js on every successful role fetch) means this
  // device was already authorized — never show the overlay, even offline.
  function cachedAuth() {
    var role = lsJson('cp_role');
    if (!role || !allowed(role.role)) return null;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(String(k))) continue;
        var sess = lsJson(k);
        var uid = sess && ((sess.user && sess.user.id) ||
          (sess.currentSession && sess.currentSession.user && sess.currentSession.user.id));
        // Unparseable token still counts (fail-soft bias): a session exists here.
        if (!uid || uid === role.user_id) return role;
      }
    } catch (e) {}
    return null;
  }

  function statusAuth() {
    try { var st = data().status(); if (st && st.user && allowed(st.role)) return st; } catch (e) {}
    return null;
  }

  // Already authorized on this device? The overlay never mounts at all. (The UI
  // below is still BUILT — building it appends nothing to the document — so an
  // already-signed-in user can still open the "set a password" panel on demand.
  // Nothing is mounted, nothing is subscribed: the authorized device is untouched.)
  var PRE_AUTHORIZED = !!(statusAuth() || cachedAuth());

  /* ------------------------------------------------------------------ UI --- */
  // A hoisted function (not a var) so the staging gate, which runs and returns
  // long before this line, can still share exactly these styles.
  function gateCss() { return [
    '#cp-auth-gate{position:fixed;inset:0;z-index:2147483647;background:#0B0B0D;color:#E9E9EE;',
    '  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    '  -webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;',
    '  padding:calc(20px + env(safe-area-inset-top,0px)) 20px calc(20px + env(safe-area-inset-bottom,0px));',
    '  overflow:auto;opacity:1;transition:opacity .35s ease}',
    '#cp-auth-gate.cpag-out{opacity:0;pointer-events:none}',
    '#cp-auth-gate *{box-sizing:border-box;margin:0}',
    '#cp-auth-gate .cpag-col{width:100%;max-width:392px;margin:auto}',
    '#cp-auth-gate .cpag-brand{text-align:center;font-size:11px;font-weight:800;letter-spacing:.28em;color:#9A9AA2;margin-bottom:14px}',
    '#cp-auth-gate .cpag-card{background:#151517;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:26px 24px}',
    '#cp-auth-gate h1{font-size:21px;font-weight:800;letter-spacing:-.01em}',
    '#cp-auth-gate .cpag-sub{color:#9A9AA2;font-size:13.5px;margin-top:4px}',
    '#cp-auth-gate label{display:block;font-size:12px;font-weight:700;color:#9A9AA2;margin:16px 0 6px}',
    '#cp-auth-gate input{width:100%;background:#0B0B0D;color:#E9E9EE;border:1px solid rgba(255,255,255,.14);',
    // 16px minimum: below that, iOS Safari zooms the whole fixed overlay on focus.
    '  border-radius:11px;padding:11px 12px;font-size:16px;transition:border-color .15s}',
    '#cp-auth-gate input:focus{outline:none;border-color:rgba(255,255,255,.4)}',
    '#cp-auth-gate input::placeholder{color:#5c5c64}',
    '#cp-auth-gate .cpag-pwrow{position:relative}',
    '#cp-auth-gate .cpag-pwrow input{padding-right:58px}',
    '#cp-auth-gate .cpag-show{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:transparent;',
    '  color:#9A9AA2;font-size:12px;font-weight:700;padding:8px;cursor:pointer;border-radius:8px}',
    '#cp-auth-gate .cpag-show:hover{color:#E9E9EE}',
    '#cp-auth-gate button{font:inherit;cursor:pointer;transition:transform .06s ease,opacity .15s,background .15s}',
    '#cp-auth-gate button:active{transform:translateY(1px) scale(.995)}',
    '#cp-auth-gate button:disabled{opacity:.55;cursor:default;transform:none}',
    '#cp-auth-gate .cpag-primary{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;margin-top:18px;',
    '  background:#E11D2A;color:#fff;border:0;border-radius:12px;padding:12px 14px;font-size:15px;font-weight:800}',
    '#cp-auth-gate .cpag-primary:hover:not(:disabled){background:#c90f1c}',
    '#cp-auth-gate .cpag-secondary{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;',
    '  background:transparent;color:#E9E9EE;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:11px 14px;font-size:14.5px;font-weight:700}',
    '#cp-auth-gate .cpag-secondary:hover:not(:disabled){border-color:rgba(255,255,255,.34)}',
    '#cp-auth-gate .cpag-link{background:transparent;border:0;color:#9A9AA2;font-size:13.5px;font-weight:700;padding:10px;width:100%;text-align:center}',
    '#cp-auth-gate .cpag-link:hover{color:#E9E9EE}',
    '#cp-auth-gate .cpag-or{display:flex;align-items:center;gap:12px;color:#5c5c64;font-size:12px;font-weight:700;margin:18px 0 12px}',
    '#cp-auth-gate .cpag-or:before,#cp-auth-gate .cpag-or:after{content:"";flex:1;height:1px;background:rgba(255,255,255,.09)}',
    '#cp-auth-gate .cpag-hint{color:#75757d;font-size:12.5px;margin-top:8px;text-align:center}',
    '#cp-auth-gate .cpag-msg{display:none;margin-top:14px;font-size:13.5px;font-weight:600;border-radius:11px;padding:10px 12px;line-height:1.45}',
    '#cp-auth-gate .cpag-msg.cpag-err{display:block;color:#FF7B85;background:rgba(225,29,42,.09);border:1px solid rgba(225,29,42,.3)}',
    '#cp-auth-gate .cpag-msg.cpag-ok{display:block;color:#34D27B;background:rgba(52,210,123,.08);border:1px solid rgba(52,210,123,.25)}',
    '#cp-auth-gate .cpag-offline{display:none;margin-top:14px;font-size:13px;color:#9A9AA2;background:rgba(255,255,255,.04);',
    '  border:1px solid rgba(255,255,255,.09);border-radius:11px;padding:10px 12px;line-height:1.45}',
    '#cp-auth-gate.cpag-is-offline .cpag-offline{display:block}',
    '#cp-auth-gate .cpag-spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.28);border-top-color:#fff;',
    '  animation:cpagspin .7s linear infinite;flex:none}',
    '#cp-auth-gate .cpag-spin.cpag-spin-dim{border-color:rgba(255,255,255,.16);border-top-color:#9A9AA2}',
    '@keyframes cpagspin{to{transform:rotate(360deg)}}',
    '#cp-auth-gate .cpag-center{text-align:center;padding:6px 0}',
    '#cp-auth-gate .cpag-big{font-size:34px;line-height:1;margin-bottom:14px}',
    '#cp-auth-gate h2{font-size:18px;font-weight:800}',
    '#cp-auth-gate .cpag-body{color:#B9B9C0;font-size:14px;margin-top:8px;line-height:1.55}',
    '#cp-auth-gate .cpag-em{color:#E9E9EE;font-weight:700;overflow-wrap:anywhere}',
    '#cp-auth-gate .cpag-foot{text-align:center;color:#9A9AA2;font-size:11.5px;margin-top:14px}',
    '#cp-auth-gate .cpag-recover{color:#9A9AA2;font-size:12.5px;margin-top:10px;line-height:1.5}',
    '#cp-auth-gate .cpag-rule{color:#75757d;font-size:12px;margin-top:6px}',
    '@media (prefers-reduced-motion:reduce){#cp-auth-gate,#cp-auth-gate button{transition:none}#cp-auth-gate .cpag-spin{animation-duration:1.4s}}',
  ].join('\n'); }

  var overlay = document.createElement('div');
  overlay.id = 'cp-auth-gate';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Sign in to ' + APP);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function spin(dim) { return el('span', 'cpag-spin' + (dim ? ' cpag-spin-dim' : '')); }

  var col = el('div', 'cpag-col');
  col.appendChild(el('div', 'cpag-brand', 'CIA PAULISTA'));
  var card = el('div', 'cpag-card');
  col.appendChild(card);
  col.appendChild(el('div', 'cpag-foot', 'Team access only · members don’t need to sign in here'));
  overlay.appendChild(col);

  /* ================================================================ v2 ===
   * Wave-2 sign-in experience (2026-07-22 auth-system-design D2/D3/D6).
   * Primary sign-in = 6-digit email code; Google (config-gated); password is a
   * collapsed fallback; per-role session caps; kiosk idle relock; account chip.
   * Everything below is LIVE-only: jsdom/dev/staging returned long before here.
   */
  var SLUG = String(APP || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
  var IS_KIOSK = SLUG === 'check-in-kiosk';   // kiosk.html declares data-app="Check-in Kiosk"
  var FRONTDESK_CAP_MS = 12 * 60 * 60 * 1000; // hard cap from sign-in
  var SLIDE_CAP_MS = 14 * 24 * 60 * 60 * 1000; // owner/admin/instructor sliding on activity
  var RESEND_MS = 30000;                       // resend link/code appears after 30s
  var RELOCK_IDLE_MS = 10 * 60 * 1000;         // kiosk relocks after 10 min idle
  try { if (typeof window !== 'undefined' && window.__CP_TEST_RELOCK_MS) RELOCK_IDLE_MS = window.__CP_TEST_RELOCK_MS; } catch (e) {}
  try { if (typeof window !== 'undefined' && window.__CP_TEST_RESEND_MS) RESEND_MS = window.__CP_TEST_RESEND_MS; } catch (e) {}
  var SESSION_KEY = 'cp_session_meta';         // {uid,started,lastActive} (plain LS → stg:: proxy namespaces it)
  var RELOCK_KEY = 'cp_kiosk_relock';          // {v,salt,hash,uid}

  // Live-only CSS (code boxes, Google button, disclosure, account chip, relock).
  // Injected in the SAME style block as gateCss() but ONLY in the live path, so the
  // shared staging overlay styling stays byte-for-byte what it was.
  function liveCss() { return [
    '#cp-auth-gate .cpag-codes{display:flex;gap:8px;justify-content:center;margin:18px 0 6px}',
    '#cp-auth-gate .cpag-pins{display:flex;gap:10px;justify-content:center;margin:18px 0 6px}',
    '#cp-auth-gate .cpag-box{width:44px;height:54px;background:#0B0B0D;color:#E9E9EE;border:1px solid rgba(255,255,255,.16);',
    '  border-radius:11px;text-align:center;font-size:22px;font-weight:800;padding:0;transition:border-color .15s}',
    '#cp-auth-gate .cpag-box:focus{outline:none;border-color:rgba(255,255,255,.5)}',
    '.cpag-shake{animation:cpagshake .4s cubic-bezier(.36,.07,.19,.97)}',
    '@keyframes cpagshake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}',
    '  30%,50%,70%{transform:translateX(-5px)}40%,60%{transform:translateX(5px)}}',
    '#cp-auth-gate .cpag-google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:12px;',
    '  background:#fff;color:#1a1a1a;border:0;border-radius:12px;padding:11px 14px;font-size:14.5px;font-weight:800}',
    '#cp-auth-gate .cpag-google:hover:not(:disabled){background:#ededed}',
    '#cp-auth-gate .cpag-gicon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;',
    '  border-radius:50%;background:#f1f3f4;color:#4285F4;font-weight:900;font-size:13px;flex:none}',
    '#cp-auth-gate .cpag-disclose{background:transparent;border:0;color:#9A9AA2;font-size:13px;font-weight:700;',
    '  padding:14px 4px 4px;width:100%;text-align:center;cursor:pointer}',
    '#cp-auth-gate .cpag-disclose:hover{color:#E9E9EE}',
    '#cp-auth-gate .cpag-pwsection{display:none;margin-top:2px}',
    '#cp-auth-gate .cpag-pwsection.cpag-open{display:block}',
    '#cp-auth-gate .cpag-resend{display:none;margin-top:12px;text-align:center}',
    '#cp-auth-gate .cpag-resend.cpag-show{display:block}',
    // Account chip + menu (rendered once signed in — same calm vocabulary as the ☁ chip).
    '#cp-acct-chip{position:fixed;z-index:2147483644;top:calc(10px + env(safe-area-inset-top,0px));',
    '  right:calc(10px + env(safe-area-inset-right,0px));width:38px;height:38px;border-radius:50%;',
    '  background:rgba(21,21,23,.94);color:#E9E9EE;border:1px solid rgba(255,255,255,.18);cursor:pointer;font-size:17px;',
    '  display:flex;align-items:center;justify-content:center;transition:border-color .15s,transform .06s;',
    '  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '#cp-acct-chip:hover{border-color:rgba(255,255,255,.4)}',
    '#cp-acct-chip:active{transform:scale(.94)}',
    '#cp-acct-menu{position:fixed;z-index:2147483644;top:calc(54px + env(safe-area-inset-top,0px));',
    '  right:calc(10px + env(safe-area-inset-right,0px));width:min(282px,calc(100vw - 20px));background:#151517;color:#E9E9EE;',
    '  border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);',
    '  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '#cp-acct-menu .cpam-who{font-size:12px;color:#9A9AA2;font-weight:700}',
    '#cp-acct-menu .cpam-email{font-weight:800;overflow-wrap:anywhere;margin-top:2px}',
    '#cp-acct-menu .cpam-role{color:#B9B9C0;font-size:12.5px;margin-top:2px}',
    '#cp-acct-menu .cpam-rule{color:#75757d;font-size:12px;margin:8px 0 12px;line-height:1.45}',
    '#cp-acct-menu .cpam-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:transparent;',
    '  color:#E9E9EE;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;font:inherit;font-weight:700;',
    '  cursor:pointer;margin-top:8px;transition:border-color .15s,background .15s}',
    '#cp-acct-menu .cpam-item:hover:not(:disabled){border-color:rgba(255,255,255,.3);background:rgba(255,255,255,.04)}',
    '#cp-acct-menu .cpam-item:disabled{opacity:.6;cursor:default}',
    '#cp-acct-menu .cpam-item.cpam-danger{color:#FF9AA2}',
    '#cp-acct-menu .cpam-msg{margin-top:10px;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 10px;display:none;line-height:1.45}',
    '#cp-acct-menu .cpam-msg.cpam-err{display:block;color:#FF7B85;background:rgba(225,29,42,.09);border:1px solid rgba(225,29,42,.3)}',
    '#cp-acct-menu .cpam-msg.cpam-ok{display:block;color:#34D27B;background:rgba(52,210,123,.08);border:1px solid rgba(52,210,123,.25)}',
    '#cp-acct-menu .cpam-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.28);',
    '  border-top-color:#fff;animation:cpagspin .7s linear infinite;display:inline-block;vertical-align:middle;flex:none}',
    // Relock overlay (kiosk) — opaque cover, NOT a sign-out; the offline queue keeps flowing beneath.
    '#cp-relock{position:fixed;inset:0;z-index:2147483645;background:#0B0B0D;color:#E9E9EE;display:flex;align-items:center;',
    '  justify-content:center;padding:calc(20px + env(safe-area-inset-top,0px)) 20px calc(20px + env(safe-area-inset-bottom,0px));',
    '  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;opacity:1;transition:opacity .3s ease}',
    '#cp-relock.cpr-out{opacity:0;pointer-events:none}',
    '#cp-relock *{box-sizing:border-box;margin:0}',
    '#cp-relock .cpr-card{width:100%;max-width:360px;background:#151517;border:1px solid rgba(255,255,255,.08);',
    '  border-radius:20px;padding:26px 24px;text-align:center}',
    '#cp-relock h2{font-size:19px;font-weight:800;letter-spacing:-.01em}',
    '#cp-relock .cpr-body{color:#B9B9C0;font-size:14px;margin-top:8px;line-height:1.5}',
    '#cp-relock .cpr-pins{display:flex;gap:12px;justify-content:center;margin:20px 0 6px}',
    '#cp-relock .cpr-box{width:48px;height:58px;background:#0B0B0D;color:#E9E9EE;border:1px solid rgba(255,255,255,.16);',
    '  border-radius:12px;text-align:center;font-size:24px;font-weight:800;padding:0;transition:border-color .15s}',
    '#cp-relock .cpr-box:focus{outline:none;border-color:rgba(255,255,255,.5)}',
    '#cp-relock .cpr-status{color:#9A9AA2;font-size:13px;margin-top:8px;min-height:1em}',
    '#cp-relock .cpr-msg{margin-top:10px;font-size:13.5px;font-weight:600;color:#FF7B85;min-height:1px}',
    '#cp-relock .cpr-link{background:transparent;border:0;color:#9A9AA2;font-size:13px;font-weight:700;padding:12px;',
    '  margin-top:6px;cursor:pointer;width:100%}',
    '#cp-relock .cpr-link:hover{color:#E9E9EE}',
  ].join('\n'); }

  /* ---------------------------------------------------- small UI utilities --- */
  function setMsgOn(node, text, ok) {
    node.textContent = text || '';
    node.className = 'cpag-msg' + (text ? (ok ? ' cpag-ok' : ' cpag-err') : '');
  }
  function shake(node) {
    try {
      node.classList.remove('cpag-shake'); void node.offsetWidth; node.classList.add('cpag-shake');
      setTimeout(function () { try { node.classList.remove('cpag-shake'); } catch (e) {} }, 460);
    } catch (e) {}
  }
  // A row of single-char inputs (OTP code = 6, PIN = 4). mask=true → password dots.
  function makeBoxGroup(n, wrapCls, boxCls, mask) {
    var wrap = el('div', wrapCls), boxes = [];
    for (var i = 0; i < n; i++) {
      var b = document.createElement('input');
      b.className = boxCls;
      b.type = mask ? 'password' : 'text';
      b.setAttribute('inputmode', 'numeric');
      b.setAttribute('autocomplete', 'off');
      b.setAttribute('maxlength', '1');
      b.spellcheck = false;
      b.setAttribute('aria-label', 'Digit ' + (i + 1));
      wrap.appendChild(b); boxes.push(b);
    }
    return { wrap: wrap, boxes: boxes };
  }
  // Auto-advance, backspace-across, paste-to-fill; fires onComplete when all filled.
  function wireBoxes(boxes, onComplete) {
    function focusAt(i) { if (boxes[i]) { try { boxes[i].focus(); if (boxes[i].select) boxes[i].select(); } catch (e) {} } }
    function collect() { return boxes.map(function (x) { return x.value; }).join(''); }
    function maybe() { var c = collect(); if (c.length === boxes.length && /^[0-9]+$/.test(c)) onComplete(c); }
    boxes.forEach(function (b, i) {
      b.addEventListener('input', function () {
        var v = String(b.value || '').replace(/[^0-9]/g, '');
        if (v.length > 1) v = v.slice(-1);
        b.value = v;
        if (v && i < boxes.length - 1) focusAt(i + 1);
        maybe();
      });
      b.addEventListener('keydown', function (ev) {
        if ((ev.key === 'Backspace' || ev.keyCode === 8) && !b.value && i > 0) { ev.preventDefault(); boxes[i - 1].value = ''; focusAt(i - 1); }
        else if ((ev.key === 'ArrowLeft' || ev.keyCode === 37) && i > 0) { ev.preventDefault(); focusAt(i - 1); }
        else if ((ev.key === 'ArrowRight' || ev.keyCode === 39) && i < boxes.length - 1) { ev.preventDefault(); focusAt(i + 1); }
      });
      b.addEventListener('paste', function (ev) {
        var t = ''; try { t = (ev.clipboardData || window.clipboardData).getData('text'); } catch (e) {}
        var digits = String(t || '').replace(/[^0-9]/g, '').slice(0, boxes.length);
        if (!digits) return;
        ev.preventDefault();
        for (var k = 0; k < boxes.length; k++) boxes[k].value = digits.charAt(k) || '';
        var last = Math.min(digits.length, boxes.length) - 1;
        focusAt(last < 0 ? 0 : last);
        maybe();
      });
    });
    return { value: collect, clear: function () { boxes.forEach(function (x) { x.value = ''; }); }, focusFirst: function () { focusAt(0); } };
  }
  // Two-phase "choose then confirm" PIN setter shared by the kiosk sign-in step and
  // the relock overlay's bootstrap mode. onSet(pin) fires only when both entries match.
  function makePinSetFlow(ctl, wrap, setStatus, setErr, onSet) {
    var first = null;
    function reset() { first = null; ctl.clear(); setStatus('Pick 4 numbers you’ll remember.'); setErr(''); ctl.focusFirst(); }
    function onComplete(pin) {
      if (first === null) { first = pin; ctl.clear(); setStatus('Type the same 4 numbers again to confirm.'); ctl.focusFirst(); }
      else if (pin !== first) { shake(wrap); ctl.clear(); first = null; setStatus('Pick 4 numbers you’ll remember.'); setErr('Those didn’t match. Let’s try again.'); ctl.focusFirst(); }
      else { onSet(pin); }
    }
    return { onComplete: onComplete, reset: reset };
  }
  // Salted SHA-256 (operational control, not the security boundary — RLS is that).
  function randSaltHex() {
    var a; try { a = new Uint8Array(16); ((window.crypto) || {}).getRandomValues(a); } catch (e) { a = null; }
    if (!a) { a = []; for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256); }
    var s = ''; for (var j = 0; j < 16; j++) s += ('0' + (a[j] & 255).toString(16)).slice(-2); return s;
  }
  function fnvHex(str) { var h = 0x811c9dc5 >>> 0; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function sha256Hex(str) {
    try {
      var subtle = (window.crypto && window.crypto.subtle) || (typeof crypto !== 'undefined' && crypto.subtle) || null;
      if (subtle && typeof TextEncoder !== 'undefined') {
        return Promise.resolve(subtle.digest('SHA-256', new TextEncoder().encode(str))).then(function (buf) {
          var arr = new Uint8Array(buf), h = '';
          for (var i = 0; i < arr.length; i++) h += ('0' + arr[i].toString(16)).slice(-2);
          return h;
        }).catch(function () { return fnvHex(str); });
      }
    } catch (e) {}
    return Promise.resolve(fnvHex(str));
  }

  /* ---- view: sign in (email → 6-digit code) ---- */
  var vSign = el('div');
  vSign.appendChild(el('h1', null, APP));
  vSign.appendChild(el('div', 'cpag-sub', 'This screen is for the gym team. Sign in with your work email.'));
  var emailForm = document.createElement('form'); emailForm.setAttribute('novalidate', 'novalidate');
  var emailLbl = el('label', null, 'Email'); emailLbl.htmlFor = 'cpag-email';
  var emailIn = document.createElement('input');
  emailIn.type = 'email'; emailIn.id = 'cpag-email'; emailIn.name = 'email';
  emailIn.placeholder = 'you@example.com'; emailIn.autocomplete = 'username';
  emailIn.setAttribute('inputmode', 'email'); emailIn.setAttribute('autocapitalize', 'none'); emailIn.spellcheck = false;
  var sendCodeBtn = el('button', 'cpag-primary'); sendCodeBtn.type = 'submit';
  sendCodeBtn.appendChild(el('span', null, 'Email me a code'));
  emailForm.appendChild(emailLbl); emailForm.appendChild(emailIn); emailForm.appendChild(sendCodeBtn);
  vSign.appendChild(emailForm);
  // Google — built dormant; revealed only when CP.data.auth.googleEnabled() is true.
  var googleBtn = el('button', 'cpag-google'); googleBtn.type = 'button'; googleBtn.style.display = 'none';
  vSign.appendChild(googleBtn);
  // Password fallback — collapsed disclosure (magic-link CTA is demoted/removed).
  var discloseBtn = el('button', 'cpag-disclose', 'Use a password instead'); discloseBtn.type = 'button';
  vSign.appendChild(discloseBtn);
  var pwSection = el('div', 'cpag-pwsection');
  var pwSignForm = document.createElement('form'); pwSignForm.setAttribute('novalidate', 'novalidate');
  var pwLbl = el('label', null, 'Password'); pwLbl.htmlFor = 'cpag-pw';
  var pwRow = el('div', 'cpag-pwrow');
  var pwIn = document.createElement('input');
  pwIn.type = 'password'; pwIn.id = 'cpag-pw'; pwIn.name = 'password'; pwIn.placeholder = 'Your password'; pwIn.autocomplete = 'current-password';
  var showBtn = el('button', 'cpag-show', 'Show'); showBtn.type = 'button'; showBtn.setAttribute('aria-label', 'Show password');
  showBtn.addEventListener('click', function () {
    var vis = pwIn.type === 'text';
    pwIn.type = vis ? 'password' : 'text';
    showBtn.textContent = vis ? 'Show' : 'Hide';
    showBtn.setAttribute('aria-label', vis ? 'Show password' : 'Hide password');
    try { pwIn.focus(); } catch (e) {}
  });
  pwRow.appendChild(pwIn); pwRow.appendChild(showBtn);
  var signBtn = el('button', 'cpag-primary'); signBtn.type = 'submit'; signBtn.appendChild(el('span', null, 'Sign in'));
  pwSignForm.appendChild(pwLbl); pwSignForm.appendChild(pwRow); pwSignForm.appendChild(signBtn);
  pwSection.appendChild(pwSignForm);
  var recoverCopy = el('div', 'cpag-recover',
    'No password yet? Use “Email me a sign-in link” above — it signs you in without one.');
  pwSection.appendChild(recoverCopy);
  vSign.appendChild(pwSection);
  var msgBox = el('div', 'cpag-msg'); msgBox.setAttribute('role', 'alert'); vSign.appendChild(msgBox);
  var offBox = el('div', 'cpag-offline',
    'You’re offline right now. Signing in needs the internet, so this screen will be ready the moment you’re back online.');
  vSign.appendChild(offBox);
  // Shown when a send is rate-limited (free mailer quota) so an invited person who never
  // set a password isn't stranded: they can wait out the timer and use the emailed link.
  var pwlessHint = el('div', 'cpag-recover', 'Haven’t set a password? Wait for the timer, then use the emailed link.');
  pwlessHint.style.display = 'none';
  vSign.appendChild(pwlessHint);

  /* ---- view: enter the 6-digit code ---- */
  var vCode = el('div', 'cpag-center');
  vCode.appendChild(el('div', 'cpag-big', '✉️'));
  vCode.appendChild(el('h2', null, 'Enter your code'));
  var codeBody = el('div', 'cpag-body');
  codeBody.appendChild(el('span', null, 'We emailed a 6-digit code to '));
  var codeEmailEm = el('span', 'cpag-em', ''); codeBody.appendChild(codeEmailEm);
  codeBody.appendChild(el('span', null, '.'));
  vCode.appendChild(codeBody);
  var codeGroup = makeBoxGroup(6, 'cpag-codes', 'cpag-box', false);
  var codeWrap = codeGroup.wrap;
  vCode.appendChild(codeWrap);
  var codeStatusDefault = 'Codes can take a minute. Same email, same code.';
  var codeStatus = el('div', 'cpag-hint', codeStatusDefault);
  vCode.appendChild(codeStatus);
  var codeMsg = el('div', 'cpag-msg'); codeMsg.setAttribute('role', 'alert'); vCode.appendChild(codeMsg);
  var resendWrap = el('div', 'cpag-resend');
  resendWrap.appendChild(el('span', 'cpag-hint', 'Didn’t get it? '));
  var resendBtn = el('button', 'cpag-link', 'Send a new code'); resendBtn.type = 'button';
  resendBtn.style.width = 'auto'; resendBtn.style.display = 'inline';
  resendWrap.appendChild(resendBtn);
  vCode.appendChild(resendWrap);
  var codeBack = el('button', 'cpag-link', '← Use a different email'); codeBack.type = 'button';
  vCode.appendChild(codeBack);
  var codeCtl = wireBoxes(codeGroup.boxes, function (c) { submitCode(c); });

  /* ---- view: sign-in LINK sent (magic-link mode — free tier can't add the code) ---- */
  var vLink = el('div', 'cpag-center');
  vLink.appendChild(el('div', 'cpag-big', '✉️'));
  vLink.appendChild(el('h2', null, 'Check your email'));
  var linkBody = el('div', 'cpag-body');
  linkBody.appendChild(el('span', null, 'We emailed a sign-in link to '));
  var linkEmailEm = el('span', 'cpag-em', ''); linkBody.appendChild(linkEmailEm);
  linkBody.appendChild(el('span', null, '. Open that email on this device and tap the link — you’ll land back here signed in.'));
  vLink.appendChild(linkBody);
  vLink.appendChild(el('div', 'cpag-hint', 'This page unlocks on its own once you tap the link.'));
  // Link mode = the free built-in mailer, which is quota-limited. Say so up front (calmly)
  // rather than only after a resend fails — the panel only ever renders in link mode.
  vLink.appendChild(el('div', 'cpag-rule',
    'Our free email service sends at most 2 sign-in emails an hour — if nothing arrives, use a password instead of resending.'));
  var linkMsg = el('div', 'cpag-msg'); linkMsg.setAttribute('role', 'alert'); vLink.appendChild(linkMsg);
  var linkResendWrap = el('div', 'cpag-resend');
  linkResendWrap.appendChild(el('span', 'cpag-hint', 'Didn’t get it? '));
  var linkResendBtn = el('button', 'cpag-link', 'Send a new link'); linkResendBtn.type = 'button';
  linkResendBtn.style.width = 'auto'; linkResendBtn.style.display = 'inline';
  linkResendWrap.appendChild(linkResendBtn);
  vLink.appendChild(linkResendWrap);
  var linkBack = el('button', 'cpag-link', '← Use a different email'); linkBack.type = 'button';
  vLink.appendChild(linkBack);

  /* ---- view: signed in, resolving role ---- */
  var vWait = el('div', 'cpag-center');
  var waitRow = el('div'); waitRow.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;padding:14px 0';
  waitRow.appendChild(spin(true)); waitRow.appendChild(el('span', 'cpag-em', 'Signing you in…'));
  vWait.appendChild(waitRow);
  var waitNote = el('div', 'cpag-hint', ''); vWait.appendChild(waitNote);

  /* ---- view: signed in but the wait didn't finish — always a way out ---- */
  var vStuck = el('div', 'cpag-center');
  vStuck.appendChild(el('div', 'cpag-big', '⏳'));
  vStuck.appendChild(el('h2', null, 'We couldn’t finish signing you in.'));
  vStuck.appendChild(el('div', 'cpag-body',
    'This usually sorts itself out. Give it another try — and if it keeps happening, sign out and sign back in.'));
  var retryBtn = el('button', 'cpag-primary'); retryBtn.type = 'button'; retryBtn.appendChild(el('span', null, 'Try again'));
  vStuck.appendChild(retryBtn);
  var stuckOutBtn = el('button', 'cpag-secondary'); stuckOutBtn.type = 'button'; stuckOutBtn.style.marginTop = '10px';
  stuckOutBtn.appendChild(el('span', null, 'Sign out'));
  vStuck.appendChild(stuckOutBtn);

  /* ---- view: signed in but wrong role for this app ---- */
  var vDeny = el('div', 'cpag-center');
  vDeny.appendChild(el('div', 'cpag-big', '🚪'));
  vDeny.appendChild(el('h2', null, 'This account can’t open this app.'));
  var denyBody = el('div', 'cpag-body');
  denyBody.appendChild(el('span', null, 'You’re signed in as '));
  var denyEmail = el('span', 'cpag-em', ''); denyBody.appendChild(denyEmail);
  denyBody.appendChild(el('span', null, '. Ask the owner to give this account access, or sign in with a different one.'));
  vDeny.appendChild(denyBody);
  var outBtn = el('button', 'cpag-primary'); outBtn.type = 'button'; outBtn.appendChild(el('span', null, 'Sign out'));
  vDeny.appendChild(outBtn);

  /* ---- view: signed in but no team record yet (Google orphan / unknown) ---- */
  var vNotList = el('div', 'cpag-center');
  vNotList.appendChild(el('div', 'cpag-big', '📋'));
  vNotList.appendChild(el('h2', null, 'You’re not on the list yet'));
  var nlBody = el('div', 'cpag-body');
  nlBody.appendChild(el('span', null, 'You’re signed in as '));
  var nlEmail = el('span', 'cpag-em', ''); nlBody.appendChild(nlEmail);
  nlBody.appendChild(el('span', null, ', but this account hasn’t been added to the team yet.'));
  vNotList.appendChild(nlBody);
  vNotList.appendChild(el('div', 'cpag-body', 'Ask the gym owner or the front desk to invite you, then sign in again.'));
  var nlBtn = el('button', 'cpag-primary'); nlBtn.type = 'button'; nlBtn.appendChild(el('span', null, 'Try a different account'));
  vNotList.appendChild(nlBtn);

  /* ---- view: success flash ---- */
  var vOk = el('div', 'cpag-center');
  vOk.appendChild(el('div', 'cpag-big', '✓'));
  vOk.appendChild(el('h2', null, 'You’re in'));

  /* ---- view: set a quick unlock PIN (kiosk sign-in) ---- */
  var vKPin = el('div');
  vKPin.appendChild(el('h1', null, 'Set a quick unlock PIN'));
  vKPin.appendChild(el('div', 'cpag-sub',
    'This keeps the front desk private when you step away. Pick 4 numbers you’ll remember.'));
  var kpinGroup = makeBoxGroup(4, 'cpag-pins', 'cpag-box', true);
  vKPin.appendChild(kpinGroup.wrap);
  var kpinStatus = el('div', 'cpag-hint', 'Pick 4 numbers you’ll remember.');
  vKPin.appendChild(kpinStatus);
  var kpinMsg = el('div', 'cpag-msg'); kpinMsg.setAttribute('role', 'alert'); vKPin.appendChild(kpinMsg);
  var kpinSkip = el('button', 'cpag-link', 'Set this up later'); kpinSkip.type = 'button';
  vKPin.appendChild(kpinSkip);
  var kpinDispatch = { fn: function () {} };
  var kpinCtl = wireBoxes(kpinGroup.boxes, function (c) { kpinDispatch.fn(c); });
  var kpinFlow = makePinSetFlow(kpinCtl, kpinGroup.wrap,
    function (t) { kpinStatus.textContent = t; },
    function (t) { setMsgOn(kpinMsg, t, false); },
    function (pin) { setRelockPin(pin).then(function () { continueHandover(); }); });
  kpinDispatch.fn = kpinFlow.onComplete;
  kpinSkip.addEventListener('click', function () { continueHandover(); });

    /* ---- view: set a password (LIVE only) ---- */
  var vPw = el('div');
  vPw.appendChild(el('h1', null, 'Set a password'));
  vPw.appendChild(el('div', 'cpag-sub',
    'You’re signed in. Pick a password now and next time you can sign straight in — no waiting for an email.'));
  var pwForm = document.createElement('form');
  pwForm.setAttribute('novalidate', 'novalidate');
  var newLbl = el('label', null, 'New password'); newLbl.htmlFor = 'cpag-newpw';
  var newRow = el('div', 'cpag-pwrow');
  var newIn = document.createElement('input');
  newIn.type = 'password'; newIn.id = 'cpag-newpw'; newIn.name = 'new-password';
  newIn.placeholder = 'At least ' + MIN_PW + ' characters'; newIn.autocomplete = 'new-password';
  var newShow = el('button', 'cpag-show', 'Show'); newShow.type = 'button';
  newShow.setAttribute('aria-label', 'Show password');
  newShow.addEventListener('click', function () {
    var vis = newIn.type === 'text';
    newIn.type = con2In.type = vis ? 'password' : 'text';
    newShow.textContent = vis ? 'Show' : 'Hide';
    newShow.setAttribute('aria-label', vis ? 'Show password' : 'Hide password');
    try { newIn.focus(); } catch (e) {}
  });
  newRow.appendChild(newIn); newRow.appendChild(newShow);
  var con2Lbl = el('label', null, 'Type it again'); con2Lbl.htmlFor = 'cpag-newpw2';
  var con2In = document.createElement('input');
  con2In.type = 'password'; con2In.id = 'cpag-newpw2'; con2In.name = 'new-password-again';
  con2In.placeholder = 'The same password'; con2In.autocomplete = 'new-password';
  var saveBtn = el('button', 'cpag-primary'); saveBtn.type = 'submit';
  saveBtn.appendChild(el('span', null, 'Save password'));
  pwForm.appendChild(newLbl); pwForm.appendChild(newRow);
  pwForm.appendChild(con2Lbl); pwForm.appendChild(con2In);
  pwForm.appendChild(saveBtn);
  vPw.appendChild(pwForm);
  vPw.appendChild(el('div', 'cpag-rule', 'Anything you’ll remember works — a short phrase is easier than a tricky word.'));
  var pwMsg = el('div', 'cpag-msg'); pwMsg.setAttribute('role', 'alert');
  vPw.appendChild(pwMsg);
  var laterBtn = el('button', 'cpag-link', 'Not now'); laterBtn.type = 'button';
  vPw.appendChild(laterBtn);

  /* ---- view: password saved ---- */
  var vPwOk = el('div', 'cpag-center');
  vPwOk.appendChild(el('div', 'cpag-big', '✓'));
  vPwOk.appendChild(el('h2', null, 'Password saved'));
  vPwOk.appendChild(el('div', 'cpag-body',
    'Next time, sign in with your email and this password. The email link still works too.'));
  var pwDoneBtn = el('button', 'cpag-primary'); pwDoneBtn.type = 'button';
  pwDoneBtn.appendChild(el('span', null, 'Continue'));
  vPwOk.appendChild(pwDoneBtn);

  var VIEWS = {
    signin: vSign, code: vCode, linksent: vLink, wait: vWait, stuck: vStuck, deny: vDeny,
    notlist: vNotList, ok: vOk, kioskpin: vKPin, pw: vPw, pwok: vPwOk,
  };
  Object.keys(VIEWS).forEach(function (k) { VIEWS[k].style.display = 'none'; card.appendChild(VIEWS[k]); });

  var view = '';
  function show(name) {
    view = name;
    Object.keys(VIEWS).forEach(function (k) { VIEWS[k].style.display = k === name ? '' : 'none'; });
  }
  show('signin');

  function setMsg(text, ok) {
    msgBox.textContent = text || '';
    msgBox.className = 'cpag-msg' + (text ? (ok ? ' cpag-ok' : ' cpag-err') : '');
  }

  /* ---- working-state helpers (spinner appears synchronously, well < 100ms) ---- */
  function btnWorking(btn, label) { btn.disabled = true; btn.textContent = ''; btn.appendChild(spin(btn === googleBtn)); btn.appendChild(el('span', null, label)); }
  function btnReset(btn, label) { btn.disabled = false; btn.textContent = ''; btn.appendChild(el('span', null, label)); }
  function fillGoogle() { googleBtn.disabled = false; googleBtn.textContent = ''; googleBtn.appendChild(el('span', 'cpag-gicon', 'G')); googleBtn.appendChild(el('span', null, 'Continue with Google')); }
  function resetSignInButtons() { btnReset(sendCodeBtn, sendLabel); btnReset(signBtn, 'Sign in'); fillGoogle(); }

  // --- OTP-code vs magic-link mode (honesty fork, discovered live 2026-07-22) ---
  // Free-tier Supabase refuses the email-template change that would add the 6-digit code
  // to the email, so until custom SMTP + template land (CP.data.auth.otpCodesEnabled()
  // flips true) the email carries ONLY a link. The gate must therefore promise a LINK,
  // never a code it cannot deliver — no fake surface (project live-honesty rule).
  var codesMode = false;
  var sendLabel = 'Email me a sign-in link';
  var sendWorkingLabel = 'Sending your sign-in link…';
  var emailHintText = 'Type your work email above, then tap “Email me a sign-in link”.';
  function codesEnabled() {
    var fn = null; try { fn = data().auth.otpCodesEnabled; } catch (e) {}
    if (typeof fn !== 'function') return false;   // default false → link mode (honest)
    try { return !!fn(); } catch (e) { return false; }
  }
  // Read the flag every time the sign-in view opens (cheap sync call): a device that
  // received the kv flag via background reconcile upgrades to code mode on the NEXT gate
  // open, no reload required.
  function refreshSignInMode() {
    codesMode = codesEnabled();
    sendLabel = codesMode ? 'Email me a code' : 'Email me a sign-in link';
    sendWorkingLabel = codesMode ? 'Sending your code…' : 'Sending your sign-in link…';
    emailHintText = codesMode
      ? 'Type your work email above, then tap “Email me a code”.'
      : 'Type your work email above, then tap “Email me a sign-in link”.';
    if (!sendCodeBtn.disabled) { sendCodeBtn.textContent = ''; sendCodeBtn.appendChild(el('span', null, sendLabel)); }
    recoverCopy.textContent = codesMode
      ? 'No password yet? Use “Email me a code” above — it signs you in without one.'
      : 'No password yet? Use “Email me a sign-in link” above — it signs you in without one.';
  }
  fillGoogle();
  refreshSignInMode();

  function refreshOffline() {
    try {
      var off = typeof navigator !== 'undefined' && navigator.onLine === false;
      overlay.classList.toggle('cpag-is-offline', !!off);
    } catch (e) {}
  }

  // Reveal Google only if config says so (resolves a boolean OR a Promise<boolean>).
  function maybeShowGoogle() {
    var fn = null; try { fn = data().auth.googleEnabled; } catch (e) {}
    if (typeof fn !== 'function') { googleBtn.style.display = 'none'; return; }
    var res; try { res = fn(); } catch (e) { res = false; }
    Promise.resolve(res).then(function (on) { googleBtn.style.display = on ? '' : 'none'; }).catch(function () { googleBtn.style.display = 'none'; });
  }

  /* ------------------------------------------------------------- gate state --- */
  var opened = false, mounted = false, unsub = null, roleTimer = null, roleTries = 0;
  var pwOpen = false, pwMode = '', pwDoneTimer = null, usedPassword = false;
  var kpinOpen = false, handedOff = false, expiring = false, codeBusy = false;
  var pendingEmail = '', resendTimer = null;
  var capTimer = null, lastTouch = 0;
  var relockTimer = null, relockOverlay = null, relockTrapHandler = null;
  var acctChip = null, acctMenu = null, acctOpen = false;

  function cleanup() {
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
    if (roleTimer) { clearInterval(roleTimer); roleTimer = null; }
    try { window.removeEventListener('online', refreshOffline); window.removeEventListener('offline', refreshOffline); } catch (e) {}
    try { document.removeEventListener('keydown', trapKey, true); } catch (e) {}
  }

  // Modal focus trap: gate / password panel / kiosk-PIN step keep Tab inside the card.
  function gateFocusables() {
    var nodes = overlay.querySelectorAll('button,input,select,textarea,a[href]'), list = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]; if (n.disabled) continue;
      var p = n, vis = true;
      while (p && p !== overlay) { if (p.style && p.style.display === 'none') { vis = false; break; } p = p.parentNode; }
      if (vis) list.push(n);
    }
    return list;
  }
  function trapKey(ev) {
    if (opened && !pwOpen && !kpinOpen) return;
    if (ev.key !== 'Tab' && ev.keyCode !== 9) return;
    var list = gateFocusables();
    if (!list.length) { ev.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1], cur = document.activeElement;
    if (!cur || list.indexOf(cur) === -1) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); return; }
    if (ev.shiftKey && cur === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && cur === last) { ev.preventDefault(); first.focus(); }
  }

  function fadeOut() {
    overlay.classList.add('cpag-out');
    setTimeout(function () {
      try {
        if (!overlay.classList.contains('cpag-out')) return;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } catch (e) {}
    }, 400);
  }

  /* --------------------------------------------------- per-role sessions --- */
  function currentUid() {
    try { var st = data().status(); if (st && st.user) return st.user.id; } catch (e) {}
    var r = lsJson('cp_role'); return r && r.user_id ? r.user_id : null;
  }
  function currentRole() {
    try { var st = data().status(); if (st && st.role) return st.role; } catch (e) {}
    var r = lsJson('cp_role'); return r && r.role ? r.role : null;
  }
  function currentEmail() { try { var st = data().status(); return st && st.user ? st.user.email : null; } catch (e) { return null; } }

  // Fresh sign-in (uid changed / no record) resets `started`; a returning device
  // keeps it so the cap is measured from the real sign-in moment.
  function writeSessionMeta() {
    var uid = currentUid(); if (!uid) return;
    var meta = lsJson(SESSION_KEY), now = Date.now();
    if (!meta || meta.uid !== uid || !meta.started) meta = { uid: uid, started: now, lastActive: now };
    else meta.lastActive = now;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(meta)); } catch (e) {}
  }
  function touchActivity() {
    var now = Date.now();
    if (now - lastTouch < 60000) return;   // at most once/minute
    lastTouch = now;
    var meta = lsJson(SESSION_KEY); if (!meta) return;
    meta.lastActive = now;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(meta)); } catch (e) {}
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // Never enforce a cap while offline — the kiosk's offline check-in queue must keep
  // flowing. Enforcement waits for the next online moment.
  function checkSessionCap() {
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return false; } catch (e) {}
    var role = currentRole(); if (!role) return false;
    var meta = lsJson(SESSION_KEY); if (!meta || !meta.started) return false;
    var now = Date.now(); role = String(role).toLowerCase();
    if (role === 'frontdesk') {
      if (now - meta.started >= FRONTDESK_CAP_MS) { expireSession('frontdesk'); return true; }
    } else if (role === 'owner' || role === 'admin' || role === 'instructor') {
      var last = meta.lastActive || meta.started;
      if (now - last >= SLIDE_CAP_MS) { expireSession('idle'); return true; }
    }
    return false;
  }
  function expireSession(kind) {
    if (expiring) return; expiring = true;
    clearSessionTimers();
    clearSession();
    var banner = kind === 'frontdesk'
      ? 'The desk’s 12-hour sign-in ended — sign in again to reopen.'
      : 'Signed out to keep the gym’s data safe. Sign in to pick up where you left off.';
    var p; try { p = data().auth.signOut(); } catch (e) { p = null; }
    Promise.resolve(p).catch(function () {}).then(function () { hardReopen(banner); });
  }
  var ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart'];
  function onActivity() { touchActivity(); if (IS_KIOSK && !relockOverlay) armRelockIdle(); }
  function startActivityTracking() {
    try { ACTIVITY_EVENTS.forEach(function (t) { document.addEventListener(t, onActivity, true); }); } catch (e) {}
    try { window.addEventListener('online', checkSessionCap); } catch (e) {}
    if (capTimer) clearInterval(capTimer);
    capTimer = setInterval(checkSessionCap, 60000);
  }
  function clearSessionTimers() {
    if (capTimer) { clearInterval(capTimer); capTimer = null; }
    try { ACTIVITY_EVENTS.forEach(function (t) { document.removeEventListener(t, onActivity, true); }); } catch (e) {}
    try { window.removeEventListener('online', checkSessionCap); } catch (e) {}
  }

  /* ------------------------------------------------- account chip + menu --- */
  function acctRoleWords(role) {
    role = String(role || '').toLowerCase();
    return role === 'owner' ? 'Owner' : role === 'admin' ? 'Manager' : role === 'instructor' ? 'Coach'
      : role === 'frontdesk' ? 'Front desk' : (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Team');
  }
  function acctSessionWords(role) {
    return String(role || '').toLowerCase() === 'frontdesk'
      ? 'The desk stays signed in up to 12 hours at a time, then needs a fresh sign-in.'
      : 'You stay signed in about 2 weeks.';
  }
  function mountAccountChip() {
    if (acctChip) return;
    try {
      ensureStyle();
      acctChip = el('button', null, '👤'); acctChip.id = 'cp-acct-chip'; acctChip.type = 'button';
      acctChip.setAttribute('aria-label', 'Account'); acctChip.title = 'Account';
      acctChip.addEventListener('click', function (ev) { ev.stopPropagation(); if (acctOpen) closeAcctMenu(); else openAcctMenu(); });
      document.body.appendChild(acctChip);
    } catch (e) {}
  }
  function removeAccountChip() {
    closeAcctMenu();
    if (acctChip) { try { if (acctChip.parentNode) acctChip.parentNode.removeChild(acctChip); } catch (e) {} acctChip = null; }
  }
  function acctOutside(ev) {
    if (!acctMenu) return;
    var t = ev.target;
    if (acctMenu.contains(t) || (acctChip && acctChip.contains(t))) return;
    closeAcctMenu();
  }
  function closeAcctMenu() {
    acctOpen = false;
    if (acctMenu) { try { if (acctMenu.parentNode) acctMenu.parentNode.removeChild(acctMenu); } catch (e) {} acctMenu = null; }
    try { document.removeEventListener('click', acctOutside, true); } catch (e) {}
  }
  function openAcctMenu() {
    if (acctMenu) return;
    var email = currentEmail() || 'your account', role = currentRole();
    acctMenu = el('div'); acctMenu.id = 'cp-acct-menu'; acctMenu.setAttribute('role', 'menu');
    acctMenu.appendChild(el('div', 'cpam-who', 'Signed in as'));
    acctMenu.appendChild(el('div', 'cpam-email', email));
    acctMenu.appendChild(el('div', 'cpam-role', acctRoleWords(role) + ' · ' + APP));
    acctMenu.appendChild(el('div', 'cpam-rule', acctSessionWords(role)));
    if (ALLOW_PW) {
      var setPw = el('button', 'cpam-item'); setPw.type = 'button';
      setPw.appendChild(el('span', null, '🔑')); setPw.appendChild(el('span', null, 'Set password'));
      setPw.addEventListener('click', function () { closeAcctMenu(); openPasswordManage(); });
      acctMenu.appendChild(setPw);
    }
    var out = el('button', 'cpam-item'); out.type = 'button';
    out.appendChild(el('span', null, '↪')); out.appendChild(el('span', null, 'Sign out'));
    out.addEventListener('click', function () { chipSignOut(); });
    acctMenu.appendChild(out);
    var outAll = el('button', 'cpam-item cpam-danger'); outAll.type = 'button';
    outAll.appendChild(el('span', null, '🚪')); outAll.appendChild(el('span', null, 'Sign out everywhere'));
    outAll.addEventListener('click', function () { confirmSignOutEverywhere(acctMenu, outAll); });
    acctMenu.appendChild(outAll);
    var msg = el('div', 'cpam-msg'); msg.setAttribute('data-acct-msg', '1'); acctMenu.appendChild(msg);
    try { document.body.appendChild(acctMenu); } catch (e) {}
    acctOpen = true;
    setTimeout(function () { try { document.addEventListener('click', acctOutside, true); } catch (e) {} }, 0);
  }
  function confirmSignOutEverywhere(menu, srcBtn) {
    var msg = menu.querySelector('[data-acct-msg]');
    msg.className = 'cpam-msg'; msg.style.display = 'block'; msg.textContent = '';
    msg.appendChild(el('div', null, 'Sign out on every device? You’ll sign in again here.'));
    var row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    var cancel = el('button', 'cpam-item', 'Cancel'); cancel.type = 'button'; cancel.style.marginTop = '0';
    var yes = el('button', 'cpam-item cpam-danger', 'Yes, everywhere'); yes.type = 'button'; yes.style.marginTop = '0';
    row.appendChild(cancel); row.appendChild(yes); msg.appendChild(row);
    cancel.addEventListener('click', function () { msg.style.display = 'none'; msg.textContent = ''; msg.className = 'cpam-msg'; });
    yes.addEventListener('click', function () {
      yes.disabled = true; cancel.disabled = true; srcBtn.disabled = true;
      yes.textContent = ''; yes.appendChild(el('span', 'cpam-spin')); yes.appendChild(el('span', null, ' Signing out…'));
      var p; try { p = data().auth.signOutEverywhere(); } catch (e) { p = null; }
      // data.js clears THIS device's session unconditionally (even offline), so the
      // gate always reopens once the call settles — only the honesty of the banner
      // changes with whether the other devices could be reached.
      Promise.resolve(p).then(function (r) {
        clearSession(); closeAcctMenu();
        if (r && r.ok === false) {
          hardReopen(r.reason === 'offline'
            ? 'Signed out here. Your other devices will sign out when they’re back online.'
            : 'Signed out here. We couldn’t reach your other devices just now.');
        } else {
          hardReopen('Signed out on all devices. Sign in to continue.');
        }
      }).catch(function () {
        clearSession(); closeAcctMenu();
        hardReopen('Signed out here. We couldn’t reach your other devices just now.');
      });
    });
  }
  function chipSignOut() {
    closeAcctMenu();
    clearSession();
    var p; try { p = data().auth.signOut(); } catch (e) { p = null; }
    Promise.resolve(p).catch(function () {}).then(function () { hardReopen('You’re signed out. Sign in when you’re ready.'); });
  }

  /* -------------------------------------------------- kiosk idle relock --- */
  function clearRelockPin() { try { localStorage.removeItem(RELOCK_KEY); } catch (e) {} }
  function hasRelockPin() {
    var r = lsJson(RELOCK_KEY);
    if (!r || !r.hash || !r.salt) return false;
    // A PIN belongs to whoever set it. If a DIFFERENT front-desk user is now signed in,
    // don't lock them behind the previous person's PIN — treat as no-PIN so the gate
    // prompts them to set a fresh one.
    var uid = currentUid();
    if (uid && r.uid && r.uid !== uid) return false;
    return true;
  }
  function setRelockPin(pin) {
    var salt = randSaltHex();
    return sha256Hex(salt + ':' + pin).then(function (hash) {
      try { localStorage.setItem(RELOCK_KEY, JSON.stringify({ v: 1, salt: salt, hash: hash, uid: currentUid() })); } catch (e) {}
      return true;
    });
  }
  function verifyRelockPin(pin) {
    var r = lsJson(RELOCK_KEY);
    if (!r || !r.salt || !r.hash) return Promise.resolve(false);
    return sha256Hex(r.salt + ':' + pin).then(function (hash) { return hash === r.hash; });
  }
  function armRelockIdle() { if (!IS_KIOSK) return; if (relockTimer) clearTimeout(relockTimer); relockTimer = setTimeout(showRelock, RELOCK_IDLE_MS); }
  function startRelock() { if (!IS_KIOSK) return; armRelockIdle(); }
  function showRelock() { if (relockOverlay) return; buildRelock(hasRelockPin() ? 'enter' : 'set'); }
  function stopRelock() {
    if (relockTimer) { clearTimeout(relockTimer); relockTimer = null; }
    try { if (relockTrapHandler) document.removeEventListener('keydown', relockTrapHandler, true); } catch (e) {}
    relockTrapHandler = null;
    if (relockOverlay) { try { if (relockOverlay.parentNode) relockOverlay.parentNode.removeChild(relockOverlay); } catch (e) {} relockOverlay = null; }
  }
  function dismissRelock() {
    try { if (relockTrapHandler) document.removeEventListener('keydown', relockTrapHandler, true); } catch (e) {}
    relockTrapHandler = null;
    var ov = relockOverlay; relockOverlay = null;
    if (ov) { ov.classList.add('cpr-out'); setTimeout(function () { try { if (ov.parentNode) ov.parentNode.removeChild(ov); } catch (e) {} }, 300); }
    armRelockIdle();
  }
  function buildRelock(mode) {
    try { ensureStyle(); } catch (e) {}
    relockOverlay = el('div'); relockOverlay.id = 'cp-relock';
    relockOverlay.setAttribute('role', 'dialog'); relockOverlay.setAttribute('aria-modal', 'true');
    relockOverlay.setAttribute('aria-label', 'Front desk locked');
    var rcard = el('div', 'cpr-card');
    rcard.appendChild(el('h2', null, mode === 'enter' ? 'Desk locked' : 'Set a quick unlock PIN'));
    rcard.appendChild(el('div', 'cpr-body', mode === 'enter'
      ? 'Enter your 4-digit PIN to get back to the desk.'
      : 'Pick 4 numbers to lock the desk when you step away.'));
    var grp = makeBoxGroup(4, 'cpr-pins', 'cpr-box', true);
    rcard.appendChild(grp.wrap);
    var rstatus = el('div', 'cpr-status', mode === 'enter' ? '' : 'Pick 4 numbers you’ll remember.');
    rcard.appendChild(rstatus);
    var rmsg = el('div', 'cpr-msg', ''); rcard.appendChild(rmsg);
    var forgot = el('button', 'cpr-link', 'Forgot PIN? Sign out'); forgot.type = 'button';
    // Full sign-out is destructive (parity with the account menu) — confirm first rather
    // than sign the desk out on a single tap.
    forgot.addEventListener('click', function () {
      forgot.style.display = 'none';
      rstatus.textContent = 'Sign out the desk? The next person will need the sign-in email or password.';
      var crow = el('div', 'cpr-confirm'); crow.style.cssText = 'display:flex;gap:14px;justify-content:center;margin-top:6px';
      var cancel = el('button', 'cpr-link', 'Cancel'); cancel.type = 'button'; cancel.style.width = 'auto';
      var yes = el('button', 'cpr-link', 'Yes, sign out'); yes.type = 'button'; yes.style.width = 'auto'; yes.style.color = '#FF9AA2';
      cancel.addEventListener('click', function () {
        try { if (crow.parentNode) crow.parentNode.removeChild(crow); } catch (e) {}
        forgot.style.display = '';
        rstatus.textContent = mode === 'enter' ? '' : 'Pick 4 numbers you’ll remember.';
      });
      yes.addEventListener('click', function () { stopRelock(); chipSignOut(); });
      crow.appendChild(cancel); crow.appendChild(yes);
      rcard.appendChild(crow);
    });
    rcard.appendChild(forgot);
    relockOverlay.appendChild(rcard);
    try { document.body.appendChild(relockOverlay); } catch (e) {}
    var dispatch = { fn: function () {} };
    var ctl = wireBoxes(grp.boxes, function (code) { dispatch.fn(code); });
    if (mode === 'enter') {
      var busy = false;
      dispatch.fn = function (pin) {
        if (busy) return; busy = true; rmsg.textContent = '';
        verifyRelockPin(pin).then(function (ok) {
          busy = false;
          if (ok) { dismissRelock(); }
          else { shake(grp.wrap); ctl.clear(); try { ctl.focusFirst(); } catch (e) {} rmsg.textContent = 'That PIN didn’t match. Try again.'; }
        });
      };
    } else {
      var flow = makePinSetFlow(ctl, grp.wrap,
        function (t) { rstatus.textContent = t; },
        function (t) { rmsg.textContent = t || ''; },
        function (pin) { setRelockPin(pin).then(function () { dismissRelock(); }); });
      dispatch.fn = flow.onComplete;
    }
    relockTrapHandler = function (ev) {
      if (ev.key !== 'Tab' && ev.keyCode !== 9) return;
      var nodes = relockOverlay ? relockOverlay.querySelectorAll('button,input') : [], list = [];
      for (var i = 0; i < nodes.length; i++) { if (!nodes[i].disabled) list.push(nodes[i]); }
      if (!list.length) { ev.preventDefault(); return; }
      var first = list[0], last = list[list.length - 1], cur = document.activeElement;
      if (!cur || list.indexOf(cur) === -1) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); return; }
      if (ev.shiftKey && cur === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && cur === last) { ev.preventDefault(); first.focus(); }
    };
    try { document.addEventListener('keydown', relockTrapHandler, true); } catch (e) {}
    try { grp.boxes[0].focus(); } catch (e) {}
  }

  /* --------------------------------------------------- authorized handoff --- */
  // Runs once we KNOW the device is authorized (fresh sign-in OR pre-authorized on
  // load): record the session, start the caps/relock monitors, mount the chip.
  function authorizedHandoff() {
    if (handedOff) return;
    handedOff = true;
    writeSessionMeta();
    whenDomReady(function () {
      if (expiring) return;
      if (checkSessionCap()) return;       // cap already blown → gate reopened
      startActivityTracking();
      mountAccountChip();
      if (IS_KIOSK) startRelock();
    });
  }
  function continueHandover() {
    kpinOpen = false;
    try { document.removeEventListener('keydown', trapKey, true); } catch (e) {}
    if (shouldOfferPassword()) { startPassword('offer'); return; }
    show('ok');
    setTimeout(fadeOut, 450);
  }
  function startKioskPinSetup() {
    ensureMounted();
    try { overlay.setAttribute('aria-label', 'Set a desk PIN for ' + APP); } catch (e) {}
    kpinOpen = true;
    show('kioskpin');
    kpinFlow.reset();
    try { document.addEventListener('keydown', trapKey, true); } catch (e) {}
  }

  // Tear the gate back down to a signed-out sign-in screen (cap expiry, sign-out,
  // sign-out-everywhere, forgot-PIN). Re-mounts the overlay it had removed on fade.
  function hardReopen(banner) {
    clearSessionTimers();
    stopRelock();
    clearRelockPin();          // the next desk user must never inherit this one's PIN
    removeAccountChip();
    clearSession();
    opened = false; mounted = false; handedOff = false; expiring = false;
    pwOpen = false; kpinOpen = false; usedPassword = false; codeBusy = false;
    view = '';
    try { document.removeEventListener('keydown', trapKey, true); } catch (e) {}
    try { if (unsub) unsub(); } catch (e) {} unsub = null;
    try { unsub = d0.onStatus(evaluate); } catch (e) {}
    whenDomReady(function () {
      mounted = false;
      mount();
      resetToEmailStep();
      emailIn.value = ''; pwIn.value = '';
      show('signin');
      if (banner) setMsg(banner, false);
      try { emailIn.focus(); } catch (e) {}
    });
  }

  /* ------------------------------------------------------------- gate flow --- */
  function openGate() {
    if (opened) return;
    opened = true;
    cleanup();
    authorizedHandoff();
    if (!mounted) return;                                   // authorized before DOM-ready: overlay never appeared
    if (IS_KIOSK && !hasRelockPin()) { startKioskPinSetup(); return; }
    continueHandover();
  }
  function showDenied(email) {
    if (roleTimer) { clearInterval(roleTimer); roleTimer = null; }
    denyEmail.textContent = email || 'this account';
    outBtn.disabled = false; outBtn.textContent = ''; outBtn.appendChild(el('span', null, 'Sign out'));
    show('deny');
  }
  function showNotListed(email) {
    if (roleTimer) { clearInterval(roleTimer); roleTimer = null; }
    nlEmail.textContent = email || 'this account';
    nlBtn.disabled = false; nlBtn.textContent = ''; nlBtn.appendChild(el('span', null, 'Try a different account'));
    show('notlist');
  }
  // Bounded wait for the role to resolve; escapes to "couldn't finish" after ~10s.
  function roleTick() {
    if (opened) return;
    // Link-sent mode: waiting (possibly minutes) for the emailed link to be tapped. This
    // is NOT the bounded post-sign-in role wait — never escalate to "stuck", never clobber
    // the panel; just resolve the instant a session appears (e.g. redemption in another
    // tab of this same session), handing off to the normal role-resolution wait.
    if (view === 'linksent') {
      var dl = data(); var sl = null; try { sl = dl && dl.status(); } catch (e) {}
      if (sl && sl.user) { evaluate(); }
      return;
    }
    roleTries++;
    var d = data();
    var st = null; try { st = d && d.status(); } catch (e) {}
    if (!st || !st.user) { if (roleTimer) { clearInterval(roleTimer); roleTimer = null; } if (!opened && view !== 'code' && view !== 'linksent') show('signin'); return; }
    if (allowed(st.role)) { openGate(); return; }
    if (st.role) { showDenied(st.user.email); return; }
    if (roleTries >= 4) { if (roleTimer) { clearInterval(roleTimer); roleTimer = null; } show('stuck'); try { retryBtn.focus(); } catch (e) {} return; }
    if (roleTries === 2) waitNote.textContent = 'Still working…';
    var cl = null; try { cl = d.client && d.client(); } catch (e) {}
    if (cl && roleTries % 2 === 1) {
      try {
        cl.from('app_users').select('role').eq('user_id', st.user.id).maybeSingle()
          .then(function (r) {
            if (opened || !roleTimer) return;
            if (r && r.data && r.data.role) { if (allowed(r.data.role)) openGate(); else showDenied(st.user.email); }
            else if (r && !r.error) { showNotListed(st.user.email); }   // definitive: no team record → not on the list
          }).catch(function () {});
      } catch (e) {}
    }
  }
  function armRoleBackstop() { if (roleTimer) return; roleTries = 0; waitNote.textContent = ''; roleTimer = setInterval(roleTick, 2500); }

  function evaluate() {
    if (opened) return;
    var d = data();
    var st = null; try { st = d && d.status(); } catch (e) {}
    if (st && st.user) {
      if (allowed(st.role)) { openGate(); return; }
      if (st.role) { showDenied(st.user.email); return; }
      if (view === 'stuck') return;
      if (view !== 'wait') show('wait');
      armRoleBackstop();
      return;
    }
    if (view === 'wait' || view === 'stuck' || view === 'deny' || view === 'notlist') { refreshSignInMode(); resetSignInButtons(); show('signin'); }
    if (cachedAuth()) openGate();
  }

  /* ------------------------------------------------ sign-in sub-flows --- */
  function resetToEmailStep() {
    if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; }
    if (roleTimer) { clearInterval(roleTimer); roleTimer = null; }   // stop any link-sent poll
    resendWrap.classList.remove('cpag-show');
    linkResendWrap.classList.remove('cpag-show');
    codeCtl.clear();
    codeMsg.textContent = ''; codeMsg.className = 'cpag-msg';
    codeStatus.textContent = codeStatusDefault;
    linkMsg.textContent = ''; linkMsg.className = 'cpag-msg';
    pwSection.classList.remove('cpag-open');
    discloseBtn.textContent = 'Use a password instead';
    pwlessHint.style.display = 'none';
    pwIn.type = 'password'; showBtn.textContent = 'Show';
    refreshSignInMode();
    resetSignInButtons();
    setMsg('');
  }
  function goToCodeStep() {
    codeCtl.clear(); codeMsg.textContent = ''; codeMsg.className = 'cpag-msg'; codeStatus.textContent = codeStatusDefault;
    resendWrap.classList.remove('cpag-show');
    show('code');
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = setTimeout(function () { resendWrap.classList.add('cpag-show'); }, RESEND_MS);
    try { codeCtl.focusFirst(); } catch (e) {}
  }
  // Magic-link mode: no code boxes — an honest "we emailed a link" panel. Sign-in
  // completes when the person taps the link (which redirects back to this page → a fresh
  // gate restores the session on load); the role backstop also catches a same-session
  // redemption from another tab.
  function goToLinkSentStep(email) {
    linkEmailEm.textContent = email;
    linkMsg.textContent = ''; linkMsg.className = 'cpag-msg';
    linkResendWrap.classList.remove('cpag-show');
    show('linksent');
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = setTimeout(function () { linkResendWrap.classList.add('cpag-show'); }, RESEND_MS);
    armRoleBackstop();
  }
  function submitCode(code) {
    if (codeBusy || opened) return;
    codeBusy = true;
    codeMsg.textContent = ''; codeMsg.className = 'cpag-msg';
    codeStatus.textContent = 'Checking your code…';
    var p; try { p = data().auth.verifyOtpCode(pendingEmail, code); } catch (e) { p = null; }
    Promise.resolve(p).then(function (r) {
      codeBusy = false;
      if (opened) return;
      if (r && r.ok) { codeStatus.textContent = ''; setMsg(''); evaluate(); }
      else {
        codeStatus.textContent = codeStatusDefault;
        setMsgOn(codeMsg, (r && r.error) || 'That code didn’t match. Check it and try again.', false);
        shake(codeWrap); codeCtl.clear(); try { codeCtl.focusFirst(); } catch (e) {}
      }
    }).catch(function () {
      codeBusy = false;
      if (opened) return;
      codeStatus.textContent = codeStatusDefault;
      setMsgOn(codeMsg, 'Could not reach the sign-in service. Check the internet connection and try again.', false);
      shake(codeWrap); codeCtl.clear(); try { codeCtl.focusFirst(); } catch (e) {}
    });
  }

  // Free-tier mailer quota detection (tolerant): data.js's friendly quota error names
  // both "email" and "password" ("…2 sign-in emails per hour… Use your password below…").
  // Any password/quota-ish phrasing trips it — better to over-offer the fallback than strand.
  function isMailerQuota(err) {
    var m = String(err || '').toLowerCase();
    if (!m) return false;
    if (m.indexOf('password') !== -1) return true;
    return /e-?mail/.test(m) && /(hour|quota|limit|used up|2 sign|too many)/.test(m);
  }
  // Rate-limited send: an invited person who never set a password would otherwise be
  // stranded. Open the password fallback and show the honest wait-then-link line.
  function offerPasswordFallback() {
    pwSection.classList.add('cpag-open');
    discloseBtn.textContent = 'Hide password sign-in';
    pwlessHint.style.display = '';
  }
  function quotaTail(err) { return isMailerQuota(err) ? ' No password yet? Wait for the timer, then use the emailed link.' : ''; }

  /* ------------------------------------------------------------- handlers --- */
  emailForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (sendCodeBtn.disabled) return;
    refreshSignInMode();   // decide the honesty fork on the flag as of this send
    var email = emailIn.value.trim();
    if (!email) { setMsg(emailHintText, false); try { emailIn.focus(); } catch (e) {} return; }
    setMsg('');
    btnWorking(sendCodeBtn, sendWorkingLabel);
    googleBtn.disabled = true; signBtn.disabled = true;
    var p; try { p = data().auth.sendOtpCode(email); } catch (e) { p = null; }
    Promise.resolve(p).then(function (r) {
      if (opened) return;
      btnReset(sendCodeBtn, sendLabel); googleBtn.disabled = false; signBtn.disabled = false;
      if (r && r.ok) {
        pendingEmail = email;
        if (codesMode) { codeEmailEm.textContent = email; goToCodeStep(); }
        else { goToLinkSentStep(email); }
      } else {
        setMsg((r && r.error) || (codesMode ? 'Could not send the code — try again in a moment.' : 'Could not send the link — try again in a moment.'), false);
        if (r && r.error && isMailerQuota(r.error)) offerPasswordFallback();   // don't strand a passwordless invite
      }
    }).catch(function () {
      if (opened) return;
      btnReset(sendCodeBtn, sendLabel); googleBtn.disabled = false; signBtn.disabled = false;
      setMsg('Could not reach the sign-in service. Check the internet connection and try again.', false);
    });
  });

  resendBtn.addEventListener('click', function () {
    if (resendBtn.disabled) return;
    resendBtn.disabled = true; resendBtn.textContent = 'Sending…';
    var p; try { p = data().auth.sendOtpCode(pendingEmail); } catch (e) { p = null; }
    Promise.resolve(p).then(function (r) {
      resendBtn.disabled = false; resendBtn.textContent = 'Send a new code';
      if (r && r.ok) {
        setMsgOn(codeMsg, 'Sent again — check your email.', true);
        resendWrap.classList.remove('cpag-show');
        if (resendTimer) clearTimeout(resendTimer);
        resendTimer = setTimeout(function () { resendWrap.classList.add('cpag-show'); }, RESEND_MS);
      } else setMsgOn(codeMsg, ((r && r.error) || 'Could not send a new code just now.') + quotaTail(r && r.error), false);
    }).catch(function () {
      resendBtn.disabled = false; resendBtn.textContent = 'Send a new code';
      setMsgOn(codeMsg, 'Could not reach the sign-in service. Try again in a moment.', false);
    });
  });
  codeBack.addEventListener('click', function () { if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; } setMsg(''); refreshSignInMode(); show('signin'); try { emailIn.focus(); } catch (e) {} });

  // Link-mode resend (mirrors the code resend, honest quota copy flows through r.error).
  linkResendBtn.addEventListener('click', function () {
    if (linkResendBtn.disabled) return;
    linkResendBtn.disabled = true; linkResendBtn.textContent = 'Sending…';
    var p; try { p = data().auth.sendOtpCode(pendingEmail); } catch (e) { p = null; }
    Promise.resolve(p).then(function (r) {
      linkResendBtn.disabled = false; linkResendBtn.textContent = 'Send a new link';
      if (r && r.ok) {
        setMsgOn(linkMsg, 'Sent again — check your email.', true);
        linkResendWrap.classList.remove('cpag-show');
        if (resendTimer) clearTimeout(resendTimer);
        resendTimer = setTimeout(function () { linkResendWrap.classList.add('cpag-show'); }, RESEND_MS);
      } else setMsgOn(linkMsg, ((r && r.error) || 'Could not send a new link just now.') + quotaTail(r && r.error), false);
    }).catch(function () {
      linkResendBtn.disabled = false; linkResendBtn.textContent = 'Send a new link';
      setMsgOn(linkMsg, 'Could not reach the sign-in service. Try again in a moment.', false);
    });
  });
  linkBack.addEventListener('click', function () { if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; } if (roleTimer) { clearInterval(roleTimer); roleTimer = null; } setMsg(''); refreshSignInMode(); show('signin'); try { emailIn.focus(); } catch (e) {} });

  googleBtn.addEventListener('click', function () {
    if (googleBtn.disabled) return;
    setMsg('');
    btnWorking(googleBtn, 'Opening Google…'); sendCodeBtn.disabled = true; signBtn.disabled = true;
    var p; try { p = data().auth.signInGoogle(); } catch (e) { p = null; }
    Promise.resolve(p).then(function (r) {
      if (opened) return;
      if (r && r.ok === false) {
        fillGoogle(); sendCodeBtn.disabled = false; signBtn.disabled = false;
        setMsg((r && r.error) || 'Could not start Google sign-in. Try a code instead.', false);
        return;
      }
      // Returned without a redirect (mock / already-signed-in): let role resolution decide.
      evaluate();
      if (!opened) { armRoleBackstop(); roleTick(); }
    }).catch(function () {
      if (opened) return;
      fillGoogle(); sendCodeBtn.disabled = false; signBtn.disabled = false;
      setMsg('Could not start Google sign-in. Try a code instead.', false);
    });
  });

  discloseBtn.addEventListener('click', function () {
    var open = pwSection.classList.toggle('cpag-open');
    discloseBtn.textContent = open ? 'Hide password sign-in' : 'Use a password instead';
    if (open) { try { pwIn.focus(); } catch (e) {} } else { pwlessHint.style.display = 'none'; }
  });

  pwSignForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (signBtn.disabled) return;
    var email = emailIn.value.trim(), pw = pwIn.value;
    if (!email || !pw) {
      setMsg(!email && !pw ? 'Type your email and password, then tap Sign in.'
        : (!email ? 'Type your email up top too, then tap Sign in.' : 'Type your password too, then tap Sign in.'), false);
      (!email ? emailIn : pwIn).focus();
      return;
    }
    setMsg('');
    btnWorking(signBtn, 'Signing in…'); sendCodeBtn.disabled = true; googleBtn.disabled = true;
    // Set BEFORE the call: data.js can fire its status change synchronously, opening
    // the gate (and the password offer would be pointless for someone who has one).
    usedPassword = true;
    var p; try { p = data().auth.signInPassword(email, pw); } catch (e) { p = null; }
    Promise.resolve(p).then(function (r) {
      if (opened) return;
      if (r && r.ok) { btnReset(signBtn, 'Sign in'); sendCodeBtn.disabled = false; googleBtn.disabled = false; setMsg('✓ Signed in', true); evaluate(); }
      else { usedPassword = false; btnReset(signBtn, 'Sign in'); sendCodeBtn.disabled = false; googleBtn.disabled = false; setMsg((r && r.error) || 'That didn’t work — give it another try.', false); }
    }).catch(function () {
      if (opened) return;
      usedPassword = false; btnReset(signBtn, 'Sign in'); sendCodeBtn.disabled = false; googleBtn.disabled = false;
      setMsg('Could not reach the sign-in service. Check the internet connection and try again.', false);
    });
  });

  function doSignOut(btn) {
    if (btn.disabled) return;
    if (roleTimer) { clearInterval(roleTimer); roleTimer = null; }
    btn.disabled = true;
    btn.textContent = ''; btn.appendChild(spin(btn === stuckOutBtn)); btn.appendChild(el('span', null, 'Signing out…'));
    clearSession();
    clearRelockPin();
    var p; try { p = data().auth.signOut(); } catch (e) { p = null; }
    Promise.resolve(p).catch(function () {}).then(function () {
      btn.disabled = false; btn.textContent = ''; btn.appendChild(el('span', null, 'Sign out'));
      resetToEmailStep(); emailIn.value = ''; pwIn.value = '';
      show('signin');
      try { emailIn.focus(); } catch (e) {}
    });
  }
  outBtn.addEventListener('click', function () { doSignOut(outBtn); });
  stuckOutBtn.addEventListener('click', function () { doSignOut(stuckOutBtn); });
  nlBtn.addEventListener('click', function () { doSignOut(nlBtn); });
  retryBtn.addEventListener('click', function () { show('wait'); waitNote.textContent = ''; armRoleBackstop(); roleTick(); });

    /* ------------------------------------------ set a password (LIVE only) --- */
  function pwRecord() { var r = lsJson(PW_KEY); return r && typeof r === 'object' ? r : null; }
  function rememberPw(state) {
    var uid = null;
    try { var st = data().status(); uid = st && st.user ? st.user.id : null; } catch (e) {}
    try { localStorage.setItem(PW_KEY, JSON.stringify({ user_id: uid, state: state, at: Date.now() })); } catch (e) {}
  }
  function pwClient() {
    try {
      var d = data();
      var cl = d && d.client ? d.client() : null;
      return (cl && cl.auth && typeof cl.auth.updateUser === 'function') ? cl : null;
    } catch (e) { return null; }
  }

  // Offer only when it can actually work and hasn't been settled already.
  function shouldOfferPassword() {
    if (!ALLOW_PW || usedPassword || pwOpen) return false;
    try { if (navigator.onLine === false) return false; } catch (e) {}
    if (!pwClient()) return false;
    var st = statusAuth();
    if (!st || !st.user) return false;
    var rec = pwRecord();
    if (rec && rec.user_id === st.user.id) {
      if (rec.state === 'set') return false;
      if (rec.state === 'later' && (Date.now() - (rec.at || 0)) < PW_SNOOZE_MS) return false;
    }
    return true;
  }

  function setPwMsg(text, ok) {
    pwMsg.textContent = text || '';
    pwMsg.className = 'cpag-msg' + (text ? (ok ? ' cpag-ok' : ' cpag-err') : '');
  }
  function setPwWorking(on) {
    saveBtn.disabled = on; laterBtn.disabled = on; newIn.disabled = on; con2In.disabled = on;
    saveBtn.textContent = '';
    if (on) { saveBtn.appendChild(spin()); saveBtn.appendChild(el('span', null, 'Saving…')); }
    else saveBtn.appendChild(el('span', null, 'Save password'));
  }

  // Server text never reaches the owner — only plain words with a next step.
  function friendlyPwError(err) {
    var m = String((err && (err.message || err.msg)) || err || '');
    if (/rate limit|once every|security purposes|too many/i.test(m))
      return 'Too many tries in a row — wait a minute, then try again.';
    if (/different from the old|should be different|same as the old/i.test(m))
      return 'That’s already your password. Pick a different one, or tap Not now.';
    if (/at least|too short|weak|characters|password strength/i.test(m))
      return 'That password is too easy to guess. Try a longer one — at least ' + MIN_PW + ' characters.';
    if (/reauth|session|expired|not authenticated|jwt|token/i.test(m))
      return 'For safety, sign in again before setting a password.';
    if (/network|fetch|failed to|offline/i.test(m))
      return 'Could not reach the sign-in service. Check the internet connection and try again.';
    try { console.warn('password change error:', m); } catch (e) {}
    return 'Could not save the password just now. You can keep using the email link, and try this again later.';
  }

  function startPassword(mode) {
    pwMode = mode;
    pwOpen = true;
    if (pwDoneTimer) { clearTimeout(pwDoneTimer); pwDoneTimer = null; }
    ensureMounted();
    try { overlay.setAttribute('aria-label', 'Set a password for ' + APP); } catch (e) {}
    newIn.value = ''; con2In.value = '';
    newIn.type = con2In.type = 'password';
    newShow.textContent = 'Show';
    setPwMsg(''); setPwWorking(false);
    laterBtn.disabled = false;
    laterBtn.textContent = mode === 'offer' ? 'Not now' : 'Cancel';
    show('pw');
    try { document.addEventListener('keydown', trapKey, true); } catch (e) {}
    try { newIn.focus(); } catch (e) {}
  }

  function closePassword() {
    if (pwDoneTimer) { clearTimeout(pwDoneTimer); pwDoneTimer = null; }
    pwOpen = false;
    try { document.removeEventListener('keydown', trapKey, true); } catch (e) {}
    fadeOut();
  }

  pwForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (saveBtn.disabled) return;
    var a = newIn.value || '', b = con2In.value || '';
    if (!a) { setPwMsg('Type a password first, then tap Save password.', false); try { newIn.focus(); } catch (e) {} return; }
    if (a.length < MIN_PW) {
      setPwMsg('Make it at least ' + MIN_PW + ' characters — a short phrase you’ll remember works well.', false);
      try { newIn.focus(); } catch (e) {} return;
    }
    if (!b) { setPwMsg('Type the same password in the second box so we know it’s right.', false); try { con2In.focus(); } catch (e) {} return; }
    if (a !== b) {
      setPwMsg('Those two don’t match. Type the same password in both boxes.', false);
      try { con2In.select(); } catch (e) { try { con2In.focus(); } catch (e2) {} }
      return;
    }
    setPwMsg('');
    setPwWorking(true);
    var cl = pwClient(), p = null;
    try { if (cl) p = cl.auth.updateUser({ password: a }); } catch (e) { p = null; }
    if (!p) {
      setPwWorking(false);
      setPwMsg('Could not save a password on this device right now. You can still sign in with the email link.', false);
      return;
    }
    Promise.resolve(p).then(function (r) {
      setPwWorking(false);
      if (r && r.error) { setPwMsg(friendlyPwError(r.error), false); return; }
      rememberPw('set');
      newIn.value = ''; con2In.value = '';
      show('pwok');
      try { pwDoneBtn.focus(); } catch (e) {}
      pwDoneTimer = setTimeout(function () { if (view === 'pwok') closePassword(); }, 4200);
    }).catch(function () {
      setPwWorking(false);
      setPwMsg('Could not reach the sign-in service. Check the internet connection and try again.', false);
    });
  });

  laterBtn.addEventListener('click', function () {
    if (laterBtn.disabled) return;
    if (pwMode === 'offer') rememberPw('later');   // don't nag on every sign-in
    closePassword();
  });
  pwDoneBtn.addEventListener('click', function () { closePassword(); });

  // Entry point for someone who is ALREADY signed in: CP.authGate.setPassword()
  // or the #set-password hash (so it can be linked from an app menu later).
  function openPasswordManage() {
    if (!ALLOW_PW || pwOpen) return false;
    if (!(statusAuth() || cachedAuth())) return false;
    whenDomReady(function () { startPassword('manage'); });
    return true;
  }
  function hashCheck() {
    var h = ''; try { h = String(location.hash || ''); } catch (e) {}
    if (/^#set-?password$/i.test(h)) openPasswordManage();
  }
  if (ALLOW_PW) {
    try {
      window.CP = window.CP || {};
      window.CP.authGate = window.CP.authGate || {};
      window.CP.authGate.setPassword = openPasswordManage;
    } catch (e) {}
    try { window.addEventListener('hashchange', hashCheck); } catch (e) {}
    hashCheck();
  }

  /* ---------------------------------------------------------------- mount --- */
  function ensureStyle() {
    try {
      if (document.getElementById('cpag-style')) return;
      var style = document.createElement('style');
      style.id = 'cpag-style';
      style.textContent = gateCss() + '\n' + liveCss();
      document.head.appendChild(style);
    } catch (e) {}
  }
  function ensureMounted() {
    try {
      ensureStyle();
      overlay.classList.remove('cpag-out');
      if (!overlay.parentNode) document.body.appendChild(overlay);
    } catch (e) {}
  }

  // Already authorized before anything mounted: the gate stays invisible, but the
  // chip + session/relock monitors still come up (and the password entry points).
  if (PRE_AUTHORIZED) { authorizedHandoff(); opened = true; return; }

  try { unsub = d0.onStatus(evaluate); } catch (e) {}
  evaluate();

  function mount() {
    if (opened || mounted) return;
    mounted = true;
    try {
      ensureMounted();
      maybeShowGoogle();
      refreshSignInMode();
      refreshOffline();
      window.addEventListener('online', refreshOffline);
      window.addEventListener('offline', refreshOffline);
      document.addEventListener('keydown', trapKey, true);
      evaluate();
      if (view === 'signin') { try { emailIn.focus(); } catch (e) {} }
    } catch (e) { /* never break the host app */ }
  }
  whenDomReady(mount);

  /* ============================================================== STAGING ===
   * Contract B. Reached ONLY when CP.env.isStaging in a real browser — never
   * under jsdom, never in the live build. A hoisted function declaration so the
   * early branch above can call it.
   *
   * Staging is a demo copy: the cloud is off (deploy blanks CFG_EMBED) and every
   * record is fictional, which is what makes a single shared code acceptable
   * here and unacceptable anywhere near live.
   */
  function runStagingGate() {
    // ONE KEY PER APP (fix wave B#2). A single shared cp_stage_auth meant unlocking
    // the Owner Console silently unlocked the Kiosk, so the owner could never watch
    // the kiosk's own sign-in again. Slug comes from data-app: "Check-in Kiosk"
    // -> cp_stage_auth::check-in-kiosk.
    var SLUG = String(APP || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app';
    var STAGE_KEY = 'cp_stage_auth::' + SLUG;  // deliberately NOT cp_role — real roles stay real
    var LEGACY_KEY = 'cp_stage_auth';          // pre-split shared key: cleared, never honoured
    var STAGE_CODE = '1111111';
    var stageRole = ROLES[0] || 'owner';   // the app's first allowed role
    var sOverlay = null, sDone = false;
    var RESET_NOTE = 'Signs out of this practice copy and clears what the practice apps ' +
      'have saved on this device. The real gym app is not touched.';

    var whenReady = whenDomReady;
    function stageStored() { var v = lsJson(STAGE_KEY); return v && v.role ? v : null; }
    function stageReset() {
      try { localStorage.removeItem(STAGE_KEY); } catch (e) {}
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      try { location.reload(); } catch (e) {}
    }
    function framed() { try { return window.top !== window.self; } catch (e) { return true; } }

    // Only the page that framed this one, on this same site, may drive a reset
    // (fix wave B#7). A local file copy reports no origin at all, hence '' / 'null'.
    function trustedReset(ev) {
      var d = ev && ev.data;
      if (!d || typeof d !== 'object' || d.type !== 'cp-staging-reset') return false;
      var okSrc = false;
      try { okSrc = !!ev.source && ev.source === window.parent && window.parent !== window; } catch (e) { okSrc = false; }
      if (!okSrc) return false;
      var o = ''; try { o = String(ev.origin == null ? '' : ev.origin); } catch (e) {}
      var here = ''; try { here = String(location.origin || ''); } catch (e) {}
      return o === here || o === '' || o === 'null';
    }

    // The shell's "⟲ Reset login" button drives this. Armed even when this device
    // is already unlocked — that is the whole case it exists for. We ACK first so
    // the shell can confirm honestly instead of guessing (contract A / fix wave B#1).
    try {
      window.addEventListener('message', function (ev) {
        if (!trustedReset(ev)) return;
        try { ev.source.postMessage({ type: 'cp-staging-reset-ack', app: APP }, '*'); } catch (e) {}
        setTimeout(stageReset, 0);   // let the ack leave before the page reloads
      });
    } catch (e) {}

    var STAGE_CSS = [
      '#cp-auth-gate .cpag-stagebadge{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.18em;',
      '  color:#E0B341;background:rgba(224,179,65,.10);border:1px solid rgba(224,179,65,.32);',
      '  border-radius:999px;padding:3px 9px;margin-bottom:12px}',
      // Bottom-RIGHT (fix wave B#5): bottom-left sits on the instructor tab bar and
      // the kiosk recent strip. Full opacity — a half-faded staging marker is how
      // you end up thinking a practice copy is the real thing.
      '#cp-stage-dock{position:fixed;z-index:2147483646;',
      '  right:calc(10px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px));',
      '  display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;',
      '  max-width:min(300px,calc(100vw - 20px))}',
      '#cp-stage-dock > *{pointer-events:auto}',
      '#cp-stage-chip{background:rgba(21,21,23,.96);color:#E9E9EE;border:1px solid rgba(255,255,255,.22);',
      '  border-radius:999px;padding:6px 12px;cursor:pointer;letter-spacing:.05em;transition:border-color .15s,color .15s;',
      '  font:800 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
      '#cp-stage-chip:hover,#cp-stage-chip:focus{border-color:#E0B341;color:#fff;outline:none}',
      '#cp-stage-warn{background:rgba(21,21,23,.96);border:1px solid rgba(224,179,65,.5);color:#E0B341;',
      '  border-radius:12px;padding:8px 11px;text-align:right;',
      '  font:600 11.5px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    ].join('\n');

    function styleOnce() {
      try {
        if (document.getElementById('cp-stage-css')) return;
        var st = document.createElement('style');
        st.id = 'cp-stage-css';
        st.textContent = gateCss() + '\n' + STAGE_CSS;   // same Tatame overlay styles as live
        document.head.appendChild(st);
      } catch (e) {}
    }

    // Re-lock affordance for someone viewing a staging app RAW (outside the
    // shell). Inside the shell the toolbar already has "⟲ Reset login", so we add
    // nothing there and never risk covering the app's own UI in the normal path.
    function mountResetChip() {
      if (framed()) return;
      whenReady(function () {
        try {
          styleOnce();
          if (document.getElementById('cp-stage-dock')) return;
          var dock = el('div');
          dock.id = 'cp-stage-dock';
          // Contract A sets storageIsolated=false when the namespaced-storage shim
          // could not be installed. Say so plainly rather than let the owner assume
          // the practice copy is safely walled off.
          if (ENV && ENV.storageIsolated === false) {
            var warn = el('div', null,
              '⚠ This practice copy is sharing saved data with the real app on this device.');
            warn.id = 'cp-stage-warn';
            dock.appendChild(warn);
          }
          var chip = el('button', null, 'STAGING · reset');
          chip.id = 'cp-stage-chip';
          chip.type = 'button';
          chip.title = RESET_NOTE;
          chip.addEventListener('click', stageReset);
          dock.appendChild(chip);
          document.body.appendChild(dock);
        } catch (e) {}
      });
    }

    if (stageStored()) { mountResetChip(); return; }   // already unlocked: no overlay

    /* ---- overlay (same markup vocabulary as the live gate) ---- */
    sOverlay = document.createElement('div');
    sOverlay.id = 'cp-auth-gate';
    sOverlay.setAttribute('role', 'dialog');
    sOverlay.setAttribute('aria-modal', 'true');
    sOverlay.setAttribute('aria-label', 'Staging preview of ' + APP);

    var sCol = el('div', 'cpag-col');
    sCol.appendChild(el('div', 'cpag-brand', 'CIA PAULISTA'));
    var sCard = el('div', 'cpag-card');
    sCol.appendChild(sCard);
    sCol.appendChild(el('div', 'cpag-foot', 'Staging preview · made-up data · not the real gym'));
    sOverlay.appendChild(sCol);

    var vCode = el('div');
    vCode.appendChild(el('div', 'cpag-stagebadge', 'STAGING'));
    vCode.appendChild(el('h1', null, APP));               // data-app title: which app is this?
    vCode.appendChild(el('div', 'cpag-sub', 'A practice copy with made-up data. Enter the staging code to look around.'));

    var sForm = document.createElement('form');
    sForm.setAttribute('novalidate', 'novalidate');
    var sLbl = el('label', null, 'Staging code'); sLbl.htmlFor = 'cpag-stage-code';
    var codeIn = document.createElement('input');
    codeIn.type = 'text'; codeIn.id = 'cpag-stage-code'; codeIn.name = 'code';
    codeIn.placeholder = 'Enter staging code';
    codeIn.autocomplete = 'off'; codeIn.spellcheck = false;
    codeIn.setAttribute('inputmode', 'numeric');
    codeIn.setAttribute('autocapitalize', 'none');
    var goBtn = el('button', 'cpag-primary'); goBtn.type = 'submit';
    goBtn.appendChild(el('span', null, 'Enter'));
    sForm.appendChild(sLbl); sForm.appendChild(codeIn); sForm.appendChild(goBtn);
    vCode.appendChild(sForm);
    vCode.appendChild(el('div', 'cpag-hint', 'The code is ' + STAGE_CODE + '. You’ll look around as ' + stageRole + '.'));
    var sMsg = el('div', 'cpag-msg'); sMsg.setAttribute('role', 'alert');
    vCode.appendChild(sMsg);
    var sResetBtn = el('button', 'cpag-link', 'Reset staging sign-in'); sResetBtn.type = 'button';
    sResetBtn.title = RESET_NOTE;
    sResetBtn.addEventListener('click', stageReset);
    vCode.appendChild(sResetBtn);

    var vOkS = el('div', 'cpag-center');
    vOkS.appendChild(el('div', 'cpag-big', '✓'));
    vOkS.appendChild(el('h2', null, 'You’re in'));
    vOkS.style.display = 'none';

    sCard.appendChild(vCode); sCard.appendChild(vOkS);

    function setSMsg(text, ok) {
      sMsg.textContent = text || '';
      sMsg.className = 'cpag-msg' + (text ? (ok ? ' cpag-ok' : ' cpag-err') : '');
    }

    function authorize() {
      if (sDone) return;
      sDone = true;
      try {
        localStorage.setItem(STAGE_KEY, JSON.stringify({
          role: stageRole, app: APP, at: new Date().toISOString(),
        }));
      } catch (e) {}
      try { document.removeEventListener('keydown', sTrap, true); } catch (e) {}
      vCode.style.display = 'none';
      vOkS.style.display = '';
      setTimeout(function () {                    // same rhythm as the live gate
        sOverlay.classList.add('cpag-out');
        setTimeout(function () {
          try { if (sOverlay.parentNode) sOverlay.parentNode.removeChild(sOverlay); } catch (e) {}
          mountResetChip();
        }, 400);
      }, 450);
    }

    sForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = String(codeIn.value || '').trim();
      if (!v) {
        setSMsg('Type the staging code first — it’s ' + STAGE_CODE + '.', false);
        try { codeIn.focus(); } catch (e) {}
        return;
      }
      if (v === STAGE_CODE) { setSMsg(''); authorize(); return; }
      setSMsg('That code doesn’t match. The staging code is ' + STAGE_CODE + '.', false);
      try { codeIn.select(); } catch (e) { try { codeIn.focus(); } catch (e2) {} }
    });

    // Same modal manners as live: while the gate is up, Tab stays inside it.
    function sTrap(ev) {
      if (sDone) return;
      if (ev.key !== 'Tab' && ev.keyCode !== 9) return;
      var nodes = sOverlay.querySelectorAll('button,input');
      var list = [];
      for (var i = 0; i < nodes.length; i++) { if (!nodes[i].disabled) list.push(nodes[i]); }
      if (!list.length) { ev.preventDefault(); return; }
      var first = list[0], last = list[list.length - 1], cur = document.activeElement;
      if (!cur || list.indexOf(cur) === -1) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); return; }
      if (ev.shiftKey && cur === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && cur === last) { ev.preventDefault(); first.focus(); }
    }

    whenReady(function () {
      try {
        styleOnce();
        document.body.appendChild(sOverlay);
        document.addEventListener('keydown', sTrap, true);
        try { codeIn.focus(); } catch (e) {}
      } catch (e) { /* never break the host app */ }
    });
  }
})();
