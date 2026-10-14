import type { RawParsedGPX } from '../gpx/GPXParser.ts';
import type { ElevationGrid } from './ElevationTiles.ts';
import type { TerrariumDecodeInput } from './TerrariumDecode.ts';
import type { LocalTerrainChunkOptions } from './LocalTerrainChunk.ts';
import type { TerrainSurfaceData } from './TerrainGrid.ts';
import type { SurfacePromotionInput } from './SurfacePromotion.ts';

export type TerrainJob =
  | { kind: 'decode'; input: TerrariumDecodeInput }
  | { kind: 'surface'; input: SurfacePromotionInput }
  | { kind: 'chunk'; options: Omit<LocalTerrainChunkOptions, 'mapTexture' | 'baseElevationSampler'>; base: TerrainSurfaceData }
  | { kind: 'finalize'; raw: RawParsedGPX; dem: ElevationGrid | null; regional?: ElevationGrid | null };

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();
let cancelActive: (() => void) | null = null;

export function disposeTerrainJobs(): void {
  cancelActive?.();
  worker?.terminate();
  worker = null;
}

/** One reusable worker bounds CPU concurrency and transient DEM copies. */
export function runTerrainJob<T>(job: TerrainJob, fallback: () => T | Promise<T>, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
  const run = async (): Promise<T> => {
    if (signal?.aborted) throw new DOMException('Terrain work cancelled', 'AbortError');
    if (typeof Worker === 'undefined') return fallback();
    try { worker ??= new Worker(new URL('../workers/TerrainWorker.ts', import.meta.url), { type: 'module' }); }
    catch { return fallback(); }
    const activeWorker = worker;
    return new Promise<T>((resolve, reject) => {
      const clean = () => {
        cancelActive = null;
        signal?.removeEventListener('abort', abort);
        activeWorker.onmessage = activeWorker.onerror = null;
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
        reject(new Error(`Terrain worker failed: ${event.message}`));
      };
      try { activeWorker.postMessage(job, transfer); }
      catch (error) { clean(); reject(error); }
    });
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
