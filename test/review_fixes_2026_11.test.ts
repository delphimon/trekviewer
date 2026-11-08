import { it, expect, vi, afterEach, describe } from 'vitest';
import * as THREE from 'three';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { isCONUS } from '../src/terrain/providers/PublicImageryProvider.ts';
import { OfflineStore, hashOfflineBlob } from '../src/offline/OfflineStore.ts';
import { offlineGeographicKey } from '../src/offline/OfflineSourceIdentity.ts';
import { chooseTablePlane } from '../src/xr/TablePlacement.ts';
import { InteractionFeedback } from '../src/xr/InteractionFeedback.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { friendlyRouteError } from '../src/main.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); TextureProvider.resetForTesting(); });

describe('imagery provider selection (review A1)', () => {
  it('starts from the saved choice instead of overwriting it with the build default', async () => {
    const store = new Map<string, string>([[TextureProvider.PROVIDER_STORAGE_KEY, 'esri']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    TextureProvider.resetForTesting();
    expect(TextureProvider.resolveInitialProviderSetting()).toBe('esri');
    await TextureProvider.initializeFromEnvironment();
    expect(TextureProvider.getSatelliteProviderSetting()).toBe('esri');
    expect(TextureProvider.getActiveSatelliteProvider().id).toBe('esri-satellite');
  });

  it('ignores invalid saved values', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'not-a-provider', setItem: () => {}, removeItem: () => {} });
    expect(TextureProvider.readStoredProviderSetting()).toBeUndefined();
  });

  it('never lets a slow, superseded Bing initialization replace a newer choice', async () => {
    let finishInit!: (ok: boolean) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const { CesiumBingImageryProvider } = await import('../src/terrain/providers/ImageryProvider.ts');
    vi.spyOn(CesiumBingImageryProvider.prototype, 'init').mockImplementation(() => new Promise<boolean>(resolve => { finishInit = resolve; }));
    const slow = TextureProvider.setSatelliteProvider('cesium-bing', 'x'.repeat(40));
    await TextureProvider.setSatelliteProvider('esri');
    finishInit(true);
    await expect(slow).resolves.toBe(false);
    expect(TextureProvider.getSatelliteProviderSetting()).toBe('esri');
    expect(TextureProvider.getActiveSatelliteProvider().id).toBe('esri-satellite');
  });

  it('clears only satellite imagery tiles on a provider switch, keeping DEM tiles', () => {
    const cache = (TileImageCache as any).cache as Map<string, unknown>;
    cache.set('public-naip:15:1:2', {}); cache.set('aws-terrarium:15:1:2', {});
    TileImageCache.clearProviders(TextureProvider.getSatelliteImageryProviderIds());
    expect(cache.has('public-naip:15:1:2')).toBe(false);
    expect(cache.has('aws-terrarium:15:1:2')).toBe(true);
    TileImageCache.clear();
  });
});

describe('coverage (review A3)', () => {
  it('excludes Canada and Mexico from the conterminous-US outline', () => {
    expect(isCONUS(46.85, -121.76)).toBe(true); // Mount Rainier
    expect(isCONUS(47.45, -120.82)).toBe(true); // Enchantments
    expect(isCONUS(49.28, -123.12)).toBe(false); // Vancouver
    expect(isCONUS(45.5, -73.57)).toBe(false); // Montreal
    expect(isCONUS(31.0, -110.0)).toBe(false); // Sonora, Mexico
    expect(isCONUS(24.55, -81.8)).toBe(true); // Key West
  });

  it('labels a Vancouver route as outside fine US imagery', () => {
    const bounds = { minLat: 49.25, maxLat: 49.35, minLon: -123.2, maxLon: -123.0, centerLat: 49.3, centerLon: -123.1, widthMeters: 1, depthMeters: 1 } as any;
    expect(TextureProvider.describeCoverageForBounds(bounds).region).not.toBe('conus');
  });
});

