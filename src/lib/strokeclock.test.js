import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STROKE_WINDOWS,
  defaultWindows,
  elapsedMs,
  windowStatus,
  anyWindowOpen,
  formatHMS,
} from './strokeclock.js';

const MIN = 60 * 1000;
const H = 60 * MIN;
// A fixed clock so every elapsed/window assertion is exact.
const NOW = Date.parse('2026-06-28T12:00:00.000Z');
// last-known-well `min` minutes before NOW.
const lkwAgo = (min) => new Date(NOW - min * MIN).toISOString();

const clock = (over = {}) => ({
  lastKnownWell: lkwAgo(300),       // 5 h ago by default
  onsetDiscovered: null,
  type: 'ischemic',
  windows: defaultWindows(),
  ...over,
});

describe('default window config', () => {
  it('seeds 4.5 h / 6 h / 24 h as exact minutes', () => {
    const byId = Object.fromEntries(DEFAULT_STROKE_WINDOWS.map((w) => [w.id, w]));
    expect(byId.iv.minutes).toBe(270);    // 4.5 h
    expect(byId.mt.minutes).toBe(360);    // 6 h
    expect(byId.mt24.minutes).toBe(1440); // 24 h
  });
  it('labels the extended window as selected-patient / not automatic', () => {
    const ext = DEFAULT_STROKE_WINDOWS.find((w) => w.id === 'mt24');
    expect(ext.kind).toBe('extended');
    expect(ext.note).toMatch(/NOT automatic|selected/i);
  });
  it('defaultWindows() returns an independent copy (editable config, not shared)', () => {
    const a = defaultWindows();
    a[0].minutes = 999;
    expect(DEFAULT_STROKE_WINDOWS[0].minutes).toBe(270);
    expect(defaultWindows()[0].minutes).toBe(270);
  });
});

describe('elapsedMs', () => {
  it('computes elapsed from a fixed now', () => {
    expect(elapsedMs(clock({ lastKnownWell: lkwAgo(300) }), NOW)).toBe(300 * MIN);
  });
  it('returns null (never 0 or a guess) when last known well is unset', () => {
    expect(elapsedMs(clock({ lastKnownWell: null }), NOW)).toBeNull();
    expect(elapsedMs(clock({ lastKnownWell: '' }), NOW)).toBeNull();
    expect(elapsedMs(null, NOW)).toBeNull();
  });
  it('returns null for an unparseable anchor', () => {
    expect(elapsedMs(clock({ lastKnownWell: 'not-a-date' }), NOW)).toBeNull();
  });
  it('clamps a future-dated anchor to 0 rather than going negative', () => {
    expect(elapsedMs(clock({ lastKnownWell: new Date(NOW + H).toISOString() }), NOW)).toBe(0);
  });
  it('ignores onsetDiscovered entirely — anchor is last known well only', () => {
    const c = clock({ lastKnownWell: lkwAgo(300), onsetDiscovered: lkwAgo(30) });
    expect(elapsedMs(c, NOW)).toBe(300 * MIN); // 5 h, NOT 30 min from discovery
  });
});

describe('windowStatus — 4.5 h IV boundary is exact', () => {
  const iv = (c) => windowStatus(c, NOW).find((w) => w.id === 'iv');
  it('at exactly 270 min (4:30:00) the IV window IS passed', () => {
    expect(iv(clock({ lastKnownWell: lkwAgo(270) })).passed).toBe(true);
  });
  it('at 269 min 59 s the IV window is NOT passed', () => {
    const c = clock({ lastKnownWell: new Date(NOW - (270 * MIN - 1000)).toISOString() });
    const w = iv(c);
    expect(w.passed).toBe(false);
    expect(w.remainingMs).toBe(1000); // exactly 1 s left
  });
  it('one second past 270 min the IV window is passed with 0 remaining', () => {
    const c = clock({ lastKnownWell: new Date(NOW - (270 * MIN + 1000)).toISOString() });
    const w = iv(c);
    expect(w.passed).toBe(true);
    expect(w.remainingMs).toBe(0);
  });
});

describe('windowStatus — type gating (windows ONLY for confirmed ischemic)', () => {
  it('returns [] for hemorrhagic (thrombolysis contraindicated)', () => {
    expect(windowStatus(clock({ type: 'hemorrhagic' }), NOW)).toEqual([]);
  });
  it('returns [] for undetermined (pending type confirmation)', () => {
    expect(windowStatus(clock({ type: 'undetermined' }), NOW)).toEqual([]);
  });
  it('returns windows for ischemic', () => {
    expect(windowStatus(clock({ type: 'ischemic' }), NOW).length).toBe(3);
  });
  it('returns [] for ischemic with an unset anchor (no guessed clock)', () => {
    expect(windowStatus(clock({ lastKnownWell: null }), NOW)).toEqual([]);
  });
});

describe('windowStatus — remaining vs passed at 5 h elapsed (the seed mix)', () => {
  const byId = Object.fromEntries(windowStatus(clock({ lastKnownWell: lkwAgo(300) }), NOW).map((w) => [w.id, w]));
  it('IV (4.5 h) is passed', () => {
    expect(byId.iv.passed).toBe(true);
    expect(byId.iv.remainingMs).toBe(0);
  });
  it('MT (6 h) is still open with ~1 h remaining', () => {
    expect(byId.mt.passed).toBe(false);
    expect(byId.mt.remainingMs).toBe(60 * MIN); // 6h - 5h = 1h
  });
  it('MT-24h is still open with ~19 h remaining', () => {
    expect(byId.mt24.passed).toBe(false);
    expect(byId.mt24.remainingMs).toBe(19 * H); // 24h - 5h
  });
});

describe('anyWindowOpen', () => {
  it('true while any ischemic window is open', () => {
    expect(anyWindowOpen(clock({ lastKnownWell: lkwAgo(300) }), NOW)).toBe(true);
  });
  it('false once every window has passed', () => {
    expect(anyWindowOpen(clock({ lastKnownWell: lkwAgo(24 * 60) }), NOW)).toBe(false);
  });
  it('false for hemorrhagic / undetermined (no windows at all)', () => {
    expect(anyWindowOpen(clock({ type: 'hemorrhagic', lastKnownWell: lkwAgo(10) }), NOW)).toBe(false);
    expect(anyWindowOpen(clock({ type: 'undetermined', lastKnownWell: lkwAgo(10) }), NOW)).toBe(false);
  });
});

describe('formatHMS', () => {
  it('formats hours:minutes:seconds zero-padded', () => {
    expect(formatHMS(5 * H)).toBe('05:00:00');
    expect(formatHMS(270 * MIN)).toBe('04:30:00');
    expect(formatHMS(1000)).toBe('00:00:01');
    expect(formatHMS(0)).toBe('00:00:00');
  });
  it('clamps negatives to zero', () => {
    expect(formatHMS(-5000)).toBe('00:00:00');
  });
  it('handles null / NaN as an em dash', () => {
    expect(formatHMS(null)).toBe('—');
    expect(formatHMS(NaN)).toBe('—');
  });
});
