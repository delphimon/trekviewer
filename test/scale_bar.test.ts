import { describe, expect, it } from 'vitest';
import { metresPerPixelAt, screenScaleBar } from '../src/ui/ScaleBar.ts';

describe('screenScaleBar', () => {
  it('picks the largest round metric length within the pixel budget', () => {
    expect(screenScaleBar(10, 120, 'metric')).toEqual({ px: 100, label: '1 km' }); // 1200 m budget
    expect(screenScaleBar(1, 120, 'metric')).toEqual({ px: 100, label: '100 m' });
    const near = screenScaleBar(0.04, 120, 'metric')!; // 4.8 m budget
    expect(near.label).toBe('2 m'); expect(near.px).toBeCloseTo(50);
    expect(screenScaleBar(300, 120, 'metric')!.label).toBe('20 km');
  });
  it('shrinks with zoom so the bar always stays within the budget', () => {
    for (const mpp of [0.01, 0.3, 7, 55, 900]) {
      const bar = screenScaleBar(mpp, 120, 'metric')!;
      expect(bar.px).toBeLessThanOrEqual(120.001); expect(bar.px).toBeGreaterThan(120 / 5 - 0.001);
    }
  });
  it('uses feet then miles in imperial', () => {
    expect(screenScaleBar(1, 120, 'imperial')!.label).toBe('200 ft');
    const miles = screenScaleBar(100, 120, 'imperial')!; // 7.46 mi budget
    expect(miles.label).toBe('5 mi'); expect(miles.px).toBeCloseTo(80.47, 1);
  });
  it('returns null for unusable input', () => {
    expect(screenScaleBar(0)).toBeNull(); expect(screenScaleBar(NaN)).toBeNull(); expect(screenScaleBar(Infinity)).toBeNull();
  });
});

describe('metresPerPixelAt', () => {
  it('converts orbit distance and model scale to ground metres per pixel', () => {
    // 90° vertical FOV: view height at distance d is 2d; model scaled to 1/1000.
    expect(metresPerPixelAt(1, 90, 1000, 0.001)).toBeCloseTo(2);
    expect(metresPerPixelAt(1, 90, 0, 1)).toBeNaN();
  });
});
