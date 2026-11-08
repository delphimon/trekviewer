import type * as THREE from 'three';
import type { FrameTimingMonitor } from './FrameTimingMonitor.ts';

type FrameTimingSnapshot = ReturnType<FrameTimingMonitor['snapshot']>;

/** Values the app gathers once per second for `?debug=1`. */
export interface DebugTelemetrySnapshot {
  data: {
    frameTiming: FrameTimingSnapshot;
    isPresenting: boolean;
    viewMode: string;
    terrainQuality: string;
    dioramaPos: number[];
    dioramaRotY: number;
    dioramaScale: number;
    drawCalls: number;
    gpuTextures: number;
    tileCacheCount: number;
    tileCacheMB: number;
    lodReadyHighRes: string;
    lodCoveragePercent: number;
    lodZ19AheadM: number;
    lodResidentWarm: number;
    lodEvictionsTotal: number;
    localTerrainMode: string;
    localTerrainActive: boolean;
    localTerrainChunks: number;
    imageryActiveProvider: string;
    imageryRequestedProvider: string;
    imageryInitialized: boolean;
    imageryFallbackReason: string | null;
    sha: string;
    dirty: boolean;
    [key: string]: unknown;
  };
  lodVisible: string;
  hitRate: number;
  failures: number;
}

/**
 * `?debug=1` diagnostics: frame timing, diorama mutation counting, a 1 Hz console log and the
 * on-screen `#buildBadge`. Extracted from main.ts. The badge is built with textContent so
 * provider error text can never inject markup.
 */
export class DebugTelemetry {
  private lastLogAt = 0;
  private mutations = 0;
  private hasLast = false;
  private lastPosArr = [0, 0, 0];
  private lastRot = [0, 0, 0];
  private lastScale = [1, 1, 1];

  constructor(private readonly frameTiming: FrameTimingMonitor) {}

  public frame(timestamp: number, cpuMs: number, now: number, visible: boolean, label: string, refreshRate: number | null,
    diorama: THREE.Object3D, collect: (frameTiming: FrameTimingSnapshot, mutations: number) => DebugTelemetrySnapshot): void {
    if (visible) this.frameTiming.record(timestamp, cpuMs, label, refreshRate);
    else this.frameTiming.reset();
    this.countMutation(diorama);
    if (now - this.lastLogAt <= 1000) return;
    this.lastLogAt = now;
    const snapshot = collect(this.frameTiming.snapshot(), this.mutations);
    console.log('[TELEMETRY]', snapshot.data);
    this.renderBadge(snapshot);
  }

  private countMutation(diorama: THREE.Object3D): void {
    const p = diorama.position, r = diorama.rotation, s = diorama.scale;
    const changed = !this.hasLast
      || p.x !== this.lastPosArr[0] || p.y !== this.lastPosArr[1] || p.z !== this.lastPosArr[2]
      || r.x !== this.lastRot[0] || r.y !== this.lastRot[1] || r.z !== this.lastRot[2]
      || s.x !== this.lastScale[0] || s.y !== this.lastScale[1] || s.z !== this.lastScale[2];
    if (!changed) return;
    if (this.hasLast) this.mutations++;
    this.hasLast = true;
    this.lastPosArr = [p.x, p.y, p.z]; this.lastRot = [r.x, r.y, r.z]; this.lastScale = [s.x, s.y, s.z];
  }

  private renderBadge({ data, lodVisible, hitRate, failures }: DebugTelemetrySnapshot): void {
    const badge = typeof document !== 'undefined' ? document.getElementById('buildBadge') : null;
    if (!badge) return;
    const t = data.frameTiming;
    const fixed = (value: number | null | undefined) => value?.toFixed(1) ?? '—';
    const lines = [
      `${data.sha}${data.dirty ? ' (modified)' : ''} • ${data.isPresenting ? 'XR ON' : 'XR OFF'} • ${data.viewMode} • ${data.terrainQuality}`,
      `Pos: [${data.dioramaPos.join(', ')}] Rot: ${data.dioramaRotY} S: ${data.dioramaScale}`,
      `Callbacks: ${fixed(t.averageFps)}/s | p95: ${fixed(t.intervalP95Ms)} ms | CPU p95: ${fixed(t.cpuP95Ms)} ms`,
      `Target: ${t.targetHz ?? 'unknown'} Hz | Est. missed callbacks: ${t.estimatedMissedCallbacks ?? '—'} (not GPU timing)`,
      `Draw: ${data.drawCalls} | Tex: ${data.gpuTextures} | Cache: ${data.tileCacheCount} (${data.tileCacheMB} MB, hit: ${hitRate}%, fails: ${failures})`,
      `LOD: ${lodVisible} | Cov: ${data.lodCoveragePercent}% | Ahead: ${data.lodZ19AheadM}m | Ready: ${data.lodReadyHighRes} | Warm: ${data.lodResidentWarm} | Evict: ${data.lodEvictionsTotal}`,
      `Local DEM: ${data.localTerrainMode} (${data.localTerrainActive ? 'active' : 'hidden'}, ${data.localTerrainChunks} warm)`,
      `Imagery: ${data.imageryActiveProvider} (req: ${data.imageryRequestedProvider}, init: ${data.imageryInitialized}${data.imageryFallbackReason ? `, fallback: ${data.imageryFallbackReason}` : ''})`,
    ];
    badge.replaceChildren(...lines.map((text, index) => {
      const line = document.createElement('div');
      line.textContent = text;
      if (index === 0) { line.style.fontWeight = 'bold'; line.style.color = '#38bdf8'; }
      return line;
    }));
  }
}
