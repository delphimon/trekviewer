import { describe, it } from 'vitest';
import assert from 'node:assert';
import { TrekSession } from '../src/core/TrekSession.ts';
import type { TrackStats, GPXPoint, GPXWaypoint } from '../src/gpx/TrackTypes.ts';

describe('TrekSession Authoritative State Store (Stage G)', () => {
  it('initializes with correct defaults', () => {
    const session = new TrekSession();
    const state = session.getState();

    assert.strictEqual(state.viewMode, 'diorama');
    assert.strictEqual(state.textureStyle, 'satellite');
    assert.strictEqual(state.trailColorMode, 'grade');
    assert.strictEqual(state.verticalExaggeration, 1.0);
    assert.strictEqual(state.isPlaying, false);
    assert.strictEqual(state.playbackSpeed, 1.0);
    assert.strictEqual(state.progress, 0);
    assert.strictEqual(state.currentDistance, 0);
    assert.strictEqual(state.terrainQuality, 'dem');
    assert.strictEqual(state.loadingPhase, 'idle');
    assert.strictEqual(state.track, null);
  });

  it('notifies subscribers on state changes and deduplicates redundant updates', () => {
    const session = new TrekSession();
    let callCount = 0;
    let lastNewState: any = null;
    let lastPrevState: any = null;

    const unsubscribe = session.subscribe((newState, prevState) => {
      callCount++;
      lastNewState = newState;
      lastPrevState = prevState;
    });

    session.setPlayback(true);
    assert.strictEqual(callCount, 1);
    assert.strictEqual(lastNewState.isPlaying, true);
    assert.strictEqual(lastPrevState.isPlaying, false);

    // Redundant update must NOT trigger listeners
    session.setPlayback(true);
    assert.strictEqual(callCount, 1);

    session.setTextureStyle('hybrid');
    assert.strictEqual(callCount, 2);
    assert.strictEqual(lastNewState.textureStyle, 'hybrid');

    session.setTextureStyle('hybrid');
    assert.strictEqual(callCount, 2);

    unsubscribe();
    session.setPlayback(false);
    assert.strictEqual(callCount, 2, 'Unsubscribed listener must not be called');
  });

  it('enforces input clamping on speed, exaggeration, and progress', () => {
    const session = new TrekSession();

    // Speed clamping (>= 0.1)
    session.setSpeed(2.5);
    assert.strictEqual(session.getState().playbackSpeed, 2.5);
    session.setSpeed(-10);
    assert.strictEqual(session.getState().playbackSpeed, 0.1);
    session.setSpeed(0);
    assert.strictEqual(session.getState().playbackSpeed, 0.1);

    // Vertical exaggeration clamping ([1.0, 3.0])
    session.setVerticalExaggeration(2.0);
    assert.strictEqual(session.getState().verticalExaggeration, 2.0);
    session.setVerticalExaggeration(5.0);
    assert.strictEqual(session.getState().verticalExaggeration, 3.0);
    session.setVerticalExaggeration(0.2);
    assert.strictEqual(session.getState().verticalExaggeration, 1.0);

    // Progress clamping ([0.0, 1.0])
    session.setProgress(0.45);
    assert.strictEqual(session.getState().progress, 0.45);
    session.setProgress(1.8);
    assert.strictEqual(session.getState().progress, 1.0);
    session.setProgress(-0.5);
    assert.strictEqual(session.getState().progress, 0.0);
  });

  it('synchronizes track statistics, bounds, and initial elevations', () => {
    const session = new TrekSession();

    const mockPoints: GPXPoint[] = [
      { lat: 46.85, lon: -121.75, ele: 1500, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
      { lat: 46.86, lon: -121.76, ele: 3000, distanceFromStart: 5000, elapsedSeconds: 3600, playbackSeconds: 1800, index: 1 },
      { lat: 46.87, lon: -121.77, ele: 4392, distanceFromStart: 10000, elapsedSeconds: 7200, playbackSeconds: 3600, index: 2 },
    ];

    const mockTrack: TrackStats = {
      name: 'Mount Rainier Summit',
      points: mockPoints,
      totalDistance: 10000,
      elevationGain: 2892,
      elevationLoss: 0,
      minElevation: 1500,
      maxElevation: 4392,
      totalDurationSeconds: 7200,
      totalPlaybackSeconds: 3600,
      bounds: {
        minLat: 46.85, maxLat: 46.87, minLon: -121.77, maxLon: -121.75,
        minEle: 1500, maxEle: 4392,
        centerLat: 46.86, centerLon: -121.76,
        widthMeters: 5000, depthMeters: 5000, heightMeters: 2892,
      },
      elevationProfile: [],
      waypoints: [],
      landmarks: [],
      segments: [],
      warnings: [],
    };

    session.setTrack(mockTrack, 'rainier', 'manifest');
    const state = session.getState();
    assert.strictEqual(state.routeName, 'Mount Rainier Summit');
    assert.strictEqual(state.activeRouteId, 'rainier');
    assert.strictEqual(state.currentElevation, 1500);
    assert.strictEqual(state.currentDistance, 0);
    assert.strictEqual(state.progress, 0);
    assert.strictEqual(state.currentPoint, mockPoints[0]);

    // Progress updates calculate distance and current point correctly
    session.setProgress(0.5, 3000, 5000, mockPoints[1]);
    assert.strictEqual(session.getState().progress, 0.5);
    assert.strictEqual(session.getState().currentElevation, 3000);
    assert.strictEqual(session.getState().currentDistance, 5000);
    assert.strictEqual(session.getState().currentPoint, mockPoints[1]);

    // Clearing track
    session.setTrack(null);
    assert.strictEqual(session.getState().track, null);
    assert.strictEqual(session.getState().routeName, 'No Trek Selected');
    assert.strictEqual(session.getState().activeRouteId, null);
  });

  it('manages loading phases and error reporting', () => {
    const session = new TrekSession();
    let lastPhase: any = null;

    session.subscribe((s) => {
      lastPhase = s.loadingPhase;
    });

    session.setLoadingStatus('parsing', 'Parsing GPX survey...', 0.1);
    assert.strictEqual(lastPhase, 'parsing');
    assert.strictEqual(session.getState().loadingProgress, 0.1);
    assert.strictEqual(session.getState().loadingMessage, 'Parsing GPX survey...');
    assert.strictEqual(session.getState().isError, false);

    session.setLoadingStatus('terrain', 'Downloading DEM elevation...', 0.5);
    assert.strictEqual(lastPhase, 'terrain');
    assert.strictEqual(session.getState().loadingProgress, 0.5);

    session.setLoadingStatus('ready', 'Trek ready.', 1.0);
    assert.strictEqual(lastPhase, 'ready');

    session.setLoadingStatus('error', 'Network failure.', null, true);
    assert.strictEqual(lastPhase, 'error');
    assert.strictEqual(session.getState().isError, true);
  });

  it('manages waypoint selection and attribution', () => {
    const session = new TrekSession();
    const wp: GPXWaypoint = { lat: 46.87, lon: -121.77, ele: 4392, name: 'Columbia Crest' };

    session.selectWaypoint(wp);
    assert.strictEqual(session.getState().selectedWaypoint?.name, 'Columbia Crest');

    session.selectWaypoint(null);
    assert.strictEqual(session.getState().selectedWaypoint, null);

    session.setAttribution('USGS Topo');
    assert.strictEqual(session.getState().attribution, 'USGS Topo');
  });
});
