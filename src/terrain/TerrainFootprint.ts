import { geoToLocalMeters } from '../gpx/Coordinates.ts';
import type { GeoBounds } from '../gpx/TrackTypes.ts';

/** Clearance kept between the route's highest point and every terrain edge. */
export const HIGH_POINT_EDGE_CLEARANCE_M = 2500;
const MIN_SIZE_M = 1500;
const ROUND_M = 250;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const MIN_DEM_ZOOM = 10;

/** Widest terrain side whose base DEM still fits the 25-tile (5 x 5) Terrarium budget at
 * the coarsest zoom: any span of 4 tiles fits in 5 however it is aligned, and the DEM
 * request adds 5% on each side. */
export function terrainSizeCapMeters(centerLat: number): number {
  const tileM = EARTH_CIRCUMFERENCE_M * Math.cos(centerLat * Math.PI / 180) / 2 ** MIN_DEM_ZOOM;
  return Math.floor((4 * tileM) / 1.1);
}

/**
 * Terrain block size around a route, centred on the route bounds. Each side is the largest
 * of: the route extent x 1.5, the extent plus 2 km each side, and the size that keeps the
 * route's highest point 2.5 km from every edge; rounded up to 250 m (so tiny elevation
 * differences between parses never change it) and capped by the DEM tile budget.
 * Terrain, plinth, XR grab footprint and offline packs all use this one rule.
 */
export function terrainFootprint(bounds: GeoBounds): { widthMeters: number; depthMeters: number } {
  let width = Math.max(bounds.widthMeters * 1.5, bounds.widthMeters + 4000, MIN_SIZE_M);
  let depth = Math.max(bounds.depthMeters * 1.5, bounds.depthMeters + 4000, MIN_SIZE_M);
  if (bounds.highPoint) {
    const p = geoToLocalMeters(bounds.highPoint.lat, bounds.highPoint.lon, 0, bounds.centerLat, bounds.centerLon, 0);
    width = Math.max(width, 2 * (Math.abs(p.x) + HIGH_POINT_EDGE_CLEARANCE_M));
    depth = Math.max(depth, 2 * (Math.abs(p.z) + HIGH_POINT_EDGE_CLEARANCE_M));
  }
  const cap = terrainSizeCapMeters(bounds.centerLat);
  const round = (size: number) => Math.min(Math.ceil(size / ROUND_M) * ROUND_M, cap);
  return { widthMeters: round(width), depthMeters: round(depth) };
}
