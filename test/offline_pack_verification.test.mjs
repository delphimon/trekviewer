import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { verifyOfflineRoutePack } from '../scripts/offline-pack-verification.mjs';

const plan = { id: 'controlled', routeId: 'controlled', routeHash: 'a'.repeat(64) };
async function withFile(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-verification-')), file = path.join(root, 'controlled.tar');
  fs.writeFileSync(file, 'abc');
  try { await task(file); } finally { fs.unlinkSync(file); fs.rmdirSync(root); }
}
it('fingerprints the exact unchanged file only after the browser verifies its sources', async () => {
  await withFile(async file => {
    const phases = []; let checked = false;
    const result = await verifyOfflineRoutePack({ async verifyArchive(actual, current) {
      expect(actual).toBe(file); expect(current).toBe(plan); checked = true;
      return { archiveBytes: 3, validated: 1, nativeFileHandle: true };
    } }, file, plan, { onProgress: value => { expect(checked).toBe(true); phases.push(value.phase); } });
    expect(result.archiveSha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(result.phase).toBe('verified'); expect(phases).toEqual(['hashing-archive']);
  });
});
it('does not proceed to fingerprinting when production source verification fails', async () => {
  await withFile(async file => {
    let progress = 0;
    await expect(verifyOfflineRoutePack({ verifyArchive: async () => { throw Error('Source hash mismatch'); } }, file, plan,
      { onProgress: () => { progress++; } })).rejects.toThrow('Source hash mismatch');
    expect(progress).toBe(0);
  });
});
it('rejects a file changed during source verification', async () => {
  await withFile(async file => {
    await expect(verifyOfflineRoutePack({ async verifyArchive() {
      fs.writeFileSync(file, 'changed archive'); return { archiveBytes: 15 };
    } }, file, plan)).rejects.toThrow('changed during verification');
  });
});
it('rejects disagreement between the browser File and the local streaming size', async () => {
  await withFile(async file => {
    await expect(verifyOfflineRoutePack({ verifyArchive: async () => ({ archiveBytes: 4 }) }, file, plan)).rejects.toThrow('changed during verification');
  });
});
it('honors cancellation before browser work and before streaming a completion fingerprint', async () => {
  await withFile(async file => {
    const before = new AbortController(); before.abort(); let entered = false;
    const validator = { verifyArchive: async () => { entered = true; return { archiveBytes: 3 }; } };
    await expect(verifyOfflineRoutePack(validator, file, plan, { signal: before.signal })).rejects.toHaveProperty('name', 'AbortError');
    expect(entered).toBe(false);
    const after = new AbortController();
    await expect(verifyOfflineRoutePack(validator, file, plan, { signal: after.signal,
      onProgress: () => after.abort() })).rejects.toHaveProperty('name', 'AbortError');
  });
});
