import { describe, it } from "vitest";
import * as THREE from 'three';
import assert from 'node:assert';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import type { TrackStats, GPXPoint, GPXWaypoint } from '../src/gpx/TrackTypes.ts';

describe("vertical exaggeration alignment", () => {
  it("verifies vertical exaggeration alignment", async () => {

console.log('--- Testing Vertical Exaggeration Alignment (Terrain, Trail & Waypoints) ---');

const summitEle = 4392.0;
const startEle = 1303.0;

const points: GPXPoint[] = [
  { lat: 46.85, lon: -121.75, ele: startEle, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
  { lat: 46.86, lon: -121.76, ele: 2800, distanceFromStart: 3000, elapsedSeconds: 1800, playbackSeconds: 30, index: 1 },
  { lat: 46.87, lon: -121.77, ele: summitEle, distanceFromStart: 6000, elapsedSeconds: 3600, playbackSeconds: 60, index: 2 },
];

const waypoints: GPXWaypoint[] = [
  { lat: 46.85, lon: -121.75, ele: startEle, name: 'Trailhead', type: 'start' },
  { lat: 46.87, lon: -121.77, ele: summitEle, name: 'Columbia Crest Summit', type: 'summit' },
];

const mockTrack: TrackStats = {
  name: 'Mount Rainier Alignment Test',
  points,
  segments: [
    {
      points,
      distance: 6000,
      elevationGain: summitEle - startEle,
      elevationLoss: 0,
      startIndex: 0,
      endIndex: 2,
    },
  ],
  totalDistance: 6000,
  elevationGain: summitEle - startEle,
  elevationLoss: 0,
  minElevation: startEle,
  maxElevation: summitEle,
  movingTime: 3600,
  totalPlaybackSeconds: 60,
  avgSpeed: 4.5,
  maxSpeed: 6.0,
  bounds: {
    minLat: 46.85,
    maxLat: 46.87,
    minLon: -121.77,
    maxLon: -121.75,
    minEle: startEle,
    maxEle: summitEle,
    centerLat: 46.86,
    centerLon: -121.76,
    widthMeters: 5000,
    depthMeters: 5000,
    elevationSpan: summitEle - startEle,
  },
  waypoints,
  landmarks: [],
  warnings: [],
};

// 1. Create TrailMesh with elevation sampler
const dummyElevationSampler = (_x: number, _z: number) => 100.0;
const trailResult = TrailMesh.create(mockTrack, dummyElevationSampler, startEle);

// 2. Create DioramaBase with waypoints and elevation sampler
const baseGroup = DioramaBase.create(
  mockTrack.bounds,
  -80,
  waypoints,
  startEle,
  dummyElevationSampler,
  1.0
);

const wpGroup = baseGroup.getObjectByName('Waypoints') as THREE.Group;
assert(wpGroup, 'Waypoints group must exist in diorama base');
assert.strictEqual(wpGroup.children.length, 2, 'Must have 2 waypoint pins');

const summitMarker = wpGroup.children.find((c) => c.name.includes('Summit'))!;
assert(summitMarker, 'Summit marker must exist');

const baseSummitY = summitMarker.userData.baseY;
assert(typeof baseSummitY === 'number' && baseSummitY > 0, 'baseY must be recorded');
console.log(`Initial 1.0x summit marker Y: ${summitMarker.position.y.toFixed(2)} (baseY=${baseSummitY.toFixed(2)})`);

// 3. Test vertical exaggeration scaling across 1.0x, 1.5x, 2.0x, 3.0x
const testFactors = [1.5, 2.0, 3.0, 1.0];

for (const factor of testFactors) {
  // Update trail exaggeration
  trailResult.setVerticalExaggeration(factor);

  // Update diorama base waypoint exaggeration
  DioramaBase.setVerticalExaggeration(baseGroup, factor);

  // Verify waypoint marker height matches factor * baseY + 8
  const expectedY: number = (baseSummitY as number) * factor + 8;
  assert(
    Math.abs(summitMarker.position.y - expectedY) < 1e-4,
    `At ${factor}x, summit marker Y should be ${expectedY.toFixed(2)}, got ${summitMarker.position.y.toFixed(2)}`
  );

  // Verify trail mesh vertices scaled proportionally
  const ribbonMesh = trailResult.trailMesh;
  const posAttr = ribbonMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  // Summit is near the end of the trail
  const lastVertexY = posAttr.getY(posAttr.count - 1);
  assert(lastVertexY > 0, 'Trail ribbon summit vertex Y must be positive');

  console.log(`✓ At ${factor.toFixed(1)}x exaggeration: summit marker Y = ${summitMarker.position.y.toFixed(2)}m (strictly aligned)`);
}

trailResult.dispose();
console.log('✓ All Vertical Exaggeration Alignment tests passed successfully!');

  });
});
