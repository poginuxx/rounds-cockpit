/**
 * motor.js — pure logic for the MRC motor power grid (neuro module #2).
 *
 * The MRC scale is 0–5 with the standard 4-/4/4+ subdivisions. LOWER = WEAKER =
 * WORSE. Laterality is real: Left and Right are graded independently per muscle
 * group (an MCA infarct gives contralateral weakness on one side only).
 *
 * "not tested" is NOT 5/5. An untested cell is the ABSENCE of a key — it never
 * carries a value, never produces a delta, and is never auto-filled with a
 * normal score. (This mirrors the parser invariant: a blank is honest; a
 * fabricated normal exam is a safety bug.)
 *
 * Pure module — no DOM, no storage. Rendering/wiring lives in main.js.
 */

/** Muscle groups, as data so the set is editable without touching render code. */
export const MUSCLE_GROUPS = [
  // Upper limb
  { id: 'shoulderAbd',  label: 'Shoulder abduction',   region: 'UL' },
  { id: 'elbowFlex',    label: 'Elbow flexion',        region: 'UL' },
  { id: 'elbowExt',     label: 'Elbow extension',      region: 'UL' },
  { id: 'wristExt',     label: 'Wrist extension',      region: 'UL' },
  { id: 'fingerAbd',    label: 'Finger abduction',     region: 'UL' },
  // Lower limb
  { id: 'hipFlex',      label: 'Hip flexion',          region: 'LL' },
  { id: 'kneeExt',      label: 'Knee extension',       region: 'LL' },
  { id: 'kneeFlex',     label: 'Knee flexion',         region: 'LL' },
  { id: 'ankleDorsi',   label: 'Ankle dorsiflexion',   region: 'LL' },
  { id: 'anklePlantar', label: 'Ankle plantarflexion', region: 'LL' },
];

/** Region labels for grid section headers. */
export const REGIONS = [
  { id: 'UL', label: 'Upper limb' },
  { id: 'LL', label: 'Lower limb' },
];

/** Both sides are graded independently. */
export const SIDES = ['L', 'R'];

/** The MRC grades a cell may take, in ascending strength order. */
export const GRADES = ['0', '1', '2', '3', '4-', '4', '4+', '5'];

/** The picker also offers "not tested", which clears the cell (absent key). */
export const NOT_TESTED = 'not tested';

/** Ascending strength rank. 4- < 4 < 4+ compares correctly. */
const GRADE_RANK = { '0': 0, '1': 1, '2': 2, '3': 3, '4-': 4, '4': 5, '4+': 6, '5': 7 };

/** Build the canonical cell key for a group + side, e.g. 'UL.shoulderAbd.R'. */
export function cellKey(group, side) {
  return `${group.region}.${group.id}.${side}`;
}

/**
 * Numeric strength rank of a grade, or null when the grade is missing / not
 * tested / unrecognised. null is excluded from ordering and trend.
 */
export function gradeRank(g) {
  if (g == null) return null;
  const r = GRADE_RANK[g];
  return r == null ? null : r;
}

/**
 * Per-cell trend of a current exam vs the previous one.
 *
 * Returns { [cellKey]: { from, to, direction } } where direction is
 * 'worse' | 'better' | 'same'. A DROP in strength (lower rank) is 'worse'; a
 * rise is 'better'. A cell is included ONLY when BOTH exams carry a real,
 * comparable grade — if either side is not tested (absent / unrecognised) the
 * cell is omitted entirely (no delta, no value).
 */
export function motorDelta(prevExam, curExam) {
  const prev = (prevExam && prevExam.cells) || {};
  const cur = (curExam && curExam.cells) || {};
  const out = {};
  for (const key of Object.keys(cur)) {
    const to = gradeRank(cur[key]);
    const from = gradeRank(prev[key]);
    if (to == null || from == null) continue;          // not tested either side → no delta
    const direction = to < from ? 'worse' : to > from ? 'better' : 'same';
    out[key] = { from: prev[key], to: cur[key], direction };
  }
  return out;
}
