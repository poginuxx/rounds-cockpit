import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from './store.js';
import { newPatient } from './schema.js';

beforeEach(async () => {
  store.lock();
  store._close();
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase('rounds_cockpit');
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
});

describe('encrypted store round-trip', () => {
  it('sets a passcode, seeds, and reads patients back', async () => {
    await store.setup('123456', [newPatient({ id: 'p_x', name: 'Test One', na: [138] })]);
    const all = await store.allPatients();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Test One');
  });

  it('rejects a wrong passcode and accepts the right one', async () => {
    await store.setup('123456', []);
    store.lock();
    expect(await store.unlock('000000')).toBe(false);
    expect(store.isLocked()).toBe(true);
    expect(await store.unlock('123456')).toBe(true);
    expect(store.isLocked()).toBe(false);
  });

  it('persists changes to a patient', async () => {
    await store.setup('123456', [newPatient({ id: 'p_y', name: 'Edit Me', na: [140] })]);
    const [p] = await store.allPatients();
    p.na = [140, 132];
    await store.savePatient(p);
    const [reloaded] = await store.allPatients();
    expect(reloaded.na).toEqual([140, 132]);
  });

  it('throws when saving while locked', async () => {
    store.lock();
    await expect(store.savePatient(newPatient({ id: 'p_z' }))).rejects.toThrow('locked');
  });
});

describe('backup: replaceVault / undoRestore', () => {
  it('replaces the vault, snapshots the prior data, and undo restores it', async () => {
    await store.setup('123456', [
      newPatient({ id: 'old1', name: 'Old One', na: [138] }),
      newPatient({ id: 'old2', name: 'Old Two', na: [140] }),
    ]);
    await store.setHospitals([{ name: 'Old Hospital', abbr: 'OH' }]);
    expect(await store.hasPrerestore()).toBe(false);

    const restored = [newPatient({ id: 'new1', name: 'New One', na: [130] })];
    const count = await store.replaceVault(restored, [{ name: 'New Hospital', abbr: 'NH' }]);
    expect(count).toBe(1);

    // Live vault is now the restored data, re-encrypted under the current key.
    let all = await store.allPatients();
    expect(all.map((p) => p.id).sort()).toEqual(['new1']);
    expect((await store.getHospitals())[0].abbr).toBe('NH');
    expect(await store.hasPrerestore()).toBe(true);

    // Undo brings back the exact prior patients AND hospital list.
    expect(await store.undoRestore()).toBe(true);
    all = await store.allPatients();
    expect(all.map((p) => p.id).sort()).toEqual(['old1', 'old2']);
    expect((await store.getHospitals())[0].abbr).toBe('OH');
    expect(await store.hasPrerestore()).toBe(false);
    expect(await store.undoRestore()).toBe(false); // nothing left to undo
  });

  it('current passcode still unlocks after a replace (records re-encrypted)', async () => {
    await store.setup('123456', [newPatient({ id: 'old1', name: 'Old One' })]);
    await store.replaceVault([newPatient({ id: 'new1', name: 'New One' })], []);
    store.lock();
    store._close();
    expect(await store.unlock('123456')).toBe(true);
    const all = await store.allPatients();
    expect(all.map((p) => p.id)).toEqual(['new1']);
  });

  it('fresh-device path: restore into a brand-new empty vault', async () => {
    await store.setup('999999', []); // new install, new passcode, no data
    expect(await store.allPatients()).toHaveLength(0);
    await store.replaceVault([
      newPatient({ id: 'r1', name: 'Restored', na: [136] }),
    ], [{ name: 'Region 1 Medical Center', abbr: 'R1MC' }]);
    const all = await store.allPatients();
    expect(all.map((p) => p.id)).toEqual(['r1']);
    expect((await store.getHospitals())[0].abbr).toBe('R1MC');
  });

  it('tracks a non-secret lastBackupAt timestamp', async () => {
    await store.setup('123456', []);
    expect(await store.getLastBackupAt()).toBe(null);
    await store.setLastBackupAt(1700000000000);
    expect(await store.getLastBackupAt()).toBe(1700000000000);
  });
});
