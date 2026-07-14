/**
 * censusImport.js — read the Brain Clinic's "Export for cockpit" census JSON and
 * turn it into cockpit patient records: the clinic → cockpit half of the
 * file-based sync loop (clinicExport.js is the other half, cockpit → clinic).
 *
 * Matching is EXACT, never fuzzy: a census admission maps to the cockpit patient
 * whose clinicAdmissionId equals its admission_id — or, for a bedside-first
 * patient the clinic registered from a cockpit updates file, whose own id equals
 * the admission's echoed cockpit_id (that import LINKS the records permanently).
 * Anything unmatched is a CREATE shown for confirmation — never merged by name.
 *
 * MERGE RULES (update path) — the clinic desktop is the system of record for the
 * census (who is admitted, where, on what), the cockpit is the bedside tool:
 *   - name / hospital / room / dx / day: clinic value wins when non-blank.
 *   - dob / age / detail: filled only when blank here — never overwritten.
 *   - meds: APPEND-ONLY, deduplicated by name. An import never edits, stops or
 *     removes a med already on this phone.
 *   - sodium: adopted only when the clinic series EXTENDS what this phone has
 *     (same values plus newer ones) or this phone has none. A genuine conflict
 *     keeps the phone's values and says so — nothing is silently replaced.
 *   - vitals / scores / ask / neuro modules: bedside-owned → mapped on CREATE
 *     only, untouched on update.
 * Nothing is ever deleted by an import; absent patients are only FLAGGED.
 *
 * Everything here is pure (no store, no DOM). main.js renders the plan, lets the
 * user confirm, and commits — matching the app's review-before-commit invariant.
 */

import { ageFromDob } from './schema.js';

/** Typed error whose message is safe to show the user as-is. */
export class CensusError extends Error {}

const SEX_IN = { Male: 'M', Female: 'F', M: 'M', F: 'F' };
const clean = (v) => (v == null ? '' : String(v).trim());

/** Parse + validate the census file text. Throws CensusError with a friendly message. */
export function readCensus(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new CensusError('Not readable JSON — is this the census file from Brain Clinic?'); }
  if (!data || data.format !== 'clinic-census') {
    throw new CensusError('Not a clinic census file — use "Export for cockpit" on Brain Clinic’s In-Patients page.');
  }
  if (data.version !== 1) {
    throw new CensusError(`This census file is version ${data.version}; this app reads version 1. Update the app.`);
  }
  if (!Array.isArray(data.admissions)) throw new CensusError('Census file has no admissions list.');
  return data;
}

