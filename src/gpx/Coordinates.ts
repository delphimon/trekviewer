export const EARTH_RADIUS_METERS = 6371000;

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Calculates great-circle distance between two coordinates in meters (Haversine formula).
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const rLat1 = degToRad(lat1);
  const rLat2 = degToRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(rLat1) * Math.cos(rLat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculates the initial bearing from point 1 to point 2 in degrees (0 = North, 90 = East).
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = degToRad(lat1);
  const phi2 = degToRad(lat2);
  const deltaLambda = degToRad(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (radToDeg(theta) + 360) % 360;
}

/**
 * Converts geodetic lat/lon/ele to local scene metric coordinates (X = East, Y = Up, Z = South, so -Z = North)
 * centered at a reference geographic coordinate.
 */
export function geoToLocalMeters(
  lat: number,
  lon: number,
  ele: number,
  centerLat: number,
  centerLon: number,
  baseElevation: number = 0
): { x: number; y: number; z: number } {
  const latRad = degToRad(centerLat);
  // Easting: meters East of center
  const x = (lon - centerLon) * (Math.PI / 180) * EARTH_RADIUS_METERS * Math.cos(latRad);
  // Northing: In Three.js, +Z is towards camera (South), -Z is forward (North)
  const z = -(lat - centerLat) * (Math.PI / 180) * EARTH_RADIUS_METERS;
  // Elevation: meters relative to base
  const y = ele - baseElevation;

  return { x, y, z };
}

/**
 * Converts local scene coordinates back to geodetic lat/lon.
 */
export function localMetersToGeo(
  x: number,
  z: number,
  centerLat: number,
  centerLon: number
): { lat: number; lon: number } {
  const latRad = degToRad(centerLat);
  const lat = centerLat - (z / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const lon = centerLon + (x / (EARTH_RADIUS_METERS * Math.cos(latRad))) * (180 / Math.PI);
  return { lat, lon };
}

/**
 * Converts lat/lon to standard Web Mercator Slippy Map tile indices (x, y) at given zoom level.
 */
export function latLonToTile(
  lat: number,
  lon: number,
  zoom: number
): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = degToRad(lat);
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

/**
 * Converts tile coordinate back to north-west bounding box lat/lon.
 */
export function tileToLatLon(
  x: number,
  y: number,
  zoom: number
): { lat: number; lon: number } {
  const n = 2 ** zoom;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = radToDeg(latRad);
  return { lat, lon };
}
