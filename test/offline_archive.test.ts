import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { archiveInventoryHash, archiveSourceName, inspectOfflineArchive, offlineArchiveSource, PACK_MANIFEST_NAME,
  tarHeader, tarPaddedSize, archiveRequestProvenance, type ArchiveManifest, type ArchiveRecord } from '../src/offline/OfflineArchive.ts';
import { hashOfflineBlob } from '../src/offline/OfflineStore.ts';
import type { OfflinePlan } from '../src/offline/OfflinePlan.ts';

const plan: OfflinePlan = { id: 'fixture-v1', routeId: 'fixture', routeHash: 'a'.repeat(64), name: 'Archive fixture',
  version: 1, coverage: 'full-model', maxZoom: 19, estimatedBytes: 1000,
  resources: [{ kind: 'elevation', width: 2, height: 2, urls: ['https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?test=1'] }] };
async function fixture(encoding: 'identity' | 'gzip' = 'identity', original = new Blob(['exact original Float32 source bytes'])) {
  const stored = encoding === 'gzip' ? new Blob([gzipSync(new Uint8Array(await original.arrayBuffer()))]) : original;
  const record: ArchiveRecord = { index: 0, sourceIndex: 0, encoding, bytes: original.size, sha256: await hashOfflineBlob(original),
    storedBytes: stored.size, storedSha256: await hashOfflineBlob(stored), ...await archiveRequestProvenance(plan.resources[0].urls[0]) };
  const manifest: ArchiveManifest = { format: 'trekviewer-route-pack', version: 1, planId: plan.id, routeId: plan.routeId,
    routeHash: plan.routeHash, inventorySha256: await archiveInventoryHash(plan), records: [record] };
  return { manifest, stored, original, record };
}
function tar(manifest: ArchiveManifest, bodies: Blob[], names?: string[]) {
  const json = new Blob([JSON.stringify(manifest)]);
  return new Blob([tarHeader(PACK_MANIFEST_NAME, json.size), json, new Uint8Array(tarPaddedSize(json.size) - json.size),
    ...manifest.records.flatMap((r, i) => [tarHeader(names?.[i] ?? archiveSourceName(r), r.storedBytes), bodies[i], new Uint8Array(tarPaddedSize(r.storedBytes) - r.storedBytes)]), new Uint8Array(1024)]);
}

it.each(['identity', 'gzip'] as const)('restores exact source bytes from %s members', async encoding => {
  const f = await fixture(encoding), file = tar(f.manifest, [f.stored]), index = await inspectOfflineArchive(file);
  const source = await offlineArchiveSource(file, index, plan), loaded = await source.load(0, new AbortController().signal);
  expect(await loaded.blob.text()).toBe(await f.original.text()); expect(loaded.sourceUrl).toBe(plan.resources[0].urls[0]);
});

it('rejects changed route, request layout, source aliases and incomplete plan coverage', async () => {
  const f = await fixture(), file = tar(f.manifest, [f.stored]), index = await inspectOfflineArchive(file);
  for (const changed of [{ ...plan, routeHash: 'b'.repeat(64) }, { ...plan, resources: [{ ...plan.resources[0], width: 3 }] },
    { ...plan, resources: [{ ...plan.resources[0], urls: [plan.resources[0].urls[0] + '&changed=1'] }] }, { ...plan, resources: [] }]) {
    await expect(offlineArchiveSource(file, index, changed)).rejects.toThrow('does not match');
  }
});

it('rejects corrupted member bytes, original hashes and invalid source selection', async () => {
  const f = await fixture(), damaged = new Blob([new Uint8Array(f.stored.size)]);
  const file = tar(f.manifest, [damaged]), source = await offlineArchiveSource(file, await inspectOfflineArchive(file), plan);
  await expect(source.load(0, new AbortController().signal)).rejects.toThrow('stored hash');
  f.manifest.records[0].sourceIndex = 1;
  const changed = tar(f.manifest, [f.stored]);
  await expect(offlineArchiveSource(changed, await inspectOfflineArchive(changed), plan)).rejects.toThrow('Unsupported');
});

