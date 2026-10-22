import { setTimeout as delay } from 'node:timers/promises';
import { readBoundedBlob } from '../src/terrain/PersistentResourceCache.ts';

/** Retry transport/service failures only. Invalid or oversized source bodies
 * remain failures; retries never change the request, decoder or coverage. */
export async function acquireOfflineSource(url, maxBytes, signal, options = {}) {
  const fetchSource = options.fetchSource ?? fetch;
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    let retryMs = attempt * attempt * 2000;
    try {
      const response = await fetchSource(url, { credentials: 'omit', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000) });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) {
          const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000;
          if (Number.isFinite(seconds)) retryMs = Math.max(retryMs, Math.max(0, seconds * 1000));
        }
        await response.body?.cancel();
        const error = new Error(`Public source returned HTTP ${response.status}${retryMs > 30000 ? '; retry later' : ''}`);
        error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status) && retryMs <= 30000;
        throw error;
      }
      return Buffer.from(await (await readBoundedBlob(response, maxBytes)).arrayBuffer());
    } catch (error) {
      signal?.throwIfAborted();
      const retryable = error.retryable ?? (error instanceof TypeError || error.name === 'TimeoutError');
      if (!retryable || attempt === 3) throw error;
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs: retryMs, error: error.message });
      await sleep(retryMs, signal);
    }
  }
}
