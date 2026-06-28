/**
 * strokeclock.js — pure logic for the stroke clock (neuro module #4).
 *
 * A live count of time elapsed since LAST KNOWN WELL, shown against acute-stroke
 * treatment windows. This is DECISION-SUPPORT REFERENCE ONLY — it states elapsed
 * time and the configured window thresholds, nothing more.
 *
 * SAFETY PROPERTIES (the point of this module — do not erode them):
 *  1. The anchor is LAST KNOWN WELL, never symptom-discovery time and never
 *     admission time. For wake-up / unwitnessed onset the elapsed time runs from
 *     when the patient was last known well, which can be far longer than "time
 *     discovered". `onsetDiscovered` is documentation only and is NEVER used in
 *     any elapsed/window calculation here.
 *  2. The clock is physician-activated only. Nothing in this module — and nothing
 *     that may call it — infers `lastKnownWell` from admission, parsed, or any
 *     automated source. An unset anchor yields null (see below), never a guess.
 *  3. REFERENCE, NOT RECOMMENDATION. `windowStatus` reports remaining/passed time
 *     against configured thresholds. It must never imply eligibility — eligibility
 *     depends on imaging, contraindications, NIHSS, BP, glucose and more this
 *     module does not assess. Callers must keep wording factual ("4.5 h window
 *     passed", never "no longer eligible" / "give tPA").
 *  4. Treatment windows render ONLY when stroke type is confirmed ischemic.
 *     `windowStatus` returns [] for 'hemorrhagic' (thrombolysis is contraindicated
 *     in haemorrhage) and for 'undetermined' (pending type confirmation).
 *
 * Pure — no DOM, no storage. `now` (epoch ms) is injectable so the live tick is
 * testable against a fixed clock.
 *
 * Clock shape (defined in schema.js):
 *   { lastKnownWell (ISO), onsetDiscovered (ISO|null),
 *     type: 'ischemic'|'hemorrhagic'|'undetermined',
 *     windows: [{ id, label, minutes, kind:'standard'|'extended', note }] }
 */

/**
 * Configurable DEFAULT treatment windows. These are protocol-dependent defaults
 * the physician confirms against their own current protocol — seeded onto a clock
 * at activation and editable, NOT hardcoded immutable truth. Minutes are exact:
 * 270 = 4.5 h, 360 = 6 h, 1440 = 24 h.
 */
export const DEFAULT_STROKE_WINDOWS = [
  {
    id: 'iv',
    label: 'IV thrombolysis',
    minutes: 270,
    kind: 'standard',
    note: 'standard 4.5 h window — protocol-dependent',
  },
  {
    id: 'mt',
    label: 'Mechanical thrombectomy',
    minutes: 360,
    kind: 'standard',
    note: 'standard 6 h window — protocol-dependent',
  },
  {
    id: 'mt24',
    label: 'Thrombectomy, extended',
    minutes: 1440,
    kind: 'extended',
    note: 'up to 24 h — selected patients only, imaging/criteria-dependent ' +
      '(e.g. DAWN/DEFUSE-3); NOT automatic eligibility',
  },
];

/** A fresh copy of the default windows (so each clock owns its editable config). */
export function defaultWindows() {
  return DEFAULT_STROKE_WINDOWS.map((w) => ({ ...w }));
}

/** Last-known-well as epoch ms, or null when unset / unparseable. */
function lkwMs(clock) {
  if (!clock || !clock.lastKnownWell) return null;
  const t = Date.parse(clock.lastKnownWell);
  return Number.isNaN(t) ? null : t;
}

/**
 * Milliseconds elapsed since LAST KNOWN WELL, or null when the anchor is unset
 * or unparseable. NEVER returns 0 as a stand-in for "unknown" — null and 0 mean
 * opposite things (0 = activated this instant; null = no anchor → show no clock).
 * Clamped to >= 0 so a future-dated anchor never reads as negative elapsed time.
 */
export function elapsedMs(clock, now = Date.now()) {
  const start = lkwMs(clock);
  if (start == null) return null;
  return Math.max(0, now - start);
}

/**
 * Per-window status — ONLY for confirmed ischemic strokes.
 * Returns [] for 'hemorrhagic' and 'undetermined' (and for any clock without a
 * usable anchor). Each entry:
 *   { id, label, kind, minutes, note, remainingMs, passed }
 * `passed` is EXACT: at exactly `minutes` elapsed the window is passed
 * (270 min → passed at 4:30:00; 269:59 is not). remainingMs is clamped to >= 0.
 */
export function windowStatus(clock, now = Date.now()) {
  if (!clock || clock.type !== 'ischemic') return [];
  const elapsed = elapsedMs(clock, now);
  if (elapsed == null) return [];
  const windows = clock.windows || [];
  return windows.map((w) => {
    const limitMs = w.minutes * 60 * 1000;
    const passed = elapsed >= limitMs;
    return {
      id: w.id,
      label: w.label,
      kind: w.kind,
      minutes: w.minutes,
      note: w.note,
      remainingMs: passed ? 0 : limitMs - elapsed,
      passed,
    };
  });
}

/**
 * True when an ischemic clock still has at least one window open. Drives the
 * "surface prominently / expand by default" decision in the UI — the whole point
 * of a stroke clock is the at-a-glance "are we still in window".
 */
export function anyWindowOpen(clock, now = Date.now()) {
  return windowStatus(clock, now).some((w) => !w.passed);
}

/** Format a non-negative ms duration as HH:MM:SS. Negatives clamp to 0. */
export function formatHMS(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
