import { expect, it } from 'vitest';
import { acquireOfflineResourceWithRetry, acquireOfflineSource } from '../scripts/offline-pack-acquisition.mjs';
const resource = { urls: ['https://example.org/public/export?tile=original'] };
it('recovers the same resource and exact body after bounded service recovery waits', async () => {
  const body = Buffer.from([0, 255, 9, 8]), calls = [], waits = [], saved = []; let attempts = 0;
  const result = await acquireOfflineResourceWithRetry(resource, undefined, {
    readRetained: () => undefined,
    download: async url => { calls.push(url); if (++attempts < 3) throw new DOMException('Service timeout', 'TimeoutError'); return body; },
    validate: async actual => expect(actual).toBe(body), save: (...args) => saved.push(args), sleepResourceRetry: async ms => waits.push(ms),
  });
  expect(waits).toEqual([120000, 300000]); expect(calls).toEqual(Array(3).fill(resource.urls[0]));
  expect(result.bytes).toBe(body); expect(saved).toEqual([[resource.urls[0], body, false]]);
});
it('bounds complete per-URL retry cycles instead of restarting the route prefix', async () => {
  let calls = 0; const transportWaits = [], resourceWaits = [];
  const result = await acquireOfflineResourceWithRetry(resource, undefined, {
    readRetained: () => undefined,
    download: url => acquireOfflineSource(url, 100, undefined, { fetchSource: async () => { calls++; return new Response('Busy', { status: 503 }); }, sleep: async ms => transportWaits.push(ms) }),
    validate: async () => { throw Error('Must not validate service errors'); }, save: () => { throw Error('Must not save'); },
    sleepResourceRetry: async ms => resourceWaits.push(ms),
  });
  expect(result).toBeUndefined(); expect(calls).toBe(9); expect(resourceWaits).toEqual([120000, 300000]);
  expect(transportWaits).toEqual([2000, 8000, 2000, 8000, 2000, 8000]);
});
it('does not retry invalid coverage or permanent service failures', async () => {
  for (const coverage of [true, false, 'type-error']) {
    let calls = 0, waits = 0;
    const result = await acquireOfflineResourceWithRetry(resource, undefined, {
      readRetained: () => undefined, download: async () => { calls++; if (!coverage) throw Object.assign(Error('HTTP 403'), { retryable: false }); return Buffer.from('masked'); },
      validate: async () => { throw coverage === 'type-error' ? new TypeError('Decoder rejected input') : Error('Missing coverage'); }, save: () => { throw Error('Must not save'); }, sleepResourceRetry: async () => { waits++; },
    }); expect(result).toBeUndefined(); expect(calls).toBe(1); expect(waits).toBe(0);
  }
});
it('stops for a longer Retry-After instead of making a fresh request two minutes later', async () => {
  let calls = 0, waits = 0;
  const result = await acquireOfflineResourceWithRetry(resource, undefined, {
    readRetained: () => undefined,
    download: url => acquireOfflineSource(url, 100, undefined, { fetchSource: async () => { calls++; return new Response('Busy', { status: 429, headers: { 'Retry-After': '3600' } }); } }),
    validate: async () => {}, save: () => {}, sleepResourceRetry: async () => { waits++; },
  }); expect(result).toBeUndefined(); expect(calls).toBe(1); expect(waits).toBe(0);
});
it('propagates disk failures immediately without retrying an accepted source', async () => {
  let calls = 0, waits = 0;
  await expect(acquireOfflineResourceWithRetry(resource, undefined, {
    readRetained: () => undefined, download: async () => { calls++; return Buffer.from('original'); }, validate: async () => {},
    save: () => { throw new TypeError('Disk write failed'); }, sleepResourceRetry: async () => { waits++; },
  })).rejects.toThrow('Disk write failed'); expect(calls).toBe(1); expect(waits).toBe(0);
});
it('cancels during a service-recovery wait without starting the next attempt', async () => {
  const controller = new AbortController(); let calls = 0;
  await expect(acquireOfflineResourceWithRetry(resource, controller.signal, {
    readRetained: () => undefined, download: async () => { calls++; throw new TypeError('Network reset'); }, validate: async () => {}, save: () => {},
    sleepResourceRetry: async () => controller.abort(),
  })).rejects.toHaveProperty('name', 'AbortError'); expect(calls).toBe(1);
});
