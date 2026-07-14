import { describe, it, expect } from 'vitest';
import { buildClinicUpdates, clinicUpdatesText, isoFromMMDD } from './clinicUpdates.js';
import { newPatient } from './schema.js';

const TODAY = '2026-07-13';

// A linked bedside patient with a bit of everything to send.
function linked(over = {}) {
  return newPatient({
    id: 'p_ramon', clinicAdmissionId: 7, name: 'Ramon dela Cruz', sex: 'M', day: '5',
    dx: 'Aneurysmal SAH', hospital: 'Region 1 Medical Center', room: '408',
    scores: [{ l: 'GCS', v: '13', a: '' }, { l: 'NA', v: '128', a: 'dn' }],
    ask: [
      { q: 'Headache', s: '', t: ['Better', 'Same', 'Worse'], on: 2, k: 'neg' },
      { q: 'Bowel movement', s: '', t: ['Yes', 'No'], on: 0, k: 'pos' },
      { q: 'Sleep', s: '', t: ['Good', 'Poor'], on: 1, k: 'neg' },
    ],
    meds: [{ n: 'Nimodipine', d: '60mg q4h PO', day: 'D5·21', w: false }],
    na: [134, 131, 128], naLabel: '07/10 → 07/12',
    snapshots: [
      { date: '07/10', na: 134 }, { date: '07/11', na: 131 }, { date: '07/12', na: 128, rr: 18 },
    ],
    customLabs: [{ id: 'lab1', label: 'Creatinine', unit: 'mg/dL', band: [0.6, 1.2],
      series: [{ date: '2026-07-11', value: 1.1 }, { date: '2026-07-12', value: 1.2 }] }],
    doMain: { t: 'Repeat Na in 6h', s: 'hyponatremia' },
    ...over,
  });
}

describe('isoFromMMDD', () => {
  it('uses the current year for past-or-today dates', () => {
    expect(isoFromMMDD('07/10', TODAY)).toBe('2026-07-10');
    expect(isoFromMMDD('7/1', TODAY)).toBe('2026-07-01');
  });
  it('rolls back a year for dates that would be in the future', () => {
    expect(isoFromMMDD('12/28', '2027-01-03')).toBe('2026-12-28');
  });
  it('returns blank for junk, never a guess', () => {
    expect(isoFromMMDD('', TODAY)).toBe('');
    expect(isoFromMMDD('July 10', TODAY)).toBe('');
  });
});

describe('buildClinicUpdates — linked patients (updates[])', () => {
  const out = buildClinicUpdates([linked()], TODAY);
  const u = out.updates[0];

  it('wraps everything in a versioned cockpit envelope', () => {
    expect(out.format).toBe('cockpit-updates');
    expect(out.version).toBe(1);
    expect(out.source).toBe('cockpit');
    expect(out.new_admissions).toEqual([]);
  });
  it('targets the linked clinic admission and carries the cockpit id', () => {
    expect(u.admission_id).toBe(7);
    expect(u.cockpit_id).toBe('p_ramon');
  });
  it('maps scores and ask answers into the round', () => {
    expect(u.round.gcs).toBe('13');
    expect(u.round.nihss).toBe('');
    expect(u.round.bowel).toBe('Yes');
    expect(u.round.sleep).toBe('Poor');
    expect(u.round.extra_answers).toEqual({ Headache: 'Worse' });
  });
  it('sends the physician-set plan as assessment_plan', () => {
    expect(u.round.assessment_plan).toBe('Repeat Na in 6h — hyponatremia');
  });
  it('maps meds whole (never splitting the free-text dose) with derived start date', () => {
    expect(u.new_meds).toEqual([{
      medication: 'Nimodipine', dosage: '60mg q4h PO', frequency: '', route: '',
      start_date: '2026-07-09', course_total_days: 21, ordered_by: '',
    }]);
  });
  it('sends dated sodium and custom-lab series as new_labs', () => {
    expect(u.new_labs).toEqual([
      { test_name: 'Sodium', result: '134', date_recorded: '2026-07-10', unit: 'mmol/L' },
      { test_name: 'Sodium', result: '131', date_recorded: '2026-07-11', unit: 'mmol/L' },
      { test_name: 'Sodium', result: '128', date_recorded: '2026-07-12', unit: 'mmol/L' },
      { test_name: 'Creatinine', result: '1.1', date_recorded: '2026-07-11', unit: 'mg/dL' },
      { test_name: 'Creatinine', result: '1.2', date_recorded: '2026-07-12', unit: 'mg/dL' },
    ]);
  });
});

