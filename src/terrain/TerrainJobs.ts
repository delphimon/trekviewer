import type { RawParsedGPX } from '../gpx/GPXParser.ts';
import type { ElevationGrid } from './ElevationTiles.ts';
import type { TerrariumDecodeInput } from './TerrariumDecode.ts';
import type { LocalTerrainChunkOptions } from './LocalTerrainChunk.ts';
import type { TerrainSurfaceData } from './TerrainGrid.ts';
import type { SurfacePromotionInput, SurfaceMeshSnapshot } from './SurfacePromotion.ts';
import type { LercElevationInput } from './LercElevation.ts';
import { encodeSurfaceSources, type SurfaceSourceUpdate } from './SurfaceSourceTransport.ts';

export type TerrainJob =
  | { kind: 'lerc'; input: LercElevationInput }
  | { kind: 'decode'; input: TerrariumDecodeInput }
  | { kind: 'surface'; input: SurfacePromotionInput; reuseSources?: boolean }
  | { kind: 'chunk'; options: Omit<LocalTerrainChunkOptions, 'mapTexture' | 'baseElevationSampler'>; base: TerrainSurfaceData }
  | { kind: 'finalize'; raw: RawParsedGPX; dem: ElevationGrid | null; regional?: ElevationGrid | null };

export type TerrainWorkerJob = Exclude<TerrainJob, { kind: 'surface' | 'chunk' }>
  | { kind: 'surface'; input: Omit<SurfacePromotionInput, 'sources'> & { sources: SurfaceSourceUpdate[] }; reuseSources?: boolean }
  | { kind: 'chunk'; options: Extract<TerrainJob, { kind: 'chunk' }>['options']; base?: TerrainSurfaceData; reuseBase?: boolean };

interface TerrainLane {
  worker: Worker | null;
  queue: Promise<unknown>;
  cancelActive: (() => void) | null;
  surfaceSources: SurfaceMeshSnapshot[] | null;
  chunkBase: TerrainSurfaceData | null;
  retryWorkerAfter: number;
  generation: number;
}
const createLane = (): TerrainLane => ({ worker: null, queue: Promise.resolve(), cancelActive: null,
  surfaceSources: null, chunkBase: null, retryWorkerAfter: 0, generation: 0 });
const elevationLane = createLane(), geometryLane = createLane();
const START_TIMEOUT_MS = 5000;
const CANCEL_DRAIN_TIMEOUT_MS = 5000;
const cancelled = () => new DOMException('Terrain work cancelled', 'AbortError');

/** Wait for module initialization before transferring caller-owned buffers.
 * A failed script load can otherwise detach the only copy before any work runs. */
async function startWorker(lane: TerrainLane): Promise<Worker | null> {
  if (lane.worker) return lane.worker;
  if (performance.now() < lane.retryWorkerAfter) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let candidate: Worker | null = null;
    try {
      candidate = new Worker(new URL('../workers/TerrainWorker.ts', import.meta.url), { type: 'module' });
      lane.worker = candidate; lane.surfaceSources = null; lane.chunkBase = null;
      const active = candidate;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer); lane.cancelActive = null;
          active.onmessage = active.onerror = active.onmessageerror = null;
        };
        const abort = () => { cleanup(); reject(cancelled()); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Terrain worker module startup timed out')); }, START_TIMEOUT_MS);
        lane.cancelActive = abort;
        active.onmessage = event => { if (event.data?.ready === true) { cleanup(); resolve(); } };
        active.onerror = event => { event.preventDefault(); cleanup(); reject(new Error(event.message || 'Terrain worker module could not start')); };
        active.onmessageerror = () => { cleanup(); reject(new Error('Terrain worker startup response could not be decoded')); };
      });
      return active;
    } catch (error) {
      candidate?.terminate(); if (lane.worker === candidate) lane.worker = null; lane.surfaceSources = null; lane.chunkBase = null;
      if ((error as Error)?.name === 'AbortError') throw error;
      if (attempt === 1) {
        lane.retryWorkerAfter = performance.now() + 10_000;
        console.warn('[TerrainJobs] Worker startup unavailable; using identical local computation temporarily.', error);
      }
    }
  }
  return null;
}

