# Security & privacy model

This app holds real patient health information. This document is the honest account of what
it protects, what it doesn't yet, and what to settle before using it with real patients. It
is written to be read, not to reassure.

## What the design protects

- **Encryption at rest.** Every patient record is encrypted with AES-GCM using a key derived
  (PBKDF2, 150k iterations) from your passcode, before it is written to IndexedDB. The
  passcode itself is never stored — only a random salt and an encrypted sentinel used to
  verify it.
- **Local-first.** Patient records never leave the device through normal use. There is no
  backend and no sync.
- **One controlled exit.** The single outbound path that touches clinical text is the cloud
  parser, and it receives only **de-identified** text (names → tokens, rooms and long ID
  numbers redacted). The re-identification key stays on the device. The intake screen shows
  you the exact outbound payload before anything is sent.

## What it does NOT protect (yet) — read carefully

- **De-identification is not anonymization.** Removing names and rooms reduces re-identification
  risk; it does not eliminate it. A rare diagnosis plus a hospital plus an age can still point
  to one person. Treat the cloud parser as "low-risk," not "no-risk," and review the payload.
- **Browser storage is softer than native.** IndexedDB is encrypted by this app's own key,
  but it does not get the hardware-backed protection a native iOS Keychain/Secure Enclave
  app would. A lost, unlocked, unencrypted phone is a real exposure. Mitigation: use a device
  passcode + full-device encryption, and add the biometric gate below.
- **No recovery.** If you forget the passcode, the data is unrecoverable by design. There is
  currently no backup. Do not store anything you can't afford to lose until backups exist.
- **No audit trail / no multi-device.** Single device, single user.

## Checklist before real patient data

- [ ] **Backups.** Design an encrypted export/restore so a lost passcode or phone isn't total
      loss. (Encrypt the export with a separate recovery phrase.)
- [ ] **Biometric gate.** Add Face ID / fingerprint via WebAuthn on top of the passcode.
- [ ] **API key handling.** If using cloud parsing, store the key in the encrypted vault, never
      in source or `localStorage`. Prefer a minimal proxy if you can accept a backend.
- [ ] **Data-privacy review.** Confirm your obligations under the Philippines Data Privacy Act
      (RA 10173) / National Privacy Commission for a personal clinical record, including a
      vendor/data-processing review of any cloud model you send de-identified text to.
- [ ] **Idle auto-lock.** Lock the app after a short period of inactivity.
- [ ] **Re-id review of intake.** Spot-check that de-identification handles your real nurses'
      phrasing (nicknames, initials, ward names) — extend `deid.js` and its tests as needed.

## Reporting

This is a personal project. If you (or a developer you bring in) find a security issue, fix it
and add a regression test in the relevant `src/lib/*.test.js`.
