/** Screen-relative scale bar: a round ground distance that fits in a pixel budget (V8). */
import { getUnits, type UnitSystem } from '../utils/Units.ts';

export interface ScaleBarSpec { px: number; label: string }

const FEET_PER_METRE = 3.28084;
const METRES_PER_MILE = 1609.344;

/** Largest 1-2-5 x 10^n value not above `value`. */
function niceBelow(value: number): number {
  const decade = 10 ** Math.floor(Math.log10(value));
  for (const m of [5, 2, 1]) if (m * decade <= value * (1 + 1e-9)) return m * decade;
  return decade;
}

const show = (v: number) => v >= 1 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toPrecision(1)));

/** Bar width in CSS pixels and its label for the ground resolution at the view centre. */
export function screenScaleBar(metresPerPixel: number, maxPx = 120, units: UnitSystem = getUnits()): ScaleBarSpec | null {
  if (!(metresPerPixel > 0) || !Number.isFinite(metresPerPixel) || !(maxPx > 0)) return null;
  const maxMetres = metresPerPixel * maxPx;
  if (units === 'imperial') {
    const feet = maxMetres * FEET_PER_METRE;
    if (feet < 5280) { const v = niceBelow(feet); return { px: v / FEET_PER_METRE / metresPerPixel, label: `${show(v)} ft` }; }
    const v = niceBelow(maxMetres / METRES_PER_MILE);
    return { px: v * METRES_PER_MILE / metresPerPixel, label: `${show(v)} mi` };
  }
  if (maxMetres < 1000) { const v = niceBelow(maxMetres); return { px: v / metresPerPixel, label: `${show(v)} m` }; }
  const v = niceBelow(maxMetres / 1000);
  return { px: v * 1000 / metresPerPixel, label: `${show(v)} km` };
}

/** Ground metres per CSS pixel at a perspective camera's orbit target. */
export function metresPerPixelAt(targetDistance: number, fovDegrees: number, viewportHeight: number, modelScale: number): number {
  if (!(viewportHeight > 0) || !(modelScale > 0)) return NaN;
  return 2 * targetDistance * Math.tan(fovDegrees * Math.PI / 360) / viewportHeight / modelScale;
}
