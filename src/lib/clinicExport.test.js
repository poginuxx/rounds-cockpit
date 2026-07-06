import { describe, it, expect } from 'vitest';
import { buildClinicExport, buildDischargeNotes, clinicExportText } from './clinicExport.js';
import { newPatient, seedPatients } from './schema.js';

const TODAY = '2026-07-06';

describe('buildClinicExport — field mapping for the clinic import box', () => {
  it('maps name and sex (M/F → Male/Female) and leaves dob/phone/address blank', () => {
    const p = newPatient({ name: 'Ramon dela Cruz', sex: 'M' });
    const out = buildClinicExport(p, TODAY);
    expect(out.full_name).toBe('Ramon dela Cruz');
    expect(out.sex).toBe('Male');
    expect(out.dob).toBe('');
    expect(out.phone).toBe('');
    expect(out.address).toBe('');

    expect(buildClinicExport(newPatient({ sex: 'F' }), TODAY).sex).toBe('Female');
  });

  it('omits sex entirely when it is not M/F (never sends a value the clinic select rejects)', () => {
    const p = newPatient({ name: 'X', sex: '' });
    expect('sex' in buildClinicExport(p, TODAY)).toBe(false);
  });

  it('never fabricates a date of birth when none was entered', () => {
    const p = newPatient({ name: 'X', age: '54' });
    expect(buildClinicExport(p, TODAY).dob).toBe('');
  });

  it('passes a physician-entered birthdate through as-is (ISO, ready for the clinic date input)', () => {
    const p = newPatient({ name: 'X', dob: '1954-03-10' });
    expect(buildClinicExport(p, TODAY).dob).toBe('1954-03-10');
  });

  it('produces valid JSON text with exactly the keys the clinic import reads', () => {
    const out = JSON.parse(clinicExportText(seedPatients()[0], TODAY));
    const allowed = ['full_name', 'dob', 'phone', 'address', 'sex', 'medical_notes'];
    Object.keys(out).forEach((k) => expect(allowed).toContain(k));
    expect(out.full_name).toBe('Ramon dela Cruz');
  });
});

describe('buildDischargeNotes — readable summary, no placeholders leak', () => {
  it('includes dx, detail, admission, meds, scores, vitals, na trend, chemistry, custom labs, and plan for a rich record', () => {
    const notes = buildDischargeNotes(seedPatients()[0], TODAY); // Ramon
    expect(notes).toContain('exported from Rounds Cockpit on 2026-07-06');
    expect(notes).toContain('Diagnosis: Aneurysmal SAH (Hunt-Hess 3)');
    expect(notes).toContain('Age 54, Male');
    expect(notes).toContain('Region 1 Medical Center · Room 408 · hospital day 5 at discharge');
    expect(notes).toContain('- Nimodipine 60mg q4h');
    expect(notes).toContain('GCS 13');
    expect(notes).toContain('BP 148/86');
    expect(notes).toContain('Sodium trend (06/12 → 06/16): 136 → 134 → 132 → 130 → 128 mmol/L');
    expect(notes).toContain('K 3.9');
    expect(notes).toContain('Creatinine trend (2026-06-12 → 2026-06-16): 0.9 → 1 → 1.1 → 1.3 → 1.2 mg/dL');
    expect(notes).toContain('Last inpatient plan: Repeat Na in 6h');
  });

  it('summarizes the seizure log with count and last event type', () => {
    const lourdes = seedPatients().find((p) => p.id === 'p_lourdes');
    const notes = buildDischargeNotes(lourdes, TODAY);
    expect(notes).toContain('Seizure log: 2 recorded event(s)');
    expect(notes).toContain('generalized tonic-clonic');
  });

  it('degrades gracefully for a bare new patient — no undefined, no lone dashes', () => {
    const notes = buildDischargeNotes(newPatient({ name: 'Juan Santos' }), TODAY);
    expect(notes).not.toContain('undefined');
    expect(notes).not.toMatch(/—\s*$/m);
    expect(notes).not.toContain('Sodium trend');
    expect(notes).not.toContain('Medications');
    // K/osmo default to the '—' placeholder → chemistry line must be absent
    expect(notes).not.toContain('Latest chemistry');
  });

  it("skips '—' vitals so an unmeasured chip never reaches the note", () => {
    const p = newPatient({ name: 'X', vitals: [['BP', '—'], ['HR', '72']] });
    const notes = buildDischargeNotes(p, TODAY);
    expect(notes).toContain('HR 72');
    expect(notes).not.toContain('BP');
  });
});
