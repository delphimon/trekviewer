import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Independent pre-transfer verification: production browser import primitives,
 * followed by a bounded streaming fingerprint of the unchanged local file. */
export async function verifyOfflineRoutePack(validator, file, plan, options = {}) {
  const { signal, onProgress = () => {} } = options;
  signal?.throwIfAborted();
  const before = fs.statSync(file, { bigint: true });
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid route-pack file');
  const checked = await validator.verifyArchive(file, plan, signal, onProgress);
  signal?.throwIfAborted();
  await onProgress({ ...checked, phase: 'hashing-archive' });
  const hash = createHash('sha256'); let hashedBytes = 0;
  // Stream bytes rather than constructing a whole-file Blob/Buffer in Node.
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024, signal })) {
    signal?.throwIfAborted(); hash.update(chunk); hashedBytes += chunk.length;
  }
  signal?.throwIfAborted();
  const after = fs.statSync(file, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== after.ino
    || BigInt(hashedBytes) !== before.size || checked.archiveBytes !== hashedBytes) throw Error('Route-pack file changed during verification');
  return { ...checked, phase: 'verified', planId: plan.id, routeId: plan.routeId, routeHash: plan.routeHash,
    archiveSha256: hash.digest('hex'), verifiedAt: new Date().toISOString(),
    condition: 'PC pre-transfer verification using a native browser File, current-plan provenance, all stored/original hashes, decompression and production source coverage. Not a browser installation, offline tour or native acceptance.' };
}
