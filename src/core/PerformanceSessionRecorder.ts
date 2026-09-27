import { FrameTimingMonitor } from './FrameTimingMonitor';

export const PROFILE_PHASES = ['input', 'simulation', 'hud', 'imagery', 'imageryRaycast', 'imagerySelection', 'imageryReconcile', 'terrain', 'waypoints', 'render'] as const;
export type ProfilePhase = typeof PROFILE_PHASES[number];

export interface ProfileCounters {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  tileCacheEntries: number;
  tileCacheDecodedMB: number;
  imageryPatches: number;
  imageryCoveragePercent: number;
  imageryInFlight: number;
  localTerrainChunks: number;
  qualityProfile: string;
  viewMode: string;
  textureStyle: string;
  imageryProvider: string;
  routeName: string | null;
}

export interface ProfileWindow extends ProfileCounters {
  elapsedSeconds: number;
  durationSeconds: number;
  frames: number;
  callbackSamples: number;
  callbackHz: number | null;
  intervalP95Ms: number | null;
  intervalMaxMs: number | null;
  cpuSubmitP95Ms: number | null;
  cpuSubmitMaxMs: number;
  targetHz: number | null;
  estimatedMissedCallbacks: number | null;
  longTaskCount: number;
  longTaskMaxMs: number;
  phaseMeanMs: Record<ProfilePhase, number>;
  phaseMaxMs: Record<ProfilePhase, number>;
}

export interface ProfileReport {
  schemaVersion: 1;
  measurement: 'webxr-callback-and-js-submission';
  limitations: string[];
  startedAt: string;
  endedAt: string;
  buildId: string;
  userAgent: string;
  windowsDropped: number;
  events: { elapsedSeconds: number; name: string; value?: string }[];
  windows: ProfileWindow[];
  summary: {
    durationSeconds: number;
    callbackSamples: number;
    minWindowCallbackHz: number | null;
    maxCallbackIntervalMs: number;
    maxCpuSubmitMs: number;
    estimatedMissedCallbacks: number | null;
    maxDrawCalls: number;
    maxTextures: number;
    longTaskCount: number;
  };
}

/** Opt-in, bounded, local session trace. One aggregate per second; no per-frame objects. */
export class PerformanceSessionRecorder {
  private readonly timing = new FrameTimingMonitor(256);
  private readonly phaseTotals = new Float64Array(PROFILE_PHASES.length);
  private readonly phaseMax = new Float64Array(PROFILE_PHASES.length);
  private readonly windows: ProfileWindow[] = [];
  private readonly events: ProfileReport['events'] = [];
  private startTime = 0;
  private windowStart = 0;
  private startedAt = '';
  private buildId = '';
  private userAgent = '';
  private frameCount = 0;
  private cpuMax = 0;
  private longTaskCount = 0;
  private longTaskMax = 0;
  private windowsDropped = 0;
  private recording = false;
  private lastCounters: ProfileCounters | null = null;

  constructor(private readonly maxWindows = 1800) {
    if (!Number.isInteger(maxWindows) || maxWindows < 1) throw new Error('Window limit must be positive');
  }

  public get isRecording(): boolean { return this.recording; }
  public get hasSamples(): boolean { return this.windows.length > 0 || this.frameCount > 0; }
  public get windowCount(): number { return this.windows.length; }

  public start(now: number, buildId: string, userAgent: string, wallTime = new Date()): void {
    this.recording = true;
    this.startTime = now;
    this.windowStart = now;
    this.startedAt = wallTime.toISOString();
    this.buildId = buildId;
    this.userAgent = userAgent;
    this.windows.length = 0;
    this.events.length = 0;
    this.windowsDropped = 0;
    this.lastCounters = null;
    this.resetWindow();
    this.mark(now, 'profile-start');
  }

  public mark(now: number, name: string, value?: string): void {
    if (!this.recording) return;
    if (this.events.length >= 128) return;
    this.events.push({ elapsedSeconds: Math.max(0, (now - this.startTime) / 1000), name, ...(value ? { value } : {}) });
  }

