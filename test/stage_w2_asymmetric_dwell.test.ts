import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  getTileKey,
} from '../src/terrain/ImageryLODManager.ts';
import { QUALITY_PROFILES } from '../src/terrain/QualityProfile.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage W2: Asymmetric Promotion/Demotion & Priority Queue Scheduler', () => {
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

  describe('Asymmetric Promotion and Demotion Dwell Timing', () => {
    it('promotes quickly after promotion dwell (200ms) and resists demotion during momentary view changes (3000ms dwell)', () => {
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        qualityProfile: {
          ...QUALITY_PROFILES['quest-high'],
          promotionDwellMs: 200,
          demotionDwellMs: 3000,
          evalIntervalMs: 100,
        },
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 1.5, 1.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.00008, 0.00008, 0.00008);

      // Initial evaluation
      manager.update(camera, dioramaRoot, false);
      const initialZoom = manager.getDiagnostics().targetZoom;

      // 1. Move camera closer -> triggers higher desired zoom
      camera.position.set(0, 0.35, 0.35);
      camera.lookAt(0, 0, 0);

      // t = 1100ms: candidate detected, promoteCandidateSince = 1100ms (0ms dwell)
      mockTime += 100;
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBe(initialZoom);

      // t = 1200ms: 100ms elapsed since candidate (< 200ms promotion dwell)
      mockTime += 100;
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBe(initialZoom);

      // t = 1350ms: 250ms total elapsed (>= 200ms promotion dwell) -> eager promotion!
      mockTime += 150;
      manager.update(camera, dioramaRoot, false);
      const promotedZoom = manager.getDiagnostics().targetZoom;
      expect(promotedZoom).toBeGreaterThan(initialZoom);

      // 2. Momentary head movement / look away: move camera further away
      camera.position.set(0, 1.8, 1.8);
      camera.lookAt(0, 0, 0);

      // t = 1850ms: 500ms elapsed since look-away (< 3000ms demotion dwell)
      mockTime += 500;
      manager.update(camera, dioramaRoot, false);
      // High-res zoom remains strictly preserved!
      expect(manager.getDiagnostics().targetZoom).toBe(promotedZoom);

      // t = 2850ms: 1500ms elapsed since look-away (still < 3000ms demotion dwell)
      mockTime += 1000;
      manager.update(camera, dioramaRoot, false);
      // Still preserved!
      expect(manager.getDiagnostics().targetZoom).toBe(promotedZoom);

      // 3. User looks back at ridge before demotion dwell expires!
      camera.position.set(0, 0.35, 0.35);
      camera.lookAt(0, 0, 0);
      mockTime += 200;
      manager.update(camera, dioramaRoot, false);
      // Continuous sharp high-res retained with zero collapse or reload!
      expect(manager.getDiagnostics().targetZoom).toBe(promotedZoom);

      // 4. Truly sustained look-away (> 3000ms)
      camera.position.set(0, 2.0, 2.0);
      camera.lookAt(0, 0, 0);
      mockTime += 100;
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBe(promotedZoom); // Candidate starts

      mockTime += 3500; // Demotion dwell exceeded!
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBeLessThan(promotedZoom);

      manager.dispose();
    });
  });

  describe('Priority Queue Scheduler & Partial Quadtree Completion', () => {
    it('prioritizes finishing a 3/4 child group ahead of unrelated new parent groups', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      // Suppose parent at zoom 17, (px=10, py=20) has children at z18:
      // (20,40), (21,40), (20,41), (21,41)
      const c1 = getTileKey('satellite', 18, 20, 40);
      const c2 = getTileKey('satellite', 18, 21, 40);
      const c3 = getTileKey('satellite', 18, 20, 41);
      const c4 = getTileKey('satellite', 18, 21, 41);

      // Simulate 3 children already loaded into patches
      const mockPatch = (key: string) => ({
        key,
        zoom: 18,
        mesh: { visible: false },
        dispose: () => {},
      });
      (manager as any).patches.set(c1, mockPatch(c1));
      (manager as any).patches.set(c2, mockPatch(c2));
      (manager as any).patches.set(c3, mockPatch(c3));

      // Simulate full in-flight concurrency so drainQueue does not immediately shift tiles out of requestQueue
      (manager as any).activeRequestCount = (manager as any).maxConcurrency;

      // Reconcile desired tiles with candidate 4 (which completes the 3/4 group)
      // and candidate 5 & 6 (from an unrelated unstarted group)
      const candidates = [
        { x: 50, y: 50, zoom: 18, dist: 0.1 }, // Unrelated tile close to center
        { x: 51, y: 50, zoom: 18, dist: 0.2 }, // Unrelated tile
        { x: 21, y: 41, zoom: 18, dist: 1.5 }, // c4: completes 3/4 parent group!
      ];

      (manager as any).reconcileDesiredTiles(candidates, {} as any, 18);

      const queue: any[] = (manager as any).requestQueue;
      expect(queue.length).toBe(3);

      // c4 MUST be at index 0 of requestQueue even though its distance (1.5) is larger than unrelated tiles!
      expect(queue[0].key).toBe(c4);

      manager.dispose();
    });

    it('does not abort in-flight requests that have loaded siblings when focus shifts slightly', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
      });

      const c1 = getTileKey('satellite', 18, 20, 40);
      const c2 = getTileKey('satellite', 18, 21, 40);

      // c1 is loaded
      (manager as any).patches.set(c1, {
        key: c1,
        zoom: 18,
        mesh: { visible: false },
        dispose: () => {},
      });

      // c2 is in-flight pending
      const abortCtrl = new AbortController();
      (manager as any).pendingRequests.set(c2, {
        key: c2,
        zoom: 18,
        x: 21,
        y: 40,
        dist: 1.0,
        abortController: abortCtrl,
      });

      // New desired set does NOT include c2 (gaze drifted slightly)
      const newCandidates = [
        { x: 80, y: 80, zoom: 18, dist: 0.5 },
      ];

      (manager as any).reconcileDesiredTiles(newCandidates, {} as any, 18);

      // c2 was NOT aborted because it shares parent with loaded sibling c1!
      expect(abortCtrl.signal.aborted).toBe(false);
      expect((manager as any).pendingRequests.has(c2)).toBe(true);

      manager.dispose();
    });
  });
});
