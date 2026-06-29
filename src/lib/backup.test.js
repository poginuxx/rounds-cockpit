import { describe, it, expect } from 'vitest';
import {
  createBackup, readBackup, validatePayload, passphraseStrength,
  BackupError, BACKUP_FORMAT, BACKUP_VERSION,
} from './backup.js';
import { newPatient } from './schema.js';

const PASS = 'correct horse battery staple';

function samplePayload() {
  return {
    patients: [
      newPatient({ id: 'p_a', name: 'Aurora Mendoza', na: [138, 132] }),
      newPatient({ id: 'p_b', name: 'Lourdes Reyes', na: [140] }),
    ],
    hospitals: [{ name: 'Region 1 Medical Center', abbr: 'R1MC' }],
  };
}

describe('validatePayload', () => {
  it('accepts a structurally valid vault (incl. empty patient list)', () => {
    expect(validatePayload(samplePayload())).toBe(true);
    expect(validatePayload({ patients: [], hospitals: [] })).toBe(true);
  });
  it('rejects non-vault objects', () => {
    expect(validatePayload(null)).toBe(false);
    expect(validatePayload({})).toBe(false);
    expect(validatePayload([])).toBe(false);
    expect(validatePayload({ patients: 'x', hospitals: [] })).toBe(false);
    expect(validatePayload({ patients: [], hospitals: 'x' })).toBe(false);
    expect(validatePayload({ patients: [{ name: 'no id' }], hospitals: [] })).toBe(false);
  });
});

describe('passphraseStrength', () => {
  it('accepts a strong passphrase', () => {
    expect(passphraseStrength(PASS).ok).toBe(true);
    expect(passphraseStrength('aVeryLongPassword1').ok).toBe(true);
  });
  it('rejects the daily 6-digit passcode and weak input', () => {
    expect(passphraseStrength('123456').ok).toBe(false);
    expect(passphraseStrength('short').ok).toBe(false);
    expect(passphraseStrength('').ok).toBe(false);
  });
});

describe('createBackup envelope', () => {
  it('produces a versioned, fully-encrypted envelope with no plaintext patient data', async () => {
    const env = await createBackup(samplePayload(), PASS);
    expect(env.format).toBe(BACKUP_FORMAT);
    expect(env.version).toBe(BACKUP_VERSION);
    expect(env.patientCount).toBe(2);
    expect(env.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(env.kdf.salt.length).toBe(16);
    expect(env.cipher.iv.length).toBe(12);
    // The serialized file must not leak any name from the payload.
    const text = JSON.stringify(env);
    expect(text).not.toContain('Aurora');
    expect(text).not.toContain('Lourdes');
    expect(text).not.toContain('Region 1');
  });
  it('refuses to back up an invalid vault', async () => {
    await expect(createBackup({ bogus: true }, PASS)).rejects.toMatchObject({ code: 'bad-payload' });
  });
});

describe('round-trip export -> restore', () => {
  it('yields identical data', async () => {
    const payload = samplePayload();
    const env = await createBackup(payload, PASS);
    const back = await readBackup(env, PASS);
    expect(back).toEqual(payload);
  });
  it('round-trips through the JSON file text too', async () => {
    const payload = samplePayload();
    const text = JSON.stringify(await createBackup(payload, PASS));
    const back = await readBackup(text, PASS);
    expect(back).toEqual(payload);
  });
});

describe('failure modes (each throws a typed error, changes nothing)', () => {
  it('wrong passphrase rejected', async () => {
    const env = await createBackup(samplePayload(), PASS);
    await expect(readBackup(env, 'wrong passphrase entirely'))
      .rejects.toMatchObject({ name: 'BackupError', code: 'wrong-passphrase' });
  });

  it('garbage / non-JSON text rejected as corrupt', async () => {
    await expect(readBackup('}{ not json at all', PASS))
      .rejects.toMatchObject({ code: 'corrupt' });
  });

  it('tampered ciphertext rejected', async () => {
    const env = await createBackup(samplePayload(), PASS);
    env.cipher.ct[0] = (env.cipher.ct[0] + 1) % 256;
    await expect(readBackup(env, PASS)).rejects.toBeInstanceOf(BackupError);
  });

  it('missing / wrong header rejected as bad-format', async () => {
    await expect(readBackup({ hello: 'world' }, PASS))
      .rejects.toMatchObject({ code: 'bad-format' });
    const env = await createBackup(samplePayload(), PASS);
    delete env.format;
    await expect(readBackup(env, PASS)).rejects.toMatchObject({ code: 'bad-format' });
  });

  it('newer version handled as bad-version', async () => {
    const env = await createBackup(samplePayload(), PASS);
    env.version = BACKUP_VERSION + 1;
    await expect(readBackup(env, PASS)).rejects.toMatchObject({ code: 'bad-version' });
  });

  it('valid envelope whose payload is not a vault rejected as bad-payload', async () => {
    // Hand-build an envelope around a non-vault payload to exercise the post-decrypt check.
    const { deriveBackupKey, encryptObj, randomSalt, BACKUP_ITERATIONS } = await import('./crypto.js');
    const salt = randomSalt();
    const key = await deriveBackupKey(PASS, salt, BACKUP_ITERATIONS);
    const env = {
      format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(),
      patientCount: 0, kdf: { salt: [...salt], iterations: BACKUP_ITERATIONS, hash: 'SHA-256' },
      cipher: await encryptObj(key, { not: 'a vault' }),
    };
    await expect(readBackup(env, PASS)).rejects.toMatchObject({ code: 'bad-payload' });
  });
});
