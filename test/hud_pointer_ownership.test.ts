import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/offline/OfflineDownloadsPanel.ts', () => ({ OfflineDownloadsPanel: class { setManifest() {} dispose() {} } }));
import * as THREE from 'three';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { handPokePointerId, handRayPointerId } from '../src/core/XRManager.ts';
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
    createTextNode: (text: string) => ({ textContent: text }),
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 1024,
          height: 768,
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
          appendChild: vi.fn(),
          querySelector: vi.fn(() => ({ style: {}, disabled: false, textContent: '', classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } })),
          querySelectorAll: vi.fn(() => []),
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

const chart = (x: number) => new THREE.Vector2(x / 1024, 1 - 250 / 768);

it('keeps a hand-ray scrub alive when the same hand\'s poke path releases', () => {
  const onScrub = vi.fn();
  const hud = new SpatialHUD(createMockTrack(50), {
    onTogglePlay: () => {}, onToggleViewMode: () => {}, onToggleTexture: () => {},
    onReset: () => {}, onExitMR: () => {}, onScrub, onSetSpeed: () => {},
    onStepSeconds: () => {}, onFocusHiker: () => {},
  });
  const ray = handRayPointerId('left'), poke = handPokePointerId('left');
  expect(ray).not.toBe(poke);
  expect(hud.onPointerClick(chart(200), ray)).toBe(true);
  // The poke path runs every frame for the same hand and releases when the fingertip is away.
  hud.onPointerRelease(poke);
  hud.onPointerDrag(chart(600), ray);
  expect(onScrub).toHaveBeenCalledTimes(2);
  expect(onScrub.mock.lastCall![0]).toBeCloseTo((600 - 53) / 918);
  hud.onPointerRelease(ray);
  hud.onPointerDrag(chart(800), ray);
  expect(onScrub).toHaveBeenCalledTimes(2);
  hud.dispose();
});
