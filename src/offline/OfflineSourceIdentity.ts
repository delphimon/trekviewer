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
