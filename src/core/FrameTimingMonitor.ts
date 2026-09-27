export interface FrameTimingSnapshot {
  samples: number;
  averageFps: number | null;
  intervalP95Ms: number | null;
  intervalMaxMs: number | null;
  cpuP95Ms: number | null;
  targetHz: number | null;
  estimatedMissedCallbacks: number | null;
}

/** Bounded local diagnostics. Callback spacing and JS/render submission time are
 * not compositor/GPU timings and must not be reported as device frame delivery.
 */
export class FrameTimingMonitor {
  private readonly intervals: Float64Array;
  private readonly cpuTimes: Float64Array;
  private count = 0;
  private cursor = 0;
  private previousTimestamp: number | null = null;
  private context = '';
  private targetHz: number | null = null;

  constructor(capacity = 720) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Frame history capacity must be positive');
    this.intervals = new Float64Array(capacity);
    this.cpuTimes = new Float64Array(capacity);
  }

  public reset(): void {
    this.count = 0;
    this.cursor = 0;
    this.previousTimestamp = null;
  }

  public record(timestamp: number, cpuMs: number, context: string, targetHz: number | null): void {
    if (!Number.isFinite(timestamp) || !Number.isFinite(cpuMs) || cpuMs < 0) return;
    const hz = targetHz !== null && Number.isFinite(targetHz) && targetHz > 0 ? targetHz : null;
    if (context !== this.context || hz !== this.targetHz) {
      this.reset();
      this.context = context;
      this.targetHz = hz;
    }
    const previous = this.previousTimestamp;
    this.previousTimestamp = timestamp;
    if (previous === null) return;
    const interval = timestamp - previous;
    if (interval <= 0) { this.reset(); this.previousTimestamp = timestamp; return; }
    this.intervals[this.cursor] = interval;
    this.cpuTimes[this.cursor] = cpuMs;
    this.cursor = (this.cursor + 1) % this.intervals.length;
    this.count = Math.min(this.count + 1, this.intervals.length);
  }

  public snapshot(): FrameTimingSnapshot {
    if (!this.count) return {samples:0, averageFps:null, intervalP95Ms:null, intervalMaxMs:null,
      cpuP95Ms:null, targetHz:this.targetHz, estimatedMissedCallbacks:null};
    // Called once per second in debug mode; recording itself allocates nothing.
    const intervals = Array.from(this.intervals.subarray(0, this.count)).sort((a,b)=>a-b);
    const cpu = Array.from(this.cpuTimes.subarray(0, this.count)).sort((a,b)=>a-b);
    const p95 = Math.ceil(this.count * .95) - 1;
    const totalMs = intervals.reduce((sum,value)=>sum+value,0);
    const budget = this.targetHz === null ? null : 1000 / this.targetHz;
    return {
      samples:this.count, averageFps:1000 * this.count / totalMs,
      intervalP95Ms:intervals[p95], intervalMaxMs:intervals[this.count-1], cpuP95Ms:cpu[p95],
      targetHz:this.targetHz,
      estimatedMissedCallbacks:budget === null ? null : intervals.reduce((sum,ms)=>sum+Math.max(0,Math.round(ms/budget)-1),0),
    };
  }
}
