import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openOfflinePackFile } from './offline-pack-file.mjs';
import { inspectOfflineArchive, offlineArchiveSource } from '../src/offline/OfflineArchive.ts';

/** Check an assembled local archive without downloading/re-encoding bodies.
 * Source coverage was checked by its completed producer and is independently
 * checked again by the native-browser verifier after publication. */
export async function inspectAssembledArchive(file, plan, signal, onProgress = () => {}) {
  const reader = openOfflinePackFile(file);
  try {
    const index = await inspectOfflineArchive(reader, signal);
    const source = await offlineArchiveSource(reader, index, plan, signal);
    const header = new Uint8Array(await reader.slice(0, 512).arrayBuffer());
    const manifestBytes = parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim(), 8);
    const manifestSha256 = createHash('sha256').update(new Uint8Array(await reader.slice(512, 512 + manifestBytes).arrayBuffer())).digest('hex');
    const report = { planId: plan.id, routeId: plan.routeId, routeHash: plan.routeHash,
      inventorySha256: index.manifest.inventorySha256, archiveBytes: reader.size, manifestSha256,
      sources: index.manifest.records.length, checked: 0, originalSourceBytes: 0, storedSourceBytes: 0,
      lastSourceOffset: index.offsets.at(-1), sourceIndexCounts: {} };
    for (const record of index.manifest.records) {
      signal?.throwIfAborted();
      const loaded = await source.load(record.index, signal ?? new AbortController().signal);
      report.checked++; report.originalSourceBytes += loaded.blob.size; report.storedSourceBytes += record.storedBytes;
      report.sourceIndexCounts[record.sourceIndex] = (report.sourceIndexCounts[record.sourceIndex] ?? 0) + 1;
      await onProgress({ ...report });
    }
    signal?.throwIfAborted(); return report;
  } finally { reader.close(); }
}

/** Reuse a published file only after checking the current contract and every
 * stored/original payload. This does not replace production coverage validation. */
export async function inspectPublishedArchive(file, plan, inventory, signal, onProgress) {
  assert.equal(inventory.complete, true, 'Existing archive lacks complete publication metadata');
  assert.equal(inventory.routeId, plan.routeId, 'Existing archive route differs');
  assert.equal(inventory.planId, plan.id, 'Existing archive plan differs');
  assert.equal(inventory.routeHash, plan.routeHash, 'Existing archive GPX differs');
  const report = await inspectAssembledArchive(file, plan, signal, onProgress);
  for (const key of ['inventorySha256', 'archiveBytes', 'manifestSha256', 'sources', 'originalSourceBytes']) {
    assert.equal(inventory[key], report[key], `Existing archive publication mismatch: ${key}`);
  }
  return report;
}
