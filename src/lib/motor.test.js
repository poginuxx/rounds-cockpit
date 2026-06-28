import { describe, it, expect } from 'vitest';
import {
  MUSCLE_GROUPS, SIDES, GRADES, gradeRank, motorDelta, cellKey,
} from './motor.js';

describe('gradeRank ordering', () => {
  it('orders 0 < 1 < 2 < 3 < 4- < 4 < 4+ < 5', () => {
    const ranks = GRADES.map(gradeRank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it('compares the 4 subdivisions correctly: 4+ > 4 > 4-', () => {
    expect(gradeRank('4+')).toBeGreaterThan(gradeRank('4'));
    expect(gradeRank('4')).toBeGreaterThan(gradeRank('4-'));
  });

  it('returns null for not-tested / missing / unrecognised grades', () => {
    expect(gradeRank('not tested')).toBeNull();
    expect(gradeRank(undefined)).toBeNull();
    expect(gradeRank(null)).toBeNull();
    expect(gradeRank('9')).toBeNull();
  });
});

describe('motorDelta direction', () => {
  const ex = (cells) => ({ date: 'x', cells });

  it('flags a DROP in power as worse', () => {
    const d = motorDelta(ex({ 'UL.elbowFlex.R': '4' }), ex({ 'UL.elbowFlex.R': '3' }));
    expect(d['UL.elbowFlex.R']).toEqual({ from: '4', to: '3', direction: 'worse' });
  });

  it('flags a RISE in power as better', () => {
    const d = motorDelta(ex({ 'UL.elbowFlex.R': '3' }), ex({ 'UL.elbowFlex.R': '4' }));
    expect(d['UL.elbowFlex.R'].direction).toBe('better');
  });

  it('flags no change as same', () => {
    const d = motorDelta(ex({ 'UL.elbowFlex.R': '4' }), ex({ 'UL.elbowFlex.R': '4' }));
    expect(d['UL.elbowFlex.R'].direction).toBe('same');
  });

  it('resolves the 4 subdivisions: 4- → 4 is better, 4 → 4- is worse', () => {
    expect(motorDelta(ex({ k: '4-' }), ex({ k: '4' })).k.direction).toBe('better');
    expect(motorDelta(ex({ k: '4' }), ex({ k: '4-' })).k.direction).toBe('worse');
  });

  it('never produces a delta when a cell is not tested in either exam', () => {
    // not tested now (absent in current) → no entry
    expect(motorDelta(ex({ k: '5' }), ex({})).k).toBeUndefined();
    // not tested before (absent in previous) → no entry, no fabricated baseline
    expect(motorDelta(ex({}), ex({ k: '5' })).k).toBeUndefined();
    // explicit 'not tested' string is treated as absent, not a value
    expect(motorDelta(ex({ k: '5' }), ex({ k: 'not tested' })).k).toBeUndefined();
  });

  it('tolerates a null / undefined previous exam (first ever exam)', () => {
    expect(motorDelta(null, ex({ k: '5' }))).toEqual({});
    expect(motorDelta(undefined, ex({ k: '5' }))).toEqual({});
  });
});

describe('muscle-group set', () => {
  it('has 5 upper-limb and 5 lower-limb groups', () => {
    expect(MUSCLE_GROUPS.filter((g) => g.region === 'UL')).toHaveLength(5);
    expect(MUSCLE_GROUPS.filter((g) => g.region === 'LL')).toHaveLength(5);
  });

  it('builds independent left/right keys per group', () => {
    const g = MUSCLE_GROUPS[0];
    expect(cellKey(g, 'L')).not.toBe(cellKey(g, 'R'));
    expect(SIDES).toEqual(['L', 'R']);
  });
});
