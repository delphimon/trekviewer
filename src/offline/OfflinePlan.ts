import type { TrackStats } from '../gpx/TrackTypes.ts';
import { localMetersToGeo, latLonToTile } from '../gpx/Coordinates.ts';
import { TextureBudget } from '../terrain/TextureBudget.ts';
import { planTerrainTiles } from '../terrain/TerrainTileLayout.ts';
import { elevationRasterRequest, requiredElevationWindow } from '../terrain/BestAvailableElevation.ts';
import type { RasterSampleWindow } from '../terrain/LercElevation.ts';
import { PublicImageryProvider } from '../terrain/providers/PublicImageryProvider.ts';

export const DEFAULT_OFFLINE_ROUTES = ['rainier-emmons', 'enchantments-dragontail'] as const;
export interface OfflineResource {
  urls: string[];
  kind: 'image' | 'elevation';
  width: number; height: number;
  requiredWindow?: RasterSampleWindow;
}
export interface OfflinePlan {
  id: string; routeId: string; routeHash: string; name: string;
  version: 1; coverage: 'full-model'; maxZoom: 19;
  estimatedBytes: number; resources: OfflineResource[];
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

/** Current renderer-compatible source inventory, generated on demand rather than
 * placing thousands of source URLs in the startup bundle. No network side effects.
 * Revision includes the GPX hash; change the plan version for layout/provider changes.
 * Public satellite imagery, normal High geometry and unmodified source requests. */
export function planOfflineRoute(track: TrackStats, routeId: string, routeHash: string): OfflinePlan {
  if (!DEFAULT_OFFLINE_ROUTES.some(id => id === routeId) || !/^[a-f0-9]{64}$/.test(routeHash)) throw Error('Unsupported offline route revision');
  const b = track.bounds, width = Math.max(1500, b.widthMeters * 1.5), depth = Math.max(1500, b.depthMeters * 1.5);
  const nw = localMetersToGeo(-width / 2, -depth / 2, b.centerLat, b.centerLon), se = localMetersToGeo(width / 2, depth / 2, b.centerLat, b.centerLon);
  const footprint = { minLat: se.lat, maxLat: nw.lat, minLon: nw.lon, maxLon: se.lon };
  const resources = new Map<string, OfflineResource>(), provider = new PublicImageryProvider();
  const add = (resource: OfflineResource) => {
    const existing = resources.get(resource.urls[0]);
    if (!existing) resources.set(resource.urls[0], resource);
    else if (existing.kind === 'elevation') {
      const a = existing.requiredWindow, c = resource.requiredWindow;
      existing.requiredWindow = a && c ? { minX: Math.min(a.minX, c.minX), maxX: Math.max(a.maxX, c.maxX),
        minY: Math.min(a.minY, c.minY), maxY: Math.max(a.maxY, c.maxY) } : undefined;
    }
  };
  for (let z = 10; z <= 19; z++) {
    const latMargin = z <= 16 ? (nw.lat - se.lat) * 0.05 : 0, lonMargin = z <= 16 ? (se.lon - nw.lon) * 0.05 : 0;
    const groupZoom = z >= 17 ? z - 2 : z;
    const a = latLonToTile(nw.lat + latMargin, nw.lon - lonMargin, groupZoom), c = latLonToTile(se.lat - latMargin, se.lon + lonMargin, groupZoom);
    for (let y = a.y; y <= c.y; y++) for (let x = a.x; x <= c.x; x++) {
      const urls = provider.getTileUrls(z, z >= 17 ? x * 4 : x, z >= 17 ? y * 4 : y)
        // The initial offline review covers USGS endpoints. Commercial/keyed,
        // global and additional mirrors retain their independent online policy.
        .filter(url => /^https:\/\/(?:imagery|basemap)\.nationalmap\.gov\//.test(url));
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
  for (const constrained of [true, false]) {
    const res = TextureBudget.getTerrainMeshResolution(width, depth, constrained, 60);
    const tiles = planTerrainTiles({ parent: { width, depth, segmentsX: res.segX, segmentsZ: res.segZ },
      focusX: 0, focusZ: 0, radiusM: Math.hypot(width, depth), parentCellsPerTile: 8, targetCellM: 5,
      maxTiles: 100000, maxVertices: 1e10 }).tiles;
    for (const tile of tiles) {
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
  // Conservative preflight capacity: raw RGBA per PNG, raw F32 per LERC plus
  // 10% overhead. Actual bytes are shown while downloading; compression unclaimed.
  const estimatedBytes = Math.ceil([...resources.values()].reduce((sum, r) => sum + r.width * r.height * 4, 0) * 1.1);
  return { id: `${routeId}-high-public-v1-${routeHash.slice(0, 16)}`, routeId, routeHash, name: track.name,
    version: 1, coverage: 'full-model', maxZoom: 19, estimatedBytes, resources: [...resources.values()] };
}
