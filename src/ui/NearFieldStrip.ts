import * as THREE from 'three';

/** Near-field transport strip (X3): previous landmark, play/pause, next landmark and a
 * short scrub bar on the plinth edge nearest the viewer, sized for an index-finger poke.
 * It stays a fixed size in the room whatever the model scale. */
export interface NearFieldStripActions {
  togglePlay(): void;
  previousLandmark(): void;
  nextLandmark(): void;
  scrub(progress: number): void;
}

export type NearFieldTarget = 'prev' | 'play' | 'next' | 'scrub' | null;

/** Room size of the strip in metres; each button is about 4.6 cm square (≥ 3 cm). */
export const NEAR_FIELD_STRIP_WIDTH_M = 0.33;
export const NEAR_FIELD_STRIP_HEIGHT_M = 0.046;
const SCRUB_START = 0.47, SCRUB_END = 0.97;

/** Which control a UV point falls on (u across the strip, v up). */
export function nearFieldTargetAt(u: number, v: number): NearFieldTarget {
  if (v < 0 || v > 1 || u < 0 || u > 1) return null;
  if (u < 0.14) return 'prev';
  if (u >= 0.15 && u < 0.29) return 'play';
  if (u >= 0.30 && u < 0.44) return 'next';
  if (u >= SCRUB_START - 0.02 && u <= SCRUB_END + 0.02) return 'scrub';
  return null;
}

export const nearFieldScrubProgress = (u: number) => Math.min(1, Math.max(0, (u - SCRUB_START) / (SCRUB_END - SCRUB_START)));

const _cam = new THREE.Vector3();
const _local = new THREE.Vector3();
const _toward = new THREE.Vector3();

export class NearFieldStrip {
  public readonly group = new THREE.Group();
  public readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private playing = false;
  private progress = 0;
  private hover: NearFieldTarget = null;
  private scrubOwner: string | null = null;
  private progressStep = -1;

  constructor(private readonly actions: NearFieldStripActions) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024; this.canvas.height = 144;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(NEAR_FIELD_STRIP_WIDTH_M, NEAR_FIELD_STRIP_HEIGHT_M), material);
    this.mesh.name = 'NearFieldStrip';
    this.mesh.renderOrder = 5;
    this.group.name = 'NearFieldStripGroup';
    this.group.add(this.mesh);
    this.group.visible = false;
    this.draw();
  }

  public setPlaying(playing: boolean): void { if (playing !== this.playing) { this.playing = playing; this.draw(); } }
  /** Called every frame; redraws only when the thumb moves by a visible step. */
  public setProgress(progress: number): void {
    const step = Math.round(progress * 400);
    if (step === this.progressStep) return;
    this.progressStep = step; this.progress = progress; this.draw();
  }

  /** Place the strip just outside the plinth edge nearest the viewer, facing them, or hide it. */
  public updatePlacement(camera: THREE.Camera, plinth: THREE.Mesh | null | undefined, visible: boolean): void {
    this.group.visible = visible && !!plinth;
    if (!this.group.visible || !plinth) return;
    const box = plinth.geometry.boundingBox ?? (plinth.geometry.computeBoundingBox(), plinth.geometry.boundingBox!);
    camera.getWorldPosition(_cam);
    _local.copy(_cam); plinth.worldToLocal(_local);
    const x = Math.min(box.max.x, Math.max(box.min.x, _local.x));
    const z = Math.min(box.max.z, Math.max(box.min.z, _local.z));
    if (x === _local.x && z === _local.z) {
      // Viewer above the plinth: use the nearest edge.
      const dx = Math.min(x - box.min.x, box.max.x - x), dz = Math.min(z - box.min.z, box.max.z - z);
      if (dx < dz) _local.x = x - box.min.x < box.max.x - x ? box.min.x : box.max.x; else _local.z = z - box.min.z < box.max.z - z ? box.min.z : box.max.z;
    } else { _local.x = x; _local.z = z; }
    _local.y = box.max.y;
    plinth.localToWorld(_local);
    _toward.set(_cam.x - _local.x, 0, _cam.z - _local.z);
    if (_toward.lengthSq() > 1e-8) _toward.normalize();
    this.group.position.set(_local.x + _toward.x * 0.05, _local.y + NEAR_FIELD_STRIP_HEIGHT_M / 2 + 0.01, _local.z + _toward.z * 0.05);
    this.group.lookAt(_cam.x, this.group.position.y, _cam.z);
    this.group.rotateX(-0.6); // tilt back toward the viewer's eyes
    this.group.updateMatrixWorld(true);
  }

  /** Strip-local point (metres) to UV, or null when outside the strip. */
  public localToUV(local: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 | null {
    const u = local.x / NEAR_FIELD_STRIP_WIDTH_M + 0.5, v = local.y / NEAR_FIELD_STRIP_HEIGHT_M + 0.5;
    if (u < 0 || u > 1 || v < -0.15 || v > 1.15) return null;
    return out.set(u, Math.min(1, Math.max(0, v)));
  }

  public onPointerHover(uv: THREE.Vector2): void {
    const target = nearFieldTargetAt(uv.x, uv.y);
    if (target !== this.hover) { this.hover = target; this.draw(); }
  }

  public onPointerLeave(): void { if (this.hover) { this.hover = null; this.draw(); } }

  /** Returns true when a control was pressed. */
  public onPointerClick(uv: THREE.Vector2, pointerId = 'default'): boolean {
    const target = nearFieldTargetAt(uv.x, uv.y);
    if (target === 'prev') this.actions.previousLandmark();
    else if (target === 'play') this.actions.togglePlay();
    else if (target === 'next') this.actions.nextLandmark();
    else if (target === 'scrub') { this.scrubOwner = pointerId; this.actions.scrub(nearFieldScrubProgress(uv.x)); }
    return target !== null;
  }

  public onPointerDrag(uv: THREE.Vector2, pointerId = 'default'): void {
    if (this.scrubOwner === pointerId) this.actions.scrub(nearFieldScrubProgress(uv.x));
  }

  public onPointerRelease(pointerId = 'default'): void { if (this.scrubOwner === pointerId) this.scrubOwner = null; }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 28); ctx.fill();
    const button = (target: NearFieldTarget, u0: number, u1: number, glyph: string) => {
      ctx.fillStyle = this.hover === target ? 'rgba(56, 189, 248, 0.55)' : 'rgba(51, 65, 85, 0.9)';
      ctx.beginPath(); ctx.roundRect(u0 * W + 6, 10, (u1 - u0) * W - 12, H - 20, 20); ctx.fill();
      ctx.fillStyle = '#f8fafc'; ctx.font = 'bold 64px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph, (u0 + u1) / 2 * W, H / 2 + 2);
    };
    button('prev', 0, 0.14, '⏮');
    button('play', 0.15, 0.29, this.playing ? '⏸' : '▶');
    button('next', 0.30, 0.44, '⏭');
    const x0 = SCRUB_START * W, x1 = SCRUB_END * W, y = H / 2;
    ctx.fillStyle = this.hover === 'scrub' ? 'rgba(148, 163, 184, 0.9)' : 'rgba(100, 116, 139, 0.9)';
    ctx.beginPath(); ctx.roundRect(x0, y - 9, x1 - x0, 18, 9); ctx.fill();
    const px = x0 + (x1 - x0) * Math.min(1, Math.max(0, this.progress));
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath(); ctx.roundRect(x0, y - 9, px - x0, 18, 9); ctx.fill();
    ctx.beginPath(); ctx.arc(px, y, 30, 0, Math.PI * 2); ctx.fill();
    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}
