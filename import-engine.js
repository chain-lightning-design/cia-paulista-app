/* Import engine — pure functions, no DOM. Browser: window.ImportEngine (needs vendored Papa).
   Node: module.exports. The prototypes are the spec; this engine serves both front doors. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./vendor/papaparse.js'));
  else root.ImportEngine = factory(root.Papa);
}(typeof self !== 'undefined' ? self : this, function (Papa) {
  const CANON = ['first','last','name','email','phone','dob','program','belt','stripes',
    'plan_name','join_date','status','guardian_name','guardian_phone','guardian_email','notes'];
  const SYNONYMS = {
    first: [/^first\s*name$/i, /^first$/i],
    last: [/^last\s*name$/i, /^last$/i, /^surname$/i],
    name: [/^(full\s*)?name$/i, /^member\s*name$/i, /^student$/i],
    email: [/e-?mail/i],
    phone: [/^(mobile|cell)(\s*phone|\s*number)?$/i, /^phone(\s*number)?$/i],
    dob: [/birth/i, /^dob$/i],
    program: [/^program$/i, /^division$/i, /^age\s*group$/i],
    belt: [/^rank$/i, /^belt(\s*rank)?$/i],
    stripes: [/stripe/i],
    plan_name: [/^membership(\s*(type|name|plan))?$/i, /^plan(\s*name)?$/i],
    join_date: [/^(enrollment|start|join(ed)?|member\s*since)(\s*date)?$/i, /^membership\s*start$/i],
    status: [/^(membership\s*)?status$/i],
    guardian_name: [/^(guardian|parent)(\s*name)?$/i],
    guardian_phone: [/^(guardian|parent).*(phone|cell|mobile)/i],
    guardian_email: [/^(guardian|parent).*e-?mail/i],
    notes: [/^notes?$/i, /^comments?$/i],
  };
  function parseCsv(text) {
    const clean = String(text || '').replace(/^﻿/, '');
    const res = Papa.parse(clean, { header: true, skipEmptyLines: 'greedy',
      transformHeader: h => String(h || '').trim() });
    return { headers: ((res.meta && res.meta.fields) || []).filter(Boolean),
      rows: res.data, errors: res.errors || [] };
  }
  function autoMap(headers) {
    const map = {}; const used = new Set();
    // Guardian fields must claim their headers before the generic fields do —
    // otherwise unanchored patterns like email's /e-?mail/i match "Guardian
    // Email" before guardian_email ever gets a turn. CANON's own order/contents
    // stay untouched; this is only the order autoMap matches in.
    const guardianFirst = ['guardian_name', 'guardian_phone', 'guardian_email'];
    const matchOrder = [...guardianFirst, ...CANON.filter(k => !guardianFirst.includes(k))];
    for (const key of matchOrder) {
      map[key] = null;
      for (const h of headers) {
        if (used.has(h)) continue;
        if ((SYNONYMS[key] || []).some(rx => rx.test(h))) { map[key] = h; used.add(h); break; }
      }
    }
    return { map, extras: headers.filter(h => !used.has(h)) };
  }
  const digits = s => String(s || '').replace(/\D/g, '');
  const lc = s => String(s || '').trim().toLowerCase();
  // Absent (no cell / non-numeric junk) => null. A real value, including 0, => that integer.
  // Distinguishing these two is required so an explicit "0" (e.g. a belt promotion that
  // resets stripes to zero) can be diffed and applied, not silently mistaken for "no data".
  const toStripes = s => { if (s === '') return null; const n = parseInt(s, 10); return Number.isNaN(n) ? null : n; };
  const STATUS_MAP = { active:'active', trial:'trial', prospect:'trial', hold:'on_hold',
    'on hold':'on_hold', frozen:'on_hold', suspended:'on_hold', inactive:'inactive',
    cancelled:'inactive', canceled:'inactive', expired:'inactive' };
  function normalizeRow(raw, map) {
    const get = k => map[k] ? String(raw[map[k]] == null ? '' : raw[map[k]]).trim() : '';
    const name = get('name') || [get('first'), get('last')].filter(Boolean).join(' ');
    const rawStatus = lc(get('status'));
    const g = { name: get('guardian_name'), phone: digits(get('guardian_phone')).slice(-10), email: lc(get('guardian_email')) };
    return { name, email: lc(get('email')), phone: digits(get('phone')).slice(-10),
      dob: get('dob'), program: get('program'), belt: get('belt'),
      stripes: toStripes(get('stripes')), plan_name: get('plan_name'),
      join_date: get('join_date'),
      // Absent/blank Status column ⇒ null ("the CSV has no opinion"), never a defaulted
      // 'active' — an import must never destroy data (e.g. a staff-set "At risk") that the
      // CSV never spoke to. toMember()'s own base ({ status: 'active', attrs: {} }) is what
      // supplies 'active' for a brand-new member created from a status-less CSV; a present
      // but unrecognized value still comes back null so the "unrecognized" warning fires,
      // distinguished from "absent" via raw_status ('' only when the column/cell is empty).
      status: rawStatus ? (STATUS_MAP[rawStatus] || null) : null, raw_status: rawStatus,
      guardian: (g.name || g.phone || g.email) ? g : null, notes: get('notes') };
  }
  const DIFF_FIELDS = ['name','email','phone','dob','program','belt','stripes','plan_name','join_date','status','notes'];
  function diffMember(member, r) {
    const diff = {};
    for (const f of DIFF_FIELDS) {
      const incoming = r[f];
      if (incoming === '' || incoming == null) continue; // never blank out (explicit 0 is a real value, not absent)
      if (f === 'status' && incoming === null) continue;                                   // unrecognized ⇒ leave
      const current = f === 'plan_name' ? member.plan
        : f === 'dob' || f === 'join_date' ? (member.attrs || {})[f] : member[f];
      if (String(current == null ? '' : current).trim().toLowerCase() !==
          String(incoming).trim().toLowerCase()) diff[f] = { from: current == null ? '' : current, to: incoming };
    }
    return diff;
  }
  function validate({ rows, map, existing, plans }) {
    existing = existing || []; plans = plans || [];
    const byEmail = new Map(), byPhone = new Map(), byNameDob = new Map();
    for (const m of existing) {
      if (m.email) byEmail.set(lc(m.email), m);
      const ph = digits(m.phone).slice(-10); if (ph.length >= 7) byPhone.set(ph, m);
      if (m.name && (m.attrs || {}).dob) byNameDob.set(lc(m.name) + '|' + m.attrs.dob, m);
    }
    const lastIndex = new Map(); const dupes = [];
    const norm = rows.map(raw => normalizeRow(raw, map));
    norm.forEach((r, i) => {
      const key = r.email ? 'e:' + r.email : (r.phone.length >= 7 ? 'p:' + r.phone : 'row:' + i);
      if (lastIndex.has(key)) dupes.push({ key, dropped: lastIndex.get(key), kept: i });
      lastIndex.set(key, i);
    });
    const keep = new Set([...lastIndex.values()]);
    const knownPlans = new Set(plans.map(p => lc(p.name || p)));
    const planNames = { known: [], unknown: [] };
    const items = norm.map((r, i) => {
      if (!keep.has(i)) return { rowIndex: i, action: 'skip', row: r,
        reason: 'duplicate row — a later row for the same person wins' };
      if (!r.name) return { rowIndex: i, action: 'error', row: r,
        reason: "no name — we can't create a member without one" };
      if (!r.email && r.phone.length < 7) return { rowIndex: i, action: 'error', row: r,
        reason: "no email or phone — we can't tell who this is. Fix the file or skip the row." };
      if (r.plan_name) {
        const bucket = knownPlans.has(lc(r.plan_name)) ? planNames.known : planNames.unknown;
        if (!bucket.includes(r.plan_name)) bucket.push(r.plan_name);
      }
      // Only warn when a status was actually present but not understood — raw_status is ''
      // when the column/cell is absent/blank, which is "no opinion", not "unrecognized".
      let warn = (r.status === null && r.raw_status) ? `status "${r.raw_status}" isn't one we recognize — we left their current status alone` : null;
      let match = (r.email && byEmail.get(r.email)) || (r.phone.length >= 7 && byPhone.get(r.phone)) || null;
      if (!match && r.name && r.dob) {
        match = byNameDob.get(lc(r.name) + '|' + r.dob) || null;
        if (match) warn = (warn ? warn + '; ' : '') + 'matched by name + birth date — double-check this is the same person';
      }
      if (!match) return { rowIndex: i, action: 'create', row: r, warn };
      const diff = diffMember(match, r);
      if (!Object.keys(diff).length) return { rowIndex: i, action: 'skip', row: r, match, reason: 'no changes' };
      return { rowIndex: i, action: 'update', row: r, match, diff, warn };
    });
    const counts = { create: 0, update: 0, skip: 0, error: 0 };
    items.forEach(it => counts[it.action]++);
    return { items, counts, planNames, dupes, mapUsed: map };
  }
  function toMember(r, planMap, base) {
    const m = base ? JSON.parse(JSON.stringify(base)) : { status: 'active', attrs: {} };
    m.attrs = m.attrs || {};
    if (r.name) m.name = r.name;
    if (r.email) m.email = r.email;
    if (r.phone) m.phone = r.phone;
    if (r.program) m.program = r.program;
    if (r.belt) m.belt = r.belt;
    if (r.stripes != null) m.stripes = r.stripes;   // 0 is real (promotion resets stripes)
    if (r.status) m.status = r.status;
    if (r.notes) m.notes = r.notes;
    if (r.dob) m.attrs.dob = r.dob;
    if (r.join_date) m.attrs.join_date = r.join_date;
    if (r.guardian) m.attrs.guardian = r.guardian;
    if (r.plan_name) m.plan = (r.plan_name in (planMap || {})) ? planMap[r.plan_name] : r.plan_name;
    return m;
  }
  async function applyBatch({ report, planMap, writer, source }) {
    const rowsLog = []; let created = 0, updated = 0;
    try {
      for (const it of report.items) {
        if (it.action === 'create') {
          const { id } = await writer.upsertMember(toMember(it.row, planMap, null));
          rowsLog.push({ action: 'create', member_id: id, before: null }); created++;
        } else if (it.action === 'update') {
          const before = JSON.parse(JSON.stringify(it.match));
          await writer.upsertMember(toMember(it.row, planMap, it.match));
          rowsLog.push({ action: 'update', member_id: it.match.id, before }); updated++;
        }
      }
    } catch (writeErr) {
      // Containment: on a real writer (network/RLS/constraint failure), the rows
      // logged so far are already permanent mutations on the backend. Best-effort
      // persist them as a batch record so undoBatch can still revert exactly what
      // landed, then rethrow with enough information for the caller to tell a human
      // what actually happened. Never swallow either error.
      const writtenIds = rowsLog.map(r => r.member_id).filter(Boolean);
      let batchId = null;
      try {
        const saved = await writer.saveBatch({ source, mapping: report.mapUsed,
          counts: { create: created, update: updated, skip: report.counts.skip, error: report.counts.error },
          rows: rowsLog });
        batchId = saved.batchId;
      } catch (saveErr) {
        const err = new Error(`applyBatch: write failed after ${rowsLog.length} row(s) were already ` +
          `written (member id(s): ${writtenIds.join(', ') || 'none'}) — the recovery batch record ALSO ` +
          `failed to save (${saveErr.message}); these writes are NOT undoable via undoBatch and may need ` +
          `manual cleanup. Original error: ${writeErr.message}`);
        err.cause = writeErr; err.saveBatchError = saveErr; err.writtenMemberIds = writtenIds;
        throw err;
      }
      const err = new Error(`applyBatch: write failed after ${rowsLog.length} row(s) were already written ` +
        `(member id(s): ${writtenIds.join(', ') || 'none'}); those rows were saved as batch ${batchId} and ` +
        `can be reverted with undoBatch. Original error: ${writeErr.message}`);
      err.cause = writeErr; err.batchId = batchId; err.writtenMemberIds = writtenIds;
      throw err;
    }
    const { batchId } = await writer.saveBatch({ source, mapping: report.mapUsed,
      counts: report.counts, rows: rowsLog });
    return { batchId, created, updated, skipped: report.counts.skip };
  }
  async function undoBatch({ writer }) {
    const batch = await writer.lastBatch();
    if (!batch) return { reverted: 0, removed: 0, kept: [], nothing: true };
    let reverted = 0, removed = 0; const kept = [];
    for (const row of batch.rows) {
      if (row.action === 'update') { await writer.upsertMember(row.before); reverted++; }
      else if (await writer.hasActivitySince(row.member_id, batch.created_at)) {
        kept.push({ member_id: row.member_id, reason: 'has activity since the import' });
      } else { await writer.removeMember(row.member_id); removed++; }
    }
    await writer.markUndone(batch.id);
    return { reverted, removed, kept };
  }
  return { CANON, parseCsv, autoMap, normalizeRow, validate, applyBatch, undoBatch };
}));
