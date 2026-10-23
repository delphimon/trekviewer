import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { writeOfflineRouteArchive } from '../scripts/offline-pack-writer.mjs';
import { inspectAssembledArchive, inspectPublishedArchive } from '../scripts/offline-pack-recovery.mjs';
import { archiveRequestProvenance, inspectOfflineArchive } from '../src/offline/OfflineArchive.ts';
import { openOfflinePackFile } from '../scripts/offline-pack-file.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-recovery-')), file = path.join(root, 'controlled.tar');
  const original = [Buffer.from('controlled encoded elevation'), Buffer.from('controlled encoded image')];
  const resources = original.map((_, index) => ({ kind: index ? 'image' : 'elevation', width: 2, height: 2,
    urls: [`https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?controlled=${index}`] }));
  const plan = { id: 'controlled-hash-only', routeId: 'controlled-hash-only', routeHash: 'a'.repeat(64),
    name: 'Payload hash fixture, not source coverage', version: 1, coverage: 'full-model', maxZoom: 19, estimatedBytes: 1000, resources };
  const files = [], records = [];
  try {
    for (let index = 0; index < original.length; index++) {
      const stored = index ? original[index] : gzipSync(original[index]), sourceFile = path.join(root, index + '.bin');
      fs.writeFileSync(sourceFile, stored); files.push(sourceFile);
      records.push({ index, sourceIndex: 0, encoding: index ? 'identity' : 'gzip', bytes: original[index].length, sha256: sha(original[index]),
        storedBytes: stored.length, storedSha256: sha(stored), ...await archiveRequestProvenance(resources[index].urls[0]) });
    }
    await writeOfflineRouteArchive(plan, records, files, file); await task(file, plan, original, records);
  } finally { for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name)); fs.rmdirSync(root); }
}
it('checks exact original and gzip payloads against the current complete contract without editing the file', async () => {
  await fixture(async (file, plan, originals, records) => {
    const before = sha(fs.readFileSync(file)), progress = [];
    const result = await inspectAssembledArchive(file, plan, undefined, value => progress.push(value.checked));
    expect(result.checked).toBe(2); expect(progress).toEqual([1, 2]);
    expect(result.originalSourceBytes).toBe(originals.reduce((n, b) => n + b.length, 0));
    expect(result.storedSourceBytes).toBe(records.reduce((n, r) => n + r.storedBytes, 0));
    expect(sha(fs.readFileSync(file))).toBe(before);
    await expect(inspectAssembledArchive(file, { ...plan, routeHash: 'b'.repeat(64) })).rejects.toThrow('does not match');
  });
});
it('rejects a corrupted assembled payload while preserving its file for diagnosis', async () => {
  await fixture(async (file, plan) => {
    const reader = openOfflinePackFile(file); let offset;
    try { offset = (await inspectOfflineArchive(reader)).offsets[1]; } finally { reader.close(); }
    const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, new Uint8Array([0]), 0, 1, offset); } finally { fs.closeSync(fd); }
    await expect(inspectAssembledArchive(file, plan)).rejects.toThrow('stored hash'); expect(fs.existsSync(file)).toBe(true);
  });
});
it('cancels between bounded bodies without publishing or deleting the assembled input', async () => {
  await fixture(async (file, plan) => {
    const controller = new AbortController(); let count = 0;
    await expect(inspectAssembledArchive(file, plan, controller.signal, () => { count++; controller.abort(); })).rejects.toHaveProperty('name', 'AbortError');
    expect(count).toBe(1); expect(fs.existsSync(file)).toBe(true);
  });
});

it('rechecks a completed publication without rewriting the archive or metadata', async () => {
  await fixture(async (file, plan) => {
    const report = await inspectAssembledArchive(file, plan);
    const inventory = { ...report, complete: true }, before = fs.statSync(file, { bigint: true });
    const value = await inspectPublishedArchive(file, plan, inventory);
    expect(value.checked).toBe(2); expect(value.manifestSha256).toBe(report.manifestSha256);
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(inventory).toEqual({ ...report, complete: true });
  });
});
it('refuses incomplete, stale or mismatched existing publication metadata', async () => {
  await fixture(async (file, plan) => {
    const inventory = { ...await inspectAssembledArchive(file, plan), complete: true };
    for (const changed of [{ complete: false }, { routeId: 'other' }, { planId: 'stale' }, { routeHash: 'b'.repeat(64) },
      { inventorySha256: 'b'.repeat(64) }, { sources: 1 }, { archiveBytes: 2048 }, { manifestSha256: 'b'.repeat(64) }, { originalSourceBytes: 1 }]) {
      await expect(inspectPublishedArchive(file, plan, { ...inventory, ...changed })).rejects.toThrow();
    }
  });
});
it('never reuses a publication whose same-sized source body was corrupted', async () => {
  await fixture(async (file, plan) => {
    const inventory = { ...await inspectAssembledArchive(file, plan), complete: true };
    const reader = openOfflinePackFile(file); let offset;
    try { offset = (await inspectOfflineArchive(reader)).offsets[1]; } finally { reader.close(); }
    const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, new Uint8Array([0]), 0, 1, offset); } finally { fs.closeSync(fd); }
    await expect(inspectPublishedArchive(file, plan, inventory)).rejects.toThrow('stored hash');
  });
});
