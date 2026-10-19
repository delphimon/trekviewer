export const SWISS_IMAGE_TILES = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/default/current/3857/';
export const SWISS_CACHE_UPDATE = 'https://api3.geo.admin.ch/rest/services/ech/MapServer/ch.swisstopo.swissimage-product/cacheUpdate';
export const SWISS_IMAGE_CREDITS = 'SWISSIMAGE ©swisstopo; Includes material © (2016–2018) Planet. All rights reserved';

/** Service envelope from EPSG:3857 WMTS capabilities, not a country/coverage
 * polygon. Transparent or partial PNGs must pass the loader's coverage check. */
export function inSwissImageryEnvelope(lat: number, lon: number): boolean {
  return lat >= 45.398181 && lat <= 48.230651 && lon >= 5.140242 && lon <= 11.47757;
}
export function isSwissImageryURL(url: string): boolean {
  return /^https:\/\/wmts\.geo\.admin\.ch\/1\.0\.0\/ch\.swisstopo\.swissimage-product\/default\/current\/3857\/\d+\/\d+\/\d+\.png$/.test(url);
}

const coverage = new WeakMap<object, boolean>();
export function isCompleteSwissImage(image: CanvasImageSource): boolean {
  const known = coverage.get(image); if (known !== undefined) return known;
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  try {
    const width = 'naturalWidth' in image ? image.naturalWidth : 'width' in image ? Number(image.width) : 0;
    const height = 'naturalHeight' in image ? image.naturalHeight : 'height' in image ? Number(image.height) : 0;
    if (width !== 256 || height !== 256) return false;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return false;
    ctx.drawImage(image, 0, 0);
    // Validate every source pixel; a one-pixel border mask must not create a
    // hole or be mistaken for opaque snow in a downsampled validation image.
    const pixels = ctx.getImageData(0, 0, 256, 256).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) { coverage.set(image, false); return false; }
    coverage.set(image, true); return true;
  } finally { canvas.width = canvas.height = 1; }
}

let revision: string | null = null;
let check: Promise<string | null> | undefined;
export function getSwissImageryRevision(): string | null { return revision; }
/** Once per page, before disk reuse. A failed check skips persistent Swiss
 * reuse/saving for this page while ordinary network imagery continues. */
export function checkSwissImageryRevision(): Promise<string | null> {
  return check ??= (async () => {
    try {
      const response = await fetch(SWISS_CACHE_UPDATE, { signal: AbortSignal.timeout(1500), credentials: 'omit' });
      if (!response.ok) return null;
      const data = await response.json();
      const stamp = typeof data.cache_update === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?$/.test(data.cache_update)
        ? Date.parse(data.cache_update.endsWith('Z') ? data.cache_update : data.cache_update + 'Z') : NaN;
      if (!Number.isFinite(stamp)) return null;
      revision = String(stamp); return revision;
    } catch { return null; }
  })();
}
