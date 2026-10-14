import * as THREE from 'three';
import { buildSurfacePatchGeometry } from './SurfacePatchGeometry.ts';
import { clampLatitude, degToRad, geoToLocalMeters, localMetersToGeo, tileBounds } from '../gpx/Coordinates.ts';
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
      const geometry = buildSurfacePatchGeometry(meshes[0], { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z }, (x, z) => {
        const geo = localMetersToGeo(x, z, input.centerLat, input.centerLon);
        const sin = Math.sin(degToRad(clampLatitude(geo.lat)));
        const mercatorY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** tile.zoom;
        return { u: (geo.lon - bounds.nw.lon) / (bounds.se.lon - bounds.nw.lon), v: 1 - (mercatorY - tile.y) };
      })!;
      const result: SurfacePatchData = { key: tile.key,
        positions: geometry.attributes.position.array as Float32Array,
        normals: geometry.attributes.normal.array as Float32Array,
        uvs: geometry.attributes.uv.array as Float32Array,
        indices: geometry.index!.array as Uint16Array | Uint32Array };
      geometry.dispose();
      return result;
    });
  } finally { meshes.forEach(mesh => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }); }
}
