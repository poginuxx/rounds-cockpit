import { describe, it, expect } from 'vitest';
import {
  readCensus, mapAdmission, mergeSodium, mergeAdmission, planImport, CensusError,
} from './censusImport.js';
import { newPatient } from './schema.js';

// A realistic admission as the clinic's /inpatient/export_census produces it.
function clinicAdm(over = {}) {
  return {
    admission_id: 7,
    cockpit_id: null,
    patient_name: 'Ramon dela Cruz', sex: 'Male', dob: '1972-03-15',
    hospital: 'Region 1 Medical Center', room: '408', admit_date: '2026-07-09',
    hospital_day: 5,
    primary_diagnosis: 'Aneurysmal SAH', icd10_code: 'I60.7',
    co_managing: '', triage_status: 'red',
    extra_questions: ['Worse headache?', 'Photophobia?'],
    today_round: { bowel: '', sleep: '', pain: '', gcs: '13', nihss: '',
      assessment_plan: 'Repeat Na in 6h\nContinue nimodipine', extra_answers: {} },
    sodium: [
      { date: '2026-07-10', value: 134 },
      { date: '2026-07-11', value: 131 },
      { date: '2026-07-12', value: 128 },
    ],
    latest_vitals: { blood_pressure: '148/86', heart_rate: '78', respiratory_rate: '18',
      temperature: '37.2', weight: '70', o2_sat: '98' },
    meds: [
      { medication: 'Nimodipine', dosage: '60mg', frequency: 'q4h', route: 'PO',
        ordered_by: 'FGL', day_num: 5, course_total_days: 21 },
      { medication: '3% NaCl', dosage: '', frequency: 'infusion', route: 'IV',
        ordered_by: '', day_num: 1, course_total_days: null },
    ],
    recent_rounds: [],
    ...over,
  };
}

const envelope = (admissions) => JSON.stringify({
  format: 'clinic-census', version: 1,
  exported_at: '2026-07-13 08:00:00', today: '2026-07-13', admissions,
});

describe('readCensus', () => {
  it('accepts a valid v1 envelope', () => {
    const data = readCensus(envelope([clinicAdm()]));
    expect(data.admissions).toHaveLength(1);
  });
  it('rejects non-JSON', () => {
    expect(() => readCensus('not json')).toThrow(CensusError);
  });
  it('rejects a foreign format (e.g. an encrypted backup file)', () => {
    expect(() => readCensus(JSON.stringify({ format: 'rounds-backup', version: 1 })))
      .toThrow(CensusError);
  });
  it('rejects an unknown version', () => {
    expect(() => readCensus(JSON.stringify({ format: 'clinic-census', version: 2, admissions: [] })))
      .toThrow(/version 2/);
  });
  it('rejects a missing admissions list', () => {
    expect(() => readCensus(JSON.stringify({ format: 'clinic-census', version: 1 })))
      .toThrow(CensusError);
  });
});

describe('mapAdmission (create path)', () => {
  const f = mapAdmission(clinicAdm());

  it('links the clinic admission id', () => {
    expect(f.clinicAdmissionId).toBe(7);
  });
  it('maps demographics, sex, and derives age from dob', () => {
    expect(f.name).toBe('Ramon dela Cruz');
    expect(f.sex).toBe('M');
    expect(f.dob).toBe('1972-03-15');
    expect(Number(f.age)).toBeGreaterThan(50); // derived, not fabricated
  });
  it('maps dx, icd10 into detail, hospital, room, day', () => {
    expect(f.dx).toBe('Aneurysmal SAH');
    expect(f.detail).toBe('I60.7');
    expect(f.hospital).toBe('Region 1 Medical Center');
    expect(f.room).toBe('408');
    expect(f.day).toBe('5');
  });
  it('maps meds into { n, d, day } joining dose/freq/route', () => {
    expect(f.meds[0]).toEqual({ n: 'Nimodipine', d: '60mg q4h PO', day: 'D5·21', w: false });
    expect(f.meds[1].d).toBe('infusion IV');
    expect(f.meds[1].day).toBe('D1');
  });
  it('maps the sodium series with label and dated snapshots', () => {
    expect(f.na).toEqual([134, 131, 128]);
    expect(f.naLabel).toBe('07/10 → 07/12');
    expect(f.trackNa).toBe(true);
    expect(f.snapshots).toEqual([
      { date: '07/10', na: 134 }, { date: '07/11', na: 131 }, { date: '07/12', na: 128 },
    ]);
  });
  it('maps vitals with the cockpit labels (SPO₂ included, weight dropped)', () => {
    expect(f.vitals).toEqual([
      ['BP', '148/86'], ['HR', '78'], ['RR', '18'], ['TEMP', '37.2'], ['SPO₂', '98'],
    ]);
  });
  it('maps scores from today’s round plus the latest Na', () => {
    expect(f.scores).toEqual([
      { l: 'GCS', v: '13', a: '' }, { l: 'NA', v: '128', a: '' },
    ]);
  });
  it('surfaces the clinic plan as the DO action', () => {
    expect(f.doMain.t).toBe('Review clinic plan');
    expect(f.doMain.s).toBe('Repeat Na in 6h');
  });
  it('never fabricates: blank dob → blank age; "?" day → 1; no sodium → no tracking', () => {
    const g = mapAdmission(clinicAdm({ dob: '', hospital_day: '?', sodium: [] }));
    expect(g.dob).toBe('');
    expect(g.age).toBe('');
    expect(g.day).toBe('1');
    expect(g.na).toEqual([]);
    expect(g.trackNa).toBe(false);
    expect(g.naLabel).toBe('');
  });
});

