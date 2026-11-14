import { afterEach, expect, it, vi } from 'vitest';
import { defaultUnits, formatDistance, formatElevation, formatSpeed, distanceInUnits, getUnits, setUnits, onUnitsChange, UNITS_STORAGE_KEY } from '../src/utils/Units.ts';

afterEach(() => vi.unstubAllGlobals());

it('defaults to imperial only for US English', () => {
  expect(defaultUnits('en-US')).toBe('imperial');
  expect(defaultUnits('en-GB')).toBe('metric');
  expect(defaultUnits('de-CH')).toBe('metric');
  expect(defaultUnits('')).toBe('metric');
});

it('formats distance, elevation and speed in both systems', () => {
  expect(formatDistance(27_500, 'imperial')).toBe('17.1 mi');
  expect(formatDistance(27_500, 'metric')).toBe('27.5 km');
  expect(formatElevation(4391, 'imperial')).toBe('14,406 ft');
  expect(formatElevation(4391, 'metric')).toBe('4,391 m');
  expect(formatElevation(3200, 'metric', true)).toBe('+3,200 m');
  expect(formatSpeed(1.25, 'imperial')).toBe('2.8 mph');
  expect(formatSpeed(1.25, 'metric')).toBe('4.5 km/h');
  expect(distanceInUnits(1609.344, 'imperial')).toBeCloseTo(1, 4);
});

it('stores the choice under trekviewer.units and notifies listeners', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  const seen: string[] = [];
  const off = onUnitsChange(units => seen.push(units));
  const next = getUnits() === 'metric' ? 'imperial' : 'metric';
  setUnits(next);
  expect(store.get(UNITS_STORAGE_KEY)).toBe(next);
  expect(seen).toEqual([next]);
  off();
});
