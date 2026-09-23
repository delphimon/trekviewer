import { describe, it } from 'vitest';
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

describe('Coordinates & Geodesy', () => {
  const centerLat = 46.8529;
  const centerLon = -121.7604;
  const baseEle = 1400;

  const schurmanLat = 46.8833;
  const schurmanLon = -121.7333;
  const schurmanEle = 2900;

  it('haversine distance', () => {
    // 1. Haversine distance test
    // Distance between Mt Rainier summit (46.8529, -121.7604) and Seattle (47.6062, -122.3321) is approx 94.7 km
    const dRainierSeattle = haversineDistance(46.8529, -121.7604, 47.6062, -122.3321);
    assert(dRainierSeattle > 93000 && dRainierSeattle < 96000, 'Haversine distance within expected range');
  });

  it('local 3D projection and roundtrip conversion', () => {
    const local3D = geoToLocalMeters(schurmanLat, schurmanLon, schurmanEle, centerLat, centerLon, baseEle);

    assert(local3D.y === schurmanEle - baseEle, 'Elevation relative to base is exact');
    assert(local3D.z < 0, 'Camp Schurman is North of summit, so Z should be negative in Three.js');
    assert(local3D.x > 0, 'Camp Schurman is East of summit, so X should be positive in Three.js');

    // Invert back to geo
    const roundtripGeo = localMetersToGeo(local3D.x, local3D.z, centerLat, centerLon);
    const latErr = Math.abs(roundtripGeo.lat - schurmanLat);
    const lonErr = Math.abs(roundtripGeo.lon - schurmanLon);
    assert(latErr < 1e-6 && lonErr < 1e-6, 'Sub-centimeter roundtrip conversion precision');
  });

  it('tile coordinate conversion', () => {
    // 3. Tile coordinate conversion
    const tile = latLonToTile(schurmanLat, schurmanLon, 12);
    assert(tile.x > 0 && tile.y > 0, 'Valid tile indices');

    const tileGeo = tileToLatLon(tile.x, tile.y, 12);
    assert(tileGeo.lat > schurmanLat && tileGeo.lon < schurmanLon, 'Tile top-left contains target coordinate');
  });
});
