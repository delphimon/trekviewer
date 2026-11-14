import { expect, it } from 'vitest';
import { scaleBarLengthMeters } from '../src/visualization/DioramaBase.ts';

it('picks a 1-2-5 x 10^n bar between 8% and 25% of the plinth width', () => {
  for (const width of [1540, 5040, 9040, 14290, 27540, 97000]) {
    const bar = scaleBarLengthMeters(width);
    expect(bar / width).toBeGreaterThanOrEqual(0.08);
    expect(bar / width).toBeLessThanOrEqual(0.25);
    expect(bar / 10 ** Math.floor(Math.log10(bar))).toSatisfy((m: number) => [1, 2, 5].includes(m));
  }
  expect(scaleBarLengthMeters(14290)).toBe(2000);
  expect(scaleBarLengthMeters(1540)).toBe(200);
});
