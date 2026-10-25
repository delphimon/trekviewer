/** CPU math libraries can differ by a final ULP in Mercator log/tan results.
 * Normalize ONLY archive/source identity to millimetres, never the request URL,
 * raster, source precision or renderer. Other parameters must match exactly. */
export function offlineSourceIdentity(url: string): string {
  const u = new URL(url);
  if (u.origin !== 'https://elevation.nationalmap.gov' || u.pathname !== '/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
    || u.searchParams.get('bboxSR') !== '3857' || u.searchParams.get('imageSR') !== '3857') return url;
  const values = u.searchParams.get('bbox')?.split(',').map(Number);
  if (values?.length !== 4 || values.some(v => !Number.isFinite(v) || Math.abs(v) > 3e7)) return url;
  u.searchParams.set('bbox', values.map(v => v.toFixed(3)).join(','));
  return u.href;
}
export const sameOfflineSource = (source: string, aliases: string[]) => aliases.includes(source)
  || aliases.some(alias => offlineSourceIdentity(alias) === offlineSourceIdentity(source));

/**
 * Service-independent geographic + resolution index key for offline elevation and imagery exports.
 * Normalizes EPSG:3857 bounding boxes to millimeter precision (toFixed(3)) and EPSG:4326 to 1e-7 deg.
 */
export function offlineGeographicKey(url: string): string | null {
  try {
    const u = new URL(url);
    const isElevation = u.hostname === 'elevation.nationalmap.gov'
      && u.pathname === '/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
    const isImagery = (u.hostname === 'imagery.nationalmap.gov' && /^\/arcgis\/rest\/services\/USGSNAIP(?:Plus|Imagery)\/ImageServer\/exportImage$/.test(u.pathname))
      || (u.hostname === 'imagery.geoplatform.gov' && u.pathname === '/iipp/rest/services/NAIP/NAIP_plus/ImageServer/exportImage')
      || (u.hostname === 'basemap.nationalmap.gov' && u.pathname === '/arcgis/rest/services/USGSImageryOnly/MapServer/export');
    if (!isElevation && !isImagery) return null;
    const values = u.searchParams.get('bbox')?.split(',').map(Number);
    const size = u.searchParams.get('size');
    const bboxSR = u.searchParams.get('bboxSR') ?? '3857';
    if (!size || values?.length !== 4 || values.some(v => !Number.isFinite(v) || Math.abs(v) > 3e7)) return null;
    const decimals = bboxSR === '3857' ? 3 : 7;
    const normBbox = values.map(v => v.toFixed(decimals)).join(',');
    return `geo:${isElevation ? 'elevation' : 'image'}:${bboxSR}:${normBbox}:${size}`;
  } catch {
    return null;
  }
}
