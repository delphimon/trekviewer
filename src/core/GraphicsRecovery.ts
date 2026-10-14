interface GraphicsRecoveryOptions {
  canvas: EventTarget;
  isContextLost: () => boolean;
  pause: () => void | Promise<void>;
  prepare: () => Promise<void>;
  resume: () => void;
  status: (message: string, retry: boolean) => void;
}

type GraphicsState = 'initializing' | 'ready' | 'lost' | 'restoring' | 'failed' | 'disposed';

/** Coordinate application playback and shader preparation with the renderer's resource recovery. */
export class GraphicsRecovery {
  private state: GraphicsState = 'initializing';
  private generation = 0;
  private pauseTask: Promise<void> = Promise.resolve();
  private readonly waiters = new Set<{ ready: () => void; cancel: () => void }>();
  private readonly onLost = (event: Event) => {
    event.preventDefault();
    if (this.state === 'disposed') return;
    this.generation++;
    this.state = 'lost';
    // Pause synchronously before another animation callback or user action.
    try { this.pauseTask = Promise.resolve(this.options.pause()).catch(() => {}); }
    catch { this.pauseTask = Promise.resolve(); }
    this.options.status('Graphics paused. Waiting for the browser to restore the view…', false);
  };
  private readonly onRestored = () => { void this.recover(); };

  constructor(private readonly options: GraphicsRecoveryOptions) {
    options.canvas.addEventListener('webglcontextlost', this.onLost);
    options.canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  public get isSuspended(): boolean { return this.state !== 'ready'; }
  public get revision(): number { return this.generation; }

  public async recover(): Promise<void> {
    if (this.state === 'disposed' || this.state === 'restoring' || this.state === 'ready' || this.options.isContextLost()) return;
    const generation = ++this.generation;
    const initial = this.state === 'initializing';
    this.state = 'restoring';
    if (!initial) this.options.status('Restoring the view…', false);
    try {
      await this.pauseTask;
      if (generation !== this.generation) return;
      await this.options.prepare();
      if (generation !== this.generation || this.options.isContextLost()) return;
      this.state = 'ready';
      this.options.resume();
      this.options.status('', false);
      for (const waiter of this.waiters) waiter.ready();
    } catch {
      if (generation !== this.generation) return;
      this.state = 'failed';
      this.options.status('The view could not be restored. Try again.', true);
    }
  }

  /** Route work waits without committing an unprepared scene; aborted routes release their waiter. */
  public waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.state === 'disposed') return Promise.reject(new DOMException('Graphics preparation cancelled', 'AbortError'));
    if (this.state === 'ready' && !this.options.isContextLost()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener('abort', cancel); this.waiters.delete(waiter); };
      const cancel = () => { cleanup(); reject(new DOMException('Graphics preparation cancelled', 'AbortError')); };
      const waiter = { ready: () => { cleanup(); resolve(); }, cancel };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  public dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed'; this.generation++;
    this.options.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.options.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const waiter of this.waiters) waiter.cancel();
  }
}
