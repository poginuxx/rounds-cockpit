# SPEC — production-readiness pass (2026-07)

Spec for the changes made across four commits on `feat/encrypted-backup-restore`
(`0def221`, `599d8bc`, `5a4a8f2`, `9aec8cf`) fixing a dead production deploy and
adding bedside data-editing and per-patient lab trend tracking. Read this
alongside `CLAUDE.md` (architecture + hard invariants) — nothing here changes
those invariants; several items exist specifically to keep them intact.

## 1. Critical fix: the app didn't boot

**Symptom:** the deployed Netlify build was a blank/broken page for every user.

**Cause:** the prior commit (`1bdbf35`, "Add edit and delete for existing
patients") deleted `closeAdd`, `fillHospitalSelect`, and `resetDemo` from
`src/main.js` while `Object.assign(window, {...})` at the bottom of the file
still referenced them. A reference to an undefined function throws at module
evaluation time, so the whole script failed to run — the lock screen never
rendered.

**Fix:** restored all three functions. `closeAdd()` now also resets
`state.editingId`, so `savePatient()` captures a `wasEdit` flag before calling
it (order matters — `closeAdd` used to run after the edit/add distinction was
still needed).

**Lesson captured in memory:** before calling anything "done," grep every name
inside the `Object.assign(window, {...})` export block and confirm it resolves
— a single missing name is a full outage, not a degraded feature.

## 2. Other correctness fixes (`0def221`)

| Bug | Where | Fix |
|---|---|---|
| Today header, intake-commit dates, motor-exam dates were hardcoded strings (`'TUE · 16 JUN'`, `'06/17'`, `'today'`) | `main.js` | Real `Date()`-derived values (`todayMMDD()`, `todayHeader()`) |
| Review tray showed `undefined` as the prior Na for a patient with no sodium history | `main.js: renderTray` | Falls back to `'—'` |
| Seizure log accepted a future onset time, which would corrupt "seizure-free Xh" | `main.js: saveSeizure` | Rejects onset > 5 min in the future |

### Safety/UX fixes bundled in the same commit
- **Passcode setup now requires the code twice.** A single mistyped digit at
  first-run setup previously meant a permanently unreadable vault (no recovery
  by design — see `CLAUDE.md` invariant on crypto). `bootLock`/`submitPin` gained
  a `pendingCode` confirm step.
- **Backup export is iOS-standalone-safe.** In an installed home-screen PWA
  (`navigator.standalone === true`), a programmatic anchor download can fail
  silently while the app still records "backup complete." `deliverBackupFile()`
  routes through `navigator.share` in that context; a cancelled share records
  nothing. Desktop/browser behavior is unchanged (plain download).
- Restore-sheet re-renders no longer wipe an already-typed passphrase
  (`renderBackup` now preserves `#bk_pass`/`#bk_rpass` values across re-renders).
- The seizure-log "Ask says Yes → log it" shortcut now appears immediately when
  the toggle flips, instead of only after reopening the card.
- Sample intake text only pre-fills while the demo roster (`p_ramon` etc.) is
  still present.
- The Delete-patient button is now styled destructive (red) instead of
  identical to Cancel.
- Mobile layout uses `100dvh` (with `100vh` fallback) so the tab bar clears the
  iOS Safari toolbar.

## 3. Feature: direct bedside editing (`599d8bc`)

**Problem:** the only way to change a patient's Na, vitals, or most scores was
to type free text into the nightly Intake screen and hope the offline parser
caught it. Potassium, serum osmolality, WFNS, and any other non-GCS/NIHSS score
had **no path at all** — not even through Intake — and were frozen from patient
creation. Medications were the same: no add/edit/delete, ever.

**Design:** a generic tap-to-edit bottom sheet (`#editScrim`/`#editsheet`) on
the Round Card, reusing the existing tested `diff.js` pipeline
(`applyChange` → `computeTriage` → snapshot) so triage stays derived, never
hand-set (invariant #5), even for a single bedside correction.

- **Sodium** — the cell now always renders (even at zero readings, with a
  "tap to add the first reading" placeholder), so a freshly added patient can
  get their first Na without a trip through Intake.
- **Potassium / serum osmolality** — tap-to-edit with an optional secondary
  "note" field. Fixed a dead conditional along the way: the "abnormal K"
  red styling checked `p.kbad`, a field nothing in the codebase ever set, so
  a critically abnormal potassium was never actually flagged.
- **Vitals** (BP/HR/RR/Temp/SpO2) — each chip is tap-to-edit.
- **Scores** — every score *except* GCS/NIHSS (which keep their existing
  bedside +/− stepper, so there is one interaction path per field, not two
  competing ones).
- **Medications** — new add/edit/delete form (`#medScrim`/`#medsheet`).
  Meds don't feed triage or the snapshot timeline, so this only mutates
  `p.meds` directly.
- **Patient "Detail" field** (e.g. "Hunt-Hess 3") — added to the existing
  Edit-patient sheet, next to Diagnosis, since it's a refinement of that same
  header line rather than a separate concern.

### `lib/diff.js` changes backing this (tested)
- `applyChange` gained `k` and `osmo` field handling.
- `naLabel` now builds correctly from an **empty** starting state (single
  anchor date → range → range-with-moved-end-date) instead of only ever
  regex-replacing an existing `→` arrow, which silently no-op'd for a
  brand-new patient.
- **`upsertSnapshot(p, date)`** — new. If the patient's most recent snapshot is
  already dated `date`, it's overwritten in place instead of appended. Without
  this, a bedside correction made after an Intake commit on the same day (or
  committing Intake twice in one day) silently duplicated the admission
  timeline row for that date. `commitPatient` now calls this too, so the fix
  applies to the nightly Intake path as well, not just bedside edits.

## 4. Feature: per-patient lab trend tracking (`5a4a8f2`)

**Problem:** every patient always showed a dedicated Sodium trend cell
regardless of whether sodium was actually a clinical concern for them, and
there was no way to track any other lab (e.g. creatinine) as a trend over
time.

**Schema (`lib/schema.js`):**
```
trackNa: false          // Sodium trend cell is opt-in per patient now
customLabs: []           // [{ id, label, unit, band:[lo,hi]|null, series:[{date,value}] }]
```
- `trackNa` defaults to `false` for every new patient. Seed data: only Ramon
  and Aurora (the two patients whose narrative is actually about sodium) start
  with it `true`; Lourdes/Efren/Carmela don't track it by default.
- Ramon also seeds one illustrative `customLabs` entry (Creatinine,
  0.6–1.2 mg/dL band, 5-day series) so the feature is visible without adding
  one first.

**UI:** a "Manage labs" link in the Round Card's LOOK zone header opens
`#labsScrim`/`#labssheet`:
- Toggle Sodium tracking on/off per patient.
- Add any named lab (name, unit, optional normal band) — not hardcoded to
  Creatinine, genuinely arbitrary.
- Remove a tracked lab.
- Tap a tracked lab's cell to log a new dated reading (own small form,
  `openLabReading`/`saveLabReading`, sharing the `#editsheet` container).

`sparkline(series, band)` in `main.js` was generalized to accept an arbitrary
`[lo, hi]` normal band (default `[135,145]` preserves the old Na-only
behavior) instead of being hardcoded to sodium's range, so it's reusable for
any lab.

**Deliberate scope boundary:** custom labs are informational/monitoring only —
they do **not** feed `computeTriage`. There is no safe way to infer a clinical
severity threshold for an arbitrary lab name, so triage stays exactly as
derived today (invariant #5 untouched). If a specific custom lab should later
influence triage, that needs a separate, explicit decision — not an automatic
consequence of adding it here.

**Also in this commit:** removed the "Foundation demo. Seeded sample
patients — don't enter real ones..." banner (`index.html` + its now-dead
`.demo-banner` CSS). "reset demo data" is untouched. Note: `CLAUDE.md`'s
"Before real patient data" checklist (`SECURITY.md`) still stands — removing
the banner doesn't mean that checklist is done.

## 5. Critical fix: buttons unclickable on every bottom sheet (`9aec8cf`)

**Symptom:** Cancel/Done/Save didn't respond on the Manage Labs sheet (user
report), and — once investigated — on every other bottom sheet in the app.

