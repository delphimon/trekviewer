import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  computeCoherentLODTiles,
  computeFirstPersonCoherentLODTiles,
  getTileKey,
  getChildTileKeys,
  getParentTileKey,
  parseTileKey,
  type ImageryPatch,
} from '../src/terrain/ImageryLODManager.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

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
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillText: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      clearRect: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
    };
  }
}

describe('Stage X5: True 4/4 Imagery Quadtree Refinement Groups', () => {
  const testBounds: GeoBounds = {
    minLat: 46.80,
    maxLat: 46.90,
    minLon: -121.80,
    maxLon: -121.70,
    centerLat: 46.85,
    centerLon: -121.75,
    minEle: 1000,
    maxEle: 4000,
    widthMeters: 8000,
    depthMeters: 11000,
    elevationSpan: 3000,
  };

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

  const createMockPatch = (
    key: string,
    zoom: number,
    x: number,
    y: number,
    isFading = false
  ): ImageryPatch => {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    return {
      key,
      zoom,
      x,
      y,
      mesh,
      texture: new THREE.Texture(),
      lastUsed: Date.now(),
      centerDist: 0,
      creationTime: Date.now(),
      isFading,
      fadeDurationMs: isFading ? 250 : 0,
      dispose: () => {
        geo.dispose();
        mat.dispose();
      },
    };
  };

  describe('RefinementGroup State Lifecycle & Atomic Visibility', () => {
    it('creates RefinementGroup with accurate quadtree child keys and tracks state transitions', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      const parentKey = getTileKey('satellite', 18, 50, 100);
      const group = manager.getOrCreateRefinementGroup(parentKey);

      expect(group.parentKey).toBe(parentKey);
      expect(group.parentZoom).toBe(18);
      expect(group.parentX).toBe(50);
      expect(group.parentY).toBe(100);
      expect(group.childZoom).toBe(19);
      expect(group.fourChildKeys).toEqual([
        getTileKey('satellite', 19, 100, 200),
        getTileKey('satellite', 19, 101, 200),
        getTileKey('satellite', 19, 100, 201),
        getTileKey('satellite', 19, 101, 201),
      ]);
      expect(group.state).toBe('parent');
      expect(group.readyChildren.size).toBe(0);

      // Mount 1 child: transitions to 'loading'
      const c0 = createMockPatch(group.fourChildKeys[0], 19, 100, 200);
      (manager as any).patches.set(group.fourChildKeys[0], c0);
      const groupAfter1 = manager.getOrCreateRefinementGroup(parentKey);
      expect(groupAfter1.state).toBe('loading');
      expect(groupAfter1.readyChildren.size).toBe(1);

      // Mount 2nd & 3rd children: remains 'loading'
      const c1 = createMockPatch(group.fourChildKeys[1], 19, 101, 200);
      const c2 = createMockPatch(group.fourChildKeys[2], 19, 100, 201);
      (manager as any).patches.set(group.fourChildKeys[1], c1);
      (manager as any).patches.set(group.fourChildKeys[2], c2);
      const groupAfter3 = manager.getOrCreateRefinementGroup(parentKey);
      expect(groupAfter3.state).toBe('loading');
      expect(groupAfter3.readyChildren.size).toBe(3);

      // Mount 4th child (non-fading): transitions to 'children'
      const c3 = createMockPatch(group.fourChildKeys[3], 19, 101, 201, false);
      (manager as any).patches.set(group.fourChildKeys[3], c3);
      const groupAfter4 = manager.getOrCreateRefinementGroup(parentKey);
      expect(groupAfter4.state).toBe('children');
      expect(groupAfter4.readyChildren.size).toBe(4);

      manager.dispose();
    });

    it('enforces 0/4, 1/4, 2/4, 3/4 hidden invariant when refining directly over base terrain (no parent patch)', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableFadeIn: false,
      });

      const parentKey = getTileKey('satellite', 18, 200, 400);
      const childKeys = getChildTileKeys('satellite', 18, 200, 400);
      (manager as any).desiredTileKeys = new Set(childKeys);

      // Notice: parent patch is NOT loaded in manager.patches.
      // Case 0/4: No children loaded
      manager.updatePatchVisibility();
      expect(manager.getDiagnostics().visibleCount).toBe(0);

      // Case 1/4: 1 child loaded -> MUST BE INVISIBLE
      const c0 = createMockPatch(childKeys[0], 19, 400, 800);
      (manager as any).patches.set(childKeys[0], c0);
      manager.updatePatchVisibility();
      expect(c0.mesh.visible).toBe(false);
      expect(manager.getDiagnostics().visibleCount).toBe(0);

      // Case 2/4: 2 children loaded -> BOTH MUST BE INVISIBLE
      const c1 = createMockPatch(childKeys[1], 19, 401, 800);
      (manager as any).patches.set(childKeys[1], c1);
      manager.updatePatchVisibility();
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);
      expect(manager.getDiagnostics().visibleCount).toBe(0);

      // Case 3/4: 3 children loaded -> ALL 3 MUST BE INVISIBLE
      const c2 = createMockPatch(childKeys[2], 19, 400, 801);
      (manager as any).patches.set(childKeys[2], c2);
      manager.updatePatchVisibility();
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);
      expect(c2.mesh.visible).toBe(false);
      expect(manager.getDiagnostics().visibleCount).toBe(0);

      // Case 4/4: 4th child loaded -> ALL 4 ATOMICALLY BECOME VISIBLE TOGETHER
      const c3 = createMockPatch(childKeys[3], 19, 401, 801);
      (manager as any).patches.set(childKeys[3], c3);
      manager.updatePatchVisibility();
      expect(c0.mesh.visible).toBe(true);
      expect(c1.mesh.visible).toBe(true);
      expect(c2.mesh.visible).toBe(true);
      expect(c3.mesh.visible).toBe(true);
      expect(manager.getDiagnostics().visibleCount).toBe(4);

      manager.dispose();
    });

    it('enforces parent patch visibility and atomic replacement when an adaptive parent is resident', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableFadeIn: false,
      });

      const parentKey = getTileKey('satellite', 18, 300, 600);
      const childKeys = getChildTileKeys('satellite', 18, 300, 600);

      // Mount resident parent patch
      const parentPatch = createMockPatch(parentKey, 18, 300, 600);
      (manager as any).patches.set(parentKey, parentPatch);
      (manager as any).desiredTileKeys = new Set(childKeys);

      // Case 0/4: Parent visible, children 0
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(manager.getDiagnostics().visibleCount).toBe(1);

      // Case 1/4: Parent remains visible, 1st child hidden
      const c0 = createMockPatch(childKeys[0], 19, 600, 1200);
      (manager as any).patches.set(childKeys[0], c0);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(false);
      expect(manager.getDiagnostics().visibleCount).toBe(1);

      // Case 2/4: Parent remains visible, 2 children hidden
      const c1 = createMockPatch(childKeys[1], 19, 601, 1200);
      (manager as any).patches.set(childKeys[1], c1);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);
      expect(manager.getDiagnostics().visibleCount).toBe(1);

      // Case 3/4: Parent remains visible, 3 children hidden
      const c2 = createMockPatch(childKeys[2], 19, 600, 1201);
      (manager as any).patches.set(childKeys[2], c2);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);
      expect(c2.mesh.visible).toBe(false);
      expect(manager.getDiagnostics().visibleCount).toBe(1);

      // Case 4/4: Parent replaced (hidden), all 4 children visible simultaneously
      const c3 = createMockPatch(childKeys[3], 19, 601, 1201);
      (manager as any).patches.set(childKeys[3], c3);
      manager.updatePatchVisibility();
      expect(parentPatch.mesh.visible).toBe(false);
      expect(c0.mesh.visible).toBe(true);
      expect(c1.mesh.visible).toBe(true);
      expect(c2.mesh.visible).toBe(true);
      expect(c3.mesh.visible).toBe(true);
      expect(manager.getDiagnostics().visibleCount).toBe(4);

      manager.dispose();
    });

    it('keeps parent patch visible during crossfade when enableFadeIn is active (state = promoting)', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableFadeIn: true,
      });

      const parentKey = getTileKey('satellite', 18, 120, 240);
      const childKeys = getChildTileKeys('satellite', 18, 120, 240);

      const parentPatch = createMockPatch(parentKey, 18, 120, 240);
      (manager as any).patches.set(parentKey, parentPatch);
      (manager as any).desiredTileKeys = new Set(childKeys);

      // Mount all 4 children with isFading = true
      const c0 = createMockPatch(childKeys[0], 19, 240, 480, true);
      const c1 = createMockPatch(childKeys[1], 19, 241, 480, true);
      const c2 = createMockPatch(childKeys[2], 19, 240, 481, true);
      const c3 = createMockPatch(childKeys[3], 19, 241, 481, true);
      (manager as any).patches.set(childKeys[0], c0);
      (manager as any).patches.set(childKeys[1], c1);
      (manager as any).patches.set(childKeys[2], c2);
      (manager as any).patches.set(childKeys[3], c3);

      manager.updatePatchVisibility();

      const group = (manager as any).refinementGroups.get(parentKey);
      expect(group.state).toBe('promoting');
      // Under promoting state, parent remains visible underneath while children fade in
      expect(parentPatch.mesh.visible).toBe(true);
      expect(c0.mesh.visible).toBe(true);
      expect(c1.mesh.visible).toBe(true);
      expect(c2.mesh.visible).toBe(true);
      expect(c3.mesh.visible).toBe(true);

      // Once fade completes:
      c0.isFading = false;
      c1.isFading = false;
      c2.isFading = false;
      c3.isFading = false;
      manager.updatePatchVisibility();

      expect(group.state).toBe('children');
      // Fully promoted: parent becomes hidden
      expect(parentPatch.mesh.visible).toBe(false);
      expect(c0.mesh.visible).toBe(true);
      expect(c1.mesh.visible).toBe(true);
      expect(c2.mesh.visible).toBe(true);
      expect(c3.mesh.visible).toBe(true);

      manager.dispose();
    });
  });

  describe('Eviction Protection & Invariant Rollback', () => {
    it('protects parent patch from eviction while children are loading or promoting', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      const parentKey = getTileKey('satellite', 18, 500, 500);
      const childKeys = getChildTileKeys('satellite', 18, 500, 500);

      const parentPatch = createMockPatch(parentKey, 18, 500, 500);
      (manager as any).patches.set(parentKey, parentPatch);
      (manager as any).desiredTileKeys = new Set(childKeys);

      // With 1 child ready, state is 'loading'
      const c0 = createMockPatch(childKeys[0], 19, 1000, 1000);
      (manager as any).patches.set(childKeys[0], c0);
      manager.updatePatchVisibility();

      // hasPendingChildren must be true
      expect((manager as any).hasPendingChildren(parentKey)).toBe(true);

      // Even if parent is not in desiredTileKeys directly, it cannot be pruned
      (manager as any).prunePatches(new Set(childKeys));
      expect((manager as any).patches.has(parentKey)).toBe(true);

      manager.dispose();
    });

    it('immediately hides remaining 3 children if 1 child is evicted from a 4/4 group', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableFadeIn: false,
      });

      const parentKey = getTileKey('satellite', 18, 600, 600);
      const childKeys = getChildTileKeys('satellite', 18, 600, 600);
      (manager as any).desiredTileKeys = new Set(childKeys);

      const c0 = createMockPatch(childKeys[0], 19, 1200, 1200);
      const c1 = createMockPatch(childKeys[1], 19, 1201, 1200);
      const c2 = createMockPatch(childKeys[2], 19, 1200, 1201);
      const c3 = createMockPatch(childKeys[3], 19, 1201, 1201);
      (manager as any).patches.set(childKeys[0], c0);
      (manager as any).patches.set(childKeys[1], c1);
      (manager as any).patches.set(childKeys[2], c2);
      (manager as any).patches.set(childKeys[3], c3);

      manager.updatePatchVisibility();
      expect(c0.mesh.visible).toBe(true);
      expect(c1.mesh.visible).toBe(true);
      expect(c2.mesh.visible).toBe(true);
      expect(c3.mesh.visible).toBe(true);

      // Now evict c3 (e.g. dropped from patches)
      (manager as any).patches.delete(childKeys[3]);
      manager.updatePatchVisibility();

      const group = (manager as any).refinementGroups.get(parentKey);
      expect(group.state).toBe('loading');
      expect(group.readyChildren.size).toBe(3);

      // The 3 surviving children MUST BE HIDDEN to prevent checkerboard exposure!
      expect(c0.mesh.visible).toBe(false);
      expect(c1.mesh.visible).toBe(false);
      expect(c2.mesh.visible).toBe(false);

      manager.dispose();
    });
  });

  describe('Group-Aware Priority Scheduling', () => {
    it('prioritizes completing a 3/4 child group (Tier 0) ahead of starting new groups even if distant', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      // Parent A at zoom 17: children at zoom 18
      const pAChildren = getChildTileKeys('satellite', 17, 10, 20);
      const cA0 = pAChildren[0];
      const cA1 = pAChildren[1];
      const cA2 = pAChildren[2];
      const cA3 = pAChildren[3];

      // Simulate 3 children of Parent A loaded into patches
      (manager as any).patches.set(cA0, createMockPatch(cA0, 18, 20, 40));
      (manager as any).patches.set(cA1, createMockPatch(cA1, 18, 21, 40));
      (manager as any).patches.set(cA2, createMockPatch(cA2, 18, 20, 41));

      // Simulate active concurrency limit so queue is not drained
      (manager as any).activeRequestCount = (manager as any).maxConcurrency;

      // Reconcile desired tiles:
      // - cA3: completes 3/4 group for Parent A, but has large distance = 2.5
      // - cB0, cB1: 2/4 group for Parent B, distance = 1.8
      // - cC0: brand new group for Parent C, very close to view center (distance = 0.1)
      const pBChildren = getChildTileKeys('satellite', 17, 30, 30);
      (manager as any).patches.set(pBChildren[0], createMockPatch(pBChildren[0], 18, 60, 60));
      (manager as any).patches.set(pBChildren[1], createMockPatch(pBChildren[1], 18, 61, 60));

      const candidates = [
        { x: 100, y: 100, zoom: 18, dist: 0.1 }, // Unstarted Parent C (dist 0.1)
        { x: 60, y: 61, zoom: 18, dist: 1.8 }, // Parent B child 2 (2/4 ready, dist 1.8)
        { x: 21, y: 41, zoom: 18, dist: 2.5 }, // cA3: Parent A missing 4th child (3/4 ready, dist 2.5)
      ];

      (manager as any).reconcileDesiredTiles(candidates, {} as any, 18);

      const queue: any[] = (manager as any).requestQueue;
      expect(queue.length).toBe(3);

      // Index 0 MUST be cA3 (completing 3/4 group, Tier 0)
      expect(queue[0].key).toBe(cA3);
      // Index 1 MUST be Parent B's child (2/4 group, Tier 1)
      expect(queue[1].key).toBe(pBChildren[2]);
      // Index 2 MUST be the unstarted group (Tier 3)
      expect(queue[2].key).toBe(getTileKey('satellite', 18, 100, 100));

      manager.dispose();
    });

    it('re-sorts requestQueue on createAndMountPatch to immediately elevate newly formed 3/4 sibling', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      const pChildren = getChildTileKeys('satellite', 17, 40, 80);
      const [c0, c1, c2, c3] = pChildren;

      // Mount c0 and c1 (2/4 loaded)
      (manager as any).patches.set(c0, createMockPatch(c0, 18, 80, 160));
      (manager as any).patches.set(c1, createMockPatch(c1, 18, 81, 160));

      // Put c3 in requestQueue along with an unrelated closer tile
      const unrelatedKey = getTileKey('satellite', 18, 200, 200);
      (manager as any).requestQueue = [
        { key: unrelatedKey, zoom: 18, x: 200, y: 200, dist: 0.2, style: 'satellite' },
        { key: c3, zoom: 18, x: 81, y: 161, dist: 1.5, style: 'satellite' },
      ];

      // Now createAndMountPatch mounts c2 (turning group into 3/4 ready)
      (manager as any).createAndMountPatch(
        c2,
        18,
        80,
        161,
        new MockCanvas() as any,
        1.4,
        Date.now()
      );

      // Request queue must have re-sorted and placed c3 at index 0 because it now completes a 3/4 group!
      const queue = (manager as any).requestQueue;
      expect(queue[0].key).toBe(c3);

      manager.dispose();
    });
  });

  describe('Tabletop and First-Person Quadtree Consistency', () => {
    it('verifies computeCoherentLODTiles generates atomic 4-child quadtrees', () => {
      const tiles = computeCoherentLODTiles(
        testBounds.centerLat,
        testBounds.centerLon,
        17,
        36,
        testBounds
      );

      const highTiles = tiles.filter((t) => t.zoom === 17);
      expect(highTiles.length).toBeGreaterThan(0);

      const parentMap = new Map<string, typeof highTiles>();
      for (const t of highTiles) {
        const pKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
        let group = parentMap.get(pKey);
        if (!group) {
          group = [];
          parentMap.set(pKey, group);
        }
        group.push(t);
      }

      for (const [pKey, children] of parentMap.entries()) {
        expect(children.length, `Parent ${pKey} must have 4 children`).toBe(4);
      }
    });

    it('verifies computeFirstPersonCoherentLODTiles generates atomic 4-child quadtrees along corridor', () => {
      const tiles = computeFirstPersonCoherentLODTiles(
        46.85,
        -121.75,
        46.851,
        -121.749,
        19,
        36,
        testBounds
      );

      const highTiles = tiles.filter((t) => t.zoom === 19);
      expect(highTiles.length).toBeGreaterThan(0);

      const parentMap = new Map<string, typeof highTiles>();
      for (const t of highTiles) {
        const pKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
        let group = parentMap.get(pKey);
        if (!group) {
          group = [];
          parentMap.set(pKey, group);
        }
        group.push(t);
      }

      for (const [pKey, children] of parentMap.entries()) {
        expect(children.length, `Parent ${pKey} in first-person mode must have 4 children`).toBe(4);
      }
    });
  });

  describe('Lifecycle Cleanup', () => {
    it('clears all refinement groups in clearAllPatches and dispose', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      manager.getOrCreateRefinementGroup(getTileKey('satellite', 18, 10, 10));
      manager.getOrCreateRefinementGroup(getTileKey('satellite', 18, 20, 20));
      expect(manager.getAllRefinementGroups().size).toBe(2);

      (manager as any).clearAllPatches();
      expect(manager.getAllRefinementGroups().size).toBe(0);

      manager.getOrCreateRefinementGroup(getTileKey('satellite', 18, 30, 30));
      expect(manager.getAllRefinementGroups().size).toBe(1);

      manager.dispose();
      expect(manager.getAllRefinementGroups().size).toBe(0);
    });
  });
});
