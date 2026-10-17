import type { ElevationGrid } from './ElevationTiles.ts';
import type { DecodedElevation } from './LercElevation.ts';
import { runTerrainJob } from './TerrainJobs.ts';
import { PersistentResourceCache, readBoundedBlob } from './PersistentResourceCache.ts';

export const USGS_ELEVATION_SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const HALF_WORLD = Math.PI * 6378137;
export interface RasterFootprint { minLat: number; maxLat: number; minLon: number; maxLon: number }

export function hasUSGSElevationCoverage(bounds: RasterFootprint): boolean {
  // A coarse eligibility test, not a claim of 1 m source coverage. NoData is checked after decoding.
  const regions = [[-125, 24, -66, 50], [-180, 51, -129, 72], [-161, 18, -154, 23], [-68, 17, -64, 19]];
  return regions.some(([west, south, east, north]) => bounds.minLon >= west && bounds.maxLon <= east
    && bounds.minLat >= south && bounds.maxLat <= north);
}

export function elevationRasterRequest(bounds: RasterFootprint, spacingMeters: number, maxSide = 1024) {
  if (![bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon, spacingMeters].every(Number.isFinite)
    || bounds.minLat >= bounds.maxLat || bounds.minLon >= bounds.maxLon || spacingMeters <= 0
    || Math.max(Math.abs(bounds.minLat), Math.abs(bounds.maxLat)) > 85
    || !Number.isInteger(maxSide) || maxSide < 2 || maxSide > 2048) throw new RangeError('Invalid elevation footprint');
  const mercatorY = (lat: number) => Math.asinh(Math.tan(lat * Math.PI / 180)) * 6378137;
  const west = bounds.minLon * HALF_WORLD / 180, east = bounds.maxLon * HALF_WORLD / 180;
  const south = mercatorY(bounds.minLat), north = mercatorY(bounds.maxLat);
  const groundScale = Math.cos((bounds.minLat + bounds.maxLat) * Math.PI / 360);
  const scale = Math.max(spacingMeters / groundScale, (east - west) / maxSide, (north - south) / maxSide);
  const width = Math.max(2, Math.min(maxSide, Math.ceil((east - west) / scale)));
  const height = Math.max(2, Math.min(maxSide, Math.ceil((north - south) / scale)));
  // ArcGIS samples at pixel centres. Expand by half a sample so the requested bounds
  // lie on samples, including shared chunk edges, rather than half a pixel outside.
  const dx = (east - west) / (width - 1), dy = (north - south) / (height - 1);
  const params = new URLSearchParams({ f: 'image', bbox: [west - dx / 2, south - dy / 2, east + dx / 2, north + dy / 2].join(','),
    bboxSR: '3857', imageSR: '3857', size: `${width},${height}`, format: 'lerc', pixelType: 'F32',
    renderingRule: JSON.stringify({ rasterFunction: 'None' }), interpolation: 'RSP_BilinearInterpolation',
    compressionTolerance: '0',
    mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicAttribute', sortField: 'Best', sortValue: '0', ascending: true, mosaicOperation: 'MT_FIRST' }) });
  return { url: `${USGS_ELEVATION_SERVICE}/exportImage?${params}`, width, height,
    sampleSpacingMeters: Math.max(dx, dy) * groundScale,
    rasterBounds: { west, east, south, north } };
}

// Failed footprints back off without permanently disabling the better source.
const failures = new Map<string, number>();
export function clearBestElevationFailures(): void { failures.clear(); }

export async function fetchBestAvailableElevation(bounds: RasterFootprint, spacingMeters: number,
  signal?: AbortSignal): Promise<ElevationGrid | null> {
  if (signal?.aborted) throw new DOMException('Elevation cancelled', 'AbortError');
  if (!hasUSGSElevationCoverage(bounds)) return null;
  const request = elevationRasterRequest(bounds, spacingMeters);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 35_000);
  const cacheGeneration = PersistentResourceCache.getGeneration();
  let cached = false;
  try {
    let blob = await PersistentResourceCache.read(request.url); cached = !!blob;
    if (!blob && (failures.get(request.url) ?? 0) > Date.now()) return null;
    if (!blob) blob = await readBoundedBlob(await fetch(request.url, { signal: controller.signal }), 32 * 1024 * 1024);
    const buffer = await blob.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Elevation cancelled', 'AbortError');
    const input = { buffer, width: request.width, height: request.height };
    const decoded = await runTerrainJob<DecodedElevation>({ kind: 'lerc', input }, async () => {
      const { decodeLercElevation } = await import('./LercElevation.ts');
      return decodeLercElevation(input);
    }, signal, [buffer]);
    // A partial coverage raster must not replace complete terrain or create coast-edge cliffs.
    if (decoded.validCount !== request.width * request.height) throw new Error('Incomplete USGS elevation coverage');
    if (!cached) PersistentResourceCache.write(request.url, blob, cacheGeneration);
    return { width: request.width, height: request.height, data: decoded.data, minElevation: decoded.min,
      maxElevation: decoded.max, isRealDEM: true, zoom: 0, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0,
      numTilesX: 1, numTilesY: 1, tileValidity: new Uint8Array([1]), rasterBounds: request.rasterBounds,
      source: 'USGS 3DEP best available (public domain)', sampleSpacingMeters: request.sampleSpacingMeters,
      quality: { validTileRatio: 1, totalTiles: 1, validTiles: 1, zoom: 0, usgsRasters: 1 } };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Elevation cancelled', 'AbortError');
    if (cached) {
      await PersistentResourceCache.remove(request.url); failures.delete(request.url);
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      return fetchBestAvailableElevation(bounds, spacingMeters, signal);
    }
    failures.delete(request.url); failures.set(request.url, Date.now() + 60_000);
    while (failures.size > 128) failures.delete(failures.keys().next().value!);
    return null;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
