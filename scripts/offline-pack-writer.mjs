import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openOfflinePackFile } from './offline-pack-file.mjs';
import { archiveInventoryHash, archiveSourceName, tarHeader, tarPaddedSize, PACK_MANIFEST_NAME, PACK_MANIFEST_LIMIT,
  inspectOfflineArchive } from '../src/offline/OfflineArchive.ts';

/** All inputs were already validated; rehash each bounded body while writing.
 * Publish the final filename only after sync and a complete header/index check. */
export async function writeOfflineRouteArchive(plan, records, files, final, signal, checkpoint = () => signal?.throwIfAborted()) {
  assert.equal(records.length, plan.resources.length); assert.equal(files.length, records.length);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { format: 'trekviewer-route-pack', version: 1, planId: plan.id, routeId: plan.routeId, routeHash: plan.routeHash,
    inventorySha256: await archiveInventoryHash(plan), records };
  const json = Buffer.from(JSON.stringify(manifest)); assert.ok(json.length <= PACK_MANIFEST_LIMIT);
  const exactBytes = 512 + tarPaddedSize(json.length) + records.reduce((n, r) => n + 512 + tarPaddedSize(r.storedBytes), 0) + 1024;
  assert.ok(!fs.existsSync(final), 'Output already exists; choose another --out directory');
  const s = fs.statfsSync(path.dirname(final), { bigint: true });
  assert.ok(s.bavail * s.bsize >= BigInt(exactBytes) + 512n * 1024n * 1024n, 'Not enough disk space for the exact archive size plus headroom');
  const partial = final + '.partial';
  if (fs.existsSync(partial)) assert.ok(!fs.lstatSync(partial).isSymbolicLink(), 'Unsafe partial output path');
  const fd = fs.openSync(partial, 'w');
  try {
    fs.writeFileSync(fd, tarHeader(PACK_MANIFEST_NAME, json.length)); fs.writeFileSync(fd, json); fs.writeFileSync(fd, new Uint8Array(tarPaddedSize(json.length) - json.length));
    for (const r of records) {
      checkpoint();
      assert.ok(r.storedBytes > 0 && r.storedBytes <= 32 * 1024 * 1024); assert.equal(fs.statSync(files[r.index]).size, r.storedBytes);
      const bytes = fs.readFileSync(files[r.index]); assert.equal(sha(bytes), r.storedSha256, 'Cached source changed during preparation');
      fs.writeFileSync(fd, tarHeader(archiveSourceName(r), r.storedBytes)); fs.writeFileSync(fd, bytes); fs.writeFileSync(fd, new Uint8Array(tarPaddedSize(r.storedBytes) - r.storedBytes));
    }
    fs.writeFileSync(fd, new Uint8Array(1024)); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  assert.equal(fs.statSync(partial).size, exactBytes);
  const indexFile = openOfflinePackFile(partial);
  try { await inspectOfflineArchive(indexFile, signal); } finally { indexFile.close(); }
  checkpoint(); fs.renameSync(partial, final);
  return { archiveBytes: exactBytes, originalSourceBytes: records.reduce((n, r) => n + r.bytes, 0), manifestSha256: sha(json) };
}
