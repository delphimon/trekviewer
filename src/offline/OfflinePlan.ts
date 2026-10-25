import type { TrackStats } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters, localMetersToGeo, latLonToTile, tileToLatLon } from '../gpx/Coordinates.ts';
import { TextureBudget } from '../terrain/TextureBudget.ts';
import { planTerrainTiles } from '../terrain/TerrainTileLayout.ts';
import { elevationRasterRequest, requiredElevationWindow } from '../terrain/BestAvailableElevation.ts';
import type { RasterSampleWindow } from '../terrain/LercElevation.ts';
import { PublicImageryProvider } from '../terrain/providers/PublicImageryProvider.ts';
import { offlineSourceAllowed } from './OfflineStore.ts';

export const DEFAULT_OFFLINE_ROUTES = ['rainier-emmons', 'enchantments-dragontail'] as const;
export interface OfflineResource {
  urls: string[];
  kind: 'image' | 'elevation';
  width: number; height: number;
  requiredWindow?: RasterSampleWindow;
}
export interface OfflinePlanOptions {
  mode?: 'full-v2' | 'corridor-v3';
  corridorMeters?: number;
  maxImageryZoom?: 18 | 19;
}
export interface OfflinePlan {
  id: string; routeId: string; routeHash: string; name: string;
  version: 1 | 2 | 3; coverage: 'full-model' | 'corridor'; maxZoom: 18 | 19;
  /** Uncompressed planning budget, not measured encoded size or minimum quota. */
  estimatedBytes: number; resources: OfflineResource[];
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

function isBoxNearCorridor(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  corridorPoints: ReadonlyArray<{ x: number; z: number }>,
  corridorMeters: number
): boolean {
  if (corridorPoints.length === 0) return true;
  const maxDistSq = corridorMeters * corridorMeters;
  for (let i = 0; i < corridorPoints.length; i++) {
    const pt = corridorPoints[i];
    const dx = Math.max(0, minX - pt.x, pt.x - maxX);
    const dz = Math.max(0, minZ - pt.z, pt.z - maxZ);
    if (dx * dx + dz * dz <= maxDistSq) return true;
  }
  return false;
}

/** Current renderer-compatible source inventory, generated on demand rather than
 * placing thousands of source URLs in the startup bundle. No network side effects.
 * Revision includes the GPX hash; change the plan version for layout/provider changes.
 * Public satellite imagery, normal High geometry and unmodified source requests. */
export function planOfflineRoute(
  track: TrackStats,
  routeId: string,
  routeHash: string,
  options?: OfflinePlanOptions
): OfflinePlan {
  if (!DEFAULT_OFFLINE_ROUTES.some(id => id === routeId) || !/^[a-f0-9]{64}$/.test(routeHash)) throw Error('Unsupported offline route revision');
  const mode = options?.mode ?? 'full-v2';
  const isCorridor = mode === 'corridor-v3';
  const corridorMeters = options?.corridorMeters ?? 1500;
  const maxZoom: 18 | 19 = options?.maxImageryZoom ?? (isCorridor ? 18 : 19);

  const b = track.bounds, width = Math.max(1500, b.widthMeters * 1.5), depth = Math.max(1500, b.depthMeters * 1.5);
  const nw = localMetersToGeo(-width / 2, -depth / 2, b.centerLat, b.centerLon), se = localMetersToGeo(width / 2, depth / 2, b.centerLat, b.centerLon);
  const footprint = { minLat: se.lat, maxLat: nw.lat, minLon: nw.lon, maxLon: se.lon };
  const resources = new Map<string, OfflineResource>(), provider = new PublicImageryProvider();

  const corridorPoints: Array<{ x: number; z: number }> = [];
  if (isCorridor && track.points.length > 0) {
    let lastDist = -Infinity;
    for (let i = 0; i < track.points.length; i++) {
      const pt = track.points[i];
      if (i === 0 || i === track.points.length - 1 || pt.distanceFromStart - lastDist >= 25) {
        const loc = geoToLocalMeters(pt.lat, pt.lon, 0, b.centerLat, b.centerLon, 0);
        corridorPoints.push({ x: loc.x, z: loc.z });
        lastDist = pt.distanceFromStart;
      }
    }
  }

  const add = (resource: OfflineResource) => {
    const existing = resources.get(resource.urls[0]);
    if (!existing) resources.set(resource.urls[0], resource);
    else if (existing.kind === 'elevation') {
      const a = existing.requiredWindow, c = resource.requiredWindow;
      existing.requiredWindow = a && c ? { minX: Math.min(a.minX, c.minX), maxX: Math.max(a.maxX, c.maxX),
        minY: Math.min(a.minY, c.minY), maxY: Math.max(a.maxY, c.maxY) } : undefined;
    }
  };
  for (let z = 10; z <= maxZoom; z++) {
    const latMargin = z <= 16 ? (nw.lat - se.lat) * 0.05 : 0, lonMargin = z <= 16 ? (se.lon - nw.lon) * 0.05 : 0;
    const groupZoom = z >= 17 ? z - 2 : z;
    const a = latLonToTile(nw.lat + latMargin, nw.lon - lonMargin, groupZoom), c = latLonToTile(se.lat - latMargin, se.lon + lonMargin, groupZoom);
    for (let y = a.y; y <= c.y; y++) for (let x = a.x; x <= c.x; x++) {
      if (isCorridor && z >= 17) {
        const tileNW = tileToLatLon(x, y, groupZoom);
        const tileSE = tileToLatLon(x + 1, y + 1, groupZoom);
        const locNW = geoToLocalMeters(tileNW.lat, tileNW.lon, 0, b.centerLat, b.centerLon, 0);
        const locSE = geoToLocalMeters(tileSE.lat, tileSE.lon, 0, b.centerLat, b.centerLon, 0);
        const minX = Math.min(locNW.x, locSE.x), maxX = Math.max(locNW.x, locSE.x);
        const minZ = Math.min(locNW.z, locSE.z), maxZ = Math.max(locNW.z, locSE.z);
        if (!isBoxNearCorridor(minX, maxX, minZ, maxZ, corridorPoints, corridorMeters)) {
          continue;
        }
      }
      const urls = provider.getTileUrls(z, z >= 17 ? x * 4 : x, z >= 17 ? y * 4 : y)
        // Reviewed USGS and USDA/USFS GeoPlatform NAIP exports. Keep the online
        // provider's exact requests/order, including source provenance.
        .filter(offlineSourceAllowed);
      if (!urls.length) throw Error('No approved offline imagery source');
      add({ kind: 'image', urls, width: z >= 17 ? 1024 : 256, height: z >= 17 ? 1024 : 256 });
    }
  }
  const margin = { lat: (nw.lat - se.lat) * 0.05, lon: (se.lon - nw.lon) * 0.05 };
  const overview = elevationRasterRequest({ minLat: footprint.minLat - margin.lat, maxLat: footprint.maxLat + margin.lat,
    minLon: footprint.minLon - margin.lon, maxLon: footprint.maxLon + margin.lon }, 5);
  add({ kind: 'elevation', urls: [overview.url], width: overview.width, height: overview.height });
  // Both normal High base-grid variants; identical requests are deduplicated.
  // Balanced, alternate providers, styles and experimental grid options are not
  // represented as a complete offline High satellite pack.
  const seenDemTileKeys = new Set<string>();
  for (const constrained of [true, false]) {
    const res = TextureBudget.getTerrainMeshResolution(width, depth, constrained, 60);
    const tiles = planTerrainTiles({ parent: { width, depth, segmentsX: res.segX, segmentsZ: res.segZ },
      focusX: 0, focusZ: 0, radiusM: Math.hypot(width, depth), parentCellsPerTile: 8, targetCellM: 5,
      maxTiles: 100000, maxVertices: 1e10 }).tiles;
    for (const tile of tiles) {
      if (isCorridor) {
        const key = `${Math.round(tile.bounds.minX)}:${Math.round(tile.bounds.maxX)}:${Math.round(tile.bounds.minZ)}:${Math.round(tile.bounds.maxZ)}`;
        if (seenDemTileKeys.has(key)) continue;
        seenDemTileKeys.add(key);
        if (!isBoxNearCorridor(tile.bounds.minX, tile.bounds.maxX, tile.bounds.minZ, tile.bounds.maxZ, corridorPoints, corridorMeters)) {
          continue;
        }
      }
      const center = localMetersToGeo((tile.bounds.minX + tile.bounds.maxX) / 2, (tile.bounds.minZ + tile.bounds.maxZ) / 2, b.centerLat, b.centerLon);
      const radius = Math.max(tile.width, tile.depth) / 2 + 100;
      const a = localMetersToGeo(-radius, -radius, center.lat, center.lon), c = localMetersToGeo(radius, radius, center.lat, center.lon);
      const request = elevationRasterRequest({ minLat: c.lat, maxLat: a.lat, minLon: a.lon, maxLon: c.lon }, 1);
      const requiredNW = localMetersToGeo(tile.bounds.minX, tile.bounds.minZ, b.centerLat, b.centerLon);
      const requiredSE = localMetersToGeo(tile.bounds.maxX, tile.bounds.maxZ, b.centerLat, b.centerLon);
      add({ kind: 'elevation', urls: [request.url], width: request.width, height: request.height,
        requiredWindow: requiredElevationWindow(request, { minLat: requiredSE.lat, maxLat: requiredNW.lat, minLon: requiredNW.lon, maxLon: requiredSE.lon }) });
    }
  }
  // Uncompressed planning budget: raw RGBA per PNG, raw F32 per LERC plus
  // 10% overhead. Keep original encoded files; check actual quota per write.
  const estimatedBytes = Math.ceil([...resources.values()].reduce((sum, r) => sum + r.width * r.height * 4, 0) * 1.1);
  // Discover missing DEM coverage before acquiring thousands of imagery exports.
  // Stable ordering keeps the overview first, then local terrain, then imagery.
  // URL-keyed staging remains compatible with the earlier acquisition order.
  const ordered = [...resources.values()].sort((a, c) => Number(c.kind === 'elevation') - Number(a.kind === 'elevation'));
  return {
    id: `${routeId}-high-public-${isCorridor ? 'v3' : 'v2'}-${routeHash.slice(0, 16)}`,
    routeId,
    routeHash,
    name: track.name,
    version: isCorridor ? 3 : 2,
    coverage: isCorridor ? 'corridor' : 'full-model',
    maxZoom,
    estimatedBytes,
    resources: ordered,
  };
}
