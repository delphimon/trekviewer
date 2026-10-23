import fs from 'node:fs';
import path from 'node:path';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function json(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw Error('Invalid bounded status file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Publication readiness only, never source verification. A TAR can appear
 * before the producer's complete inventory write; wait for both to agree. */
export function preparedArchiveReadiness(directory, routeId) {
  const file = path.join(directory, routeId + '.trekpack.tar');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return { ready: false, reason: 'Archive is not a regular file' };
    const inventory = json(path.join(directory, routeId + '.inventory.json'));
    if (inventory.complete !== true) return { ready: false, reason: 'Waiting for the complete inventory' };
    if (inventory.routeId !== routeId || typeof inventory.planId !== 'string' || !hash(inventory.routeHash)
      || !hash(inventory.inventorySha256) || !Number.isSafeInteger(inventory.sources) || inventory.sources < 1 || inventory.sources > 20000
      || !Number.isSafeInteger(inventory.originalSourceBytes) || inventory.originalSourceBytes < 1
      || !Number.isSafeInteger(inventory.archiveBytes) || inventory.archiveBytes < 2048 || inventory.archiveBytes !== stat.size) {
      return { ready: false, reason: 'Archive and publication inventory disagree' };
    }
    return { ready: true, file: path.resolve(file), inventory };
  } catch (error) {
    return { ready: false, reason: error.code === 'ENOENT' ? 'Waiting for the completed archive and inventory' : 'Publication metadata is unavailable or incomplete' };
  }
}

export function verifiedArchiveResult(directory, ready, exitCode) {
  if (exitCode !== 0) throw Error(`Archive verifier exited ${exitCode}`);
  const inventory = ready.inventory, file = path.join(directory, inventory.routeId + '.verified.json');
  const report = json(file);
  if (report.phase !== 'verified' || report.routeId !== inventory.routeId || report.planId !== inventory.planId
    || report.routeHash !== inventory.routeHash || report.inventorySha256 !== inventory.inventorySha256
    || report.validated !== inventory.sources || report.sources !== inventory.sources
    || report.archiveBytes !== inventory.archiveBytes || report.originalSourceBytes !== inventory.originalSourceBytes || path.resolve(report.file ?? '') !== ready.file
    || !hash(report.archiveSha256) || report.externalRequests !== 0 || report.nativeFileHandle !== true) {
    throw Error('Verifier result does not match the completed archive');
  }
  return { routeId: report.routeId, state: 'verified', sources: report.validated, archiveBytes: report.archiveBytes,
    originalSourceBytes: report.originalSourceBytes, archiveSha256: report.archiveSha256, report: path.resolve(file) };
}

export function acquisitionQueueState(directory) {
  try { return json(path.join(directory, 'defaults.progress.json')).state; } catch { return undefined; }
}
