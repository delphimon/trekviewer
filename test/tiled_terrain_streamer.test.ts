import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { TiledTerrainStreamer } from '../src/terrain/TiledTerrainStreamer.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { QUALITY_PROFILES } from '../src/terrain/QualityProfile.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { planTerrainTiles } from '../src/terrain/TerrainTileLayout.ts';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const parent = { width: 3840, depth: 3840, segmentsX: 32, segmentsZ: 32 };
  const attached = new Set<LocalTerrainChunk>();
  const terrain: any = {
    baseMeshGrid: parent, terrainGeoBounds: { centerLat: 46, centerLon: -120 }, terrainBaseElevation: 0,
    terrainMesh: new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()),
    sampleBaseSurfaceY: (x: number, z: number) => 100 + x * 0.01 + z * 0.02,
    attachLocalChunk: (chunk: LocalTerrainChunk) => attached.add(chunk),
    detachLocalChunk: (chunk: LocalTerrainChunk) => { attached.delete(chunk); chunk.dispose(); },
    notifySurfaceChange: vi.fn(),
  };
  const routeGeometry: any = { getTelemetryAtProgress: () => ({ currentPoint: { lat: 46, lon: -120 } }) };
  const streamer = new TiledTerrainStreamer({ terrainResult: terrain, routeGeometry, demGrid: {} as any, qualityProfile: QUALITY_PROFILES['quest-high'] });
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ elevation: 125, isValid: true });
  return { streamer, terrain, parent, attached };
}

async function flushBuild(): Promise<void> { for (let i = 0; i < 6; i++) await Promise.resolve(); }

it('keeps parent coverage through acquisition and publishes one validated tile per frame', async () => {
  const { streamer, terrain, attached } = fixture();
  let complete!: (grid: any) => void;
  const pending = new Promise<any>(resolve => { complete = resolve; });
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockReturnValue(pending);
  streamer.update(0);
  expect(attached.size).toBe(0); expect(terrain.notifySurfaceChange).not.toHaveBeenCalled();
  complete({ zoom: 15, isRealDEM: true }); await flushBuild();
  expect(attached.size).toBe(0);
  streamer.update(0);
  expect(attached.size).toBe(1); expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1);
  expect(streamer.activeChunks[0].mesh.visible).toBe(true);
  streamer.dispose();
});

it('bounds total refinement vertices and reuses stable terrain when focus is stationary', async () => {
  const { streamer } = fixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  for (let i = 0; i < 30; i++) { streamer.update(0); await flushBuild(); }
  const chunks = streamer.activeChunks;
  expect(chunks.length).toBeGreaterThan(1); expect(chunks.length).toBeLessThanOrEqual(12);
  expect(chunks.reduce((sum, c) => sum + c.totalVertices, 0)).toBeLessThanOrEqual(96_000);
  const calls = fetch.mock.calls.length;
  for (let i = 0; i < 72; i++) { streamer.update(0); await flushBuild(); }
  expect(fetch.mock.calls.length).toBe(calls);
  expect(streamer.activeChunks).toEqual(chunks);
  streamer.dispose();
});

it('discards an in-flight tile after route disposal without publishing', async () => {
  const { streamer, terrain, attached } = fixture();
  let complete!: (grid: any) => void;
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockReturnValue(new Promise(resolve => { complete = resolve; }));
  streamer.update(0); streamer.dispose();
  complete({ zoom: 15, isRealDEM: true }); await flushBuild(); streamer.update(0);
  expect(attached.size).toBe(0);
  expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1); // disposal restores parent coverage
});

it('matches heights and normals across adjacent independently built terrain tiles', () => {
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ elevation: 200, isValid: true });
  const plan = planTerrainTiles({ parent: { width: 1920, depth: 960, segmentsX: 16, segmentsZ: 8 }, focusX: 0, focusZ: 0, radiusM: 3000,
    parentCellsPerTile: 8, targetCellM: 10, maxTiles: 2, maxVertices: 30_000 });
  const chunks = plan.tiles.map(layout => new LocalTerrainChunk({
    layout, localGrid: { zoom: 15, isRealDEM: true } as any, centerLat: 46, centerLon: -120,
    terrainBaseElevation: 0, baseElevationSampler: (x, z) => 100 + x * 0.1 + z * 0.2,
  }));
  const [left, right] = chunks.sort((a, b) => a.localBounds.minX - b.localBounds.minX);
  const lp = left.geometry.attributes.position, rp = right.geometry.attributes.position;
  const ln = left.geometry.attributes.normal, rn = right.geometry.attributes.normal;
  const cols = plan.tiles[0].segmentsX + 1;
  for (let row = 0; row <= plan.tiles[0].segmentsZ; row++) {
    const a = row * cols + cols - 1, b = row * cols;
    expect(lp.getY(a)).toBeCloseTo(rp.getY(b), 4);
    expect(ln.getX(a)).toBeCloseTo(rn.getX(b), 4);
    expect(ln.getZ(a)).toBeCloseTo(rn.getZ(b), 4);
  }
  chunks.forEach(chunk => chunk.dispose());
});

it('retains old coverage until removal imagery is prepared, then replaces it atomically', async () => {
  const { streamer, terrain, attached } = fixture();
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  for (let i = 0; i < 15; i++) { streamer.update(0); await flushBuild(); }
  const before = [...attached]; expect(before.length).toBeGreaterThan(0);
  let complete!: (publish: () => boolean) => void;
  const prepared = new Promise<() => boolean>(resolve => { complete = resolve; });
  const prepare = vi.fn().mockReturnValue(prepared);
  (streamer as any).options.prepareSurfaceRemoval = prepare;
  terrain.notifySurfaceChange.mockClear();
  streamer.update(0, { lat: 46.01, lon: -119.99 }); await flushBuild();
  expect(prepare).toHaveBeenCalledTimes(1);
  const retiring: LocalTerrainChunk[] = prepare.mock.calls[0][0]; expect(retiring.length).toBeGreaterThan(0);
  expect(retiring.every(chunk => chunk.mesh.visible && attached.has(chunk))).toBe(true);
  expect(terrain.notifySurfaceChange).not.toHaveBeenCalled();
  const publish = vi.fn(() => { expect(retiring.every(chunk => chunk.mesh.visible)).toBe(true); return true; });
  complete(publish); await flushBuild(); streamer.update(0, { lat: 46.01, lon: -119.99 });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(retiring.every(chunk => !attached.has(chunk))).toBe(true);
  expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1);
  expect(terrain.notifySurfaceChange.mock.calls[0][0]).toHaveProperty('minX');
  streamer.dispose();
});

it('can change quality before the first tile without repeatedly retiring new tiles', async () => {
  const { streamer } = fixture();
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  streamer.setQualityProfile(QUALITY_PROFILES['quest-balanced']);
  for (let i = 0; i < 15; i++) { streamer.update(0); await flushBuild(); }
  expect(streamer.activeChunks.length).toBeGreaterThan(1);
  expect(streamer.activeChunks.length).toBeLessThanOrEqual(9);
  streamer.dispose();
});
