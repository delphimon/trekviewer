import { it, expect } from 'vitest';
import * as THREE from 'three';
import { SurfaceVertexIndex } from '../src/visualization/SurfaceVertexIndex.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';

it('matches exhaustive vertex membership for localized, broad and sparse footprints', () => {
  const geometry = new THREE.BufferGeometry(), positions = new Float32Array(12000);
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < positions.length; i += 3) { positions[i] = (random() - 0.5) * 100000; positions[i + 2] = (random() - 0.5) * 100000; }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lookup = new SurfaceVertexIndex(geometry, 500, false), position = geometry.attributes.position;
  for (let query = 0; query < 120; query++) {
    const x = (random() - 0.5) * 100000, z = (random() - 0.5) * 100000, radius = query % 3 === 0 ? 60000 : query % 3 === 1 ? 300 : 2000;
    const bounds = { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
    const expected = [];
    for (let i = 0; i < position.count; i++) if (position.getX(i) >= bounds.minX && position.getX(i) <= bounds.maxX && position.getZ(i) >= bounds.minZ && position.getZ(i) <= bounds.maxZ) expected.push(i);
    expect(lookup.verticesIn(bounds).sort((a, b) => a - b)).toEqual(expected);
  }
  geometry.dispose();
});

it('keeps original bucket order for interleaved trails in direct and broad queries', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    110, 0, 0, -90, 0, 0, 120, 0, 0, -80, 0, 0, 10, 0, 0, 10000, 0, 10000,
  ], 3));
  const lookup = new SurfaceVertexIndex(geometry, 100, false);
  expect(lookup.verticesIn({ minX: -100, maxX: 199, minZ: 0, maxZ: 0 })).toEqual([0, 2, 1, 3, 4]);
  expect(lookup.verticesIn({ minX: -100000, maxX: 100000, minZ: -100000, maxZ: 100000 })).toEqual([0, 2, 1, 3, 4, 5]);
  expect(lookup.verticesIn()).toEqual([0, 1, 2, 3, 4, 5]);
  geometry.dispose();
});

it('includes exact positive/negative cell boundaries and rejects unusable or disjoint bounds', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-500, 0, -500, 0, 0, 0, 500, 0, 500, 499, 0, 499], 3));
  const lookup = new SurfaceVertexIndex(geometry, 500, false);
  for (const [point, expected] of [[-500, 0], [0, 1], [500, 2]] as const) expect(lookup.verticesIn({ minX: point, maxX: point, minZ: point, maxZ: point })).toEqual([expected]);
  expect(lookup.verticesIn({ minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity })).toEqual([0, 1, 3, 2]);
  expect(lookup.verticesIn({ minX: NaN, maxX: 500, minZ: -500, maxZ: 500 })).toEqual([]);
  expect(lookup.verticesIn({ minX: 500, maxX: -500, minZ: -500, maxZ: 500 })).toEqual([]);
  expect(lookup.verticesIn({ minX: 100000, maxX: 200000, minZ: -500, maxZ: 500 })).toEqual([]);
  geometry.dispose();
});

it('bounds sparse queries and supports cells beyond safe integer increments', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float64Array([-1e20, 0, 0, 1e20, 0, 0]), 3));
  const lookup = new SurfaceVertexIndex(geometry, 1, false);
  expect(lookup.verticesIn({ minX: -1e20, maxX: 1e20, minZ: 0, maxZ: 0 })).toEqual([0, 1]);
  expect(lookup.verticesIn({ minX: 1e20, maxX: 1e20, minZ: 0, maxZ: 0 })).toEqual([1]);
  geometry.dispose();
});

it('matches a full normal rebuild after a localized elevation change, including boundary neighbors', () => {
  const geometry = new THREE.PlaneGeometry(2000, 2000, 20, 20); geometry.rotateX(-Math.PI / 2);
  const lookup = new SurfaceVertexIndex(geometry, 200);
  const changed = lookup.verticesIn({ minX: -300, maxX: 300, minZ: -200, maxZ: 200 });
  expect(changed.length).toBeLessThan(geometry.attributes.position.count / 8);
  for (const i of changed) geometry.attributes.position.setY(i, 20 + geometry.attributes.position.getX(i) * 0.01);
  const expected = geometry.clone(); expected.computeVertexNormals();
  lookup.updateNormals(changed);
  const actual = geometry.attributes.normal, reference = expected.attributes.normal;
  for (let i = 0; i < actual.count; i++) {
    expect(actual.getX(i)).toBeCloseTo(reference.getX(i), 6);
    expect(actual.getY(i)).toBeCloseTo(reference.getY(i), 6);
    expect(actual.getZ(i)).toBeCloseTo(reference.getZ(i), 6);
  }
  geometry.dispose(); expected.dispose();
});

