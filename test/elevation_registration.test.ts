import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { elevationRasterRequest } from '../src/terrain/BestAvailableElevation.ts';

it('preserves the live service sample-centre footprint for a non-square Olympus raster', () => {
  const capture = JSON.parse(readFileSync('docs/review-2026-10-19/dem-registration/registration.json', 'utf8'));
  const request = elevationRasterRequest(capture.bounds, 5);
  expect(request).toEqual(capture.request);
  expect(new URL(request.url).searchParams.get('adjustAspectRatio')).toBe('false');
  expect(request.width).toBe(1024); expect(request.height).toBe(675);
  const corrected = capture.results.find((r: { mode: string }) => r.mode === 'preserve-footprint');
  const previous = capture.results.find((r: { mode: string }) => r.mode === 'previous-default');
  // Recorded service extents are independent of the application's request math.
  for (const side of ['west', 'east', 'north', 'south'] as const) {
    expect(corrected.actualCentres[side]).toBeCloseTo(request.rasterBounds[side], 8);
  }
  expect(corrected.maxErrorGroundM).toBeLessThan(1e-6);
  expect(previous.maxErrorGroundM).toBeGreaterThan(8);
  expect(capture.raster.maxZerror).toBe(0);
});
