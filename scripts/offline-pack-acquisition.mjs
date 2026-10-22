import { setTimeout as delay } from 'node:timers/promises';
import { readBoundedBlob } from '../src/terrain/PersistentResourceCache.ts';

function temporary(error) {
  return error.retryable ?? (error instanceof TypeError || error.name === 'TimeoutError');
}

/** Only reorder the resource's existing approved aliases. A failed export
 * service cools down across requests; no source is removed from the fallback. */
export class OfflineSourceHealth {
  constructor(now = Date.now, cooldownMs = 120000) { this.now = now; this.cooldownMs = cooldownMs; this.failures = new Map(); }
  key(url) { const u = new URL(url); return u.origin + u.pathname; }
  order(urls) {
    const now = this.now();
    return [...urls].sort((a, b) => Number((this.failures.get(this.key(a)) ?? 0) > now) - Number((this.failures.get(this.key(b)) ?? 0) > now));
  }
  failed(url, error) { if (temporary(error)) this.failures.set(this.key(url), this.now() + this.cooldownMs); }
  succeeded(url) { this.failures.delete(this.key(url)); }
}

/** Validate every retained alias before doing any network work. A cached
 * fallback must not depend on availability of the preferred remote service. */
export async function acquireOfflineResource(resource, signal, options) {
  const accepted = async (url, bytes, retained) => {
    signal?.throwIfAborted();
    await options.save(url, bytes, retained);
    signal?.throwIfAborted();
    return { bytes, url, sourceIndex: resource.urls.indexOf(url), retained };
  };
  for (const url of resource.urls) {
    signal?.throwIfAborted();
    const bytes = await options.readRetained(url);
    if (!bytes) continue;
    try { await options.validate(bytes); }
    catch (error) { signal?.throwIfAborted(); options.onFailure?.(url, error, true); continue; }
    return accepted(url, bytes, true);
  }
  if (!options.download) return undefined;
  for (const url of options.health?.order(resource.urls) ?? resource.urls) {
    signal?.throwIfAborted();
    let bytes;
    try { bytes = await options.download(url); }
    catch (error) { signal?.throwIfAborted(); options.health?.failed(url, error); options.onFailure?.(url, error, false); continue; }
    signal?.throwIfAborted();
    try { await options.validate(bytes); }
    catch (error) { signal?.throwIfAborted(); options.onFailure?.(url, error, false); continue; }
    options.health?.succeeded(url);
    return accepted(url, bytes, false);
  }
  return undefined;
}

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
      const retryable = temporary(error);
      if (!retryable || attempt === 3) throw error;
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs: retryMs, error: error.message });
      await sleep(retryMs, signal);
    }
  }
}
