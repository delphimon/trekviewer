import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  computeCoherentLODTiles,
  parseTileKey,
} from '../src/terrain/ImageryLODManager.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage W3: Tabletop 2x2 Parent Quadtree Expansion & Gaze Extension', () => {
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

  it('promotes at least a 2x2 parent quadtree group (16 z19 children) plus surrounding z18 perimeter on Quest 48-patch budget', () => {
    const targetLat = 46.05;
    const targetLon = 7.75;
    const zHigh = 19;
    const maxPatches = 48; // Quest Tabletop budget

    const candidates = computeCoherentLODTiles(
      targetLat,
      targetLon,
      zHigh,
      maxPatches,
      testBounds
    );

    expect(candidates.length).toBeLessThanOrEqual(maxPatches);
    expect(candidates.length).toBeGreaterThanOrEqual(28);

    const highTiles = candidates.filter((t) => t.zoom === zHigh);
    const midTiles = candidates.filter((t) => t.zoom === zHigh - 1);

    // Verify all zHigh tiles belong to complete 4-child quadtrees
    const parentGroups = new Map<string, typeof highTiles>();
    for (const t of highTiles) {
      const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
      let group = parentGroups.get(parentKey);
      if (!group) {
        group = [];
        parentGroups.set(parentKey, group);
      }
      group.push(t);
    }

    // At least 4 parents (2x2 parents = 16 children)
    expect(parentGroups.size).toBeGreaterThanOrEqual(4);
    for (const [parentKey, children] of parentGroups.entries()) {
      expect(
        children.length,
        `Parent ${parentKey} must have all 4 children, but had ${children.length}`
      ).toBe(4);
    }

    // Mid-res ring must be present and enclose the high-res parents
    expect(midTiles.length).toBeGreaterThanOrEqual(8);
  });

  it('extends high-res footprint along horizontal gaze direction when gazeVector is provided', () => {
    const targetLat = 46.05;
    const targetLon = 7.75;
    const zHigh = 19;
    const maxPatches = 48;

    // Eastward gaze (+dx)
    const eastGaze = { dx: 1.0, dy: 0.0 };
    const candidatesEast = computeCoherentLODTiles(
      targetLat,
      targetLon,
      zHigh,
      maxPatches,
      testBounds,
      undefined,
      eastGaze
    );

    const highTilesEast = candidatesEast.filter((t) => t.zoom === zHigh);
    const parentGroupsEast = new Map<string, typeof highTilesEast>();
    for (const t of highTilesEast) {
      const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
      let group = parentGroupsEast.get(parentKey);
      if (!group) {
        group = [];
        parentGroupsEast.set(parentKey, group);
      }
      group.push(t);
    }

    // Gaze extension should promote 6 parents (3x2 = 24 children)
    expect(parentGroupsEast.size).toBe(6);
    expect(highTilesEast.length).toBe(24);
    for (const [parentKey, children] of parentGroupsEast.entries()) {
      expect(children.length).toBe(4);
    }

    // Southward gaze (+dy)
    const southGaze = { dx: 0.0, dy: 1.0 };
    const candidatesSouth = computeCoherentLODTiles(
      targetLat,
      targetLon,
      zHigh,
      maxPatches,
      testBounds,
      undefined,
      southGaze
    );

    const highTilesSouth = candidatesSouth.filter((t) => t.zoom === zHigh);
    const parentGroupsSouth = new Map<string, typeof highTilesSouth>();
    for (const t of highTilesSouth) {
      const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
      let group = parentGroupsSouth.get(parentKey);
      if (!group) {
        group = [];
        parentGroupsSouth.set(parentKey, group);
      }
      group.push(t);
    }

    expect(parentGroupsSouth.size).toBe(6);
    expect(highTilesSouth.length).toBe(24);
    for (const [parentKey, children] of parentGroupsSouth.entries()) {
      expect(children.length).toBe(4);
    }
  });

  it('allocates deep high-res footprint on Desktop High budget (80 patches)', () => {
    const targetLat = 46.05;
    const targetLon = 7.75;
    const zHigh = 19;
    const maxPatches = 80;
    const gaze = { dx: 0.8, dy: 0.2 };

    const candidates = computeCoherentLODTiles(
      targetLat,
      targetLon,
      zHigh,
      maxPatches,
      testBounds,
      undefined,
      gaze
    );

    expect(candidates.length).toBeLessThanOrEqual(maxPatches);

    const highTiles = candidates.filter((t) => t.zoom === zHigh);
    const parentGroups = new Map<string, typeof highTiles>();
    for (const t of highTiles) {
      const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
      let group = parentGroups.get(parentKey);
      if (!group) {
        group = [];
        parentGroups.set(parentKey, group);
      }
      group.push(t);
    }

    // On Desktop 80-patch budget with gaze, at least 9 to 12 parents (36-48 children) are promoted
    expect(parentGroups.size).toBeGreaterThanOrEqual(9);
    for (const [parentKey, children] of parentGroups.entries()) {
      expect(children.length).toBe(4);
    }
  });

  it('guarantees atomic 4/4 child completeness across various budgets and gaze angles', () => {
    const angles = [0, Math.PI / 4, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    const budgets = [28, 38, 48, 64, 80];

    for (const budget of budgets) {
      for (const theta of angles) {
        const gaze = { dx: Math.cos(theta), dy: Math.sin(theta) };
        const candidates = computeCoherentLODTiles(
          46.05,
          7.75,
          19,
          budget,
          testBounds,
          undefined,
          gaze
        );

        expect(candidates.length).toBeLessThanOrEqual(budget);
        const highTiles = candidates.filter((t) => t.zoom === 19);
        const parentGroups = new Map<string, typeof highTiles>();
        for (const t of highTiles) {
          const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
          let group = parentGroups.get(parentKey);
          if (!group) {
            group = [];
            parentGroups.set(parentKey, group);
          }
          group.push(t);
        }

        // Each promoted parent MUST have all 4 children (no 1/4, 2/4, 3/4 holes)
        for (const [parentKey, children] of parentGroups.entries()) {
          expect(
            children.length,
            `Budget ${budget}, angle ${theta}: parent ${parentKey} must have 4 children, had ${children.length}`
          ).toBe(4);
        }
      }
    }
  });

  describe('ImageryLODManager Active Interaction Ray', () => {
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

    it('stores and clears activeInteractionRay cleanly', () => {
      expect(manager.getActiveInteractionRay()).toBeNull();

      const testRay = new THREE.Ray(
        new THREE.Vector3(0, 1.5, 0),
        new THREE.Vector3(0, -1, -1).normalize()
      );
      manager.setActiveInteractionRay(testRay);

      const retrieved = manager.getActiveInteractionRay();
      expect(retrieved).not.toBeNull();
      expect(retrieved!.origin.y).toBeCloseTo(1.5);
      expect(retrieved!.direction.z).toBeCloseTo(testRay.direction.z);

      manager.setActiveInteractionRay(null);
      expect(manager.getActiveInteractionRay()).toBeNull();
    });
  });
});
