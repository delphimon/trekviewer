import * as THREE from 'three';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface XRDebugInfo {
  isPresenting: boolean;
  isPassthrough: boolean;
  anchorState: string;
  headPos: THREE.Vector3;
  dioramaPos: THREE.Vector3;
  dioramaRotY: number;
  dioramaScale: number;
  dioramaVersion: number;
  hudPos: THREE.Vector3;
  viewMode: string;
  activeRouteId: string;
  loadingPhase: string;
  drawCalls: number;
  textures: number;
  fps: number;
}

export class XRDebugPanel {
  public readonly group: THREE.Group;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private texture: THREE.CanvasTexture;
  private mesh: THREE.Mesh;
  private lastUpdate: number = 0;
  private updateIntervalMs: number = 250; // 4Hz throttle to prevent GPU churn

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'XRDebugPanel';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 340;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    const geo = new THREE.PlaneGeometry(0.48, 0.32);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.group.add(this.mesh);
  }

  public update(info: XRDebugInfo, now: number): void {
    if (now - this.lastUpdate < this.updateIntervalMs) return;
    this.lastUpdate = now;

    if (!this.ctx) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Background
    ctx.fillStyle = 'rgba(10, 15, 29, 0.90)';
    ctx.fillRect(0, 0, w, h);

    // Border
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    // Title
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 20px monospace';
    ctx.fillText('XR Diagnostics (?debug=1)', 16, 28);

    // Metrics
    ctx.font = '14px monospace';
    let y = 56;
    const lineStep = 22;

    const xrModeStr = info.isPresenting ? (info.isPassthrough ? 'Passthrough AR' : 'Immersive VR') : 'Desktop';
    ctx.fillStyle = info.isPresenting ? '#4ade80' : '#94a3b8';
    ctx.fillText(`Mode: ${xrModeStr} | Anchor: ${info.anchorState}`, 16, y); y += lineStep;

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`Head: [${info.headPos.x.toFixed(2)}, ${info.headPos.y.toFixed(2)}, ${info.headPos.z.toFixed(2)}]`, 16, y); y += lineStep;

    ctx.fillStyle = '#38bdf8';
    const yawDeg = ((info.dioramaRotY * 180) / Math.PI).toFixed(1);
    ctx.fillText(`Diorama: [${info.dioramaPos.x.toFixed(2)}, ${info.dioramaPos.y.toFixed(2)}, ${info.dioramaPos.z.toFixed(2)}]`, 16, y); y += lineStep;
    ctx.fillText(`Yaw: ${yawDeg}° | Scale: ${info.dioramaScale.toExponential(2)} | V: ${info.dioramaVersion}`, 16, y); y += lineStep;

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`HUD: [${info.hudPos.x.toFixed(2)}, ${info.hudPos.y.toFixed(2)}, ${info.hudPos.z.toFixed(2)}]`, 16, y); y += lineStep;
    ctx.fillText(`View: ${info.viewMode} | Phase: ${info.loadingPhase}`, 16, y); y += lineStep;

    ctx.fillStyle = '#fbbf24';
    ctx.fillText(`Route: ${info.activeRouteId || 'none'}`, 16, y); y += lineStep;
    ctx.fillText(`XR LOD: Disabled (Baseline Stabilization)`, 16, y); y += lineStep;

    ctx.fillStyle = '#a78bfa';
    ctx.fillText(`FPS: ${info.fps.toFixed(0)} | DrawCalls: ${info.drawCalls} | Tex: ${info.textures}`, 16, y);

    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    disposeObject3D(this.group);
  }
}
