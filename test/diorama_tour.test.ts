import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { DioramaCameraFollow } from '../src/visualization/DioramaCameraFollow.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import { playbackPresentation } from '../src/visualization/PlaybackPresentation.ts';

function route() {
  const track = GPXParser.parse(`<gpx><trk><name>Tour fixture</name><trkseg>
    <trkpt lat="47" lon="-122"><ele>100</ele><time>2026-10-19T00:00:00Z</time></trkpt>
    <trkpt lat="47.001" lon="-122"><ele>120</ele><time>2026-10-19T00:02:00Z</time></trkpt>
    <trkpt lat="47.01" lon="-122"><ele>200</ele><time>2026-10-20T00:00:00Z</time></trkpt>
    </trkseg></trk></gpx>`);
  const trail = TrailMesh.create(track);
  return { track, trail, controller: new FlyoverController(trail, track) };
}

describe('diorama route tours', () => {
  it.each(['tour', 'recorded'] as const)('predicts %s playback without advancing state, including speed, pauses and the end', mode => {
    const { controller, trail } = route();
    controller.setPlaybackMode(mode); controller.setProgress(0.4); controller.setSpeed(3);
    expect(controller.getLookaheadProgress(1.5)).toBe(0.4);
    controller.play();
    const time = controller.getPlaybackTime(), predicted = controller.getLookaheadProgress(1.5);
    expect(controller.getProgress()).toBe(0.4); expect(controller.getPlaybackTime()).toBe(time);
    controller.update(1.5);
    expect(controller.getProgress()).toBeCloseTo(predicted, 10);
    expect(controller.getLookaheadProgress(Infinity)).toBe(controller.getProgress());
    expect(controller.getLookaheadProgress(-1)).toBe(controller.getProgress());
    expect(controller.getLookaheadProgress(1e9)).toBe(1);
    controller.pause();
    expect(controller.getLookaheadProgress(1.5)).toBe(controller.getProgress());
    controller.setViewMode('first-person'); controller.play();
    expect(controller.getLookaheadProgress(1.5)).toBe(controller.getProgress());
    controller.dispose(); trail.dispose();
  });

  it('covers a multi-day route in 90 seconds regardless of recorded pace, with pause and replay', () => {
    const { controller, track } = route();
    expect(track.totalPlaybackSeconds).toBeGreaterThan(90);
    controller.setPlaybackMode('tour');
    controller.play();
    controller.update(45);
    expect(controller.getProgress()).toBeCloseTo(0.5);
    controller.pause();
    controller.update(10);
    expect(controller.getProgress()).toBeCloseTo(0.5);
    controller.play();
    controller.update(45);
    expect(controller.getProgress()).toBe(1);
    expect(controller.getIsPlaying()).toBe(false);
    controller.play();
    expect(controller.getProgress()).toBe(0);
  });

  it('preserves scrubbed location across timing changes and uses tour seconds for stepping', () => {
    const { controller } = route();
    controller.setPlaybackMode('tour');
    controller.setProgress(0.4);
    controller.setSpeed(3);
    controller.stepSeconds(9);
    expect(controller.getProgress()).toBeCloseTo(0.5);
    controller.setPlaybackMode('recorded');
    controller.update(0);
    expect(controller.getProgress()).toBeCloseTo(0.5);
    controller.setPlaybackMode('tour');
    controller.play();
    controller.update(9);
    expect(controller.getProgress()).toBeCloseTo(0.8);
    controller.update(-1);
    controller.update(NaN);
    expect(controller.getProgress()).toBeCloseTo(0.8);
  });

  it('retains temporal track playback and keeps tours out of first-person locomotion', () => {
    const { controller, track } = route();
    controller.play();
    controller.update(1);
    expect(controller.getPlaybackTime()).toBeCloseTo(1);
    controller.setPlaybackMode('tour');
    controller.setViewMode('first-person');
    controller.setProgress(0);
    controller.setSpeed(60);
    controller.play();
    controller.update(1);
    expect(controller.getProgress() * track.totalDistance).toBeLessThanOrEqual(1.4 + 1e-8);
  });

  it('leaves the XR camera and transformed tabletop fixed while the hiker progresses', () => {
    const { controller } = route();
    const root = new THREE.Group();
    root.position.set(0.1, 0.82, -0.8);
    root.rotation.set(0.1, 0.4, 0);
    root.scale.setScalar(0.001);
    root.updateMatrix();
    const initial = root.matrix.clone();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.3, 1.6, 0);
    camera.updateMatrix();
    const initialCamera = camera.matrix.clone();
    controller.setPlaybackMode('tour');
    controller.play();
    controller.update(10, camera, root, true);
    root.updateMatrix(); camera.updateMatrix();
    expect(controller.getProgress()).toBeGreaterThan(0);
    expect(root.matrix.equals(initial)).toBe(true);
    expect(camera.matrix.equals(initialCamera)).toBe(true);
  });

  it('resets the speed when switching timing basis and shares the UI presets', () => {
    const session = new TrekSession();
    expect(session.getState().playbackMode).toBe('tour');
    expect(session.getState().followRoute).toBe(false);
    session.setProgress(0.6);
    session.setSpeed(3);
    session.setPlaybackMode('recorded');
    expect(session.getState().playbackSpeed).toBe(1);
    expect(session.getState().progress).toBe(0.6);
    expect(playbackPresentation('tour', 'diorama', false).speeds).toEqual([0.5, 1, 2, 3]);
    expect(playbackPresentation('recorded', 'diorama', false).speeds).toEqual([1, 5, 20, 60]);
  });
});

it('smoothly follows a moving focus with equivalent results across frame rates', () => {
  function follow(hz: number) {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1, 2);
    const target = new THREE.Vector3();
    const focus = new THREE.Vector3(0.3, 0.1, -0.2);
    const follower = new DioramaCameraFollow();
    follower.start(camera, target);
    for (let i = 0; i < hz; i++) follower.update(camera, target, focus, 1 / hz);
    return { camera, target, focus };
  }
  const a = follow(30), b = follow(90);
  expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-8);
  expect(a.target.distanceTo(b.target)).toBeLessThan(1e-8);
  expect(a.target.distanceTo(a.focus)).toBeLessThan(0.02);
  expect(a.camera.position.y).toBeGreaterThan(a.focus.y + 0.18);
});
