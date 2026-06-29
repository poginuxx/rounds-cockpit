import { describe, it, expect } from 'vitest';
import {
  SEED_HOSPITALS, UNLISTED_LABEL,
  addHospital, removeHospital, moveHospital, abbrFor, groupPatientsByHospital,
} from './hospitals.js';

describe('SEED_HOSPITALS', () => {
  it('has the 10 real hospitals in route order', () => {
    expect(SEED_HOSPITALS.map((h) => h.abbr)).toEqual(
      ['TMCP', 'MCD', 'DDVMH', 'NGH', 'ACEMC', 'R1MC', 'JKQWMC', 'PPH', 'CPHMC', 'BFDGH'],
    );
    expect(SEED_HOSPITALS[0].name).toBe('The Medical City Pangasinan');
    expect(SEED_HOSPITALS[5].name).toBe('Region 1 Medical Center'); // numeral 1, not Roman I
  });
});

describe('addHospital', () => {
  it('appends a new hospital and trims', () => {
    const out = addHospital([], '  New Hospital  ', '  NH ');
    expect(out).toEqual([{ name: 'New Hospital', abbr: 'NH' }]);
  });
  it('allows an empty abbreviation', () => {
    expect(addHospital([], 'Solo')).toEqual([{ name: 'Solo', abbr: '' }]);
  });
  it('ignores a blank name (returns an unchanged copy)', () => {
    const base = [{ name: 'A', abbr: 'A' }];
    const out = addHospital(base, '   ', 'X');
    expect(out).toEqual(base);
    expect(out).not.toBe(base); // new array, original untouched
  });
});

describe('removeHospital', () => {
  it('removes by index', () => {
    const base = [{ name: 'A', abbr: 'A' }, { name: 'B', abbr: 'B' }, { name: 'C', abbr: 'C' }];
    expect(removeHospital(base, 1).map((h) => h.name)).toEqual(['A', 'C']);
    expect(base.length).toBe(3); // pure
  });
  it('is a no-op for an out-of-range index', () => {
    const base = [{ name: 'A', abbr: 'A' }];
    expect(removeHospital(base, 5)).toEqual(base);
  });
});

describe('moveHospital', () => {
  const base = [{ name: 'A', abbr: 'A' }, { name: 'B', abbr: 'B' }, { name: 'C', abbr: 'C' }];
  it('moves up', () => {
    expect(moveHospital(base, 1, -1).map((h) => h.name)).toEqual(['B', 'A', 'C']);
  });
  it('moves down', () => {
    expect(moveHospital(base, 1, 1).map((h) => h.name)).toEqual(['A', 'C', 'B']);
  });
  it('clamps at the top (first up is a no-op)', () => {
    expect(moveHospital(base, 0, -1)).toEqual(base);
  });
  it('clamps at the bottom (last down is a no-op)', () => {
    expect(moveHospital(base, 2, 1)).toEqual(base);
  });
});

describe('abbrFor', () => {
  const list = [{ name: 'Region 1 Medical Center', abbr: 'R1MC' }, { name: 'No Abbr Hospital', abbr: '' }];
  it('returns the abbreviation for a listed hospital', () => {
    expect(abbrFor(list, 'Region 1 Medical Center')).toBe('R1MC');
  });
  it('falls back to the full name when the abbr is missing', () => {
    expect(abbrFor(list, 'No Abbr Hospital')).toBe('No Abbr Hospital');
  });
  it('falls back to the stored name when the hospital is unlisted', () => {
    expect(abbrFor(list, 'Some Other Place')).toBe('Some Other Place');
  });
});

describe('groupPatientsByHospital', () => {
  const list = [
    { name: 'The Medical City Pangasinan', abbr: 'TMCP' },
    { name: 'Nazareth General Hospital', abbr: 'NGH' },
    { name: 'No Abbr Hospital', abbr: '' },
  ];
  const pts = [
    { id: '1', hospital: 'Nazareth General Hospital' },
    { id: '2', hospital: 'The Medical City Pangasinan' },
    { id: '3', hospital: 'Region I Medical Center' },   // unlisted (old Roman-I string)
    { id: '4', hospital: 'No Abbr Hospital' },
    { id: '5', hospital: 'The Medical City Pangasinan' },
  ];

  it('orders listed groups by the list, with resolved abbreviations', () => {
    const groups = groupPatientsByHospital(list, pts);
    const listed = groups.filter((g) => g.listed);
    expect(listed.map((g) => g.abbr)).toEqual(['TMCP', 'NGH', 'No Abbr Hospital']);
    expect(listed[0].patients.map((p) => p.id)).toEqual(['2', '5']);
  });

  it('sorts unlisted patients into a group LAST and never drops them', () => {
    const groups = groupPatientsByHospital(list, pts);
    expect(groups[groups.length - 1].listed).toBe(false);
    expect(groups[groups.length - 1].name).toBe('Region I Medical Center'); // stored name shown as-is
    // every patient lands in exactly one group — none dropped
    const total = groups.reduce((n, g) => n + g.patients.length, 0);
    expect(total).toBe(pts.length);
  });

  it('labels a blank hospital as the unlisted catch-all', () => {
    const groups = groupPatientsByHospital(list, [{ id: 'x', hospital: '' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe(UNLISTED_LABEL);
    expect(groups[0].patients[0].id).toBe('x');
  });
});
