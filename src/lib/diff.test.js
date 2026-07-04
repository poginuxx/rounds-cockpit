import { describe, it, expect } from 'vitest';
import { computeTriage, diffSnapshots, commitPatient, applyChange, upsertSnapshot, snapshotOf, buildTimeline, neuroStatus } from './diff.js';
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

describe('applyChange — na label building (bedside direct edits, no prior range)', () => {
  it('anchors a single date on the first-ever reading', () => {
    const p = newPatient({ na: [], naLabel: '', scores: [] });
    applyChange(p, { field: 'na', new: 140, date: '07/01' });
    expect(p.naLabel).toBe('07/01');
  });
  it('turns the anchor into a range on the second reading', () => {
    const p = newPatient({ na: [140], naLabel: '07/01', scores: [] });
    applyChange(p, { field: 'na', new: 138, date: '07/02' });
    expect(p.naLabel).toBe('07/01 → 07/02');
  });
  it('moves only the end date on subsequent readings', () => {
    const p = newPatient({ na: [140, 138], naLabel: '07/01 → 07/02', scores: [] });
    applyChange(p, { field: 'na', new: 136, date: '07/03' });
    expect(p.naLabel).toBe('07/01 → 07/03');
  });
});

describe('applyChange — potassium and osmolality', () => {
  it('sets K value and keeps the existing note when none is given', () => {
    const p = newPatient({ k: { v: '4.0', s: 'baseline' } });
    applyChange(p, { field: 'k', new: '3.2' });
    expect(p.k).toEqual({ v: '3.2', s: 'baseline' });
  });
  it('overwrites the K note when one is given', () => {
    const p = newPatient({ k: { v: '4.0', s: 'baseline' } });
    applyChange(p, { field: 'k', new: '3.2', note: 'hemolyzed, repeat' });
    expect(p.k).toEqual({ v: '3.2', s: 'hemolyzed, repeat' });
  });
  it('sets serum osmolality the same way', () => {
    const p = newPatient({ osmo: { v: '—', s: 'not drawn today' } });
    applyChange(p, { field: 'osmo', new: '268', note: 'low · ?SIADH' });
    expect(p.osmo).toEqual({ v: '268', s: 'low · ?SIADH' });
  });
});

describe('upsertSnapshot', () => {
  it('appends a new row when no snapshot exists for that date', () => {
    const p = newPatient({ na: [136], snapshots: [{ date: '06/16', na: 134 }] });
    upsertSnapshot(p, '06/17');
    expect(p.snapshots).toHaveLength(2);
    expect(p.snapshots[1]).toMatchObject({ date: '06/17', na: 136 });
  });
  it('overwrites the last row in place when it is already dated today', () => {
    const p = newPatient({ na: [136], snapshots: [{ date: '06/17', na: 999 }] });
    upsertSnapshot(p, '06/17');
    expect(p.snapshots).toHaveLength(1);
    expect(p.snapshots[0]).toMatchObject({ date: '06/17', na: 136 });
  });
  it('keeps commitPatient from duplicating a same-day row on a second commit', () => {
    const p = newPatient({ na: [136], naLabel: '06/16', scores: [{ l: 'NA', v: '136', a: '' }], snapshots: [] });
    commitPatient(p, [{ field: 'na', new: 134, apply: true, label: 'Sodium' }], '06/17');
    commitPatient(p, [{ field: 'na', new: 130, apply: true, label: 'Sodium' }], '06/17');
    expect(p.snapshots).toHaveLength(1);
    expect(p.snapshots[0]).toMatchObject({ date: '06/17', na: 130 });
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

  it('captures gcs and nihss from scores[] when present', () => {
    const p = newPatient({ na: [137], scores: [{ l: 'GCS', v: '13' }, { l: 'NIHSS', v: '8' }] });
    const snap = snapshotOf(p, '06/17');
    expect(snap.gcs).toBe(13);
    expect(snap.nihss).toBe(8);
  });

  it('omits neuro keys entirely for a patient without those scores', () => {
    const p = newPatient({ na: [137], scores: [{ l: 'NA', v: '137' }] });
    const snap = snapshotOf(p, '06/17');
    expect('gcs' in snap).toBe(false);
    expect('nihss' in snap).toBe(false);
  });
});

describe('neuroStatus', () => {
  it('flags BOTH a falling GCS and a rising NIHSS as worsening', () => {
    expect(neuroStatus([14, 13, 12], 'down')).toBe('bad'); // GCS dropping
    expect(neuroStatus([4, 6, 8], 'up')).toBe('bad');      // NIHSS climbing
  });

  it('does not colour the opposite direction as worsening', () => {
    expect(neuroStatus([12, 14], 'down')).toBe('good');    // GCS rising = improving
    expect(neuroStatus([8, 4], 'up')).toBe('good');        // NIHSS falling = improving
  });

  it('grades severity: 1-step move is a warn, 2+ is bad', () => {
    expect(neuroStatus([15, 14], 'down')).toBe('warn');
    expect(neuroStatus([15, 13], 'down')).toBe('bad');
    expect(neuroStatus([15, 15, 15], 'down')).toBe('good');
  });

  it('is safe with too little data', () => {
    expect(neuroStatus([15], 'down')).toBe('good');
    expect(neuroStatus([], 'up')).toBe('good');
  });
});
