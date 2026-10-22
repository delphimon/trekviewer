import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { DEFAULT_OFFLINE_ROUTES, planOfflineRoute } from '../src/offline/OfflinePlan.ts';
import { OfflineStore, offlineSourceAllowed } from '../src/offline/OfflineStore.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { elevationRasterRequest } from '../src/terrain/BestAvailableElevation.ts';
import { PublicImageryProvider } from '../src/terrain/providers/PublicImageryProvider.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
const manifest = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8'));
afterEach(() => vi.restoreAllMocks());

it.each(DEFAULT_OFFLINE_ROUTES)('covers actual overview request identity and fine imagery along %s without child-crop duplication', async id => {
  const route = manifest.find((r: { id: string }) => r.id === id);
  const track = GPXParser.parse(fs.readFileSync('public' + route.file, 'utf8'));
  const actualHash = createHash('sha256').update(fs.readFileSync('public' + route.file, 'utf8').replace(/\r\n?/g, '\n')).digest('hex');
  expect(OfflineStore.compatible({ routeId: id, routeHash: actualHash } as never)).toBe(true);
  expect(OfflineStore.compatible({ routeId: id, routeHash: 'a'.repeat(64) } as never)).toBe(false);
  const plan = planOfflineRoute(track, id, 'a'.repeat(64));
  expect(plan.version).toBe(2); expect(plan.id).toContain('-high-public-v2-');
  const overview = vi.spyOn(ElevationTileService, 'fetchElevationGrid').mockResolvedValue(null);
  await TerrainGenerator.prepareElevation(track.bounds);
  const [b, margin = 0.25] = overview.mock.calls[0];
  const lat = (b.maxLat - b.minLat) * margin, lon = (b.maxLon - b.minLon) * margin;
  const url = elevationRasterRequest({ minLat: b.minLat - lat, maxLat: b.maxLat + lat, minLon: b.minLon - lon, maxLon: b.maxLon + lon }, 5).url;
  const urls = new Set(plan.resources.flatMap(r => r.urls));
  expect(urls.has(url)).toBe(true);
  expect(plan.resources[0].urls).toEqual([url]);
  const firstImage = plan.resources.findIndex(r => r.kind === 'image');
  expect(firstImage).toBeGreaterThan(500);
  expect(plan.resources.slice(firstImage).every(r => r.kind === 'image')).toBe(true);
  const provider = new PublicImageryProvider();
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) for (let z = 10; z <= 19; z++) {
    const p = track.points[Math.round((track.points.length - 1) * fraction)], xy = latLonToTile(p.lat, p.lon, z);
    expect(urls.has(provider.getTileUrls(z, xy.x, xy.y)[0])).toBe(true);
    if (z >= 17) {
      const candidates = provider.getTileUrls(z, xy.x, xy.y);
      expect(plan.resources.find(r => r.urls[0] === candidates[0])?.urls).toEqual(candidates);
    }
  }
  expect(plan.resources.length).toBeGreaterThan(4000);
  expect(plan.resources.every(r => r.urls.every(offlineSourceAllowed))).toBe(true);
  expect(new Set(plan.resources.map(r => r.urls[0])).size).toBe(plan.resources.length);
  expect(plan.resources.filter(r => r.kind === 'elevation' && r.requiredWindow).length).toBeGreaterThan(500);
  expect(plan.estimatedBytes).toBeGreaterThan(1e9);
  expect(plan.id).not.toBe(planOfflineRoute(track, id, 'b'.repeat(64)).id);
  expect(plan.coverage).toBe('full-model'); expect(plan.maxZoom).toBe(19);
});

it('restricts offline acquisition to reviewed public sources without credential-bearing or lookalike URLs', () => {
  const url = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?f=image';
  expect(offlineSourceAllowed(url)).toBe(true);
  const geo = 'https://imagery.geoplatform.gov/iipp/rest/services/NAIP/NAIP_plus/ImageServer/exportImage?f=image';
  expect(offlineSourceAllowed(geo)).toBe(true);
  for (const invalid of [geo + '&access_token=private', geo.replace('.gov/', '.gov.example.test/'),
    geo.replace('/exportImage?', '/query?'), geo.replace('/NAIP_plus/', '/NAIP2018_CONUS/'), geo.replace('https:', 'http:')]) expect(offlineSourceAllowed(invalid)).toBe(false);
  for (const invalid of [url + '&key=private', url + '&access_token=private', url.replace('.gov/', '.gov.example.test/'),
    url.replace('https:', 'http:'), 'https://assets.cesium.com/1?token=private']) expect(offlineSourceAllowed(invalid)).toBe(false);
  expect(() => planOfflineRoute({} as never, 'olympus-bailey-2026', 'a'.repeat(64))).toThrow('Unsupported');
});
