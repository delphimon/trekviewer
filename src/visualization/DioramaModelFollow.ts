import * as THREE from 'three';

/** Follow a miniature in room space without changing the tracked viewer pose. */
export class DioramaModelFollow {
  private readonly anchor = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly displacement = new THREE.Vector3();
  private readonly position = new THREE.Vector3();

  public start(camera: THREE.Camera): void {
    camera.getWorldPosition(this.anchor);
    camera.getWorldDirection(this.direction);
    this.direction.y = 0;
    if (this.direction.lengthSq() < 1e-8) this.direction.set(0, 0, -1);
    this.anchor.addScaledVector(this.direction.normalize(), 0.8);
    this.anchor.y -= 0.45;
  }

  public update(root: THREE.Object3D, focusWorld: THREE.Vector3, delta: number): void {
    const dt = Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.1)) : 0;
    this.displacement.copy(this.anchor).sub(focusWorld).multiplyScalar(1 - Math.exp(-5 * dt));
    // Bound travel after a scrub or a large inspection zoom. Never turn the room.
    this.displacement.clampLength(0, 0.6 * dt);
    root.getWorldPosition(this.position).add(this.displacement);
    if (root.parent) root.parent.worldToLocal(this.position);
    root.position.copy(this.position);
  }
}
