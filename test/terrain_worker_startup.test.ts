import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runTerrainJob, disposeTerrainJobs } from '../src/terrain/TerrainJobs.ts';
import { snapshotSurfaceMesh } from '../src/terrain/SurfacePromotion.ts';
import * as THREE from 'three';

class StartupWorker {
  static instances: StartupWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: unknown[] = [];
  terminated = false;
  constructor() { StartupWorker.instances.push(this); }
  postMessage(job: unknown, transfer: Transferable[]) { this.messages.push(structuredClone(job, { transfer })); }
  terminate() { this.terminated = true; }
  ready() { this.onmessage?.({ data: { ready: true } }); }
  fail() { this.onerror?.({ preventDefault() {} }); }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const job = () => ({ kind: 'decode' as const, input: { width: 1, height: 1, pixels: new Uint8ClampedArray([128, 0, 0, 255]), validity: new Uint8Array([1]) } });
beforeEach(() => { StartupWorker.instances = []; vi.stubGlobal('Worker', StartupWorker); });
afterEach(() => { disposeTerrainJobs(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reuses source arrays across metadata revisions and resends them after a worker failure', async () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry());
  const input = () => ({ sources: [snapshotSurfaceMesh(mesh)], tiles: [], centerLat: 46, centerLon: -120 });
  const first = runTerrainJob({ kind: 'surface', input: input() }, () => 0);
  await flush(); const worker = StartupWorker.instances[0]; worker.ready(); await flush();
  expect((worker.messages[0] as any).input.sources[0].positions).toBeInstanceOf(Float32Array);
  worker.onmessage?.({ data: { result: 1 } }); await first;
  const second = runTerrainJob({ kind: 'surface', input: input() }, () => 0);
  const rejected = expect(second).rejects.toThrow('execution error'); await flush();
  expect((worker.messages[1] as any).input.sources[0]).toHaveProperty('reuseSource', 0);
  expect((worker.messages[1] as any).input.sources[0]).not.toHaveProperty('positions');
  worker.fail(); await rejected;
  const third = runTerrainJob({ kind: 'surface', input: input() }, () => 0);
  await flush(); const replacement = StartupWorker.instances[1]; replacement.ready(); await flush();
  expect((replacement.messages[0] as any).input.sources[0].positions).toBeInstanceOf(Float32Array);
  replacement.onmessage?.({ data: { result: 3 } }); expect(await third).toBe(3);
  mesh.geometry.dispose();
});

it('retains only the current immutable chunk base and resends it on replacement and worker restart', async () => {
  const base = { width: 100, depth: 100, segmentsX: 1, segmentsZ: 1, heights: new Float32Array([0, 10, 20, 30]) };
  const chunkJob = (grid = base) => ({ kind: 'chunk' as const, options: {} as any, base: grid });
  const first = runTerrainJob(chunkJob(), () => 0);
  await flush(); const worker = StartupWorker.instances[0]; worker.ready(); await flush();
  worker.onmessage?.({ data: { result: 1 } }); await first;
  const second = runTerrainJob(chunkJob(), () => 0); await flush();
  expect((worker.messages[1] as any).reuseBase).toBe(true);
  expect((worker.messages[1] as any).base).toBeUndefined();
  worker.onmessage?.({ data: { result: 2 } }); await second;
  const changed = { ...base, heights: new Float32Array([40, 50, 60, 70]) };
  const third = runTerrainJob(chunkJob(changed), () => 0); await flush();
  expect((worker.messages[2] as any).base.heights).toEqual(changed.heights);
  const rejected = expect(third).rejects.toThrow('execution error'); worker.fail(); await rejected;
  const fourth = runTerrainJob(chunkJob(changed), () => 0); await flush();
  const replacement = StartupWorker.instances[1]; replacement.ready(); await flush();
  expect((replacement.messages[0] as any).base.heights).toEqual(changed.heights);
  replacement.onmessage?.({ data: { result: 4 } }); expect(await fourth).toBe(4);
  expect(base.heights.byteLength).toBe(16);
});

it('restores full surface inputs after a handler error without restarting a healthy worker', async () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry());
  const input = { sources: [snapshotSurfaceMesh(mesh)], tiles: [], centerLat: 46, centerLon: -120 };
  const first = runTerrainJob({ kind: 'surface', input }, () => 0);
  const rejected = expect(first).rejects.toThrow('missing source');
  await flush(); const worker = StartupWorker.instances[0]; worker.ready(); await flush();
  worker.onmessage?.({ data: { error: { name: 'Error', message: 'missing source' } } }); await rejected;
  const next = runTerrainJob({ kind: 'surface', input }, () => 0); await flush();
  const message: any = worker.messages[1];
  expect(message.reuseSources).toBe(false);
  expect(message.input.sources[0].positions).toBeInstanceOf(Float32Array);
  expect(worker.terminated).toBe(false);
  worker.onmessage?.({ data: { result: 2 } }); expect(await next).toBe(2);
  mesh.geometry.dispose();
});

