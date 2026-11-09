import type { ImageryProvider } from './ImageryProvider.ts';
import { inSwissImageryEnvelope, isSwissImageryURL, isCompleteSwissImage, SWISS_IMAGE_TILES, SWISS_IMAGE_CREDITS } from './SwissImagery.ts';

const HALF_WORLD = Math.PI * 6378137;
export const NAIP_SERVICE = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer';
export const NAIP_PLUS_SERVICE = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer';
export const GEOPLATFORM_NAIP_SERVICE = 'https://imagery.geoplatform.gov/iipp/rest/services/NAIP/NAIP_plus/ImageServer';
export const USGS_IMAGERY_SERVICE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer';

export function tileMercatorBounds(zoom: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** zoom;
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 23 || !Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || y < 0 || x >= n || y >= n) throw new RangeError('Invalid imagery tile');
  const span = 2 * HALF_WORLD / n;
  return [-HALF_WORLD + x * span, HALF_WORLD - (y + 1) * span, -HALF_WORLD + (x + 1) * span, HALF_WORLD - y * span];
}

function exportParams(zoom: number, x: number, y: number): URLSearchParams {
  return new URLSearchParams({ f: 'image', bbox: tileMercatorBounds(zoom, x, y).join(','), bboxSR: '3857', imageSR: '3857',
    size: '256,256', format: 'png32', transparent: 'true', interpolation: 'RSP_BilinearInterpolation', adjustAspectRatio: 'false' });
}

/** Coarse conterminous-US outline (lon, lat): follows the Canadian and Mexican land borders
 * and runs generously offshore elsewhere. A lat/lon box would include Vancouver, Montreal
 * and northern Mexico, where NAIP never exists. */
const CONUS_OUTLINE: readonly (readonly [number, number])[] = [
  [-125.0, 48.4], [-123.3, 49.0], [-95.15, 49.0], [-94.8, 49.4], [-89.6, 48.0], [-84.8, 46.6],
  [-82.4, 45.3], [-82.5, 42.6], [-83.1, 42.0], [-79.0, 42.6], [-79.2, 43.5], [-76.5, 44.2],
  [-74.7, 45.0], [-71.5, 45.0], [-70.8, 45.4], [-70.0, 46.7], [-69.2, 47.45], [-67.8, 47.1],
  [-67.0, 45.2], [-66.5, 44.5], [-70.0, 40.5], [-75.0, 35.0], [-80.0, 30.5], [-79.8, 24.3],
  [-82.2, 24.3], [-97.1, 25.9], [-99.5, 27.5], [-101.4, 29.8], [-103.0, 29.0], [-104.5, 29.6],
  [-106.5, 31.8], [-108.2, 31.78], [-108.2, 31.33], [-111.07, 31.33], [-114.8, 32.5],
  [-117.12, 32.53], [-118.5, 32.3], [-121.0, 34.0], [-125.5, 40.0],
];

