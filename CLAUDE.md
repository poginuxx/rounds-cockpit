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

## Architecture (where things live)
```
index.html          static markup (the "chrome" + all screens). No logic.
src/main.js         the ONLY file that touches the DOM. Thin controller; calls lib/*.
src/styles.css      design tokens + styles (IBM Plex, the teal/ink palette).
src/lib/
  schema.js         newPatient() factory + seed roster. THE record shape lives here.
  crypto.js         passcode → AES-GCM key; encrypt/decrypt. (Web Crypto)
  store.js          encrypted IndexedDB vault: setup/unlock/save/all/wipe.
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
- **Capture / OCR** screen (paper lab slips) feeding the same intake confirm flow.
- **Billing / PhilHealth** (CF1/CF2/CF4/CSF assembly) — `doMain.bill` already flags it.
- **Patient timeline** — `patient.snapshots[]` already accumulates the history it needs.
- **Neuro modules** — GCS/NIHSS ribbons, motor grid, seizure log, stroke clock.
- **Commute / prep mode** — calm read-only overnight diff.
- **Settings** — store the model API key in the encrypted vault and wire `getApiKey` in
  `main.js` to it (currently returns null → offline parser). See README "Cloud parsing".

## Before real patient data
This is a working prototype, not yet a clinical system. See `SECURITY.md` for the
checklist (backups/recovery, biometric gate, key handling, data-privacy review).
