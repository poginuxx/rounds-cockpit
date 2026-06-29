# CLAUDE.md

Context for Claude Code. Read this first every session.

## What this is
A **personal** neurology rounding cockpit for one physician rounding across several
hospitals in Dagupan. It is independent of any hospital system. It is **local-first**:
patient records live only in the browser's encrypted IndexedDB on the user's own phone.
It installs as a **PWA** ("Add to Home Screen").

The rounding model is **Ask → Look → Do**, designed to keep a stable patient under a
minute at the bedside. Data is entered the night before via the **intake** screen.

## Hard invariants — do not break these
1. **Patient data never leaves the device** except as **de-identified** text sent to the
   cloud parser. The only outbound network call with clinical content is in
   `src/lib/parser.js → cloudParse`, and it must only ever receive the output of
   `src/lib/deid.js → deidentify` (tokens like `[PT1]`, never real names).
2. **Records are encrypted before storage.** All persistence goes through
   `src/lib/store.js`, which encrypts via `src/lib/crypto.js` before writing. Never write
   a patient object to IndexedDB or anywhere else in plaintext. Never add `localStorage`
   for patient data.
3. **The parser must under-report, never fabricate.** `heuristicParse` (the offline
   fallback) is deliberately conservative. A missed value is acceptable; a hallucinated
   lab value is a safety bug. There is a regression test for this (the "finally" → 150
   case). Keep `parser.test.js` green.
4. **Nothing commits without confirmation.** Parsed changes land in a review tray and only
   reach the store when the user presses commit. Do not auto-apply parsed values.
5. **Triage colour is derived, not authored.** It comes from `src/lib/diff.js →
   computeTriage`. Don't set `patient.triage` by hand in feature code.
6. **Backups are always encrypted, never auto-uploaded, and undoable.** The backup
   file (`src/lib/backup.js`) is a single envelope encrypted as a whole — no plaintext
   patient data is ever written to it, and the app NEVER uploads or transmits it (the
   user downloads and keeps it themselves). It is encrypted under a SEPARATE **recovery
   passphrase** that is independent of the daily 6-digit passcode, must be strong
   (`passphraseStrength`), is derived with a much heavier KDF (`deriveBackupKey`,
   600k PBKDF2 vs 150k on-device), and is NEVER stored by the app. Export must
   verify-after-write (decrypt the produced bytes back) before reporting success.
   Restore must `store.replaceVault` — which snapshots the current vault to
   `__prerestore` FIRST so the restore is undoable (`store.undoRestore`) — and must
   never lose data.

## Architecture (where things live)
```
index.html          static markup (the "chrome" + all screens). No logic.
src/main.js         the ONLY file that touches the DOM. Thin controller; calls lib/*.
src/styles.css      design tokens + styles (IBM Plex, the teal/ink palette).
src/lib/
  schema.js         newPatient() factory + seed roster. THE record shape lives here.
  crypto.js         passcode → AES-GCM key; encrypt/decrypt. (Web Crypto)
                    + deriveBackupKey (heavier KDF for the backup file).
  store.js          encrypted IndexedDB vault: setup/unlock/save/all/wipe;
                    replaceVault/undoRestore (pre-restore snapshot). [tested]
  backup.js         encrypted backup envelope: create/read/validate.   [tested]
  deid.js           local de-identification (pure).            [tested]
  parser.js         cloudParse + heuristicParse fallback.      [tested]
  diff.js           triage, digest, and the commit pipeline.   [tested]
public/
  manifest.webmanifest, sw.js, icons/   PWA assets.
```

`lib/deid.js`, `lib/parser.js`, `lib/diff.js`, `lib/store.js` have tests next to them
(`*.test.js`). The **clinical logic is all in `lib/` and all tested**; `main.js` is glue.

## Conventions
- Plain ES modules, vanilla JS, no framework. Keep it that way unless the app outgrows it.
- The record shape is defined once in `schema.js`. If you change it, update `newPatient`
  AND the tests AND any screen that reads the changed field.
- Add a test whenever you touch `lib/`. Run `npm test` before declaring done.
- DOM handlers are exposed on `window` at the bottom of `main.js` so the inline `onclick`
  in `index.html` resolve. If you add a screen action, add it there too.

## Run
```
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # -> dist/
```

