import { describe, it } from "vitest";
import assert from 'node:assert';
import { TrekSession } from '../src/core/TrekSession.ts';
import type { TrackStats, GPXPoint, GPXWaypoint } from '../src/gpx/TrackTypes.ts';

describe("session state", () => {
  it("verifies session state", async () => {

console.log('--- Testing TrekSession Authoritative State Store ---');

const session = new TrekSession();
const initialState = session.getState();

// 1. Initial Defaults
assert.strictEqual(initialState.viewMode, 'diorama');
assert.strictEqual(initialState.textureStyle, 'satellite');
assert.strictEqual(initialState.trailColorMode, 'grade');
assert.strictEqual(initialState.verticalExaggeration, 1.0);
assert.strictEqual(initialState.isPlaying, false);
assert.strictEqual(initialState.playbackSpeed, 20.0);
assert.strictEqual(initialState.progress, 0);
assert.strictEqual(initialState.currentDistance, 0);
assert.strictEqual(initialState.terrainQuality, 'dem');
console.log('✓ Initial session defaults verified');

// 2. Subscription & State Change Notifications
let callCount = 0;
let lastPrevState: any = null;
let lastNewState: any = null;

const unsubscribe = session.subscribe((newState, prevState) => {
  callCount++;
  lastNewState = newState;
  lastPrevState = prevState;
});

session.setPlayback(true);
assert.strictEqual(callCount, 1);
assert.strictEqual(lastNewState.isPlaying, true);
assert.strictEqual(lastPrevState.isPlaying, false);

session.setPlayback(true); // Redundant update should not re-trigger
assert.strictEqual(callCount, 1);

session.setSpeed(50.0);
assert.strictEqual(callCount, 2);
assert.strictEqual(session.getState().playbackSpeed, 50.0);

session.setSpeed(-5); // Min bound clamped to >= 0.1
assert.strictEqual(session.getState().playbackSpeed, 0.1);

session.setVerticalExaggeration(2.5);
assert.strictEqual(session.getState().verticalExaggeration, 2.5);

session.setVerticalExaggeration(5.0); // Clamped to 3.0
assert.strictEqual(session.getState().verticalExaggeration, 3.0);

session.setVerticalExaggeration(0.5); // Clamped to 1.0
assert.strictEqual(session.getState().verticalExaggeration, 1.0);

console.log('✓ Subscriptions and value clamping verified');

// 3. Track Loading & Elevation Sync
const mockPoints: GPXPoint[] = [
  { lat: 46.85, lon: -121.75, ele: 1500, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
  { lat: 46.86, lon: -121.76, ele: 3000, distanceFromStart: 5000, elapsedSeconds: 3600, playbackSeconds: 1800, index: 1 },
  { lat: 46.87, lon: -121.77, ele: 4392, distanceFromStart: 10000, elapsedSeconds: 7200, playbackSeconds: 3600, index: 2 },
];

const mockTrack: TrackStats = {
  name: 'Rainier Summit',
  points: mockPoints,
  totalDistance: 10000,
  elevationGain: 2892,
  elevationLoss: 0,
  minElevation: 1500,
  maxElevation: 4392,
  movingTime: 7200,
  totalPlaybackSeconds: 3600,
  avgSpeed: 5.0,
  maxSpeed: 8.5,
  bounds: {
    minLat: 46.85, maxLat: 46.87, minLon: -121.77, maxLon: -121.75,
    minEle: 1500, maxEle: 4392,
    centerLat: 46.86, centerLon: -121.76,
    widthMeters: 5000, depthMeters: 5000, elevationSpan: 2892,
  },
  waypoints: [],
  landmarks: [],
  segments: [],
  warnings: [],
};

session.setTrack(mockTrack, 'rainier', 'manifest');
assert.strictEqual(session.getState().routeName, 'Rainier Summit');
assert.strictEqual(session.getState().currentElevation, 1500);
assert.strictEqual(session.getState().currentDistance, 0);
assert.strictEqual(session.getState().progress, 0);
assert.strictEqual(session.getState().activeRouteId, 'rainier');

// 4. Progress Tracking along Track
session.setProgress(0.5, 3000, 5000, mockPoints[1]);
assert.strictEqual(session.getState().progress, 0.5);
assert.strictEqual(session.getState().currentElevation, 3000);
assert.strictEqual(session.getState().currentDistance, 5000);
assert.strictEqual(session.getState().currentPoint?.index, 1);

// Progress bounds clamp 0..1
session.setProgress(1.5);
assert.strictEqual(session.getState().progress, 1.0);

session.setProgress(-0.2);
assert.strictEqual(session.getState().progress, 0.0);

// 5. Waypoint Selection
const wp: GPXWaypoint = { lat: 46.87, lon: -121.77, ele: 4392, name: 'Columbia Crest' };
session.selectWaypoint(wp);
assert.strictEqual(session.getState().selectedWaypoint?.name, 'Columbia Crest');

session.selectWaypoint(null);
assert.strictEqual(session.getState().selectedWaypoint, null);

// 6. Unsubscribe
unsubscribe();
const preCount = callCount;
session.setPlayback(false);
assert.strictEqual(callCount, preCount, 'Unsubscribed listener should not receive updates');

console.log('✓ All TrekSession state store tests passed!');

  });
});
