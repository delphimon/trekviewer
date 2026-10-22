import { readBoundedBlob } from '../terrain/PersistentResourceCache.ts';
import { runTerrainJob } from '../terrain/TerrainJobs.ts';
import type { DecodedElevation } from '../terrain/LercElevation.ts';
import type { OfflinePlan, OfflineResource } from './OfflinePlan.ts';
import { OfflineStore, hashOfflineBlob, offlineSourceAllowed, type OfflinePackState } from './OfflineStore.ts';
import { requireOfflineCapacity } from './OfflineCapacity.ts';

export async function validateOfflineResource(resource: OfflineResource, blob: Blob, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Download paused', 'AbortError');
  if (resource.kind === 'elevation') {
    const buffer = await blob.arrayBuffer();
    const input = { buffer, width: resource.width, height: resource.height, requiredWindow: resource.requiredWindow };
    const decoded = await runTerrainJob<DecodedElevation>({ kind: 'lerc', input }, async () => {
      const { decodeLercElevation } = await import('../terrain/LercElevation.ts'); return decodeLercElevation(input);
    }, signal, [buffer]);
    const w = resource.requiredWindow;
    const count = w ? (w.maxX - w.minX + 1) * (w.maxY - w.minY + 1) : resource.width * resource.height;
    if ((w ? decoded.requiredValidCount : decoded.validCount) !== count) throw Error('Elevation source has missing terrain coverage.');
  } else {
    const header = new DataView(await blob.slice(0, 24).arrayBuffer());
    if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
      || header.getUint32(16) !== resource.width || header.getUint32(20) !== resource.height) throw Error('Unexpected imagery dimensions or format.');
    const image = await createImageBitmap(blob);
    try {
      if (image.width !== resource.width || image.height !== resource.height) throw Error('Unexpected imagery dimensions.');
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw Error('Image validation unavailable.');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) throw Error('Imagery source has missing coverage.');
      } finally { canvas.width = canvas.height = 1; }
    } finally { image.close(); }
  }
  if (signal?.aborted) throw new DOMException('Download paused', 'AbortError');
}

/** User-started foreground preparation. One bounded acquisition/decoder lane;
 * browser-wide lock prevents competing tabs from corrupting counts or removal.
 * Browser close/Play/XR pauses, and already committed sources survive reload. */
export class OfflineDownloads {
  private static controller: AbortController | undefined;
  public static busy(): boolean { return !!this.controller; }
  public static pause(): void { this.controller?.abort(); }
  public static async withLock<T>(task: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw Error('This browser does not support safe offline downloads.');
    return navigator.locks.request('trekviewer-offline-download', { ifAvailable: true }, async lock => {
      if (!lock) throw Error('Another TrekViewer tab is managing downloads.');
      return task();
    });
  }
  public static async start(plan: OfflinePlan): Promise<void> {
    if (this.busy()) throw Error('A route download is already running.');
    if (!plan.resources.length || new Set(plan.resources.map(r => r.urls[0])).size !== plan.resources.length
      || plan.resources.some(r => !r.urls.length || r.urls.some(url => !offlineSourceAllowed(url)))) throw Error('Invalid offline download inventory.');
    const controller = new AbortController(); this.controller = controller;
    try {
      await this.withLock(async () => {
        const previous = await OfflineStore.state(plan.id);
        if (previous?.state === 'ready') return;
        const persisted = await navigator.storage.persist?.().catch(() => false);
        let state: OfflinePackState = { id: plan.id, routeId: plan.routeId, routeHash: plan.routeHash, name: plan.name,
          state: 'downloading', total: plan.resources.length, completed: previous?.completed ?? 0, bytes: previous?.bytes ?? 0, estimatedBytes: plan.estimatedBytes,
          message: persisted ? 'Downloading • storage persistence granted' : 'Downloading • browser may reclaim storage', updated: Date.now() };
        await OfflineStore.putState(state);
        try {
          let verified = 0, verifiedBytes = 0;
          for (const resource of plan.resources) {
            if (controller.signal.aborted) throw new DOMException('Download paused', 'AbortError');
            const retained = await OfflineStore.stored(plan.id, resource);
            let asset = retained;
            if (asset && (asset.bytes !== asset.blob.size || asset.sha256 !== await hashOfflineBlob(asset.blob))) asset = undefined;
            let blob = asset?.blob, sourceUrl = asset?.sourceUrl ?? '';
            if (!blob) {
              // Check actual shared usage, not the uncompressed planning budget.
              // Already-saved sources can still be verified/published when full.
              await requireOfflineCapacity();
              let lastError: unknown = Error('Source unavailable.');
              for (const url of resource.urls) {
                if (controller.signal.aborted) throw new DOMException('Download paused', 'AbortError');
                const request = new AbortController(), abort = () => request.abort();
                controller.signal.addEventListener('abort', abort, { once: true });
                const timer = setTimeout(abort, 35000);
                try {
                  blob = await readBoundedBlob(await fetch(url, { signal: request.signal, credentials: 'omit' }), resource.kind === 'image' ? 8 * 1024 * 1024 : 32 * 1024 * 1024);
                  await validateOfflineResource(resource, blob, controller.signal); sourceUrl = url; break;
                } catch (error) { blob = undefined; lastError = error; }
                finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
              }
              if (!blob) throw lastError;
            } else {
              // Resume verifies bytes AND source coverage before publication.
              await validateOfflineResource(resource, blob, controller.signal);
            }
            if (controller.signal.aborted) throw new DOMException('Download paused', 'AbortError');
            verified++; verifiedBytes += blob.size;
            if (asset) {
              if (verified % 32 === 0) await OfflineStore.putState({ ...state, message: `Checking saved sources (${verified}/${plan.resources.length})…`, updated: Date.now() });
              continue; // Verified staged bodies are immutable; do not rewrite gigabytes on resume.
            }
            const next = { ...state, completed: state.completed + Number(!retained), bytes: state.bytes + blob.size - (retained?.bytes ?? 0), updated: Date.now() };
            await requireOfflineCapacity(blob.size);
            if (controller.signal.aborted) throw new DOMException('Download paused', 'AbortError');
            await OfflineStore.save(next, resource, sourceUrl, blob, await hashOfflineBlob(blob));
            state = next;
          }
          if (controller.signal.aborted) throw new DOMException('Download paused', 'AbortError');
          await OfflineStore.publish(plan, verified, verifiedBytes);
        } catch (error) {
          await OfflineStore.putState({ ...state, state: 'paused', message: controller.signal.aborted ? 'Paused. Resume keeps completed downloads.'
            : error instanceof DOMException && error.name === 'QuotaExceededError' ? 'Browser storage is full. Free space, then resume.'
            : (error instanceof Error ? error.message : 'Download interrupted. Resume to retry.'), updated: Date.now() });
          if (!controller.signal.aborted) throw error;
        }
      });
    } finally { this.controller = undefined; OfflineStore.events.dispatchEvent(new Event('change')); }
  }
}
