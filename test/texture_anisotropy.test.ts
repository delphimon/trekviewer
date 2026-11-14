import { expect, it } from 'vitest';
import { anisotropyForProfile } from '../src/core/SceneManager.ts';

it('clamps texture anisotropy to 4 on Quest profiles and 8 on desktop', () => {
  expect(anisotropyForProfile('quest-high', 16)).toBe(4);
  expect(anisotropyForProfile('quest-balanced', 16)).toBe(4);
  expect(anisotropyForProfile('desktop-high', 16)).toBe(8);
  expect(anisotropyForProfile('desktop-high', 2)).toBe(2);
  expect(anisotropyForProfile('quest-high', 0)).toBe(1);
});

it('renders XR at 1.2x on Quest High only', async () => {
  const { framebufferScaleForProfile } = await import('../src/core/SceneManager.ts');
  expect(framebufferScaleForProfile('quest-high')).toBe(1.2);
  expect(framebufferScaleForProfile('quest-balanced')).toBe(1);
  expect(framebufferScaleForProfile('desktop-high')).toBe(1);
});