it('bounds decompression to declared original size, rejecting gzip expansion', async () => {
  const f = await fixture('gzip', new Blob([new Uint8Array(1024 * 1024)]));
  f.record.bytes = 16;
  const file = tar(f.manifest, [f.stored]), source = await offlineArchiveSource(file, await inspectOfflineArchive(file), plan);
  await expect(source.load(0, new AbortController().signal)).rejects.toThrow();
});

it('rejects truncated archives, extra members and traversal names before import', async () => {
  const f = await fixture(), file = tar(f.manifest, [f.stored]);
  await expect(inspectOfflineArchive(file.slice(0, file.size - 1))).rejects.toThrow();
  await expect(inspectOfflineArchive(new Blob([file, new Uint8Array(512)]))).rejects.toThrow('ending');
  await expect(inspectOfflineArchive(tar(f.manifest, [f.stored], ['../elsewhere']))).rejects.toThrow('member');
  f.manifest.records.push(f.record);
  await expect(inspectOfflineArchive(tar(f.manifest, [f.stored, f.stored]))).rejects.toThrow('record');
});

it('rejects a bad header checksum and oversized manifest before reading bodies', async () => {
  const f = await fixture(), file = tar(f.manifest, [f.stored]), header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  header[0] ^= 1;
  await expect(inspectOfflineArchive(new Blob([header, file.slice(512)]))).rejects.toThrow('header');
  await expect(inspectOfflineArchive(new Blob([tarHeader(PACK_MANIFEST_NAME, 9 * 1024 * 1024), new Uint8Array(1536)]))).rejects.toThrow('oversized');
});

it('supports offsets above 4 GB without allocating or reading the full archive', async () => {
  const f = await fixture();
  f.manifest.records = Array.from({ length: 160 }, (_, index) => ({ ...f.record, index, bytes: 32 * 1024 * 1024, storedBytes: 32 * 1024 * 1024 }));
  const json = new Blob([JSON.stringify(f.manifest)]), blocks = new Map<number, Blob>();
  blocks.set(0, new Blob([tarHeader(PACK_MANIFEST_NAME, json.size)])); blocks.set(512, json);
  let cursor = 512 + tarPaddedSize(json.size), largestRead = 0;
  for (const r of f.manifest.records) { blocks.set(cursor, new Blob([tarHeader(archiveSourceName(r), r.storedBytes)])); cursor += 512 + tarPaddedSize(r.storedBytes); }
  blocks.set(cursor, new Blob([new Uint8Array(1024)]));
  const virtual = { size: cursor + 1024, slice(start: number, end = cursor + 1024) {
    largestRead = Math.max(largestRead, end - start); const block = blocks.get(start); if (!block) throw Error('Unexpected payload read'); return block;
  }, arrayBuffer() { throw Error('Whole archive must never be read'); } } as unknown as Blob;
  const index = await inspectOfflineArchive(virtual);
  expect(index.offsets.at(-1)).toBeGreaterThan(2 ** 32); expect(largestRead).toBeLessThan(100000);
});

it('honors cancellation during header preparation', async () => {
  const f = await fixture();
  await expect(inspectOfflineArchive(tar(f.manifest, [f.stored]), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
});

it('preserves the original PC request and bytes across final-ULP browser coordinate differences', async () => {
  const f = await fixture();
  const pcUrl = plan.resources[0].urls[0] + '&bboxSR=3857&imageSR=3857&bbox=-13547950.402958488%2C5918272.071436257%2C-13546956.33033472%2C5919266.14406156';
  const pc = { ...plan, resources: [{ ...plan.resources[0], urls: [pcUrl] }] };
  const browser = { ...plan, resources: [{ ...plan.resources[0], urls: [pcUrl.replace('5918272.071436257', '5918272.071436258')] }] };
  Object.assign(f.record, await archiveRequestProvenance(pcUrl)); f.manifest.inventorySha256 = await archiveInventoryHash(pc);
  const file = tar(f.manifest, [f.stored]), index = await inspectOfflineArchive(file), source = await offlineArchiveSource(file, index, browser);
  const loaded = await source.load(0, new AbortController().signal);
  expect(loaded.sourceUrl).toBe(pcUrl); expect(await loaded.blob.text()).toBe(await f.original.text());
});
