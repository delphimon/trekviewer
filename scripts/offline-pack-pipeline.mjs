/** PC-only preparation: a small ordered window bounds retained source bodies,
 * including completed results waiting behind a slow earlier request. */
export function offlineSourceConcurrency(value = '2') {
  if (!['1', '2'].includes(String(value))) throw Error('Choose --source-concurrency 1 or 2');
  return Number(value);
}

export async function* orderedOfflineSources(items, acquire, signal, concurrency = 2) {
  offlineSourceConcurrency(concurrency);
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending = new Map(); let next = 0, failed = false;
  const fill = () => {
    activeSignal.throwIfAborted();
    if (failed) return;
    while (pending.size < concurrency && next < items.length) {
      const index = next++;
      // Observe every rejection immediately, including later jobs that finish
      // while an earlier source is still in flight or the consumer is writing.
      pending.set(index, Promise.resolve().then(() => {
        activeSignal.throwIfAborted(); return acquire(items[index], index, activeSignal);
      }).then(value => ({ value }), error => { failed = true; return { error }; }));
    }
  };
  try {
    fill();
    for (let index = 0; index < items.length; index++) {
      let outcome = await pending.get(index);
      pending.delete(index);
      if ('error' in outcome) throw outcome.error;
      activeSignal.throwIfAborted();
      yield { index, value: outcome.value };
      outcome = undefined;
      fill();
    }
  } finally {
    controller.abort();
    // Finish cancellation before the owner tears down its browser or lock.
    await Promise.all(pending.values()); pending.clear();
  }
}

/** One production browser decode/coverage validator at a time, regardless of
 * network overlap. Cancellation prevents queued jobs from entering the browser. */
export function offlineValidationLane(validate) {
  let tail = Promise.resolve();
  return (resource, bytes, signal) => {
    const task = tail.then(async () => {
      signal?.throwIfAborted();
      await validate(resource, bytes);
      signal?.throwIfAborted();
    });
    tail = task.catch(() => {});
    return task;
  };
}