## Roadmap (not yet built)
- **Capture / OCR** — ✅ DONE. The Intake "Snap" source reads a paper lab slip with
  ON-DEVICE OCR (Tesseract.js) and drops the recognized TEXT into the SAME `#rawText`
  textarea the typed flow uses, then switches the source back to text — so the
  existing de-identify → parse → review tray → commit path runs unchanged (zero new
  downstream code; OCR is an input adapter, not a parallel pipeline). `src/lib/ocr.js`
  is the thin seam: `recognize(blob,{onProgress})`, lazy `import('tesseract.js')` (its
  own Vite chunk — main bundle isn't bloated for non-Snap users), terminates the
  worker each call. `main.js` owns the file input, thumbnail, progress UI, and handoff.
  INVARIANT — a lab-slip image is the most identifying artifact in the app (printed
  name + ID) and is TRANSIENT + ON-DEVICE ONLY; a future change must NOT erode this:
    * The image bytes NEVER leave the device and are NEVER persisted — held in memory
      only (a File + one objectURL), OCR'd, then dropped (URL revoked). It is never
      written to the store/IndexedDB and never sent to any network call. Only the
      EXTRACTED TEXT continues.
    * OCR runs with NO CDN: Tesseract is forced to LOCAL assets under
      `public/tesseract/` (`worker.min.js`, the self-contained `tesseract-core-simd-
      lstm.wasm.js`, and `lang/eng.traineddata.gz` = gzipped tessdata_fast `eng`).
      They are same-origin → the existing cache-first service worker caches them →
      recognition works offline after first load. Re-vendor with `npm run vendor:ocr`
      (copies worker+core from node_modules; see `scripts/vendor-tesseract.mjs` header
      for the traineddata download). The default CDN fetch the SW can't cache would
      break offline — do not revert to it.
    * OCR text is UNVERIFIED input: it enters at the textarea UPSTREAM of de-identify,
      is editable, and gets no shortcut to commit. De-identification is never bypassed;
      only de-identified TEXT reaches the cloud parser (invariant #1 intact). The
      parser's "under-report, never fabricate" property still governs commits.
  No schema change (OCR only produces text for the existing pipeline).
- **Billing / PhilHealth** (CF1/CF2/CF4/CSF assembly) — `doMain.bill` already flags it.
- **Patient timeline** — ✅ DONE. Read-only admission history reached from the Round
  Card header ("History"). Renders the sodium trajectory + captured vitals per day,
  newest first, with a "what changed" line from `diff.js → buildTimeline`. Seed
  `snapshots[]` are backfilled from `na[]`/`naLabel` in `schema.js`.
- **Neuro modules** — a reusable **Neuro section** now lives in the Round Card's
  LOOK zone: a collapsed-by-default expandable block (the `expandable()` helper +
  `.nblock` styles in `main.js`/`styles.css`) that the remaining modules will reuse.
  - **GCS / NIHSS ribbons** — ✅ DONE. Direction-aware trend ribbons in the sodium
    sparkline style; a FALLING GCS and a RISING NIHSS are coloured as worsening via
    `diff.js → neuroStatus`. A bedside stepper writes today's score to `scores[]`
    (persisted, encrypted); the new value becomes a ribbon point at the next intake
    commit (`snapshotOf` captures gcs/nihss). Seed `gcs[]`/`nihss[]` history is
    backfilled in `schema.js`. Ribbons render only for metrics that have data.
  - **Motor power grid** — ✅ DONE. MRC grid (rows = muscle groups, columns =
    Left/Right) in its own collapsible block, default collapsed. The muscle-group
    set + grade list + ordering rule are data in `lib/motor.js`; `motorDelta` gives
    per-cell trend where a DROP in power = 'worse' (red), a rise = 'better' (teal),
    unchanged = neutral — pure & tested. Grades are strings ('0'..'5','4-','4+') on
    a dated `motorExams[]` history (own array, NOT in `snapshots[]`); an ABSENT key
    means NOT TESTED — renders '—', excluded from trend, never auto-filled to 5/5.
    "Set all 5/5" + a fast cell picker compose a draft; "Record exam" persists it
    encrypted and the prior exam becomes the trend baseline. Seed: the MCA-infarct
    patient (Aurora) carries two dated exams with contralateral right-sided weakness.
  - **Seizure log** — ✅ DONE. Own collapsible block, default collapsed. The
    collapsed header is the one glanceable summary: "N seizure(s) today", else
    "Seizure-free Xh/Xd" (interval from the most recent entry), else an explicit
    "No seizures recorded" (null interval — NOT "0h", which means the opposite).
    Records per event: onset (REAL ISO datetime), durationSec, type, optional
    features[]/trigger/rescueMed/rescueResponded/witnessed/note. A single event
    ≥ 5min (300s exactly) flags STATUS EPILEPTICUS. All derived numbers are pure
    & tested in `lib/seizures.js` (`now` injectable); `main.js` only renders the
    log + wires the form. Seed: the breakthrough-GTC patient (Lourdes) carries
    two entries timestamped RELATIVE to Date.now() (~36h + ~9d ago).
    MANUAL-ENTRY-ONLY BY DESIGN — the log is written EXCLUSIVELY by its own
    Record-seizure form (`seizures[]` is assigned in exactly one place). The
    intake parser's `seizure` field and the bedside "Any seizures?" Ask toggle
    are fully decoupled and must NEVER append to it; a future change must not
    quietly wire an automated append. The only bridge is a convenience shortcut:
    when the Ask toggle reads "Yes", the block shows a one-tap button that OPENS
    the empty form — the physician fills it, nothing is pre-filled. Entries are
    append-only (no edit/delete path; a correction is a new entry). NOTE: a
    recent seizure deliberately does NOT feed `computeTriage` (decision: triage
    left untouched for now); if wired later, do it via a derived `seizures.js`
    helper so triage stays derived, never authored.
  - **Stroke clock** — ✅ DONE. Own collapsible block in the Neuro section; when a
    clock is active AND any window is still open it surfaces PROMINENTLY (expanded,
    teal-accented `.sc-live`), else it sits collapsed. A live count-up (HH:MM:SS,
    `setInterval` in `main.js`, recomputed from timestamps each tick — no drift)
    shows time elapsed since LAST KNOWN WELL. All time/window maths is pure & tested
    in `lib/strokeclock.js` (`now` injectable): `elapsedMs`, `windowStatus`,
    `anyWindowOpen`, `formatHMS`, plus editable `DEFAULT_STROKE_WINDOWS`
    (IV 270min/4.5h, MT 360min/6h, MT-extended 1440min/24h). Schema:
    `strokeClock:null` until activated → `{ lastKnownWell, onsetDiscovered|null,
    type, windows[] }`. Seed: the ischemic MCA-infarct patient (Aurora) carries an
    ACTIVE clock anchored ~5h before Date.now() (illustrative) → IV PASSED, MT/MT-24h
    open. The interval is cleared in `closeCard()` AND `lockApp()` — no leaked timers.
    SAFETY PROPERTIES — pin these; a future change must NOT erode them:
      * REFERENCE, NOT RECOMMENDATION. It states elapsed time + configured window
        thresholds only. It must NEVER say to give/withhold a treatment or imply
        eligibility — eligibility depends on imaging, contraindications, NIHSS, BP,
        glucose and more this clock does not assess. Wording stays factual ("window
        passed", never "(no longer) eligible").
      * The anchor is LAST KNOWN WELL, never symptom-discovery and NEVER admission
        time. Physician-activated only; nothing infers/auto-anchors it. A future
        change must not quietly anchor it to admission/parsed/automated data, nor
        auto-activate it. `onsetDiscovered` is documentation only — never used in
        any elapsed/window calculation.
      * Treatment windows render ONLY for confirmed ischemic. `windowStatus` returns
        [] for hemorrhagic (thrombolysis contraindicated — show elapsed only, note
        N/A) and for undetermined (windows pending type confirmation, not active).
      * Threshold crossing is EXACT: at 270min (4:30:00) the IV window is passed;
        4:29:59 is not (`strokeclock.test.js` pins the boundary). LKW unset →
        "last known well not set", no countdown — never a zero or a guess.
      * Windows are EDITABLE config (defaults the physician confirms vs protocol),
        not immutable truth. The in-UI per-window editor is deferred; the config is
        already editable in the record. The ONLY writer of `strokeClock` is the
        activation form (physician-set).
    With this, all four neuro modules (ribbons, motor grid, seizure log, stroke
    clock) are complete.
- **Hospital list** — ✅ DONE. The hospital list is now USER-MANAGED data, not a
  hardcoded array. It lives in the encrypted vault under the reserved key
  `__hospitals` (encrypted like everything else; `store.js` skips reserved keys in
  `allPatients`). Seeded with the 10 real hospitals on first load ONLY — an
  existing list is never overwritten. A focused "Manage hospitals" sheet (reached
  from the Today header 🏥 button and a "Manage" link beside the Add-Patient
  hospital field — NOT a full Settings screen) adds / removes / reorders entries;
  reorder is move-up / move-down, not drag-and-drop. All list logic is pure &
  tested in `lib/hospitals.js` (`SEED_HOSPITALS`, add/remove/move, `abbrFor`,
  `groupPatientsByHospital`); `main.js` only renders the manager, the dropdown, and
  the display labels.
  NAME vs ABBREVIATION — a hospital is `{ name, abbr }`. The FULL NAME is the
  stored source of truth: `patient.hospital` is the full-name STRING (NO patient
  schema change, no id, no migration). The abbreviation is a DISPLAY label only,
  looked up by matching the patient's stored name. Show the ABBREVIATION where the
  user scans their own patients and space is tight (Today census group headers,
  Round Card + timeline location); show the FULL NAME where a wrong choice has
  consequences (Add-Patient dropdown, the Manage sheet — full name WITH abbr — and
  any future printed/official output). If a hospital has no abbr, fall back to the
  full name everywhere (`abbrFor` never returns blank for a non-blank name).
  SAFETY — no existing patient may lose its hospital:
    * A patient whose stored hospital is NOT in the current list is NEVER hidden or
      dropped: `groupPatientsByHospital` sorts such patients LAST under an
      "Other / unlisted" group, shown with their stored name as-is. Pinned by test.
    * RENAME LIMITATION: matching is by exact full-name string. Renaming a hospital
      in the manager does NOT rewrite the string on existing patients — they fall to
      the unlisted group until re-pointed. (This is why the old placeholder seed
      "Region I Medical Center" / "Gov. T. Sison Memorial" patients show as unlisted
      after upgrade — they are not lost.) Seed roster now uses real canonical full
      names (the Roman-`I` → numeral-`1` gotcha is fixed). "reset demo data" reseeds
      patients with real names AND resets the hospital list to the seed.
- **Encrypted backup & restore** — ✅ DONE. The gate before real patient data. A
  focused "Backup & restore" sheet (Today header 💾 — NOT a full Settings screen)
  exports the whole vault (all patients + the hospital list) as ONE encrypted file
  the user downloads and keeps; the app never uploads it. Envelope:
  `{ format:'rounds-backup', version, createdAt, patientCount, kdf:{salt,iterations},
  cipher:{iv,ct} }` — header is non-secret (count/date only), `ct` is the whole
  payload AES-GCM-encrypted under the recovery passphrase. All format/crypto is pure
  & tested in `lib/backup.js` (`createBackup`, `readBackup`, `validatePayload`,
  `passphraseStrength`, typed `BackupError` for wrong-passphrase / bad-format /
  bad-version / corrupt / bad-payload). KDF: PBKDF2-SHA256 **600k** iters (vs 150k
  on-device) because the file is portable + offline-attackable; the count travels in
  the envelope so it can be raised later. Export VERIFIES-AFTER-WRITE (decrypts the
  produced bytes back) before reporting success. RESTORE = **replace** both patients
  and hospital list, but `store.replaceVault` snapshots the current vault to
  `__prerestore` FIRST (raw ciphertext, no decryption) so it is one-step undoable
  (`store.undoRestore`); restored records are re-encrypted under the CURRENT on-device
  key, so the FRESH-DEVICE path works (new passcode → restore → readable). The daily
  passcode/key is never touched. `lib/store.js` adds `replaceVault`, `undoRestore`,
  `hasPrerestore`, `get/setLastBackupAt` (non-secret timestamp → gentle Today nudge).
  See invariant #6.
- **Commute / prep mode** — calm read-only overnight diff.
- **Settings** — store the model API key in the encrypted vault and wire `getApiKey` in
  `main.js` to it (currently returns null → offline parser). See README "Cloud parsing".

## Before real patient data
This is a working prototype, not yet a clinical system. See `SECURITY.md` for the
checklist (backups/recovery, biometric gate, key handling, data-privacy review).
