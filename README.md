# Rounds Cockpit

A personal neurology rounding cockpit — local-first, encrypted, and installable to your
phone's home screen as a PWA. Built to keep a stable patient under a minute at the bedside,
with data entered the night before.

This is the maintainable codebase version of the single-file prototype. The clinical logic
now lives in small, **tested** modules.

## Run it

You need [Node.js](https://nodejs.org) (version 18 or newer). Then, in this folder:

```bash
npm install      # one time — downloads the build tools
npm run dev      # starts the app at http://localhost:5173
```

Open that URL. First run asks you to **set a 6-digit passcode** — this encrypts everything.
Five sample patients are seeded so you can explore. There's a "reset demo data" link on the
Intake screen.

Other commands:

```bash
npm test         # run the test suite (the safety-critical logic)
npm run build    # produce a deployable build in dist/
npm run preview  # preview the built version locally
```

## What works today

- **Lock screen** — passcode sets up an AES-GCM key; records are encrypted before storage.
- **Today** — census grouped by hospital in route order, triage colours and the overnight
  digest computed from the data, not hardcoded.
- **Round Card** — Ask / Look / Do, reading live from the encrypted store. Ask answers
  persist.
- **Nightly intake** — paste a nurse update → de-identify locally (you see exactly what
  leaves the phone) → parse → review every change → commit. The commit updates the store
  and recomputes triage.

## Cloud parsing (optional)

By default the app parses on-device with a conservative regex fallback, fully offline. To
use the stronger cloud parser (Claude), you need an Anthropic API key. The de-identified
text — never real names — is what gets sent.

For now this is wired to be **off** (`getApiKey` in `src/main.js` returns `null`). To turn
it on properly, store your key in the encrypted vault and return it from `getApiKey`. Don't
hardcode a key in the source. (A small Settings screen for this is on the roadmap.)

Note: calling the model API directly from the browser requires the
`anthropic-dangerous-direct-browser-access` header (already set in `parser.js`). The most
secure option is a tiny proxy that holds the key server-side — but that reintroduces a
backend, which this app deliberately avoids.

## Project layout

See `CLAUDE.md` for the full map and the invariants. In short: `index.html` is markup,
`src/main.js` is the DOM controller, and everything consequential is a tested module under
`src/lib/`.

## Installing to your phone

Build and deploy `dist/` to any static host over HTTPS (required for service workers).
Open it in your phone's browser and choose "Add to Home Screen". It then runs full-screen,
offline, with its own icon.

## Status

A working prototype, not yet a clinical system of record. Read `SECURITY.md` before putting
real patient data in.
