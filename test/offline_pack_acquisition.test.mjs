import { expect, it } from 'vitest';
import { acquireOfflineSource } from '../scripts/offline-pack-acquisition.mjs';

const url = 'https://elevation.nationalmap.gov/controlled-fixture';
it('retains exact encoded bytes after transient HTTP and transport failures', async () => {
  const expected = new Uint8Array([0, 255, 42, 7]), calls = [], waits = [], events = [];
  const result = await acquireOfflineSource(url, 100, new AbortController().signal, {
    fetchSource: async (actual, options) => {
      calls.push({ actual, options });
      if (calls.length === 1) return new Response('Unavailable', { status: 503 });
      if (calls.length === 2) throw new TypeError('Connection reset');
      return new Response(expected);
    }, sleep: async ms => { waits.push(ms); }, onRetry: event => events.push(event),
  });
  expect(new Uint8Array(result)).toEqual(expected); expect(waits).toEqual([2000, 8000]);
  expect(events.map(e => e.nextAttempt)).toEqual([2, 3]);
  expect(calls.every(c => c.actual === url && c.options.credentials === 'omit' && c.options.redirect === 'error')).toBe(true);
});
it('stops after three transient failures', async () => {
  let count = 0;
  await expect(acquireOfflineSource(url, 100, undefined, {
    fetchSource: async () => { count++; throw new DOMException('Timed out', 'TimeoutError'); }, sleep: async () => {},
  })).rejects.toThrow('Timed out');
  expect(count).toBe(3);
});
it.each([400, 401, 403, 404])('does not retry HTTP %i', async status => {
  let count = 0;
  await expect(acquireOfflineSource(url, 100, undefined, {
    fetchSource: async () => { count++; return new Response('Rejected', { status }); },
  })).rejects.toThrow(`HTTP ${status}`); expect(count).toBe(1);
});
it('does not retry an oversized body or relax its byte bound', async () => {
  let count = 0;
  await expect(acquireOfflineSource(url, 2, undefined, {
    fetchSource: async () => { count++; return new Response(new Uint8Array(3)); },
  })).rejects.toThrow('too large'); expect(count).toBe(1);
});
it('respects a bounded Retry-After and stops for a longer service delay', async () => {
  const waits = []; let count = 0;
  await expect(acquireOfflineSource(url, 100, undefined, {
    fetchSource: async () => new Response('Busy', { status: 429, headers: { 'Retry-After': ++count === 1 ? '12' : '3600' } }),
    sleep: async ms => { waits.push(ms); },
  })).rejects.toThrow('retry later'); expect(count).toBe(2); expect(waits).toEqual([12000]);
});
it('cancels during retry delay without acquiring another source', async () => {
  const controller = new AbortController(); let count = 0;
  await expect(acquireOfflineSource(url, 100, controller.signal, {
    fetchSource: async () => { count++; return new Response('Busy', { status: 503 }); },
    sleep: async () => { controller.abort(); },
  })).rejects.toThrow(); expect(count).toBe(1);
});
