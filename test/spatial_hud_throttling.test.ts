import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

describe('SpatialHUD throttling and offscreen canvas', () => {
  it('throttles rapid progress updates and caches static canvas', async () => {
    // Mock minimal DOM document with mock canvas context if not present
    let staticDraws = 0;
    let dynamicDraws = 0;

    const createMockCtx = (isStatic: boolean): any => ({
      clearRect: () => {},
      beginPath: () => {},
      roundRect: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
      setLineDash: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      arc: () => {},
      fillRect: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      drawImage: () => {
        if (!isStatic) dynamicDraws++;
      },
    });

    let canvasCount = 0;
    const origDoc = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          canvasCount++;
          const isStatic = canvasCount === 2;
          const mock = createMockCtx(isStatic);
          const origClear = mock.clearRect;
          mock.clearRect = () => {
            origClear();
            if (isStatic) staticDraws++;
          };
          return {
            width: 1024,
            height: 680,
            getContext: (type: string) => mock,
          };
        }
        return {};
      },
    };

    try {
      const mockTrack: TrackStats = {
        name: 'Rainier Test Route',
        points: [
          { lat: 46.85, lon: -121.75, ele: 1500, time: new Date(), distanceFromStart: 0, grade: 0.05, speed: 1.2 },
          { lat: 46.86, lon: -121.76, ele: 4392, time: new Date(), distanceFromStart: 10000, grade: 0.15, speed: 0.8 },
        ],
        totalDistance: 10000,
        elevationGain: 2892,
        elevationLoss: 0,
        minElevation: 1500,
        maxElevation: 4392,
        movingTime: 10000,
        totalPlaybackSeconds: 120,
        avgSpeed: 1.0,
        maxSpeed: 2.0,
        bounds: {
          minLat: 46.85, maxLat: 46.86, minLon: -121.76, maxLon: -121.75,
          minEle: 1500, maxEle: 4392, centerLat: 46.855, centerLon: -121.755,
          widthMeters: 5000, depthMeters: 5000, elevationSpan: 2892,
        },
        waypoints: [],
        landmarks: [],
        segments: [],
        warnings: [],
      };

      const session = new TrekSession();
      session.setTrack(mockTrack);

      const hud = new SpatialHUD(
        mockTrack,
        {
          onTogglePlay: () => {},
          onToggleViewMode: () => {},
          onToggleTexture: () => {},
          onReset: () => {},
          onExitMR: () => {},
          onScrub: () => {},
          onSetSpeed: () => {},
          onStepSeconds: () => {},
          onFocusHiker: () => {},
        },
        session
      );

      const initialStaticDraws = staticDraws;
      assert(initialStaticDraws >= 1, 'Static HUD should be drawn at initialization');
      const initialDynamicDraws = dynamicDraws;
      assert(initialDynamicDraws >= 1, 'Dynamic HUD should be drawn at initialization');

      // Simulate 50 rapid progress updates within a few milliseconds (like a high-framerate playback tick)
      for (let i = 0; i < 50; i++) {
        session.setState({
          progress: i / 100,
          currentElevation: 1500 + i * 50,
        });
      }

      // Static draws should NOT have increased because buttons/title/route didn't change!
      assert.strictEqual(
        staticDraws,
        initialStaticDraws,
        'Static canvas should NOT redraw when only progress changes'
      );

      // Dynamic draws must be throttled and NOT fire 50 times synchronously
      const rapidDynamicDraws = dynamicDraws - initialDynamicDraws;
      assert(
        rapidDynamicDraws <= 2,
        `Expected throttled dynamic draws (<= 2), got ${rapidDynamicDraws}`
      );

      // Now change a static property (e.g. viewMode)
      session.setViewMode('first-person');
      assert(
        staticDraws > initialStaticDraws,
        'Static canvas must redraw when viewMode or buttons change'
      );

      // Test idempotent dispose
      hud.dispose();
      hud.dispose(); // Should not throw
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});
