import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('O5 imagery transcoding', () => {
  const png = (w: number, h: number, size: number) => {
    const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(16, w); view.setUint32(20, h);
    return new Blob([bytes]);
  };
  const stubCanvas = (jpegBytes: number | null, alpha = 255) => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4, height: 4, close() {} }));
    vi.stubGlobal('document', { createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64).fill(alpha) }) }),
      toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => {
        expect(type).toBe('image/jpeg'); expect(quality).toBe(0.9);
        cb(jpegBytes === null ? null : new Blob([new Uint8Array(jpegBytes)], { type }));
      },
    }) });
  };
  afterEach(() => vi.unstubAllGlobals());
  const resource = { kind: 'image' as const, urls: ['x'], width: 4, height: 4 };

  it('stores an opaque PNG as a smaller JPEG', async () => {
    stubCanvas(100);
    const stored = await validateOfflineResource(resource, png(4, 4, 1000));
    expect(stored.type).toBe('image/jpeg'); expect(stored.size).toBe(100);
  });
  it('keeps the original when the JPEG is not smaller or cannot be made', async () => {
    const source = png(4, 4, 1000);
    stubCanvas(2000); expect(await validateOfflineResource(resource, source)).toBe(source);
    stubCanvas(null); expect(await validateOfflineResource(resource, source)).toBe(source);
  });
  it('still rejects imagery with missing coverage before transcoding', async () => {
    stubCanvas(100, 0);
    await expect(validateOfflineResource(resource, png(4, 4, 1000))).rejects.toThrow('missing coverage');
  });
});
