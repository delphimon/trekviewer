import * as THREE from 'three';
import { tileToLatLon, geoToLocalMeters } from '../gpx/Coordinates.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export class ImageryPatch {
  public readonly zoom: number;
  public readonly tileX: number;
  public readonly tileY: number;
  public readonly key: string;
  public readonly mesh: THREE.Mesh;

  private unscaledHeights: Float32Array;
  private currentExaggeration: number;
  private isDisposed: boolean = false;
  private static readonly MICRO_OFFSET: number = 0.04; // 4cm elevation bias to guarantee no Z-fighting

  constructor(
    zoom: number,
    tileX: number,
    tileY: number,
    centerLat: number,
    centerLon: number,
    baseElevation: number,
    elevationSampler: (x: number, z: number) => number,
    currentExaggeration: number,
    texture: THREE.Texture
  ) {
    this.zoom = zoom;
    this.tileX = tileX;
    this.tileY = tileY;
    this.key = `${zoom}:${tileX}:${tileY}`;
    this.currentExaggeration = currentExaggeration;

    // Geographic boundary of this Web Mercator tile
    const nw = tileToLatLon(tileX, tileY, zoom);
    const se = tileToLatLon(tileX + 1, tileY + 1, zoom);

    // Convert corners to scene local metric coordinates
    const nwLocal = geoToLocalMeters(nw.lat, nw.lon, 0, centerLat, centerLon, baseElevation);
    const seLocal = geoToLocalMeters(se.lat, se.lon, 0, centerLat, centerLon, baseElevation);

    const minX = Math.min(nwLocal.x, seLocal.x);
    const maxX = Math.max(nwLocal.x, seLocal.x);
    const minZ = Math.min(nwLocal.z, seLocal.z);
    const maxZ = Math.max(nwLocal.z, seLocal.z);

    const widthM = maxX - minX;
    const depthM = maxZ - minZ;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    // Terrain-conforming grid: 10x10 segments is lightweight yet conforms smoothly to topography
    const segs = 10;
    const geo = new THREE.PlaneGeometry(widthM, depthM, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const posAttr = geo.attributes.position;
    const vertexCount = posAttr.count;
    this.unscaledHeights = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const worldX = centerX + vx;
      const worldZ = centerZ + vz;

      const unscaledY = elevationSampler(worldX, worldZ);
      this.unscaledHeights[i] = unscaledY;
      posAttr.setY(i, unscaledY * this.currentExaggeration + ImageryPatch.MICRO_OFFSET);
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.9,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -1.5,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(centerX, 0, centerZ);
    this.mesh.name = `ImageryPatch_${zoom}_${tileX}_${tileY}`;
    this.mesh.receiveShadow = true;
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed || Math.abs(this.currentExaggeration - factor) < 0.001) return;
    this.currentExaggeration = factor;

    const geo = this.mesh.geometry;
    const posAttr = geo.attributes.position;
    const vertexCount = posAttr.count;

    for (let i = 0; i < vertexCount; i++) {
      posAttr.setY(i, this.unscaledHeights[i] * this.currentExaggeration + ImageryPatch.MICRO_OFFSET);
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  public getCenter(): THREE.Vector3 {
    return this.mesh.position;
  }

  public distanceTo(pos: THREE.Vector3): number {
    return this.mesh.position.distanceTo(pos);
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    disposeObject3D(this.mesh);
  }
}
