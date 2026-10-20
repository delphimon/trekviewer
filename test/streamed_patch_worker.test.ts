import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { EsriWorldImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';
import { disposeTerrainJobs, type TerrainJob } from '../src/terrain/TerrainJobs.ts';
import { buildPromotedSurfacePatches, type SurfaceMeshSnapshot } from '../src/terrain/SurfacePromotion.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';

const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 6000, depthMeters: 9000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  messages: TerrainJob[] = [];
  sources?: SurfaceMeshSnapshot[];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor() { ControlledWorker.instances.push(this); queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
  postMessage(job: TerrainJob) {
    const copied = structuredClone(job);
    this.messages.push(copied);
    if (copied.kind === 'surface' && !copied.reuseSources) this.sources = copied.input.sources;
  }
  complete() {
    const job = this.messages.at(-1)!;
    if (job.kind !== 'surface') throw Error('Expected a surface job');
    const result = buildPromotedSurfacePatches({ ...job.input, sources: this.sources! });
    this.onmessage?.({ data: { result } });
  }
  terminate() { this.terminated = true; }
}

function setup(concurrency = 2) {
  ControlledWorker.instances = [];
  vi.stubGlobal('Worker', ControlledWorker);
  const load = vi.spyOn(ImageryLODManager, 'loadPatchImage').mockResolvedValue({ width: 256, height: 256 } as HTMLCanvasElement);
  const geometry = new THREE.PlaneGeometry(2000, 2000, 64, 64); geometry.rotateX(-Math.PI / 2);
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    geometry.attributes.position.setY(i, 200 + geometry.attributes.position.getX(i) * .1);
  }
  geometry.computeVertexNormals();
  const base = new THREE.Mesh(geometry); new THREE.Group().add(base);
  const manager: any = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0,
    elevationSampler: () => 0, terrainMesh: base, maxConcurrency: concurrency, enableFadeIn: false });
  const tile = latLonToTile(bounds.centerLat, bounds.centerLon, 19);
  const candidates = Array.from({ length: 3 }, (_, i) => ({ x: tile.x + i, y: tile.y, zoom: 19, dist: i }));
  return { manager, base, load, candidates };
}

afterEach(() => { disposeTerrainJobs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('bounds decoded imagery while clipping in the worker and mounts identical geometry without synchronous rebuilding', async () => {
  const { manager, base, load, candidates } = setup();
  const syncBuild = vi.spyOn(manager, 'buildPatchGeometry');
  try {
    const expected = manager.buildPatchGeometry(19, candidates[0].x, candidates[0].y);
    syncBuild.mockClear();
    manager.reconcileDesiredTiles(candidates, new EsriWorldImageryProvider(), 19);
    await flush();
    const worker = ControlledWorker.instances[0];
    expect(load).toHaveBeenCalledTimes(2);
    expect(manager.activeRequestCount).toBe(2);
    expect(manager.patches.size).toBe(0);
    expect(worker.messages).toHaveLength(1); // The reusable worker serializes preparation.
    worker.complete(); await flush();
    const actual = [...manager.patches.values()][0] as any;
    for (const attribute of ['position', 'normal', 'uv']) {
      expect(actual.mesh.geometry.attributes[attribute].array).toEqual(expected.attributes[attribute].array);
    }
    expect(actual.mesh.geometry.index.array).toEqual(expected.index.array);
    expect(actual.mesh.geometry.boundingBox.equals(expected.boundingBox)).toBe(true);
    expect(actual.mesh.geometry.boundingSphere.equals(expected.boundingSphere)).toBe(true);
    expect(syncBuild).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(3);
    expect(worker.messages[1].kind).toBe('surface');
    const second: any = worker.messages[1];
    expect(second.reuseSources).toBe(true); expect(second.input.sources).toEqual([]);
    worker.complete(); await flush(); worker.complete(); await flush();
    expect(manager.patches.size).toBe(3); expect(manager.activeRequestCount).toBe(0);
    expect(base.geometry.attributes.position.array.byteLength).toBeGreaterThan(0);
    expected.dispose();
  } finally { manager.dispose(); base.geometry.dispose(); }
});

it('retries against a changed DEM surface before mounting the tile', async () => {
  const { manager, base, candidates } = setup(1);
  try {
    manager.reconcileDesiredTiles(candidates.slice(0, 1), new EsriWorldImageryProvider(), 19);
    await flush(); const worker = ControlledWorker.instances[0];
    for (let i = 0; i < base.geometry.attributes.position.count; i++) base.geometry.attributes.position.setY(i, 800);
    base.geometry.computeVertexNormals(); manager.reprojectPatches();
    worker.complete(); await flush();
    expect(manager.patches.size).toBe(0);
    expect(worker.messages).toHaveLength(2);
    const retry: any = worker.messages[1];
    expect(retry.reuseSources).not.toBe(true); expect(retry.input.sources).toHaveLength(1);
    worker.complete(); await flush();
    const patch: any = [...manager.patches.values()][0];
    const positions = patch.mesh.geometry.attributes.position;
    expect(positions.count).toBeGreaterThan(0);
    for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeCloseTo(800.04, 3);
    expect(manager.activeRequestCount).toBe(0);
  } finally { manager.dispose(); base.geometry.dispose(); }
});

it.each(['style', 'mode', 'dispose'])('cancels stale publication on %s changes without restarting a healthy worker', async change => {
  const { manager, base, candidates } = setup(1);
  try {
    manager.reconcileDesiredTiles(candidates.slice(0, 1), new EsriWorldImageryProvider(), 19);
    await flush(); const worker = ControlledWorker.instances[0];
    if (change === 'style') await manager.setTextureStyle('topo');
    if (change === 'mode') manager.setViewMode('first-person');
    if (change === 'dispose') manager.dispose();
    worker.complete(); await flush();
    expect(worker.terminated).toBe(false);
    expect(manager.patches.size).toBe(0); expect(manager.activeRequestCount).toBe(0);
    if (change !== 'dispose') {
      manager.reconcileDesiredTiles(candidates.slice(0, 1), new EsriWorldImageryProvider(), 19);
      await flush();
      expect(ControlledWorker.instances).toHaveLength(1);
      const job: any = worker.messages[1];
      expect(job.kind).toBe('surface');
      expect(job.reuseSources).toBe(true); expect(job.input.sources).toHaveLength(0);
      worker.complete(); await flush(); expect(manager.patches.size).toBe(1);
    }
  } finally { manager.dispose(); base.geometry.dispose(); }
});
