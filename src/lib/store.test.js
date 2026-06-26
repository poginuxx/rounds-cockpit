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
