import { clampLatitude, degToRad, EARTH_RADIUS_METERS, tileBounds } from '../gpx/Coordinates.ts';

/** Exact existing projection, with invariant longitude scale and row latitude
 * work shared by vertices of one patch. The cache lives only for this build. */
export function createTileUVMapper(zoom: number, x: number, y: number, centerLat: number, centerLon: number): (localX: number, localZ: number) => { u: number; v: number } {
  const bounds = tileBounds(x, y, zoom);
  const longitudeScale = EARTH_RADIUS_METERS * Math.cos(degToRad(centerLat));
  const longitudeSpan = bounds.se.lon - bounds.nw.lon;
  const n = 2 ** zoom;
  const rows = new Map<number, number>();
  return (localX, localZ) => {
    const lon = centerLon + (localX / longitudeScale) * (180 / Math.PI);
    let v = rows.get(localZ);
    if (v === undefined) {
      const lat = centerLat - (localZ / EARTH_RADIUS_METERS) * (180 / Math.PI);
      const sin = Math.sin(degToRad(clampLatitude(lat)));
      const tileY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n;
      v = 1 - (tileY - y);
      if (rows.size >= 4096) rows.delete(rows.keys().next().value!);
      rows.set(localZ, v);
    }
    return { u: (lon - bounds.nw.lon) / longitudeSpan, v };
  };
}
