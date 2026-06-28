/**
 * seizures.js — pure logic for the seizure log (neuro module #3).
 *
 * MANUAL ENTRY ONLY (by design). This module computes derived numbers from a
 * hand-recorded, APPEND-ONLY seizures[] history. Nothing here — and nothing that
 * calls it — may append to the log on behalf of an automated source: not the
 * intake parser's `seizure` field, not the bedside "Any seizures?" Ask toggle.
 * The physician writes every entry through the Record-seizure form. Keeping this
 * decoupled is a safety property, not an accident; do not wire automated appends.
 *
 * Entry shape (defined in schema.js):
 *   { id, onset (ISO datetime string), durationSec, type, features:[], trigger,
 *     rescueMed, rescueResponded (bool|null), witnessed (bool), note }
 *
 * Pure — no DOM, no storage. `now` (epoch ms) is injectable so intervals are
 * testable against a fixed clock.
 */

/** The seizure-type vocabulary, as data so the form is data-driven. */
export const SEIZURE_TYPES = [
  'focal aware',
  'focal impaired awareness',
  'focal to bilateral tonic-clonic',
  'generalized tonic-clonic',
  'absence',
  'myoclonic',
  'tonic',
  'atonic',
  'unknown',
];

/** Optional semiology features (multi-select). */
export const FEATURES = [
  'aura',
  'automatisms',
  'eye deviation',
  'incontinence',
  'tongue bite',
  'post-ictal confusion',
  "Todd's paresis",
];

/** Optional likely-trigger choices (single-select). */
export const TRIGGERS = [
  'missed meds',
  'sleep deprivation',
  'fever',
  'alcohol',
  'none/unknown',
];

/**
 * Status epilepticus: a single seizure lasting >= 5 minutes. The threshold is
 * EXACT — 4:59 (299s) is NOT status, 5:00 (300s) IS.
 */
export const STATUS_EPILEPTICUS_SEC = 300;

export function isStatusEpilepticus(entry) {
  return (
    !!entry &&
    typeof entry.durationSec === 'number' &&
    entry.durationSec >= STATUS_EPILEPTICUS_SEC
  );
}

/** Onset (epoch ms) of the most recent entry, or null when the log is empty. */
function lastOnsetMs(entries) {
  let max = null;
  for (const e of entries || []) {
    const t = Date.parse(e && e.onset);
    if (!Number.isNaN(t) && (max == null || t > max)) max = t;
  }
  return max;
}

/** The most recent entry by onset, or null when none recorded. */
export function lastEntry(entries) {
  const ms = lastOnsetMs(entries);
  if (ms == null) return null;
  return (entries || []).find((e) => Date.parse(e && e.onset) === ms) || null;
}

/**
 * Seconds since the most recent seizure, or null when none recorded.
 * null and 0 mean OPPOSITE things — an empty log is "no seizures recorded",
 * which a caller must render differently from "0h seizure-free".
 */
export function timeSinceLast(entries, now = Date.now()) {
  const ms = lastOnsetMs(entries);
  if (ms == null) return null;
  return Math.max(0, Math.floor((now - ms) / 1000));
}

/** Count of seizures whose onset falls within the last 24h of `now`. */
export function count24h(entries, now = Date.now()) {
  const cutoff = now - 24 * 3600 * 1000;
  let n = 0;
  for (const e of entries || []) {
    const t = Date.parse(e && e.onset);
    if (!Number.isNaN(t) && t > cutoff && t <= now) n++;
  }
  return n;
}

/** Glanceable summary for the collapsed block header. */
export function summary(entries, now = Date.now()) {
  const last = lastEntry(entries);
  return {
    lastOnset: last ? last.onset : null,
    freeIntervalSec: timeSinceLast(entries, now),
    count24h: count24h(entries, now),
    anyStatus: (entries || []).some(isStatusEpilepticus),
  };
}

/** Duration formatter: "m:ss" at or above a minute, "Ns" below. */
export function formatDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Seizure-free interval formatter: hours up to 2 days, whole days beyond. The
 * 48h cutoff keeps the clinically natural "seizure-free 36h" phrasing in hours
 * rather than collapsing it to a vague "1d".
 */
export function formatInterval(sec) {
  if (sec == null) return null;
  const h = Math.floor(sec / 3600);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
