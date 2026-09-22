import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { TileRequestScheduler } from '../src/terrain/TileRequestScheduler.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { ImageryPatch } from '../src/terrain/ImageryPatch.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Adaptive View-Dependent Imagery Level-of-Detail (LOD)', () => {
  it('TileRequestScheduler enforces concurrency, priority ordering, and deduplication', async () => {
    const scheduler = new TileRequestScheduler(2); // Concurrency limit of 2

    const executionOrder: string[] = [];
    let resolveTaskA: (img: any) => void;
    let resolveTaskB: (img: any) => void;

    const promiseA = scheduler.schedule(
      'tile-A',
      100, // lower priority
      () =>
        new Promise((resolve) => {
          executionOrder.push('start-A');
          resolveTaskA = resolve;
        })
    );

    const promiseB = scheduler.schedule(
      'tile-B',
      200, // lower priority
      () =>
        new Promise((resolve) => {
          executionOrder.push('start-B');
          resolveTaskB = resolve;
        })
    );

    // Concurrency is 2, so A and B should both have started
    assert.deepStrictEqual(executionOrder, ['start-A', 'start-B']);

    // Schedule C (priority 50, high) and D (priority 10, highest) while slots are full
    const promiseC = scheduler.schedule(
      'tile-C',
      50,
      () =>
        new Promise((resolve) => {
          executionOrder.push('start-C');
          resolve({} as any);
        })
    );

    const promiseD = scheduler.schedule(
      'tile-D',
      10, // highest priority among queued!
      () =>
        new Promise((resolve) => {
          executionOrder.push('start-D');
          resolve({} as any);
        })
    );

    // Also test deduplication: scheduling 'tile-D' again should return existing promise without starting another task
    const promiseD2 = scheduler.schedule(
      'tile-D',
      5,
      () => {
        executionOrder.push('duplicate-D');
        return Promise.resolve({} as any);
      }
    );

    assert.strictEqual(promiseD, promiseD2, 'Identical in-flight / queued tile key must be deduplicated');

    // Complete task A
    resolveTaskA!({} as any);
    await promiseA;

    // Slot freed: Task D (priority 10) must start BEFORE Task C (priority 50)
    await promiseD;
    assert.strictEqual(executionOrder[2], 'start-D', 'Higher priority task D must execute before C');

    // Complete task B
    resolveTaskB!({} as any);
    await promiseB;
    await promiseC;

    assert.strictEqual(executionOrder[3], 'start-C', 'Task C executes once slot frees');
  });

  it('TileImageCache accounts for byte memory and evicts LRU entries under budget', () => {
    TileImageCache.clear();
    const origMax = TileImageCache.getMaxMemoryBytes();

    try {
      // Set small memory budget of 1 MB (can hold ~4 256x256 tiles at 256KB each)
      TileImageCache.setMaxMemoryBytes(1024 * 1024);

      const createFakeImage = (id: string): HTMLImageElement => {
        return {
          width: 256,
          height: 256,
          src: id,
        } as any;
      };

      TileImageCache.set('t1', createFakeImage('1'));
      TileImageCache.set('t2', createFakeImage('2'));
      TileImageCache.set('t3', createFakeImage('3'));
      TileImageCache.set('t4', createFakeImage('4'));

      assert.strictEqual(TileImageCache.size(), 4);
      assert.strictEqual(TileImageCache.getMemoryBytes(), 4 * 256 * 256 * 4); // 1,048,576 bytes

      // Access t1 so it becomes most recently used
      TileImageCache.get('t1');

      // Adding t5 must evict the oldest unaccessed tile (t2)
      TileImageCache.set('t5', createFakeImage('5'));

      assert.strictEqual(TileImageCache.size(), 4, 'Cache size must remain bounded at 4');
      assert.strictEqual(TileImageCache.has('t2'), false, 't2 must have been evicted by LRU');
      assert.strictEqual(TileImageCache.has('t1'), true, 't1 must still be in cache because it was recently accessed');
      assert.strictEqual(TileImageCache.has('t5'), true, 't5 must be in cache');
    } finally {
      TileImageCache.setMaxMemoryBytes(origMax);
      TileImageCache.clear();
    }
  });

  it('ImageryPatch conforms to terrain elevation, adjusts with vertical exaggeration, and uses polygonOffset', () => {
    const fakeTexture = new THREE.Texture();
    const sampler = () => 500; // 500m relative elevation

    const centerLat = 46.85;
    const centerLon = -121.75;
    const tile = latLonToTile(centerLat, centerLon, 15);

    const patch = new ImageryPatch(
      15,
      tile.x,
      tile.y,
      centerLat,
      centerLon,
      1000,
      sampler,
      1.0,
      fakeTexture
    );

    assert(patch.mesh.geometry instanceof THREE.PlaneGeometry);
    const pos = patch.mesh.geometry.attributes.position;
    const y0 = pos.getY(0);

    // Initial Y should reflect sampler elevation (approx 500m + 0.04m micro offset)
    assert(y0 >= 499 && y0 <= 501, `Expected Y around 500, got ${y0}`);

    const mat = patch.mesh.material as THREE.MeshStandardMaterial;
    assert.strictEqual(mat.polygonOffset, true, 'Patch material must enable polygonOffset to prevent Z-fighting');
    assert(mat.polygonOffsetFactor < 0, 'Polygon offset factor must be negative');

    // Scale vertical exaggeration to 2.0x
    patch.setVerticalExaggeration(2.0);
    const yExag = pos.getY(0);
    assert(yExag >= 999 && yExag <= 1001, `Expected exaggerated Y around 1000m, got ${yExag}`);

    // Disposing patch
    patch.dispose();
    patch.dispose(); // Idempotent
    fakeTexture.dispose();
  });

  it('ImageryLODManager computes target zoom, respects baseZoom, and evicts patches cleanly', () => {
    const bounds: GeoBounds = {
      minLat: 46.80, maxLat: 46.90, minLon: -121.80, maxLon: -121.70,
      minEle: 1000, maxEle: 4000, centerLat: 46.85, centerLon: -121.75,
      widthMeters: 10000, depthMeters: 10000, elevationSpan: 3000,
    };

    const lod = new ImageryLODManager({
      bounds,
      terrainBaseElevation: 1000,
      centerLat: 46.85,
      centerLon: -121.75,
      elevationSampler: () => 1500,
      baseZoom: 13,
      initialExaggeration: 1.0,
      initialStyle: 'satellite',
      isXR: false,
    });

    const stats0 = lod.getLODStats();
    assert.strictEqual(stats0.activePatches, 0, 'Initially 0 refinement patches');
    assert.strictEqual(stats0.targetZoom, 13);
    assert.strictEqual(stats0.baseZoom, 13);

    // 1. In diorama mode when zoomed out (small scale), target zoom remains at baseZoom
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 1.2, 0.6); // 0.6m away in room space

    const dioramaRoot = new THREE.Group();
    dioramaRoot.scale.setScalar(0.0001); // 1:10000 scale (1m = 10km)

    lod.update(camera, dioramaRoot, 'diorama', 0.3); // delta > 0.25 triggers LOD check

    const statsZoomedOut = lod.getLODStats();
    assert.strictEqual(statsZoomedOut.targetZoom, 13, 'At far distance, target zoom stays at baseZoom 13');
    assert.strictEqual(statsZoomedOut.activePatches, 0, 'No refinement patches needed when at baseZoom');

    // 2. In diorama mode when user zooms in 10x closer (scale = 0.001)
    dioramaRoot.scale.setScalar(0.001); // 10x closer zoom
    lod.update(camera, dioramaRoot, 'diorama', 0.3);

    const statsZoomedIn = lod.getLODStats();
    assert(statsZoomedIn.targetZoom >= 15, `Expected targetZoom >= 15 when zoomed in 10x, got ${statsZoomedIn.targetZoom}`);

    // 3. In 1:1 first-person mode
    lod.update(camera, dioramaRoot, 'first-person', 0.3);
    const stats1to1 = lod.getLODStats();
    assert(stats1to1.targetZoom >= 16, `Expected high zoom in 1:1 mode, got ${stats1to1.targetZoom}`);

    // 4. Style switch and vertical exaggeration
    lod.setTextureStyle('topo');
    lod.setVerticalExaggeration(2.5);

    // 5. Cleanup
    lod.dispose();
    lod.dispose(); // Idempotent
  });
});