it('keeps a raised trail section inside its culling bounds and limits its position upload', () => {
  const geometry = new THREE.PlaneGeometry(1000, 1000, 8, 8); geometry.rotateX(-Math.PI / 2);
  const lookup = new SurfaceVertexIndex(geometry);
  const mesh = new THREE.Mesh(geometry), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 50);
  camera.position.set(0, 3000, 20); camera.lookAt(0, 3000, 0); camera.updateMatrixWorld(); mesh.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  expect(frustum.intersectsObject(mesh)).toBe(false);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  position.setY(40, 3000); lookup.updatePositions([40]);
  expect(frustum.intersectsObject(mesh)).toBe(true);
  expect(geometry.boundingBox!.max.y).toBe(3000);
  expect(geometry.boundingSphere!.containsPoint(new THREE.Vector3(0, 3000, 0))).toBe(true);
  expect(position.updateRanges).toEqual([{ start: 120, count: 3 }]);
  expect(position.usage).toBe(THREE.DynamicDrawUsage);
  position.setY(42, -100); lookup.updatePositions([42]);
  expect(position.updateRanges).toEqual([{ start: 120, count: 9 }]);
  expect(geometry.boundingBox!.min.y).toBe(-100);
  geometry.dispose(); (mesh.material as THREE.Material).dispose();
});

it('retains pending local changes when a full exaggeration update occurs before rendering', () => {
  const geometry = new THREE.PlaneGeometry(1000, 1000, 8, 8); geometry.rotateX(-Math.PI / 2);
  const lookup = new SurfaceVertexIndex(geometry, 500, false);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  position.setY(40, 3000); lookup.updatePositions([40]);
  for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) * 2);
  lookup.updatePositions(lookup.verticesIn());
  expect(position.updateRanges).toEqual([{ start: 0, count: position.array.length }]);
  expect(geometry.boundingBox!.max.y).toBe(6000);
  expect((lookup as any).incidentFaces).toBeNull();
  geometry.dispose();
});

it('uploads a bounded normal span containing every affected boundary neighbor', () => {
  const geometry = new THREE.PlaneGeometry(1000, 1000, 8, 8); geometry.rotateX(-Math.PI / 2);
  const lookup = new SurfaceVertexIndex(geometry), normal = geometry.attributes.normal as THREE.BufferAttribute;
  const before = normal.array.slice();
  geometry.attributes.position.setY(40, 100); lookup.updateNormals([40]);
  const reference = geometry.clone(); reference.computeVertexNormals();
  const range = normal.updateRanges[0]; expect(range.count).toBeLessThan(normal.array.length / 2);
  for (let i = 0; i < normal.array.length; i++) {
    expect(normal.array[i]).toBeCloseTo(reference.attributes.normal.array[i], 6);
    if (Math.abs(normal.array[i] - before[i]) > 1e-6) expect(i >= range.start && i < range.start + range.count).toBe(true);
  }
  geometry.dispose(); reference.dispose();
});

it('maintains trail bounds across terrain refinement and exaggeration, with correct initial walking normals', () => {
  const track = GPXParser.parse('<gpx><trk><trkseg><trkpt lat="46.8" lon="-121.75"><ele>1000</ele></trkpt><trkpt lat="46.805" lon="-121.75"><ele>1200</ele></trkpt></trkseg></trk></gpx>');
  const trail = TrailMesh.create(track, (_x, z) => 100 + z * 0.35);
  trail.setViewMode('first-person');
  const walking = trail.trailMesh.geometry, expected = walking.clone(); expected.computeVertexNormals();
  expect(walking.attributes.normal.array).toEqual(expected.attributes.normal.array);
  expect(Math.abs(walking.attributes.normal.getZ(0))).toBeGreaterThan(0.1);
  trail.reprojectToSurface!(() => 3000, { minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  expect(walking.boundingBox!.max.y).toBeCloseTo(3000.08, 3);
  trail.setViewMode('diorama');
  const tabletop = trail.trailMesh.geometry;
  expect(tabletop.boundingBox!.max.y).toBeGreaterThan(3000);
  trail.setVerticalExaggeration(3);
  expect(tabletop.boundingBox!.max.y).toBeGreaterThan(9000);
  expect((tabletop.attributes.position as THREE.BufferAttribute).updateRanges[0].count).toBe(tabletop.attributes.position.array.length);
  expected.dispose(); trail.dispose();
});
