/*!
 * Cia Paulista — day-zero Guide engine (framework-agnostic, vanilla JS, no deps).
 * Owns the cp_day0 quest state machine, cp_telemetry event log, and cp_tips
 * path-learning tip registry. Pure data/state layer — it renders nothing itself;
 * host pages read Guide.state()/Guide.QUESTS/Guide.checkTips() to draw their own UI.
 *
 * Safe to load in ANY page, including inside an iframe (owner-console runs both
 * standalone AND inside assistant-home's iframe, same origin/localStorage):
 *   - all reads are validated + self-healing (never throw, never trust raw storage)
 *   - Guide.track() never throws and always leaves cp_telemetry as valid JSON
 *   - Guide.checkTips() returns null when NOT the top window, so tips only
 *     ever surface in the top-level frame; telemetry writes work from any frame.
 *
 * localStorage keys owned here: cp_day0, cp_telemetry, cp_tips.
 * Also wiped (not owned) by Guide.reset(): ah_onboarded, ah_intro_dashboard,
 * ah_nudges, cp_onb_owner, cp_onb_owner_ck, cp_tab, ah_view, ah_recents
 * (old-onboarding consolidation keys — "Reset demo" must yield a truly fresh pitch).
 *
 * USAGE:
 *   Load guide.js via a script tag BEFORE the app's own babel script, then:
 *   Guide.init({app:'assistant'});     // once per page load
 *   Guide.track('ask', {source:'chip', q:'...'});
 *   if (Guide.active()) { ...show quest HUD using Guide.state()/Guide.QUESTS... }
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.Guide) return; // already loaded in this frame

  var KEY_DAY0 = 'cp_day0';
  var KEY_TELEMETRY = 'cp_telemetry';
  var KEY_TIPS = 'cp_tips';
  var CONSOLIDATION_KEYS = ['ah_onboarded', 'ah_intro_dashboard', 'ah_nudges', 'cp_onb_owner', 'cp_onb_owner_ck', 'cp_tab', 'ah_view', 'ah_recents'];
  var TELEMETRY_CAP = 300;
  var TIP_SHOW_CAP = 3;

  var QUEST_IDS = ['chip', 'ask', 'drill', 'pricing', 'roundtrip', 'learn'];

  var QUESTS = [
    { id: 'chip', icon: '💬', title: 'First win', hint: 'Tap a suggested question' },
    { id: 'ask', icon: '⌨️', title: 'Ask your own', hint: 'Type anything about your gym' },
    { id: 'drill', icon: '📊', title: "Find who hasn't paid", hint: 'Dashboard → Billing' },
    { id: 'pricing', icon: '⚙️', title: 'Review your pricing', hint: 'Settings → Classes & Pricing' },
    { id: 'roundtrip', icon: '🔁', title: 'The round trip', hint: 'Jump back to Assistant in one tap' },
    { id: 'learn', icon: '🎓', title: 'Know where answers live', hint: 'Peek at the Learn hub' }
  ];

  var currentApp = null; // set by Guide.init({app})

  // ---- tiny utils ------------------------------------------------------
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function lsRemove(k) { try { window.localStorage.removeItem(k); } catch (e) {} }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k]; }
    }
    return target;
  }
  function fire(name, detail) {
    try {
      var ev;
      if (typeof window.CustomEvent === 'function') ev = new window.CustomEvent(name, { detail: detail });
      else { ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail); }
      window.dispatchEvent(ev);
    } catch (e) { /* never break the host */ }
  }

  // ---- cp_day0 (validated, self-healing) --------------------------------
  function defaultDay0() {
    return {
      v: 1, name: '', gymName: '', signedUp: false, story: false,
      quests: { chip: false, ask: false, drill: false, pricing: false, roundtrip: false, learn: false },
      startedAt: null, completedAt: null, skipped: false
    };
  }
  function readDay0() {
    try {
      var raw = lsGet(KEY_DAY0);
      if (!raw) return defaultDay0();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaultDay0();
      if (parsed.v !== 1) return defaultDay0();
      if (!parsed.quests || typeof parsed.quests !== 'object') return defaultDay0();
      for (var i = 0; i < QUEST_IDS.length; i++) { if (!(QUEST_IDS[i] in parsed.quests)) return defaultDay0(); }
      var def = defaultDay0();
      var merged = assign({}, def, parsed);
      merged.quests = assign({}, def.quests, parsed.quests);
      return merged;
    } catch (e) { return defaultDay0(); }
  }
  function writeDay0(state) { lsSet(KEY_DAY0, JSON.stringify(state)); }

  function state() { return readDay0(); }

  function save(patch) {
    try {
      var cur = readDay0();
      var next = assign({}, cur, patch || {}, { v: 1 });
      writeDay0(next);
      fire('guide:change', next);
      return next;
    } catch (e) { return readDay0(); }
  }

  function active() {
    var s = readDay0();
    return !!(s.signedUp && !s.completedAt && !s.skipped);
  }

  function completeQuest(id) {
    try {
      if (QUEST_IDS.indexOf(id) === -1) return; // guard: unknown id, safe no-op
      var s = readDay0();
      if (s.quests[id] === true) return; // idempotent: already done, no state change, no event
      var quests = assign({}, s.quests);
      quests[id] = true;
      var allDone = QUEST_IDS.every(function (q) { return quests[q]; });
      var patch = { quests: quests };
      if (allDone && !s.completedAt) patch.completedAt = Date.now();
      save(patch);
      fire('guide:quest', { id: id, done: true, all: allDone });
    } catch (e) { /* never break the host */ }
  }

  function skip() { save({ skipped: true }); }
  function resume() { save({ skipped: false }); }

  function reset() {
    lsRemove(KEY_DAY0);
    lsRemove(KEY_TELEMETRY);
    lsRemove(KEY_TIPS);
    for (var i = 0; i < CONSOLIDATION_KEYS.length; i++) lsRemove(CONSOLIDATION_KEYS[i]);
  }

  // ---- cp_telemetry -------------------------------------------------------
  function readTelemetry() {
    try {
      var raw = lsGet(KEY_TELEMETRY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeTelemetry(arr) { lsSet(KEY_TELEMETRY, JSON.stringify(arr)); }

  function track(ev, data) {
    try {
      var arr = readTelemetry();
      var safeData;
      try { safeData = data ? JSON.parse(JSON.stringify(data)) : {}; } catch (e2) { safeData = {}; }
      arr.push({ t: Date.now(), app: currentApp, ev: ev, data: safeData });
      if (arr.length > TELEMETRY_CAP) arr = arr.slice(arr.length - TELEMETRY_CAP);
      writeTelemetry(arr);
    } catch (e) { /* Guide.track must never throw */ }
  }

  function init(cfg) {
    try {
      if (cfg && cfg.app) currentApp = cfg.app;
      track('session', {});
    } catch (e) {}
  }

  // ---- cp_tips --------------------------------------------------------
  function readTips() {
    try {
      var raw = lsGet(KEY_TIPS);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }
  function writeTips(obj) { lsSet(KEY_TIPS, JSON.stringify(obj)); }
  function tipRecord(tips, id) { return tips[id] || { shown: 0, dismissed: false, doneAt: null }; }

  function tipShown(id) {
    try {
      var tips = readTips();
      var rec = tipRecord(tips, id);
      rec.shown = (rec.shown || 0) + 1;
      tips[id] = rec;
      writeTips(tips);
      track('tip', { id: id }); // marks "a tip was shown this session" for checkTips()'s 1/session gate
    } catch (e) {}
  }
  function tipDismissed(id) {
    try {
      var tips = readTips();
      var rec = tipRecord(tips, id);
      rec.dismissed = true;
      tips[id] = rec;
      writeTips(tips);
    } catch (e) {}
  }
  function tipDone(id) {
    try {
      var tips = readTips();
      var rec = tipRecord(tips, id);
      rec.doneAt = Date.now();
      tips[id] = rec;
      writeTips(tips);
    } catch (e) {}
  }

  // ---- path-learning: session grouping + helpers (pure internal fns) ------
  // A "session" = events between consecutive 'session' events for the same app.
  function sessionsForApp(T, app) {
    var events = T.filter(function (e) { return e && e.app === app; });
    var sessions = [];
    var cur = null;
    events.forEach(function (e) {
      if (e.ev === 'session') { cur = [e]; sessions.push(cur); }
      else { if (!cur) { cur = []; sessions.push(cur); } cur.push(e); }
    });
    return sessions;
  }
  // a 'nav' to target preceded by >= n OTHER console navs in the same session
  function reachedVia(session, target, n) {
    var navs = session.filter(function (e) { return e.ev === 'nav'; });
    for (var i = 0; i < navs.length; i++) {
      var to = navs[i].data && navs[i].data.to;
      if (to === target) {
        var priorOther = navs.slice(0, i).filter(function (e) { return (e.data && e.data.to) !== target; });
        if (priorOther.length >= n) return true;
      }
    }
    return false;
  }
  function countSessions(T, predicate) {
    var sessions = sessionsForApp(T, 'console');
    var n = 0;
    sessions.forEach(function (s) { try { if (predicate(s)) n++; } catch (e) {} });
    return n;
  }
  function daysAgo(days) { return Date.now() - days * 24 * 60 * 60 * 1000; }
  function consoleSessions(T, days) {
    var cutoff = daysAgo(days);
    return T.filter(function (e) { return e && e.app === 'console' && e.ev === 'session' && e.t >= cutoff; }).length;
  }
  function asks(T, days) {
    var cutoff = daysAgo(days);
    return T.filter(function (e) { return e && e.ev === 'ask' && e.t >= cutoff; }).length;
  }
  function currentSessionEvents(T) {
    var events = T.filter(function (e) { return e && e.app === currentApp; });
    var lastSessionIdx = -1;
    for (var i = events.length - 1; i >= 0; i--) { if (events[i].ev === 'session') { lastSessionIdx = i; break; } }
    return lastSessionIdx === -1 ? events : events.slice(lastSessionIdx);
  }
  function tipAlreadyShownThisSession(T) {
    return currentSessionEvents(T).some(function (e) { return e.ev === 'tip'; });
  }

  var TIPS = [
    { id: 'billing-longpath',
      when: function (T) { return countSessions(T, function (s) { return reachedVia(s, 'Billing', 2); }) >= 3; },
      title: 'A faster way to check payments',
      body: 'We noticed you usually reach Billing after a few stops. There\'s a two-step path — and a one-line ask — that gets the same answer.',
      cta: 'Show me how',
      how: { ask: 'Who hasn\'t paid this month?', dash: ['Open Dashboard view', 'Click Billing in the sidebar — it\'s one tap from anywhere'] } },
    { id: 'ask-instead', // replaces the old hard-coded ah_nudges underuse nudge
      when: function (T) { return consoleSessions(T, 7) >= 3 && asks(T, 7) === 0; },
      title: 'You can just ask',
      body: 'You\'ve been browsing the Dashboard a lot — which works! But anything you hunt for there, the assistant can answer in one line.',
      cta: 'Show me how',
      how: { ask: 'Who\'s training this week?' } },
    { id: 'lookup-longpath',
      when: function (T) { return countSessions(T, function (s) { return reachedVia(s, 'Members', 2); }) >= 3; },
      title: 'Find anyone in one line',
      body: 'Looking someone up? Ask the assistant by name — profile, billing, and attendance in one answer.',
      cta: 'Show me how',
      how: { ask: 'Look up Jo Santos' } }
  ];

  function checkTips() {
    try {
      if (window !== window.top) return null; // tips only ever surface in the top-level frame
      var T = readTelemetry();
      if (tipAlreadyShownThisSession(T)) return null; // max one tip per page load
      var tips = readTips();
      for (var i = 0; i < TIPS.length; i++) {
        var def = TIPS[i];
        var rec = tipRecord(tips, def.id);
        if (rec.dismissed) continue;
        if ((rec.shown || 0) >= TIP_SHOW_CAP) continue;
        var qualifies = false;
        try { qualifies = !!def.when(T); } catch (e) { qualifies = false; }
        if (qualifies) return { id: def.id, title: def.title, body: def.body, cta: def.cta, how: def.how };
      }
      return null;
    } catch (e) { return null; }
  }

  // ---- public API ----------------------------------------------------------
  window.Guide = {
    _v: '1.0.0',
    state: state,
    save: save,
    active: active,
    completeQuest: completeQuest,
    skip: skip,
    resume: resume,
    reset: reset,
    track: track,
    init: init,
    checkTips: checkTips,
    tipShown: tipShown,
    tipDismissed: tipDismissed,
    tipDone: tipDone,
    QUESTS: QUESTS
  };
})();
