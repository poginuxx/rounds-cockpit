/**
 * clinicUpdates.js — build the "updates" JSON the Brain Clinic's In-Patients →
 * Import updates screen accepts: the cockpit → clinic half of the daily sync
 * loop (censusImport.js is the other half, clinic → cockpit; clinicExport.js
 * is the separate discharge-to-OUTPATIENT handover).
 *
 * Two sections:
 *   updates[]         — patients LINKED to a clinic admission (clinicAdmissionId
 *                       set by a census import): today's scores, ask answers,
 *                       the plan, current meds, and dated labs.
 *   new_admissions[]  — patients admitted bedside-first (no link yet), carrying
 *                       this app's patient id as cockpit_id. The clinic creates
 *                       the patient + admission and stores that id; the NEXT
 *                       census import links the two records permanently.
 *
 * The clinic import is ADDITIVE (meds appended, round upserted, labs and plan
 * lines deduplicated on its side), so sending the same file twice is safe.
 * Values are exported as-is; a missing value is omitted, never guessed.
 *
 * PRIVACY — like clinicExport.js this produces PLAINTEXT patient data. It is
 * only ever handed to the physician (file download / share sheet) on an
 * explicit tap; nothing here uploads, persists, or auto-sends anything.
 *
 * Everything here is pure (no store, no DOM); main.js renders and delivers.
 */

const SEX_OUT = { M: 'Male', F: 'Female' };
const TRIAGE_OUT = { g: 'green', a: 'amber', r: 'red' };

const clean = (v) => (v == null || v === '—' ? '' : String(v).trim());
const todayISOOf = () => new Date().toISOString().slice(0, 10);

/** ISO date `n` days before `todayISO`. Pure UTC arithmetic — a local-midnight
 *  Date would shift a day when serialized back through toISOString (UTC+8). */
function daysBefore(todayISO, n) {
  const [y, m, d] = todayISO.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}

/**
 * 'MM/DD' (the app's snapshot date format) → ISO 'YYYY-MM-DD'.
 * The year is inferred: this year, unless that lands in the future relative to
 * `todayISO` (a December reading seen in January) — then last year. Returns ''
 * for unparseable input rather than guessing.
 */
export function isoFromMMDD(mmdd, todayISO) {
  const m = clean(mmdd).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return '';
  const mm = m[1].padStart(2, '0'), dd = m[2].padStart(2, '0');
  const year = Number(todayISO.slice(0, 4));
  const candidate = `${year}-${mm}-${dd}`;
  return candidate > todayISO ? `${year - 1}-${mm}-${dd}` : candidate;
}

/** Score value by label ('GCS' / 'NIHSS'), '' when absent or placeholder. */
function scoreOf(p, label) {
  const s = (p.scores || []).find((x) => x.l === label);
  return s ? clean(s.v) : '';
}

/** The chosen chip text of the first ask entry whose question matches `re`. */
function askAnswer(p, re) {
  const a = (p.ask || []).find((x) => re.test(x.q || ''));
  return a && typeof a.on === 'number' && a.t && a.t[a.on] != null ? String(a.t[a.on]) : '';
}

const BOWEL_RE = /bowel/i;
const SLEEP_RE = /sleep/i;

/** Remaining answered ask entries → { question: answer } for extra_answers. */
function extraAnswers(p) {
  const out = {};
  (p.ask || []).forEach((a) => {
    if (BOWEL_RE.test(a.q || '') || SLEEP_RE.test(a.q || '')) return; // sent as round fields
    if (typeof a.on !== 'number' || !a.t || a.t[a.on] == null) return;
    out[a.q] = String(a.t[a.on]);
  });
  return out;
}

/**
 * The plan line for assessment_plan. The factory default ('Set plan') and the
 * line a census import wrote ('Review clinic plan') are NOT echoed back — the
 * clinic already has its own plan; only a physician-set cockpit plan travels.
 */
function planOf(p) {
  const t = clean(p.doMain && p.doMain.t);
  if (!t || t === 'Set plan' || t === 'Review clinic plan') return '';
  const s = clean(p.doMain && p.doMain.s);
  return s ? `${t} — ${s}` : t;
}

