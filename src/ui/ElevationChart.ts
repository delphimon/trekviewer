/** Pure helpers for the desktop elevation chart (sizing, axes, hover readout). */

export interface ChartSample { distance: number; elevation: number }

/** Canvas backing-store size for a CSS box at a device pixel ratio (at least 1 x 1). */
export function chartBackingSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width: Math.max(1, Math.round(cssWidth * ratio)), height: Math.max(1, Math.round(cssHeight * ratio)) };
}

/** Elevation (interpolated) and grade (from the neighbouring samples, in %) at a distance. */
export function chartReadout(samples: readonly ChartSample[], distance: number): { elevation: number; grade: number } | null {
  if (samples.length < 2) return null;
  const last = samples.length - 1;
  const d = Math.min(Math.max(distance, samples[0].distance), samples[last].distance);
  let i = 0;
  while (i < last - 1 && samples[i + 1].distance < d) i++;
  const a = samples[i], b = samples[i + 1];
  const span = b.distance - a.distance;
  const t = span > 0 ? (d - a.distance) / span : 0;
  const elevation = a.elevation + (b.elevation - a.elevation) * t;
  const lo = samples[Math.max(0, i - 1)], hi = samples[Math.min(last, i + 2)];
  const run = hi.distance - lo.distance;
  const grade = run > 0 ? (hi.elevation - lo.elevation) / run * 100 : 0;
  return { elevation, grade };
}

/** Evenly spaced 1-2-5 x 10^n distance ticks (in display units) with at most `maxTicks` inside the route. */
export function distanceTicks(totalUnits: number, maxTicks = 6): number[] {
  if (!(totalUnits > 0)) return [];
  const raw = totalUnits / maxTicks;
  const decade = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * decade).find(s => s >= raw) ?? 10 * decade;
  const ticks: number[] = [];
  for (let v = step; v < totalUnits - step * 0.25; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}
