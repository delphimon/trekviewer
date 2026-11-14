import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_COMFORT, readComfortPreferences, stepFadeOpacity, STEP_FADE_MS } from '../src/xr/ComfortPreferences.ts';

afterEach(() => vi.unstubAllGlobals());
const storage = (value?: object) => vi.stubGlobal('localStorage', { getItem: () => value ? JSON.stringify(value) : null, setItem: () => {} });

it('defaults to step movement but keeps a saved walk preference', () => {
  expect(DEFAULT_COMFORT.movement).toBe('step');
  storage(); expect(readComfortPreferences().movement).toBe('step');
  storage({ movement: 'walk' }); expect(readComfortPreferences().movement).toBe('walk');
  storage({ movement: 'step', turning: 'smooth' }); expect(readComfortPreferences()).toMatchObject({ movement: 'step', turning: 'smooth' });
});

it('fades each step through black over 150 ms', () => {
  expect(STEP_FADE_MS).toBe(150);
  expect(stepFadeOpacity(0)).toBe(0);
  expect(stepFadeOpacity(75)).toBe(1);
  expect(stepFadeOpacity(37.5)).toBeCloseTo(0.5);
  expect(stepFadeOpacity(112.5)).toBeCloseTo(0.5);
  expect(stepFadeOpacity(150)).toBe(0);
});
