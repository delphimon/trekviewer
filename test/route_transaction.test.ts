import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { RouteLoader } from '../src/core/RouteLoader.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrekSession } from '../src/core/TrekSession.ts';

const ROUTE_A_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewer Test">
  <trk>
    <name>Camp Muir Trail</name>
    <trkseg>
      <trkpt lat="46.786" lon="-121.735"><ele>1650.0</ele><time>2026-09-20T10:00:00Z</time></trkpt>
      <trkpt lat="46.800" lon="-121.730"><ele>2400.0</ele><time>2026-09-20T11:00:00Z</time></trkpt>
      <trkpt lat="46.835" lon="-121.731"><ele>3072.0</ele><time>2026-09-20T13:00:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const ROUTE_B_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewer Test">
  <trk>
    <name>Enchantments Traverse</name>
    <trkseg>
      <trkpt lat="47.485" lon="-120.785"><ele>1000.0</ele><time>2026-09-21T06:00:00Z</time></trkpt>
      <trkpt lat="47.495" lon="-120.805"><ele>1800.0</ele><time>2026-09-21T08:30:00Z</time></trkpt>
      <trkpt lat="47.510" lon="-120.835"><ele>2380.0</ele><time>2026-09-21T11:00:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const INVALID_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<notgpx>This is not a valid GPX document</notgpx>`;

describe('Route Transaction Architecture & State Atomicity (Stage F)', () => {
  let origDocument: any;
  let origFetch: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    origFetch = (globalThis as any).fetch;

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
            width: 1024,
            height: 1024,
            getContext: () => mockCtx,
          };
        }
        return {};
      },
    };

    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('route-a.gpx')) {
        return {
          ok: true,
          status: 200,
          text: async () => ROUTE_A_GPX,
        };
      }
      if (url.includes('route-b.gpx')) {
        return {
          ok: true,
          status: 200,
          text: async () => ROUTE_B_GPX,
        };
      }
      if (url.includes('invalid.gpx')) {
        return {
          ok: true,
          status: 200,
          text: async () => INVALID_GPX,
        };
      }
      if (url.includes('network-fail.gpx')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        };
      }
      // Tile requests: return 404 so TerrainGenerator falls back to fast synthetic topography
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).fetch = origFetch;
  });

  it('LoadedTrek encapsulates all 3D components, adjusts vertical exaggeration, and disposes completely', async () => {
    const dioramaRoot = new THREE.Group();
    let committedTrek: LoadedTrek | null = null;

    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
      onTrekCommitted: (trek) => {
        committedTrek = trek;
      },
    });

    const trek = await loader.loadRouteFromXml(ROUTE_A_GPX, 'Camp Muir Trail');
    assert(trek, 'LoadedTrek must be created successfully');
    assert.strictEqual(trek === committedTrek, true, 'Committed trek must match returned trek');
    assert.strictEqual(trek.track.name, 'Camp Muir Trail');
    assert.strictEqual(trek.isDisposed, false);

    // Verify dioramaRoot has exactly 1 child: the trek's group
    assert.strictEqual(dioramaRoot.children.length, 1);
    assert.strictEqual(dioramaRoot.children[0], trek.group);

    // Verify trek.group encapsulates terrain, trail, and dioramaBase
    assert(trek.group.children.includes(trek.terrainResult.group), 'Trek group must contain terrain');
    assert(trek.group.children.includes(trek.trailResult.group), 'Trek group must contain trail');
    assert(trek.group.children.includes(trek.dioramaBase), 'Trek group must contain dioramaBase');

    // Test vertical exaggeration delegation
    assert.doesNotThrow(() => {
      trek.setVerticalExaggeration(1.5);
    });

    // Test disposal
    trek.dispose();
    assert.strictEqual(trek.isDisposed, true);
    assert.strictEqual(trek.group.parent, null, 'Trek group must be detached from parent');
    assert.strictEqual(dioramaRoot.children.length, 0, 'dioramaRoot must be empty after trek disposal');
  });

  it('guarantees atomic swap: old route remains mounted and rendered until new route is 100% ready', async () => {
    const dioramaRoot = new THREE.Group();
    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
    });

    // 1. Initial Route A
    const trekA = await loader.loadRouteFromXml(ROUTE_A_GPX, 'Camp Muir');
    assert(trekA !== null);
    assert.strictEqual(dioramaRoot.children.length, 1);
    assert.strictEqual(dioramaRoot.children[0], trekA.group);
    assert.strictEqual(loader.getActiveTrek()?.track.name, 'Camp Muir Trail');

    // 2. Load Route B via URL
    // While Route B is loading, Route A must remain in dioramaRoot
    const loadPromise = loader.loadRouteFromUrl('/routes/route-b.gpx', 'Enchantments');

    // Check intermediate state immediately after starting load
    assert.strictEqual(dioramaRoot.children.length, 1, 'Scene must not go blank during route loading');
    assert.strictEqual(dioramaRoot.children[0], trekA.group, 'Route A must remain mounted while Route B loads');
    assert.strictEqual(trekA.isDisposed, false, 'Route A must not be disposed until Route B is ready');

    const trekB = await loadPromise;
    assert(trekB !== null);

    // 3. Post-commit verification
    assert.strictEqual(dioramaRoot.children.length, 1, 'dioramaRoot must have exactly 1 active trek');
    assert.strictEqual(dioramaRoot.children[0], trekB.group, 'Route B must now be mounted');
    assert.strictEqual(loader.getActiveTrek()?.track.name, 'Enchantments Traverse');

    // Route A must now be cleanly disposed
    assert.strictEqual(trekA.isDisposed, true, 'Old Route A must be disposed after atomic swap');
    assert.strictEqual(trekA.group.parent, null, 'Old Route A group must be detached');
  });

  it('guarantees error rollback: failure leaves active route untouched and cleans up partial assets', async () => {
    const dioramaRoot = new THREE.Group();
    let capturedError: Error | null = null;

    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
      onError: (err) => {
        capturedError = err;
      },
    });

    // 1. Load stable initial Route A
    const trekA = await loader.loadRouteFromXml(ROUTE_A_GPX, 'Camp Muir');
    assert(trekA !== null);
    assert.strictEqual(dioramaRoot.children[0], trekA.group);

    // 2. Attempt to load invalid route (corrupt XML)
    const failedTrek = await loader.loadRouteFromXml(INVALID_GPX, 'Corrupt Route');
    assert.strictEqual(failedTrek, null, 'Failed load must return null');
    assert(capturedError !== null, 'onError callback must receive the error');

    // Verify ROLLBACK: Route A is STILL mounted and active!
    assert.strictEqual(dioramaRoot.children.length, 1, 'Scene must still contain exactly 1 route');
    assert.strictEqual(dioramaRoot.children[0], trekA.group, 'Route A must remain mounted');
    assert.strictEqual(trekA.isDisposed, false, 'Route A must NOT be disposed on failed load');
    assert.strictEqual(loader.getActiveTrek()?.track.name, 'Camp Muir Trail');

    // 3. Attempt network failure
    capturedError = null;
    const netFailedTrek = await loader.loadRouteFromUrl('/routes/network-fail.gpx', 'Network Failed Route');
    assert.strictEqual(netFailedTrek, null);
    assert(capturedError !== null);

    // Verify ROLLBACK again: Route A is STILL intact
    assert.strictEqual(dioramaRoot.children.length, 1);
    assert.strictEqual(dioramaRoot.children[0], trekA.group);
    assert.strictEqual(trekA.isDisposed, false);
  });

  it('handles race conditions: rapid clicks cancel superseded requests and only commit the latest', async () => {
    const dioramaRoot = new THREE.Group();
    const committedTracks: string[] = [];

    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
      onTrekCommitted: (trek) => {
        committedTracks.push(trek.track.name);
      },
    });

    // Trigger Load 1, immediately superseded by Load 2, immediately superseded by Load 3
    const p1 = loader.loadRouteFromUrl('/routes/route-a.gpx', 'Load 1');
    const p2 = loader.loadRouteFromUrl('/routes/route-b.gpx', 'Load 2');
    const p3 = loader.loadRouteFromUrl('/routes/route-a.gpx', 'Load 3');

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    // Only Load 3 should succeed
    assert.strictEqual(res1, null, 'Superseded Load 1 must return null');
    assert.strictEqual(res2, null, 'Superseded Load 2 must return null');
    assert(res3 !== null, 'Latest Load 3 must succeed');

    // Verify scene contains only Load 3
    assert.strictEqual(dioramaRoot.children.length, 1);
    assert.strictEqual(dioramaRoot.children[0], res3.group);
    assert.strictEqual(committedTracks.length, 1, 'Only 1 trek must have been committed');
    assert.strictEqual(committedTracks[0], 'Camp Muir Trail');
  });

  it('loader dispose() clears all mounted treks and aborts pending loads', async () => {
    const dioramaRoot = new THREE.Group();
    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
    });

    const trek = await loader.loadRouteFromXml(ROUTE_A_GPX, 'Camp Muir');
    assert(trek !== null);
    assert.strictEqual(dioramaRoot.children.length, 1);

    loader.dispose();

    assert.strictEqual(dioramaRoot.children.length, 0, 'dioramaRoot must be empty after loader dispose');
    assert.strictEqual(loader.getActiveTrek(), null, 'activeTrek must be null after dispose');
    assert.strictEqual(trek.isDisposed, true, 'Trek must be marked disposed');
  });

  it('correctly classifies manifest vs upload source and preserves routeId', async () => {
    const dioramaRoot = new THREE.Group();
    const session = new TrekSession();
    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
      session,
    });

    // 1. Loading from URL -> manifest source
    const urlTrek = await loader.loadRouteFromUrl('/routes/route-a.gpx', 'Camp Muir Trail', 'route-a-id');
    assert(urlTrek !== null);
    assert.strictEqual(session.getState().routeSource, 'manifest');
    assert.strictEqual(session.getState().activeRouteId, 'route-a-id');
    assert.strictEqual(session.getState().routeName, 'Camp Muir Trail');

    // 2. Loading from XML directly -> upload source
    const xmlTrek = await loader.loadRouteFromXml(ROUTE_B_GPX, 'Custom Upload');
    assert(xmlTrek !== null);
    assert.strictEqual(session.getState().routeSource, 'upload');
    assert.strictEqual(session.getState().activeRouteId, 'upload:Custom Upload');
    assert.strictEqual(session.getState().routeName, 'Enchantments Traverse');

    loader.dispose();
  });
});
