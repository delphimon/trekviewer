import type { GeoBounds } from '../src/gpx/TrackTypes.ts';
import { localMetersToGeo, geoToLocalMeters } from '../src/gpx/Coordinates.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';

console.log('--- Testing Satellite & DEM UV Orthorectification Alignment ---');

// Test Case: Mount Rainier (center approx 46.8528, -121.7604)
const centerLat = 46.852886;
const centerLon = -121.760374;
const widthM = 15000;
const depthM = 15000;

const nwGeo = localMetersToGeo(-widthM / 2, -depthM / 2, centerLat, centerLon);
const seGeo = localMetersToGeo(widthM / 2, depthM / 2, centerLat, centerLon);

const bounds: GeoBounds = {
  minLat: Math.min(nwGeo.lat, seGeo.lat),
  maxLat: Math.max(nwGeo.lat, seGeo.lat),
  minLon: Math.min(nwGeo.lon, seGeo.lon),
  maxLon: Math.max(nwGeo.lon, seGeo.lon),
  centerLat,
  centerLon,
  minEle: 1300,
  maxEle: 4392,
  widthMeters: widthM,
  depthMeters: depthM,
  elevationSpan: 3092,
};

const tileGrid = TextureProvider.getTileGridForBounds(bounds, 0.05);

console.log('Tile Grid Bounds at Zoom', tileGrid.zoom, ':', {
  tileXMin: tileGrid.tileXMin,
  tileXMax: tileGrid.tileXMax,
  tileYMin: tileGrid.tileYMin,
  tileYMax: tileGrid.tileYMax,
  numTilesX: tileGrid.numTilesX,
  numTilesY: tileGrid.numTilesY,
  totalTiles: tileGrid.numTilesX * tileGrid.numTilesY,
});

if (tileGrid.numTilesX <= 0 || tileGrid.numTilesY <= 0) {
  throw new Error('Invalid tile dimensions');
}

// Check UV for NW corner
const uvNW = TextureProvider.getUVForGeo(nwGeo.lat, nwGeo.lon, tileGrid);
console.log('NW Corner UV (should be small u, large v near top):', uvNW);
if (uvNW.u < 0 || uvNW.u > 0.5 || uvNW.v < 0.5 || uvNW.v > 1) {
  throw new Error(`NW Corner UV unexpected: ${JSON.stringify(uvNW)}`);
}

// Check UV for SE corner
const uvSE = TextureProvider.getUVForGeo(seGeo.lat, seGeo.lon, tileGrid);
console.log('SE Corner UV (should be large u, small v near bottom):', uvSE);
if (uvSE.u < 0.5 || uvSE.u > 1 || uvSE.v < 0 || uvSE.v > 0.5) {
  throw new Error(`SE Corner UV unexpected: ${JSON.stringify(uvSE)}`);
}

// Check UV for center
const uvCenter = TextureProvider.getUVForGeo(centerLat, centerLon, tileGrid);
console.log('Center UV (should be near 0.5, 0.5):', uvCenter);
if (Math.abs(uvCenter.u - 0.5) > 0.2 || Math.abs(uvCenter.v - 0.5) > 0.2) {
  throw new Error(`Center UV not near center: ${JSON.stringify(uvCenter)}`);
}

// Check Summit (Mount Rainier: 46.852886, -121.760374)
const summitLoc = geoToLocalMeters(46.852886, -121.760374, 4392, centerLat, centerLon, 1300);
const summitGeo = localMetersToGeo(summitLoc.x, summitLoc.z, centerLat, centerLon);
const summitUV = TextureProvider.getUVForGeo(summitGeo.lat, summitGeo.lon, tileGrid);
console.log('Summit UV:', summitUV);
if (Math.abs(summitUV.u - uvCenter.u) > 0.001 || Math.abs(summitUV.v - uvCenter.v) > 0.001) {
  throw new Error('Summit and center UV mismatch');
}

console.log('✓ All UV orthorectification alignment tests passed!');
