import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildPromotedSurfacePatches, createPromotedPatchGeometry, snapshotSurfaceMesh } from '../src/terrain/SurfacePromotion.ts';
import { buildSurfacePatchGeometry } from '../src/terrain/SurfacePatchGeometry.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { clampLatitude, degToRad, geoToLocalMeters, latLonToTile, localMetersToGeo, tileBounds } from '../src/gpx/Coordinates.ts';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const group = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(1600, 1600, 16, 16); geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) positions.setY(i, 100);
  geometry.computeVertexNormals();
  const base = new THREE.Mesh(geometry); group.add(base);
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ elevation: 200, isValid: true });
  const chunk = new LocalTerrainChunk({ localGrid: { zoom: 15, isRealDEM: true } as any, centerLat: 46, centerLon: -120,
    terrainBaseElevation: 0, radiusMeters: 300, segments: 24, baseMeshGrid: { width: 1600, depth: 1600, segmentsX: 16, segmentsZ: 16 }, baseElevationSampler: () => 100 });
  const tile = latLonToTile(46, -120, 15);
  return { group, base, chunk, tile };
}

it('prepares the same clipped triangles, normals and Mercator UVs as the rendered refined surface', () => {
  const { group, base, chunk, tile } = fixture();
  base.geometry.userData.surfaceHoles = [chunk.getSurfaceBounds()]; group.add(chunk.mesh);
  const tb = tileBounds(tile.x, tile.y, 15);
  const a = geoToLocalMeters(tb.nw.lat, tb.nw.lon, 0, 46, -120, 0), b = geoToLocalMeters(tb.se.lat, tb.se.lon, 0, 46, -120, 0);
  const expected = buildSurfacePatchGeometry(base, { minX: a.x, maxX: b.x, minZ: a.z, maxZ: b.z }, (x, z) => {
    const geo = localMetersToGeo(x, z, 46, -120), sin = Math.sin(degToRad(clampLatitude(geo.lat)));
    const tileY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** 15;
    return { u: (geo.lon - tb.nw.lon) / (tb.se.lon - tb.nw.lon), v: 1 - (tileY - tile.y) };
  })!;
  const [actual] = buildPromotedSurfacePatches({ sources: [snapshotSurfaceMesh(base), snapshotSurfaceMesh(chunk.mesh)], centerLat: 46, centerLon: -120, tiles: [{ key: 'tile', zoom: 15, ...tile }] });
  expect(actual.positions).toEqual(expected.attributes.position.array);
  expect(actual.normals).toEqual(expected.attributes.normal.array);
  expect(actual.uvs).toEqual(expected.attributes.uv.array);
  expect(actual.indices).toEqual(expected.index!.array);
  expect(actual.boundsMin).toEqual(expected.boundingBox!.min.toArray());
  expect(actual.boundsMax).toEqual(expected.boundingBox!.max.toArray());
  expect(actual.sphereCenter).toEqual(expected.boundingSphere!.center.toArray());
  expect(actual.sphereRadius).toBe(expected.boundingSphere!.radius);
  expected.dispose(); chunk.dispose(); base.geometry.dispose();
});

it.each(['flat', 'exaggerated', 'empty'])('preserves exact culling bounds through worker transfer for %s geometry', kind => {
  const { group, base, chunk, tile } = fixture();
  if (kind === 'exaggerated') chunk.setVerticalExaggeration(3);
  base.geometry.userData.surfaceHoles = [chunk.getSurfaceBounds()]; group.add(chunk.mesh);
  const [data] = buildPromotedSurfacePatches({sources:[snapshotSurfaceMesh(base),snapshotSurfaceMesh(chunk.mesh)],
    centerLat:46,centerLon:-120,tiles:[{key:'tile',zoom:15,x:kind==='empty'?tile.x+10000:tile.x,y:tile.y}]});
  const published = createPromotedPatchGeometry(structuredClone(data));
  const scanned = new THREE.BufferGeometry();
  scanned.setAttribute('position',new THREE.BufferAttribute(data.positions,3));
  scanned.computeBoundingBox();scanned.computeBoundingSphere();
  try {
    expect(published.boundingBox!.equals(scanned.boundingBox!)).toBe(true);
    expect(published.boundingSphere!.equals(scanned.boundingSphere!)).toBe(true);
    expect(published.attributes.position.array).toEqual(data.positions);
    expect(published.attributes.normal.array).toEqual(data.normals);
    expect(published.attributes.uv.array).toEqual(data.uvs);
    expect(published.index!.array).toEqual(data.indices);
    const camera=new THREE.PerspectiveCamera(75,1,.1,10000),frustum=new THREE.Frustum();
    for(const x of [-5000,0,5000]) {
      camera.position.set(x,400,1000);camera.lookAt(x,100,0);camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
      expect(frustum.intersectsObject(new THREE.Mesh(published))).toBe(frustum.intersectsObject(new THREE.Mesh(scanned)));
    }
  } finally {published.dispose();scanned.dispose();chunk.dispose();base.geometry.dispose();}
});

