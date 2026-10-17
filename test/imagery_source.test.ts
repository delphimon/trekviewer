import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { copyImagerySource, getImagerySource, imagerySourceId, recordImagerySource } from '../src/terrain/ImagerySource.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { PublicImageryProvider, NAIP_PLUS_SERVICE, NAIP_SERVICE } from '../src/terrain/providers/PublicImageryProvider.ts';

const preferred = `${NAIP_PLUS_SERVICE}/exportImage?token=do-not-export`;
const fallback = `${NAIP_SERVICE}/exportImage?bbox=1,2,3,4`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); TileImageCache.clear(); });

it('classifies exact public services without retaining URLs or accepting lookalike hosts', () => {
  expect(imagerySourceId(preferred)).toBe('usgs-naip-plus');
  expect(imagerySourceId(fallback)).toBe('usgs-naip');
  expect(imagerySourceId('https://imagery.geoplatform.gov/iipp/rest/services/NAIP/NAIP_plus/ImageServer/exportImage')).toBe('geoplatform-naip');
  expect(imagerySourceId('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export')).toBe('usgs-overview');
  expect(imagerySourceId('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/15/1/2.jpg')).toBe('eox-global');
  expect(imagerySourceId('https://imagery.nationalmap.gov.example.test/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage')).toBe('other');
  expect(imagerySourceId('invalid')).toBe('other');
  const image = {}; recordImagerySource(image, preferred, preferred);
  expect(getImagerySource(image)).toEqual({ source: 'usgs-naip-plus', configuredAlternative: false });
  expect(JSON.stringify(getImagerySource(image))).not.toContain('token');
});

it('preserves the actual alternative on cropped images and cache hits', async () => {
  const canvases: object[] = [];
  vi.stubGlobal('document', { createElement: () => { const canvas = { width: 0, height: 0, dataset: {}, getContext: () => ({ drawImage() {} }) }; canvases.push(canvas); return canvas; } });
  const load = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockRejectedValueOnce(Error('outage')).mockResolvedValue({ width: 1024, height: 1024 });
  const provider = { id: 'test-source', displayName: 'test', attribution: '', maxZoom: 19,
    getTileUrls: () => [preferred, fallback], getTileImageRegion: () => ({ x: 0, y: 0, width: 256, height: 256 }) };
  const image = await TileImageCache.loadTile(provider, 19, 1, 1);
  expect(image).toBe(canvases[0]);
  expect(getImagerySource(image)).toEqual({ source: 'usgs-naip', configuredAlternative: true });
  expect(await TileImageCache.loadTile(provider, 19, 1, 1)).toBe(image);
  expect(load).toHaveBeenCalledTimes(2);
  // Service cooldown reorders the alternative first; it is still an alternative.
  const next = await TileImageCache.loadTile(provider, 19, 2, 1);
  expect(getImagerySource(next)?.configuredAlternative).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
});

it('keeps aerial provenance through real Hybrid compositing when labels fail', async () => {
  const sat = {}; recordImagerySource(sat, fallback, preferred);
  vi.spyOn(TileImageCache, 'loadTile').mockResolvedValueOnce(sat as HTMLImageElement).mockRejectedValueOnce(Error('labels unavailable'));
  vi.spyOn(TextureProvider, 'getActiveSatelliteProvider').mockReturnValue(new PublicImageryProvider());
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }) });
  const hybrid = await ImageryLODManager.loadPatchImage(19, 1, 1, 'hybrid');
  expect(hybrid).not.toBe(sat);
  expect(getImagerySource(hybrid)).toEqual({ source: 'usgs-naip', configuredAlternative: true });
  const unknown = {}; copyImagerySource({}, unknown); expect(getImagerySource(unknown)).toBeUndefined();
});

it('counts published visible patches separately from hidden residents and marks unknown sources honestly', () => {
  const bounds = { minLat:46.8,maxLat:46.9,minLon:-121.8,maxLon:-121.7,centerLat:46.85,centerLon:-121.75,widthMeters:7600,depthMeters:11100,minEle:0,maxEle:1000,elevationSpan:1000 };
  const manager = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0 });
  const add = (id: string, zoom: number, visible: boolean, source?: string) => {
    const image = {}; if (source) recordImagerySource(image, source, preferred);
    const texture = new THREE.Texture(image as HTMLImageElement);
    const mesh = new THREE.Mesh(); mesh.visible = visible;
    (manager as any).patches.set(id, { zoom, texture, mesh, dispose: () => { texture.dispose(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } });
  };
  add('fine', 19, true, fallback); add('hidden', 19, false, preferred); add('unknown', 19, true); add('overview', 15, true, preferred);
  try {
    expect(manager.getDiagnostics()).toMatchObject({ visibleCount: 3, visibleBySource: { 'usgs-naip': 1, unknown: 1, 'usgs-naip-plus': 1 },
      visibleFineBySource: { 'usgs-naip': 1, unknown: 1 }, visibleAlternativeSources: 1 });
  } finally { manager.dispose(); }
});
