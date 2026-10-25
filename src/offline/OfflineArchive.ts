import { readBoundedBlob } from '../terrain/PersistentResourceCache.ts';
import { sha256, type OfflinePlan } from './OfflinePlan.ts';
import { hashOfflineBlob, OfflineStore, type OfflineAsset } from './OfflineStore.ts';
import { offlineSourceIdentity } from './OfflineSourceIdentity.ts';

export const PACK_MANIFEST_NAME = 'trekviewer-pack.json';
export const PACK_MANIFEST_LIMIT = 8 * 1024 * 1024;
const SOURCE_LIMIT = 32 * 1024 * 1024;
export interface ArchiveRecord {
  index: number; sourceIndex: number; encoding: 'identity' | 'gzip';
  bytes: number; sha256: string; storedBytes: number; storedSha256: string;
  sourceRequestSha256: string; sourceBounds?: number[];
}
export interface ArchiveManifest {
  format: 'trekviewer-route-pack'; version: 1;
  planId: string; routeId: string; routeHash: string; inventorySha256: string;
  records: ArchiveRecord[];
}
export interface ArchiveIndex { manifest: ArchiveManifest; offsets: number[] }
export const archiveSourceName = (record: ArchiveRecord) => `sources/${String(record.index).padStart(6, '0')}.bin${record.encoding === 'gzip' ? '.gz' : ''}`;
export const tarPaddedSize = (size: number) => Math.ceil(size / 512) * 512;
const text = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const hashPattern = /^[a-f0-9]{64}$/;
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const paused = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Import paused. Reselect the pack file to resume.', 'AbortError'); };

/** Bind an archive to the entire current source/layout contract, not just GPX. */
export async function archiveInventoryHash(plan: OfflinePlan): Promise<string> {
  return sha256(text.encode(JSON.stringify(plan.resources.map(r => [r.kind, r.width, r.height, r.requiredWindow ?? null, r.urls.map(offlineSourceIdentity)]))).buffer);
}

export async function archiveRequestProvenance(url: string): Promise<Pick<ArchiveRecord, 'sourceRequestSha256' | 'sourceBounds'>> {
  const u = new URL(url), sourceBounds = u.origin === 'https://elevation.nationalmap.gov'
    && u.pathname === '/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
    && u.searchParams.get('bboxSR') === '3857' && u.searchParams.get('imageSR') === '3857'
    ? u.searchParams.get('bbox')!.split(',').map(Number) : undefined;
  return { sourceRequestSha256: await sha256(text.encode(url).buffer), sourceBounds };
}

/** Restricted regular-file USTAR headers. No extraction, links or extensions. */
export function tarHeader(name: string, size: number): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9/._-]{1,99}$/.test(name) || !integer(size, SOURCE_LIMIT)) throw Error('Invalid pack member');
  const header = new Uint8Array(512);
  const put = (offset: number, value: string) => header.set(text.encode(value), offset);
  put(0, name); put(100, '0000644\0'); put(108, '0000000\0'); put(116, '0000000\0');
  put(124, size.toString(8).padStart(11, '0') + '\0'); put(136, '00000000000\0');
  put(148, '        '); put(156, '0'); put(257, 'ustar\0'); put(263, '00');
  const sum = header.reduce((n, v) => n + v, 0);
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function readTarHeader(header: Uint8Array): { name: string; size: number } {
  if (header.length !== 512) throw Error('Truncated pack header');
  const field = (offset: number, length: number) => decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/s, '').trim();
  const octal = (offset: number, length: number) => {
    const value = field(offset, length);
    if (!/^[0-7]+$/.test(value)) throw Error('Invalid pack header number');
    return parseInt(value, 8);
  };
  const sum = header.reduce((n, v, i) => n + (i >= 148 && i < 156 ? 32 : v), 0);
  if (sum !== octal(148, 8) || decoder.decode(header.subarray(257, 265)) !== ('ustar\0' + '00')
    || header[156] !== 48 || header.subarray(157, 257).some(v => v) || header.subarray(345).some(v => v)) throw Error('Unsupported or damaged pack header');
  const name = field(0, 100), size = octal(124, 12);
  if (!integer(size, SOURCE_LIMIT)) throw Error('Pack member is too large');
  return { name, size };
}

