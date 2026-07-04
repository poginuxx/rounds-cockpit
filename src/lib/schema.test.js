import { describe, it, expect } from 'vitest';
import { newPatient, seedPatients } from './schema.js';
import { summary } from './seizures.js';

describe('newPatient', () => {
  it('starts with an empty snapshots array', () => {
    expect(newPatient().snapshots).toEqual([]);
  });
  it('starts with an empty seizures array', () => {
    expect(newPatient().seizures).toEqual([]);
  });
  it('does not track a sodium trend by default — opt-in per patient', () => {
    expect(newPatient().trackNa).toBe(false);
  });
  it('starts with no custom labs', () => {
    expect(newPatient().customLabs).toEqual([]);
  });
});

describe('seedPatients lab trends', () => {
  const seeds = seedPatients();
  const byId = Object.fromEntries(seeds.map((p) => [p.id, p]));

  it('only tracks sodium by default for the two patients where Na is the actual concern', () => {
    expect(byId.p_ramon.trackNa).toBe(true);
    expect(byId.p_aurora.trackNa).toBe(true);
    expect(byId.p_lourdes.trackNa).toBe(false);
    expect(byId.p_efren.trackNa).toBe(false);
    expect(byId.p_carmela.trackNa).toBe(false);
  });

  it('gives the illustrative creatinine trend a normal band and a multi-point series', () => {
    const cr = byId.p_ramon.customLabs.find((l) => l.label === 'Creatinine');
    expect(cr).toBeTruthy();
    expect(cr.band).toEqual([0.6, 1.2]);
    expect(cr.series.length).toBeGreaterThanOrEqual(2);
  });
});

describe('seedPatients seizure log', () => {
  const seeds = seedPatients();
  const lourdes = seeds.find((p) => p.id === 'p_lourdes');

  it('only the breakthrough-GTC patient carries seeded seizures', () => {
    for (const p of seeds) {
      expect(Array.isArray(p.seizures)).toBe(true);
      if (p.id !== 'p_lourdes') expect(p.seizures).toEqual([]);
    }
    expect(lourdes.seizures.length).toBe(2);
  });

  it('uses real ISO datetimes (not the app fake date strings)', () => {
    for (const e of lourdes.seizures) {
      expect(Number.isNaN(Date.parse(e.onset))).toBe(false);
      expect(e.onset).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO, not '06/17'
    }
  });

  it('the most recent seed seizure is ~36h ago so the summary reads in hours', () => {
    const s = summary(lourdes.seizures, Date.now());
    const hours = s.freeIntervalSec / 3600;
    expect(hours).toBeGreaterThan(35);
    expect(hours).toBeLessThan(37);
  });

  it('does not auto-fill optional clinical fields (trigger absent stays null)', () => {
    const focal = lourdes.seizures.find((e) => e.type === 'focal impaired awareness');
    expect(focal.trigger).toBeNull();
    expect(focal.witnessed).toBe(false); // reported, not witnessed
    expect(focal.rescueMed).toBeNull();
  });
});

describe('seedPatients snapshot backfill', () => {
  const seeds = seedPatients();

  it('gives each seeded patient a multi-day snapshot trail', () => {
    for (const p of seeds) {
      expect(p.snapshots.length).toBe(p.na.length);
      expect(p.snapshots.length).toBeGreaterThan(1);
    }
  });

  it('keeps the unchanged snapshot shape and the real sodium series', () => {
    const ramon = seeds.find((p) => p.id === 'p_ramon');
    expect(ramon.snapshots.map((s) => s.na)).toEqual(ramon.na); // real values, not invented
    for (const s of ramon.snapshots) {
      expect(s).toHaveProperty('date');
      expect(s).toHaveProperty('na');
      expect(typeof s.date).toBe('string');
    }
  });

  it('orders snapshots chronologically, ending on the naLabel latest date', () => {
    const ramon = seeds.find((p) => p.id === 'p_ramon'); // naLabel '06/12 → 06/16'
    const dates = ramon.snapshots.map((s) => s.date);
    expect(dates[0]).toBe('06/12');
    expect(dates[dates.length - 1]).toBe('06/16');
    expect([...dates].sort()).toEqual(dates); // ascending MM/DD
  });

  it('lets the newest day inherit vitals captured in the seed', () => {
    const efren = seeds.find((p) => p.id === 'p_efren'); // seed snapshot had rr:22, spo2:96
    const last = efren.snapshots[efren.snapshots.length - 1];
    expect(last).toMatchObject({ rr: 22, spo2: 96 });
    expect(efren.snapshots[0].rr).toBeUndefined(); // history has no fabricated vitals
  });
});

describe('newPatient motorExams', () => {
  it('starts with an empty motorExams array', () => {
    expect(newPatient().motorExams).toEqual([]);
  });
});

describe('seeded motor exams (MCA infarct → contralateral weakness)', () => {
  const aurora = seedPatients().find((p) => p.id === 'p_aurora'); // L MCA infarct

  it('carries two dated exams, oldest first', () => {
    expect(aurora.motorExams).toHaveLength(2);
    expect(aurora.motorExams.map((e) => e.date)).toEqual(['06/15', '06/16']);
  });

  it('stores grades as strings so 4-/4/4+ are representable', () => {
    for (const exam of aurora.motorExams) {
      for (const v of Object.values(exam.cells)) expect(typeof v).toBe('string');
    }
    expect(aurora.motorExams[0].cells['LL.kneeExt.R']).toBe('4-');
  });

  it('keeps the left side normal and the right side weak (real laterality)', () => {
    const cur = aurora.motorExams[1].cells;
    expect(cur['UL.shoulderAbd.L']).toBe('5');     // unaffected side
    expect(cur['UL.shoulderAbd.R']).toBe('4-');    // contralateral weakness
  });

  it('leaves a genuinely untested cell ABSENT — never auto-filled to 5/5', () => {
    for (const exam of aurora.motorExams) {
      expect(exam.cells['LL.ankleDorsi.R']).toBeUndefined();
    }
  });
});
