/**
 * hospitals.js — the user-managed hospital list (pure logic).
 *
 * The hospital list is editable data the physician manages from inside the app
 * (add / remove / reorder). The array ORDER is the physical round (route) order.
 *
 * A hospital record is { name, abbr }:
 *   - name  the FULL NAME — the stored source of truth. A patient's
 *           `patient.hospital` is this exact string (no id, no migration).
 *   - abbr  a short DISPLAY LABEL shown where space is tight (census headers,
 *           round-card location). May be '' — then the full name is shown instead.
 *
 * Everything here is pure: callers pass the current list and get a new one back.
 * Persistence (encrypted, under the '__hospitals' key) lives in store.js; the
 * UI lives in main.js. This file never touches storage or the DOM.
 */

/** The real hospitals, in route order. Seeds an empty vault (never overwrites). */
export const SEED_HOSPITALS = [
  { name: 'The Medical City Pangasinan', abbr: 'TMCP' },
  { name: 'Medical Centrum Dagupan', abbr: 'MCD' },
  { name: 'Dagupan Doctors Villaflor Memorial Hospital', abbr: 'DDVMH' },
  { name: 'Nazareth General Hospital', abbr: 'NGH' },
  { name: 'ACE Medical Center', abbr: 'ACEMC' },
  { name: 'Region 1 Medical Center', abbr: 'R1MC' },
  { name: 'Julius K. Quiambao Wellness and Medical Center', abbr: 'JKQWMC' },
  { name: 'Pangasinan Provincial Hospital', abbr: 'PPH' },
  { name: 'Central Pangasinan Hospital and Medical Center', abbr: 'CPHMC' },
  { name: 'Blessed Family Doctors General Hospital', abbr: 'BFDGH' },
];

/** Label for the catch-all group of patients whose hospital isn't in the list. */
export const UNLISTED_LABEL = 'Other / unlisted';

/**
 * Append a hospital. Name is required (trimmed); a blank name is ignored and the
 * list returned unchanged. Abbr is optional. Returns a NEW array.
 */
export function addHospital(list, name, abbr = '') {
  const n = String(name == null ? '' : name).trim();
  if (!n) return list.slice();
  return [...list, { name: n, abbr: String(abbr == null ? '' : abbr).trim() }];
}

/** Remove the hospital at index `i`. Out-of-range index is a no-op. Returns a NEW array. */
export function removeHospital(list, i) {
  if (i < 0 || i >= list.length) return list.slice();
  return list.filter((_, idx) => idx !== i);
}

/**
 * Move the hospital at index `i` by `dir` (-1 = up, +1 = down). Clamped at the
 * ends (moving the first up, or the last down, is a no-op). Returns a NEW array.
 */
export function moveHospital(list, i, dir) {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list.slice();
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * Resolve a stored full-name string to its display abbreviation.
 * Falls back to the full name when the hospital has no abbr OR is unlisted —
 * never returns blank for a non-blank name (display rule: never show a blank label).
 */
export function abbrFor(list, name) {
  const n = String(name == null ? '' : name);
  const hit = list.find((h) => h.name === n);
  if (hit && String(hit.abbr || '').trim()) return hit.abbr.trim();
  return n;
}

/**
 * Group patients by hospital for the census, in route order.
 * Returns [{ name, abbr, listed, patients[] }]:
 *   - one group per LISTED hospital that has patients, in list order (listed:true);
 *   - then a group per UNLISTED hospital string (listed:false), sorted by name,
 *     LAST — a patient whose hospital isn't in the list is never dropped.
 * For unlisted groups `name` is the stored string (or UNLISTED_LABEL when blank)
 * and `abbr` falls back to that same label.
 */
export function groupPatientsByHospital(list, patients) {
  const byName = new Map();
  for (const p of patients) {
    const key = String(p.hospital == null ? '' : p.hospital);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }
  const groups = [];
  const seen = new Set();
  for (const h of list) {
    const pts = byName.get(h.name);
    if (pts && pts.length) {
      groups.push({ name: h.name, abbr: abbrFor(list, h.name), listed: true, patients: pts });
      seen.add(h.name);
    }
  }
  const unlisted = [...byName.keys()].filter((k) => !seen.has(k)).sort();
  for (const key of unlisted) {
    const label = key.trim() ? key : UNLISTED_LABEL;
    groups.push({ name: label, abbr: label, listed: false, patients: byName.get(key) });
  }
  return groups;
}
