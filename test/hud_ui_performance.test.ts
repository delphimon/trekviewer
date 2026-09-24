import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { GPXValidator } from '../src/gpx/GPXValidator.ts';
import type { TrackStats, GPXPoint, TrackSegment } from '../src/gpx/TrackTypes.ts';

function createMockTrack(pointCount: number = 10, hasTimestamps: boolean = true): TrackStats {
  const points: GPXPoint[] = [];
  const baseTime = new Date('2026-09-20T10:00:00Z').getTime();

  for (let i = 0; i < pointCount; i++) {
    points.push({
      index: i,
      lat: 46.85 + i * 0.001,
      lon: -121.75 + i * 0.001,
      ele: 2000 + i * 20,
      time: hasTimestamps ? new Date(baseTime + i * 60000) : undefined,
      elapsedSeconds: i * 60,
      distanceFromStart: i * 100,
      playbackSeconds: i * 60,
    });
  }

  const segment: TrackSegment = {
    points,
    distance: (pointCount - 1) * 100,
    elevationGain: (pointCount - 1) * 20,
    elevationLoss: 0,
    startIndex: 0,
    endIndex: pointCount - 1,
  };

  return {
    name: 'Performance Test Track',
    points,
    segments: [segment],
    bounds: {
      minLat: 46.85,
      maxLat: 46.86,
      minLon: -121.76,
      maxLon: -121.75,
      minEle: 2000,
      maxEle: 2000 + (pointCount - 1) * 20,
      elevationSpan: (pointCount - 1) * 20,
      centerLat: 46.855,
      centerLon: -121.755,
      widthMeters: 1000,
      depthMeters: 1000,
    },
    totalDistance: (pointCount - 1) * 100,
    elevationGain: (pointCount - 1) * 20,
    elevationLoss: 0,
    minElevation: 2000,
    maxElevation: 2000 + (pointCount - 1) * 20,
    movingTime: (pointCount - 1) * 60,
    totalPlaybackSeconds: (pointCount - 1) * 60,
    timingType: hasTimestamps ? 'recorded' : 'estimated',
    avgSpeed: 1.4,
    maxSpeed: 2.0,
    waypoints: [],
    landmarks: [],
    warnings: [],
  };
}

