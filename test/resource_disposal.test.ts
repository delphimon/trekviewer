import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { disposeObject3D } from '../src/core/ResourceLifecycle.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewer Test">
  <trk>
    <name>Test Ridge</name>
    <trkseg>
      <trkpt lat="46.85" lon="-121.75"><ele>1500</ele><time>2026-09-20T10:00:00Z</time></trkpt>
      <trkpt lat="46.86" lon="-121.74"><ele>1800</ele><time>2026-09-20T10:15:00Z</time></trkpt>
      <trkpt lat="46.87" lon="-121.73"><ele>2100</ele><time>2026-09-20T10:30:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('Resource Disposal Lifecycle (Stage E)', () => {
  it('disposeObject3D recursively releases geometries, materials, texture maps, and canvas buffers', () => {
    const root = new THREE.Group();

    // Create a mock canvas
    const canvas = {
      width: 1024,
      height: 1024,
      getContext: () => ({}),
    } as unknown as HTMLCanvasElement;

    // Track dispose calls
    let geoDisposed = false;
    let matDisposed = false;
    let texDisposed = false;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.addEventListener('dispose', () => {
      geoDisposed = true;
    });

    const tex = new THREE.CanvasTexture(canvas);
    tex.addEventListener('dispose', () => {
      texDisposed = true;
    });

    const mat = new THREE.MeshStandardMaterial({ map: tex });
    mat.addEventListener('dispose', () => {
      matDisposed = true;
    });

    const mesh = new THREE.Mesh(geo, mat);
    const subGroup = new THREE.Group();
    subGroup.add(mesh);
    root.add(subGroup);

    assert.strictEqual(root.children.length, 1);
    assert.strictEqual(subGroup.children.length, 1);
    assert.strictEqual(canvas.width, 1024);

    // Perform recursive disposal
    disposeObject3D(root);

    // Verify GPU resources are marked disposed
    assert.strictEqual(geoDisposed, true, 'BufferGeometry must be disposed');
    assert.strictEqual(matDisposed, true, 'Material must be disposed');
    assert.strictEqual(texDisposed, true, 'Texture map must be disposed');

    // Verify canvas backing store was collapsed to 1x1 to reclaim RAM
    assert.strictEqual(canvas.width, 1, 'Canvas backing width must be reduced to 1');
    assert.strictEqual(canvas.height, 1, 'Canvas backing height must be reduced to 1');

    // Verify scene graph hierarchy was completely detached
    assert.strictEqual(root.children.length, 0, 'Root children must be detached');
    assert.strictEqual(subGroup.children.length, 0, 'Subgroup children must be detached');
    assert.strictEqual(mesh.parent, null, 'Mesh parent must be null');
  });

  it('SpatialHUD.dispose() frees texture, collapses canvas backing store, and clears scene hierarchy', () => {
    const origDocument = (globalThis as any).document;
    const mockCtx = new Proxy(
      {
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
        createLinearGradient: () => ({
          addColorStop: () => {},
        }),
      },
      {
        get(target: any, prop: string) {
          if (prop in target) return target[prop];
          return () => {};
        },
        set(target: any, prop: string, value: any) {
          target[prop] = value;
          return true;
        },
      }
    );

    const mockCanvas = {
      width: 1024,
      height: 680,
      getContext: () => mockCtx,
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return mockCanvas;
        return {};
      },
    };


    try {
      const track = GPXParser.parse(SAMPLE_GPX, 'Test Ridge');
      const hud = new SpatialHUD(track, {
        onTogglePlay: () => {},
        onToggleViewMode: () => {},
        onToggleTexture: () => {},
        onToggleTrailColor: () => {},
        onReset: () => {},
        onExitMR: () => {},
        onScrub: () => {},
        onSetSpeed: () => {},
        onStepSeconds: () => {},
        onFocusHiker: () => {},
        onDockHUD: () => {},
      });

      assert.ok(hud.group);
      assert.ok(hud.group.children.length > 0, 'HUD must contain meshes');
      assert.strictEqual((hud as any).canvas.width, 1024);
      assert.strictEqual((hud as any).canvas.height, 680);

      let hudTexDisposed = false;
      (hud as any).texture.addEventListener('dispose', () => {
        hudTexDisposed = true;
      });

      hud.dispose();

      assert.strictEqual(hudTexDisposed, true, 'SpatialHUD canvas texture must be disposed');
      assert.strictEqual((hud as any).canvas.width, 1, 'SpatialHUD canvas width must collapse to 1');
      assert.strictEqual((hud as any).canvas.height, 1, 'SpatialHUD canvas height must collapse to 1');
      assert.strictEqual(hud.group.children.length, 0, 'SpatialHUD group children must be cleared');
    } finally {
      (globalThis as any).document = origDocument;
    }
  });


  it('handles AbortController signal correctly when route load is superseded', async () => {
    let activeAbortController: AbortController | null = null;
    let completedRoute: string | null = null;

    const startRouteLoad = async (routeName: string, delayMs: number) => {
      if (activeAbortController) {
        activeAbortController.abort();
      }
      const controller = new AbortController();
      activeAbortController = controller;
      const signal = controller.signal;

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (signal.aborted) {
              reject(new Error('Aborted'));
            } else {
              resolve();
            }
          }, delayMs);

          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });

        if (signal.aborted) return;
        completedRoute = routeName;
      } catch (e: any) {
        if (e.message === 'Aborted') {
          // cleanly aborted
          return;
        }
        throw e;
      }
    };

    // Start loading Route A (50ms)
    const loadA = startRouteLoad('Route A', 50);

    // 10ms later, user clicks Route B (15ms) - Route A must be aborted
    await new Promise((r) => setTimeout(r, 10));
    const loadB = startRouteLoad('Route B', 15);

    await Promise.all([loadA, loadB]);

    assert.strictEqual(completedRoute, 'Route B', 'Route B must complete and Route A must be cleanly aborted');
  });
});
