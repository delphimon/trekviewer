import { afterEach, expect, it, vi } from 'vitest';
import { validateOfflineResource } from '../src/offline/OfflineDownloads.ts';
afterEach(() => vi.unstubAllGlobals());
const resource = { kind: 'image' as const, urls: [], width: 256, height: 256 };
it('rejects oversized PNG dimensions before allocating a decoded bitmap', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  const bytes = new ArrayBuffer(24), view = new DataView(bytes);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(16, 16384); view.setUint32(20, 16384);
  await expect(validateOfflineResource(resource, new Blob([bytes]))).rejects.toThrow('dimensions');
  expect(decode).not.toHaveBeenCalled();
});
it('rejects malformed bodies and cancelled work before image decoding', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(validateOfflineResource(resource, new Blob(['bad']))).rejects.toThrow('format');
  await expect(validateOfflineResource(resource, new Blob(['bad']), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  expect(decode).not.toHaveBeenCalled();
});