describe('mergeSodium', () => {
  const sodium = [
    { date: '2026-07-10', value: 134 },
    { date: '2026-07-11', value: 131 },
    { date: '2026-07-12', value: 128 },
  ];
  it('adopts the clinic series when this phone has none', () => {
    const r = mergeSodium(newPatient(), sodium);
    expect(r.kind).toBe('adopt');
    expect(r.na).toEqual([134, 131, 128]);
    expect(r.added).toBe(3);
  });
  it('adopts when the clinic series extends the phone’s (prefix rule)', () => {
    const p = newPatient({ na: [134, 131], naLabel: '07/10 → 07/11',
      snapshots: [{ date: '07/10', na: 134 }, { date: '07/11', na: 131, rr: 18 }] });
    const r = mergeSodium(p, sodium);
    expect(r.kind).toBe('adopt');
    expect(r.added).toBe(1);
    expect(r.naLabel).toBe('07/10 → 07/12');
    // existing snapshot vitals survive; the new day is appended
    expect(r.snapshots).toEqual([
      { date: '07/10', na: 134 }, { date: '07/11', na: 131, rr: 18 }, { date: '07/12', na: 128 },
    ]);
  });
  it('reports identical series as same (no change)', () => {
    expect(mergeSodium(newPatient({ na: [134, 131, 128] }), sodium).kind).toBe('same');
  });
  it('never overwrites a diverging series — conflict', () => {
    expect(mergeSodium(newPatient({ na: [134, 130] }), sodium).kind).toBe('conflict');
    // phone has MORE than the clinic → also a conflict, not a truncation
    expect(mergeSodium(newPatient({ na: [134, 131, 128, 126] }), sodium).kind).toBe('conflict');
  });
});

describe('mergeAdmission (update path)', () => {
  const base = () => newPatient({
    id: 'p_x', clinicAdmissionId: 7, name: 'Ramon dela Cruz', dob: '1972-03-15', age: '54',
    dx: 'Aneurysmal SAH', detail: 'Hunt-Hess 3', day: '4',
    hospital: 'Region 1 Medical Center', room: '406',
    meds: [{ n: 'Nimodipine', d: '60mg q4h', day: 'D4', w: false }],
    na: [134, 131], naLabel: '07/10 → 07/11',
    snapshots: [{ date: '07/10', na: 134 }, { date: '07/11', na: 131 }],
  });

  it('clinic wins on room and day, with readable change lines', () => {
    const { next, changes } = mergeAdmission(base(), clinicAdm());
    expect(next.room).toBe('408');
    expect(next.day).toBe('5');
    expect(changes).toContain('Room: 406 → 408');
    expect(changes).toContain('Day: 4 → 5');
  });
  it('does NOT overwrite bedside detail with the ICD code', () => {
    const { next } = mergeAdmission(base(), clinicAdm());
    expect(next.detail).toBe('Hunt-Hess 3');
  });
  it('appends only genuinely new meds (name match is case-insensitive)', () => {
    const { next, changes } = mergeAdmission(base(), clinicAdm());
    expect(next.meds.map((m) => m.n)).toEqual(['Nimodipine', '3% NaCl']);
    expect(changes.filter((c) => c.startsWith('+ med'))).toHaveLength(1);
  });
  it('extends sodium and reports it', () => {
    const { next, changes } = mergeAdmission(base(), clinicAdm());
    expect(next.na).toEqual([134, 131, 128]);
    expect(changes.some((c) => c.startsWith('Sodium: +1'))).toBe(true);
  });
  it('keeps the phone’s sodium on conflict and says so in notes', () => {
    const p = base(); p.na = [134, 130];
    const { next, notes } = mergeAdmission(p, clinicAdm());
    expect(next.na).toEqual([134, 130]);
    expect(notes.join(' ')).toMatch(/kept this phone/);
  });
  it('is pure — the input patient is untouched', () => {
    const p = base();
    mergeAdmission(p, clinicAdm());
    expect(p.room).toBe('406');
    expect(p.meds).toHaveLength(1);
  });
  it('returns no changes when the census adds nothing', () => {
    const p = base(); p.room = '408'; p.day = '5'; p.na = [134, 131, 128];
    p.naLabel = '07/10 → 07/12';
    p.meds.push({ n: '3% nacl', d: 'infusion IV', day: 'D1', w: true });
    const { changes } = mergeAdmission(p, clinicAdm());
    expect(changes).toEqual([]);
  });
});

