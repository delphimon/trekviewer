import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  TerrainGenerator,
  type TerrainResult,
  type TerrainSurfaceChange,
  type TerrainSurfaceBounds,
} from '../src/terrain/TerrainGenerator.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { QualityProfileManager } from '../src/terrain/QualityProfile.ts';
import type { GeoBounds, TrackStats, GPXPoint, GPXWaypoint } from '../src/gpx/TrackTypes.ts';
import type { ElevationGrid } from '../src/terrain/ElevationTiles.ts';

class MockCanvas {
  public width = 256;
  public height = 256;
  public pixelBuffer: Uint8ClampedArray = new Uint8ClampedArray(256 * 256 * 4);
  getContext(type: string) {
    if (type !== '2d') return null;
    let currentFill = '#000000';
    return {
      canvas: this,
      get fillStyle() {
        return currentFill;
      },
      set fillStyle(val: string) {
        currentFill = val;
      },
      fillRect: () => {},
      strokeRect: () => {},
      rect: () => {},
      roundRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
      putImageData: () => {},
      clearRect: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fillText: () => {},
      measureText: (text: string) => ({ width: text.length * 10 }),
      createImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
    };
  }
}

describe('Stage X4: Terrain SurfaceRevision and Dependent Reprojection', () => {
  let origDocument: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return new MockCanvas();
        }
        return {};
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    vi.restoreAllMocks();
  });
  const testBounds: GeoBounds = {
    minLat: 46.85,
    maxLat: 46.86,
    minLon: -121.76,
    maxLon: -121.75,
    centerLat: 46.855,
    centerLon: -121.755,
    minEle: 1500,
    maxEle: 2500,
    widthMeters: 4000,
    depthMeters: 4000,
    elevationSpan: 1000,
  };

  function createMockGrid(): ElevationGrid {
    const width = 512;
    const height = 512;
    const data = new Float32Array(width * height).fill(2000);
    return {
      zoom: 13,
      tileXMin: 1322,
      tileXMax: 1323,
      tileYMin: 2883,
      tileYMax: 2884,
      numTilesX: 2,
      numTilesY: 2,
      width,
      height,
      data,
      tileValidity: new Uint8Array(4).fill(1),
      minElevation: 1500,
      maxElevation: 2500,
      isRealDEM: true,
    };
  }

  function createMockTrack(): TrackStats {
    const points: GPXPoint[] = [
      {
        lat: 46.851,
        lon: -121.758,
        ele: 1600,
        time: new Date('2026-09-25T08:00:00Z'),
        distanceFromStart: 0,
        elapsedSeconds: 0,
        playbackSeconds: 0,
        grade: 5,
        speed: 1.2,
        index: 0,
      },
      {
        lat: 46.855,
        lon: -121.755,
        ele: 1800,
        time: new Date('2026-09-25T08:30:00Z'),
        distanceFromStart: 1000,
        elapsedSeconds: 1800,
        playbackSeconds: 1800,
        grade: 5,
        speed: 1.2,
        index: 1,
      },
      {
        lat: 46.859,
        lon: -121.752,
        ele: 2100,
        time: new Date('2026-09-25T09:00:00Z'),
        distanceFromStart: 2000,
        elapsedSeconds: 3600,
        playbackSeconds: 3600,
        grade: 5,
        speed: 1.2,
        index: 2,
      },
    ];

    const waypoints: GPXWaypoint[] = [
      {
        lat: 46.851,
        lon: -121.758,
        ele: 1600,
        name: 'Trailhead',
      },
      {
        lat: 46.859,
        lon: -121.752,
        ele: 2100,
        name: 'Camp Muir',
      },
    ];

    return {
      name: 'Test Trail',
      bounds: testBounds,
      points,
      segments: [
        {
          points,
          distance: 2000,
          elevationGain: 500,
          elevationLoss: 0,
          startIndex: 0,
          endIndex: 2,
        },
      ],
      waypoints,
      landmarks: [],
      warnings: [],
      totalDistance: 2000,
      elevationGain: 500,
      elevationLoss: 0,
      minElevation: 1600,
      maxElevation: 2100,
      movingTime: 3600,
      avgSpeed: 2.0,
      maxSpeed: 3.0,
      totalPlaybackSeconds: 3600,
    };
  }

  function createMockLocalChunk(radius: number = 300): LocalTerrainChunk {
    return new LocalTerrainChunk({
      localGrid: createMockGrid(),
      centerLat: testBounds.centerLat,
      centerLon: testBounds.centerLon,
      referenceCenterLat: testBounds.centerLat,
      referenceCenterLon: testBounds.centerLon,
      terrainBaseElevation: testBounds.minEle,
      radiusMeters: radius,
      segments: 4,
      initialExaggeration: 1.0,
      baseElevationSampler: () => 2000,
    });
  }

  async function createTestTerrain(): Promise<TerrainResult> {
    const track = createMockTrack();
    const demGrid = createMockGrid();
    return await TerrainGenerator.generate(track, () => 2000, undefined, 1.0, false, {
      demGrid,
      terrainGeoBounds: testBounds,
      elevationSamplerForGeo: () => 2000,
    });
  }

  it('1. TerrainGenerator increments surfaceRevision and fires onSurfaceChange with bounds on chunk attach/detach and exaggeration', async () => {
    const terrain = await createTestTerrain();

    expect(terrain.surfaceRevision).toBe(1);

    const changes: TerrainSurfaceChange[] = [];
    terrain.onSurfaceChange = (change: TerrainSurfaceChange) => {
      changes.push(change);
    };

    // Attach visible chunk
    const chunk = createMockLocalChunk(200);
    chunk.mesh.visible = true;
    terrain.attachLocalChunk?.(chunk);

    expect(terrain.surfaceRevision).toBe(2);
    expect(changes.length).toBe(1);
    expect(changes[0].revision).toBe(2);
    expect(changes[0].bounds).toEqual(chunk.getSurfaceBounds());

    // Detach visible chunk
    terrain.detachLocalChunk?.(chunk);
    expect(terrain.surfaceRevision).toBe(3);
    expect(changes.length).toBe(2);
    expect(changes[1].revision).toBe(3);

    // Set vertical exaggeration -> triggers surface change
    terrain.setVerticalExaggeration(1.5);
    expect(terrain.surfaceRevision).toBe(4);
    expect(changes.length).toBe(3);
    expect(terrain.getVerticalExaggeration?.()).toBe(1.5);

    terrain.dispose();
  });

  it('2. TrailMesh reprojectToSurface updates ribbon vertices in affected bounds without modifying analytical route geometry', () => {
    const track = createMockTrack();
    const baseSampler = (x: number, z: number) => 100;
    const trail = TrailMesh.create(track, baseSampler, track.bounds.minEle, 1.0);

    const dioramaGeo = trail.trailMesh.geometry;
    const posAttr = dioramaGeo.attributes.position;
    const initialY0 = posAttr.getY(0);
    expect(initialY0).toBeGreaterThan(100); // 100 + dioramaElevationOffset

    // Reproject with a higher elevation surface (+150m) in a region covering the start of the trail
    const highSampler = (x: number, z: number) => 250;
    const startX = posAttr.getX(0);
    const startZ = posAttr.getZ(0);

    const affectedBounds: TerrainSurfaceBounds = {
      minX: startX - 50,
      maxX: startX + 50,
      minZ: startZ - 50,
      maxZ: startZ + 50,
    };

    trail.reprojectToSurface?.(highSampler, affectedBounds);

    // Vertex 0 (inside bounds) should have updated Y
    const newY0 = posAttr.getY(0);
    expect(newY0).toBeGreaterThan(250);
    expect(newY0).not.toBe(initialY0);

    // Last vertex (outside bounds) should remain at original baseSampler elevation
    const lastIdx = posAttr.count - 1;
    const lastX = posAttr.getX(lastIdx);
    const lastZ = posAttr.getZ(lastIdx);
    // Verify last vertex is outside affected bounds
    expect(
      lastX < affectedBounds.minX ||
      lastX > affectedBounds.maxX ||
      lastZ < affectedBounds.minZ ||
      lastZ > affectedBounds.maxZ
    ).toBe(true);

    const lastY = posAttr.getY(lastIdx);
    expect(lastY).toBeCloseTo(initialY0, 0.1);

    // Analytical route geometry is untouched
    expect(trail.routeGeometry.totalDistance).toBe(2000);

    trail.dispose();
  });

  it('3. DioramaBase reprojectWaypoints updates pin baseY and position.y for waypoints within bounds', () => {
    const track = createMockTrack();
    const baseSampler = (x: number, z: number) => 100;
    const dioramaBase = DioramaBase.create(track.bounds, -80, track.waypoints, track.bounds.minEle, baseSampler, 1.0);

    const wpGroup = dioramaBase.getObjectByName('Waypoints') as THREE.Group;
    expect(wpGroup).toBeDefined();
    expect(wpGroup.children.length).toBe(2);

    const pin0 = wpGroup.children[0];
    const initialBaseY0 = pin0.userData.baseY;
    const initialPosY0 = pin0.position.y;
    expect(initialPosY0).toBe(initialBaseY0 + 8.0);

    // Reproject only the area around pin0
    const newSampler = (x: number, z: number) => 300;
    const bounds: TerrainSurfaceBounds = {
      minX: pin0.position.x - 10,
      maxX: pin0.position.x + 10,
      minZ: pin0.position.z - 10,
      maxZ: pin0.position.z + 10,
    };

    DioramaBase.reprojectWaypoints(dioramaBase, newSampler, 1.5, bounds);

    expect(pin0.userData.baseY).toBe(300);
    expect(pin0.position.y).toBe(300 * 1.5 + 8.0);

    // Pin 1 (outside bounds) should not have been updated
    const pin1 = wpGroup.children[1];
    expect(pin1.userData.baseY).toBe(initialBaseY0);
  });

  it('4. Hiker marker updates dynamically when surface changes and on progress updates', () => {
    const track = createMockTrack();
    let surfaceElevation = 150;
    const dynamicSampler = (x: number, z: number) => surfaceElevation;

    const trail = TrailMesh.create(track, dynamicSampler, track.bounds.minEle, 1.0);
    const initialHikerY = trail.hikerMarker.position.y;
    expect(initialHikerY).toBeGreaterThan(150);

    // Surface elevation changes (e.g. high-res DEM loaded)
    surfaceElevation = 275;
    trail.reprojectToSurface?.(dynamicSampler);

    // Hiker marker position should reflect new surface elevation
    expect(trail.hikerMarker.position.y).toBeGreaterThan(275);
    expect(trail.hikerMarker.position.y).not.toBe(initialHikerY);

    // Progress update also samples from the updated sampler
    const updateResult = trail.updateHikerPosition(0.5);
    expect(updateResult.position.y).toBeGreaterThan(275);

    trail.dispose();
  });

  it('5. FlyoverController uses dynamic elevationSampler for first-person camera and world position', () => {
    const track = createMockTrack();
    const trail = TrailMesh.create(track, undefined, track.bounds.minEle, 1.0);
    let currentSurfaceY = 500;
    const elevationSampler = (x: number, z: number) => currentSurfaceY;

    const flyover = new FlyoverController(trail, track, elevationSampler);
    flyover.setViewMode('first-person');

    // Desktop fallback camera
    const camera = new THREE.PerspectiveCamera();
    flyover.update(0.016, camera);

    // Camera height should be groundY + 2.0m eye level
    expect(camera.position.y).toBeCloseTo(500 + 2.0, 0.01);

    // World position reflects current surface Y
    const worldPos = flyover.getCurrentWorldPosition();
    expect(worldPos.y).toBe(500);

    // Surface height changes dynamically
    currentSurfaceY = 650;
    flyover.update(0.016, camera);
    expect(camera.position.y).toBeCloseTo(650 + 2.0, 0.01);
    expect(flyover.getCurrentWorldPosition().y).toBe(650);

    // WebXR presentation offset test
    const dioramaRoot = new THREE.Group();
    flyover.update(0.016, undefined, dioramaRoot, true);
    // Root position should place trail at user floor level (offset.y = -groundY = -650)
    expect(dioramaRoot.position.y).toBeCloseTo(-650, 0.01);

    trail.dispose();
  });

  it('6. ImageryLODManager reprojectPatches updates active patch heights in affected bounds', () => {
    const track = createMockTrack();
    let currentGroundY = 120;
    const elevationSampler = (x: number, z: number) => currentGroundY;

    const lodManager = new ImageryLODManager({
      terrainGeoBounds: track.bounds,
      terrainBaseElevation: track.bounds.minEle,
      elevationSampler,
      verticalExaggeration: 1.0,
      qualityProfile: QualityProfileManager.getActiveProfile(),
    });

    // Create a mock patch
    const patchGeo = new THREE.PlaneGeometry(100, 100, 2, 2);
    patchGeo.rotateX(-Math.PI / 2);
    const patchMesh = new THREE.Mesh(patchGeo, new THREE.MeshBasicMaterial());
    const mockPatch = {
      key: 'sat_16_100_100',
      zoom: 16,
      x: 100,
      y: 100,
      mesh: patchMesh,
      texture: new THREE.Texture(),
      lastUsed: Date.now(),
      centerDist: 50,
      creationTime: Date.now(),
      isFading: false,
      fadeDurationMs: 0,
      dispose: vi.fn(),
    };

    (lodManager as any).patches.set(mockPatch.key, mockPatch);

    // Verify initial patch heights
    const pos = patchGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, currentGroundY + 0.04);
    }

    expect(pos.getY(0)).toBeCloseTo(120.04, 0.01);

    // Reproject with new surface sampler (+80m)
    currentGroundY = 200;
    const bounds: TerrainSurfaceBounds = {
      minX: -100,
      maxX: 100,
      minZ: -100,
      maxZ: 100,
    };

    lodManager.reprojectPatches((x, z) => currentGroundY, bounds);

    expect(pos.getY(0)).toBeCloseTo(200.04, 0.01);

    lodManager.dispose();
  });

  it('7. LoadedTrek coordinates surface change events to trail, waypoints, imagery LOD, and flyover controller', async () => {
    const track = createMockTrack();
    const terrain = await createTestTerrain();
    const trail = TrailMesh.create(track, terrain.sampleRenderedSurfaceY, testBounds.minEle, 1.0);
    const dioramaBase = DioramaBase.create(testBounds, -80, track.waypoints, testBounds.minEle, terrain.sampleRenderedSurfaceY, 1.0);
    const flyover = new FlyoverController(trail, track, terrain.sampleRenderedSurfaceY);

    const reprojectTrailSpy = vi.spyOn(trail, 'reprojectToSurface');
    const reprojectWaypointsSpy = vi.spyOn(DioramaBase, 'reprojectWaypoints');
    const setElevationSamplerSpy = vi.spyOn(flyover, 'setElevationSampler');

    const loadedTrek = new LoadedTrek({
      track,
      terrainResult: terrain,
      trailResult: trail,
      dioramaBase,
      flyoverController: flyover,
    });

    const reprojectPatchesSpy = vi.spyOn(loadedTrek.imageryLOD, 'reprojectPatches');

    // Reset spy call history from initial trek construction
    reprojectTrailSpy.mockClear();
    reprojectWaypointsSpy.mockClear();
    setElevationSamplerSpy.mockClear();
    reprojectPatchesSpy.mockClear();

    // Trigger surface change notification
    const testBoundsChange: TerrainSurfaceBounds = {
      minX: -200,
      maxX: 200,
      minZ: -200,
      maxZ: 200,
    };
    terrain.notifySurfaceChange?.(testBoundsChange);

    expect(reprojectTrailSpy).toHaveBeenCalledTimes(1);
    expect(reprojectTrailSpy).toHaveBeenCalledWith(expect.any(Function), testBoundsChange);

    expect(reprojectWaypointsSpy).toHaveBeenCalledTimes(1);
    expect(reprojectWaypointsSpy).toHaveBeenCalledWith(
      dioramaBase,
      expect.any(Function),
      1.0,
      testBoundsChange
    );

    expect(reprojectPatchesSpy).toHaveBeenCalledTimes(1);
    expect(reprojectPatchesSpy).toHaveBeenCalledWith(expect.any(Function), testBoundsChange);

    expect(setElevationSamplerSpy).toHaveBeenCalledWith(expect.any(Function));

    loadedTrek.dispose();
  });
});