it('leaves live imagery untouched until publication and avoids rebuilding it during the surface notification', async () => {
  const { base, chunk, tile } = fixture();
  const lod: any = Object.create(ImageryLODManager.prototype);
  lod.options = { terrainMesh: base, terrainGeoBounds: { centerLat: 46, centerLon: -120 } };
  lod.surfaceLifetime = new AbortController(); lod.currentGeneration = 0; lod.verticalExaggeration = 1;
  lod.preparedSurfaceKeys = new Set(); lod.patches = new Map();
  const initial = new THREE.PlaneGeometry(600, 600, 1, 1); initial.rotateX(-Math.PI / 2); initial.computeBoundingBox();
  const key = `satellite:15:${tile.x}:${tile.y}`;
  const patch: any = { key, zoom: 15, ...tile, mesh: new THREE.Mesh(initial) };
  lod.patches.set(key, patch);
  const publish = await lod.prepareSurfacePromotion(chunk);
  expect(patch.mesh.geometry).toBe(initial);
  expect(publish()).toBe(true);
  expect(patch.mesh.geometry).not.toBe(initial);
  lod.buildPatchGeometry = vi.fn();
  lod.reprojectPatches(undefined, chunk.getSurfaceBounds());
  expect(lod.buildPatchGeometry).not.toHaveBeenCalled();
  expect(lod.preparedSurfaceKeys.size).toBe(0);
  patch.mesh.geometry.dispose(); chunk.dispose(); base.geometry.dispose();
});

it('rejects stale imagery preparation when the source surface changes before publication', async () => {
  const { base, chunk, tile } = fixture();
  const lod: any = Object.create(ImageryLODManager.prototype);
  lod.options = { terrainMesh: base, terrainGeoBounds: { centerLat: 46, centerLon: -120 } };
  lod.surfaceLifetime = new AbortController(); lod.currentGeneration = 0; lod.verticalExaggeration = 1;
  lod.preparedSurfaceKeys = new Set();
  const geometry = new THREE.PlaneGeometry(600, 600, 1, 1); geometry.rotateX(-Math.PI / 2); geometry.computeBoundingBox();
  const key = `satellite:15:${tile.x}:${tile.y}`, mesh = new THREE.Mesh(geometry);
  lod.patches = new Map([[key, { key, ...tile, zoom: 15, mesh }]]);
  const publish = await lod.prepareSurfacePromotion(chunk);
  base.geometry.userData.surfaceHoles = [chunk.getSurfaceBounds()];
  expect(publish()).toBe(false); expect(mesh.geometry).toBe(geometry);
  geometry.dispose(); chunk.dispose(); base.geometry.dispose();
});

it('retries preparation if new intersecting imagery arrives before publication', async () => {
  const { base, chunk, tile } = fixture();
  const lod: any = Object.create(ImageryLODManager.prototype);
  lod.options = { terrainMesh: base, terrainGeoBounds: { centerLat: 46, centerLon: -120 } };
  lod.surfaceLifetime = new AbortController(); lod.currentGeneration = 0; lod.verticalExaggeration = 1;
  lod.preparedSurfaceKeys = new Set(); lod.patches = new Map();
  const publish = await lod.prepareSurfacePromotion(chunk);
  const geometry = new THREE.PlaneGeometry(600, 600, 1, 1); geometry.rotateX(-Math.PI / 2);
  lod.patches.set('new', { key: 'new', ...tile, zoom: 15, mesh: new THREE.Mesh(geometry) });
  expect(publish()).toBe(false);
  expect(lod.patches.get('new').mesh.geometry).toBe(geometry);
  geometry.dispose(); chunk.dispose(); base.geometry.dispose();
});

