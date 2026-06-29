/**
 * crypto.js — passcode-derived encryption. Uses the Web Crypto API.
 *
 * The passcode is NEVER stored. We store only a random salt and an encrypted
 * sentinel; on unlock we re-derive the key and try to decrypt the sentinel to
 * verify the passcode. The derived key lives in memory only and is discarded on
 * lock or reload. There is no recovery if the passcode is lost — keep backups.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 150_000;

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function deriveKey(passcode, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Iteration count for the BACKUP key. Much heavier than the on-device passcode
// (above): the backup file is portable and can be attacked offline at leisure, so
// derivation must be costly. 600k is the OWASP floor for PBKDF2-HMAC-SHA256.
// (Argon2 would be preferable but is not in Web Crypto.) The actual count used is
// always read back from the envelope's kdf.iterations, so this can be raised later
// without breaking older backups.
export const BACKUP_ITERATIONS = 600_000;

/**
 * Derive the AES-GCM key for a backup file from the user's recovery passphrase.
 * Unlike deriveKey, the iteration count is explicit so it travels in the envelope
 * and stays forward-compatible.
 */
export async function deriveBackupKey(passphrase, salt, iterations = BACKUP_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptObj(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: [...iv], ct: [...new Uint8Array(ct)] };
}

export async function decryptObj(key, rec) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(rec.iv) },
    key,
    new Uint8Array(rec.ct),
  );
  return JSON.parse(dec.decode(pt));
}
