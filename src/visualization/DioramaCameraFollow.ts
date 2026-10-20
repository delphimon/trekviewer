import * as THREE from 'three';

/** Desktop-only inspection camera. The XR viewer and model never move here. */
export class DioramaCameraFollow {
  private readonly offset = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();

  public start(camera: THREE.Camera, target: THREE.Vector3): void {
    this.offset.copy(camera.position).sub(target);
    if (this.offset.lengthSq() < 1e-8) this.offset.set(0, 1, 1);
    this.offset.setLength(THREE.MathUtils.clamp(this.offset.length(), 0.15, 0.45));
    // Keep a raised, oblique inspection view rather than a ground-level camera.
    this.offset.y = Math.max(0.18, this.offset.y);
  }

  public update(camera: THREE.Camera, target: THREE.Vector3, focus: THREE.Vector3, delta: number): void {
    const alpha = 1 - Math.exp(-3 * Math.max(0, Math.min(delta, 0.1)));
    this.desiredPosition.copy(focus).add(this.offset);
    target.lerp(focus, alpha);
    camera.position.lerp(this.desiredPosition, alpha);
  }
}