it('does not transfer a buffer until ready and retries a failed startup with the original input intact', async () => {
  const input = job(), fallback = vi.fn();
  const result = runTerrainJob(input, fallback, undefined, [input.input.pixels.buffer]);
  await flush(); const first = StartupWorker.instances[0];
  expect(first.messages).toHaveLength(0); expect(input.input.pixels.byteLength).toBe(4);
  first.fail(); await flush(); expect(first.terminated).toBe(true);
  const second = StartupWorker.instances[1]; second.ready(); await flush();
  expect(second.messages).toHaveLength(1); expect(input.input.pixels.byteLength).toBe(0);
  expect((second.messages[0] as any).input.pixels).toEqual(new Uint8ClampedArray([128, 0, 0, 255]));
  second.onmessage?.({ data: { result: 12 } }); expect(await result).toBe(12); expect(fallback).not.toHaveBeenCalled();
});

it('bounds persistent startup failures and falls back with intact bytes instead of losing the route', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const input = job(), fallback = vi.fn(() => [...input.input.pixels]);
  const result = runTerrainJob(input, fallback, undefined, [input.input.pixels.buffer]);
  await flush(); StartupWorker.instances[0].fail(); await flush(); StartupWorker.instances[1].fail();
  expect(await result).toEqual([128, 0, 0, 255]); expect(fallback).toHaveBeenCalledOnce();
  expect(StartupWorker.instances.every(w => w.terminated)).toBe(true);
  expect(await runTerrainJob(job(), () => 42)).toBe(42); expect(StartupWorker.instances).toHaveLength(2);
});

it('cancels the caller during initialization but reuses the starting worker for the next caller', async () => {
  const controller = new AbortController(), fallback = vi.fn();
  const result = runTerrainJob(job(), fallback, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  expect(StartupWorker.instances).toHaveLength(1); expect(StartupWorker.instances[0].terminated).toBe(false); expect(fallback).not.toHaveBeenCalled();
  const next = runTerrainJob(job(), () => 7); const worker = StartupWorker.instances[0]; worker.ready(); await flush();
  expect(worker.messages).toHaveLength(1); worker.onmessage?.({ data: { result: 9 } }); expect(await next).toBe(9);
});

it('times out workers that never signal readiness and recovers after the cooldown', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = runTerrainJob(job(), () => 7);
  await flush(); await vi.advanceTimersByTimeAsync(5000); await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe(7); expect(StartupWorker.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(10001);
  const recovered = runTerrainJob(job(), () => 8); await flush();
  const worker = StartupWorker.instances[2]; worker.ready(); await flush();
  worker.onmessage?.({ data: { result: 9 } }); expect(await recovered).toBe(9);
});

it('does not retry an execution error after transferring the only buffer', async () => {
  const input = job(), fallback = vi.fn();
  const result = runTerrainJob(input, fallback, undefined, [input.input.pixels.buffer]);
  const rejected = expect(result).rejects.toThrow('execution error');
  await flush(); const worker = StartupWorker.instances[0]; worker.ready(); await flush(); worker.fail(); await rejected;
  expect(input.input.pixels.byteLength).toBe(0); expect(fallback).not.toHaveBeenCalled();
});

it('rejects an aborted active caller immediately, drains its response, then reuses the worker without confusing results', async () => {
  const controller = new AbortController(), input = job();
  const first = runTerrainJob(input, () => 1, controller.signal, [input.input.pixels.buffer]);
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); const worker = StartupWorker.instances[0]; worker.ready(); await flush();
  const second = runTerrainJob(job(), () => 2);
  controller.abort(); await rejected;
  expect(worker.terminated).toBe(false); expect(worker.messages).toHaveLength(1);
  worker.onmessage?.({ data: { result: 'stale' } }); await flush();
  expect(worker.messages).toHaveLength(2); expect(StartupWorker.instances).toHaveLength(1);
  worker.onmessage?.({ data: { result: 'current' } }); expect(await second).toBe('current');
});

