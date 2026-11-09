import { PerformanceSessionRecorder, type ProfileCounters, type ProfileReport } from './PerformanceSessionRecorder.ts';
import { loadLastProfileReport, saveLastProfileReport, profileDownloadFilename } from './ProfileReportStore.ts';

/**
 * `?profile=1` performance session: recorder lifecycle, on-page Start/Stop/Download controls,
 * long-task observation, visibility pauses and on-device persistence of the last report.
 * Extracted from main.ts; the app supplies counters and the playback context.
 */
export class ProfileSession {
  public readonly recorder = new PerformanceSessionRecorder();
  private completed: ProfileReport | null = null;
  private savedOnDevice = false;
  private generation = 0;
  private controls: HTMLElement | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private suspended = false;
  private disposed = false;
  private readonly onPageHide = () => this.stop();
  private readonly onVisibilityChange = (): void => {
    if (!this.recorder.isRecording) return;
    const now = performance.now();
    if (document.visibilityState === 'hidden' && !this.suspended) {
      this.recorder.pause(now, this.counters());
      this.suspended = true;
    } else if (document.visibilityState !== 'hidden' && this.suspended) {
      this.recorder.mark(now, 'visibility-resume');
      this.suspended = false;
    }
  };

  constructor(private readonly counters: () => ProfileCounters, private readonly playbackContext: () => string) {}

  /** Recorder for phase timing this frame, or null when idle/suspended. */
  public get activeRecorder(): PerformanceSessionRecorder | null {
    return this.recorder.isRecording && !this.suspended ? this.recorder : null;
  }

  public get isRecording(): boolean { return this.recorder.isRecording; }

  public mark(label: string, detail?: string, at = performance.now()): void {
    this.recorder.mark(at, label, detail);
  }

  public markPlaybackContext(): void {
    if (this.recorder.isRecording) this.recorder.mark(performance.now(), 'playback-context', this.playbackContext());
  }

  public installControls(): void {
    const box = document.createElement('div');
    box.id = 'profile-controls';
    box.style.cssText = 'position:fixed;right:16px;top:100px;z-index:10000;display:flex;flex-wrap:wrap;max-width:calc(100vw - 32px);box-sizing:border-box;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;background:rgba(15,23,42,.94);color:#f1f5f9;font:12px system-ui,sans-serif;box-shadow:0 4px 16px #0005;';
    const status = document.createElement('span');
    status.id = 'profile-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Local profile ready';
    box.appendChild(status);
    for (const [label, id, action] of [
      ['Start', 'profile-start', () => this.start()],
      ['Stop', 'profile-stop', () => this.stop()],
      ['Download JSON', 'profile-download', () => this.download()],
    ] as const) {
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'padding:5px 8px;border:1px solid #64748b;border-radius:6px;background:#334155;color:white;cursor:pointer;';
      button.addEventListener('click', action);
      box.appendChild(button);
    }
    document.body.appendChild(box);
    this.controls = box;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    this.updateControls();
    void this.restore();
  }

  public start(): void {
    if (this.recorder.isRecording) return;
    this.generation++;
    this.completed = null;
    this.savedOnDevice = false;
    this.recorder.start(performance.now(), __APP_BUILD_INFO__.id, navigator.userAgent);
    this.markPlaybackContext();
    this.suspended = false;
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      try {
        this.longTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) this.recorder.recordLongTask(entry.duration);
        });
        this.longTaskObserver.observe({ type: 'longtask' });
      } catch { this.longTaskObserver = null; }
    }
    this.updateControls();
  }

  public stop(): void {
    if (!this.recorder.isRecording) return;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    this.completed = this.recorder.stop(performance.now(), this.counters());
    this.savedOnDevice = false;
    const generation = ++this.generation;
    const report = this.completed;
    if (report) void saveLastProfileReport(report).then(saved => {
      if (this.disposed || generation !== this.generation || this.completed !== report) return;
      this.savedOnDevice = saved;
      this.updateControls();
    });
    this.suspended = false;
    this.updateControls();
  }

  /** Per-frame bookkeeping after rendering: records the frame or pauses while hidden. */
  public endFrame(timestamp: number, frameStart: number, now: number, visible: boolean, label: string, hz: number | null): void {
    if (!this.recorder.isRecording) return;
    if (visible) {
      if (this.suspended) {
        this.recorder.mark(now, 'visibility-resume');
        this.suspended = false;
        return;
      }
      this.recorder.recordFrame(timestamp, now - frameStart, label, hz);
      if (this.recorder.due) this.recorder.captureWindow(now, this.counters());
    } else if (!this.suspended) {
      this.recorder.pause(now, this.counters());
      this.suspended = true;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.controls?.remove();
    this.controls = null;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
  }

  private async restore(): Promise<void> {
    const generation = this.generation;
    const report = await loadLastProfileReport();
    if (this.disposed || generation !== this.generation || this.recorder.isRecording || this.completed || !report) return;
    this.completed = report;
    this.savedOnDevice = true;
    this.updateControls();
  }

  private updateControls(): void {
    if (!this.controls) return;
    const recording = this.recorder.isRecording;
    const status = this.controls.querySelector<HTMLElement>('#profile-status');
    if (status) {
      const report = this.completed;
      status.textContent = recording ? 'Recording locally' : report
        ? `${this.savedOnDevice ? 'Saved on this device' : 'Ready to download'} · ${report.windows.length} windows · ${report.buildId.split('-')[0]}`
        : 'Local profile ready';
      status.title = report?.buildId ?? '';
    }
    const start = this.controls.querySelector<HTMLButtonElement>('#profile-start');
    const stop = this.controls.querySelector<HTMLButtonElement>('#profile-stop');
    const download = this.controls.querySelector<HTMLButtonElement>('#profile-download');
    if (start) { start.disabled = recording; start.style.opacity = recording ? '0.45' : '1'; }
    if (stop) { stop.disabled = !recording; stop.style.opacity = recording ? '1' : '0.45'; }
    if (download) { download.disabled = !this.completed; download.style.opacity = this.completed ? '1' : '0.45'; }
  }

  private download(): void {
    if (!this.completed) return;
    const blob = new Blob([JSON.stringify(this.completed, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = profileDownloadFilename(this.completed);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
