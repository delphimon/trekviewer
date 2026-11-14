import { expect, it } from 'vitest';
import { hudFont, HUD_MIN_FONT_PX, HUD_CANVAS_SCALE, HUD_LAYOUT_WIDTH } from '../src/ui/SpatialHUD.ts';

it('raises small HUD text to the minimum size and leaves larger text alone', () => {
  expect(HUD_MIN_FONT_PX).toBe(18);
  expect(hudFont('12px sans-serif')).toBe('18px sans-serif');
  expect(hudFont('bold 15px sans-serif')).toBe('bold 18px sans-serif');
  expect(hudFont('600 16px -apple-system')).toBe('600 18px -apple-system');
  expect(hudFont('bold 23px sans-serif')).toBe('bold 23px sans-serif');
});

it('renders the 1024-unit layout at twice the resolution', () => {
  expect(HUD_LAYOUT_WIDTH * HUD_CANVAS_SCALE).toBe(2048);
});
