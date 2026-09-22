import { describe, it } from "vitest";
import assert from 'node:assert';
import * as THREE from 'three';
import { disposeObject3D } from '../src/core/ResourceLifecycle.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

describe("resource disposal", () => {
  it("verifies resource disposal", async () => {

console.log('--- Testing GPU Resource Lifecycle & Complete Tree Disposal ---');

// 1. Spying on THREE.js disposables
let disposedGeometries = 0;
let disposedMaterials = 0;
let disposedTextures = 0;

function createSpyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const origDispose = geo.dispose.bind(geo);
  geo.dispose = () => {
    disposedGeometries++;
    origDispose();
  };
  return geo;
}

function createSpyTexture(): THREE.Texture {
  const tex = new THREE.Texture();
  const origDispose = tex.dispose.bind(tex);
  tex.dispose = () => {
    disposedTextures++;
    origDispose();
  };
  return tex;
}

function createSpyMaterial(textures: THREE.Texture[] = []): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial();
  if (textures[0]) mat.map = textures[0];
  if (textures[1]) mat.normalMap = textures[1];
  if (textures[2]) mat.roughnessMap = textures[2];

  const origDispose = mat.dispose.bind(mat);
  mat.dispose = () => {
    disposedMaterials++;
    origDispose();
  };
  return mat;
}

// 2. Build deep nested 3D hierarchy with meshes, materials, and textures
const root = new THREE.Group();
root.name = 'DeepRoot';

const child1 = new THREE.Group();
const mesh1 = new THREE.Mesh(createSpyGeometry(), createSpyMaterial([createSpyTexture()]));
child1.add(mesh1);
root.add(child1);

const child2 = new THREE.Group();
const tex2 = createSpyTexture();
const tex3 = createSpyTexture();
const mesh2 = new THREE.Mesh(createSpyGeometry(), createSpyMaterial([tex2, tex3]));
const mesh3 = new THREE.Mesh(createSpyGeometry(), [
  createSpyMaterial([createSpyTexture()]),
  createSpyMaterial(),
]);
child2.add(mesh2);
child2.add(mesh3);
root.add(child2);

// Total created:
// Geometries: 3
// Materials: 4 (mat1, mat2, array mat3[0], array mat3[1])
// Textures: 4 (in mat1, mat2, mat3)

assert.strictEqual(disposedGeometries, 0);
assert.strictEqual(disposedMaterials, 0);
assert.strictEqual(disposedTextures, 0);

// Dispose entire hierarchy
disposeObject3D(root);

assert.strictEqual(disposedGeometries, 3, 'All 3 geometries must be disposed');
assert.strictEqual(disposedMaterials, 4, 'All 4 materials must be disposed');
assert.strictEqual(disposedTextures, 4, 'All 4 textures must be disposed');
assert.strictEqual(root.children.length, 0, 'Root children must be detached');
assert.strictEqual(child1.children.length, 0, 'Child 1 children must be detached');
assert.strictEqual(child2.children.length, 0, 'Child 2 children must be detached');
console.log('✓ Recursive tree traversal cleanly disposed all geometries, multi-materials, and textures');

// 3. Test LoadedTrek.dispose()
const mockTrack: TrackStats = {
  name: 'Test Trek',
  points: [],
  totalDistance: 100,
  elevationGain: 10,
  elevationLoss: 0,
  minElevation: 100,
  maxElevation: 110,
  movingTime: 100,
  totalPlaybackSeconds: 60,
  avgSpeed: 3.6,
  maxSpeed: 5.0,
  bounds: {
    minLat: 0, maxLat: 1, minLon: 0, maxLon: 1,
    minEle: 100, maxEle: 110, centerLat: 0.5, centerLon: 0.5,
    widthMeters: 100, depthMeters: 100, elevationSpan: 10,
  },
  waypoints: [],
  landmarks: [],
  segments: [],
  warnings: [],
};

let terrainDisposed = false;
let trailDisposed = false;
let flyoverDisposed = false;

const mockTerrainResult: any = {
  group: new THREE.Group(),
  dispose: () => { terrainDisposed = true; },
  setVerticalExaggeration: () => {},
  setTextureStyle: async () => {},
};

const mockTrailResult: any = {
  group: new THREE.Group(),
  dispose: () => { trailDisposed = true; },
  setVerticalExaggeration: () => {},
  setColorMode: () => {},
  setViewMode: () => {},
};

const mockDioramaBase = new THREE.Group();
const baseMesh = new THREE.Mesh(createSpyGeometry(), createSpyMaterial());
mockDioramaBase.add(baseMesh);

const mockFlyover: any = {
  dispose: () => { flyoverDisposed = true; },
  setViewMode: () => {},
};

const trek = new LoadedTrek(
  mockTrack,
  mockTerrainResult,
  mockTrailResult,
  mockDioramaBase,
  mockFlyover
);

assert.strictEqual(trek.group.children.length, 3);
assert(!terrainDisposed);
assert(!trailDisposed);
assert(!flyoverDisposed);

trek.dispose();

assert(terrainDisposed, 'TerrainResult must be disposed');
assert(trailDisposed, 'TrailResult must be disposed');
assert(flyoverDisposed, 'FlyoverController must be disposed');
assert.strictEqual(mockDioramaBase.children.length, 0, 'Diorama base must be disposed and detached');
assert.strictEqual(trek.group.children.length, 0, 'Trek container group must be detached');

console.log('✓ LoadedTrek.dispose() atomically disposed all sub-controllers and meshes');
console.log('✓ All GPU Resource Lifecycle tests passed successfully!');

  });
});
