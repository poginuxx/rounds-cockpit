import { describe, it, expect } from 'vitest';
import { computeTriage, diffSnapshots, commitPatient, snapshotOf, buildTimeline } from './diff.js';
import { newPatient } from './schema.js';

describe('computeTriage', () => {
  it('flags red for critical hyponatremia', () => {
    expect(computeTriage(newPatient({ na: [134, 126] }))).toBe('r');
  });
  it('flags red for a fast sodium drop even if still in range-ish', () => {
    expect(computeTriage(newPatient({ na: [140, 134] }))).toBe('r'); // drop of 6
  });
  it('flags red for respiratory compromise', () => {
    expect(computeTriage(newPatient({ vitals: [['RR', '26'], ['SPO₂', '93%']] }))).toBe('r');
  });
  it('flags amber for mild hyponatremia', () => {
    expect(computeTriage(newPatient({ na: [136, 133] }))).toBe('a');
  });
  it('stays green when stable', () => {
    expect(computeTriage(newPatient({ na: [139, 140], vitals: [['RR', '16'], ['SPO₂', '99%']] }))).toBe('g');
  });
});

describe('diffSnapshots', () => {
  it('reports sodium movement with direction', () => {
    const d = diffSnapshots({ na: 134 }, { na: 128 });
    expect(d[0]).toMatchObject({ field: 'Na', from: 134, to: 128, delta: -6 });
  });
  it('returns nothing when there is no prior snapshot', () => {
    expect(diffSnapshots(null, { na: 128 })).toEqual([]);
  });
});

describe('commitPatient', () => {
  it('applies confirmed changes, recomputes triage, and pushes a snapshot', () => {
    const p = newPatient({
      name: 'Test', na: [136, 134], naLabel: '06/15 → 06/16',
      scores: [{ l: 'NA', v: '134', a: '' }], vitals: [['RR', '18']],
      snapshots: [{ date: '06/16', na: 134 }],
    });
    const changes = [
      { field: 'na', label: 'Sodium', new: 126, cls: 'bad', apply: true },
      { field: 'rr', label: 'RR', new: '26', cls: 'warn', apply: false }, // unchecked
    ];
    commitPatient(p, changes, '06/17');
    expect(p.na).toEqual([136, 134, 126]);
    expect(p.triage).toBe('r');                 // from new sodium
    expect(p.scores[0].v).toBe('126');
    expect(p.vitals.find((v) => v[0] === 'RR')[1]).toBe('18'); // unchecked change not applied
    expect(p.snapshots).toHaveLength(2);
    expect(p.snapshots[1]).toMatchObject({ date: '06/17', na: 126 });
    expect(p.overnight.k).toBe('Na 126');
  });

  it('is a no-op when nothing is confirmed', () => {
    const p = newPatient({ na: [140] });
    const before = JSON.stringify(p);
    commitPatient(p, [{ field: 'na', new: 120, apply: false }]);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('buildTimeline', () => {
  it('returns rows newest-first with per-day changes from diffSnapshots', () => {
    const p = newPatient({ snapshots: [
      { date: '06/14', na: 136 },
      { date: '06/15', na: 134 },
      { date: '06/16', na: 128 },
    ] });
    const tl = buildTimeline(p);
    expect(tl.map((r) => r.snapshot.date)).toEqual(['06/16', '06/15', '06/14']);
    expect(tl[0].changes).toEqual(diffSnapshots({ na: 134 }, { na: 128 }));
    expect(tl[0].changes[0]).toMatchObject({ field: 'Na', from: 134, to: 128, delta: -6 });
  });
  it('marks the oldest snapshot as the baseline with no changes', () => {
    const p = newPatient({ snapshots: [{ date: '06/15', na: 138 }, { date: '06/16', na: 137 }] });
    const tl = buildTimeline(p);
    expect(tl[1]).toMatchObject({ baseline: true });
    expect(tl[1].changes).toEqual([]);
    expect(tl[0].baseline).toBe(false);
  });
  it('handles a single snapshot and an empty history', () => {
    expect(buildTimeline(newPatient({ snapshots: [{ date: '06/16', na: 140 }] }))).toHaveLength(1);
    expect(buildTimeline(newPatient({}))).toEqual([]);
  });
});

describe('snapshotOf', () => {
  it('captures the latest salient values', () => {
    const p = newPatient({ na: [140, 137], vitals: [['RR', '22'], ['SPO₂', '96%'], ['TEMP', '37.0']] });
    expect(snapshotOf(p, '06/17')).toEqual({ date: '06/17', na: 137, rr: 22, spo2: 96, temp: 37 });
  });
});