function parseManifest(bytes: ArrayBuffer): ArchiveManifest {
  const m = JSON.parse(decoder.decode(bytes)) as ArchiveManifest;
  if (!m || m.format !== 'trekviewer-route-pack' || m.version !== 1 || typeof m.planId !== 'string' || m.planId.length > 200
    || typeof m.routeId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(m.routeId) || !hashPattern.test(m.routeHash)
    || !hashPattern.test(m.inventorySha256) || !Array.isArray(m.records) || !m.records.length || m.records.length > 20000) throw Error('Unsupported route pack manifest');
  for (let i = 0; i < m.records.length; i++) {
    const r = m.records[i];
    if (!r || r.index !== i || !integer(r.sourceIndex, 16) || !['identity', 'gzip'].includes(r.encoding)
      || !integer(r.bytes, SOURCE_LIMIT) || !r.bytes || !integer(r.storedBytes, SOURCE_LIMIT) || !r.storedBytes
      || !hashPattern.test(r.sha256) || !hashPattern.test(r.storedSha256) || !hashPattern.test(r.sourceRequestSha256)
      || (r.sourceBounds !== undefined && (!Array.isArray(r.sourceBounds) || r.sourceBounds.length !== 4 || r.sourceBounds.some(v => !Number.isFinite(v) || Math.abs(v) > 3e7)))
      || (r.encoding === 'identity' && (r.bytes !== r.storedBytes || r.sha256 !== r.storedSha256))) throw Error('Invalid route pack source record');
  }
  return m;
}

/** Read only bounded metadata/headers using file offsets, even for multi-GB TARs. */
export async function inspectOfflineArchive(file: Blob, signal?: AbortSignal): Promise<ArchiveIndex> {
  paused(signal);
  if (!Number.isSafeInteger(file.size) || file.size < 2048) throw Error('Incomplete route pack');
  const first = readTarHeader(new Uint8Array(await file.slice(0, 512).arrayBuffer()));
  if (first.name !== PACK_MANIFEST_NAME || !first.size || first.size > PACK_MANIFEST_LIMIT) throw Error('Missing or oversized route pack manifest');
  const manifest = parseManifest(await file.slice(512, 512 + first.size).arrayBuffer()), offsets: number[] = [];
  let cursor = 512 + tarPaddedSize(first.size);
  for (const record of manifest.records) {
    paused(signal);
    const header = readTarHeader(new Uint8Array(await file.slice(cursor, cursor + 512).arrayBuffer()));
    if (header.name !== archiveSourceName(record) || header.size !== record.storedBytes) throw Error('Route pack member does not match its manifest');
    offsets.push(cursor + 512); cursor += 512 + tarPaddedSize(record.storedBytes);
    if (!Number.isSafeInteger(cursor) || cursor + 1024 > file.size) throw Error('Truncated route pack');
  }
  if (cursor + 1024 !== file.size || new Uint8Array(await file.slice(cursor).arrayBuffer()).some(v => v)) throw Error('Invalid route pack ending');
  paused(signal);
  return { manifest, offsets };
}

