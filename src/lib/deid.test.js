import { describe, it, expect } from 'vitest';
import { deidentify } from './deid.js';

const roster = [
  { id: 'p_ramon', name: 'Ramon dela Cruz' },
  { id: 'p_aurora', name: 'Aurora Mendoza' },
  { id: 'p_efren', name: 'Efren Villaraza' },
];

describe('deidentify', () => {
  it('tokenizes known names and builds a re-identify map', () => {
    const { redacted, map } = deidentify('Ramon dela Cruz Na 126; Aurora Mendoza ok', roster);
    expect(redacted).toContain('[PT1]');
    expect(redacted).toContain('[PT2]');
    expect(redacted).not.toMatch(/Ramon|Aurora/);
    expect(map['[PT1]']).toBe('p_ramon');
    expect(map['[PT2]']).toBe('p_aurora');
  });

  it('matches on last name alone', () => {
    const { redacted, map } = deidentify('Villaraza RR up to 26', roster);
    expect(redacted).toBe('[PT1] RR up to 26');
    expect(map['[PT1]']).toBe('p_efren');
  });

  it('redacts rooms and long ID numbers', () => {
    const { redacted } = deidentify('rm 408, MRN 1002554 Na 128', roster);
    expect(redacted).toContain('[ROOM]');
    expect(redacted).toContain('[ID]');
    expect(redacted).not.toContain('408');
    expect(redacted).not.toContain('1002554');
  });

  it('leaves text without roster names untouched (no false tokenizing)', () => {
    const { redacted, removed } = deidentify('patient stable overnight', roster);
    expect(removed).toHaveLength(0);
    expect(redacted).toBe('patient stable overnight');
  });
});
