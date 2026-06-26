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
