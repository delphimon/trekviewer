import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { RouteLoader } from '../src/core/RouteLoader.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewer WebXR Entry Test">
  <trk>
    <name>WebXR Entry Test Route</name>
    <trkseg>
      <trkpt lat="46.850" lon="-121.750"><ele>2000.0</ele><time>2026-09-20T10:00:00Z</time></trkpt>
      <trkpt lat="46.860" lon="-121.760"><ele>2500.0</ele><time>2026-09-20T11:00:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('WebXR Entry Button & Loading Phase Lifecycle (Regression Fix)', () => {
  let origDocument: any;
  let origWindow: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    origWindow = (globalThis as any).window;

    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const elements = new Map<string, any>();

    const mockCtx = {
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      measureText: () => ({ width: 50 }),
      roundRect: () => {},
      drawImage: () => {},
      setLineDash: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 512,
            height: 512,
            getContext: () => mockCtx,
          };
        }
        return {
          style: {},
          classList: { add: () => {}, remove: () => {}, toggle: () => {} },
          appendChild: () => {},
          addEventListener: () => {},
        };
      },
      getElementById: (id: string) => {
        if (!elements.has(id)) {
          elements.set(id, {
            id,
            disabled: false,
            style: {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            addEventListener: () => {},
            textContent: '',
            value: '',
          });
        }
        return elements.get(id);
      },
      querySelectorAll: () => [],
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    vi.restoreAllMocks();
  });

  it('keeps loadingPhase as ready after trek commits, and prevents background streaming from reverting it', async () => {
    const DEM_ELE = 2200.0;
    const mockGrid: ElevationGrid = {
      width: 512,
      height: 512,
      zoom: 12,
      tileXMin: 662,
      tileXMax: 663,
      tileYMin: 1442,
      tileYMax: 1443,
      numTilesX: 2,
      numTilesY: 2,
      data: new Float32Array(512 * 512).fill(DEM_ELE),
      tileValidity: new Uint8Array([1, 1, 1, 1]),
      minElevation: DEM_ELE,
      maxElevation: DEM_ELE,
      isRealDEM: true,
    };

    vi.spyOn(ElevationTileService, 'fetchElevationGrid').mockResolvedValue(mockGrid);

    const session = new TrekSession();
    const dioramaRoot = new THREE.Group();

    const loader = new RouteLoader({
      dioramaRoot,
      session,
      getIsXR: () => false,
    });

    assert.strictEqual(session.getState().loadingPhase, 'idle');

    // Load route
    const trek = await loader.loadRouteFromXml(SAMPLE_GPX, 'Test Route');
    assert(trek !== null, 'Trek must be loaded');

    // 1. Immediately after commit, loadingPhase MUST be 'ready'
    assert.strictEqual(session.getState().loadingPhase, 'ready');
    assert(loader.getActiveTrek() !== null);

    // 2. Simulate background satellite tile streaming progress callbacks
    // (This was the root cause: background streaming callbacks previously called setLoadingStatus('terrain', ...))
    (loader as any).options.onProgress?.('Terrain ready — refining imagery…', 0.5);
    assert.strictEqual(
      session.getState().loadingPhase,
      'ready',
      'loadingPhase must remain "ready" during background imagery refinement'
    );

    (loader as any).options.onProgress?.('Satellite imagery ready.', 1.0);
    assert.strictEqual(
      session.getState().loadingPhase,
      'ready',
      'loadingPhase must remain "ready" when satellite refinement completes'
    );

    loader.dispose();
  });

  it('DesktopOverlay setXREnabled toggles disabled property on VR and AR buttons', () => {
    const container = { innerHTML: '' } as HTMLElement;
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

    const vrBtn = document.getElementById('btnEnterVR') as any;
    const arBtn = document.getElementById('btnEnterAR') as any;

    overlay.setXREnabled(true);
    assert.strictEqual(vrBtn.disabled, false);
    assert.strictEqual(arBtn.disabled, false);

    overlay.setXREnabled(false);
    assert.strictEqual(vrBtn.disabled, true);
    assert.strictEqual(arBtn.disabled, true);

    overlay.setXREnabled(true);
    assert.strictEqual(vrBtn.disabled, false);
    assert.strictEqual(arBtn.disabled, false);

    overlay.dispose();
  });
});