  public recordPhase(phase: ProfilePhase, elapsedMs: number): void {
    if (!this.recording || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const index = PROFILE_PHASES.indexOf(phase);
    this.phaseTotals[index] += elapsedMs;
    this.phaseMax[index] = Math.max(this.phaseMax[index], elapsedMs);
  }

  public recordFrame(timestamp: number, cpuSubmitMs: number, context: string, targetHz: number | null): void {
    if (!this.recording || !Number.isFinite(timestamp) || !Number.isFinite(cpuSubmitMs) || cpuSubmitMs < 0) return;
    this.timing.record(timestamp, cpuSubmitMs, context, targetHz);
    this.frameCount++;
    this.cpuMax = Math.max(this.cpuMax, cpuSubmitMs);
  }

  public recordLongTask(durationMs: number): void {
    if (!this.recording || !Number.isFinite(durationMs) || durationMs < 0) return;
    this.longTaskCount++;
    this.longTaskMax = Math.max(this.longTaskMax, durationMs);
  }

  public get due(): boolean {
    return this.recording && this.frameCount > 0 && performance.now() - this.windowStart >= 1000;
  }

  public pause(now: number, counters?: ProfileCounters): void {
    if (!this.recording) return;
    if (this.frameCount > 0 && (counters || this.lastCounters)) this.captureWindow(now, counters ?? this.lastCounters!);
    this.timing.reset();
    this.windowStart = now;
    this.mark(now, 'visibility-pause');
  }

  public captureWindow(now: number, counters: ProfileCounters): void {
    if (!this.recording) return;
    this.lastCounters = counters;
    if (!this.frameCount) { this.windowStart = now; return; }
    const timing = this.timing.snapshot();
    const phaseMean = {} as Record<ProfilePhase, number>;
    const phaseMax = {} as Record<ProfilePhase, number>;
    for (let i = 0; i < PROFILE_PHASES.length; i++) {
      phaseMean[PROFILE_PHASES[i]] = this.phaseTotals[i] / this.frameCount;
      phaseMax[PROFILE_PHASES[i]] = this.phaseMax[i];
    }
    const sample: ProfileWindow = {
      ...counters,
      elapsedSeconds: Math.max(0, (now - this.startTime) / 1000),
      durationSeconds: Math.max(0, (now - this.windowStart) / 1000),
      frames: this.frameCount,
      callbackSamples: timing.samples,
      callbackHz: timing.averageFps,
      intervalP95Ms: timing.intervalP95Ms,
      intervalMaxMs: timing.intervalMaxMs,
      cpuSubmitP95Ms: timing.cpuP95Ms,
      cpuSubmitMaxMs: this.cpuMax,
      targetHz: timing.targetHz,
      estimatedMissedCallbacks: timing.estimatedMissedCallbacks,
      longTaskCount: this.longTaskCount,
      longTaskMaxMs: this.longTaskMax,
      phaseMeanMs: phaseMean,
      phaseMaxMs: phaseMax,
    };
    if (this.windows.length < this.maxWindows) this.windows.push(sample);
    else this.windowsDropped++;
    this.windowStart = now;
    this.resetWindow();
  }

  public stop(now: number, counters?: ProfileCounters, wallTime = new Date()): ProfileReport | null {
    if (!this.recording) return null;
    this.mark(now, 'profile-stop');
    if (this.frameCount > 0 && (counters || this.lastCounters)) this.captureWindow(now, counters ?? this.lastCounters!);
    this.recording = false;
    const windows = this.windows.slice();
    const estimated = windows.length > 0 && windows.every(w => w.estimatedMissedCallbacks !== null)
      ? windows.reduce((sum, w) => sum + (w.estimatedMissedCallbacks ?? 0), 0) : null;
    return {
      schemaVersion: 1,
      measurement: 'webxr-callback-and-js-submission',
      limitations: [
        'Callback spacing and JavaScript/render submission are not GPU time or compositor-delivered FPS.',
        'Missed callbacks are estimated from the reported XR refresh rate; use OVR Metrics Tool for device FPS, GPU time and thermal state.',
        'WebGL counts reflect the last rendered frame in each window; texture count is not total GPU memory.',
      ],
      startedAt: this.startedAt,
      endedAt: wallTime.toISOString(),
      buildId: this.buildId,
      userAgent: this.userAgent,
      windowsDropped: this.windowsDropped,
      events: this.events.slice(),
      windows,
      summary: {
        durationSeconds: Math.max(0, (now - this.startTime) / 1000),
        callbackSamples: windows.reduce((sum, w) => sum + w.callbackSamples, 0),
        minWindowCallbackHz: windows.reduce<number | null>((min, w) => w.callbackHz === null ? min : Math.min(min ?? Infinity, w.callbackHz), null),
        maxCallbackIntervalMs: Math.max(0, ...windows.map(w => w.intervalMaxMs ?? 0)),
        maxCpuSubmitMs: Math.max(0, ...windows.map(w => w.cpuSubmitMaxMs)),
        estimatedMissedCallbacks: estimated,
        maxDrawCalls: Math.max(0, ...windows.map(w => w.drawCalls)),
        maxTextures: Math.max(0, ...windows.map(w => w.textures)),
        longTaskCount: windows.reduce((sum, w) => sum + w.longTaskCount, 0),
      },
    };
  }

  private resetWindow(): void {
    this.timing.reset();
    this.phaseTotals.fill(0);
    this.phaseMax.fill(0);
    this.frameCount = 0;
    this.cpuMax = 0;
    this.longTaskCount = 0;
    this.longTaskMax = 0;
  }
}
