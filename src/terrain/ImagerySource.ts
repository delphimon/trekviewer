/** Service provenance only: neither catalog dataset identity nor native resolution. */
export type ImagerySourceId = 'usgs-naip-plus' | 'geoplatform-naip' | 'usgs-naip'
  | 'usgs-overview' | 'eox-global' | 'other';
export interface ImagerySourceInfo { source: ImagerySourceId; configuredAlternative: boolean }
const images = new WeakMap<object, Readonly<ImagerySourceInfo>>();

export function imagerySourceId(url: string): ImagerySourceId {
  try {
    const parsed = new URL(url);
    const service = parsed.pathname.toLowerCase();
    if (parsed.hostname === 'imagery.nationalmap.gov') {
      if (service.startsWith('/arcgis/rest/services/usgsnaipplus/imageserver/')) return 'usgs-naip-plus';
      if (service.startsWith('/arcgis/rest/services/usgsnaipimagery/imageserver/')) return 'usgs-naip';
    }
    if (parsed.hostname === 'imagery.geoplatform.gov' && service.startsWith('/iipp/rest/services/naip/naip_plus/imageserver/')) return 'geoplatform-naip';
    if (parsed.hostname === 'basemap.nationalmap.gov' && service.startsWith('/arcgis/rest/services/usgsimageryonly/mapserver/')) return 'usgs-overview';
    if (parsed.hostname === 'tiles.maps.eox.at' && service.startsWith('/wmts/1.0.0/s2cloudless-2025_3857/')) return 'eox-global';
  } catch { /* Unknown or non-URL sources remain explicitly unclassified. */ }
  return 'other';
}

export function recordImagerySource(image: object, url: string, configuredFirstURL: string): void {
  // Keep fixed labels only; URLs may contain optional-provider credentials.
  images.set(image, Object.freeze({ source: imagerySourceId(url), configuredAlternative: url !== configuredFirstURL }));
}
export function getImagerySource(image: unknown): Readonly<ImagerySourceInfo> | undefined {
  return image !== null && typeof image === 'object' ? images.get(image) : undefined;
}
export function copyImagerySource(from: object, to: object): void {
  const info = images.get(from);
  if (info) images.set(to, info);
}