export function isCONUS(lat: number, lon: number): boolean {
  if (lat < 24 || lat > 49.5 || lon < -126 || lon > -66) return false;
  let inside = false;
  for (let i = 0, j = CONUS_OUTLINE.length - 1; i < CONUS_OUTLINE.length; j = i++) {
    const [xi, yi] = CONUS_OUTLINE[i], [xj, yj] = CONUS_OUTLINE[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** No account, key, paid subscription, or implicit commercial-provider fallback. */
export class PublicImageryProvider implements ImageryProvider {
  readonly id = 'public-naip';
  readonly displayName = 'USGS NAIP / high-resolution orthoimagery';
  readonly attribution = `USGS / USDA NAIP + HRO (public domain); NAIP: USDA FPAC / USFS GTAC / DOI GeoPlatform; USGS overview. ${SWISS_IMAGE_CREDITS}. Global: EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025), CC BY-NC-SA 4.0`;
  readonly maxZoom = 19;
  readonly requestTimeoutMs = 12_000;

  getMaxZoomForLocation(lat: number, lon: number): number { return isCONUS(lat, lon) || inSwissImageryEnvelope(lat, lon) ? 19 : 15; }
  getMaxOverviewZoomForLocation(lat: number, lon: number): number { return isCONUS(lat, lon) ? 19 : 15; }

  getTileUrls(zoom: number, x: number, y: number): string[] {
    const [west, south, east, north] = tileMercatorBounds(zoom, x, y);
    const lat = Math.atan(Math.sinh((north + south) / (2 * 6378137))) * 180 / Math.PI;
    const lon = (west + east) / (2 * HALF_WORLD) * 180;
    if (!isCONUS(lat, lon)) {
      // Keep complete global overview imagery below fine inspection levels.
      // Missing Swiss coverage never publishes an enlarged global tile as Z16+.
      if (zoom >= 16 && zoom <= 19 && inSwissImageryEnvelope(lat, lon)) return [`${SWISS_IMAGE_TILES}${zoom}/${x}/${y}.png`];
      return zoom <= 15 ? [`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${zoom}/${y}/${x}.jpg`] : [];
    }
    const blockZoom = zoom >= 17 ? zoom - 2 : zoom;
    const params = exportParams(blockZoom, zoom >= 17 ? Math.floor(x / 4) : x, zoom >= 17 ? Math.floor(y / 4) : y);
    if (zoom >= 17) params.set('size', '1024,1024');
    params.set('renderingRule', JSON.stringify({ rasterFunction: 'NaturalColor' }));
    params.set('noData', '0'); params.set('noDataInterpretation', 'esriNoDataMatchAll');
    const sharpPlus = `${NAIP_PLUS_SERVICE}/exportImage?${params}`;
    const sharp = `${NAIP_SERVICE}/exportImage?${params}`;
    const geoParams = new URLSearchParams(params);
    geoParams.set('renderingRule', JSON.stringify({ rasterFunction: 'None' }));
    geoParams.set('bandIds', '0,1,2');
    const geo = `${GEOPLATFORM_NAIP_SERVICE}/exportImage?${geoParams}`;
    params.delete('renderingRule');
    params.delete('noData'); params.delete('noDataInterpretation');
    const fallback = `${USGS_IMAGERY_SERVICE}/export?${params}`;
    // Cached overview is adequate below its own native sampling; sharp inspection
    // always requests the dynamic NAIP mosaic, with lossless natural-colour output.
    // Do not publish an upscaled overview under a fine-detail key. A failed fine
    // request retains the existing parent imagery and uses the normal retry path.
    return zoom >= 17 ? [sharpPlus, geo, sharp] : [fallback, geo, sharpPlus, sharp];
  }

  getTileImageRegion(zoom: number, x: number, y: number) {
    const [west, south, east, north] = tileMercatorBounds(zoom, x, y);
    const lat = Math.atan(Math.sinh((north + south) / (2 * 6378137))) * 180 / Math.PI;
    const lon = (west + east) / (2 * HALF_WORLD) * 180;
    return zoom >= 17 && isCONUS(lat, lon) ? { x: (x % 4) * 256, y: (y % 4) * 256, width: 256, height: 256 } : undefined;
  }

  getTileRequestGroup(zoom: number, x: number, y: number): string | undefined {
    return this.getTileImageRegion(zoom, x, y) ? `${zoom}:${Math.floor(x / 4)}:${Math.floor(y / 4)}` : undefined;
  }

  isTileUsable(image: CanvasImageSource, url: string): boolean {
    if (isSwissImageryURL(url)) return isCompleteSwissImage(image);
    if ((!url.startsWith(NAIP_SERVICE) && !url.startsWith(NAIP_PLUS_SERVICE) && !url.startsWith(GEOPLATFORM_NAIP_SERVICE)) || typeof document === 'undefined') return true;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(image, 0, 0, 16, 16);
      const pixels = ctx.getImageData(0, 0, 16, 16).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return false;
      return true;
    } finally { canvas.width = canvas.height = 1; }
  }
}

/** Transparent public-domain place / mountain names for the Hybrid style. */
export class USGSReferenceProvider implements ImageryProvider {
  readonly id = 'usgs-names';
  readonly displayName = 'USGS geographic names';
  readonly attribution = 'Labels: USGS GNIS (public domain)';
  readonly maxZoom = 19;
  readonly requestTimeoutMs = 12_000;
  getTileUrls(zoom: number, x: number, y: number): string[] {
    const params = zoom >= 2 ? exportParams(zoom - 2, Math.floor(x / 4), Math.floor(y / 4)) : exportParams(zoom, x, y);
    if (zoom >= 2) params.set('size', '1024,1024');
    params.set('layers', 'show:1,2,3,5,6,7');
    return [`https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/export?${params}`];
  }
  getTileImageRegion(zoom: number, x: number, y: number) { return zoom >= 2 ? { x: x % 4 * 256, y: y % 4 * 256, width: 256, height: 256 } : undefined; }
  getTileRequestGroup(zoom: number, x: number, y: number): string | undefined {
    return zoom >= 2 ? `${zoom}:${Math.floor(x / 4)}:${Math.floor(y / 4)}` : undefined;
  }
}
