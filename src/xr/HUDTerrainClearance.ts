import * as THREE from 'three';

/** World-space terrain height at an X/Z (null where there is no terrain). */
export type SurfaceHeightFn = (x: number, z: number, yHint: number) => number | null;

const SIGHT_FRACTIONS = [0.25, 0.5, 0.75, 1];
const _point = new THREE.Vector3();

/**
 * How far (metres) a vertical panel must rise so that its bottom edge clears the terrain and
 * the lines of sight from the eye to its bottom corners do not pass through the ground.
 * Raising the panel by L lifts a sight-line sample at fraction f by f * L, so each sample
 * needs L >= (ground + margin - sightY) / f.
 */
export function requiredHUDLift(
  eye: THREE.Vector3,
  bottomPoints: readonly THREE.Vector3[],
  surfaceY: SurfaceHeightFn,
  margin = 0.04,
): number {
  let lift = 0;
  for (const bottom of bottomPoints) {
    for (const f of SIGHT_FRACTIONS) {
      _point.lerpVectors(eye, bottom, f);
      const ground = surfaceY(_point.x, _point.z, _point.y);
      if (ground === null) continue;
      const need = (ground + margin - _point.y) / f;
      if (need > lift) lift = need;
    }
  }
  return lift;
}

/**
 * Keeps a docked panel above the terrain. The panel is placed in room space while the terrain
 * can move under it (1:1 walking, tabletop zoom, mode switches), so this re-checks a few times a
 * second and eases the panel up when the ground would bury it, then back down to where it was
 * docked. A manual drag becomes the new resting position.
 */
export class HUDTerrainClearance {
  private restY: number | null = null;
  private appliedY: number | null = null;
  private lastCheck = -Infinity;
  private targetLift = 0;
  private shortfall = 0;
  private readonly bottoms = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  /** Call after docking the panel: its current height is the resting height. */
  public reset(group: THREE.Object3D): void {
    this.restY = group.position.y;
    this.appliedY = group.position.y;
    this.targetLift = 0;
    this.shortfall = 0;
    this.lastCheck = -Infinity;
  }

  /** True when the terrain is too high to clear without floating the panel overhead. */
  public get buried(): boolean { return this.shortfall > 0.01; }

  /** Lift applied right now (metres above the resting height). */
  public get lift(): number {
    return this.restY === null || this.appliedY === null ? 0 : this.appliedY - this.restY;
  }

  /**
   * @param maxY highest the panel centre may go (about eye level) so it never floats overhead.
   * @returns true when the panel moved.
   */
  public update(
    group: THREE.Object3D, halfW: number, halfH: number, eye: THREE.Vector3, surfaceY: SurfaceHeightFn,
    now: number, maxY: number, force = false,
  ): boolean {
    if (this.restY === null || this.appliedY === null) this.reset(group);
    // Someone else (a drag, a re-dock) moved the panel: that is the new resting place.
    if (Math.abs(group.position.y - this.appliedY!) > 1e-4) this.reset(group);
    if (force || now - this.lastCheck >= 200) {
      this.lastCheck = now;
      group.updateMatrixWorld();
      const restOffset = this.restY! - group.position.y;
      // Measure from the resting position, so the lift can also come back down.
      this.bottoms[0].set(-halfW, -halfH, 0);
      this.bottoms[1].set(0, -halfH, 0);
      this.bottoms[2].set(halfW, -halfH, 0);
      for (const p of this.bottoms) { group.localToWorld(p); p.y += restOffset; }
      const lift = requiredHUDLift(eye, this.bottoms, surfaceY);
      this.targetLift = Math.max(0, Math.min(lift, maxY - this.restY!));
      this.shortfall = Math.max(0, lift - this.targetLift);
    }
    const targetY = this.restY! + this.targetLift;
    const current = group.position.y;
    if (Math.abs(targetY - current) < 1e-4) return false;
    // Rise quickly (the panel is being covered); settle back slowly to avoid bobbing.
    const step = force ? Infinity : targetY > current ? 0.03 : 0.006;
    group.position.y = current + Math.max(-step, Math.min(step, targetY - current));
    this.appliedY = group.position.y;
    return true;
  }
}
