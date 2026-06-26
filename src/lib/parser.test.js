import { describe, it, expect } from 'vitest';
import { heuristicParse } from './parser.js';

describe('heuristicParse', () => {
  it('extracts sodium even with words between "Na" and the value', () => {
    const [o] = heuristicParse('[PT1] repeat Na came back 126, severe headache. BP 150/88, HR 80.');
    expect(o.na).toBe(126);
    expect(o.bp).toBe('150/88');
    expect(o.hr).toBe('80');
  });

  it('REGRESSION: never reads "na" inside a word like "finally" as sodium', () => {
    const [o] = heuristicParse('[PT2] moved bowels this morning, finally. BP 150/86.');
    expect(o.na).toBeNull();          // must NOT be 150
    expect(o.bm).toBe('yes');
    expect(o.bp).toBe('150/86');
  });

  it('captures RR and SpO2 with loose spacing', () => {
    const [o] = heuristicParse('[PT3] RR up to 26, sats 94%. Flagging.');
    expect(o.rr).toBe('26');
    expect(o.spo2).toBe('94%');
  });

  it('reads headache direction in either word order', () => {
    expect(heuristicParse('[PT1] still severe headache')[0].headache).toBe('worse');
    expect(heuristicParse('[PT4] headache improving')[0].headache).toBe('better');
  });

  it('splits a multi-patient update into one object per token', () => {
    const out = heuristicParse('[PT1] Na 130. [PT2] seizure-free. [PT3] ready for discharge.');
    expect(out).toHaveLength(3);
    expect(out[0].na).toBe(130);
    expect(out[1].seizure).toBe(false);
    expect(out[2].ready).toBe(true);
  });
});
