import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { RouteLoader } from '../src/core/RouteLoader.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

describe('Style races and RouteLoader transactional lifecycle', () => {
  const mockTrack: TrackStats = {
    name: 'Style Race Test',
    points: [
      { lat: 46.85, lon: -121.75, ele: 1500, time: new Date(), distanceFromStart: 0, grade: 0.05, speed: 1.2, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
      { lat: 46.86, lon: -121.76, ele: 3000, time: new Date(), distanceFromStart: 5000, grade: 0.1, speed: 1.0, elapsedSeconds: 100, playbackSeconds: 100, index: 1 },
    ],
    totalDistance: 5000,
    elevationGain: 1500,
    elevationLoss: 0,
    minElevation: 1500,
    maxElevation: 3000,
    movingTime: 5000,
    totalPlaybackSeconds: 60,
    avgSpeed: 1.0,
    maxSpeed: 2.0,
    bounds: {
      minLat: 46.85, maxLat: 46.86, minLon: -121.76, maxLon: -121.75,
      minEle: 1500, maxEle: 3000, centerLat: 46.855, centerLon: -121.755,
      widthMeters: 3000, depthMeters: 3000, elevationSpan: 1500,
    },
    waypoints: [],
    landmarks: [],
    segments: [],
    warnings: [],
  };

  it('prevents stale async texture styles from overwriting newly requested styles', async () => {
    // Mock TextureProvider methods with controlled delays
    const origFetchTopo = TextureProvider.fetchTopoTexture;
    const origFetchHybrid = TextureProvider.fetchHybridTexture;
    const origDoc = (globalThis as any).document;

    (globalThis as any).document = {
      createElement: () => ({
        width: 1024,
        height: 1024,
        getContext: () => ({
          fillRect: () => {},
          stroke: () => {},
          beginPath: () => {},
          arc: () => {},
          moveTo: () => {},
          lineTo: () => {},
          closePath: () => {},
          createRadialGradient: () => ({ addColorStop: () => {} }),
          createLinearGradient: () => ({ addColorStop: () => {} }),
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => {},
        }),
      }),
    };

    let hybridResolved = false;
    let topoResolved = false;

    const hybridTextureMock = new THREE.CanvasTexture({} as any);
    const topoTextureMock = new THREE.CanvasTexture({} as any);

    (TextureProvider as any).fetchHybridTexture = async () => {
      // Slow network response (100ms)
      await new Promise((r) => setTimeout(r, 100));
      hybridResolved = true;
      return hybridTextureMock;
    };

    (TextureProvider as any).fetchTopoTexture = async () => {
      // Faster network response (20ms)
      await new Promise((r) => setTimeout(r, 20));
      topoResolved = true;
      return topoTextureMock;
    };

    try {
      const terrain = await TerrainGenerator.generate(mockTrack);

      // User first clicks 'hybrid' (slow network)
      const p1 = terrain.setTextureStyle('hybrid');

      // Then 10ms later clicks 'topo' (faster network)
      await new Promise((r) => setTimeout(r, 10));
      const p2 = terrain.setTextureStyle('topo');

      await Promise.all([p1, p2]);

      assert(topoResolved, 'Topo texture should have resolved');
      assert(hybridResolved, 'Hybrid texture should have resolved');

      // Since 'topo' was the final user choice, the active material map must NOT be hybrid!
      const mat = (terrain.terrainMesh.material as THREE.MeshStandardMaterial);
      assert.strictEqual(mat.map, topoTextureMock, 'Terrain material must keep the latest requested style (topo)');

      // Idempotent dispose
      terrain.dispose();
      terrain.dispose();
      hybridTextureMock.dispose();
      topoTextureMock.dispose();
    } finally {
      TextureProvider.fetchTopoTexture = origFetchTopo;
      TextureProvider.fetchHybridTexture = origFetchHybrid;
      (globalThis as any).document = origDoc;
    }
  });

  it('rolls back and disposes partially allocated GPU objects if route loading throws', async () => {
    let terrainDisposed = false;
    const origGenerate = TerrainGenerator.generate;
    (TerrainGenerator as any).generate = async () => {
      return {
        group: new THREE.Group(),
        terrainMesh: new THREE.Mesh(),
        skirtMesh: new THREE.Mesh(),
        bounds: mockTrack.bounds,
        terrainBaseElevation: 1000,
        terrainQuality: 'dem',
        demGrid: null,
        elevationSampler: () => 1500,
        setTextureStyle: async () => {},
        setVerticalExaggeration: () => {},
        dispose: () => { terrainDisposed = true; },
      };
    };

    const mockSceneManager: any = {
      scene: new THREE.Group(),
      dioramaRoot: new THREE.Group(),
      renderer: { xr: { isPresenting: false } },
      setDioramaVolume: () => {},
      setViewMode: () => {},
    };

    const session = new TrekSession();
    const loader = new RouteLoader(session, mockSceneManager);

    // Corrupt GPX to trigger an error after terrain generation (e.g. invalid point list for TrailMesh)
    // We simulate by monkey patching TrailMesh.create to throw
    const TrailMeshModule = await import('../src/visualization/TrailMesh.ts');
    const origCreate = TrailMeshModule.TrailMesh.create;
    TrailMeshModule.TrailMesh.create = () => {
      throw new Error('Simulated TrailMesh allocation failure');
    };

    try {
      const result = await loader.loadRouteFromXml(
        `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="46.85" lon="-121.75"><ele>1500</ele></trkpt><trkpt lat="46.86" lon="-121.76"><ele>1600</ele></trkpt></trkseg></trk></gpx>`,
        'Failing Route',
        'failing_route'
      );

      assert.strictEqual(result, null, 'Failed route must return null');
      assert.strictEqual(terrainDisposed, true, 'Terrain must be atomically disposed on rollback');
      assert.strictEqual(session.getState().loadingPhase, 'error');
    } finally {
      TerrainGenerator.generate = origGenerate;
      TrailMeshModule.TrailMesh.create = origCreate;
    }
  });
});
