import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runTerrainJob, disposeTerrainJobs } from '../src/terrain/TerrainJobs.ts';

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

it('cancels initialization without retrying or invoking local computation', async () => {
  const controller = new AbortController(), fallback = vi.fn();
  const result = runTerrainJob(job(), fallback, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  expect(StartupWorker.instances).toHaveLength(1); expect(StartupWorker.instances[0].terminated).toBe(true); expect(fallback).not.toHaveBeenCalled();
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
