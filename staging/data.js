/* CP.data — the shared live data layer (MVP seam swap).
 *
 * Contract (frozen — docs/superpowers/plans/2026-07-20-live-mvp.md):
 *   - localStorage stays the SYNCHRONOUS source of truth the apps read at init.
 *     Cloud (Supabase) reconciles in the background and fires change events.
 *   - Fail-soft by construction: no config / offline / signed-out => every call
 *     still works exactly like the localStorage pilot. Writes queue and flush.
 *   - Browser holds ONLY the anon key (public by design; RLS is the lock).
 *
 * Load order in each app:  vendor/supabase.js  ->  data.js  ->  app script.
 * Works without vendor/supabase.js too (pure local mode).
 */
(function () {
  'use strict';

  // Filled at credential time; overridable via localStorage cp_data_cfg,
  // and falls back to the Lab's existing cp_sync config (same project).
  var CFG_EMBED = { url: "", anonKey: "" };

  var TENANT = '00000000-0000-4000-8000-0000000000ff';  // STAGING BUILD: never the real gym's tenant.
  var QUEUE_KEY = 'cp_data_queue';      // pending cloud writes (cap 500)
  var STAMP_KEY = 'cp_data_stamps';     // kv key -> last applied cloud updated_at
  var MEMBERS_KEY = 'cp_members';       // local cache of the canonical member rows
  var IMPORTS_KEY = 'cp_import_batches'; // local cache of CSV import batches (cap 5, newest last)
  var QUEUE_CAP = 500;
  var IMPORTS_CAP = 5;

  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); }
    catch (e) { return fb; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function cfg() {
    return null;  // STAGING BUILD: cloud is off — demo/local data only.
    // Headless test harnesses (jsdom) always run pure-local: never touch the
    // real project from CI, never hold the node event loop open with timers.
    try {
      if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return null;
    } catch (e) {}
    var o = lsGet('cp_data_cfg', null);
    if (o && o.url && o.anonKey) return o;
    if (CFG_EMBED.url && CFG_EMBED.url.indexOf('__') !== 0) return CFG_EMBED;
    var s = lsGet('cp_sync', null); // Lab sync config: same project, same anon key
    if (s && s.url && s.key) return { url: s.url, anonKey: s.key };
    return null;
  }
  function configured() { return !!cfg(); }

  var _client = null, _clientFor = '';
  function client() {
    var c = cfg();
    if (!c || typeof window.supabase === 'undefined' || !window.supabase.createClient) return null;
    if (_client && _clientFor === c.url) return _client;
    try {
      _client = window.supabase.createClient(c.url, c.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      _clientFor = c.url;
    } catch (e) { _client = null; }
    return _client;
  }

  var _online = null;           // null = unknown yet
  var _user = null;
  var _role = lsGet('cp_role', null); // {user_id, role, tenant_id}
  var statusSubs = [];
  function fireStatus() {
    var s = status();
    statusSubs.forEach(function (cb) { try { cb(s); } catch (e) {} });
  }
  function markOnline(ok) {
    if (_online !== ok) { _online = ok; fireStatus(); } else { _online = ok; }
  }
  function status() {
    return {
      configured: configured(),
      online: _online,
      user: _user ? { id: _user.id, email: _user.email } : null,
      role: _role && _user && _role.user_id === _user.id ? _role.role : null,
      queued: lsGet(QUEUE_KEY, []).length,
      mode: configured() && _user ? 'cloud' : 'local',
    };
  }

  // ------------------------------------------------------------- write queue
  function enqueue(job) {
    var q = lsGet(QUEUE_KEY, []);
    q.push(Object.assign({ ts: Date.now(), qid: Math.random().toString(36).slice(2) + Date.now().toString(36) }, job));
    if (q.length > QUEUE_CAP) q = q.slice(-QUEUE_CAP);
    lsSet(QUEUE_KEY, q);
    fireStatus();
  }
  var flushing = false;
  function flushQueue() {
    if (flushing) return Promise.resolve(false);
    var cl = client();
    var q = lsGet(QUEUE_KEY, []);
    if (!cl || !q.length) return Promise.resolve(false);
    flushing = true;
    var chain = Promise.resolve();
    var sent = {};
    q.forEach(function (job) {
      // Anonymous sessions can only deliver leads (RLS) — don't hammer the rest.
      if (!_user && job.kind !== 'lead') return;
      chain = chain.then(function () {
        return runJob(cl, job).then(function (ok) {
          if (ok && job.qid) sent[job.qid] = true;
        });
      });
    });
    var finish = function () {
      // Subtract only what was actually sent from the CURRENT queue — jobs
      // enqueued while this flush was in flight must survive it. Jobs that keep
      // failing (schema rejects, bad key) are dropped after ~25 attempts so one
      // poison job can't retry forever.
      var attempted = {};
      q.forEach(function (j) { if (j.qid && (_user || j.kind === 'lead')) attempted[j.qid] = true; });
      var now = lsGet(QUEUE_KEY, []);
      var kept = [];
      now.forEach(function (j) {
        if (j.qid && sent[j.qid]) return;
        if (j.qid && attempted[j.qid]) {
          j.fails = (j.fails || 0) + 1;
          if (j.fails >= 25) return; // poison — give up quietly
        }
        kept.push(j);
      });
      lsSet(QUEUE_KEY, kept);
      flushing = false;
      fireStatus();
      return Object.keys(sent).length > 0;
    };
    return chain.then(finish).catch(function () { try { return finish(); } catch (e) { flushing = false; return false; } });
  }
  // 23505 = unique violation: an earlier attempt DID land (we just never saw the
  // response) — the ONE reusable rule every job-kind's duplicate handling is built on.
  function isDup(r) { return !!(r && r.error && String(r.error.code) === '23505'); }
  function runJob(cl, job) {
    var p;
    if (job.kind === 'kv') {
      p = cl.from('kv_state').upsert({
        tenant_id: TENANT, key: job.key, data: job.data,
        updated_at: new Date().toISOString(), device: deviceId(),
      }, { onConflict: 'tenant_id,key' });
    } else if (job.kind === 'checkin') {
      p = cl.from('checkins').insert(job.row);
    } else if (job.kind === 'lead') {
      p = cl.from('leads').insert(job.row);
    } else if (job.kind === 'member_upsert') {
      p = cl.from('members').upsert(job.row, { onConflict: 'id' });
    } else if (job.kind === 'member_remove') {
      // Task 8 (import undo) needs a real delete — 'staff all members' (0001_core.sql) already
      // grants DELETE to any authenticated staff role for their own tenant, same policy that
      // already covers member_upsert above, so no new RLS is required for this job kind.
      p = cl.from('members').delete().eq('id', job.id).eq('tenant_id', TENANT);
    } else if (job.kind === 'import_batch') {
      // Two-table write (the batch row + its per-member audit rows) as ONE queue job —
      // rows carry the LOCAL id imports.saveBatch() already generated (uuidv4() below), so
      // they never have to wait on a cloud-assigned id to be insertable.
      //
      // Resumable by construction: a retry re-sends the SAME batch.id AND the SAME
      // per-row id (assigned once in imports.saveBatch(), never regenerated), so every
      // insert below is safe to re-run.
      //   - 23505 (unique violation) on the import_batches insert means the batch row
      //     is already there from an earlier attempt — that is a reason to CONTINUE on
      //     to the rows insert, not to stop (only a non-duplicate error aborts here;
      //     see isDup() above the outer classifier below, reused for both steps).
      //   - import_rows is inserted in ROWS_CHUNK-sized chunks — a full-roster import
      //     can be ~400 rows carrying `before` snapshots, and one oversized payload
      //     raises the odds of exactly the partial-landing failure this job must
      //     survive. Each chunk carries its own stable ids, so a 23505 on a chunk means
      //     THAT chunk already landed (treated as confirmed, move to the next chunk); a
      //     non-duplicate error stops the chain there and the WHOLE job is retried next
      //     time (safe: every already-landed chunk will just re-report 23505 and be
      //     skipped again).
      //   - The job is only "delivered" (dropped from the queue by the generic
      //     classifier below) once the last link in this chain resolves with no error —
      //     i.e. the batch row AND every row chunk are confirmed present.
      var batch = job.batch;
      var ROWS_CHUNK = 200;
      p = cl.from('import_batches').insert({
        id: batch.id, tenant_id: TENANT, source: batch.source, mapping: batch.mapping,
        counts: batch.counts, created_at: batch.created_at, undone: false,
      }).then(function (r) {
        if (r.error && !isDup(r)) return r; // real failure: abort, whole job retries later
        var rows = (batch.rows || []).map(function (row) {
          return {
            id: row.id, batch_id: batch.id, tenant_id: TENANT,
            action: row.action, member_id: row.member_id, before: row.before,
          };
        });
        if (!rows.length) return { error: null }; // batch confirmed, nothing else to land
        var chunks = [];
        for (var i = 0; i < rows.length; i += ROWS_CHUNK) chunks.push(rows.slice(i, i + ROWS_CHUNK));
        var chain = Promise.resolve({ error: null });
        chunks.forEach(function (chunk) {
          chain = chain.then(function (prev) {
            if (prev.error) return prev; // an earlier chunk hard-failed: stop, whole job retries later
            return cl.from('import_rows').insert(chunk).then(function (rr) {
              return isDup(rr) ? { error: null } : rr; // dup on THIS chunk = already landed
            });
          });
        });
        return chain;
      });
    } else if (job.kind === 'import_undo') {
      p = cl.from('import_batches').update({ undone: true }).eq('id', job.batchId).eq('tenant_id', TENANT);
    } else { return Promise.resolve(true); } // unknown job: drop
    return p.then(function (r) {
      // 23505 (isDup) = unique violation on client_id: an earlier attempt DID land (we
      // just never saw the response). Delivered — drop the job. (import_batch's chain
      // above already folds ITS per-step duplicate handling into whatever `r` reaches
      // here, so a dup on just the batch row — with rows still unconfirmed — never
      // shows up as a top-level dup; only "batch AND every row chunk confirmed" does.)
      var dup = isDup(r);
      var code = r.error && String(r.error.code);
      // Permission-denied is NOT offline — the network is fine, we're just not
      // provisioned (yet). Keep the job queued but don't flap the ☁ status.
      var denied = code === '42501' || code === 'PGRST301' || code === '401' || code === '403';
      markOnline(!r.error || dup || denied);
      return !r.error || dup;
    }).catch(function () { markOnline(false); return false; });
  }
  function deviceId() {
    var d = lsGet('cp_device', null);
    if (!d) { d = 'dev-' + Math.random().toString(36).slice(2, 10); lsSet('cp_device', d); }
    return d;
  }
  // Locally-generated v4-shaped id for an import batch. Generated up front so saveBatch()
  // can resolve with a USABLE batchId before any cloud round-trip is even attempted (or
  // ever succeeds) — the same id is reused for the queued cloud insert so rows can
  // reference it immediately. Math.random-based (matches deviceId() above) — not
  // cryptographically strong, but this id is a foreign key target, never a security token.
  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // ------------------------------------------------------------------- auth
  // Wave-2 constants (frozen contract, docs/superpowers/specs/2026-07-22-auth-system-
  // design.md D3 + "Frozen Wave-2 API contract"): per-role session policy read by
  // sessionInfo() below. Exactly one of capMs (hard cap — auth-gate v2 forces a
  // signOut() at the cap) or slidingMs (renews on activity, auth-gate v2 owns writing
  // lastActive) applies per role; a role with neither (unknown/no cached role) gets
  // both null, which auth-gate treats as "nothing to enforce here."
  var SESSION_POLICY = {
    frontdesk:  { capMs: 12 * 60 * 60 * 1000,        slidingMs: null },
    owner:      { capMs: null, slidingMs: 14 * 24 * 60 * 60 * 1000 },
    admin:      { capMs: null, slidingMs: 14 * 24 * 60 * 60 * 1000 },
    instructor: { capMs: null, slidingMs: 14 * 24 * 60 * 60 * 1000 },
    member:     { capMs: null, slidingMs: 60 * 24 * 60 * 60 * 1000 },
  };
  // Same hash+query strip signInMagic below already does inline for emailRedirectTo;
  // pulled out as a tiny standalone helper here (rather than touching signInMagic) so
  // the two new Wave-2 callers that need it (sendOtpCode, signInGoogle) share one spot.
  function baseHref() { try { return location.href.split('#')[0].split('?')[0]; } catch (e) { return ''; } }

  // M8 (security review): this used to short-circuit on ANY cached _role matching the signed-in
  // user_id, meaning a role promotion/demotion/deactivation between sessions was never picked up
  // client-side — a fresh sign-in just trusted a stale local cache forever. Every call now does a
  // real read. This is cheap (only called at actual sign-in transitions, not on a hot path) and
  // is UX-level honesty only — 0007_status_enforcement.sql's cp_role()/cp_is_owner_admin() (not
  // this function) are what actually enforce deactivation; this just keeps the account menu/gate
  // from showing a deactivated person their own stale last-known role.
  function refreshRole() {
    var cl = client();
    if (!cl || !_user) return Promise.resolve(null);
    var forUser = _user.id;
    return cl.from('app_users').select('role,tenant_id,status').eq('user_id', forUser).maybeSingle()
      .then(function (r) {
        // A deactivated account (or no app_users row at all — an orphan session) resolves to NO
        // role client-side too, not just server-side — never surface a deactivated person's own
        // last-known role.
        var usable = r.data && r.data.status !== 'deactivated';
        if (usable) { _role = { user_id: forUser, role: r.data.role, tenant_id: r.data.tenant_id }; lsSet('cp_role', _role); }
        else { _role = null; lsSet('cp_role', null); }
        fireStatus();
        return _role ? _role.role : null;
      }).catch(function () {
        // Network/off-cloud failure: fail-soft to whatever's already cached for THIS user,
        // rather than wiping a perfectly good role just because this one refresh couldn't reach
        // the server (matches every other read in this file).
        return (_role && _role.user_id === forUser) ? _role.role : null;
      });
  }
  var auth = {
    user: function () { return _user; },
    role: function () { return _role && _user && _role.user_id === _user.id ? _role.role : null; },
    signInMagic: function (email) {
      var cl = client();
      if (!cl) return Promise.resolve({ ok: false, error: 'Cloud is not set up on this device yet.' });
      return cl.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.href.split('#')[0].split('?')[0] } })
        .then(function (r) { return r.error ? { ok: false, error: friendlyAuthError(r.error) } : { ok: true }; })
        .catch(function (e) { return { ok: false, error: 'Could not reach the sign-in service. Check the internet connection and try again.' }; });
    },
    signInPassword: function (email, pw) {
      var cl = client();
      if (!cl) return Promise.resolve({ ok: false, error: 'Cloud is not set up on this device yet.' });
      return cl.auth.signInWithPassword({ email: email, password: pw })
        .then(function (r) {
          if (r.error) return { ok: false, error: friendlyAuthError(r.error) };
          _user = r.data.user; fireStatus(); refreshRole(); flushQueue();
          return { ok: true };
        })
        .catch(function () { return { ok: false, error: 'Could not reach the sign-in service. Check the internet connection and try again.' }; });
    },
    signOut: function () {
      var cl = client();
      _user = null; _role = null; lsSet('cp_role', null); fireStatus();
      return cl ? cl.auth.signOut().catch(function () {}) : Promise.resolve();
    },

    // ------------------------------------------------- Wave 2 (D2/D3/D6, frozen contract)
    // OTP-code sign-in: same signInWithOtp machinery as signInMagic above, but the person
    // types the 6-digit code from the email instead of tapping its link (D2). shouldCreateUser
    // is false — this path never creates accounts, only invite acceptance (D5) does.
    // emailRedirectTo is kept (unused for code redemption itself) purely so the email
    // template's secondary "or click this link" line still resolves for anyone who taps it.
    sendOtpCode: function (email) {
      var cl = client();
      if (!cl) return Promise.resolve({ ok: false, reason: 'unconfigured' });
      return cl.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false, emailRedirectTo: baseHref() } })
        .then(function (r) { return r.error ? { ok: false, error: friendlyAuthError(r.error) } : { ok: true }; })
        .catch(function () { return { ok: false, reason: 'offline' }; });
    },
    // Redeems the code from sendOtpCode(). verifyOtp() sets the session internally, which
    // fires cl.auth.onAuthStateChange -> init()'s onSignedIn() (refreshRole + reconcileKv +
    // members.refresh + flushQueue) the same way any other sign-in does — confirmed against
    // the vendored supabase-js: verifyOtp() saves the session and notifies subscribers same
    // as signInWithPassword. Belt-and-braces per the Wave-2 contract note anyway: also run
    // the same immediate post-signin steps signInPassword uses above, in case that event
    // hasn't landed by the time this promise resolves (refreshRole/flushQueue are idempotent,
    // so running them twice is harmless).
    verifyOtpCode: function (email, code) {
      var cl = client();
      if (!cl) return Promise.resolve({ ok: false, reason: 'unconfigured' });
      return cl.auth.verifyOtp({ email: email, token: code, type: 'email' })
        .then(function (r) {
          if (r.error) return { ok: false, error: friendlyAuthError(r.error) };
          if (r.data && r.data.user) { _user = r.data.user; fireStatus(); refreshRole(); flushQueue(); }
          return { ok: true };
        })
        .catch(function () { return { ok: false, reason: 'offline' }; });
    },
    // The button only ever renders when googleEnabled() below is true (D6) — calling this
    // while the provider isn't configured on the Supabase side just surfaces Supabase's own
    // error through friendlyAuthError, same as any other bad-config sign-in attempt.
    signInGoogle: function () {
      var cl = client();
      if (!cl) return Promise.resolve({ ok: false, reason: 'unconfigured' });
      return cl.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: baseHref() } })
        .then(function (r) { return r.error ? { ok: false, error: friendlyAuthError(r.error) } : { ok: true }; })
        .catch(function () { return { ok: false, reason: 'offline' }; });
    },
    // Synchronous by contract ("never a network wait on first paint") — reads the SAME
    // local cache every other kv consumer reads (kv.get is a plain lsGet, no network round
    // trip). reconcileKv() (below) is what keeps this cache fresh in the background; this
    // call never waits on it. Default false: an unconfigured/never-synced device shows no
    // Google button, matching D6's "no fake surface" rule.
    googleEnabled: function () {
      try { var c = kv.get('auth_cfg', null); return !!(c && c.google_enabled); }
      catch (e) { return false; }
    },
    // Same pattern/contract as googleEnabled. 6-digit codes only exist in sign-in emails
    // once the OTP template is applied server-side — and Supabase's FREE tier refuses
    // template changes until custom SMTP is configured (discovered live 2026-07-22, 400:
    // "Email template modification is not available for free tier projects using the
    // default email provider"). setup_cloud.js maintains auth_cfg.otp_codes_enabled; until
    // it's true the gate must promise a LINK, not a code — no fake surface.
    otpCodesEnabled: function () {
      try { var c = kv.get('auth_cfg', null); return !!(c && c.otp_codes_enabled); }
      catch (e) { return false; }
    },
    // Server-side revoke of every refresh token for this user (mirrors the Admin-side
    // revoke D5's invite/deactivate path uses for its <=15-min AC). Local device state is
    // always cleared, even when the network call fails or the cloud is unconfigured — there
    // is nothing this device should stay signed into either way.
    signOutEverywhere: function () {
      var cl = client();
      _user = null; _role = null; lsSet('cp_role', null); fireStatus();
      if (!cl) return Promise.resolve({ ok: false, reason: 'unconfigured' });
      return cl.auth.signOut({ scope: 'global' })
        .then(function (r) { return r && r.error ? { ok: false, error: friendlyAuthError(r.error) } : { ok: true }; })
        .catch(function () { return { ok: false, reason: 'offline' }; });
    },
    // Synchronous read of the session-cap bookkeeping auth-gate v2 owns writing
    // (localStorage 'cp_session_meta' = {started, lastActive}; plain localStorage API, so
    // the stg:: proxy namespaces it automatically per D9). capMs/slidingMs come from
    // SESSION_POLICY above, keyed off the CACHED role (cp_role) rather than auth.role() so
    // this still answers correctly in the fail-soft "cached session, cloud unreachable"
    // case auth-gate.js's cachedAuth() already relies on elsewhere.
    sessionInfo: function () {
      var roleRec = lsGet('cp_role', null);
      var role = (roleRec && roleRec.role) || null;
      var meta = lsGet('cp_session_meta', null);
      var policy = SESSION_POLICY[role] || { capMs: null, slidingMs: null };
      return {
        role: role,
        startedAt: (meta && meta.started) || null,
        capMs: policy.capMs,
        slidingMs: policy.slidingMs,
      };
    },
  };
  function friendlyAuthError(err) {
    var m = String(err && err.message || err || '');
    if (/rate limit|security purposes|once every/i.test(m)) {
      // Honest reason, not a vague "too many tries": Supabase's free built-in
      // mailer caps sign-in emails at 2/hour, project-wide. There's no reset
      // time in the error itself, so we estimate "an hour from now" — close
      // enough to be useful, and we say so plainly if the clock math fails.
      var when = 'in about an hour';
      try {
        var reset = new Date(Date.now() + 60 * 60 * 1000);
        when = 'after ' + reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch (e) {}
      return "Our free email service only sends 2 sign-in emails per hour, and today's are used up. Use your password below, or try again " + when + '.';
    }
    if (/invalid login|invalid credentials/i.test(m)) return "That didn't match. Check the email and password and try again.";
    if (/signup|not allowed|disabled/i.test(m)) return 'This email is not on the team yet. Ask the owner to add you.';
    // Anything else: plain words to the person, raw detail to the console only.
    try { console.warn('sign-in error:', m); } catch (e) {}
    return "Sign-in didn't work. Try again in a moment.";
  }

  // ---------------------------------------------------------------- invites
  // Wave 3 (D5, frozen contract: docs/superpowers/specs/2026-07-22-auth-system-design.md
  // "Frozen Wave-3 contract (invites)"). Nine thin wrappers over the `invite` Edge Function —
  // fail-soft exactly like `auth` above: no config => {ok:false, reason:'unconfigured'}; a
  // network/timeout/off-cloud failure => {ok:false, reason:'offline'}. Every call POSTs
  // /functions/v1/invite with {action, ...}; role-checked actions (everything except accept/
  // requestJoin) send the SIGNED-IN caller's own access token as the bearer (mirrors brain.ask()
  // below exactly — same cl.auth.getSession() + AbortController + 11s timeout shape); accept/
  // requestJoin are reachable signed OUT, so they send the anon key itself as the bearer (the
  // same thing supabase-js's own client sends when there is no active session) — the Edge
  // Function does its own privileged work with the SERVICE ROLE key server-side either way.
  function callInviteFn(payload, needsCallerJwt) {
    var c = cfg(); var cl = client();
    if (!c || !cl) return Promise.resolve({ ok: false, reason: 'unconfigured' });
    var tokenP = needsCallerJwt
      ? (_user ? cl.auth.getSession().then(function (s) {
          return (s && s.data && s.data.session && s.data.session.access_token) || null;
        }).catch(function () { return null; }) : Promise.resolve(null))
      : Promise.resolve(c.anonKey);
    return tokenP.then(function (tok) {
      if (!tok) return { ok: false, reason: 'offline' }; // e.g. a role-checked call with no signed-in user
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ac ? setTimeout(function () { ac.abort(); }, 11000) : null;
      return fetch(c.url.replace(/\/$/, '') + '/functions/v1/invite', {
        method: 'POST',
        signal: ac ? ac.signal : undefined,
        headers: { 'Authorization': 'Bearer ' + tok, 'apikey': c.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then(function (resp) {
        if (timer) clearTimeout(timer);
        return resp.json().catch(function () { return null; }).then(function (j) {
          // Pass the function's own {ok, ...} body straight through verbatim (its error strings
          // are already friendly, per the frozen contract) — only a genuinely unreadable/absent
          // response falls back to the canonical off-cloud shape.
          return (j && typeof j.ok === 'boolean') ? j : { ok: false, reason: 'offline' };
        });
      }).catch(function () { if (timer) clearTimeout(timer); return { ok: false, reason: 'offline' }; });
    });
  }
  var invites = {
    issueStaff: function (email, role) { return callInviteFn({ action: 'issue_staff', email: email, role: role }, true); },
    issueMember: function (memberId, email) { return callInviteFn({ action: 'issue_member', member_id: memberId, email: email }, true); },
    resend: function (id) { return callInviteFn({ action: 'resend', invite_id: id }, true); },
    revoke: function (id) { return callInviteFn({ action: 'revoke', invite_id: id }, true); },
    accept: function (token) { return callInviteFn({ action: 'accept', token: token }, false); },
    requestJoin: function (fields) { return callInviteFn(Object.assign({ action: 'request_join' }, fields || {}), false); },
    approveRequest: function (leadId) { return callInviteFn({ action: 'approve_request', lead_id: leadId }, true); },
    deactivate: function (userId) { return callInviteFn({ action: 'deactivate', user_id: userId }, true); },
    list: function (kind) { return callInviteFn({ action: 'list', kind: kind }, true); },
  };

  // --------------------------------------------------------------------- kv
  var kvSubs = {}; // key -> [cb]
  function kvFire(key) {
    (kvSubs[key] || []).forEach(function (cb) { try { cb(lsGet(key, null)); } catch (e) {} });
  }
  var kv = {
    get: function (key, fb) { return lsGet(key, fb); },
    set: function (key, val) {
      lsSet(key, val);
      var stamps = lsGet(STAMP_KEY, {});
      stamps[key] = new Date().toISOString();
      lsSet(STAMP_KEY, stamps);
      enqueue({ kind: 'kv', key: key, data: val });
      flushQueue();
      kvFire(key);
    },
    onChange: function (key, cb) {
      (kvSubs[key] = kvSubs[key] || []).push(cb);
      return function () { kvSubs[key] = (kvSubs[key] || []).filter(function (f) { return f !== cb; }); };
    },
  };
  function reconcileKv() {
    var cl = client();
    if (!cl || !_user) return Promise.resolve(false);
    return cl.from('kv_state').select('key,data,updated_at').eq('tenant_id', TENANT)
      .then(function (r) {
        if (r.error || !r.data) { markOnline(!r.error); return false; }
        markOnline(true);
        var stamps = lsGet(STAMP_KEY, {});
        var queued = {};
        lsGet(QUEUE_KEY, []).forEach(function (j) { if (j.kind === 'kv') queued[j.key] = true; });
        var changed = false;
        r.data.forEach(function (row) {
          if (queued[row.key]) return;               // our unsent write wins
          var local = stamps[row.key];
          if (!local || new Date(row.updated_at) > new Date(local)) {
            lsSet(row.key, row.data);
            stamps[row.key] = row.updated_at;
            changed = true;
            kvFire(row.key);
          }
        });
        lsSet(STAMP_KEY, stamps);
        return changed;
      }).catch(function () { markOnline(false); return false; });
  }

  // ---------------------------------------------------------------- members
  // Console-only breadcrumb for the members.refresh() cache-wipe guard below — never
  // thrown, never shown to the person, just enough for a dev/console session to see WHY
  // a stale-looking cache didn't refresh (see 0004_role_matrix.sql's header comment).
  function logMembersRefreshGuard(table, reason, keptCount) {
    try {
      console.warn('[CP.data] members.refresh(' + table + '): ' + reason +
        ' — keeping the existing local cache (' + keptCount + ' rows), not overwriting with [].');
    } catch (e) {}
  }
  var members = {
    all: function () { return lsGet(MEMBERS_KEY, []); },
    byName: function (name) {
      var n = String(name || '').toLowerCase();
      return members.all().find(function (m) { return String(m.name || '').toLowerCase() === n; }) || null;
    },
    // Wave 2 (D4 back-compat deviation — read supabase/migrations/0004_role_matrix.sql's
    // header comment before touching this): owner/admin keep reading the `members` base
    // table (unchanged from Wave 1, full columns, RLS lets them see everything anyway).
    // frontdesk/instructor now read the narrower `members_lookup` VIEW instead — the base
    // table's RLS still allows their SELECT for back-compat, but pointing them at the view
    // is the "Wave 2 change" the migration's header comment calls out as its intended next
    // step. The view carries id/tenant_id/name/status/qr_token/joined_at/belt/stripes/
    // program/attrs — enough for kiosk.html:98 memberRow() and instructor-app.html:134-141
    // adoptCanonicalRoster() to keep working unchanged, plus data.js's own QR short-id
    // resolution below (checkins.add).
    refresh: function () {
      var cl = client();
      if (!cl || !_user) return Promise.resolve(members.all());
      var role = auth.role();
      var table = (role === 'frontdesk' || role === 'instructor') ? 'members_lookup' : 'members';
      return cl.from(table).select('*').eq('tenant_id', TENANT).order('name')
        .then(function (r) {
          var prev = members.all();
          if (r.error || !r.data) {
            markOnline(!r.error);
            logMembersRefreshGuard(table, r.error ? ('errored: ' + (r.error.message || r.error.code || r.error)) : 'returned no data', prev.length);
            return prev;
          }
          // CRITICAL fail-soft — this is the exact kiosk-cache-wipe scenario
          // 0004_role_matrix.sql's header comment warns about: PostgREST + RLS filter
          // denied/missing rows SILENTLY (empty array, no error), so an empty result is
          // NOT trustworthy evidence the roster is actually empty once a previous
          // non-empty cache already proves otherwise (e.g. an old DB that hasn't run
          // 0004 yet, so members_lookup doesn't exist and PostgREST 404s into r.error —
          // or a schema hiccup that RLS-filters everything). Never overwrite a real
          // cache with [] on the strength of a single ambiguous empty response.
          if (!r.data.length && prev.length) {
            markOnline(true);
            logMembersRefreshGuard(table, 'returned empty', prev.length);
            return prev;
          }
          markOnline(true);
          lsSet(MEMBERS_KEY, r.data);
          kvFire(MEMBERS_KEY);
          return r.data;
        }).catch(function () { markOnline(false); return members.all(); });
    },
    upsert: function (row) {
      var all = members.all();
      var i = all.findIndex(function (m) { return m.id === row.id; });
      if (i >= 0) all[i] = Object.assign({}, all[i], row); else all.push(row);
      lsSet(MEMBERS_KEY, all);
      kvFire(MEMBERS_KEY);
      if (row.id) { enqueue({ kind: 'member_upsert', row: row }); flushQueue(); }
      return Promise.resolve(row);
    },
    // Added for Task 8 (owner-console import wizard): undoBatch() (prototypes/import-engine.js)
    // needs a real writer.removeMember(id) to delete a batch-created member on undo — no
    // equivalent existed on this domain before (only upsert/all/refresh/onChange). Same
    // local-write-then-queue shape as upsert() above; no new sync mechanism invented.
    remove: function (id) {
      var all = members.all().filter(function (m) { return m.id !== id; });
      lsSet(MEMBERS_KEY, all);
      kvFire(MEMBERS_KEY);
      if (id) { enqueue({ kind: 'member_remove', id: id }); flushQueue(); }
      return Promise.resolve();
    },
    onChange: function (cb) { return kv.onChange(MEMBERS_KEY, cb); },
  };

  // --------------------------------------------------------------- checkins
  var seenCheckins = {};   // client_id/db id -> true (dedup legacy vs realtime)
  var checkinSubs = [];
  var pollTimer = null, lastPollTs = null;
  function fireCheckin(row) {
    var key = (row.meta && row.meta.client_id) || ('db-' + row.id);
    if (seenCheckins[key]) return;
    seenCheckins[key] = true;
    checkinSubs.forEach(function (cb) { try { cb(row); } catch (e) {} });
  }
  var checkins = {
    add: function (rec, opts) {
      // rec: the legacy shape {id,name,at,ts,cls,late,dropIn,fee,...}. Mirror it to
      // the legacy queue (console drain path keeps working same-origin) + cloud row.
      // opts.legacy===false skips the mirror (for callers that already reflected
      // the check-in locally and would double-count their own drain).
      if (!opts || opts.legacy !== false) {
        var legacy = lsGet('cp_checkins', []);
        legacy.push(rec);
        // On a kiosk device no console ever drains this mirror — cap it so a busy
        // year can't march the origin into its localStorage quota.
        if (legacy.length > 2000) legacy = legacy.slice(-2000);
        lsSet('cp_checkins', legacy);
      }
      seenCheckins[rec.id] = true; // don't echo our own write back via realtime
      var member = members.byName(rec.name);
      // The canonical id from a CP2 QR scan beats a name guess — two members can
      // share a display name. QR payloads carry a SHORT id prefix (density: the
      // fixed-focus iPad camera needs a small QR) — resolve it against the cache;
      // only a full uuid goes to the uuid column.
      var mid = null;
      if (rec.memberId) {
        var midStr = String(rec.memberId);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(midStr)) mid = midStr;
        else {
          var bare = midStr.replace(/-/g, '').toLowerCase();
          var hit = members.all().find(function (m) {
            return String(m.id || '').replace(/-/g, '').toLowerCase().indexOf(bare) === 0;
          });
          if (hit) mid = hit.id;
        }
      }
      var row = {
        tenant_id: TENANT,
        member_id: mid || (member ? member.id : null),
        name: rec.name,
        cls: rec.cls || null,
        source: rec.source || 'kiosk',
        late: !!rec.late, drop_in: !!rec.dropIn, fee: rec.fee || 0,
        meta: { client_id: rec.id, device: deviceId(), phone: rec.phone || '', email: rec.email || '' },
      };
      // Preserve the REAL moment: offline-queued check-ins must not adopt the
      // flush time when they finally reach the database.
      try {
        if (rec.ts) row.ts = new Date(rec.ts).toISOString();
        if (rec.at) row.at = rec.at;
      } catch (e) {}
      enqueue({ kind: 'checkin', row: row });
      return flushQueue();
    },
    today: function () {
      var cl = client();
      if (!cl || !_user) return Promise.resolve([]);
      var start = new Date(); start.setHours(0, 0, 0, 0);
      return cl.from('checkins').select('*').eq('tenant_id', TENANT)
        .gte('ts', start.toISOString()).order('ts', { ascending: false })
        .then(function (r) { markOnline(!r.error); return r.data || []; })
        .catch(function () { markOnline(false); return []; });
    },
    recent: function (n) {
      var cl = client();
      if (!cl || !_user) return Promise.resolve([]);
      return cl.from('checkins').select('*').eq('tenant_id', TENANT)
        .order('ts', { ascending: false }).limit(n || 50)
        .then(function (r) { markOnline(!r.error); return r.data || []; })
        .catch(function () { markOnline(false); return []; });
    },
    onNew: function (cb) {
      checkinSubs.push(cb);
      ensureCheckinStream();
      return function () {
        checkinSubs = checkinSubs.filter(function (f) { return f !== cb; });
        if (!checkinSubs.length) stopCheckinStream();
      };
    },
  };
  var checkinChannel = null;
  function ensureCheckinStream() {
    var cl = client();
    if (!cl || !_user) return;
    if (!checkinChannel) {
      try {
        checkinChannel = cl.channel('cp-checkins')
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkins' },
            function (payload) { if (payload.new) fireCheckin(payload.new); })
          .subscribe();
      } catch (e) { checkinChannel = null; }
    }
    if (!pollTimer) { // polling fallback: cheap, covers realtime failure silently
      lastPollTs = new Date().toISOString();
      pollTimer = setInterval(function () {
        var c2 = client();
        if (!c2 || !_user || !checkinSubs.length) return;
        var since = lastPollTs;
        lastPollTs = new Date().toISOString();
        c2.from('checkins').select('*').eq('tenant_id', TENANT)
          .gt('ts', since).order('ts')
          .then(function (r) { (r.data || []).forEach(fireCheckin); })
          .catch(function () {});
      }, 12000);
    }
  }
  function stopCheckinStream() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (checkinChannel) { try { checkinChannel.unsubscribe(); } catch (e) {} checkinChannel = null; }
  }

  // ------------------------------------------------------------------ leads
  var leadSubs = [];
  var leads = {
    add: function (rec) {
      // Public funnel path — works ANONYMOUSLY (RLS: anon insert only).
      var legacy = lsGet('cp_leads_inbox', []);
      legacy.push(rec);
      lsSet('cp_leads_inbox', legacy);
      enqueue({ kind: 'lead', row: {
        tenant_id: TENANT,
        name: rec.name || 'Unknown', phone: rec.phone || null, email: rec.email || null,
        source: rec.source || 'Website', stage: rec.stage || 'New',
        interest: rec.interest || null, session: rec.session || null,
        waitlist: !!rec.waitlist,
        attrs: { client_id: rec.id, child: rec.child, childAge: rec.childAge,
                 guardianRel: rec.guardianRel, exp: rec.exp, foundVia: rec.foundVia,
                 notes: rec.notes, created: rec.created },
      } });
      return flushQueue();
    },
    list: function () {
      var cl = client();
      if (!cl || !_user) return Promise.resolve([]);
      return cl.from('leads').select('*').eq('tenant_id', TENANT)
        .order('created_at', { ascending: false }).limit(200)
        .then(function (r) { markOnline(!r.error); return r.data || []; })
        .catch(function () { markOnline(false); return []; });
    },
    onNew: function (cb) { leadSubs.push(cb); ensureLeadStream(); return function () {
      leadSubs = leadSubs.filter(function (f) { return f !== cb; });
    }; },
  };
  var leadChannel = null;
  function ensureLeadStream() {
    var cl = client();
    if (!cl || !_user || leadChannel) return;
    try {
      leadChannel = cl.channel('cp-leads')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads' },
          function (payload) {
            if (payload.new) leadSubs.forEach(function (cb) { try { cb(payload.new); } catch (e) {} });
          })
        .subscribe();
    } catch (e) { leadChannel = null; }
  }

  // ----------------------------------------------------------------- imports
  // CSV import batches (backs the Task 8 import wizard). Local-first under IMPORTS_KEY
  // (array, newest last, capped at IMPORTS_CAP) — reads never wait on the cloud. Write-
  // through reuses the SAME enqueue/flushQueue/runJob queue every other domain uses (see
  // the 'import_batch' / 'import_undo' job kinds in runJob above) — no second sync
  // mechanism. RLS on import_batches/import_rows is owner/admin-only (0003_import.sql):
  // an instructor or kiosk device gets a denied response, which markOnline() already
  // treats as "reached the server, just not authorized" rather than offline — the same
  // distinction every other job kind gets for free from the shared runJob() error handling.
  var imports = {
    saveBatch: function (b) {
      var rec = {
        id: uuidv4(),
        created_at: new Date().toISOString(),
        undone: false,
        source: (b && b.source) || null,
        mapping: (b && b.mapping) || null,
        counts: (b && b.counts) || {},
        // Each row gets a STABLE client-supplied id, assigned ONCE here and never
        // regenerated — the queued 'import_batch' job (runJob above) re-sends this
        // exact rec.rows array on every retry, so a repeat insert of the same row
        // collides on this id (23505) instead of creating a duplicate row.
        rows: ((b && b.rows) || []).map(function (row) {
          return Object.assign({}, row, { id: row.id || uuidv4() });
        }),
      };
      var arr = lsGet(IMPORTS_KEY, []);
      arr.push(rec);
      if (arr.length > IMPORTS_CAP) arr = arr.slice(-IMPORTS_CAP); // drop the OLDEST beyond the cap
      lsSet(IMPORTS_KEY, arr);
      // Fire-and-forget, same shape as members.upsert(): the cloud write queues and
      // retries on its own schedule. saveBatch must resolve with the local batchId
      // regardless of whether this ever lands, so the wizard's undo affordance works
      // identically online or off.
      enqueue({ kind: 'import_batch', batch: rec });
      flushQueue();
      return Promise.resolve({ batchId: rec.id });
    },
    lastBatch: function () {
      var arr = lsGet(IMPORTS_KEY, []);
      for (var i = arr.length - 1; i >= 0; i--) {
        if (!arr[i].undone) {
          var b = arr[i];
          return Promise.resolve({ id: b.id, created_at: b.created_at, undone: !!b.undone, rows: b.rows || [] });
        }
      }
      return Promise.resolve(null);
    },
    markUndone: function (batchId) {
      var arr = lsGet(IMPORTS_KEY, []);
      var i = arr.findIndex(function (b) { return b.id === batchId; });
      if (i >= 0) { arr[i].undone = true; lsSet(IMPORTS_KEY, arr); }
      enqueue({ kind: 'import_undo', batchId: batchId });
      flushQueue();
      return Promise.resolve();
    },
  };

  // ------------------------------------------------- member device binding
  var memberApi = {
    lastError: null, // 'offline' (no config/network) vs 'bad-token' (cloud said no)
    token: function () { return lsGet('cp_member_token', null); },
    current: function () { return lsGet('cp_member_rec', null); },
    bind: function (token) {
      var cl = client();
      if (!cl) { memberApi.lastError = 'offline'; return Promise.resolve(null); }
      return cl.rpc('member_by_token', { tok: token }).then(function (r) {
        markOnline(!r.error);
        // The server REPLIED with an error: that's our problem, not their wifi.
        // Only the network .catch below may claim 'offline'.
        if (r.error) { memberApi.lastError = 'server'; return null; }
        if (!r.data) { memberApi.lastError = 'bad-token'; return null; }
        memberApi.lastError = null;
        lsSet('cp_member_token', token);
        lsSet('cp_member_rec', r.data);
        return r.data;
      }).catch(function () { markOnline(false); memberApi.lastError = 'offline'; return null; });
    },
    checkin: function (cls) {
      var cl = client(); var tok = memberApi.token();
      if (!cl || !tok) return Promise.resolve({ ok: false, error: 'not bound' });
      return cl.rpc('member_checkin', { tok: tok, p_cls: cls || null })
        .then(function (r) { markOnline(!r.error); return r.data || { ok: false, error: 'no reply' }; })
        .catch(function () { markOnline(false); return { ok: false, error: 'offline' }; });
    },
    attendance: function () {
      var cl = client(); var tok = memberApi.token();
      if (!cl || !tok) return Promise.resolve(null);
      return cl.rpc('member_attendance', { tok: tok })
        .then(function (r) { markOnline(!r.error); return r.data || null; })
        .catch(function () { markOnline(false); return null; });
    },
  };

  // ------------------------------------------------------------------ brain
  var brain = {
    available: function () { return !!(configured() && _user); },
    ask: function (payload) {
      var c = cfg(); var cl = client();
      if (!c || !cl || !_user) return Promise.resolve(null);
      return cl.auth.getSession().then(function (s) {
        var tokenStr = s && s.data && s.data.session && s.data.session.access_token;
        if (!tokenStr) return null;
        var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ac ? setTimeout(function () { ac.abort(); }, 11000) : null;
        return fetch(c.url.replace(/\/$/, '') + '/functions/v1/brain', {
          method: 'POST',
          signal: ac ? ac.signal : undefined,
          headers: {
            'Authorization': 'Bearer ' + tokenStr,
            'apikey': c.anonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload || {}),
        }).then(function (resp) {
          if (timer) clearTimeout(timer);
          if (!resp.ok) return null;
          return resp.json().then(function (j) { return j && j.text ? j : null; });
        }).catch(function () { if (timer) clearTimeout(timer); return null; });
      }).catch(function () { return null; });
    },
  };

  // ------------------------------------------------------------------- init
  var _authSub = null, _flushTimer = null;
  function init() {
    var cl = client();
    if (!cl) { fireStatus(); return; }
    var onSignedIn = function () {
      // M9 (security review): members.refresh() picks its target table (members_lookup vs the
      // base `members` table) off auth.role(), which reads whatever refreshRole() has resolved
      // SO FAR. These two used to fire in parallel — on a FRESH device (no cached role yet),
      // members.refresh() would run with role still null, land on the base `members` table, and
      // 0005_member_read_narrowing.sql denies frontdesk/instructor any SELECT on that table at
      // all (empty result, no error). The empty-cache guard inside members.refresh() only
      // protects an ALREADY non-empty cache, so a device's very first sign-in permanently cached
      // an empty roster. Chaining members.refresh() to run only AFTER refreshRole() resolves
      // guarantees the table pick reflects the real, current role — including the "role just
      // transitioned from null to something real" case, since refreshRole() (M8, above) no
      // longer short-circuits and always does a real read first.
      refreshRole().then(function () { members.refresh(); });
      reconcileKv(); flushQueue();
      // Streams subscribed before sign-in must arm now — a console opened
      // signed-out would otherwise look "synced" but never receive a thing.
      if (checkinSubs.length) ensureCheckinStream();
      if (leadSubs.length) ensureLeadStream();
    };
    cl.auth.getSession().then(function (r) {
      _user = r && r.data && r.data.session ? r.data.session.user : null;
      fireStatus();
      if (_user) onSignedIn();
    }).catch(function () { fireStatus(); });
    try {
      if (_authSub) { try { _authSub.unsubscribe(); } catch (e) {} _authSub = null; }
      var sub = cl.auth.onAuthStateChange(function (_evt, session) {
        var was = _user && _user.id;
        _user = session ? session.user : null;
        if ((_user && _user.id) !== was) {
          fireStatus();
          if (_user) onSignedIn();
        }
      });
      _authSub = sub && sub.data && sub.data.subscription ? sub.data.subscription : null;
    } catch (e) {}
    // periodic: flush the queue + pull cross-device kv edits (calm cadence)
    if (_flushTimer) { clearInterval(_flushTimer); }
    _flushTimer = setInterval(function () {
      if (lsGet(QUEUE_KEY, []).length) flushQueue();
      if (_user) reconcileKv();
    }, 30000);
  }

  window.CP = window.CP || {};
  window.CP.data = {
    VERSION: 1,
    TENANT: TENANT,
    cfg: cfg, configured: configured, client: client,
    status: status,
    onStatus: function (cb) { statusSubs.push(cb); return function () {
      statusSubs = statusSubs.filter(function (f) { return f !== cb; });
    }; },
    setConfig: function (url, anonKey) {
      lsSet('cp_data_cfg', { url: url, anonKey: anonKey });
      stopCheckinStream();
      if (leadChannel) { try { leadChannel.unsubscribe(); } catch (e) {} leadChannel = null; }
      _client = null; _clientFor = '';
      init();
    },
    auth: auth, kv: kv, members: members, checkins: checkins, leads: leads, imports: imports,
    invites: invites, member: memberApi, brain: brain,
    reconcile: reconcileKv, flush: flushQueue,
  };

  try { init(); } catch (e) { /* never break the host app */ }
})();
