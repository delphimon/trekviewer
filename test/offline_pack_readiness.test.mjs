import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { preparedArchiveReadiness, verifiedArchiveResult, acquisitionQueueState } from '../scripts/offline-pack-readiness.mjs';
const routeId = 'rainier-emmons', sha = 'a'.repeat(64);
async function fixture(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-readiness-'));
  const file = path.join(dir, routeId + '.trekpack.tar'), inventoryFile = path.join(dir, routeId + '.inventory.json');
  const inventory = { complete: true, routeId, planId: routeId + '-controlled', routeHash: sha, inventorySha256: sha, sources: 3, archiveBytes: 2048, originalSourceBytes: 1000 };
  const write = value => fs.writeFileSync(inventoryFile, JSON.stringify(value));
  try { await task({ dir, file, inventoryFile, inventory, write }); }
  finally { for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); }
}
it('waits for final filename and complete inventory, including torn inventory writes', async () => {
  await fixture(({ dir, file, inventoryFile, inventory, write }) => {
    write(inventory); fs.writeFileSync(file + '.partial', new Uint8Array(2048));
    expect(preparedArchiveReadiness(dir, routeId).ready).toBe(false);
    fs.renameSync(file + '.partial', file); fs.writeFileSync(inventoryFile, '{');
    expect(preparedArchiveReadiness(dir, routeId).ready).toBe(false);
    write({ ...inventory, complete: false }); expect(preparedArchiveReadiness(dir, routeId).ready).toBe(false);
    write(inventory); expect(preparedArchiveReadiness(dir, routeId)).toEqual({ ready: true, file, inventory });
  });
});
it.each([{ routeId: 'other' }, { archiveBytes: 4096 }, { sources: 0 }, { inventorySha256: 'broken' }])('does not schedule mismatched publication %j', async changed => {
  await fixture(({ dir, file, inventory, write }) => {
    fs.writeFileSync(file, new Uint8Array(2048)); write({ ...inventory, ...changed });
    expect(preparedArchiveReadiness(dir, routeId).ready).toBe(false);
  });
});
it('bounds inventory reads before parsing untrusted status data', async () => {
  await fixture(({ dir, file, inventoryFile }) => {
    fs.writeFileSync(file, new Uint8Array(2048)); fs.writeFileSync(inventoryFile, ' '.repeat(65537));
    expect(preparedArchiveReadiness(dir, routeId).ready).toBe(false);
  });
});
it('never treats an old verification report as success after a failed verifier run', async () => {
  await fixture(({ dir, file, inventory, write }) => {
    fs.writeFileSync(file, new Uint8Array(2048)); write(inventory);
    const ready = preparedArchiveReadiness(dir, routeId);
    const report = { ...inventory, phase: 'verified', sources: 3, validated: 3, archiveSha256: sha,
      file, externalRequests: 0, nativeFileHandle: true, originalSourceBytes: 1000 };
    fs.writeFileSync(path.join(dir, routeId + '.verified.json'), JSON.stringify(report));
    expect(() => verifiedArchiveResult(dir, ready, 1)).toThrow('exited 1');
    expect(verifiedArchiveResult(dir, ready, 0).state).toBe('verified');
    fs.writeFileSync(path.join(dir, routeId + '.verified.json'), JSON.stringify({ ...report, validated: 2 }));
    expect(() => verifiedArchiveResult(dir, ready, 0)).toThrow('does not match');
  });
});
it('reports terminal acquisition state without requiring or modifying its process', async () => {
  await fixture(({ dir }) => {
    expect(acquisitionQueueState(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'defaults.progress.json'), JSON.stringify({ state: 'unfinished' }));
    expect(acquisitionQueueState(dir)).toBe('unfinished');
  });
});
