import * as THREE from 'three';
import { buildSurfacePatchGeometry } from './SurfacePatchGeometry.ts';
import { geoToLocalMeters, tileBounds } from '../gpx/Coordinates.ts';
import { createTileUVMapper } from './TileUV.ts';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

export interface SurfaceMeshSnapshot {
  width: number; depth: number; segmentsX: number; segmentsZ: number;
  x: number; z: number;
  positions: Float32Array; normals: Float32Array;
  holes: TerrainSurfaceBounds[];
}
export interface SurfacePromotionInput {
  sources: SurfaceMeshSnapshot[];
  centerLat: number; centerLon: number;
  tiles: { key: string; zoom: number; x: number; y: number }[];
}
export interface SurfacePatchData {
  key: string; positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint16Array | Uint32Array;
  boundsMin: [number, number, number]; boundsMax: [number, number, number];
  sphereCenter: [number, number, number]; sphereRadius: number;
}

/** Reuse the bounds already computed with the prepared Float32 positions.
 * Publication must not rescan every refined vertex on the XR render thread.
 */
export function createPromotedPatchGeometry(data: SurfacePatchData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3().fromArray(data.boundsMin), new THREE.Vector3().fromArray(data.boundsMax));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3().fromArray(data.sphereCenter), data.sphereRadius);
  return geometry;
}

export function snapshotSurfaceMesh(mesh: THREE.Mesh): SurfaceMeshSnapshot {
  const geometry = mesh.geometry as THREE.PlaneGeometry;
  const p = geometry.parameters;
  return { width: p.width, depth: p.height, segmentsX: p.widthSegments, segmentsZ: p.heightSegments,
    x: mesh.position.x, z: mesh.position.z,
    positions: geometry.attributes.position.array as Float32Array,
    normals: geometry.attributes.normal.array as Float32Array,
    holes: geometry.userData.surfaceHoles ?? [] };
}

/** Clip the original triangle surfaces in a worker, preserving the existing geographic UV mapping. */
export function buildPromotedSurfacePatches(input: SurfacePromotionInput): SurfacePatchData[] {
  const group = new THREE.Group();
  const meshes = input.sources.map((source, i) => {
    // Minimal construction establishes the PlaneGeometry type; source arrays define the actual grid.
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    Object.assign(geometry.parameters, { width: source.width, height: source.depth, widthSegments: source.segmentsX, heightSegments: source.segmentsZ });
    geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(source.normals, 3));
    geometry.userData.surfaceHoles = source.holes;
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(source.x, 0, source.z);
    mesh.name = i === 0 ? 'BaseTerrainMesh' : 'LocalHighResTerrainMesh';
    group.add(mesh);
    return mesh;
  });
  try {
    return input.tiles.map(tile => {
      const bounds = tileBounds(tile.x, tile.y, tile.zoom);
      const nw = geoToLocalMeters(bounds.nw.lat, bounds.nw.lon, 0, input.centerLat, input.centerLon, 0);
      const se = geoToLocalMeters(bounds.se.lat, bounds.se.lon, 0, input.centerLat, input.centerLon, 0);
      const geometry = buildSurfacePatchGeometry(meshes[0], { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z },
        createTileUVMapper(tile.zoom, tile.x, tile.y, input.centerLat, input.centerLon))!;
      const result: SurfacePatchData = { key: tile.key,
        positions: geometry.attributes.position.array as Float32Array,
        normals: geometry.attributes.normal.array as Float32Array,
        uvs: geometry.attributes.uv.array as Float32Array,
        indices: geometry.index!.array as Uint16Array | Uint32Array,
        boundsMin: geometry.boundingBox!.min.toArray(), boundsMax: geometry.boundingBox!.max.toArray(),
        sphereCenter: geometry.boundingSphere!.center.toArray(), sphereRadius: geometry.boundingSphere!.radius };
      geometry.dispose();
      return result;
    });
  } finally { meshes.forEach(mesh => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }); }
}
