/**
 * diff.js — the overnight-diff engine (was "step 3").
 *
 * Triage colour and the digest come from the DELTA between snapshots, not from a
 * single value. All functions here are pure (they take a patient/snapshot and
 * return data or mutate the object you hand them) so they can be unit-tested
 * without a browser or storage.
 */

export function vital(p, key) {
  const v = (p.vitals || []).find((x) => x[0] === key);
  return v ? v[1] : null;
}
function num(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? +m[0] : null;
}
function hasSeizureFlag(p) {
  return (p.flags || []).some((f) => /seizure/i.test(f.t) && f.lv === 'bad');
}

/**
 * Triage colour from absolute thresholds AND overnight deltas.
 * Tune these thresholds with your own clinical judgement — they are deliberately
 * conservative defaults, not a validated score.
 */
export function computeTriage(p) {
  const na = p.na || [];
  const last = na.length ? na[na.length - 1] : null;
  const prev = na.length > 1 ? na[na.length - 2] : null;
  const drop = prev != null && last != null ? prev - last : 0;
  const rr = num(vital(p, 'RR'));
  const spo2 = num(vital(p, 'SPO₂'));
  const temp = num(vital(p, 'TEMP'));

  // red — needs eyes now
  if (last != null && last < 130) return 'r';
  if (drop >= 5) return 'r';
  if (rr != null && rr >= 24) return 'r';
  if (spo2 != null && spo2 < 94) return 'r';
  if (hasSeizureFlag(p)) return 'r';

  // amber — watch
  if (last != null && last < 135) return 'a';
  if (drop >= 3) return 'a';
  if (rr != null && rr >= 22) return 'a';
  if (temp != null && temp >= 38) return 'a';
  if (spo2 != null && spo2 < 96) return 'a';

  return 'g';
}

/** Capture today's salient values for the trend history. */
export function snapshotOf(p, date) {
  const na = p.na || [];
  return {
    date,
    na: na.length ? na[na.length - 1] : null,
    rr: num(vital(p, 'RR')),
    spo2: num(vital(p, 'SPO₂')),
    temp: num(vital(p, 'TEMP')),
  };
}

/** What changed between two snapshots, most-salient first. */
export function diffSnapshots(prev, cur) {
  if (!prev) return [];
  const out = [];
  if (cur.na != null && prev.na != null && cur.na !== prev.na)
    out.push({ field: 'Na', from: prev.na, to: cur.na, delta: cur.na - prev.na });
  if (cur.rr != null && prev.rr != null && cur.rr !== prev.rr)
    out.push({ field: 'RR', from: prev.rr, to: cur.rr, delta: cur.rr - prev.rr });
  if (cur.spo2 != null && prev.spo2 != null && cur.spo2 !== prev.spo2)
    out.push({ field: 'SpO₂', from: prev.spo2, to: cur.spo2, delta: cur.spo2 - prev.spo2 });
  return out;
}

/**
 * Build a per-patient admission timeline from snapshots[], newest day first.
 * Each row pairs a snapshot with what changed since the previous one — the
 * per-day diff is delegated to diffSnapshots, NOT re-derived here.
 */
export function buildTimeline(p) {
  const snaps = p.snapshots || [];
  const rows = snaps.map((s, i) => ({
    snapshot: s,
    changes: diffSnapshots(i > 0 ? snaps[i - 1] : null, s),
    baseline: i === 0,
  }));
  return rows.reverse(); // newest first
}

/** Build the "overnight changes" digest for the Today header. */
export function buildDigest(patients) {
  return patients.filter((p) => p.overnight).map((p) => p.overnight);
}

// ---- commit pipeline: apply confirmed changes, then recompute ----

const VITAL_KEY = { bp: 'BP', hr: 'HR', rr: 'RR', spo2: 'SPO₂', temp: 'TEMP' };

/** Apply ONE confirmed change to a patient (mutates p). */
export function applyChange(p, c) {
  if (c.field === 'na') {
    const nv = +c.new;
    p.na = [...p.na, nv].slice(-6);
    p.naLabel = p.naLabel.replace(/→.*/, '→ ' + (c.date || 'today'));
    const sc = p.scores.find((s) => s.l === 'NA');
    if (sc) {
      const prevV = +sc.v;
      sc.v = String(nv);
      sc.a = nv < prevV ? 'dn' : nv > prevV ? 'up' : '';
      sc.d = nv < 130;
    }
  } else if (VITAL_KEY[c.field]) {
    const key = VITAL_KEY[c.field];
    const v = p.vitals.find((x) => x[0] === key);
    if (v) v[1] = c.new; else p.vitals.push([key, c.new]);
  } else if (c.field === 'bm') {
    const a = p.ask.find((x) => x.q.toLowerCase().startsWith('bowel'));
    if (a) { const i = a.t.indexOf(c.new); if (i >= 0) a.on = i; }
  } else if (c.field === 'headache') {
    const a = p.ask.find((x) => x.q.toLowerCase().startsWith('headache'));
    if (a) { const i = a.t.indexOf(c.new); if (i >= 0) a.on = i; }
  } else if (c.field === 'ready') {
    p.ready = true;
  }
}

/**
 * Apply all confirmed changes for one patient, then recompute triage, census
 * flags, the digest entry, and push a fresh snapshot. Returns the mutated p.
 */
export function commitPatient(p, changes, date = 'today') {
  const applied = changes.filter((c) => c.apply);
  if (!applied.length) return p;

  for (const c of applied) applyChange(p, { ...c, date });

  p.triage = computeTriage(p);
  p.flags = applied.slice(0, 2).map((c) => ({
    t: c.label === 'Sodium' ? 'Na ' + c.new : c.label + ' ' + c.new,
    lv: c.cls === 'bad' ? 'bad' : c.cls === 'warn' ? 'warn' : '',
  }));
  const naCh = applied.find((c) => c.field === 'na');
  p.overnight = {
    who: p.name, txt: '',
    k: naCh ? 'Na ' + naCh.new : applied[0].label + ' ' + applied[0].new, tail: '',
  };
  p.newCount = applied.length;
  p.snapshots = p.snapshots || [];
  p.snapshots.push(snapshotOf(p, date));
  return p;
}
