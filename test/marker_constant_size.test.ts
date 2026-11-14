import { expect, it } from 'vitest';
import * as THREE from 'three';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';

const track = GPXParser.parse(`<gpx><trk><name>Size</name><trkseg>
<trkpt lat="47" lon="-121"><ele>100</ele></trkpt>
<trkpt lat="47.02" lon="-120.98"><ele>900</ele></trkpt></trkseg></trk></gpx>`, 'Size');

function setup(scale: number) {
  const trail = TrailMesh.create(track);
  const root = new THREE.Group(); root.scale.setScalar(scale); root.add(trail.group); root.updateMatrixWorld(true);
  return { trail, root };
}
const worldHeight = (marker: THREE.Object3D) => {
  marker.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(marker).getSize(new THREE.Vector3()).y;
};

it('keeps the hiker and pins the same room size at any model scale in XR', () => {
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 1.6, 0.5);
  const heights = [0.0001, 0.001].map(scale => {
    const { trail, root } = setup(scale);
    trail.updateMarkerScales!(camera); root.updateMatrixWorld(true);
    return [worldHeight(trail.hikerMarker), worldHeight(trail.startBeacon)];
  });
  expect(heights[0][0]).toBeCloseTo(0.05, 3); expect(heights[1][0]).toBeCloseTo(0.05, 3);
  expect(heights[0][1]).toBeCloseTo(0.04, 3); expect(heights[1][1]).toBeCloseTo(0.04, 3);
});

it('keeps a constant pixel size on desktop, so zooming in no longer enlarges the pins', () => {
  const { trail, root } = setup(0.0001);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.001, 100);
  const pin = trail.startBeacon.getWorldPosition(new THREE.Vector3());
  camera.position.copy(pin).add(new THREE.Vector3(0, 0, 0.5)); camera.updateMatrixWorld(true);
  trail.updateMarkerScales!(camera, 900); root.updateMatrixWorld(true);
  const far = worldHeight(trail.startBeacon);
  camera.position.copy(pin).add(new THREE.Vector3(0, 0, 0.25)); camera.updateMatrixWorld(true);
  trail.updateMarkerScales!(camera, 900); root.updateMatrixWorld(true);
  expect(worldHeight(trail.startBeacon)).toBeCloseTo(far / 2, 4); // half the distance, half the size
});

it('stands waypoint markers about 1.5 m tall in life-size mode only', async () => {
  const { DioramaBase, LIFE_SIZE_MARKER_HEIGHT_M, BASE_MARKER_DIAMETER_LOCAL } = await import('../src/visualization/DioramaBase.ts');
  const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
    widthMeters: 3000, depthMeters: 3000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
  const base = DioramaBase.create(bounds, undefined, [{ name: 'Spring', lat: 46.85, lon: -121.75, ele: 500 }]);
  const pin = base.getObjectByName('Waypoints')!.children[0];
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 600, 50);
  DioramaBase.updateWaypoints(base, camera, 1, 0.016, undefined, true);
  expect(pin.scale.x * BASE_MARKER_DIAMETER_LOCAL).toBeCloseTo(LIFE_SIZE_MARKER_HEIGHT_M);
  DioramaBase.updateWaypoints(base, camera, 1, 0.016);
  expect(pin.scale.x * BASE_MARKER_DIAMETER_LOCAL).toBeLessThan(0.1);
});
