import * as THREE from 'three';

/**
 * Mixed-reality tabletop placement (Quest Browser WebXR plane detection + anchors).
 *
 * - After session start, waits up to a few seconds for detected planes (Quest reports the
 *   desk/table from Space Setup) and places the diorama on the nearest table-height surface.
 * - Creates an anchor at the placement. Each frame the anchor's pose change is applied to the
 *   diorama, so a recenter (reference-space reset) or tracking correction does not move the
 *   model relative to the real room, while the user's own grabs/moves are preserved.
 * - Every call is optional and failure-tolerant: without the features the app keeps its
 *   default placement (82 cm high, 80 cm ahead).
 */
export interface PlaneCandidate {
  /** Plane centre in reference space. */
  position: THREE.Vector3;
  orientation: 'horizontal' | 'vertical' | string;
  semanticLabel?: string;
  /** Approximate width/depth in metres from the polygon bounds. */
  width: number;
  depth: number;
}

const MIN_TABLE_HEIGHT = 0.45;
const MAX_TABLE_HEIGHT = 1.25;
const MAX_TABLE_DISTANCE = 2.0;

/** Picks the best table surface near the viewer, or null. Pure for testability. */
export function chooseTablePlane(candidates: readonly PlaneCandidate[], viewer: THREE.Vector3, floorY = 0): PlaneCandidate | null {
  let best: PlaneCandidate | null = null;
  let bestScore = Infinity;
  for (const plane of candidates) {
    if (plane.orientation !== 'horizontal') continue;
    const label = plane.semanticLabel?.toLowerCase();
    if (label && ['floor', 'ceiling', 'wall', 'bed', 'couch', 'other'].includes(label) && label !== 'table') continue;
    const height = plane.position.y - floorY;
    if (height < MIN_TABLE_HEIGHT || height > MAX_TABLE_HEIGHT) continue;
    if (Math.min(plane.width, plane.depth) < 0.35) continue;
    const dx = plane.position.x - viewer.x, dz = plane.position.z - viewer.z;
    const distance = Math.hypot(dx, dz);
    if (distance > MAX_TABLE_DISTANCE) continue;
    const score = distance - (label === 'table' ? 0.5 : 0);
    if (score < bestScore) { bestScore = score; best = plane; }
  }
  return best;
}

type AnyFrame = XRFrame & { detectedPlanes?: Set<any>; createAnchor?: (pose: XRRigidTransform, space: XRSpace) => Promise<any> };

export class TablePlacement {
  private startedAt = 0;
  private searching = false;
  private anchor: any = null;
  private anchorPending = false;
  private readonly lastAnchorMatrix = new THREE.Matrix4();
  private hasLastAnchorMatrix = false;
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchDelta = new THREE.Matrix4();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private static readonly SEARCH_MS = 4000;

  /** Begin a new session: look for a table for a few seconds. */
  public start(now: number): void {
    this.dispose();
    this.startedAt = now;
    this.searching = true;
  }

  /** Stops searching (e.g. the user grabbed the model or switched to 1:1). */
  public stopSearching(): void {
    this.searching = false;
  }

  public get isSearching(): boolean { return this.searching; }

  /**
   * Call once per XR frame. Returns a message when the model was just placed on a table.
   */
  public update(frame: XRFrame | undefined, referenceSpace: XRSpace | null, root: THREE.Object3D,
    viewer: THREE.Vector3, now: number): string | null {
    if (!frame || !referenceSpace) return null;
    let message: string | null = null;
    const f = frame as AnyFrame;
    if (this.searching) {
      if (now - this.startedAt > TablePlacement.SEARCH_MS) this.searching = false;
      else if (f.detectedPlanes && f.detectedPlanes.size > 0) {
        const candidates: (PlaneCandidate & { space: XRSpace })[] = [];
        for (const plane of f.detectedPlanes) {
          try {
            const pose = frame.getPose(plane.planeSpace, referenceSpace);
            if (!pose) continue;
            const p = pose.transform.position;
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const point of plane.polygon ?? []) {
              minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
              minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
            }
            candidates.push({ position: new THREE.Vector3(p.x, p.y, p.z), orientation: plane.orientation,
              semanticLabel: plane.semanticLabel, width: Number.isFinite(maxX - minX) ? maxX - minX : 0,
              depth: Number.isFinite(maxZ - minZ) ? maxZ - minZ : 0, space: plane.planeSpace });
          } catch { /* Skip planes without a pose this frame. */ }
        }
        const table = chooseTablePlane(candidates, viewer);
        if (table) {
          // Sit the model's base on the surface, at the table centre (a small gap avoids z-fighting).
          root.position.set(table.position.x, table.position.y + 0.01, table.position.z);
          this.searching = false;
          this.createAnchor(f, referenceSpace, root);
          message = 'Placed the model on your table.';
        }
      }
    }
    this.followAnchor(frame, referenceSpace, root);
    return message;
  }

  /** Re-anchor after the user moves the model, so later corrections follow its new spot. */
  public reanchor(frame: XRFrame | undefined, referenceSpace: XRSpace | null, root: THREE.Object3D): void {
    if (!frame || !referenceSpace) return;
    this.releaseAnchor();
    this.createAnchor(frame as AnyFrame, referenceSpace, root);
  }

  public dispose(): void {
    this.searching = false;
    this.releaseAnchor();
  }

  private releaseAnchor(): void {
    try { this.anchor?.delete?.(); } catch { /* Already gone. */ }
    this.anchor = null;
    this.hasLastAnchorMatrix = false;
  }

  private createAnchor(frame: AnyFrame, referenceSpace: XRSpace, root: THREE.Object3D): void {
    if (!frame.createAnchor || this.anchorPending || typeof XRRigidTransform === 'undefined') return;
    this.anchorPending = true;
    const p = root.position;
    try {
      void frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }), referenceSpace)
        .then(anchor => { this.anchor = anchor; this.hasLastAnchorMatrix = false; })
        .catch(() => { /* Anchors unsupported/denied: keep the plain placement. */ })
        .finally(() => { this.anchorPending = false; });
    } catch { this.anchorPending = false; }
  }

  private followAnchor(frame: XRFrame, referenceSpace: XRSpace, root: THREE.Object3D): void {
    if (!this.anchor?.anchorSpace) return;
    let pose: XRPose | undefined | null;
    try { pose = frame.getPose(this.anchor.anchorSpace, referenceSpace); } catch { return; }
    if (!pose) return;
    this.scratchMatrix.fromArray(pose.transform.matrix);
    if (this.hasLastAnchorMatrix) {
      // delta = current * last^-1 : how the real-world anchor moved in reference space.
      this.scratchDelta.copy(this.lastAnchorMatrix).invert().premultiply(this.scratchMatrix);
      this.scratchDelta.decompose(this.scratchPos, this.scratchQuat, this.scratchScale);
      if (this.scratchPos.lengthSq() > 1e-8 || Math.abs(this.scratchQuat.w) < 0.999999) {
        root.updateMatrix();
        root.matrix.premultiply(this.scratchDelta);
        root.matrix.decompose(root.position, root.quaternion, this.scratchScale.copy(root.scale));
        root.scale.copy(this.scratchScale);
      }
    }
    this.lastAnchorMatrix.copy(this.scratchMatrix);
    this.hasLastAnchorMatrix = true;
  }
}
