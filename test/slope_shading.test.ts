import { expect, it } from 'vitest';
import * as THREE from 'three';
import { trueSlopeDegrees, slopeBand, SLOPE_BANDS } from '../src/terrain/TerrainImageryMaterial.ts';

/** Model-space normal of a plane rising `slopeDeg` to the east, drawn with exaggeration `e`. */
function normal(slopeDeg: number, e: number) {
  const gradient = Math.tan(slopeDeg * Math.PI / 180) * e;
  return new THREE.Vector3(-gradient, 1, 0).normalize();
}

it('recovers the true slope from an exaggerated surface normal', () => {
  for (const e of [1, 1.5, 3]) for (const slope of [10, 28, 33, 40, 50]) {
    expect(trueSlopeDegrees(normal(slope, e), e)).toBeCloseTo(slope, 6);
  }
});

it('uses the avalanche bands: none below 27, then yellow, orange, red and purple', () => {
  expect(slopeBand(26.9)).toBeNull();
  expect([27, 29.9, 30, 34.9, 35, 44.9, 45, 60].map(a => slopeBand(a)!.label))
    .toEqual(['27-30°', '27-30°', '30-35°', '30-35°', '35-45°', '35-45°', '45°+', '45°+']);
  expect(SLOPE_BANDS.map(b => b.css)).toEqual(['#facc15', '#f97316', '#ef4444', '#a855f7']);
});
