import assert from 'node:assert';
import * as THREE from 'three';
import { TrekSession } from '../src/core/TrekSession.ts';
import { RouteLoader } from '../src/core/RouteLoader.ts';

console.log('--- Testing RouteLoader Lifecycle & Cancellation Management ---');

// Lightweight Node DOM mock for canvas creation
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 512,
          height: 512,
          getContext: () => ({
            fillStyle: '',
            fillRect: () => {},
            drawImage: () => {},
            getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4) }),
            createImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4) }),
            putImageData: () => {},
            beginPath: () => {},
            arc: () => {},
            fill: () => {},
            stroke: () => {},
            measureText: () => ({ width: 50 }),
            fillText: () => {},
            strokeText: () => {},
          }),
        };
      }
      return {};
    },
  };
}

const gpxXmlA = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Route Alpha</name>
    <trkseg>
      <trkpt lat="46.850" lon="-121.750"><ele>1500</ele></trkpt>
      <trkpt lat="46.855" lon="-121.755"><ele>2000</ele></trkpt>
      <trkpt lat="46.860" lon="-121.760"><ele>2500</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const gpxXmlB = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Route Beta</name>
    <trkseg>
      <trkpt lat="47.500" lon="-122.000"><ele>500</ele></trkpt>
      <trkpt lat="47.505" lon="-122.005"><ele>800</ele></trkpt>
      <trkpt lat="47.510" lon="-122.010"><ele>1200</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const session = new TrekSession();
const mockSceneManager = {
  renderer: { xr: { isPresenting: false } },
  dioramaRoot: new THREE.Group(),
  setViewMode: () => {},
  setDioramaVolume: () => {},
} as any;

const loader = new RouteLoader(session, mockSceneManager);

import { describe, it } from 'vitest';

describe('RouteLoader Lifecycle & Cancellation Management', () => {
  it('handles initial load, rapid preemption, and manual cancellation', async () => {
    // 1. Initial Load of Route A
    const trekA = await loader.loadRouteFromXml(gpxXmlA, 'Route Alpha', 'alpha');
    assert(trekA !== null, 'Route Alpha should load successfully');
    assert.strictEqual(session.getState().routeName, 'Route Alpha');
    assert.strictEqual(loader.getActiveTrek(), trekA);
    assert.strictEqual(mockSceneManager.dioramaRoot.children.length, 1);

    // 2. Rapid Route Switching / Preemption (A in-flight cancelled by B)
    const promiseA = loader.loadRouteFromXml(gpxXmlA, 'Route Alpha (Retry)', 'alpha_retry');
    const promiseB = loader.loadRouteFromXml(gpxXmlB, 'Route Beta', 'beta');

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    assert.strictEqual(resultA, null, 'Stale/cancelled Route Alpha must return null');
    assert(resultB !== null, 'Preempting Route Beta must load successfully');
    assert.strictEqual(loader.getActiveTrek(), resultB);
    assert.strictEqual(session.getState().routeName, 'Route Beta');
    assert.strictEqual(mockSceneManager.dioramaRoot.children.length, 1);
    assert.strictEqual(mockSceneManager.dioramaRoot.children[0], resultB!.group);

    // 3. Manual Cancellation
    const promiseC = loader.loadRouteFromXml(gpxXmlA, 'Route Alpha Cancelled', 'alpha_cancel');
    loader.cancelCurrentLoad();
    const resultC = await promiseC;

    assert.strictEqual(resultC, null, 'Cancelled load must return null');
    assert.strictEqual(loader.getActiveTrek(), resultB, 'Active trek should remain Route Beta');

    // Clean up
    resultB!.dispose();
  });
});