**Root cause:** `#toast` (the small confirmation popup, e.g. "✓ Sodium
updated") sits at `z-index: 40` — above every sheet (`21`) and scrim (`20`) —
but its base CSS rule never set `pointer-events: none`. Even fully invisible
(`opacity: 0`) and never yet triggered, an element still blocks pointer events
by default unless told otherwise, so it silently intercepted clicks anywhere
over its bottom-of-screen bounding box — which overlaps the `.formbtns` row
every sheet uses.

**Fix:** one line — `pointer-events: none` on the base `.toast` rule.

**Verification method:** real coordinate-based hit-testing
(`document.elementFromPoint` at each button's actual rendered center),
not `.click()` (which invokes a handler directly and would never have caught
this, since it bypasses the browser's real hit-testing/z-index stacking).
Confirmed fixed on: Manage Labs, Manage Hospitals, Add/Edit Patient, Backup &
Restore, Record Seizure, Stroke Clock activation, the medication form, and the
generic value-edit sheet — plus a clean pass over the tab bar, the "+ Add"
FAB, the Round Card close button, and the motor-grade picker, none of which
were affected.

## Testing

- `npm test` — 146 tests passing across 10 files (up from 133 at the start of
  this pass; new coverage added for `applyChange` k/osmo handling,
  `upsertSnapshot`, `naLabel` construction, and the new schema defaults).
- `npm run build` — production build succeeds after every commit in this pass.
- Every feature was additionally driven live in a browser preview (unlock →
  Today → Round Card → tap-to-edit flows → Manage Labs → medications →
  backup/restore) with console-error checks at each step.

## Not done in this pass (explicitly out of scope)

- Custom labs are not shown in the admission Timeline sheet (`buildTimeline`)
  — only on the Round Card. Would require generalizing `diffSnapshots`/
  `buildTimeline` beyond na/rr/spo2/temp.
- The "Do" action card (`doMain`) and its per-type behavior are still static.
- `SECURITY.md`'s pre-real-patient-data checklist (biometric gate, key
  handling review, etc.) is unaffected by this pass and still applies.