describe('buildClinicUpdates — nothing-to-say and defaults', () => {
  it('omits a linked patient with nothing to send', () => {
    const empty = newPatient({ id: 'p_e', clinicAdmissionId: 9, name: 'Quiet Patient' });
    expect(buildClinicUpdates([empty], TODAY).updates).toEqual([]);
  });
  it('never echoes the factory or census-written plan back to the clinic', () => {
    const a = linked({ doMain: { t: 'Set plan', s: 'new admission' }, meds: [], snapshots: [], customLabs: [], ask: [], scores: [] });
    const b = linked({ doMain: { t: 'Review clinic plan', s: 'Repeat Na in 6h' }, meds: [], snapshots: [], customLabs: [], ask: [], scores: [] });
    expect(buildClinicUpdates([a], TODAY).updates).toEqual([]);
    expect(buildClinicUpdates([b], TODAY).updates).toEqual([]);
  });
  it('skips placeholder score values and undated labs', () => {
    const p = linked({ scores: [{ l: 'GCS', v: '—', a: '' }], snapshots: [{ date: '', na: 130 }], customLabs: [], meds: [], ask: [], doMain: { t: 'Set plan', s: '' } });
    expect(buildClinicUpdates([p], TODAY).updates).toEqual([]);
  });
  it('handles a med without a parseable day (no start date, no course)', () => {
    const p = linked({ meds: [{ n: 'Paracetamol', d: 'PRN', day: 'PRN', w: false }] });
    const med = buildClinicUpdates([p], TODAY).updates[0].new_meds[0];
    expect(med.start_date).toBe('');
    expect(med.course_total_days).toBeNull();
  });
});

describe('buildClinicUpdates — bedside-first patients (new_admissions[])', () => {
  const p = newPatient({
    id: 'p_new', name: 'Bedside Admission', sex: 'F', dob: '1958-01-20', day: '3',
    dx: 'L MCA infarct', detail: 'NIHSS 6', triage: 'a',
    hospital: 'Nazareth General Hospital', room: '302',
    scores: [{ l: 'NIHSS', v: '6', a: '' }],
    meds: [{ n: 'Aspirin', d: '80mg OD', day: 'D3', w: false }],
  });
  const out = buildClinicUpdates([p], TODAY);
  const na = out.new_admissions[0];

  it('goes to new_admissions with the cockpit id as the future link', () => {
    expect(out.updates).toEqual([]);
    expect(na.cockpit_id).toBe('p_new');
  });
  it('maps demographics and location, sex to the clinic wording', () => {
    expect(na.patient_name).toBe('Bedside Admission');
    expect(na.sex).toBe('Female');
    expect(na.dob).toBe('1958-01-20');
    expect(na.hospital).toBe('Nazareth General Hospital');
    expect(na.room).toBe('302');
  });
  it('derives admit_date from the day counter (day 1 = today)', () => {
    expect(na.admit_date).toBe('2026-07-11'); // day 3 → two days ago
  });
  it('folds detail into the diagnosis and maps triage wording', () => {
    expect(na.primary_diagnosis).toBe('L MCA infarct (NIHSS 6)');
    expect(na.triage_status).toBe('amber');
  });
  it('carries round + meds for the clinic to apply after creating the admission', () => {
    expect(na.round.nihss).toBe('6');
    expect(na.new_meds[0].medication).toBe('Aspirin');
  });
});

describe('clinicUpdatesText', () => {
  it('produces parseable pretty JSON', () => {
    const parsed = JSON.parse(clinicUpdatesText([linked()], TODAY));
    expect(parsed.format).toBe('cockpit-updates');
    expect(parsed.updates).toHaveLength(1);
  });
});
