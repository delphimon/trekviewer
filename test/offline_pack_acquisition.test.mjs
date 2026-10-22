import { expect, it } from 'vitest';
import { acquireOfflineSource, acquireOfflineResource, OfflineSourceHealth } from '../scripts/offline-pack-acquisition.mjs';

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

const aliases = ['https://example.org/primary/export?tile=1', 'https://example.org/alternate/export?tile=1'];
const resource = { urls: aliases };
it('uses a validated cached alternate before any primary network request', async () => {
  const body = Buffer.from('original alternate bytes'), saved = [], reads = []; let network = 0;
  const actual = await acquireOfflineResource(resource, undefined, {
    readRetained: url => { reads.push(url); return url === aliases[1] ? body : undefined; },
    download: async () => { network++; throw Error('Primary is offline'); },
    validate: async bytes => { expect(bytes).toBe(body); }, save: (...args) => saved.push(args),
  });
  expect(network).toBe(0); expect(reads).toEqual(aliases); expect(saved).toEqual([[aliases[1], body, true]]);
  expect(actual).toEqual({ bytes: body, url: aliases[1], sourceIndex: 1, retained: true });
});
it('rejects an invalid cached primary and still reuses a valid cached alternate without network', async () => {
  const valid = Buffer.from('valid'), invalid = Buffer.from('invalid'), failures = [];
  const actual = await acquireOfflineResource(resource, undefined, {
    readRetained: url => url === aliases[0] ? invalid : valid,
    download: async () => { throw Error('Must not acquire'); },
    validate: async bytes => { if (bytes === invalid) throw Error('Missing coverage'); },
    save: () => {}, onFailure: (url, error, retained) => failures.push({ url, error: error.message, retained }),
  });
  expect(actual.bytes).toBe(valid); expect(actual.retained).toBe(true);
  expect(failures).toEqual([{ url: aliases[0], error: 'Missing coverage', retained: true }]);
});
it('cannot download on a cache-only run when retained data fails validation', async () => {
  const actual = await acquireOfflineResource(resource, undefined, {
    readRetained: () => Buffer.from('invalid'), validate: async () => { throw Error('Invalid'); },
    save: () => { throw Error('Must not save'); },
  }); expect(actual).toBeUndefined();
});
it('reacquires invalid retained data and validates it before saving', async () => {
  const old = Buffer.from('invalid'), fresh = Buffer.from('exact fresh bytes'), calls = [];
  const actual = await acquireOfflineResource(resource, undefined, {
    readRetained: url => url === aliases[0] ? old : undefined,
    download: async url => { calls.push(url); return fresh; },
    validate: async bytes => { if (bytes === old) throw Error('Invalid'); },
    save: (url, bytes, retained) => { expect(bytes).toBe(fresh); expect(retained).toBe(false); },
  }); expect(actual.bytes).toBe(fresh); expect(calls).toEqual([aliases[0]]);
});
it('propagates a disk write failure without downloading more aliases', async () => {
  const calls = [];
  await expect(acquireOfflineResource(resource, undefined, {
    readRetained: () => undefined, download: async url => { calls.push(url); return Buffer.from('source'); },
    validate: async () => {}, save: () => { throw Error('Disk full'); },
  })).rejects.toThrow('Disk full'); expect(calls).toEqual([aliases[0]]);
});
it('cancels after cached validation without saving or downloading', async () => {
  const controller = new AbortController(); let saves = 0;
  await expect(acquireOfflineResource(resource, controller.signal, {
    readRetained: () => Buffer.from('source'), validate: async () => { controller.abort(); }, save: () => { saves++; },
  })).rejects.toThrow(); expect(saves).toBe(0);
});
it('cools an exhausted transient service across different tile requests and restores its priority', () => {
  let now = 1000; const health = new OfflineSourceHealth(() => now);
  const failed = Object.assign(new Error('HTTP 502'), { retryable: true });
  health.failed(aliases[0], failed);
  const next = aliases.map(url => url.replace('tile=1', 'tile=2'));
  expect(health.order(next)).toEqual([next[1], next[0]]);
  now += 120000; expect(health.order(next)).toEqual(next);
  health.failed(aliases[0], failed); health.succeeded(next[0]); expect(health.order(next)).toEqual(next);
});
it('does not cool a service for cached/decoded coverage failures or permanent HTTP errors', async () => {
  const health = new OfflineSourceHealth();
  health.failed(aliases[0], Object.assign(new Error('HTTP 403'), { retryable: false }));
  expect(health.order(aliases)).toEqual(aliases);
  await acquireOfflineResource(resource, undefined, {
    health, readRetained: () => undefined, download: async () => Buffer.from('source'),
    validate: async () => { throw Error('Missing coverage'); }, save: () => { throw Error('Must not save'); },
  }); expect(health.order(aliases)).toEqual(aliases);
});
it('tries a cooled source when the healthy alias has no usable coverage', async () => {
  const health = new OfflineSourceHealth(), calls = [];
  health.failed(aliases[0], Object.assign(new Error('HTTP 502'), { retryable: true }));
  const actual = await acquireOfflineResource(resource, undefined, {
    health, readRetained: () => undefined,
    download: async url => { calls.push(url); return Buffer.from(url); },
    validate: async bytes => { if (bytes.toString() === aliases[1]) throw Error('Missing coverage'); }, save: () => {},
  });
  expect(calls).toEqual([aliases[1], aliases[0]]); expect(actual.sourceIndex).toBe(0);
  expect(health.order(aliases)).toEqual(aliases);
});
