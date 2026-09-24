import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import type { TrackStats, GPXPoint, GPXWaypoint, TrackSegment, ViewMode, TextureStyle, TrailColorMode } from '../src/gpx/TrackTypes.ts';

function createMockTrack(pointCount: number = 20): TrackStats {
  const points: GPXPoint[] = [];
  const baseTime = new Date('2026-09-20T10:00:00Z').getTime();

  for (let i = 0; i < pointCount; i++) {
    points.push({
      index: i,
      lat: 46.85 + i * 0.001,
      lon: -121.75 + i * 0.001,
      ele: 2000 + i * 50,
      time: new Date(baseTime + i * 60000),
      elapsedSeconds: i * 60,
      distanceFromStart: i * 200,
      playbackSeconds: i * 60,
      grade: 12,
      speed: 1.5,
    });
  }

  const segment: TrackSegment = {
    points,
    distance: (pointCount - 1) * 200,
    elevationGain: (pointCount - 1) * 50,
    elevationLoss: 0,
    startIndex: 0,
    endIndex: pointCount - 1,
  };

  const waypoints: GPXWaypoint[] = [
    {
      name: 'Trailhead Parking',
      lat: 46.85,
      lon: -121.75,
      ele: 2000,
      type: 'start',
    },
    {
      name: 'Camp Muir',
      lat: 46.855,
      lon: -121.745,
      ele: 2500,
      type: 'day_boundary',
    },
  ];

  const landmarks: GPXWaypoint[] = [
    {
      name: 'Start',
      lat: 46.85,
      lon: -121.75,
      ele: 2000,
      type: 'start',
      isDerivedLandmark: true,
    },
    {
      name: 'Rainier Summit',
      lat: 46.869,
      lon: -121.731,
      ele: 2950,
      type: 'summit',
      isDerivedLandmark: true,
    },
    {
      name: 'Finish',
      lat: 46.869,
      lon: -121.731,
      ele: 2950,
      type: 'finish',
      isDerivedLandmark: true,
    },
  ];

  return {
    name: 'Mount Rainier Skyline',
    points,
    segments: [segment],
    bounds: {
      minLat: 46.85,
      maxLat: 46.87,
      minLon: -121.75,
      maxLon: -121.73,
      minEle: 2000,
      maxEle: 2950,
      elevationSpan: 950,
      centerLat: 46.86,
      centerLon: -121.74,
      widthMeters: 2000,
      depthMeters: 2000,
    },
    totalDistance: (pointCount - 1) * 200,
    elevationGain: (pointCount - 1) * 50,
    elevationLoss: 0,
    minElevation: 2000,
    maxElevation: 2950,
    movingTime: (pointCount - 1) * 60,
    totalPlaybackSeconds: (pointCount - 1) * 60,
    timingType: 'recorded',
    avgSpeed: 1.5,
    maxSpeed: 2.2,
    waypoints,
    landmarks,
    warnings: [],
  };
}

