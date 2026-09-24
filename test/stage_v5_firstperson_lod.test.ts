import { describe, it, expect } from 'vitest';
import {
  ImageryLODManager,
  computeFirstPersonCoherentLODTiles,
} from '../src/terrain/ImageryLODManager.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage V6: Coherent 1:1 First-Person Imagery LOD Quadtree Suite', () => {
  const testBounds: GeoBounds = {
    minLat: 46.8,
    maxLat: 46.9,
    minLon: -121.8,
    maxLon: -121.7,
    centerLat: 46.85,
    centerLon: -121.75,
    minEle: 1400,
    maxEle: 4392,
    widthMeters: 8000,
    depthMeters: 11000,
    elevationSpan: 2992,
  };

  describe('Quadtree Candidate Atomicity & No Partial-Parent Holes (Stage V6.1)', () => {
    it('generates all promoted high-res tiles in complete 2x2 parent quadtree units (no partial parents)', () => {
      const hikerLat = 46.85;
      const hikerLon = -121.75;
      const forwardLat = 46.852;
      const forwardLon = -121.748;
      const innerZoom = 19;
      const maxPatches = 36; // Desktop budget

      const candidates = computeFirstPersonCoherentLODTiles(
        hikerLat,
        hikerLon,
        forwardLat,
        forwardLon,
        innerZoom,
        maxPatches,
        testBounds
      );

      // Total candidates must not exceed maxPatches
      expect(candidates.length).toBeLessThanOrEqual(maxPatches);

      // Verify all zHigh tiles belong to complete 4-child quadtree blocks
      const highTiles = candidates.filter((c) => c.zoom === innerZoom);
      expect(highTiles.length).toBeGreaterThan(0);

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

      // Every single parent group promoted to innerZoom MUST have all 4 children present
      for (const [parentKey, children] of parentGroups.entries()) {
        expect(
          children.length,
          `Parent ${parentKey} in first-person mode must have all 4 children promoted, but had ${children.length}`
        ).toBe(4);
      }
    });

    it('enforces contiguous surrounding zMid ring around high-res footprint without holes', () => {
      const hikerLat = 46.85;
      const hikerLon = -121.75;
      const forwardLat = 46.851;
      const forwardLon = -121.749;
      const innerZoom = 19;
      const zMid = 18;
      const maxPatches = 36;

      const candidates = computeFirstPersonCoherentLODTiles(
        hikerLat,
        hikerLon,
        forwardLat,
        forwardLon,
        innerZoom,
        maxPatches,
        testBounds
      );

      const highTiles = candidates.filter((c) => c.zoom === innerZoom);
      const midTiles = candidates.filter((c) => c.zoom === zMid);

      expect(highTiles.length).toBeGreaterThan(0);
      expect(midTiles.length).toBeGreaterThan(0);

      // High tiles + mid tiles must strictly fit within maxPatches
      expect(highTiles.length + midTiles.length).toBe(candidates.length);
      expect(candidates.length).toBeLessThanOrEqual(maxPatches);

      // Promoted parent footprints must not overlap midTiles (no redundant duplicate coverage)
      const promotedParentKeys = new Set(
        highTiles.map((t) => `${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`)
      );
      for (const mid of midTiles) {
        expect(promotedParentKeys.has(`${mid.x}:${mid.y}`)).toBe(false);
      }
    });
  });

  describe('Quest XR Conservative Budget Scaling & Coherent Demotion (Stage V6.2)', () => {
    it('scales quadtree parent count cleanly on Quest profile (maxPatches = 24) without slicing partial parents', () => {
      const hikerLat = 46.85;
      const hikerLon = -121.75;
      const forwardLat = 46.853;
      const forwardLon = -121.747;
      const innerZoom = 19;
      const questMaxPatches = 24;

      const candidates = computeFirstPersonCoherentLODTiles(
        hikerLat,
        hikerLon,
        forwardLat,
        forwardLon,
        innerZoom,
        questMaxPatches,
        testBounds
      );

      expect(candidates.length).toBeLessThanOrEqual(questMaxPatches);

      const highTiles = candidates.filter((c) => c.zoom === innerZoom);
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

      // Even under tight Quest 24-patch budget, EVERY parent promoted has all 4 children
      expect(parentGroups.size).toBeGreaterThan(0);
      for (const [parentKey, children] of parentGroups.entries()) {
        expect(
          children.length,
          `Under Quest budget, parent ${parentKey} must have 4 children, but had ${children.length}`
        ).toBe(4);
      }
    });

    it('demotes coherently to pure zMid if budget cannot accommodate any 4-child zHigh block', () => {
      const hikerLat = 46.85;
      const hikerLon = -121.75;
      const forwardLat = 46.85;
      const forwardLon = -121.75;
      const innerZoom = 19;
      const tinyBudget = 6; // Too small for 4 high + 8 mid (12 tiles)

      const candidates = computeFirstPersonCoherentLODTiles(
        hikerLat,
        hikerLon,
        forwardLat,
        forwardLon,
        innerZoom,
        tinyBudget,
        testBounds
      );

      expect(candidates.length).toBeLessThanOrEqual(tinyBudget);
      // All candidates should be demoted to zMid (18)
      expect(candidates.every((c) => c.zoom === 18)).toBe(true);
    });
  });

  describe('Directional Forward Prefetch Prioritization (Stage V6.3)', () => {
    it('prioritizes forward lookahead parent along route azimuth and includes forward children', () => {
      const hikerLat = 46.85;
      const hikerLon = -121.75;
      // Forward point ~300m North
      const forwardLat = 46.853;
      const forwardLon = -121.75;
      const innerZoom = 19;
      const maxPatches = 36;

      const fwdTile = latLonToTile(forwardLat, forwardLon, innerZoom);
      const fwdParentKey = `${innerZoom - 1}:${Math.floor(fwdTile.x / 2)}:${Math.floor(fwdTile.y / 2)}`;

      const candidates = computeFirstPersonCoherentLODTiles(
        hikerLat,
        hikerLon,
        forwardLat,
        forwardLon,
        innerZoom,
        maxPatches,
        testBounds
      );

      // Verify that the forward parent tile is included in promoted parents or mid coverage
      const highTiles = candidates.filter((c) => c.zoom === innerZoom);
      const promotedParentKeys = new Set(
        highTiles.map((t) => `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`)
      );

      expect(
        promotedParentKeys.has(fwdParentKey),
        `Forward prefetch parent ${fwdParentKey} should be promoted to high-res`
      ).toBe(true);
    });
  });
});
