import { TextureBudget } from './TextureBudget.ts';

export interface ScheduledTask<T> {
  key: string;
  priority: number; // Smaller number = higher priority (closer to camera)
  loadFn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  signal?: AbortSignal;
}

export class TileRequestScheduler {
  private queue: ScheduledTask<HTMLImageElement>[] = [];
  private inFlightMap: Map<string, Promise<HTMLImageElement>> = new Map();
  private activeCount: number = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent?: number) {
    if (maxConcurrent !== undefined) {
      this.maxConcurrent = maxConcurrent;
    } else {
      this.maxConcurrent = TextureBudget.isQuestHeadset() ? 4 : 8;
    }
  }

  public schedule(
    key: string,
    priority: number,
    loadFn: () => Promise<HTMLImageElement>,
    signal?: AbortSignal
  ): Promise<HTMLImageElement> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Tile request aborted'));
    }

    // Deduplicate identical in-flight requests
    const existingPromise = this.inFlightMap.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    // Check if identical key is already queued: update its priority if higher
    const queued = this.queue.find((t) => t.key === key);
    if (queued) {
      if (priority < queued.priority) {
        queued.priority = priority;
      }
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const origResolve = queued.resolve;
        const origReject = queued.reject;
        queued.resolve = (val) => {
          origResolve(val);
          resolve(val);
        };
        queued.reject = (err) => {
          origReject(err);
          reject(err);
        };
      });
    }

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      this.queue.push({
        key,
        priority,
        loadFn,
        resolve,
        reject,
        signal,
      });
    });

    this.inFlightMap.set(key, promise);
    this.processQueue();
    return promise;
  }

  private processQueue(): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    // Sort queue by priority ascending (smallest number first)
    this.queue.sort((a, b) => a.priority - b.priority);

    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      if (task.signal?.aborted) {
        this.inFlightMap.delete(task.key);
        task.reject(new Error('Tile request aborted'));
        continue;
      }

      this.activeCount++;
      task.loadFn()
        .then((result) => {
          this.inFlightMap.delete(task.key);
          this.activeCount--;
          task.resolve(result);
          this.processQueue();
        })
        .catch((err) => {
          this.inFlightMap.delete(task.key);
          this.activeCount--;
          task.reject(err);
          this.processQueue();
        });
    }
  }

  public cancelPending(filter?: (key: string) => boolean): void {
    const remaining: ScheduledTask<HTMLImageElement>[] = [];
    for (const task of this.queue) {
      if (!filter || filter(task.key)) {
        this.inFlightMap.delete(task.key);
        task.reject(new Error('Tile request cancelled'));
      } else {
        remaining.push(task);
      }
    }
    this.queue = remaining;
  }

  public clear(): void {
    this.cancelPending();
    this.inFlightMap.clear();
    this.activeCount = 0;
  }

  public getStats(): { inFlight: number; queued: number } {
    return {
      inFlight: this.activeCount,
      queued: this.queue.length,
    };
  }
}