function roundOf(p) {
  return {
    bowel: askAnswer(p, BOWEL_RE),
    sleep: askAnswer(p, SLEEP_RE),
    pain: '',
    gcs: scoreOf(p, 'GCS'),
    nihss: scoreOf(p, 'NIHSS'),
    assessment_plan: planOf(p),
    extra_answers: extraAnswers(p),
  };
}

/**
 * Cockpit meds → clinic new_meds. The cockpit stores dose/frequency/route as
 * ONE free-text string, so it travels whole in `dosage` (never split by
 * guessing). 'D5·21' → start date 4 days before today + 21-day course.
 * The clinic side appends these only when the name isn't already active.
 */
function medsOf(p, todayISO) {
  return (p.meds || []).filter((m) => clean(m.n)).map((m) => {
    const day = clean(m.day).match(/^D(\d+)/);
    const course = clean(m.day).match(/·(\d+)$/);
    const start = day ? daysBefore(todayISO, Number(day[1]) - 1) : '';
    return {
      medication: clean(m.n), dosage: clean(m.d), frequency: '', route: '',
      start_date: start, course_total_days: course ? Number(course[1]) : null,
      ordered_by: '',
    };
  });
}

/**
 * Dated lab values → clinic new_labs (deduplicated by the clinic on
 * patient + test + date, so full series are safe to resend).
 * Sodium comes from snapshots[] (the dated record of na[]); custom labs from
 * their own ISO-dated series. Undated values (k, osmo) are NOT sent.
 */
function labsOf(p, todayISO) {
  const out = [];
  (p.snapshots || []).forEach((s) => {
    if (s.na == null) return;
    const date = isoFromMMDD(s.date, todayISO);
    if (!date) return;
    out.push({ test_name: 'Sodium', result: String(s.na), date_recorded: date, unit: 'mmol/L' });
  });
  (p.customLabs || []).forEach((lab) => {
    if (!clean(lab.label)) return;
    (lab.series || []).forEach((r) => {
      if (!r || r.value == null || !clean(r.date)) return;
      out.push({
        test_name: clean(lab.label), result: String(r.value),
        date_recorded: clean(r.date), unit: clean(lab.unit),
      });
    });
  });
  return out;
}

/** Does this update entry carry anything worth importing? */
function hasContent(u) {
  const r = u.round;
  return !!(u.new_meds.length || u.new_labs.length || r.bowel || r.sleep
    || r.gcs || r.nihss || r.assessment_plan || Object.keys(r.extra_answers).length);
}

/** Admit date inferred from the hospital-day counter (day 1 = today). */
function admitDateOf(p, todayISO) {
  const day = Number(p.day);
  if (!Number.isFinite(day) || day < 1) return todayISO;
  return daysBefore(todayISO, Math.floor(day) - 1);
}

/**
 * Build the whole payload. `patients` is whatever the user confirmed to send —
 * linked ones become updates[], unlinked ones new_admissions[]. `todayISO` is
 * injectable for tests.
 */
export function buildClinicUpdates(patients, todayISO = todayISOOf()) {
  const updates = [];
  const newAdmissions = [];
  (patients || []).forEach((p) => {
    const base = {
      cockpit_id: p.id,
      patient_name: clean(p.name), // for the human reading the file; ids do the matching
      round: roundOf(p),
      new_meds: medsOf(p, todayISO),
      new_labs: labsOf(p, todayISO),
    };
    if (p.clinicAdmissionId != null) {
      const u = { admission_id: p.clinicAdmissionId, ...base };
      if (hasContent(u)) updates.push(u);
    } else {
      newAdmissions.push({
        ...base,
        dob: clean(p.dob),
        sex: SEX_OUT[p.sex] || '',
        hospital: clean(p.hospital), room: clean(p.room),
        admit_date: admitDateOf(p, todayISO),
        primary_diagnosis: clean(p.dx) + (clean(p.detail) ? ` (${clean(p.detail)})` : ''),
        triage_status: TRIAGE_OUT[p.triage] || 'green',
      });
    }
  });
  return {
    format: 'cockpit-updates', version: 1,
    generated_at: new Date().toISOString(), source: 'cockpit',
    updates, new_admissions: newAdmissions,
  };
}

/** Pretty JSON string, ready to save/share and import in Brain Clinic. */
export function clinicUpdatesText(patients, todayISO) {
  return JSON.stringify(buildClinicUpdates(patients, todayISO), null, 2);
}
