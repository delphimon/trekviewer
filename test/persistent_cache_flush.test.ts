import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersistentResourceCache } from '../src/terrain/PersistentResourceCache.ts';
import { OfflineStore } from '../src/offline/OfflineStore.ts';

const url = (i: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/${650 + i}/1430.png`;
const blob = (bytes = 64) => new Blob([new Uint8Array(bytes)]);

beforeEach(async () => {
  vi.spyOn(OfflineStore, 'read').mockResolvedValue(null);
  PersistentResourceCache.setEnabled(true);
  await PersistentResourceCache.clear();
});
afterEach(() => vi.restoreAllMocks());

it('reads in read-only transactions and batches access times into the next flush', async () => {
  PersistentResourceCache.write(url(0), blob());
  await PersistentResourceCache.flush();
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
  expect(await PersistentResourceCache.read(url(0))).not.toBeNull();
  expect(transaction.mock.calls.map(call => call[1])).toEqual(['readonly']);
  await PersistentResourceCache.flush(); // applies the access-time update
  expect(transaction.mock.calls.at(-1)![1]).toBe('readwrite');
});

it('keeps running totals so flushes do not scan every entry', async () => {
  const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  for (let i = 0; i < 5; i++) { PersistentResourceCache.write(url(i), blob(100)); await PersistentResourceCache.flush(); }
  expect(getAll).not.toHaveBeenCalled(); // clear() established exact totals
  const stats = await PersistentResourceCache.refreshStats();
  expect(stats.entries).toBe(5);
  expect(stats.bytes).toBe(500);
  PersistentResourceCache.write(url(2), blob(300)); // replace one entry
  await PersistentResourceCache.flush();
  expect(PersistentResourceCache.getStats().bytes).toBe(700);
  expect(PersistentResourceCache.getStats().entries).toBe(5);
});
