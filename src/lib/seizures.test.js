import { describe, it, expect } from 'vitest';
import {
  isStatusEpilepticus,
  timeSinceLast,
  count24h,
  summary,
  lastEntry,
  formatDuration,
  formatInterval,
  STATUS_EPILEPTICUS_SEC,
} from './seizures.js';

const H = 3600 * 1000;
// A fixed clock so every interval assertion is exact.
const NOW = Date.parse('2026-06-28T08:00:00.000Z');
const ago = (hours) => new Date(NOW - hours * H).toISOString();
const sz = (over = {}) => ({
  id: 's', onset: ago(36), durationSec: 60, type: 'generalized tonic-clonic',
  features: [], trigger: null, rescueMed: null, rescueResponded: null,
  witnessed: true, note: '', ...over,
});

describe('isStatusEpilepticus threshold (exact at 300s)', () => {
  it('4:59 (299s) is NOT status epilepticus', () => {
    expect(isStatusEpilepticus(sz({ durationSec: 299 }))).toBe(false);
  });
  it('5:00 (300s) IS status epilepticus', () => {
    expect(isStatusEpilepticus(sz({ durationSec: 300 }))).toBe(true);
  });
  it('5:01 (301s) IS status epilepticus', () => {
    expect(isStatusEpilepticus(sz({ durationSec: 301 }))).toBe(true);
  });
  it('the exported threshold is 300', () => {
    expect(STATUS_EPILEPTICUS_SEC).toBe(300);
  });
  it('a missing/garbled duration is not status', () => {
    expect(isStatusEpilepticus({})).toBe(false);
    expect(isStatusEpilepticus(null)).toBe(false);
  });
});

describe('timeSinceLast with a fixed now', () => {
  it('returns exact seconds since the most recent onset', () => {
    expect(timeSinceLast([sz({ onset: ago(36) })], NOW)).toBe(36 * 3600);
  });
  it('uses the most recent entry, not array order', () => {
    const entries = [sz({ onset: ago(2) }), sz({ onset: ago(50) })];
    expect(timeSinceLast(entries, NOW)).toBe(2 * 3600);
  });
  it('an empty log returns null (NOT 0 — opposite meaning)', () => {
    expect(timeSinceLast([], NOW)).toBeNull();
    expect(timeSinceLast(undefined, NOW)).toBeNull();
  });
});

describe('count24h windowing', () => {
  it('counts an onset 23h59m ago, excludes one 24h01m ago', () => {
    const entries = [
      sz({ onset: ago(23 + 59 / 60) }), // inside the window
      sz({ onset: ago(24 + 1 / 60) }),  // just outside
    ];
    expect(count24h(entries, NOW)).toBe(1);
  });
  it('excludes an onset exactly 24h ago (strict boundary)', () => {
    expect(count24h([sz({ onset: ago(24) })], NOW)).toBe(0);
  });
  it('counts multiple recent seizures', () => {
    expect(count24h([sz({ onset: ago(1) }), sz({ onset: ago(5) })], NOW)).toBe(2);
  });
  it('is 0 for an empty log', () => {
    expect(count24h([], NOW)).toBe(0);
  });
});

describe('summary', () => {
  it('an empty log: null interval (not 0), no count, no status', () => {
    const s = summary([], NOW);
    expect(s.freeIntervalSec).toBeNull();
    expect(s.lastOnset).toBeNull();
    expect(s.count24h).toBe(0);
    expect(s.anyStatus).toBe(false);
  });
  it('reports the latest onset, interval, count, and any-status flag', () => {
    const entries = [sz({ onset: ago(40), durationSec: 320 }), sz({ onset: ago(3) })];
    const s = summary(entries, NOW);
    expect(s.lastOnset).toBe(ago(3));
    expect(s.freeIntervalSec).toBe(3 * 3600);
    expect(s.count24h).toBe(1);
    expect(s.anyStatus).toBe(true); // the 320s event
  });
});

describe('lastEntry', () => {
  it('returns the most recent entry object, or null when empty', () => {
    const recent = sz({ onset: ago(1), note: 'recent' });
    expect(lastEntry([sz({ onset: ago(20) }), recent]).note).toBe('recent');
    expect(lastEntry([])).toBeNull();
  });
});

describe('formatters', () => {
  it('formatDuration: seconds under a minute, m:ss at/above', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(300)).toBe('5:00');
    expect(formatDuration(null)).toBe('—');
  });
  it('formatInterval: hours under a day, days beyond; null stays null', () => {
    expect(formatInterval(36 * 3600)).toBe('36h');
    expect(formatInterval(23 * 3600)).toBe('23h');
    expect(formatInterval(3 * 24 * 3600)).toBe('3d');
    expect(formatInterval(null)).toBeNull();
  });
});
