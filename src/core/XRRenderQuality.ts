import type { QualityProfileName } from '../terrain/QualityProfile.ts';

/** High preserves peripheral eye-buffer resolution. Balanced is an explicit
 * power-saving choice and retains Three.js's maximum-foveation policy.
 */
export function requestedXRFoveation(profile: QualityProfileName): number {
  return profile === 'quest-balanced' ? 1 : 0;
}

export interface XRRenderQualityCounters {
  xrRequestedFoveation: number;
  xrLayerFoveation: number | null;
  xrLayerFoveationSupported: boolean | null;
  xrFramebufferScaleRequested: number;
  xrLayerType: 'none' | 'projection' | 'webgl' | 'unknown';
  xrLayerWidth: number | null;
  xrLayerHeight: number | null;
  xrLayerArrayLength: number | null;
  xrEyeViewports: { width: number; height: number }[];
}

interface XRQualityReader {
  isPresenting: boolean;
  getBaseLayer?: () => unknown;
  getCamera?: () => { cameras: readonly unknown[] };
}
const dimension = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** Read the actual layer, never WebXRManager.getFoveation(): that getter returns
 * the library's cached request, even when a runtime ignores or clamps it.
 * Dimensions are diagnostics, not GPU timing or a guarantee of pixel clarity.
 */
export function readXRRenderQuality(xr: XRQualityReader, requested: number): XRRenderQualityCounters {
  const counters: XRRenderQualityCounters = { xrRequestedFoveation: requested,
    xrLayerFoveation: null, xrLayerFoveationSupported: null, xrFramebufferScaleRequested: 1,
    xrLayerType: xr.isPresenting ? 'unknown' : 'none', xrLayerWidth: null, xrLayerHeight: null,
    xrLayerArrayLength: null, xrEyeViewports: [] };
  if (!xr.isPresenting) return counters;
  try {
    const layer = xr.getBaseLayer?.() as Record<string, unknown> | null | undefined;
    if (layer) {
      const projection = 'textureWidth' in layer, webgl = 'framebufferWidth' in layer;
      counters.xrLayerType = projection ? 'projection' : webgl ? 'webgl' : 'unknown';
      counters.xrLayerWidth = dimension(projection ? layer.textureWidth : layer.framebufferWidth);
      counters.xrLayerHeight = dimension(projection ? layer.textureHeight : layer.framebufferHeight);
      counters.xrLayerArrayLength = projection ? dimension(layer.textureArrayLength) : null;
      const value = layer.fixedFoveation;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
        counters.xrLayerFoveationSupported = true; counters.xrLayerFoveation = value;
      } else if (value === undefined || value === null) counters.xrLayerFoveationSupported = false;
    }
  } catch { /* Detached/unavailable layer: leave its unsupported state unknown. */ }
  try {
    for (const eye of xr.getCamera?.().cameras.slice(0, 2) ?? []) {
      const viewport = (eye as { viewport?: { z?: number; w?: number } }).viewport;
      const width = dimension(viewport?.z), height = dimension(viewport?.w);
      if (width !== null && height !== null) counters.xrEyeViewports.push({ width, height });
    }
  } catch { /* The next valid XR frame can populate the eye dimensions. */ }
  return counters;
}
