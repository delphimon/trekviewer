import { expect, it } from 'vitest';
import { chartBackingSize, chartReadout, distanceTicks } from '../src/ui/ElevationChart.ts';

it('sizes the backing store to CSS size times device pixel ratio', () => {
  expect(chartBackingSize(1000, 96, 2)).toEqual({ width: 2000, height: 192 });
  expect(chartBackingSize(333.4, 72, 1.5)).toEqual({ width: 500, height: 108 });
  expect(chartBackingSize(0, 0, NaN)).toEqual({ width: 1, height: 1 });
});

it('reads elevation and neighbouring-sample grade under the pointer', () => {
  const samples = [0, 100, 200, 300, 400].map((distance, i) => ({ distance, elevation: [1000, 1010, 1030, 1030, 1000][i] }));
  expect(chartReadout(samples, 150)!.elevation).toBeCloseTo(1020);
  expect(chartReadout(samples, 150)!.grade).toBeCloseTo((1030 - 1000) / 300 * 100); // samples 0..3
  expect(chartReadout(samples, 390)!.grade).toBeLessThan(0);
  expect(chartReadout(samples, -50)!.elevation).toBe(1000);
  expect(chartReadout([{ distance: 0, elevation: 1 }], 0)).toBeNull();
});

it('places round distance ticks inside the route', () => {
  expect(distanceTicks(17.1)).toEqual([5, 10, 15]);
  expect(distanceTicks(3.2)).toEqual([1, 2]); // 3 sits too close to the end label
  expect(distanceTicks(0)).toEqual([]);
});