describe('planImport', () => {
  it('splits creates / updates / unchanged / absent by exact admission id', () => {
    const linkedChanged = newPatient({ id: 'p_a', clinicAdmissionId: 7, name: 'Ramon dela Cruz', room: '406' });
    const linkedGone = newPatient({ id: 'p_b', clinicAdmissionId: 99, name: 'Old Patient' });
    const unlinked = newPatient({ id: 'p_c', name: 'Manual Entry' });
    const plan = planImport(
      { admissions: [clinicAdm(), clinicAdm({ admission_id: 8, patient_name: 'New Person', sodium: [], meds: [] })] },
      [linkedChanged, linkedGone, unlinked],
    );
    expect(plan.creates.map((c) => c.name)).toEqual(['New Person']);
    expect(plan.updates.map((u) => u.id)).toEqual(['p_a']);
    expect(plan.absent).toEqual([{ id: 'p_b', name: 'Old Patient' }]);
  });
  it('matches numeric ids against stored string ids (and vice versa)', () => {
    const p = newPatient({ id: 'p_a', clinicAdmissionId: '7', name: 'Ramon dela Cruz', room: '406' });
    const plan = planImport({ admissions: [clinicAdm()] }, [p]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
  });
  it('flags a create whose name matches an existing unlinked patient', () => {
    const p = newPatient({ id: 'p_c', name: 'Ramon dela Cruz' }); // no link
    const plan = planImport({ admissions: [clinicAdm()] }, [p]);
    expect(plan.creates[0].nameClash).toBe(true);
  });
  it('collects sodium-conflict warnings even when nothing else changed', () => {
    const p = newPatient({
      id: 'p_a', clinicAdmissionId: 7, name: 'Ramon dela Cruz', dob: '1972-03-15',
      dx: 'Aneurysmal SAH', detail: 'HH3', day: '5',
      hospital: 'Region 1 Medical Center', room: '408',
      na: [134, 130], naLabel: '07/10 → 07/11',
      meds: [{ n: 'Nimodipine', d: '', day: '', w: false }, { n: '3% NaCl', d: '', day: '', w: false }],
    });
    const plan = planImport({ admissions: [clinicAdm()] }, [p]);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchanged).toEqual(['Ramon dela Cruz']);
    expect(plan.warnings.join(' ')).toMatch(/Sodium series differ/);
  });
  it('links a bedside-first patient by the echoed cockpit_id instead of duplicating', () => {
    // The cockpit sent this patient in an updates file; the clinic created
    // admission 7 storing cockpit_id 'p_bed' and now exports it in the census.
    const p = newPatient({ id: 'p_bed', name: 'Ramon dela Cruz', room: '406' }); // no link yet
    const plan = planImport({ admissions: [clinicAdm({ cockpit_id: 'p_bed' })] }, [p]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].next.clinicAdmissionId).toBe(7);
    expect(plan.updates[0].changes[0]).toBe('Linked to this clinic admission');
  });
  it('an existing admission link always beats a cockpit_id claim', () => {
    // p_a is already linked to admission 7; a stale cockpit_id pointing at p_b
    // must not steal the match or relink anyone.
    const pa = newPatient({ id: 'p_a', clinicAdmissionId: 7, name: 'Ramon dela Cruz', room: '406' });
    const pb = newPatient({ id: 'p_b', name: 'Someone Else' });
    const plan = planImport({ admissions: [clinicAdm({ cockpit_id: 'p_b' })] }, [pa, pb]);
    expect(plan.updates.map((u) => u.id)).toEqual(['p_a']);
    expect(plan.creates).toHaveLength(0);
  });
  it('skips admissions without an id and never deletes anyone', () => {
    const p = newPatient({ id: 'p_a', clinicAdmissionId: 7, name: 'Ramon dela Cruz' });
    const plan = planImport({ admissions: [clinicAdm({ admission_id: null })] }, [p]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.absent.map((a) => a.id)).toEqual(['p_a']); // flagged only
  });
});