it('prepares restored parent imagery while the retiring child is still visible', async () => {
  const { group, base, chunk, tile } = fixture();
  base.geometry.userData.surfaceHoles = [chunk.getSurfaceBounds()]; group.add(chunk.mesh);
  const lod: any = Object.create(ImageryLODManager.prototype);
  lod.options = { terrainMesh: base, terrainGeoBounds: { centerLat: 46, centerLon: -120 } };
  lod.surfaceLifetime = new AbortController(); lod.currentGeneration = 0; lod.verticalExaggeration = 1;
  lod.preparedSurfaceKeys = new Set();
  const geometry = new THREE.PlaneGeometry(600, 600, 1, 1); geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry), key = `satellite:15:${tile.x}:${tile.y}`;
  lod.patches = new Map([[key, { key, ...tile, zoom: 15, mesh }]]);
  const publish = await lod.prepareSurfaceRemoval([chunk]);
  expect(chunk.mesh.visible).toBe(true); expect(mesh.geometry).toBe(geometry);
  expect(publish()).toBe(true);
  const positions = mesh.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeCloseTo(100.04, 3);
  base.geometry.userData.surfaceHoles = []; group.remove(chunk.mesh);
  lod.buildPatchGeometry = vi.fn(); lod.reprojectPatches(undefined, chunk.getSurfaceBounds());
  expect(lod.buildPatchGeometry).not.toHaveBeenCalled();
  mesh.geometry.dispose(); chunk.dispose(); base.geometry.dispose();
});

it('bounds diagnostic outlines independently of terrain triangle density', () => {
  const lod: any = Object.create(ImageryLODManager.prototype);
  lod.options = { elevationSampler: (x: number, z: number) => x + z + 100 }; lod.verticalExaggeration = 2;
  const geometry = new THREE.PlaneGeometry(100, 100, 160, 160); geometry.rotateX(-Math.PI / 2);
  const outline: THREE.LineSegments = lod.buildPatchOutline(geometry, 19);
  const positions = outline.geometry.attributes.position;
  expect(positions.count).toBe(128);
  for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeCloseTo((positions.getX(i) + positions.getZ(i) + 100) * 2 + 0.1, 3);
  outline.geometry.dispose(); (outline.material as THREE.Material).dispose(); geometry.dispose();
});

it('publishes direct-shaded terrain without reclipping owned imagery, then refreshes the legacy fallback before release completes', async () => {
  const { group, base, chunk, tile } = fixture();
  const lod: any = Object.create(ImageryLODManager.prototype);
  lod.options = { terrainMesh: base, terrainGeoBounds: { centerLat: 46, centerLon: -120 } };
  lod.surfaceLifetime = new AbortController(); lod.currentGeneration = 0; lod.verticalExaggeration = 1; lod.surfaceRevision = 0;
  lod.preparedSurfaceKeys = new Set(); lod.staleDirectPatches = new Set(); lod.directRefreshDepth = 0; lod.directReprojectionsAvoided = 0;
  const geometry = new THREE.PlaneGeometry(600, 600, 1, 1); geometry.rotateX(-Math.PI / 2); geometry.computeBoundingBox();
  const key = `satellite:15:${tile.x}:${tile.y}`, patch: any = { key, ...tile, zoom: 15, mesh: new THREE.Mesh(geometry) };
  lod.patches = new Map([[key, patch]]);
  lod.terrainImagery = { dispose: vi.fn() }; lod.batchRenderer = { owns: () => true, clear: vi.fn() };
  const publish = await lod.prepareSurfacePromotion(chunk);
  expect(publish()).toBe(true); expect(patch.mesh.geometry).toBe(geometry);
  base.geometry.userData.surfaceHoles = [chunk.getSurfaceBounds()]; group.add(chunk.mesh);
  lod.buildPatchGeometry = vi.fn(); lod.reprojectPatches(undefined, chunk.getSurfaceBounds());
  expect(lod.buildPatchGeometry).not.toHaveBeenCalled(); expect(lod.staleDirectPatches.has(key)).toBe(true);
  expect(lod.directReprojectionsAvoided).toBe(1);
  await lod.releaseBatches();
  expect(patch.mesh.geometry).not.toBe(geometry); expect(lod.staleDirectPatches.size).toBe(0);
  expect(lod.directRefreshDepth).toBe(0);
  const heights = patch.mesh.geometry.attributes.position.array;
  expect(heights.some((value: number, i: number) => i % 3 === 1 && value > 150)).toBe(true);
  patch.mesh.geometry.dispose(); chunk.dispose(); base.geometry.dispose();
});
