import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  QualityProfileManager,
  QUALITY_PROFILES,
  type QualityProfile,
} from '../src/terrain/QualityProfile.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import type { TrackStats, GeoBounds } from '../src/gpx/TrackTypes.ts';
import type { TerrainResult } from '../src/terrain/TerrainGenerator.ts';
import type { TrailResult } from '../src/visualization/TrailMesh.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';

describe('Stage X1: Single-Source Quality Profile Architecture', () => {
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

  const dummyPoints = [
    { lat: 46.85, lon: -121.76, ele: 1500, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
    { lat: 46.86, lon: -121.75, ele: 2500, distanceFromStart: 2000, elapsedSeconds: 3600, playbackSeconds: 3600, index: 1 },
  ];

  const dummyTrack = {
    name: 'Test Trail',
    points: dummyPoints,
    segments: [
      { points: dummyPoints, distance: 2000, elevationGain: 1000, elevationLoss: 0 },
    ],
    totalDistance: 2000,
    elevationGain: 1000,
    elevationLoss: 0,
    minElevation: 1500,
    maxElevation: 2500,
    bounds: testBounds,
    estimatedDuration: 3600,
  } as any as TrackStats;

  const dummyRouteGeometry = new RouteGeometry(dummyTrack, 1500, () => 1800);

  const createDummyTerrainResult = (): TerrainResult => ({
    group: new THREE.Group(),
    terrainMesh: new THREE.Mesh(),
    skirtMesh: new THREE.Mesh(),
    demGrid: {
      width: 10,
      height: 10,
      zoom: 15,
      tileXMin: 1000,
      tileXMax: 1000,
      tileYMin: 2000,
      tileYMax: 2000,
      numTilesX: 1,
      numTilesY: 1,
      data: new Float32Array(100),
      tileValidity: new Uint8Array([1]),
      minElevation: 1500,
      maxElevation: 2500,
      isRealDEM: true,
    },
    terrainGeoBounds: testBounds,
    terrainBaseElevation: 1500,
    terrainQuality: 'dem',
    elevationSampler: () => 1800,
    sampleRenderedSurfaceY: () => 1800,
    setVerticalExaggeration: () => {},
    dispose: () => {},
  } as any as TerrainResult);

  const createDummyTrailResult = (): TrailResult => ({
    group: new THREE.Group(),
    routeGeometry: dummyRouteGeometry,
    updateHikerPosition: () => ({ currentPoint: dummyTrack.points[0], position: new THREE.Vector3() }),
    setColorMode: () => {},
    setViewMode: () => {},
    setVerticalExaggeration: () => {},
    dispose: () => {},
  } as any as TrailResult);

  beforeEach(() => {
    QualityProfileManager.setActiveProfile('desktop-high');
  });

  describe('QualityProfileManager & Mode Resolution', () => {
    it('provides local DEM parameters in quality profiles for Stage X', () => {
      const qHigh = QUALITY_PROFILES['quest-high'];
      expect(qHigh.localDemZoom).toBe(15);
      expect(qHigh.localDemMaxTiles).toBe(16);
      expect(qHigh.localDemSegments).toBe(128);

      const qBalanced = QUALITY_PROFILES['quest-balanced'];
      expect(qBalanced.localDemZoom).toBe(15);
      expect(qBalanced.localDemMaxTiles).toBe(8);
      expect(qBalanced.localDemSegments).toBe(96);

      const dHigh = QUALITY_PROFILES['desktop-high'];
      expect(dHigh.localDemZoom).toBe(15);
      expect(dHigh.localDemMaxTiles).toBe(25);
      expect(dHigh.localDemSegments).toBe(160);
    });

    it('resolves mode to appropriate profile name based on device target', () => {
      expect(QualityProfileManager.resolveProfileName('high', true)).toBe('quest-high');
      expect(QualityProfileManager.resolveProfileName('balanced', true)).toBe('quest-balanced');
      expect(QualityProfileManager.resolveProfileName('high', false)).toBe('desktop-high');
      expect(QualityProfileManager.resolveProfileName('balanced', false)).toBe('quest-balanced');
    });

    it('maps profile names back to high vs balanced mode for UI', () => {
      expect(QualityProfileManager.getQualityMode('quest-high')).toBe('high');
      expect(QualityProfileManager.getQualityMode('desktop-high')).toBe('high');
      expect(QualityProfileManager.getQualityMode('quest-balanced')).toBe('balanced');
    });
  });

  describe('TrekSession Quality Profile State & Reactivity', () => {
    it('manages qualityProfile reactive state and notifies subscribers', () => {
      const session = new TrekSession({ qualityProfile: 'quest-high' });
      expect(session.getState().qualityProfile).toBe('quest-high');

      let notifiedState: string | null = null;
      session.subscribe((state, prev) => {
        if (state.qualityProfile !== prev.qualityProfile) {
          notifiedState = state.qualityProfile;
        }
      });

      session.setQualityProfile('quest-balanced');
      expect(notifiedState).toBe('quest-balanced');
      expect(session.getState().qualityProfile).toBe('quest-balanced');
    });
  });

  describe('LoadedTrek Single-Source Quality Profile Ownership', () => {
    it('initializes ImageryLODManager using active profile without hardcoding maxPatches', () => {
      QualityProfileManager.setActiveProfile('quest-high');

      const terrain = createDummyTerrainResult();
      const trail = createDummyTrailResult();
      const flyover = new FlyoverController(trail, dummyTrack);

      const trek = new LoadedTrek({
        track: dummyTrack,
        terrainResult: terrain,
        trailResult: trail,
        dioramaBase: new THREE.Group(),
        flyoverController: flyover,
      });

      // Under quest-high tabletop mode, maxPatches must be 48 (not 36!)
      expect((trek.imageryLOD as any).maxPatches).toBe(48);
      expect(trek.imageryLOD.getQualityProfile().name).toBe('quest-high');

      // LocalTerrainStreamer receives the active profile radius
      expect(trek.localTerrainStreamer?.chunkRadiusM).toBe(1250);

      trek.dispose();
    });

    it('propagates setQualityProfile to both imageryLOD and localTerrainStreamer', () => {
      QualityProfileManager.setActiveProfile('quest-high');

      const terrain = createDummyTerrainResult();
      const trail = createDummyTrailResult();
      const flyover = new FlyoverController(trail, dummyTrack);

      const trek = new LoadedTrek({
        track: dummyTrack,
        terrainResult: terrain,
        trailResult: trail,
        dioramaBase: new THREE.Group(),
        flyoverController: flyover,
      });

      expect((trek.imageryLOD as any).maxPatches).toBe(48);
      expect(trek.localTerrainStreamer?.chunkRadiusM).toBe(1250);

      // Change profile to quest-balanced
      trek.setQualityProfile(QUALITY_PROFILES['quest-balanced']);

      expect((trek.imageryLOD as any).maxPatches).toBe(28);
      expect(trek.imageryLOD.getQualityProfile().name).toBe('quest-balanced');
      expect(trek.localTerrainStreamer?.chunkRadiusM).toBe(750);
      expect(trek.localTerrainStreamer?.getQualityProfile().name).toBe('quest-balanced');

      trek.dispose();
    });
  });

  describe('LocalTerrainStreamer setQualityProfile', () => {
    it('updates qualityProfile and chunkRadiusM cleanly', () => {
      const terrain = createDummyTerrainResult();
      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: dummyRouteGeometry,
        demGrid: terrain.demGrid!,
        qualityProfile: QUALITY_PROFILES['desktop-high'],
      });

      expect(streamer.qualityProfile.name).toBe('desktop-high');
      expect(streamer.chunkRadiusM).toBe(1500);

      streamer.setQualityProfile(QUALITY_PROFILES['quest-balanced']);
      expect(streamer.qualityProfile.name).toBe('quest-balanced');
      expect(streamer.chunkRadiusM).toBe(750);
    });
  });

  describe('ImageryLODManager XR Update Loop Profile Stability', () => {
    it('does not overwrite configured quality profile during XR frame updates', () => {
      QualityProfileManager.setActiveProfile('quest-balanced');

      const lod = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1500,
        elevationSampler: () => 1800,
        viewMode: 'diorama',
        qualityProfile: QUALITY_PROFILES['quest-balanced'],
      });

      expect(lod.getQualityProfile().name).toBe('quest-balanced');
      expect((lod as any).maxPatches).toBe(28);

      // Simulate XR render frame update
      const cam = new THREE.PerspectiveCamera();
      const diorama = new THREE.Group();
      lod.update(cam, diorama, true, 0.5);

      // Must remain quest-balanced and NOT be forced to quest-high every frame
      expect(lod.getQualityProfile().name).toBe('quest-balanced');
      expect((lod as any).maxPatches).toBe(28);

      lod.dispose();
    });
  });
});