/** '2026-07-10' (or anything ISO-prefixed) → '07/10'; '' when unparseable. */
function mmdd(iso) {
  const m = clean(iso).match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${m[2]}` : '';
}

/** The clinic's sodium rows, coerced to numbers and cleaned of junk. */
function sodiumSeries(adm) {
  return (adm.sodium || [])
    .map((r) => r && { date: clean(r.date), value: Number(r.value) })
    .filter((r) => r && Number.isFinite(r.value));
}

/** '06/12 → 06/16' axis label in the cockpit's own style. */
function naLabelFor(sodium) {
  if (!sodium.length) return '';
  const a = mmdd(sodium[0].date), b = mmdd(sodium[sodium.length - 1].date);
  if (!a) return '';
  return sodium.length > 1 && b && b !== a ? `${a} → ${b}` : a;
}

/** Clinic med row → cockpit med shape { n, d, day, w }. */
function medFromClinic(m) {
  const d = [m.dosage, m.frequency, m.route].map(clean).filter(Boolean).join(' ');
  let day = m.day_num != null && m.day_num !== '' ? `D${m.day_num}` : '';
  if (day && m.course_total_days) day += `·${m.course_total_days}`;
  return { n: clean(m.medication), d, day, w: false };
}

const VITALS_MAP = [
  ['blood_pressure', 'BP'], ['heart_rate', 'HR'], ['respiratory_rate', 'RR'],
  ['temperature', 'TEMP'], ['o2_sat', 'SPO₂'],
];
function vitalsFromClinic(v) {
  return VITALS_MAP.filter(([k]) => clean(v && v[k])).map(([k, l]) => [l, clean(v[k])]);
}

/** Hospital day as a positive-int string, '1' when the clinic couldn't compute it. */
function dayOf(adm) {
  const d = Number(adm.hospital_day);
  return Number.isFinite(d) && d > 0 ? String(d) : '1';
}

/**
 * Map one census admission to newPatient() fields — the CREATE path.
 * Missing values stay blank; nothing is guessed or fabricated.
 */
export function mapAdmission(adm) {
  const sodium = sodiumSeries(adm);
  const na = sodium.map((r) => r.value);
  const tr = adm.today_round || {};

  const scores = [];
  if (clean(tr.gcs)) scores.push({ l: 'GCS', v: clean(tr.gcs), a: '' });
  if (clean(tr.nihss)) scores.push({ l: 'NIHSS', v: clean(tr.nihss), a: '' });
  if (na.length) scores.push({ l: 'NA', v: String(na[na.length - 1]), a: '' });

  const dob = clean(adm.dob);
  const fields = {
    clinicAdmissionId: adm.admission_id,
    name: clean(adm.patient_name),
    dob, age: ageFromDob(dob),
    sex: SEX_IN[clean(adm.sex)] || 'M',
    dx: clean(adm.primary_diagnosis),
    detail: clean(adm.icd10_code),
    day: dayOf(adm),
    hospital: clean(adm.hospital), room: clean(adm.room),
    meds: (adm.meds || []).map(medFromClinic).filter((m) => m.n),
    vitals: vitalsFromClinic(adm.latest_vitals),
    scores,
    na, naLabel: naLabelFor(sodium), trackNa: na.length > 0,
    snapshots: sodium.map((r) => ({ date: mmdd(r.date), na: r.value })),
  };
  const plan = clean(tr.assessment_plan);
  if (plan) fields.doMain = { t: 'Review clinic plan', s: plan.split('\n')[0].slice(0, 80) };
  return fields;
}

/** True when every element of `shorter` equals the same position in `longer`. */
const isPrefix = (shorter, longer) => shorter.every((v, i) => longer[i] === v);

/**
 * Decide what the clinic's sodium series means for this patient:
 *   { kind:'none' }      clinic has no series — nothing to do
 *   { kind:'same' }      identical — nothing to do
 *   { kind:'adopt', na, naLabel, snapshots, added }
 *                        clinic series EXTENDS this phone's (or phone has none)
 *   { kind:'conflict' }  values disagree — keep the phone's, tell the user
 */
export function mergeSodium(patient, sodium) {
  const clinic = sodium.map((r) => r.value);
  const cur = patient.na || [];
  if (!clinic.length) return { kind: 'none' };
  if (cur.length === clinic.length && isPrefix(cur, clinic)) return { kind: 'same' };
  if (cur.length < clinic.length && isPrefix(cur, clinic)) {
    // Merge into snapshots by date so the timeline gains the clinic's history
    // without disturbing vitals already captured on existing days.
    const snapshots = (patient.snapshots || []).map((s) => ({ ...s }));
    sodium.forEach((r) => {
      const date = mmdd(r.date);
      const hit = date && snapshots.find((s) => s.date === date);
      if (hit) hit.na = r.value;
      else snapshots.push({ date, na: r.value });
    });
    return {
      kind: 'adopt', na: clinic, naLabel: naLabelFor(sodium), snapshots,
      added: clinic.length - cur.length,
    };
  }
  return { kind: 'conflict' };
}

/**
 * Merge one census admission into an EXISTING patient — the UPDATE path.
 * Pure: returns { next, changes, notes } and leaves `patient` untouched.
 * `changes` are human-readable lines shown in the review; `notes` are
 * kept-your-data warnings (e.g. a sodium conflict).
 */
export function mergeAdmission(patient, adm) {
  const changes = [];
  const notes = [];
  const next = { ...patient, meds: (patient.meds || []).map((m) => ({ ...m })) };

  // clinic-wins fields (census facts owned by the desktop app)
  const winner = (field, label, val) => {
    if (val && val !== next[field]) {
      changes.push(`${label}: ${clean(next[field]) || '—'} → ${val}`);
      next[field] = val;
    }
  };
  winner('name', 'Name', clean(adm.patient_name));
  winner('hospital', 'Hospital', clean(adm.hospital));
  winner('room', 'Room', clean(adm.room));
  winner('dx', 'Diagnosis', clean(adm.primary_diagnosis));
  const d = Number(adm.hospital_day);
  if (Number.isFinite(d) && d > 0) winner('day', 'Day', String(d));

  // fill-only fields — never overwrite what was entered at the bedside
  if (clean(adm.dob) && !clean(next.dob)) {
    next.dob = clean(adm.dob);
    changes.push(`Birthdate: set to ${next.dob}`);
    if (!clean(next.age)) next.age = ageFromDob(next.dob);
  }
  if (clean(adm.icd10_code) && !clean(next.detail)) {
    next.detail = clean(adm.icd10_code);
    changes.push(`Detail: set to ${next.detail}`);
  }

  // meds: append-only, dedup by name (case-insensitive)
  const have = new Set(next.meds.map((m) => clean(m.n).toLowerCase()).filter(Boolean));
  (adm.meds || []).map(medFromClinic).forEach((m) => {
    if (!m.n || have.has(m.n.toLowerCase())) return;
    next.meds.push(m);
    have.add(m.n.toLowerCase());
    changes.push(`+ med: ${m.n}${m.d ? ' ' + m.d : ''}`);
  });

  const s = mergeSodium(patient, sodiumSeries(adm));
  if (s.kind === 'adopt') {
    next.na = s.na; next.naLabel = s.naLabel; next.snapshots = s.snapshots;
    changes.push(`Sodium: +${s.added} clinic value${s.added > 1 ? 's' : ''} (latest ${s.na[s.na.length - 1]})`);
  } else if (s.kind === 'conflict') {
    notes.push('Sodium series differ — kept this phone’s values.');
  }

  return { next, changes, notes };
}

/**
 * Build the review plan for a whole census file against the current roster:
 *   creates   — admissions with no linked patient here → will create (opt-out)
 *   updates   — linked patients with at least one change → will update (opt-out)
 *   unchanged — linked patients the file adds nothing to (names only)
 *   absent    — patients linked to the clinic but NOT in this file (likely
 *               discharged there) → flagged only, NEVER deleted or changed
 *   warnings  — kept-your-data notes ("Name: sodium series differ …")
 * Pure; main.js owns rendering and the commit.
 */
export function planImport(payload, patients) {
  const byId = new Map();
  (patients || []).forEach((p) => {
    if (p.clinicAdmissionId != null) byId.set(String(p.clinicAdmissionId), p);
  });
  const names = new Set((patients || []).map((p) => clean(p.name).toLowerCase()).filter(Boolean));

  const creates = [], updates = [], unchanged = [], warnings = [];
  const seen = new Set();

  // Bedside-first patients the clinic registered from a cockpit updates file:
  // the census echoes this app's patient id back as cockpit_id. Only a patient
  // not yet linked may be claimed this way — an existing link always wins.
  const byCockpitId = new Map();
  (patients || []).forEach((p) => {
    if (p.clinicAdmissionId == null) byCockpitId.set(String(p.id), p);
  });

  (payload.admissions || []).forEach((adm) => {
    if (adm.admission_id == null) return;
    const key = String(adm.admission_id);
    seen.add(key);
    let p = byId.get(key);
    let newlyLinked = false;
    if (!p && adm.cockpit_id != null && byCockpitId.has(String(adm.cockpit_id))) {
      p = byCockpitId.get(String(adm.cockpit_id));
      newlyLinked = true;
    }
    if (!p) {
      const fields = mapAdmission(adm);
      creates.push({
        name: fields.name || '(unnamed)',
        summary: [fields.dx, fields.hospital, fields.room ? 'Rm ' + fields.room : '']
          .filter(Boolean).join(' · '),
        // An unlinked same-name patient may already exist (added by hand before
        // the link) — importing would DUPLICATE, so warn; the user can untick.
        nameClash: names.has(fields.name.toLowerCase()),
        fields, include: true,
      });
      return;
    }
    const { next, changes, notes } = mergeAdmission(p, adm);
    notes.forEach((n) => warnings.push(`${p.name}: ${n}`));
    if (newlyLinked) {
      next.clinicAdmissionId = adm.admission_id;
      changes.unshift('Linked to this clinic admission');
    }
    if (changes.length) updates.push({ id: p.id, name: p.name, next, changes, include: true });
    else unchanged.push(p.name);
  });

  const absent = (patients || [])
    .filter((p) => p.clinicAdmissionId != null && !seen.has(String(p.clinicAdmissionId)))
    .map((p) => ({ id: p.id, name: p.name }));

  return { creates, updates, unchanged, absent, warnings };
}
