import { latLonToTile, tileBounds } from '../gpx/Coordinates.ts';
import type { GeoBounds } from '../gpx/TrackTypes.ts';

export interface DetailFocus { lat: number; lon: number; }
export interface DetailTile { x: number; y: number; zoom: number; dist: number; isHighRes: boolean; }

/** Broad, concentric coverage with complete sibling groups around overscanned view hits.
 * The near neighborhood stays sharp through head turns; view samples extend it to
 * distant slopes without sacrificing the terrain above/below the central hit.
 */
export function computeBroadDetailTiles(
  center: DetailFocus, zoom: number, maxTiles: number, bounds: GeoBounds,
  viewPoints: readonly DetailFocus[] = [],
): DetailTile[] {
  const outerZoom = Math.max(13, zoom - 2);
  const centerTile = latLonToTile(center.lat, center.lon, outerZoom);
  const selected = new Map<string, DetailTile>();
  const intersects = (x: number, y: number, z: number) => {
    const b = tileBounds(x, y, z);
    return b.nw.lat >= bounds.minLat && b.se.lat <= bounds.maxLat && b.se.lon >= bounds.minLon && b.nw.lon <= bounds.maxLon;
  };
  const add = (target: Map<string, DetailTile>, x: number, y: number, z: number, priority: number) => {
    if (intersects(x, y, z)) target.set(`${z}:${x}:${y}`, { x, y, zoom: z, dist: priority, isHighRes: z === zoom });
  };
  // Transactional promotion retains every required sibling and ancestor. Never
  // truncate a fine block to meet the budget, which would expose coarse holes.
  const promote = (x: number, y: number, z: number, priority: number): void => {
    const additions = new Map<string, DetailTile>();
    const ensure = (tx: number, ty: number, level: number) => {
      if (level > outerZoom) ensure(Math.floor(tx / 2), Math.floor(ty / 2), level - 1);
      if (level === outerZoom) add(additions, tx, ty, level, priority + 6);
      else {
        const px = Math.floor(tx / 2), py = Math.floor(ty / 2);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) add(additions, px * 2 + dx, py * 2 + dy, level, priority + zoom - level);
      }
    };
    ensure(x, y, z);
    let extra = 0;
    for (const key of additions.keys()) if (!selected.has(key)) extra++;
    if (selected.size + extra > maxTiles) return;
    for (const [key, tile] of additions) {
      const existing = selected.get(key);
      if (!existing || tile.dist < existing.dist) selected.set(key, tile);
    }
  };
  const offsets = (radius: number) => {
    const result: { x: number; y: number }[] = [];
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) result.push({ x, y });
    return result.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  };
  for (const o of offsets(3)) {
    if (selected.size >= maxTiles) break;
    add(selected, centerTile.x + o.x, centerTile.y + o.y, outerZoom, Math.hypot(o.x, o.y) + 6);
  }
  if (zoom > outerZoom) for (const o of offsets(2)) {
    promote((centerTile.x + o.x) * 2, (centerTile.y + o.y) * 2, outerZoom + 1, 2 + Math.hypot(o.x, o.y));
  }
  if (zoom > outerZoom + 1) for (const o of offsets(1)) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      promote((centerTile.x + o.x) * 4 + dx * 2, (centerTile.y + o.y) * 4 + dy * 2, zoom, Math.hypot(o.x, o.y));
    }
  }
  // Guard each view hit by a 2x2 block of fine parents, in addition to the
  // already broad all-direction core. Terrain just outside the FOV stays sharp.
  const viewTiles = viewPoints.map(point => latLonToTile(point.lat, point.lon, zoom));
  // Cover every sampled slope before spending spare capacity on guard bands.
  // Current center-out view samples precede retained history. Give their
  // complete sibling groups priority over the background neighborhood, even
  // when those tiles were already selected by the concentric core above.
  for (let i = 0; i < viewTiles.length; i++) {
    const fine = viewTiles[i];
    promote(fine.x, fine.y, zoom, -2 + i / viewTiles.length);
  }
  for (const fine of viewTiles) {
    const px = Math.floor(fine.x / 2), py = Math.floor(fine.y / 2);
    const startX = fine.x % 2 ? px : px - 1, startY = fine.y % 2 ? py : py - 1;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) promote((startX + dx) * 2, (startY + dy) * 2, zoom, 1);
  }
  return [...selected.values()];
}
