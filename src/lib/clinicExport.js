/**
 * clinicExport.js — turn a patient record into the JSON the Brain Clinic app's
 * "Import from JSON" box (New Patient page) understands, for the send-home
 * handover: inpatient discharged here → registered as an outpatient there.
 *
 * The clinic import fills exactly these form fields:
 *   full_name, dob, phone, sex ("Male"/"Female"), address, medical_notes
 *
 * Date of birth passes through only if the physician entered one on the
 * patient (optional field, ISO YYYY-MM-DD — the clinic's date input takes it
 * as-is); phone and address aren't stored here, so they export as EMPTY
 * strings to fill in at registration. Missing values are never guessed or
 * fabricated (a made-up DOB in a medical record is worse than a blank one).
 * Everything clinical goes into medical_notes as a readable discharge summary.
 *
 * PRIVACY — this produces PLAINTEXT patient data. It must only ever be
 * handed to the physician (clipboard / share sheet) on an explicit tap;
 * nothing here may upload, persist, or auto-send it (see CLAUDE.md
 * invariant #1 — the app itself transmits nothing).
 */

const SEX_MAP = { M: 'Male', F: 'Female' };

/** True for the app's "no value" placeholders. */
const blank = (v) => v == null || v === '' || v === '—';

function fmtOnset(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Build the multiline discharge summary for medical_notes. Sections with no
 * data are omitted entirely — the note must never contain "undefined" or a
 * lone '—' placeholder.
 */
export function buildDischargeNotes(p, todayISO) {
  const lines = [];
  lines.push(`Discharged from inpatient care — exported from Rounds Cockpit on ${todayISO}.`);
  lines.push('');

  if (!blank(p.dx)) lines.push(`Diagnosis: ${p.dx}${blank(p.detail) ? '' : ` (${p.detail})`}`);
  else if (!blank(p.detail)) lines.push(`Diagnosis detail: ${p.detail}`);

  const who = [];
  if (!blank(p.age)) who.push(`Age ${p.age}`);
  if (SEX_MAP[p.sex]) who.push(SEX_MAP[p.sex]);
  if (who.length) lines.push(who.join(', '));

  const adm = [];
  if (!blank(p.hospital)) adm.push(p.hospital);
  if (!blank(p.room)) adm.push(`Room ${p.room}`);
  if (!blank(p.day)) adm.push(`hospital day ${p.day} at discharge`);
  if (adm.length) lines.push(`Admission: ${adm.join(' · ')}`);

  const meds = (p.meds || []).filter((m) => !blank(m.n));
  if (meds.length) {
    lines.push('');
    lines.push('Medications at discharge:');
    meds.forEach((m) => lines.push(`- ${m.n}${blank(m.d) ? '' : ' ' + m.d}`));
  }

  const scores = (p.scores || []).filter((s) => !blank(s.l) && !blank(s.v));
  if (scores.length) {
    lines.push('');
    lines.push(`Latest scores: ${scores.map((s) => `${s.l} ${s.v}`).join(', ')}`);
  }

  const vitals = (p.vitals || []).filter((v) => v && !blank(v[0]) && !blank(v[1]));
  if (vitals.length) lines.push(`Latest vitals: ${vitals.map((v) => `${v[0]} ${v[1]}`).join(', ')}`);

  const na = (p.na || []).filter((v) => v != null);
  if (na.length) {
    const label = blank(p.naLabel) ? '' : ` (${p.naLabel})`;
    lines.push(`Sodium trend${label}: ${na.join(' → ')} mmol/L`);
  }
  const chem = [];
  if (p.k && !blank(p.k.v)) chem.push(`K ${p.k.v}`);
  if (p.osmo && !blank(p.osmo.v)) chem.push(`Serum osm ${p.osmo.v}`);
  if (chem.length) lines.push(`Latest chemistry: ${chem.join(' · ')}`);

  (p.customLabs || []).forEach((lab) => {
    const series = (lab.series || []).filter((r) => r && r.value != null);
    if (!series.length || blank(lab.label)) return;
    const unit = blank(lab.unit) ? '' : ` ${lab.unit}`;
    const span = series.length > 1 ? ` (${series[0].date} → ${series[series.length - 1].date})` : ` (${series[0].date})`;
    lines.push(`${lab.label} trend${span}: ${series.map((r) => r.value).join(' → ')}${unit}`);
  });

  const sz = p.seizures || [];
  if (sz.length) {
    const last = sz[sz.length - 1];
    const when = fmtOnset(last.onset);
    lines.push('');
    lines.push(`Seizure log: ${sz.length} recorded event(s) this admission; last: ${blank(last.type) ? 'unspecified type' : last.type}${when ? ` on ${when}` : ''}.`);
  }

  if (p.doMain && !blank(p.doMain.t)) {
    lines.push('');
    lines.push(`Last inpatient plan: ${p.doMain.t}${blank(p.doMain.s) ? '' : ` — ${p.doMain.s}`}`);
  }

  return lines.join('\n').trim();
}

/**
 * The importable object. `todayISO` is injectable for tests; defaults to the
 * real date (YYYY-MM-DD).
 */
export function buildClinicExport(p, todayISO = new Date().toISOString().slice(0, 10)) {
  return {
    full_name: p.name || '',
    dob: p.dob || '', // only a physician-entered birthdate — blank is never guessed
    phone: '', // not stored in this app
    address: '', // not stored in this app
    ...(SEX_MAP[p.sex] ? { sex: SEX_MAP[p.sex] } : {}),
    medical_notes: buildDischargeNotes(p, todayISO),
  };
}

/** Pretty JSON string, ready to paste into the clinic's import box. */
export function clinicExportText(p, todayISO) {
  return JSON.stringify(buildClinicExport(p, todayISO), null, 2);
}
