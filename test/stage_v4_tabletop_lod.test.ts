import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  computeCoherentLODTiles,
  getTileKey,
  getChildTileKeys,
  parseTileKey,
} from '../src/terrain/ImageryLODManager.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage V4 & V5: Tabletop Imagery LOD Coherence & Terrain Surface Focus', () => {
  const testBounds: GeoBounds = {
    minLat: 46.0,
    maxLat: 46.1,
    minLon: 7.7,
    maxLon: 7.8,
    centerLat: 46.05,
    centerLon: 7.75,
    minEle: 1000,
    maxEle: 3000,
    widthMeters: 8000,
    depthMeters: 11000,
    elevationSpan: 2000,
  };

  describe('Quadtree Candidate Atomicity (Stage V4.1)', () => {
    it('promotes high-res tiles in atomic 2x2 parent quadtree blocks with no partial parents', () => {
      const targetLat = 46.05;
      const targetLon = 7.75;
      const zHigh = 16;
      const maxPatches = 36;
      const style = 'satellite';

      const tiles = computeCoherentLODTiles(
        targetLat,
        targetLon,
        zHigh,
        maxPatches,
        testBounds
      );

      // Verify all zHigh tiles belong to complete 4-child quadtrees
      const zHighTiles = tiles.filter((t) => t.zoom === zHigh);
      const parentGroups = new Map<string, typeof zHighTiles>();

      for (const t of zHighTiles) {
        const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
        let group = parentGroups.get(parentKey);
        if (!group) {
          group = [];
          parentGroups.set(parentKey, group);
        }
        group.push(t);
      }

      // Every parent group promoted to zHigh must have exactly 4 children
      expect(parentGroups.size).toBeGreaterThan(0);
      for (const [parentKey, children] of parentGroups.entries()) {
        expect(
          children.length,
          `Parent ${parentKey} must have all 4 children promoted, but had ${children.length}`
        ).toBe(4);
      }
    });
  });

  describe('Parent/Child Visibility Matrix (Stage V4.2, V4.3)', () => {
    let manager: ImageryLODManager;

    beforeEach(() => {
      manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 1500,
        enableInXR: true,
        enableFadeIn: false,
      });
    });

    afterEach(() => {
      manager.dispose();
    });

    it('enforces parent visibility and hides children for 0/4, 1/4, 2/4, 3/4 ready states, replacing parent only at 4/4', () => {
      const parentZ = 15;
      const parentX = 17000;
      const parentY = 23000;
      const style = 'satellite';
      const parentKey = getTileKey(style, parentZ, parentX, parentY);
      const childKeys = getChildTileKeys(style, parentZ, parentX, parentY);

      const dummyGeo = new THREE.BufferGeometry();
      const dummyMat = new THREE.MeshStandardMaterial();
      const dummyTex = new THREE.Texture();

      const createPatch = (key: string, zoom: number, x: number, y: number) => ({
        key,
        zoom,
        x,
        y,
        mesh: new THREE.Mesh(dummyGeo, dummyMat.clone()),
        texture: dummyTex,
        lastUsed: Date.now(),
        centerDist: 0,
        creationTime: Date.now(),
        isFading: false,
        fadeDurationMs: 0,
        dispose: () => {},
      });

      const parentPatch = createPatch(parentKey, parentZ, parentX, parentY);
      (manager as any).patches.set(parentKey, parentPatch);

      // Desiring children at zoom Z+1
      (manager as any).desiredTileKeys = new Set(childKeys);

      // Case 0/4: No children ready
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);

      // Case 1/4: One child ready -> parent stays visible, child hidden
      const c0Parsed = parseTileKey(childKeys[0]);
      const c0 = createPatch(childKeys[0], c0Parsed.zoom, c0Parsed.x, c0Parsed.y);
      (manager as any).patches.set(childKeys[0], c0);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(false);

      // Case 2/4: Two children ready -> parent stays visible, both children hidden
      const c1Parsed = parseTileKey(childKeys[1]);
      const c1 = createPatch(childKeys[1], c1Parsed.zoom, c1Parsed.x, c1Parsed.y);
      (manager as any).patches.set(childKeys[1], c1);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);

      // Case 3/4: Three children ready -> parent stays visible, all 3 children hidden
      const c2Parsed = parseTileKey(childKeys[2]);
      const c2 = createPatch(childKeys[2], c2Parsed.zoom, c2Parsed.x, c2Parsed.y);
      (manager as any).patches.set(childKeys[2], c2);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);
      expect(c2.mesh.visible).toBe(false);

      // Case 4/4: All four children ready -> all 4 become visible, parent is replaced (hidden)
      const c3Parsed = parseTileKey(childKeys[3]);
      const c3 = createPatch(childKeys[3], c3Parsed.zoom, c3Parsed.x, c3Parsed.y);
      (manager as any).patches.set(childKeys[3], c3);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(false);
      expect(c0.mesh.visible).toBe(true);
      expect(c1.mesh.visible).toBe(true);
      expect(c2.mesh.visible).toBe(true);
      expect(c3.mesh.visible).toBe(true);
    });
  });

  describe('Diorama Raycast & Surface Focus (Stage V5.1, V5.2)', () => {
    it('focuses LOD on actual terrain mesh hit and adapts camDist to the surface hit', () => {
      // Build a test terrain mesh matching testBounds (8000m x 11000m)
      const planeGeo = new THREE.PlaneGeometry(8000, 11000, 10, 10);
      planeGeo.rotateX(-Math.PI / 2);
      const terrainMesh = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial());
      terrainMesh.name = 'BaseTerrainMesh';

      const dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0, 0.82, -0.8);
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);
      dioramaRoot.add(terrainMesh);
      dioramaRoot.updateMatrixWorld(true);

      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 1500,
        enableInXR: true,
        enableFadeIn: false,
        terrainMesh: terrainMesh,
      });

      // Camera looking straight down at the diorama
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 1.5, -0.8); // 0.68m directly above diorama
      camera.lookAt(0, 0.82, -0.8);
      camera.updateMatrixWorld(true);

      // Spy on calculateTargetZoom to verify the camDist passed to it
      const spyZoom = vi.spyOn(ImageryLODManager, 'calculateTargetZoom');

      manager.update(camera, dioramaRoot, false);

      expect(spyZoom).toHaveBeenCalled();
      const lastCall = spyZoom.mock.calls[spyZoom.mock.calls.length - 1];
      const camDistArg = lastCall[0];

      // Distance should be ~0.68m (camera y=1.5 to terrain hit y=0.82)
      expect(camDistArg).toBeCloseTo(0.68, 1);

      spyZoom.mockRestore();
      manager.dispose();
    });

    it('falls back to diorama plane transformed by actual 3D orientation when tilted', () => {
      const dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0, 0.82, -0.8);
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);
      // Tilt diorama 45 degrees around X
      dioramaRoot.rotation.x = Math.PI / 4;
      dioramaRoot.updateMatrixWorld(true);

      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 1500,
        enableInXR: true,
        enableFadeIn: false,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 1.5, -0.8);
      camera.lookAt(0, 0.82, -0.8);
      camera.updateMatrixWorld(true);
      camera.position.set(0, 1.5, -0.8);
      camera.lookAt(0, 0.82, -0.8);

      const spyZoom = vi.spyOn(ImageryLODManager, 'calculateTargetZoom');

      manager.update(camera, dioramaRoot, false);

      expect(spyZoom).toHaveBeenCalled();
      const lastCall = spyZoom.mock.calls[spyZoom.mock.calls.length - 1];
      const camDistArg = lastCall[0];

      // Distance should be measured to the tilted plane hit, which is well-defined and positive
      expect(camDistArg).toBeGreaterThan(0.2);

      spyZoom.mockRestore();
      manager.dispose();
    });
  });
});
