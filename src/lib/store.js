/**
 * store.js — the encrypted on-device vault (IndexedDB).
 *
 * Records are encrypted with the passcode-derived key BEFORE they are written, so
 * nothing is ever stored in readable form. No network calls happen here — patient
 * data never leaves the device through this module.
 */

import { randomSalt, deriveKey, encryptObj, decryptObj } from './crypto.js';
import { newPatient } from './schema.js';

const DB_NAME = 'rounds_cockpit';
const STORE = 'vault';
const META = '__meta';

let _key = null; // in-memory derived key; null when locked
let _db = null;  // cached connection

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => {
      _db = r.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      res(_db);
    };
    r.onerror = () => rej(r.error);
  });
}

/** Close the cached connection (used by tests and before a known reset). */
export function _close() {
  if (_db) { _db.close(); _db = null; }
}
function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((res, rej) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }),
  );
}
const rawGet = (k) => tx('readonly', (s) => s.get(k));
const rawPut = (k, v) => tx('readwrite', (s) => s.put(v, k));
const rawDel = (k) => tx('readwrite', (s) => s.delete(k));
const rawKeys = () => tx('readonly', (s) => s.getAllKeys());

export function isLocked() {
  return _key === null;
}
export function lock() {
  _key = null;
}

/** Has a passcode ever been set on this device? */
export async function isInitialized() {
  return !!(await rawGet(META));
}

/** First run: set the passcode and seed initial records (if provided). */
export async function setup(passcode, seed = []) {
  const salt = randomSalt();
  _key = await deriveKey(passcode, salt);
  const sentinel = await encryptObj(_key, { ok: true });
  await rawPut(META, { salt: [...salt], sentinel });
  for (const p of seed) await savePatient(p);
}

/** Unlock with an existing passcode. Returns true on success. */
export async function unlock(passcode) {
  const meta = await rawGet(META);
  if (!meta) return false;
  const key = await deriveKey(passcode, new Uint8Array(meta.salt));
  try {
    await decryptObj(key, meta.sentinel);
    _key = key;
    return true;
  } catch {
    return false;
  }
}

export async function savePatient(p) {
  if (!_key) throw new Error('locked');
  await rawPut(p.id, await encryptObj(_key, p));
  return p;
}

export async function deletePatient(id) {
  await rawDel(id);
}

/** Decrypt and return all patients. */
export async function allPatients() {
  if (!_key) throw new Error('locked');
  const keys = (await rawKeys()).filter((k) => k !== META);
  const out = [];
  for (const k of keys) {
    try { out.push(newPatient(await decryptObj(_key, await rawGet(k)))); }
    catch { /* skip unreadable record */ }
  }
  return out;
}

/** Wipe all patient records (keeps the passcode). For the demo reset. */
export async function wipePatients() {
  const keys = (await rawKeys()).filter((k) => k !== META);
  for (const k of keys) await rawDel(k);
}