export function disposeTerrainJobs(): void {
  for (const lane of [elevationLane, geometryLane]) {
    lane.generation++;
    lane.cancelActive?.();
    lane.worker?.terminate();
    lane.worker = null; lane.surfaceSources = null; lane.chunkBase = null; lane.retryWorkerAfter = 0;
    lane.queue = Promise.resolve();
  }
}

/** Two bounded lanes keep elevation decoding independent of geometry work.
 * Caller cancellation rejects immediately, but an executing synchronous job
 * drains before its lane is reused. This avoids worker/module restart churn
 * and prevents a late response from being delivered to another caller. */
export function runTerrainJob<T>(job: TerrainJob, fallback: () => T | Promise<T>, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
  const lane = job.kind === 'surface' || job.kind === 'chunk' ? geometryLane : elevationLane;
  const generation = lane.generation;
  const run = async (): Promise<T> => {
    if (signal?.aborted || generation !== lane.generation) throw cancelled();
    if (typeof Worker === 'undefined') return fallback();
    const activeWorker = await startWorker(lane);
    if (signal?.aborted || generation !== lane.generation || (activeWorker && activeWorker !== lane.worker)) throw cancelled();
    if (!activeWorker) return fallback();
    return new Promise<T>((resolve, reject) => {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const clean = () => {
        clearTimeout(drainTimer); signal?.removeEventListener('abort', drain);
        lane.cancelActive = null;
        activeWorker.onmessage = activeWorker.onerror = activeWorker.onmessageerror = null;
      };
      // Normally the already-running bounded computation finishes promptly.
      // An abandoned hung job must not occupy its lane indefinitely.
      const drain = () => {
        drainTimer = setTimeout(() => {
          clean(); activeWorker.terminate(); lane.worker = null; lane.surfaceSources = null; lane.chunkBase = null; reject(cancelled());
        }, CANCEL_DRAIN_TIMEOUT_MS);
      };
      signal?.addEventListener('abort', drain, { once: true });
      lane.cancelActive = () => { clean(); reject(cancelled()); };
      activeWorker.onmessage = (event) => {
        clean();
        if (event.data.error) {
          // A handler may reject before installing all referenced state. Force
          // the next message to restore complete inputs on this healthy worker.
          lane.surfaceSources = null; lane.chunkBase = null;
          const error = new Error(event.data.error.message);
          error.name = event.data.error.name;
          reject(error);
        } else resolve(event.data.result as T);
      };
      activeWorker.onerror = (event) => {
        event.preventDefault(); clean(); activeWorker.terminate(); lane.worker = null; lane.surfaceSources = null; lane.chunkBase = null;
        reject(new Error(`Terrain worker failed: ${event.message || 'execution error'}`));
      };
      activeWorker.onmessageerror = () => {
        clean(); activeWorker.terminate(); lane.worker = null; lane.surfaceSources = null; lane.chunkBase = null;
        reject(new Error('Terrain worker response could not be decoded'));
      };
      try {
        // A revision changes holes/chunk membership more often than vertex data.
        // Keep unchanged grids in the worker; publish fresh metadata every time.
        let message: TerrainWorkerJob = job;
        if (job.kind === 'surface') {
          const reuseSources = job.input.sources === lane.surfaceSources;
          message = { ...job, input: { ...job.input,
            sources: reuseSources ? [] : encodeSurfaceSources(job.input.sources, lane.surfaceSources) }, reuseSources };
        } else if (job.kind === 'chunk' && job.base === lane.chunkBase) {
          // Base heights are immutable for this loaded trek; exaggeration lives
          // in separate mesh attributes. Retain just the current base grid.
          message = { ...job, base: undefined, reuseBase: true };
        }
        activeWorker.postMessage(message, transfer);
        if (job.kind === 'surface') lane.surfaceSources = job.input.sources;
        if (job.kind === 'chunk') lane.chunkBase = job.base;
      }
      catch (error) { clean(); reject(error); }
    });
  };
  const result = lane.queue.then(run, run);
  lane.queue = result.catch(() => {});
  if (!signal) return result;
  // The queue waits for execution, not for the caller's independently aborted
  // promise. Queued cancellation never transfers the caller's input buffers.
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    result.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(cancelled()); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
