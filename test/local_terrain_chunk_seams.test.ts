import { expect, it } from 'vitest';
import * as THREE from 'three';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { localMetersToGeo } from '../src/gpx/Coordinates.ts';

const center = { lat: 46.855, lon: -121.755 };
const R = 6378137;

/** A raster whose elevation rises 0.3 m per Web-Mercator metre to the east. */
function slopedGrid(): ElevationGrid {
  const cx = center.lon * Math.PI * R / 180;
  const cy = R * Math.log(Math.tan(Math.PI / 4 + center.lat * Math.PI / 360));
  const half = 3000, width = 301, height = 301;
  const data = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) data[j * width + i] = 2000 + (i / (width - 1) * 2 * half - half) * 0.3;
  return { width, height, zoom: 0, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0, numTilesX: 1, numTilesY: 1,
    data, tileValidity: new Uint8Array(1).fill(1), minElevation: 1000, maxElevation: 3000, isRealDEM: true,
    rasterBounds: { west: cx - half, east: cx + half, south: cy - half, north: cy + half }, sampleSpacingMeters: 20 };
}

it('re-blends a worker-prepared chunk from raw heights so a shared edge keeps the real DEM, not the parent', () => {
  const grid = slopedGrid(), base = 1000, parent = 60;
  const options = { localGrid: grid, centerLat: center.lat, centerLon: center.lon, referenceCenterLat: center.lat,
    referenceCenterLon: center.lon, terrainBaseElevation: base, radiusMeters: 400, segments: 16,
    baseElevationSampler: () => parent, outerEdges: { west: true, east: true, north: true, south: true } };
  const built = new LocalTerrainChunk(options);
  const data = built.getBuildData();
  // The worker transfers these arrays; the main thread adopts them.
  const chunk = new LocalTerrainChunk({ ...options, preparedData: {
    ...data, positions: data.positions.slice(), normals: data.normals.slice(), uvs: data.uvs.slice(), indices: data.indices.slice(),
    heights: data.heights.slice(), rawHeights: data.rawHeights?.slice(), edgeRing: data.edgeRing?.slice() } });
  built.dispose();

  const pos = chunk.mesh.geometry.attributes.position as THREE.BufferAttribute;
  const eastEdge = Array.from({ length: 17 }, (_, row) => row * 17 + 16);
  expect(pos.getY(eastEdge[8])).toBeCloseTo(parent, 1); // outer edge blends to the parent first

  expect(chunk.setOuterEdges({ west: true, east: false, north: true, south: true })).toBe(true);
  for (const i of eastEdge.slice(3, 14)) { // away from the corners, which still blend north/south
    const geo = localMetersToGeo(chunk.mesh.position.x + pos.getX(i), chunk.mesh.position.z + pos.getZ(i), center.lat, center.lon);
    const raw = ElevationTileService.sampleElevation(grid, geo.lat, geo.lon).elevation - base;
    expect(Math.abs(pos.getY(i) - raw)).toBeLessThan(0.01);
  }

  // The shared-edge normal is two-sided: it matches the interior normal of this planar slope.
  const normals = chunk.mesh.geometry.attributes.normal as THREE.BufferAttribute;
  const edge = new THREE.Vector3().fromBufferAttribute(normals, eastEdge[8]);
  const interior = new THREE.Vector3().fromBufferAttribute(normals, eastEdge[8] - 4);
  expect(edge.angleTo(interior)).toBeLessThan(0.01);
  chunk.dispose();
});