it('decodes elevation while geometry is busy, with at most one active job on each of two workers', async () => {
  const first = runTerrainJob({ kind: 'surface', input: { sources: [], tiles: [], centerLat: 46, centerLon: -120 } }, () => 'geometry');
  const second = runTerrainJob(job(), () => 'decode');
  const third = runTerrainJob(job(), () => 'next-decode');
  await flush(); expect(StartupWorker.instances).toHaveLength(2);
  StartupWorker.instances.forEach(worker => worker.ready()); await flush();
  const geometry = StartupWorker.instances.find(worker => (worker.messages[0] as any).kind === 'surface')!;
  const elevation = StartupWorker.instances.find(worker => (worker.messages[0] as any).kind === 'decode')!;
  expect(geometry.messages).toHaveLength(1); expect(elevation.messages).toHaveLength(1);
  elevation.onmessage?.({ data: { result: 'decoded' } }); expect(await second).toBe('decoded'); await flush();
  expect(elevation.messages).toHaveLength(2); expect(geometry.messages).toHaveLength(1);
  elevation.onmessage?.({ data: { result: 'decoded-next' } }); expect(await third).toBe('decoded-next');
  geometry.onmessage?.({ data: { result: 'built' } }); expect(await first).toBe('built');
});

it('cancels a queued caller before its buffers transfer and disposes both active lanes', async () => {
  const controller = new AbortController(), input = job();
  const active = runTerrainJob(job(), () => 1);
  const queued = runTerrainJob(input, () => 2, controller.signal, [input.input.pixels.buffer]);
  const queuedRejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await queuedRejection; expect(input.input.pixels.byteLength).toBe(4);
  const geometry = runTerrainJob({ kind: 'surface', input: { sources: [], tiles: [], centerLat: 46, centerLon: -120 } }, () => 3);
  const rejections = [expect(active).rejects.toMatchObject({ name: 'AbortError' }), expect(geometry).rejects.toMatchObject({ name: 'AbortError' })];
  await flush(); StartupWorker.instances.forEach(worker => worker.ready()); await flush();
  disposeTerrainJobs(); await Promise.all(rejections);
  expect(StartupWorker.instances).toHaveLength(2); expect(StartupWorker.instances.every(worker => worker.terminated)).toBe(true);
});

it('restarts only an abandoned worker that fails to drain within five seconds', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const active = runTerrainJob(job(), () => 1, controller.signal);
  const rejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); const worker = StartupWorker.instances[0]; worker.ready(); await flush();
  const next = runTerrainJob(job(), () => 2);
  controller.abort(); await rejected; await vi.advanceTimersByTimeAsync(4999);
  expect(worker.terminated).toBe(false); expect(StartupWorker.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); await flush();
  expect(worker.terminated).toBe(true); expect(StartupWorker.instances).toHaveLength(2);
  const replacement = StartupWorker.instances[1]; replacement.ready(); await flush();
  replacement.onmessage?.({ data: { result: 3 } }); expect(await next).toBe(3);
});
