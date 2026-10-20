export interface SharedRequest<T> {
  controller: AbortController;
  promise: Promise<T>;
  consumers: number;
  settled: boolean;
}

const aborted = () => new DOMException('Resource request aborted', 'AbortError');

/** Share a download until its last consumer leaves, then cancel its actual work. */
export function consumeSharedRequest<T>(
  requests: Map<string, SharedRequest<T>>, key: string,
  load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted());
  let request = requests.get(key);
  let start: (() => void) | undefined;
  if (!request) {
    const controller = new AbortController();
    const created: SharedRequest<T> = { controller, consumers: 0, settled: false, promise: undefined! };
    created.promise = new Promise<T>((resolve, reject) => {
      // Start eagerly, after registration, so priority accounting is available
      // to overview requests made in the same turn.
      start = () => {
        try { load(controller.signal).then(resolve, reject); }
        catch (error) { reject(error); }
      };
    }).finally(() => {
      created.settled = true;
      if (requests.get(key) === created) requests.delete(key);
    });
    request = created;
    requests.set(key, request);
  }
  const shared = request;
  shared.consumers++;
  const consumer = new Promise<T>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      signal?.removeEventListener('abort', onAbort);
      shared.consumers--;
      if (!shared.settled && shared.consumers === 0) {
        // A new consumer may immediately retry this key. Old completion must
        // neither own that new entry nor cancel its work.
        if (requests.get(key) === shared) requests.delete(key);
        shared.controller.abort();
      }
      return true;
    };
    const onAbort = () => { if (release()) reject(aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(value => {
      if (release()) shared.controller.signal.aborted ? reject(aborted()) : resolve(value);
    }, error => { if (release()) reject(shared.controller.signal.aborted ? aborted() : error); });
  });
  start?.();
  return consumer;
}

export function cancelSharedRequests<T>(requests: Map<string, SharedRequest<T>>): void {
  for (const request of requests.values()) request.controller.abort();
  requests.clear();
}
