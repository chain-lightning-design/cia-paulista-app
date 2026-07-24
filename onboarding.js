/*!
 * Cia Paulista — shared onboarding engine (framework-agnostic, vanilla JS).
 * Works over React- or vanilla-rendered DOM: it operates on the live DOM,
 * so it does not care how the host app was built.
 *
 * Provides three tailored pieces, all optional per page:
 *   1) a Welcome modal (intro + bullets),
 *   2) an interactive guided TOUR (coach-mark spotlight on real UI elements),
 *   3) a setup CHECKLIST panel (for operator experiences).
 * Plus a persistent, re-launchable "?" help button.
 *
 * Everything is guarded: if onboarding throws or this file fails to load, the
 * host app is unaffected (onboarding is enhancement, never core). Persisted
 * state is validated on read (per the project's stale-localStorage rule).
 *
 * USAGE (call once, after the app has rendered):
 *   Onboarding.init({
 *     key: 'cp_onb_owner',              // localStorage key (required)
 *     accent: '#E11D2A',               // brand accent (optional)
 *     dark: true,                       // set true for dark apps (owner console)
 *     title: 'Welcome to the Owner Console',
 *     subtitle: 'Run your whole gym from one place.',
 *     bullets: ['Track members & billing', 'Promote belts', 'Ask the AI copilot'],
 *     tour: [ { sel:'#nav-members', title:'Members', body:'…', place:'right' }, … ],
 *     checklist: [ { label:'Add your gym profile' }, … ],   // optional
 *     helpLabel: 'Tour',                // help-button text (optional)
 *     helpPosition: 'bottom-left',      // bottom-left|bottom-right|top-right (optional)
 *     suppress: () => false             // optional; when it returns true, auto-welcome is silenced
 *   });
 *
 *   A tour step may also be action-gated instead of Next-button-advanced:
 *     { sel:'#chip-1', title:'Try it', body:'…', action:'Tap a suggestion',
 *       advanceOn:{ event:'click', target:'#chip-1' }, questId:'chip' }
 *   The tooltip's Next button is replaced by a pulsing "do it" hint, and the tour
 *   only advances once the user performs the real action (or, if questId is set,
 *   once a matching window 'guide:quest' event fires — e.g. from guide.js).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.Onboarding && window.Onboarding._v) return; // already loaded

  var CFG = null;
  var stepIdx = 0;
  var STYLE_ID = 'cp-onb-style';
  var advanceCleanup = null; // removes the current gated step's listener(s), if any

  // ---- storage (validated) -------------------------------------------------
  function seen(key) {
    try {
      var v = window.localStorage.getItem(key);
      return v === 'done' || v === 'skipped'; // only known values count
    } catch (e) { return false; }
  }
  function mark(key, val) {
    if (val !== 'done' && val !== 'skipped') return;
    try { window.localStorage.setItem(key, val); } catch (e) {}
  }

  // ---- styles --------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var accent = (CFG && CFG.accent) || '#E11D2A';
    var css = [
      '.cp-onb-scrim{position:fixed;inset:0;background:rgba(15,15,18,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;animation:cpOnbFade .18s ease}',
      '@keyframes cpOnbFade{from{opacity:0}to{opacity:1}}',
      '.cp-onb-card{background:#fff;color:#18181b;max-width:440px;width:100%;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.4);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;animation:cpOnbPop .2s ease}',
      '@keyframes cpOnbPop{from{transform:translateY(8px) scale(.98);opacity:0}to{transform:none;opacity:1}}',
      '.cp-onb-hd{padding:22px 24px 6px}',
      '.cp-onb-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' + accent + ';margin-bottom:10px}',
      '.cp-onb-badge b{width:8px;height:8px;border-radius:50%;background:' + accent + ';display:inline-block}',
      '.cp-onb-title{font-size:21px;font-weight:800;line-height:1.2;margin:0 0 6px}',
      '.cp-onb-sub{font-size:14px;color:#52525b;margin:0;line-height:1.5}',
      '.cp-onb-bd{padding:14px 24px 4px}',
      '.cp-onb-li{display:flex;gap:11px;align-items:flex-start;padding:8px 0;font-size:14px;color:#27272a;line-height:1.45}',
      '.cp-onb-li i{flex:none;width:22px;height:22px;border-radius:50%;background:' + accent + '1a;color:' + accent + ';display:flex;align-items:center;justify-content:center;font-style:normal;font-size:12px;font-weight:800;margin-top:1px}',
      '.cp-onb-ft{display:flex;gap:10px;align-items:center;padding:16px 24px 22px}',
      '.cp-onb-btn{border:0;border-radius:11px;padding:11px 16px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.cp-onb-primary{background:' + accent + ';color:#fff;flex:1}',
      '.cp-onb-primary:hover{filter:brightness(.94)}',
      '.cp-onb-ghost{background:transparent;color:#71717a}',
      '.cp-onb-ghost:hover{color:#18181b}',
      // spotlight tour
      '.cp-onb-hole{position:fixed;z-index:2147483001;border-radius:10px;box-shadow:0 0 0 9999px rgba(15,15,18,.62);transition:all .25s cubic-bezier(.4,0,.2,1);pointer-events:none}',
      // accent ring around the spotlighted target; gated ("do it") steps pulse so the eye lands on the action
      '.cp-onb-hole::after{content:"";position:absolute;inset:-3px;border-radius:13px;box-shadow:0 0 0 2px ' + accent + ',0 0 22px 3px rgba(225,29,42,.35);pointer-events:none}',
      '.cp-onb-hole.cp-gated::after{animation:cpOnbRing 1.5s ease-in-out infinite}',
      '@keyframes cpOnbRing{0%,100%{box-shadow:0 0 0 2px ' + accent + ',0 0 18px 2px rgba(225,29,42,.3)}50%{box-shadow:0 0 0 4px ' + accent + ',0 0 32px 9px rgba(225,29,42,.6)}}',
      '@media (prefers-reduced-motion:reduce){.cp-onb-hole.cp-gated::after{animation:none}}',
      '.cp-onb-tip{position:fixed;z-index:2147483002;background:#1c1c22;color:#f4f4f5;max-width:300px;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:16px 17px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;animation:cpOnbPop .2s ease;transition:opacity .25s ease}',
      // Discretion while editing: when the user focuses a field elsewhere on the page, the tip fades to
      // near-transparent + click-through so it never blocks what they are doing (restored on blur/focusout).
      '.cp-onb-tip.cp-faded{opacity:.12;pointer-events:none}',
      '.cp-onb-tip h4{margin:0 0 6px;font-size:15px;font-weight:800;color:#fff}',
      '.cp-onb-tip p{margin:0;font-size:13px;line-height:1.5;color:#c7c7cf}',
      '.cp-onb-tip .cp-onb-trow{display:flex;align-items:center;gap:8px;margin-top:14px}',
      '.cp-onb-dots{display:flex;gap:5px;flex:1}',
      '.cp-onb-dot{width:6px;height:6px;border-radius:50%;background:#4b4b55}',
      '.cp-onb-dot.on{background:' + accent + ';width:16px;border-radius:3px}',
      '.cp-onb-mini{background:transparent;border:0;color:#a1a1aa;font-size:13px;font-weight:600;cursor:pointer;padding:6px 8px;font-family:inherit}',
      '.cp-onb-mini:hover{color:#fff}',
      '.cp-onb-next{background:' + accent + ';color:#fff;border:0;border-radius:9px;padding:8px 15px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.cp-onb-doit{font-size:13px;font-weight:700;color:' + accent + ';animation:cpOnbPulse 1.4s ease-in-out infinite}',
      '@keyframes cpOnbPulse{0%,100%{opacity:1}50%{opacity:.45}}',
      '.cp-onb-skip{position:fixed;z-index:2147483002;top:16px;right:16px;background:rgba(28,28,34,.9);color:#f4f4f5;border:0;border-radius:9px;padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}',
      // checklist
      '.cp-onb-check{position:fixed;z-index:2147482999;bottom:18px;right:18px;width:290px;background:#fff;color:#18181b;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.28);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
      '.cp-onb-check .ch-hd{padding:14px 16px;background:' + accent + ';color:#fff;display:flex;align-items:center;justify-content:space-between}',
      '.cp-onb-check .ch-hd b{font-size:14px;font-weight:800}',
      '.cp-onb-check .ch-x{background:transparent;border:0;color:#fff;cursor:pointer;font-size:16px;opacity:.85}',
      '.cp-onb-check .ch-bar{height:5px;background:#eee}',
      '.cp-onb-check .ch-bar i{display:block;height:100%;background:' + accent + ';transition:width .3s}',
      '.cp-onb-item{display:flex;gap:10px;align-items:center;padding:11px 16px;font-size:13.5px;cursor:pointer;border-bottom:1px solid #f4f4f5}',
      '.cp-onb-item:hover{background:#fafafa}',
      '.cp-onb-item i{flex:none;width:20px;height:20px;border-radius:50%;border:2px solid #d4d4d8;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:11px;color:#fff}',
      '.cp-onb-item.on i{background:' + accent + ';border-color:' + accent + '}',
      '.cp-onb-item.on span{color:#a1a1aa;text-decoration:line-through}',
      // guided (action) checklist rows: a stacked label + destination hint, plus a subtle "›" affordance
      '.cp-onb-item .ck-text{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}',
      '.cp-onb-item .ck-hint{font-style:normal;font-size:11px;color:#a1a1aa;line-height:1.3}',
      '.cp-onb-item.on .ck-hint{color:#c4c4cc}',
      '.cp-onb-item .ck-go{flex:none;color:#c4c4cc;font-size:18px;font-weight:700;line-height:1;transition:color .15s ease,transform .15s ease}',
      '.cp-onb-item.cp-onb-actionable:hover .ck-go{color:' + accent + ';transform:translateX(2px)}',
      // help button
      '.cp-onb-help{position:fixed;z-index:2147482998;background:' + accent + ';color:#fff;border:0;border-radius:999px;height:40px;padding:0 15px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.25);display:flex;align-items:center;gap:7px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
      '.cp-onb-help b{display:inline-flex;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.25);align-items:center;justify-content:center;font-size:12px}',
      '.cp-onb-help:hover{filter:brightness(.95)}'
    ].join('');
    var s = document.createElement('style');
    s.id = STYLE_ID; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function rm(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  // ---- welcome modal -------------------------------------------------------
  function showWelcome() {
    try {
      injectStyles();
      closeWelcome();
      var scrim = el('div', 'cp-onb-scrim'); scrim.id = 'cp-onb-welcome';
      var card = el('div', 'cp-onb-card');
      var hd = el('div', 'cp-onb-hd');
      hd.appendChild(el('div', 'cp-onb-badge', '<b></b> Getting started'));
      hd.appendChild(el('h3', 'cp-onb-title', esc(CFG.title || 'Welcome')));
      if (CFG.subtitle) hd.appendChild(el('p', 'cp-onb-sub', esc(CFG.subtitle)));
      card.appendChild(hd);
      if (CFG.bullets && CFG.bullets.length) {
        var bd = el('div', 'cp-onb-bd');
        CFG.bullets.forEach(function (b) {
          bd.appendChild(el('div', 'cp-onb-li', '<i>&#10003;</i><span>' + esc(b) + '</span>'));
        });
        card.appendChild(bd);
      }
      var ft = el('div', 'cp-onb-ft');
      var hasTour = CFG.tour && CFG.tour.length;
      var primary = el('button', 'cp-onb-btn cp-onb-primary', hasTour ? 'Take the tour' : 'Get started');
      primary.onclick = function () { closeWelcome(); if (hasTour) startTour(); else finish('done'); };
      var skip = el('button', 'cp-onb-btn cp-onb-ghost', 'Skip for now');
      skip.onclick = function () { closeWelcome(); finish('skipped'); };
      ft.appendChild(primary); ft.appendChild(skip);
      card.appendChild(ft);
      scrim.appendChild(card);
      scrim.addEventListener('click', function (e) { if (e.target === scrim) { closeWelcome(); finish('skipped'); } });
      document.body.appendChild(scrim);
    } catch (e) { /* never break the host */ }
  }
  function closeWelcome() { rm(document.getElementById('cp-onb-welcome')); }

  // ---- guided tour ---------------------------------------------------------
  function startTour(customSteps) {
    if (customSteps && customSteps.length) CFG.tour = customSteps; // optional explicit steps override CFG.tour
    if (!CFG.tour || !CFG.tour.length) { finish('done'); return; }
    injectStyles();
    stepIdx = 0;
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onTipFocusIn);
    document.addEventListener('focusout', onTipFocusOut);
    renderStep();
  }
  function onKey(e) {
    if (!document.getElementById('cp-onb-tip')) return;
    if (e.key === 'Escape') { endTour('skipped'); }
    else if (e.key === 'ArrowRight') { nextStep(); }
    else if (e.key === 'ArrowLeft') { prevStep(); }
  }
  // Tip discretion while editing (generic; all apps): fade the tip out of the way whenever the user is
  // typing in a field that is NOT part of the tip itself, restore it when they leave the field. The
  // spotlight hole stays put; only the tip fades. Keyboard nav (Esc/arrows) keeps working while faded.
  function isEditableTarget(node) {
    var tag = node && node.tagName ? String(node.tagName).toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }
  function onTipFocusIn(e) {
    try {
      var tip = document.getElementById('cp-onb-tip'); if (!tip) return;
      var t = e && e.target;
      if (!isEditableTarget(t)) return;
      if (t.closest && t.closest('#cp-onb-tip')) return; // focus inside the tip → keep it fully visible
      tip.classList.add('cp-faded');
    } catch (err) { /* never break the host */ }
  }
  function onTipFocusOut(e) {
    try {
      var tip = document.getElementById('cp-onb-tip'); if (!tip) return;
      var t = e && e.target;
      if (t && !isEditableTarget(t)) return; // only an editable losing focus restores the tip
      tip.classList.remove('cp-faded');
    } catch (err) { /* never break the host */ }
  }
  function firstVisibleFrom(idx) {
    // skip steps whose target is missing, so a stale selector never dead-ends the tour
    for (var i = idx; i < CFG.tour.length; i++) {
      var st = CFG.tour[i];
      if (!st.sel) return i; // selector-less step (centered note) always shows
      if (document.querySelector(st.sel)) return i;
    }
    return -1;
  }
  function qVis(sel) {
    // prefer the first VISIBLE match (e.g. mobile drawer copy when the desktop rail
    // is display:none); fall back to first match — jsdom has no layout, everything
    // measures 0 there, and the old querySelector behavior must be preserved.
    var list = document.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.getClientRects && n.getClientRects().length && (n.offsetWidth || n.offsetHeight)) return n;
    }
    return list[0] || null;
  }
  function renderStep() {
    var i = firstVisibleFrom(stepIdx);
    if (i < 0) { endTour('done'); return; }
    stepIdx = i;
    var step = CFG.tour[stepIdx];
    var target = step.sel ? qVis(step.sel) : null;
    if (target && target.scrollIntoView) {
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { target.scrollIntoView(); }
    }
    // draw after a tick so scroll settles
    setTimeout(function () { paintStep(target, step); }, target ? 180 : 0);
  }
  function paintStep(target, step) {
    clearAdvanceListeners(); // moving to a new step always retires the previous step's gate

    var hole = document.getElementById('cp-onb-hole') || el('div', 'cp-onb-hole');
    hole.id = 'cp-onb-hole';
    hole.className = 'cp-onb-hole' + (step.advanceOn ? ' cp-gated' : ''); // gated steps get the pulsing accent ring
    var tip = document.getElementById('cp-onb-tip');
    if (tip) rm(tip);
    tip = el('div', 'cp-onb-tip'); tip.id = 'cp-onb-tip';

    var total = CFG.tour.length;
    var dots = '';
    for (var d = 0; d < total; d++) dots += '<span class="cp-onb-dot' + (d === stepIdx ? ' on' : '') + '"></span>';
    var isLast = firstVisibleFrom(stepIdx + 1) < 0;
    var backBtn = stepIdx > 0 ? '<button class="cp-onb-mini" data-onb="back">Back</button>' : '';
    var footer = step.advanceOn
      ? ('<span class="cp-onb-doit">👆 ' + esc(step.action || 'Do it to continue') + '</span>')
      : ('<button class="cp-onb-next" data-onb="next">' + (isLast ? 'Done' : 'Next') + '</button>');
    tip.innerHTML =
      '<h4>' + esc(step.title || '') + '</h4>' +
      '<p>' + esc(step.body || '') + '</p>' +
      '<div class="cp-onb-trow"><div class="cp-onb-dots">' + dots + '</div>' + backBtn + footer + '</div>';

    if (target && target.getBoundingClientRect) {
      var r = target.getBoundingClientRect();
      var pad = 6;
      hole.style.display = 'block';
      hole.style.top = (r.top - pad) + 'px';
      hole.style.left = (r.left - pad) + 'px';
      hole.style.width = (r.width + pad * 2) + 'px';
      hole.style.height = (r.height + pad * 2) + 'px';
      if (!hole.parentNode) document.body.appendChild(hole);
      positionTip(tip, r, step.place);
    } else {
      // no target → centered note over a plain dim scrim
      hole.style.display = 'none';
      if (!hole.parentNode) document.body.appendChild(hole);
      tip.style.top = '50%'; tip.style.left = '50%';
      tip.style.transform = 'translate(-50%,-50%)';
    }
    document.body.appendChild(tip);

    if (!document.getElementById('cp-onb-skipbtn')) {
      var sk = el('button', 'cp-onb-skip', 'Skip tour'); sk.id = 'cp-onb-skipbtn';
      sk.onclick = function () { endTour('skipped'); };
      document.body.appendChild(sk);
    }
    tip.querySelectorAll('[data-onb]').forEach(function (b) {
      b.onclick = function () { b.getAttribute('data-onb') === 'back' ? prevStep() : nextStep(); };
    });

    if (step.advanceOn) armAdvanceOn(step);
  }
  // Gated steps advance only once the user performs the real action. Independent, additive gates:
  //   advanceOn.target — advance on a matching event (default 'click'), via document-level delegation
  //                      (closest(target)) so a React re-render swapping the node never orphans it;
  //   advanceOn.gone   — advance once the given selector LEAVES the DOM (whenGone: the counterpart to
  //                      whenPresent; MutationObserver + interval backstop) so a drawer that closes via
  //                      the ✕, a backdrop tap, OR an action button all count uniformly;
  //   step.questId     — advance on a matching window 'guide:quest' event (e.g. bridged from guide.js).
  function armAdvanceOn(step) {
    try {
      var ao = step.advanceOn || {};
      var evtName = ao.event || 'click';
      var targetSel = ao.target;
      var goneSel = ao.gone;
      var questId = step.questId;
      var cleaners = [];
      var advance = function () { clearAdvanceListeners(); nextStep(); };

      if (targetSel) {
        var onDomEvent = function (e) {
          try { if (e.target && e.target.closest && e.target.closest(targetSel)) advance(); } catch (err) {}
        };
        document.addEventListener(evtName, onDomEvent, true);
        cleaners.push(function () { document.removeEventListener(evtName, onDomEvent, true); });
      }
      if (questId) {
        var onQuestEvent = function (e) {
          try { if (e && e.detail && e.detail.id === questId) advance(); } catch (err) {}
        };
        window.addEventListener('guide:quest', onQuestEvent);
        cleaners.push(function () { window.removeEventListener('guide:quest', onQuestEvent); });
      }
      if (goneSel) {
        // The step only ever arms while its target IS present (firstVisibleFrom skips a missing-target
        // step), so we watch for it to disappear rather than checking synchronously up-front.
        var goneObs = null, goneIv = null, fired = false;
        var stopGone = function () {
          if (goneObs) { try { goneObs.disconnect(); } catch (e) {} goneObs = null; }
          if (goneIv) { clearInterval(goneIv); goneIv = null; }
        };
        var checkGone = function () {
          if (fired) return;
          if (!document.querySelector(goneSel)) { fired = true; stopGone(); advance(); }
        };
        try { goneObs = new MutationObserver(checkGone); goneObs.observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch (e) {}
        goneIv = setInterval(checkGone, 150);
        cleaners.push(stopGone);
      }
      advanceCleanup = function () { while (cleaners.length) { try { cleaners.pop()(); } catch (e) {} } };
    } catch (e) { /* never break the host */ }
  }
  function clearAdvanceListeners() {
    if (advanceCleanup) { try { advanceCleanup(); } catch (e) {} advanceCleanup = null; }
  }
  function positionTip(tip, r, place) {
    tip.style.transform = 'none';
    var vw = window.innerWidth, vh = window.innerHeight, tw = 300, th = 150, gap = 14;
    var p = place || (r.bottom + th + gap < vh ? 'bottom' : (r.top - th - gap > 0 ? 'top' : 'right'));
    var top, left;
    if (p === 'bottom') { top = r.bottom + gap; left = r.left; }
    else if (p === 'top') { top = r.top - th - gap; left = r.left; }
    else if (p === 'left') { top = r.top; left = r.left - tw - gap; }
    else { top = r.top; left = r.right + gap; } // right
    left = Math.max(12, Math.min(left, vw - tw - 12));
    top = Math.max(12, Math.min(top, vh - th - 12));
    tip.style.top = top + 'px'; tip.style.left = left + 'px';
  }
  function reposition() {
    var tip = document.getElementById('cp-onb-tip');
    if (!tip || !CFG.tour[stepIdx]) return;
    var step = CFG.tour[stepIdx];
    var target = step.sel ? qVis(step.sel) : null; // same visible-copy resolution as renderStep
    if (target && target.getBoundingClientRect) {
      var r = target.getBoundingClientRect(), hole = document.getElementById('cp-onb-hole'), pad = 6;
      if (hole) { hole.style.top = (r.top - pad) + 'px'; hole.style.left = (r.left - pad) + 'px'; hole.style.width = (r.width + pad * 2) + 'px'; hole.style.height = (r.height + pad * 2) + 'px'; }
      positionTip(tip, r, step.place);
    }
  }
  function nextStep() { stepIdx++; if (firstVisibleFrom(stepIdx) < 0) endTour('done'); else renderStep(); }
  function prevStep() { stepIdx = Math.max(0, stepIdx - 1); renderStep(); }
  function endTour(how) {
    clearAdvanceListeners();
    rm(document.getElementById('cp-onb-hole'));
    rm(document.getElementById('cp-onb-tip'));
    rm(document.getElementById('cp-onb-skipbtn'));
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onTipFocusIn);
    document.removeEventListener('focusout', onTipFocusOut);
    finish(how === 'skipped' ? 'skipped' : 'done');
    if (how !== 'skipped' && CFG.checklist && CFG.checklist.length) openChecklist();
  }

  // ---- checklist -----------------------------------------------------------
  // A checklist item is either LEGACY {label} — clicking toggles its own _ck checkbox (platform-control's
  // behavior, unchanged) — or GUIDED {label, hint?, action:fn}: it renders a "›" affordance + a destination
  // hint, and clicking calls it.action() and NEVER toggles. A guided item's checked state is driven PURELY
  // by the _ck store, which the host writes once the underlying task is actually done. While the panel is
  // open we listen for a window 'cp:onb-refresh' event and re-read the store, so rows tick themselves live
  // (the user watches the checklist complete itself). CFG.checklistTitle overrides the default header text.
  var checklistRefresh = null; // the single cp:onb-refresh listener while a panel is open (null otherwise)

  function openChecklist() {
    try {
      if (!CFG || !CFG.checklist || !CFG.checklist.length) return;
      injectStyles();
      renderChecklist();
      if (!checklistRefresh) { // guard against duplicate listeners across repeated opens
        checklistRefresh = function () {
          // Self-healing: if the panel was removed by the host (not via ✕), drop the listener.
          if (document.getElementById('cp-onb-check')) renderChecklist();
          else detachChecklistRefresh();
        };
        window.addEventListener('cp:onb-refresh', checklistRefresh);
      }
    } catch (e) {}
  }
  function detachChecklistRefresh() {
    if (checklistRefresh) { try { window.removeEventListener('cp:onb-refresh', checklistRefresh); } catch (e) {} checklistRefresh = null; }
  }
  function closeChecklist() {
    detachChecklistRefresh();
    rm(document.getElementById('cp-onb-check'));
  }
  function renderChecklist() {
    try {
      if (!CFG || !CFG.checklist || !CFG.checklist.length) return;
      var ckey = CFG.key + '_ck';
      var state = readCk(ckey);
      rm(document.getElementById('cp-onb-check'));
      var wrap = el('div', 'cp-onb-check'); wrap.id = 'cp-onb-check';
      var done = 0; CFG.checklist.forEach(function (_, i) { if (state[i]) done++; });
      var pct = Math.round(done / CFG.checklist.length * 100);
      var title = CFG.checklistTitle || 'Set up your gym';
      var hd = el('div', 'ch-hd', '<b>' + esc(title) + '</b>');
      var x = el('button', 'ch-x', '&times;'); x.onclick = function () { closeChecklist(); };
      hd.appendChild(x); wrap.appendChild(hd);
      var bar = el('div', 'ch-bar', '<i style="width:' + pct + '%"></i>'); wrap.appendChild(bar);
      CFG.checklist.forEach(function (it, i) {
        var hasAction = it && typeof it.action === 'function';
        var html = '<i>&#10003;</i><div class="ck-text"><span>' + esc(it.label) + '</span>' +
          (hasAction && it.hint ? '<em class="ck-hint">' + esc(it.hint) + '</em>' : '') + '</div>' +
          (hasAction ? '<b class="ck-go">&rsaquo;</b>' : '');
        var row = el('div', 'cp-onb-item' + (state[i] ? ' on' : '') + (hasAction ? ' cp-onb-actionable' : ''), html);
        if (hasAction) {
          // Guided: deep-link into the real task. Never toggles — the host writes _ck when the task is done.
          row.onclick = function () { try { it.action(); } catch (e) {} };
        } else {
          // Legacy: clicking toggles this item's own checkbox (re-read the store each time, then persist).
          row.onclick = function () { var st = readCk(ckey); st[i] = !st[i]; writeCk(ckey, st); renderChecklist(); };
        }
        wrap.appendChild(row);
      });
      document.body.appendChild(wrap);
    } catch (e) {}
  }
  function readCk(k) { try { return JSON.parse(window.localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } }
  function writeCk(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ---- help button ---------------------------------------------------------
  function mountHelp() {
    if (document.getElementById('cp-onb-help')) return;
    var b = el('button', 'cp-onb-help', '<b>?</b> ' + esc(CFG.helpLabel || 'Tour')); b.id = 'cp-onb-help';
    var pos = CFG.helpPosition || 'bottom-left';
    if (pos === 'bottom-right') { b.style.bottom = '18px'; b.style.right = '18px'; }
    else if (pos === 'top-right') { b.style.top = '18px'; b.style.right = '18px'; }
    else { b.style.bottom = '18px'; b.style.left = '18px'; }
    b.onclick = function () { showWelcome(); };
    document.body.appendChild(b);
  }

  function finish(val) { mark(CFG.key, val); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ---- public API ----------------------------------------------------------
  function init(config) {
    try {
      if (!config || !config.key) return;
      CFG = config;
      injectStyles();
      if (config.mountHelp !== false) {
        // wait for body if called very early
        if (document.body) mountHelp();
        else document.addEventListener('DOMContentLoaded', mountHelp);
      }
      var suppressed = false;
      try { suppressed = typeof config.suppress === 'function' && !!config.suppress(); } catch (e2) { suppressed = false; }
      if (config.autorun !== false && !suppressed && !seen(config.key)) {
        // let the (possibly React) app paint first
        setTimeout(function () { showWelcome(); }, config.delay != null ? config.delay : 700);
      }
    } catch (e) { /* onboarding must never break the app */ }
  }

  window.Onboarding = {
    _v: '1.0.0',
    init: init,
    showWelcome: function () { if (CFG) showWelcome(); },
    startTour: function (steps) { if (CFG) startTour(steps && steps.length ? steps : null); },
    // The step currently on screen (or null) — lets a host lock everything EXCEPT the step's intended target.
    currentStep: function () { try { return (document.getElementById('cp-onb-tip') && CFG && CFG.tour) ? CFG.tour[stepIdx] : null; } catch (e) { return null; } },
    openChecklist: openChecklist,
    reset: function () { try { if (CFG) { window.localStorage.removeItem(CFG.key); window.localStorage.removeItem(CFG.key + '_ck'); } } catch (e) {} }
  };
})();