/** File sources never choose arbitrary URLs: aliases come from the current plan. */
export async function offlineArchiveSource(file: Blob, index: ArchiveIndex, plan: OfflinePlan, signal?: AbortSignal) {
  paused(signal);
  const m = index.manifest;
  if (m.planId !== plan.id || m.routeId !== plan.routeId || m.routeHash !== plan.routeHash
    || m.records.length !== plan.resources.length || m.inventorySha256 !== await archiveInventoryHash(plan)) throw Error('Pack does not match this route and terrain version');
  for (const r of m.records) {
    const resource = plan.resources[r.index];
    if (r.sourceIndex >= resource.urls.length || r.bytes > (resource.kind === 'image' ? 8 * 1024 * 1024 : SOURCE_LIMIT)
      || (r.encoding === 'gzip' && resource.kind !== 'elevation')) throw Error('Unsupported route pack source');
  }
  const sourceUrls: string[] = [];
  for (const r of m.records) {
    paused(signal);
    const alias = plan.resources[r.index].urls[r.sourceIndex], actual = new URL(alias);
    if (r.sourceBounds) actual.searchParams.set('bbox', r.sourceBounds.join(','));
    const url = r.sourceBounds ? actual.href : alias;
    if (offlineSourceIdentity(url) !== offlineSourceIdentity(alias) || await sha256(text.encode(url).buffer) !== r.sourceRequestSha256) throw Error('Pack source request provenance does not match');
    sourceUrls.push(url);
  }
  paused(signal);
  return { message: 'Importing route pack', async load(position: number, signal: AbortSignal, retained?: OfflineAsset) {
    paused(signal);
    const r = m.records[position], resource = plan.resources[position];
    const stored = file.slice(index.offsets[position], index.offsets[position] + r.storedBytes);
    if (await hashOfflineBlob(stored) !== r.storedSha256) throw Error(`Pack source ${position + 1} failed its stored hash`);
    // Still verify stored archive bytes on resume, but avoid a second decode and
    // write when the retained original already matches this manifest exactly.
    let blob = retained?.bytes === r.bytes && retained.sha256 === r.sha256 ? retained.blob : stored;
    if (blob === stored && r.encoding === 'gzip') {
      if (typeof DecompressionStream === 'undefined') throw Error('This browser cannot import compressed elevation. Use an uncompressed pack.');
      blob = await readBoundedBlob(new Response(stored.stream().pipeThrough(new DecompressionStream('gzip'))), r.bytes);
    }
    if (blob.size !== r.bytes || await hashOfflineBlob(blob) !== r.sha256) throw Error(`Pack source ${position + 1} failed its original hash`);
    paused(signal);
    return { blob, sourceUrl: sourceUrls[position] };
  } };
}

/**
 * Assemble a portable USTAR `.tar` route pack Blob directly from a committed pack in `OfflineStore`
 * without copying stored Blob payloads in memory.
 */
export async function exportOfflineArchive(plan: OfflinePlan, signal?: AbortSignal): Promise<Blob> {
  paused(signal);
  const state = await OfflineStore.state(plan.id);
  if (!state || state.state !== 'ready') throw Error('Offline pack is not ready for export.');
  const records: ArchiveRecord[] = [];
  const bodies: Blob[] = [];
  for (let index = 0; index < plan.resources.length; index++) {
    paused(signal);
    const resource = plan.resources[index];
    const asset = await OfflineStore.stored(plan.id, resource);
    if (!asset || asset.blob.size !== asset.bytes || !hashPattern.test(asset.sha256)) {
      throw Error(`Pack source ${index + 1} is missing or invalid in storage.`);
    }
    const sourceId = offlineSourceIdentity(asset.sourceUrl);
    const foundIdx = resource.urls.findIndex(u => u === asset.sourceUrl || offlineSourceIdentity(u) === sourceId);
    if (foundIdx < 0) throw Error(`Pack source ${index + 1} does not match the current route plan.`);
    const provenance = await archiveRequestProvenance(asset.sourceUrl);
    records.push({
      index,
      sourceIndex: foundIdx,
      encoding: 'identity',
      bytes: asset.bytes,
      sha256: asset.sha256,
      storedBytes: asset.bytes,
      storedSha256: asset.sha256,
      ...provenance,
    });
    bodies.push(asset.blob);
  }
  paused(signal);
  const manifest: ArchiveManifest = {
    format: 'trekviewer-route-pack',
    version: 1,
    planId: plan.id,
    routeId: plan.routeId,
    routeHash: plan.routeHash,
    inventorySha256: await archiveInventoryHash(plan),
    records,
  };
  const json = new Blob([JSON.stringify(manifest)]);
  const pad = (len: number) => new Uint8Array(tarPaddedSize(len) - len);
  const parts: BlobPart[] = [tarHeader(PACK_MANIFEST_NAME, json.size), json, pad(json.size)];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    parts.push(tarHeader(archiveSourceName(r), r.storedBytes), bodies[i], pad(r.storedBytes));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}
