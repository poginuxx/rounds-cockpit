import { describe, it, expect } from 'vitest';
import { newPatient, seedPatients } from './schema.js';

describe('newPatient', () => {
  it('starts with an empty snapshots array', () => {
    expect(newPatient().snapshots).toEqual([]);
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
