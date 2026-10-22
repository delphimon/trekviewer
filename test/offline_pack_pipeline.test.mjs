import { expect, it, vi } from 'vitest';
import { offlineSourceConcurrency, orderedOfflineSources, offlineValidationLane } from '../scripts/offline-pack-pipeline.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
it('bounds the complete pending window and yields original bodies in inventory order', async () => {
  const gates = Array.from({ length: 4 }, deferred), started = [], bodies = gates.map((_, i) => Buffer.from([0, 255, i]));
  const stream = orderedOfflineSources(bodies, async (body, index) => { started.push(index); await gates[index].promise; return body; });
  const first = stream.next();
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  gates[1].resolve(); await Promise.resolve(); expect(started).toEqual([0, 1]);
  gates[0].resolve(); expect((await first).value).toEqual({ index: 0, value: bodies[0] });
  // The consumer can write/compress the first body without starting a third.
  expect(started).toEqual([0, 1]);
  expect((await stream.next()).value.value).toBe(bodies[1]);
  const third = stream.next(); await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
  gates[3].resolve(); gates[2].resolve(); expect((await third).value.value).toBe(bodies[2]);
  expect((await stream.next()).value.value).toBe(bodies[3]); expect((await stream.next()).done).toBe(true);
});
it('supports one lane without speculative requests', async () => {
  const started = [], stream = orderedOfflineSources([1, 2], async item => { started.push(item); return item; }, undefined, 1);
  expect((await stream.next()).value.value).toBe(1); expect(started).toEqual([1]);
  expect((await stream.next()).value.value).toBe(2); expect(started).toEqual([1, 2]); await stream.return();
});
it('aborts and drains an overlapping source when an earlier acquisition fails', async () => {
  const failed = deferred(), started = [], cancelled = [];
  const stream = orderedOfflineSources([0, 1, 2], async (item, index, signal) => {
    started.push(index);
    if (index === 0) return failed.promise;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled.push(index); reject(signal.reason); }, { once: true }));
  });
  const result = stream.next(); await vi.waitFor(() => expect(started).toEqual([0, 1]));
  failed.reject(Error('Disk full'));
  await expect(result).rejects.toThrow('Disk full'); expect(cancelled).toEqual([1]); expect(started).toEqual([0, 1]);
});
it('observes a later rejection without publishing it as a successful source', async () => {
  const gate = deferred(), started = [], error = Error('Invalid source');
  const stream = orderedOfflineSources([0, 1, 2], async (_, index) => { started.push(index); if (index === 1) throw error; await gate.promise; return 'first'; });
  const result = stream.next(); await vi.waitFor(() => expect(started).toEqual([0, 1]));
  gate.resolve(); expect((await result).value.value).toBe('first');
  await expect(stream.next()).rejects.toBe(error); expect(started).toEqual([0, 1]);
});
it('drains cancellation before consumer teardown and never starts more sources', async () => {
  let cancelled = false; const started = [];
  const stream = orderedOfflineSources([0, 1, 2], async (_, index, signal) => {
    started.push(index); if (index === 0) return 'original';
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }));
  });
  expect((await stream.next()).value.value).toBe('original'); await stream.return();
  expect(cancelled).toBe(true); expect(started).toEqual([0, 1]);
});
it('rejects an already cancelled run before any source starts', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const stream = orderedOfflineSources([1], async () => { calls++; }, controller.signal);
  await expect(stream.next()).rejects.toHaveProperty('name', 'AbortError'); expect(calls).toBe(0);
});
it('serializes real validation work and recovers the lane after a coverage failure', async () => {
  const gate = deferred(), entered = []; let active = 0, peak = 0;
  const validate = offlineValidationLane(async (resource, bytes) => {
    active++; peak = Math.max(peak, active); entered.push(resource);
    try { if (resource === 'masked') { await gate.promise; throw Error('Missing coverage'); } expect(bytes).toBe('original'); }
    finally { active--; }
  });
  const first = validate('masked', 'bad').catch(error => error), second = validate('complete', 'original');
  await vi.waitFor(() => expect(entered).toEqual(['masked'])); gate.resolve();
  expect((await first).message).toBe('Missing coverage'); await second; expect(entered).toEqual(['masked', 'complete']); expect(peak).toBe(1);
});
it('skips cancelled queued validation before touching its browser', async () => {
  const gate = deferred(), controller = new AbortController(), entered = [];
  const validate = offlineValidationLane(async resource => { entered.push(resource); await gate.promise; });
  const first = validate('first', 'original'), second = validate('cancelled', 'original', controller.signal).catch(error => error);
  controller.abort(); gate.resolve(); await first;
  expect(await second).toHaveProperty('name', 'AbortError'); expect(entered).toEqual(['first']);
});
it.each(['0', '3', '2.5', '2x', ''])('rejects unsafe concurrency %j', value => {
  expect(() => offlineSourceConcurrency(value)).toThrow('1 or 2');
});