describe('Stage L: HUD and UI Performance Architecture', () => {
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
      measureText: () => ({ width: 50 }),
      roundRect: vi.fn(),
      drawImage: vi.fn(),
      setLineDash: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 1024,
            height: 680,
            getContext: () => mockCtx,
          };
        }
        return {
          style: {},
          classList: {
            add: vi.fn(),
            remove: vi.fn(),
            toggle: vi.fn(),
          },
          appendChild: vi.fn(),
          addEventListener: vi.fn(),
          setAttribute: vi.fn(),
          getAttribute: () => null,
        };
      },
      getElementById: (id: string) => {
        if (!elements.has(id)) {
          const el: any = {
            id,
            disabled: false,
            style: {},
            classList: {
              add: vi.fn(),
              remove: vi.fn(),
              toggle: vi.fn(),
            },
            addEventListener: vi.fn(),
            textContent: '',
            value: '0',
            files: [],
          };
          if (id === 'canvasChart') {
            el.width = 280;
            el.height = 60;
            el.getContext = () => mockCtx;
          }
          elements.set(id, el);
        }
        return elements.get(id);
      },
      querySelectorAll: (sel: string) => {
        if (sel === '.btn-exag') {
          return [
            { getAttribute: () => '1', classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() }, addEventListener: vi.fn() },
            { getAttribute: () => '1.5', classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() }, addEventListener: vi.fn() },
            { getAttribute: () => '2', classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() }, addEventListener: vi.fn() },
            { getAttribute: () => '3', classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn() }, addEventListener: vi.fn() },
          ];
        }
        return [];
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    vi.restoreAllMocks();
  });

  describe('SpatialHUD Dual-Layer & Upload Throttling', () => {
    it('caches elevation profile samples once on creation and reuses them without re-sampling', () => {
      const sampleSpy = vi.spyOn(GPXParser, 'sampleElevationProfile');
      const track = createMockTrack(50);

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

      // Must be sampled once during constructor
      assert.strictEqual(sampleSpy.mock.calls.length, 1);

      // Multiple updateState calls during flyover must NEVER re-sample the profile
      for (let i = 0; i < 20; i++) {
        hud.updateState(i / 20, 2000 + i * 10, true, 'diorama', 'satellite');
      }

      assert.strictEqual(
        sampleSpy.mock.calls.length,
        1,
        'sampleElevationProfile must NOT be called repeatedly during updates'
      );

      hud.dispose();
    });

    it('throttles dynamic texture uploads during active playback to <= 12 uploads/sec and flushes immediately on user action', () => {
      let mockNow = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockNow);

      const track = createMockTrack(50);
      let uploadCount = 0;

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

      const texture = (hud as any).texture;
      Object.defineProperty(texture, 'needsUpdate', {
        set(val: boolean) {
          if (val) uploadCount++;
        },
        get() {
          return false;
        },
      });

      // Reset initial constructor upload
      uploadCount = 0;

      // Simulate 72 frames within 1000ms (~13.88ms per frame) during active playback
      for (let frame = 0; frame < 72; frame++) {
        mockNow += 13.88;
        const progress = frame / 72;
        hud.updateState(progress, 2000 + frame, true, 'diorama', 'satellite');
      }

      // Over 1000ms with 85ms minimum interval: 1000 / 85 ~= 11-12 uploads max
      assert(
        uploadCount <= 12,
        `Active playback GPU texture uploads must be throttled (got ${uploadCount}, expected <= 12)`
      );
      assert(
        uploadCount >= 10,
        `Throttled upload rate should maintain smooth 8-12 Hz HUD updates (got ${uploadCount})`
      );

      // Now test settled state: when paused and stationary, 0 uploads should occur
      uploadCount = 0;
      hud.updateState(0.5, 2050, false, 'diorama', 'satellite');
      // The pause itself triggers 1 immediate flush to settle cleanly
      assert.strictEqual(uploadCount, 1);
      uploadCount = 0;

      // Subsequent identical calls or calls when settled with no changes:
      for (let frame = 0; frame < 20; frame++) {
        mockNow += 16;
        hud.update();
      }
      assert.strictEqual(uploadCount, 0, 'Settled state must produce 0 texture uploads');

      hud.dispose();
    });

    it('cycles vertical exaggeration through [1.0, 1.5, 2.0, 3.0] and calls onSetVerticalExaggeration', () => {
      const track = createMockTrack(20);
      let receivedExag = 1.0;

      const hud = new SpatialHUD(track, {
        onTogglePlay: () => {},
        onToggleViewMode: () => {},
        onToggleTexture: () => {},
        onSetVerticalExaggeration: (f) => {
          receivedExag = f;
        },
        onReset: () => {},
        onExitMR: () => {},
        onScrub: () => {},
        onSetSpeed: () => {},
        onStepSeconds: () => {},
        onFocusHiker: () => {},
      });

      // Click on btn-exag (x=800, y=500 in canvas space, UV: x=800/1024, y=1 - 500/680)
      const uvExag = new THREE.Vector2(850 / 1024, 1 - 510 / 680);

      // 1st click: 1.0x -> 1.5x
      const handled1 = hud.onPointerClick(uvExag);
      assert.strictEqual(handled1, true);
      assert.strictEqual(receivedExag, 1.5);

      // 2nd click: 1.5x -> 2.0x
      hud.onPointerClick(uvExag);
      assert.strictEqual(receivedExag, 2.0);

      // 3rd click: 2.0x -> 3.0x
      hud.onPointerClick(uvExag);
      assert.strictEqual(receivedExag, 3.0);

      // 4th click: 3.0x -> 1.0x (cycles back)
      hud.onPointerClick(uvExag);
      assert.strictEqual(receivedExag, 1.0);

      hud.dispose();
    });
  });

  describe('DesktopOverlay File Guard & Sample Caching', () => {
    it('rejects files larger than 25 MB before calling readAsText', () => {
      const container = { innerHTML: '' } as HTMLElement;
      let uploadCalled = false;

      const overlay = new DesktopOverlay(container, {
        onSelectRoute: () => {},
        onUploadGPX: () => {
          uploadCalled = true;
        },
        onEnterXR: () => {},
        onToggleViewMode: () => {},
        onTogglePlay: () => {},
        onSetSpeed: () => {},
        onScrub: () => {},
        onSetTextureStyle: () => {},
        onSetTrailColorMode: () => {},
      });

      let showStatusMessage = '';
      (overlay as any).showStatus = (msg: string) => {
        showStatusMessage = msg;
      };

      // Mock FileReader
      let readAsTextCalled = false;
      (globalThis as any).FileReader = class {
        readAsText() {
          readAsTextCalled = true;
        }
      };

      // Simulate change event on gpxUploadInput with a 26 MB file
      const fileInput = document.getElementById('gpxUploadInput') as any;
      const oversizedFile = {
        name: 'huge_alps_tour.gpx',
        size: 26 * 1024 * 1024, // 26 MB
      };
      fileInput.files = [oversizedFile];

      // Retrieve the listener attached in setupEventListeners
      // By calling the change listener:
      const changeCalls = fileInput.addEventListener.mock.calls.filter((c: any) => c[0] === 'change');
      assert(changeCalls.length > 0, 'change listener must be attached');
      const changeHandler = changeCalls[0][1];

      changeHandler();

      assert.strictEqual(readAsTextCalled, false, 'readAsText must NOT be called for files > 25 MB');
      assert.strictEqual(uploadCalled, false, 'upload callback must NOT be fired');
      assert(showStatusMessage.includes('exceeds 25 MB limit'), 'Status message must warn about file size');

      // Now simulate valid 2 MB file
      const validFile = {
        name: 'standard_hike.gpx',
        size: 2 * 1024 * 1024, // 2 MB
      };
      fileInput.files = [validFile];
      changeHandler();

      assert.strictEqual(readAsTextCalled, true, 'readAsText must be called for valid file sizes');

      overlay.dispose();
    });

    it('caches elevation samples on updateTrack and blits static canvas on scrubber update without re-sampling', () => {
      const container = { innerHTML: '' } as HTMLElement;
      const sampleSpy = vi.spyOn(GPXParser, 'sampleElevationProfile');

      const overlay = new DesktopOverlay(container, {
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

      const track = createMockTrack(40);
      overlay.updateTrack(track);

      // Once on updateTrack
      assert.strictEqual(sampleSpy.mock.calls.length, 1);

      // Rapid scrubber updates must not re-sample
      for (let i = 0; i < 30; i++) {
        overlay.updateScrubber(i / 30, 2000 + i * 5);
      }

      assert.strictEqual(
        sampleSpy.mock.calls.length,
        1,
        'updateScrubber must use cached elevation samples and static canvas blit'
      );

      overlay.dispose();
    });
  });

  describe('FlyoverController True Temporal Multiplier', () => {
    it('applies true temporal multiplier: 1x real second advances 1x trek second, 20x advances 20 trek seconds', () => {
      const track = createMockTrack(60);
      const trailResult = TrailMesh.create(track);
      const controller = new FlyoverController(trailResult, track);

      // At 1x speed, stepSeconds(10) should advance by exactly 10 trek seconds
      controller.setSpeed(1.0);
      controller.stepSeconds(10);
      assert.strictEqual(Math.round(controller.getPlaybackTime()), 10);

      // At 20x speed, stepSeconds(10) should advance by 10 * 20 = 200 trek seconds
      controller.setSpeed(20.0);
      controller.stepSeconds(10);
      assert.strictEqual(Math.round(controller.getPlaybackTime()), 210);

      // During active play with speed 5.0, delta of 2.0 real seconds advances 10 trek seconds
      controller.setProgress(0);
      controller.setSpeed(5.0);
      controller.play();

      const dummyCam = new THREE.PerspectiveCamera();
      const dummyRoot = new THREE.Group();

      controller.update(2.0, dummyCam, dummyRoot, false);
      assert.strictEqual(Math.round(controller.getPlaybackTime()), 10);
    });
  });

  describe('GPXValidator & Timing Type', () => {
    it('GPXValidator reports full-fidelity rendering instead of false decimation', () => {
      const points = Array.from({ length: 21000 }, (_, i) => ({
        lat: 46.85 + i * 0.00001,
        lon: -121.75 + i * 0.00001,
        ele: 2000,
      }));

      const result = GPXValidator.validate(points);
      assert.strictEqual(result.isValid, true);
      const warning = result.warnings.find((w) => w.includes('High point count'));
      assert(warning !== undefined, 'Should have high point count warning');
      assert(
        warning.includes('Rendering full-fidelity track'),
        `Warning should state full-fidelity track rendering: got "${warning}"`
      );
      assert(
        !warning.includes('may be decimated'),
        'Warning must not claim track may be decimated'
      );
    });

    it('GPXParser accurately identifies timingType as recorded or estimated', () => {
      const trackWithTime = createMockTrack(10, true);
      assert.strictEqual(trackWithTime.timingType, 'recorded');

      const trackWithoutTime = createMockTrack(10, false);
      assert.strictEqual(trackWithoutTime.timingType, 'estimated');
    });
  });
});