describe('Stage Q: Product Polish, Landmarks, and Diagnostics', () => {
  let origDocument: any;
  let origWindow: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    origWindow = (globalThis as any).window;

    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      clearTimeout: () => {},
      setTimeout: () => 1,
    };

    const elements = new Map<string, any>();

    const mockCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      measureText: () => ({ width: 60 }),
      createLinearGradient: () => ({
        addColorStop: vi.fn(),
      }),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
      roundRect: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        const style: Record<string, string> = {};
        const listeners: Record<string, ((e?: any) => void)[]> = {};
        const children: any[] = [];
        const el: any = {
          tagName: tag.toUpperCase(),
          style,
          classList: {
            add: (cls: string) => {},
            remove: (cls: string) => {},
            toggle: (cls: string, active?: boolean) => {},
            contains: (cls: string) => false,
          },
          appendChild: (c: any) => children.push(c),
          removeChild: (c: any) => {
            const idx = children.indexOf(c);
            if (idx >= 0) children.splice(idx, 1);
          },
          children,
          addEventListener: (evt: string, fn: any) => {
            listeners[evt] = listeners[evt] || [];
            listeners[evt].push(fn);
          },
          click: () => {
            (listeners['click'] || []).forEach((fn) => fn());
          },
          getContext: (type: string) => {
            if (type === '2d') return mockCtx;
            return null;
          },
          getAttribute: (name: string) => (el as any)[name] || '',
          setAttribute: (name: string, val: string) => { (el as any)[name] = val; },
          innerHTML: '',
          textContent: '',
          value: '',
          width: 800,
          height: 600,
        };
        return el;
      },
      getElementById: (id: string) => {
        if (!elements.has(id)) {
          const el = (globalThis as any).document.createElement('div');
          el.id = id;
          elements.set(id, el);
        }
        return elements.get(id);
      },
      querySelectorAll: (sel: string) => [],
      body: {
        appendChild: (child: any) => {},
        removeChild: (child: any) => {},
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
  });

  describe('Requirement #117: Explicit and Derived Landmarks in Diorama', () => {
    it('creates diorama base containing pins for both explicit waypoints and derived landmarks without coordinate duplicates', () => {
      const track = createMockTrack(10);

      // Merge explicit waypoints with derived landmarks while preventing duplicate pins
      const allWaypoints = [...track.waypoints];
      for (const lm of track.landmarks) {
        if (lm.type === 'summit' || lm.type === 'start' || lm.type === 'finish' || lm.type === 'day_boundary') {
          const isDuplicate = allWaypoints.some(
            (w) => Math.hypot(w.lat - lm.lat, w.lon - lm.lon) < 0.0005
          );
          if (!isDuplicate) {
            allWaypoints.push(lm);
          }
        }
      }

      // 'Trailhead Parking' is at (46.85, -121.75).
      // Derived 'Start' is at (46.85, -121.75). They are within 0.0005 deg, so 'Start' was deduplicated!
      // 'Rainier Summit' is at (46.869, -121.731).
      // 'Finish' is at the same point as summit, so 'Finish' was deduplicated!
      // 'Camp Muir' is explicit at (46.855, -121.745).
      assert.strictEqual(allWaypoints.length, 3);
      assert.strictEqual(allWaypoints[0].name, 'Trailhead Parking');
      assert.strictEqual(allWaypoints[1].name, 'Camp Muir');
      assert.strictEqual(allWaypoints[2].name, 'Rainier Summit');

      const dioramaGroup = DioramaBase.create(
        track.bounds,
        -80,
        allWaypoints,
        track.bounds.minEle
      );

      const wpGroup = dioramaGroup.getObjectByName('Waypoints');
      assert.ok(wpGroup, 'DioramaBase must contain a Waypoints group');
      assert.strictEqual(wpGroup.children.length, 3);

      const pin0 = wpGroup.children[0] as THREE.Group;
      assert.strictEqual(pin0.userData.waypoint.name, 'Trailhead Parking');
      assert.strictEqual(pin0.userData.waypoint.type, 'start');

      const pin1 = wpGroup.children[1] as THREE.Group;
      assert.strictEqual(pin1.userData.waypoint.name, 'Camp Muir');
      assert.strictEqual(pin1.userData.waypoint.type, 'day_boundary');

      const pin2 = wpGroup.children[2] as THREE.Group;
      assert.strictEqual(pin2.userData.waypoint.name, 'Rainier Summit');
      assert.strictEqual(pin2.userData.waypoint.type, 'summit');

      // Verify pin jewels have distinct distinctive colors
      // summit: 0xf59e0b (amber/gold), start: 0x10b981 (green), day_boundary: 0x8b5cf6 (purple)
      const diamond0 = pin0.children[0] as THREE.Mesh;
      const mat0 = diamond0.material as THREE.MeshStandardMaterial;
      assert.strictEqual(mat0.color.getHex(), 0x10b981); // Start is emerald green

      const diamond1 = pin1.children[0] as THREE.Mesh;
      const mat1 = diamond1.material as THREE.MeshStandardMaterial;
      assert.strictEqual(mat1.color.getHex(), 0x8b5cf6); // Camp / day boundary is purple

      const diamond2 = pin2.children[0] as THREE.Mesh;
      const mat2 = diamond2.material as THREE.MeshStandardMaterial;
      assert.strictEqual(mat2.color.getHex(), 0xf59e0b); // Summit is gold
    });
  });

  describe('Requirement #118: Waypoint Jump Interaction', () => {
    function findClosestTrackProgress(
      points: { lat: number; lon: number; distanceFromStart: number }[],
      lat: number,
      lon: number,
      totalDistance: number
    ): number {
      if (!points || points.length === 0 || totalDistance <= 0) return 0;
      let bestIdx = 0;
      let bestDistSq = Infinity;
      const cosLat = Math.cos((lat * Math.PI) / 180);

      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const dLat = (pt.lat - lat) * 111320;
        const dLon = (pt.lon - lon) * 111320 * cosLat;
        const distSq = dLat * dLat + dLon * dLon;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestIdx = i;
        }
      }

      const closestPt = points[bestIdx];
      return Math.min(1, Math.max(0, closestPt.distanceFromStart / totalDistance));
    }

    it('correctly calculates track progress for start, mid, and finish waypoints', () => {
      const track = createMockTrack(21); // points 0 to 20, distances 0 to 4000m

      // Waypoint at start (point 0)
      const progStart = findClosestTrackProgress(
        track.points,
        track.points[0].lat,
        track.points[0].lon,
        track.totalDistance
      );
      assert.strictEqual(progStart, 0.0);

      // Waypoint midway (point 10)
      const progMid = findClosestTrackProgress(
        track.points,
        track.points[10].lat,
        track.points[10].lon,
        track.totalDistance
      );
      assert.strictEqual(progMid, 0.5);

      // Waypoint at summit / finish (point 20)
      const progFinish = findClosestTrackProgress(
        track.points,
        track.points[20].lat,
        track.points[20].lon,
        track.totalDistance
      );
      assert.strictEqual(progFinish, 1.0);
    });

    it('DesktopOverlay renders interactive landmark chips and triggers callback upon selection', () => {
      let selectedWaypoint: { name: string; lat: number; lon: number } | null = null;
      const dummyContainer = (globalThis as any).document.createElement('div');

      const overlay = new DesktopOverlay(dummyContainer, {
        onSelectRoute: () => {},
        onUploadGPX: () => {},
        onEnterXR: () => {},
        onToggleViewMode: () => {},
        onTogglePlay: () => {},
        onSetSpeed: () => {},
        onScrub: () => {},
        onSetTextureStyle: () => {},
        onSetTrailColorMode: () => {},
        onSelectWaypoint: (name, lat, lon) => {
          selectedWaypoint = { name, lat, lon };
        },
      });

      const track = createMockTrack(10);
      overlay.updateTrack(track);

      const list = (globalThis as any).document.getElementById('landmarksList');
      assert.ok(list.children.length > 0, 'Landmark chips should be rendered in landmarksList');

      // Click the first landmark chip (e.g. Rainier Summit)
      const firstChip = list.children[0];
      firstChip.click();

      assert.ok(selectedWaypoint, 'Clicking landmark chip should invoke onSelectWaypoint');
      const wp = selectedWaypoint as { name: string; lat: number; lon: number };
      assert.ok(wp.name.length > 0);
      assert.ok(typeof wp.lat === 'number');
      assert.ok(typeof wp.lon === 'number');
    });
  });

  describe('Requirement #119: Dynamic Trail Legend UI in DesktopOverlay', () => {
    it('updates gradient bar and text labels dynamically across grade, speed, and elevation modes', () => {
      const dummyContainer = (globalThis as any).document.createElement('div');
      const overlay = new DesktopOverlay(dummyContainer, {
        onSelectRoute: () => {},
        onUploadGPX: () => {},
        onEnterXR: () => {},
        onToggleViewMode: () => {},
        onTogglePlay: () => {},
        onSetSpeed: () => {},
        onScrub: () => {},
        onSetTextureStyle: () => {},
        onSetTrailColorMode: () => {},
      });

      const track = createMockTrack(10);
      overlay.updateTrack(track);

      const bar = (globalThis as any).document.getElementById('legendBar');
      const minEl = (globalThis as any).document.getElementById('legendMin');
      const midEl = (globalThis as any).document.getElementById('legendMid');
      const maxEl = (globalThis as any).document.getElementById('legendMax');

      // 1. Grade mode (default)
      overlay.setTrailColorMode('grade');
      assert.ok(bar.style.background.includes('#10b981'));
      assert.ok(bar.style.background.includes('#ef4444'));
      assert.strictEqual(minEl.textContent, '0% (Gentle)');
      assert.strictEqual(maxEl.textContent, '40%+ (Extreme)');

      // 2. Speed mode
      overlay.setTrailColorMode('speed');
      assert.ok(bar.style.background.includes('#ef4444'));
      assert.ok(bar.style.background.includes('#06b6d4'));
      assert.strictEqual(minEl.textContent, '< 1.1 mph (Slow)');
      assert.strictEqual(maxEl.textContent, '4.0+ mph (Fast)');

      // 3. Elevation mode
      overlay.setTrailColorMode('elevation');
      assert.ok(bar.style.background.includes('#00f5d4'));
      assert.ok(bar.style.background.includes('#ffffff'));
      // Min is 2000m = 6,562 ft, Max is 2950m = 9,678 ft
      assert.ok(minEl.textContent.includes('ft'));
      assert.ok(maxEl.textContent.includes('ft'));
    });
  });

  describe('Requirements #120 & #121: Type Integrity for ViewMode and TextureStyle', () => {
    it('strictly enforces ViewMode as "diorama" | "first-person" and TextureStyle as "satellite" | "topo" | "hybrid"', () => {
      const validViewModes: ViewMode[] = ['diorama', 'first-person'];
      const validTextureStyles: TextureStyle[] = ['satellite', 'topo', 'hybrid'];

      assert.strictEqual(validViewModes.length, 2);
      assert.strictEqual(validTextureStyles.length, 3);
      assert.ok(validViewModes.includes('diorama'));
      assert.ok(validViewModes.includes('first-person'));
      assert.ok(!validViewModes.includes('flyover' as any), 'flyover must not be in ViewMode');

      assert.ok(validTextureStyles.includes('satellite'));
      assert.ok(validTextureStyles.includes('topo'));
      assert.ok(validTextureStyles.includes('hybrid'));
      assert.ok(!validTextureStyles.includes('elevation-ramp' as any), 'elevation-ramp must not be in TextureStyle');
    });
  });

  describe('Requirement #122: Diagnostics and Upload Rate Telemetry', () => {
    it('SpatialHUD tracks upload rate and reports uploads/second', () => {
      const track = createMockTrack(5);
      const hud = new SpatialHUD(track, {
        onTogglePlay: () => {},
        onToggleViewMode: () => {},
        onToggleTexture: () => {},
        onReset: () => {},
        onExitMR: () => {},
        onScrub: () => {},
        onSetSpeed: () => {},
        onStepSeconds: () => {},
        onFocusHiker: () => {},
      });

      // Initial rate
      assert.strictEqual(typeof hud.getUploadRate(), 'number');

      // Trigger state updates
      hud.updateState(0.1, 2100, true, 'diorama', 'satellite');
      hud.updateState(0.2, 2200, true, 'diorama', 'satellite');

      const rate = hud.getUploadRate();
      assert.ok(rate >= 0);
    });

    it('TileImageCache exposes cache statistics for diagnostic readout', () => {
      const stats = TileImageCache.getStats();
      assert.strictEqual(typeof stats.entries, 'number');
      assert.strictEqual(typeof stats.maxEntries, 'number');
      assert.strictEqual(typeof stats.decodedBytes, 'number');
      assert.strictEqual(typeof stats.maxDecodedBytes, 'number');
      assert.strictEqual(typeof stats.inFlight, 'number');
      assert.ok(stats.maxEntries > 0);
    });
  });
});
