import * as THREE from 'three';
import type { TerrainResult } from '../terrain/TerrainGenerator.ts';

export const FOLLOW_SURFACE_SAMPLES = 16;
export const FOLLOW_SURFACE_CLEARANCE = 0.015;
type FollowTerrain = Pick<TerrainResult, 'group' | 'sampleRenderedSurfaceY' | 'getVerticalExaggeration'>;

/** Desktop-only inspection camera. The XR viewer and model never move here. */
export class DioramaCameraFollow {
  private readonly offset = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly inverseSurface = new THREE.Matrix4();
  private readonly localFocus = new THREE.Vector3();
  private readonly localCamera = new THREE.Vector3();
  private readonly surfaceScale = new THREE.Vector3();
  private terrain: FollowTerrain | null = null;
  private localClearance = 0;

  public setTerrain(terrain: FollowTerrain | null): void {
    this.terrain = terrain;
  }

  public start(camera: THREE.Camera, target: THREE.Vector3): void {
    this.offset.copy(camera.position).sub(target);
    if (this.offset.lengthSq() < 1e-8) this.offset.set(0, 1, 1);
    this.offset.setLength(THREE.MathUtils.clamp(this.offset.length(), 0.15, 0.45));
    // Keep a raised, oblique inspection view rather than a ground-level camera.
    this.offset.y = Math.max(0.18, this.offset.y);
  }

  public update(camera: THREE.Camera, target: THREE.Vector3, focus: THREE.Vector3, delta: number): void {
    const alpha = 1 - Math.exp(-3 * (Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.1)) : 0));
    this.desiredPosition.copy(focus).add(this.offset);
    const terrain = this.terrain;
    let surfaceReady = false;
    if (terrain) {
      terrain.group.updateWorldMatrix(true, false);
      const determinant = terrain.group.matrixWorld.determinant();
      this.surfaceScale.setFromMatrixScale(terrain.group.matrixWorld);
      if (Number.isFinite(determinant) && determinant !== 0 && this.surfaceScale.y > 0) {
        this.inverseSurface.copy(terrain.group.matrixWorld).invert();
        this.localFocus.copy(focus).applyMatrix4(this.inverseSurface);
        this.localClearance = FOLLOW_SURFACE_CLEARANCE / this.surfaceScale.y;
        surfaceReady = true;
        this.raiseAboveSurface(this.desiredPosition, terrain);
      }
    }
    target.lerp(focus, alpha);
    camera.position.lerp(this.desiredPosition, alpha);
    // Smoothing or a scrub can put the actual camera below a newly raised ridge.
    if (terrain && surfaceReady) this.raiseAboveSurface(camera.position, terrain);
  }

  private raiseAboveSurface(position: THREE.Vector3, terrain: FollowTerrain): void {
    this.localCamera.copy(position).applyMatrix4(this.inverseSurface);
    const exaggeration = terrain.getVerticalExaggeration?.() ?? 1;
    if (!Number.isFinite(exaggeration) || exaggeration <= 0) return;
    let minimumY = this.localCamera.y;
    for (let i = 1; i <= FOLLOW_SURFACE_SAMPLES; i++) {
      const t = i / FOLLOW_SURFACE_SAMPLES;
      const x = THREE.MathUtils.lerp(this.localFocus.x, this.localCamera.x, t);
      const z = THREE.MathUtils.lerp(this.localFocus.z, this.localCamera.z, t);
      const height = terrain.sampleRenderedSurfaceY(x, z) * exaggeration;
      if (!Number.isFinite(height)) continue;
      // Clearance tapers to zero at the focus so a surface-level hiker does not
      // force an excessive lift. The camera endpoint receives the full margin.
      const requiredY = this.localFocus.y + (height - this.localFocus.y) / t + this.localClearance;
      if (Number.isFinite(requiredY)) minimumY = Math.max(minimumY, requiredY);
    }
    if (minimumY > this.localCamera.y) {
      this.localCamera.y = minimumY;
      position.copy(this.localCamera).applyMatrix4(terrain.group.matrixWorld);
    }
  }
}
