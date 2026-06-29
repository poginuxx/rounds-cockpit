/**
 * backup.js — encrypted, portable backup envelope.
 *
 * INVARIANTS (see CLAUDE.md):
 *  - A backup is ALWAYS encrypted as a whole; no plaintext patient data is ever
 *    written to the file. The header carries only non-secret metadata (a count
 *    and a date) — never names.
 *  - The recovery passphrase is INDEPENDENT of the daily 6-digit passcode and is
 *    NEVER stored anywhere by the app. It must be strong (see passphraseStrength)
 *    because the file is portable and attackable offline.
 *  - The app never uploads a backup. This module only builds/reads the envelope;
 *    file I/O and any transport are the caller's concern (and must stay local).
 *
 * This module is PURE (no IndexedDB, no DOM): it turns a vault payload into an
 * envelope and back. Storage lives in store.js; tests cover both.
 */

import { deriveBackupKey, encryptObj, decryptObj, randomSalt, BACKUP_ITERATIONS } from './crypto.js';

export const BACKUP_FORMAT = 'rounds-backup';
export const BACKUP_VERSION = 1;

/** Typed error so the UI can map each failure mode to a clear message. */
export class BackupError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'BackupError';
    this.code = code; // 'corrupt' | 'bad-format' | 'bad-version' | 'wrong-passphrase' | 'bad-payload'
  }
}

/**
 * Is `payload` a structurally valid vault? Used both before encrypting (export)
 * and after decrypting (restore) so a malformed file never reaches the store.
 * An empty patient list is allowed (a quiet day is still a real vault); what is
 * rejected is the wrong SHAPE.
 */
export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!Array.isArray(payload.patients)) return false;
  if (!Array.isArray(payload.hospitals)) return false;
  // Every patient must at least be an object with a string id (the vault key).
  for (const p of payload.patients) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return false;
  }
  return true;
}

/**
 * Assess passphrase strength. The daily PIN is fine on-device (rate-limited by
 * the hardware) but is brute-forceable offline once it's protecting a portable
 * file — so the recovery passphrase must clear a real bar. Pure + tested; the UI
 * enforces it and explains the why.
 */
export function passphraseStrength(s) {
  const v = String(s == null ? '' : s);
  const words = v.trim().split(/\s+/).filter(Boolean);
  if (/^\d+$/.test(v.trim())) {
    return { ok: false, reason: 'A string of digits like your daily passcode is too easy to guess offline. Use words or a mix of characters.' };
  }
  if (v.length >= 12 || words.length >= 4) return { ok: true, reason: '' };
  return { ok: false, reason: 'Use at least 12 characters, or 4 or more words. This protects the file if it ever leaves your phone.' };
}

/**
 * Build an encrypted backup envelope from a vault payload. The passphrase is used
 * only here to derive the key; it is not retained. Throws BackupError('bad-payload')
 * if the payload isn't a valid vault, so we never produce an un-restorable file.
 */
export async function createBackup(payload, passphrase, { now = () => new Date() } = {}) {
  if (!validatePayload(payload)) throw new BackupError('bad-payload', 'Refusing to back up an invalid vault.');
  const salt = randomSalt();
  const key = await deriveBackupKey(passphrase, salt, BACKUP_ITERATIONS);
  const cipher = await encryptObj(key, payload); // { iv, ct } — encrypts the WHOLE payload
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now().toISOString(),
    patientCount: payload.patients.length,
    kdf: { salt: [...salt], iterations: BACKUP_ITERATIONS, hash: 'SHA-256' },
    cipher,
  };
}

function parseEnvelope(envelopeOrText) {
  let env = envelopeOrText;
  if (typeof env === 'string') {
    try { env = JSON.parse(env); }
    catch { throw new BackupError('corrupt', 'This file is not readable — it may be corrupted or not a backup file.'); }
  }
  if (!env || typeof env !== 'object' || env.format !== BACKUP_FORMAT
      || !env.kdf || !Array.isArray(env.kdf.salt) || !env.cipher
      || !Array.isArray(env.cipher.iv) || !Array.isArray(env.cipher.ct)) {
    throw new BackupError('bad-format', "This doesn't look like a Rounds Cockpit backup.");
  }
  if (typeof env.version !== 'number' || env.version > BACKUP_VERSION) {
    throw new BackupError('bad-version', `This backup was made by a newer version (v${env.version}). Update the app to restore it.`);
  }
  return env;
}

/**
 * Decrypt + validate a backup envelope (object or its JSON text) with the recovery
 * passphrase. Returns the vault payload. Throws a typed BackupError for every
 * failure mode — the caller changes nothing on throw.
 */
export async function readBackup(envelopeOrText, passphrase) {
  const env = parseEnvelope(envelopeOrText);
  const key = await deriveBackupKey(passphrase, new Uint8Array(env.kdf.salt), env.kdf.iterations);
  let payload;
  try {
    payload = await decryptObj(key, env.cipher);
  } catch {
    // AES-GCM authentication failed: wrong passphrase OR tampered ciphertext.
    throw new BackupError('wrong-passphrase', 'Wrong recovery passphrase (or the file has been altered). Nothing was changed.');
  }
  if (!validatePayload(payload)) {
    throw new BackupError('bad-payload', 'The backup decrypted but its contents are not a valid vault.');
  }
  return payload;
}
