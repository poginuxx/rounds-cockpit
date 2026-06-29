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
const HOSPITALS = '__hospitals';
const PRERESTORE = '__prerestore'; // snapshot of the vault taken just before a restore
const LASTBACKUP = '__lastbackup'; // non-secret timestamp of the last successful export
// Reserved keys hold app data (not patient records). allPatients() must skip them
// so they are never decrypted as patients.
const RESERVED = new Set([META, HOSPITALS, PRERESTORE, LASTBACKUP]);

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
  const keys = (await rawKeys()).filter((k) => !RESERVED.has(k));
  const out = [];
  for (const k of keys) {
    try { out.push(newPatient(await decryptObj(_key, await rawGet(k)))); }
    catch { /* skip unreadable record */ }
  }
  return out;
}

/** Wipe all patient records (keeps the passcode AND the managed hospital list). */
export async function wipePatients() {
  const keys = (await rawKeys()).filter((k) => !RESERVED.has(k));
  for (const k of keys) await rawDel(k);
}

/**
 * The user-managed hospital list (encrypted like everything else). Returns the
 * stored array, or null if none has been saved yet (first run → caller seeds).
 */
export async function getHospitals() {
  if (!_key) throw new Error('locked');
  const blob = await rawGet(HOSPITALS);
  if (!blob) return null;
  try { return await decryptObj(_key, blob); }
  catch { return null; }
}

/** Persist the hospital list (encrypted). */
export async function setHospitals(list) {
  if (!_key) throw new Error('locked');
  await rawPut(HOSPITALS, await encryptObj(_key, list));
  return list;
}

// ============================ backup / restore ============================
// These support the encrypted backup feature. The envelope crypto lives in
// backup.js (pure); here we only read the live vault and atomically replace it,
// always snapshotting the current data first so a restore is undoable.

const patientKeys = async () => (await rawKeys()).filter((k) => !RESERVED.has(k));

/** Snapshot of the CURRENT vault as raw (already-encrypted) blobs — no decryption,
 *  so the ciphertext is preserved exactly. Used as the pre-restore safety net. */
async function rawSnapshot() {
  const records = {};
  for (const k of await patientKeys()) records[k] = await rawGet(k);
  return { records, hospitals: (await rawGet(HOSPITALS)) || null, savedAt: Date.now() };
}

/** Wipe every non-reserved (patient) key, then restore a set of raw blobs. */
async function restoreRaw(snapshot) {
  for (const k of await patientKeys()) await rawDel(k);
  for (const [k, blob] of Object.entries(snapshot.records)) await rawPut(k, blob);
  if (snapshot.hospitals) await rawPut(HOSPITALS, snapshot.hospitals);
  else await rawDel(HOSPITALS);
}

/**
 * Replace the live vault with restored data. Order matters for safety:
 *  1. snapshot the current vault (raw ciphertext) into __prerestore — undo target;
 *  2. wipe the current patient records;
 *  3. write the restored patients + hospital list, re-encrypted under the CURRENT
 *     on-device key (so this also works right after a fresh-device passcode setup).
 * The on-device passcode/key is never touched. Returns the restored patient count.
 */
export async function replaceVault(patients, hospitals) {
  if (!_key) throw new Error('locked');
  await rawPut(PRERESTORE, await rawSnapshot());
  for (const k of await patientKeys()) await rawDel(k);
  for (const p of patients) await rawPut(p.id, await encryptObj(_key, p));
  await rawPut(HOSPITALS, await encryptObj(_key, hospitals || []));
  return patients.length;
}

/** Is there a pre-restore snapshot to undo back to? */
export async function hasPrerestore() {
  return !!(await rawGet(PRERESTORE));
}

/** Undo the most recent restore: put the snapshotted vault back, drop the snapshot.
 *  Returns true if a snapshot existed and was restored. */
export async function undoRestore() {
  const snap = await rawGet(PRERESTORE);
  if (!snap) return false;
  await restoreRaw(snap);
  await rawDel(PRERESTORE);
  return true;
}

/** Drop the pre-restore snapshot once the user is satisfied (no longer undoable). */
export async function clearPrerestore() {
  await rawDel(PRERESTORE);
}

/** Non-secret timestamp (ms) of the last successful export, or null. Stored in
 *  the clear deliberately — it carries no patient data. */
export async function getLastBackupAt() {
  return (await rawGet(LASTBACKUP)) ?? null;
}
export async function setLastBackupAt(ts) {
  await rawPut(LASTBACKUP, ts);
}
