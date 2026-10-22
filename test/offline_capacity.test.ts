import { afterEach, expect, it, vi } from 'vitest';
import { requireOfflineCapacity } from '../src/offline/OfflineCapacity.ts';

afterEach(() => vi.unstubAllGlobals());
const storage = (quota?: number, usage?: number) => vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota, usage }) } });

it('permits encoded writes when free space is smaller than the raw-pixel planning budget', async () => {
  storage(100 * 1024 * 1024, 10 * 1024 * 1024);
  await expect(requireOfflineCapacity(8 * 1024 * 1024)).resolves.toBeUndefined();
});

it('rechecks shared usage and preserves headroom for the actual next blob', async () => {
  const quota = 100 * 1024 * 1024;
  storage(quota, 60 * 1024 * 1024);
  await expect(requireOfflineCapacity()).resolves.toBeUndefined();
  await expect(requireOfflineCapacity(8 * 1024 * 1024)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage(quota, 90 * 1024 * 1024);
  await expect(requireOfflineCapacity()).rejects.toMatchObject({ name: 'QuotaExceededError' });
});

it.each([[undefined, 0], [Infinity, 0], [1e9, undefined], [1e9, -1], [0, 0]])('rejects unknown or invalid quota %s / usage %s', async (quota, usage) => {
  storage(quota, usage);
  await expect(requireOfflineCapacity()).rejects.toThrow('capacity unavailable');
});
