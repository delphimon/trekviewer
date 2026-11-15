import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { NEAR_FIELD_STRIP_HEIGHT_M, NEAR_FIELD_STRIP_WIDTH_M, NearFieldStrip, nearFieldTargetAt } from '../src/ui/NearFieldStrip.ts';

// Minimal canvas: every 2D context call is a no-op.
const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
beforeAll(() => vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) }));
afterAll(() => vi.unstubAllGlobals());

function makeStrip() {
  const actions = { togglePlay: vi.fn(), previousLandmark: vi.fn(), nextLandmark: vi.fn(), scrub: vi.fn() };
  return { strip: new NearFieldStrip(actions), actions };
}

describe('NearFieldStrip', () => {
  it('has poke targets of at least 3 cm', () => {
    expect(NEAR_FIELD_STRIP_HEIGHT_M).toBeGreaterThanOrEqual(0.03);
    expect(0.14 * NEAR_FIELD_STRIP_WIDTH_M).toBeGreaterThanOrEqual(0.03); // each button is 14% wide
    expect(0.5 * NEAR_FIELD_STRIP_WIDTH_M).toBeGreaterThanOrEqual(0.15); // scrub bar
  });

  it('maps presses to previous, play, next and scrub', () => {
    const { strip, actions } = makeStrip();
    expect(nearFieldTargetAt(0.07, 0.5)).toBe('prev');
    strip.onPointerClick(new THREE.Vector2(0.07, 0.5)); expect(actions.previousLandmark).toHaveBeenCalledOnce();
    strip.onPointerClick(new THREE.Vector2(0.22, 0.5)); expect(actions.togglePlay).toHaveBeenCalledOnce();
    strip.onPointerClick(new THREE.Vector2(0.37, 0.5)); expect(actions.nextLandmark).toHaveBeenCalledOnce();
    expect(strip.onPointerClick(new THREE.Vector2(0.145, 0.5))).toBe(false); // gap between buttons
    strip.onPointerClick(new THREE.Vector2(0.47, 0.5), 'hand');
    expect(actions.scrub).toHaveBeenLastCalledWith(0);
    strip.onPointerDrag(new THREE.Vector2(0.72, 0.5), 'other'); // another pointer cannot steal the scrub
    expect(actions.scrub).toHaveBeenCalledTimes(1);
    strip.onPointerDrag(new THREE.Vector2(0.72, 0.5), 'hand');
    expect(actions.scrub).toHaveBeenLastCalledWith(0.5);
    strip.onPointerRelease('hand');
    strip.onPointerDrag(new THREE.Vector2(0.97, 0.5), 'hand');
    expect(actions.scrub).toHaveBeenCalledTimes(2);
  });

  it('sits outside the plinth edge nearest the viewer at a fixed room size', () => {
    const { strip } = makeStrip();
    const root = new THREE.Group(); root.scale.setScalar(0.0005); // a 2 km plinth becomes 1 m
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(2000, 80, 2000)); root.add(plinth); root.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 0.5, 1.2); camera.updateMatrixWorld(true);
    strip.updatePlacement(camera, plinth, true);
    expect(strip.group.visible).toBe(true);
    expect(strip.group.position.z).toBeGreaterThan(0.5); // just past the +Z edge (0.5 m)
    expect(strip.group.position.z).toBeLessThan(0.6);
    expect(Math.abs(strip.group.position.x)).toBeLessThan(1e-6);
    expect(strip.group.getWorldScale(new THREE.Vector3()).x).toBeCloseTo(1); // not scaled with the model
    strip.updatePlacement(camera, plinth, false);
    expect(strip.group.visible).toBe(false);
  });

  it('round-trips strip-local points to UV and rejects points off the strip', () => {
    const { strip } = makeStrip();
    const out = new THREE.Vector2();
    expect(strip.localToUV(new THREE.Vector3(0, 0, 0), out)?.toArray()).toEqual([0.5, 0.5]);
    expect(strip.localToUV(new THREE.Vector3(NEAR_FIELD_STRIP_WIDTH_M, 0, 0), out)).toBeNull();
  });
});