describe('offline packs (review B1, B6)', () => {
  it('ignores decode failures when the saved bytes still match their hash', async () => {
    const blob = new Blob(['valid bytes']);
    (OfflineStore as any).suppliedAssets.set(blob, { key: 'k', sha256: await hashOfflineBlob(blob) });
    const quarantine = vi.spyOn(OfflineStore as any, 'quarantine').mockResolvedValue(undefined);
    vi.stubGlobal('indexedDB', {});
    await expect(OfflineStore.reportDecodeFailure(blob)).resolves.toBe(false);
    expect(quarantine).not.toHaveBeenCalled();
  });

  it('quarantines only the damaged asset on a real hash mismatch', async () => {
    const blob = new Blob(['corrupted']);
    (OfflineStore as any).suppliedAssets.set(blob, { key: 'pack\nurl', sha256: 'a'.repeat(64) });
    const quarantine = vi.spyOn(OfflineStore as any, 'quarantine').mockResolvedValue(undefined);
    vi.stubGlobal('indexedDB', {});
    await expect(OfflineStore.reportDecodeFailure(blob)).resolves.toBe(true);
    expect(quarantine).toHaveBeenCalledWith('pack\nurl');
  });

  it('does nothing for blobs that did not come from a saved pack', async () => {
    await expect(OfflineStore.reportDecodeFailure(new Blob(['temp']))).resolves.toBe(false);
  });

  it('keeps geographic keys stable for default requests but separates other encodings', () => {
    const base = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?f=image&bbox=1,2,3,4&bboxSR=3857&imageSR=3857&size=10,10&format=lerc&pixelType=F32&compressionTolerance=0';
    expect(offlineGeographicKey(base)).toBe('geo:elevation:3857:1.000,2.000,3.000,4.000:10,10');
    expect(offlineGeographicKey(base.replace('format=lerc', 'format=png'))).not.toBe(offlineGeographicKey(base));
  });
});

describe('XR helpers (review A7, C1, C3)', () => {
  it('derives the HUD finger hit area from the real panel geometry', () => {
    const hud = Object.assign(Object.create(SpatialHUD.prototype), { mesh: new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6)) });
    expect(hud.getPanelHalfExtents()).toEqual({ halfW: 0.4, halfH: 0.3 });
    const uv = hud.localToUV(new THREE.Vector3(0, 0.29, 0), new THREE.Vector2());
    expect(uv?.y).toBeCloseTo(0.983, 2); // was outside the old 0.265 half-height
    expect(hud.localToUV(new THREE.Vector3(0, 0.31, 0), new THREE.Vector2())).toBeNull();
  });

  it('picks the nearest table-height horizontal plane and ignores floors', () => {
    const viewer = new THREE.Vector3(0, 1.6, 0);
    const floor = { position: new THREE.Vector3(0, 0, -0.5), orientation: 'horizontal', width: 4, depth: 4, semanticLabel: 'floor' };
    const desk = { position: new THREE.Vector3(0.2, 0.74, -0.7), orientation: 'horizontal', width: 1.2, depth: 0.6, semanticLabel: 'table' };
    const shelf = { position: new THREE.Vector3(0, 1.8, -0.3), orientation: 'horizontal', width: 1, depth: 0.4 };
    expect(chooseTablePlane([floor, desk, shelf], viewer)).toBe(desk);
    expect(chooseTablePlane([floor, shelf], viewer)).toBeNull();
  });

  it('plays audio cues without throwing when Web Audio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(() => new InteractionFeedback().play('press')).not.toThrow();
  });
});

describe('route errors (review D3)', () => {
  it('turns parser messages into plain language', () => {
    expect(friendlyRouteError(new Error('XML parse error: Unclosed root tag\nLine: 0'))).toMatch(/not valid GPX/);
    expect(friendlyRouteError(new Error('Valid GPS points could not be extracted after filtering.'))).toMatch(/at least two track points/);
  });
});
