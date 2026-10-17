import type { RawParsedGPX } from '../gpx/GPXParser.ts';
import type { ElevationGrid } from './ElevationTiles.ts';
import type { TerrariumDecodeInput } from './TerrariumDecode.ts';
import type { LocalTerrainChunkOptions } from './LocalTerrainChunk.ts';
import type { TerrainSurfaceData } from './TerrainGrid.ts';
import type { SurfacePromotionInput, SurfaceMeshSnapshot } from './SurfacePromotion.ts';
import type { LercElevationInput } from './LercElevation.ts';

export type TerrainJob =
  | { kind: 'lerc'; input: LercElevationInput }
  | { kind: 'decode'; input: TerrariumDecodeInput }
  | { kind: 'surface'; input: SurfacePromotionInput; reuseSources?: boolean }
  | { kind: 'chunk'; options: Omit<LocalTerrainChunkOptions, 'mapTexture' | 'baseElevationSampler'>; base: TerrainSurfaceData }
  | { kind: 'finalize'; raw: RawParsedGPX; dem: ElevationGrid | null; regional?: ElevationGrid | null };

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();
let cancelActive: (() => void) | null = null;
let surfaceSources: SurfaceMeshSnapshot[] | null = null;
let retryWorkerAfter = 0;
const START_TIMEOUT_MS = 5000;

/** Wait for module initialization before transferring caller-owned buffers.
 * A failed script load can otherwise detach the only copy before any work runs. */
async function startWorker(signal?: AbortSignal): Promise<Worker | null> {
  if (worker) return worker;
  if (performance.now() < retryWorkerAfter) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('Terrain work cancelled', 'AbortError');
    let candidate: Worker | null = null;
    try {
      candidate = new Worker(new URL('../workers/TerrainWorker.ts', import.meta.url), { type: 'module' });
      worker = candidate; surfaceSources = null;
      const active = candidate;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer); cancelActive = null; signal?.removeEventListener('abort', abort);
          active.onmessage = active.onerror = active.onmessageerror = null;
        };
        const abort = () => { cleanup(); reject(new DOMException('Terrain work cancelled', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Terrain worker module startup timed out')); }, START_TIMEOUT_MS);
        cancelActive = abort; signal?.addEventListener('abort', abort, { once: true });
        active.onmessage = event => { if (event.data?.ready === true) { cleanup(); resolve(); } };
        active.onerror = event => { event.preventDefault(); cleanup(); reject(new Error(event.message || 'Terrain worker module could not start')); };
        active.onmessageerror = () => { cleanup(); reject(new Error('Terrain worker startup response could not be decoded')); };
      });
      if (signal?.aborted) throw new DOMException('Terrain work cancelled', 'AbortError');
      return active;
    } catch (error) {
      candidate?.terminate(); if (worker === candidate) worker = null; surfaceSources = null;
      if ((error as Error)?.name === 'AbortError') throw error;
      if (attempt === 1) {
        retryWorkerAfter = performance.now() + 10_000;
        console.warn('[TerrainJobs] Worker startup unavailable; using identical local computation temporarily.', error);
      }
    }
  }
  return null;
}

export function disposeTerrainJobs(): void {
  cancelActive?.();
  worker?.terminate();
  worker = null;
  surfaceSources = null;
  retryWorkerAfter = 0;
}

/** One reusable worker bounds CPU concurrency and transient DEM copies. */
export function runTerrainJob<T>(job: TerrainJob, fallback: () => T | Promise<T>, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
  const run = async (): Promise<T> => {
    if (signal?.aborted) throw new DOMException('Terrain work cancelled', 'AbortError');
    if (typeof Worker === 'undefined') return fallback();
    const activeWorker = await startWorker(signal);
    if (signal?.aborted || (activeWorker && activeWorker !== worker)) throw new DOMException('Terrain work cancelled', 'AbortError');
    if (!activeWorker) return fallback();
    return new Promise<T>((resolve, reject) => {
      const clean = () => {
        cancelActive = null;
        signal?.removeEventListener('abort', abort);
        activeWorker.onmessage = activeWorker.onerror = activeWorker.onmessageerror = null;
      };
      const abort = () => {
        clean(); activeWorker.terminate(); worker = null;
        reject(new DOMException('Terrain work cancelled', 'AbortError'));
      };
      cancelActive = abort;
      signal?.addEventListener('abort', abort, { once: true });
      activeWorker.onmessage = (event) => {
        clean();
        if (event.data.error) {
          const error = new Error(event.data.error.message);
          error.name = event.data.error.name;
          reject(error);
        } else resolve(event.data.result as T);
      };
      activeWorker.onerror = (event) => {
        event.preventDefault(); clean(); activeWorker.terminate(); worker = null;
        reject(new Error(`Terrain worker failed: ${event.message || 'execution error'}`));
      };
      activeWorker.onmessageerror = () => {
        clean(); activeWorker.terminate(); worker = null; surfaceSources = null;
        reject(new Error('Terrain worker response could not be decoded'));
      };
      try {
        // A surface revision is shared by many tile jobs. Clone its source grids
        // once, rather than copying the full DEM mesh for every 256px crop.
        const reuseSources = job.kind === 'surface' && job.input.sources === surfaceSources;
        activeWorker.postMessage(reuseSources
          ? { ...job, input: { ...job.input, sources: [] }, reuseSources: true }
          : job, transfer);
        if (job.kind === 'surface') surfaceSources = job.input.sources;
      }
      catch (error) { clean(); reject(error); }
    });
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
