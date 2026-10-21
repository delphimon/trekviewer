/** Public-source diagnostics only; no resource keys or response bytes are retained. */
export function installResourceCacheAudit() {
  const transactions = new WeakMap();
  const stats = window.__resourceCacheAudit = { reads: 0, missing: 0, present: 0, expired: 0, validBody: 0,
    completedHits: 0, abortedWithValidBody: 0, aborted: 0, completed: 0, maxReadMs: 0, readMs: 0, writes: 0, maxWriteMs: 0 };
  const nativeTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = nativeTransaction.apply(this, args);
    if (this.name !== 'trekviewer-resources-v1') return tx;
    const row = { start: performance.now(), read: false, valid: false, write: false };
    transactions.set(tx, row);
    const finish = aborted => {
      const duration = performance.now() - row.start;
      if (row.read) {
        stats.readMs += duration; stats.maxReadMs = Math.max(stats.maxReadMs, duration);
        if (aborted) { stats.aborted++; if (row.valid) stats.abortedWithValidBody++; }
        else { stats.completed++; if (row.valid) stats.completedHits++; }
      }
      if (row.write) { stats.writes++; stats.maxWriteMs = Math.max(stats.maxWriteMs, duration); }
    };
    tx.addEventListener('complete', () => finish(false), { once: true });
    tx.addEventListener('abort', () => finish(true), { once: true });
    return tx;
  };
  const nativeGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...args) {
    const request = nativeGet.apply(this, args), row = transactions.get(this.transaction);
    if (!row) return request;
    if (this.name === 'metadata') {
      row.read = true; stats.reads++;
      request.addEventListener('success', () => {
        if (!request.result) stats.missing++;
        else if (request.result.expires <= Date.now()) stats.expired++;
        else stats.present++;
      }, { once: true });
    } else if (this.name === 'bodies') request.addEventListener('success', () => {
      if (request.result instanceof Blob) { stats.validBody++; row.valid = true; }
    }, { once: true });
    return request;
  };
  const nativeGetAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args) {
    const row = transactions.get(this.transaction);
    if (row && this.transaction.mode === 'readwrite') row.write = true;
    return nativeGetAll.apply(this, args);
  };
}
