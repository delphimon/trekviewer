import {
  haversineDistance,
  calculateBearing,
  geoToLocalMeters,
  localMetersToGeo,
  latLonToTile,
  tileToLatLon,
} from '../src/gpx/Coordinates.ts';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

console.log('--- Testing Coordinates & Geodesy ---');

// 1. Haversine distance test
// Distance between Mt Rainier summit (46.8529, -121.7604) and Seattle (47.6062, -122.3321) is approx 94.7 km
const dRainierSeattle = haversineDistance(46.8529, -121.7604, 47.6062, -122.3321);
console.log(`Distance Rainier to Seattle: ${(dRainierSeattle / 1000).toFixed(2)} km`);
assert(dRainierSeattle > 93000 && dRainierSeattle < 96000, 'Haversine distance within expected range');

// 2. Local 3D projection and roundtrip conversion
const centerLat = 46.8529;
const centerLon = -121.7604;
const baseEle = 1400;

// Test point: Camp Schurman (46.8833, -121.7333, 2900m)
const schurmanLat = 46.8833;
const schurmanLon = -121.7333;
const schurmanEle = 2900;

const local3D = geoToLocalMeters(schurmanLat, schurmanLon, schurmanEle, centerLat, centerLon, baseEle);
console.log('Camp Schurman local 3D (meters):', {
  x: local3D.x.toFixed(1),
  y: local3D.y.toFixed(1),
  z: local3D.z.toFixed(1),
});

assert(local3D.y === schurmanEle - baseEle, 'Elevation relative to base is exact');
assert(local3D.z < 0, 'Camp Schurman is North of summit, so Z should be negative in Three.js');
assert(local3D.x > 0, 'Camp Schurman is East of summit, so X should be positive in Three.js');

// Invert back to geo
const roundtripGeo = localMetersToGeo(local3D.x, local3D.z, centerLat, centerLon);
const latErr = Math.abs(roundtripGeo.lat - schurmanLat);
const lonErr = Math.abs(roundtripGeo.lon - schurmanLon);
console.log(`Roundtrip error: lat ${latErr.toExponential(4)}, lon ${lonErr.toExponential(4)}`);
assert(latErr < 1e-6 && lonErr < 1e-6, 'Sub-centimeter roundtrip conversion precision');

// 3. Tile coordinate conversion
const tile = latLonToTile(schurmanLat, schurmanLon, 12);
console.log('Tile coordinates at zoom 12:', tile);
assert(tile.x > 0 && tile.y > 0, 'Valid tile indices');

const tileGeo = tileToLatLon(tile.x, tile.y, 12);
console.log('Tile top-left geo:', tileGeo);
assert(tileGeo.lat > schurmanLat && tileGeo.lon < schurmanLon, 'Tile top-left contains target coordinate');

console.log('✓ All coordinate & geodesy tests passed!\n');
