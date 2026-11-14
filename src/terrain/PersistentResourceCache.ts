import { isSwissImageryURL, checkSwissImageryRevision, getSwissImageryRevision } from './providers/SwissImagery.ts';
import { OfflineStore } from '../offline/OfflineStore.ts';

const DATABASE = 'trekviewer-resources-v1';
const LIMIT_BYTES = 256 * 1024 * 1024;
const LIMIT_ENTRIES = 4096;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFERENCE = 'trekviewer-resource-cache-enabled';
interface Metadata { key: string; bytes: number; created: number; accessed: number; expires: number }
interface Pending { blob: Blob; generation: number }

/** Only sources whose local reuse has been reviewed. Optional commercial/keyed
 * services are excluded unless their terms and key handling are added explicitly. */
export function persistentResourceAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) return false;
    if ([...u.searchParams.keys()].some(k => /token|key|api|auth|signature|credential/i.test(k))) return false;
    const p = u.pathname;
    if (isSwissImageryURL(url)) return true;
    if (u.hostname === 'elevation.nationalmap.gov') return p === '/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
    if (u.hostname === 'imagery.nationalmap.gov') return /^\/arcgis\/rest\/services\/USGSNAIP(?:Plus|Imagery)\/ImageServer\/exportImage$/.test(p);
    if (u.hostname === 'imagery.geoplatform.gov') return p === '/iipp/rest/services/NAIP/NAIP_plus/ImageServer/exportImage';
    if (u.hostname === 'basemap.nationalmap.gov') return /^\/arcgis\/rest\/services\/(?:USGSImageryOnly|USGSTopo)\/MapServer\/(?:export|tile\/\d+\/\d+\/\d+)$/.test(p);
    if (u.hostname === 'carto.nationalmap.gov') return p === '/arcgis/rest/services/geonames/MapServer/export';
    if (u.hostname === 'tiles.maps.eox.at') return /^\/wmts\/1\.0\.0\/s2cloudless-2025_3857\/default\/g\/\d+\/\d+\/\d+\.jpg$/.test(p);
    if ((u.hostname === 'server.arcgisonline.com' || u.hostname === 'services.arcgisonline.com')
      && /^\/arcgis\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/i.test(p)) return true;
    if (u.hostname === 's3.amazonaws.com') return /^\/elevation-tiles-prod\/terrarium\/\d+\/\d+\/\d+\.png$/.test(p);
  } catch { /* Invalid URLs do not enter persistent storage. */ }
  return false;
}

/** Compressed source bytes, separate from decoded-image/GPU budgets. Best effort:
 * no storage prompt, no prefetch, no wait for disk writes in the loading path. */
export class PersistentResourceCache {
  private static database: Promise<IDBDatabase | null> | null = null;
  private static pending = new Map<string, Pending>();
  private static pendingBytes = 0;
  private static writeTimer: ReturnType<typeof setTimeout> | undefined;
  private static writes: Promise<void> = Promise.resolve();
  private static generation = 0;
  private static enabled: boolean | undefined;
  private static writeFailed = false;
  private static storageReady: boolean | null = null;
  private static counters = { hits: 0, misses: 0, writes: 0, bytes: 0, entries: 0 };
  /** Reads are read-only; their access-time updates and stale-entry deletions wait for the next flush. */
  private static pendingAccess = new Map<string, number>();
  private static pendingDeletes = new Set<string>();
  /** counters.bytes/entries match the database (set by a full scan), so a flush can skip getAll(). */
  private static totalsKnown = false;
  private static scheduleFlush(): void {
    if (!this.writeTimer) this.writeTimer = setTimeout(() => { this.writeTimer = undefined; void this.flush(); }, 250);
  }

  public static getGeneration(): number { return this.generation; }
  public static isEnabled(): boolean {
    if (this.enabled === undefined) {
      try { this.enabled = localStorage.getItem(PREFERENCE) !== '0'; } catch { this.enabled = true; }
    }
    return this.enabled;
  }
  public static isAvailable(): boolean { return typeof indexedDB !== 'undefined'; }
  public static getStats() { return { ...this.counters, enabled: this.isEnabled(), available: this.isAvailable(), storageReady: this.storageReady, writeFailed: this.writeFailed, maxBytes: LIMIT_BYTES }; }

  public static setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.generation++;
    this.pending.clear(); this.pendingBytes = 0;
    try { localStorage.setItem(PREFERENCE, enabled ? '1' : '0'); } catch { /* Session setting still applies. */ }
  }

  private static open(): Promise<IDBDatabase | null> {
    if (!this.isAvailable()) return Promise.resolve(null);
    if (!this.database) this.database = new Promise(resolve => {
      let settled = false;
      const finish = (db: IDBDatabase | null) => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timer); this.storageReady = !!db; resolve(db); };
      const timer = setTimeout(() => finish(null), 500);
      try {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('bodies');
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.database = null; };
          finish(db);
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch { finish(null); }
    });
    return this.database;
  }

  public static async read(url: string): Promise<Blob | null> {
    const pinned = await OfflineStore.read(url);
    if (pinned) return pinned;
    if (!this.isEnabled() || !persistentResourceAllowed(url)) return null;
    const generation = this.generation;
    if (isSwissImageryURL(url)) {
      const revision = await checkSwissImageryRevision();
      if (!revision) return null;
      url += `#swiss-${revision}`;
    }
    const db = await this.open();
    if (!db || generation !== this.generation) return null;
    const blob = await new Promise<Blob | null>(resolve => {
      let done = false;
      let tx: IDBTransaction | undefined;
      const finish = (value: Blob | null) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Completed already. */ } finish(null); }, 150);
      try {
        // Read-only: never serialize tile reads behind cache writes.
        tx = db.transaction(['bodies', 'metadata'], 'readonly');
        const metadata = tx.objectStore('metadata'), bodies = tx.objectStore('bodies');
        const request = metadata.get(url);
        let value: Blob | null = null;
        request.onsuccess = () => {
          const entry = request.result as Metadata | undefined;
          if (!entry) return;
          if (entry.expires <= Date.now()) { this.pendingDeletes.add(url); return; }
          const body = bodies.get(url);
          body.onsuccess = () => {
            if (body.result instanceof Blob && body.result.size === entry.bytes) {
              value = body.result; this.pendingAccess.set(url, Date.now());
            } else this.pendingDeletes.add(url);
          };
        };
        tx.oncomplete = () => finish(value);
        tx.onerror = tx.onabort = () => finish(null);
      } catch { finish(null); }
    });
    if (generation !== this.generation) return null;
    if (blob) this.counters.hits++; else this.counters.misses++;
    if (this.pendingAccess.size || this.pendingDeletes.size) this.scheduleFlush();
    return blob;
  }

  public static write(url: string, blob: Blob, generation = this.generation): void {
    if (generation !== this.generation || !this.isEnabled() || this.writeFailed || !this.isAvailable()
      || !persistentResourceAllowed(url) || !blob.size || blob.size > 32 * 1024 * 1024) return;
    if (isSwissImageryURL(url)) {
      const revision = getSwissImageryRevision(); if (!revision) return;
      url += `#swiss-${revision}`;
    }
    // Bound queued source bytes as well as committed disk use.
    this.pendingBytes -= this.pending.get(url)?.blob.size ?? 0;
    this.pending.delete(url);
    while (this.pending.size && (this.pending.size >= 32 || this.pendingBytes + blob.size > 32 * 1024 * 1024)) {
      const key = this.pending.keys().next().value!;
      this.pendingBytes -= this.pending.get(key)!.blob.size; this.pending.delete(key);
    }
    this.pending.set(url, { blob, generation }); this.pendingBytes += blob.size;
    this.scheduleFlush();
  }

  public static async flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined; }
    // Only one batch may wait for an existing transaction. Further arrivals stay
    // in the bounded pending map, rather than retaining unbounded blob snapshots.
    if (!this.pending.size && !this.pendingAccess.size && !this.pendingDeletes.size) { await this.writes; return; }
    const generation = this.generation;
    this.writes = this.writes.then(async () => {
      if (generation !== this.generation || !this.isEnabled() || this.writeFailed) return;
      const batch = new Map(this.pending); this.pending.clear(); this.pendingBytes = 0;
      const access = new Map(this.pendingAccess); this.pendingAccess.clear();
      const deletes = new Set(this.pendingDeletes); this.pendingDeletes.clear();
      if (!batch.size && !access.size && !deletes.size) return;
      const db = await this.open(); if (!db || generation !== this.generation) return;
      let incoming = 0; for (const item of batch.values()) incoming += item.blob.size;
      // A full scan is needed only before the first totals are known or when the batch may
      // push the cache over its limits (LRU eviction); otherwise update the running totals.
      if (this.totalsKnown && this.counters.bytes + incoming <= LIMIT_BYTES && this.counters.entries + batch.size < LIMIT_ENTRIES) {
        await this.flushIncremental(db, generation, batch, access, deletes);
        return;
      }
      for (const key of deletes) access.delete(key);
      await new Promise<void>(resolve => {
        let tx: IDBTransaction | undefined;
        const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Finished. */ } resolve(); }, 2000);
        const finish = () => { clearTimeout(timer); resolve(); };
        try {
          tx = db.transaction(['bodies', 'metadata'], 'readwrite');
          const metadata = tx.objectStore('metadata'), bodies = tx.objectStore('bodies');
          const request = metadata.getAll();
          let bytes = 0, entries = 0, written = 0;
          request.onsuccess = () => {
            if (generation !== this.generation) { tx?.abort(); return; }
            const now = Date.now();
            const retained = (request.result as Metadata[]).filter(entry => {
              if (entry.expires <= now || batch.has(entry.key) || deletes.has(entry.key)) { metadata.delete(entry.key); bodies.delete(entry.key); return false; }
              const accessed = access.get(entry.key);
              if (accessed !== undefined) { entry.accessed = accessed; metadata.put(entry); }
              return true;
            }).sort((a, b) => a.accessed - b.accessed);
            bytes = retained.reduce((total, entry) => total + entry.bytes, 0); entries = retained.length;
            for (const [url, item] of batch) {
              if (item.generation !== this.generation) continue;
              while (retained.length && (bytes + item.blob.size > LIMIT_BYTES || entries >= LIMIT_ENTRIES)) {
                const victim = retained.shift()!; metadata.delete(victim.key); bodies.delete(victim.key); bytes -= victim.bytes; entries--;
              }
              if (bytes + item.blob.size > LIMIT_BYTES || entries >= LIMIT_ENTRIES) continue;
              bodies.put(item.blob, url); metadata.put({ key: url, bytes: item.blob.size, created: now, accessed: now, expires: now + TTL_MS } satisfies Metadata);
              bytes += item.blob.size; entries++; written++;
            }
          };
          tx.oncomplete = () => { this.counters.bytes = bytes; this.counters.entries = entries; this.totalsKnown = true; this.counters.writes += written; finish(); };
          tx.onerror = tx.onabort = () => { if (generation === this.generation) this.writeFailed = true; finish(); };
        } catch { this.writeFailed = true; finish(); }
      });
    }).catch(() => { this.writeFailed = true; });
    await this.writes;
  }

  /** Writes, access times and deletions applied with per-key requests, keeping the totals current. */
  private static flushIncremental(db: IDBDatabase, generation: number, batch: Map<string, Pending>,
    access: Map<string, number>, deletes: Set<string>): Promise<void> {
    return new Promise<void>(resolve => {
      let tx: IDBTransaction | undefined;
      const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Finished. */ } resolve(); }, 2000);
      const finish = () => { clearTimeout(timer); resolve(); };
      let bytes = this.counters.bytes, entries = this.counters.entries, written = 0;
      try {
        tx = db.transaction(['bodies', 'metadata'], 'readwrite');
        const metadata = tx.objectStore('metadata'), bodies = tx.objectStore('bodies');
        const now = Date.now();
        const forget = (key: string, after?: () => void) => {
          const request = metadata.get(key);
          request.onsuccess = () => {
            const entry = request.result as Metadata | undefined;
            if (entry) { metadata.delete(key); bodies.delete(key); bytes -= entry.bytes; entries--; }
            after?.();
          };
        };
        for (const key of deletes) if (!batch.has(key)) forget(key);
        for (const [key, accessed] of access) {
          if (deletes.has(key) || batch.has(key)) continue;
          const request = metadata.get(key);
          request.onsuccess = () => { const entry = request.result as Metadata | undefined; if (entry) metadata.put({ ...entry, accessed }); };
        }
        for (const [url, item] of batch) {
          if (item.generation !== this.generation) continue;
          forget(url, () => {
            bodies.put(item.blob, url);
            metadata.put({ key: url, bytes: item.blob.size, created: now, accessed: now, expires: now + TTL_MS } satisfies Metadata);
            bytes += item.blob.size; entries++; written++;
          });
        }
        tx.oncomplete = () => { this.counters.bytes = bytes; this.counters.entries = entries; this.counters.writes += written; finish(); };
        tx.onerror = tx.onabort = () => { if (generation === this.generation) this.writeFailed = true; this.totalsKnown = false; finish(); };
      } catch { this.writeFailed = true; finish(); }
    });
  }

  /** Drops a temporary-cache entry whose bytes failed to decode. Pinned offline packs are never
   * changed here; pass the failed blob so the offline store can check it against its hash. */
  public static async remove(url: string, failedBlob?: Blob): Promise<void> {
    if (failedBlob) await OfflineStore.reportDecodeFailure(failedBlob).catch(() => false);
    if (isSwissImageryURL(url)) {
      const revision = getSwissImageryRevision(); if (!revision) return;
      url += `#swiss-${revision}`;
    }
    this.pendingBytes -= this.pending.get(url)?.blob.size ?? 0; this.pending.delete(url);
    await this.writes;
    const db = await this.open(); if (!db) return;
    this.totalsKnown = false; // the next flush rescans rather than guess this entry's size
    try { const tx = db.transaction(['bodies', 'metadata'], 'readwrite'); tx.objectStore('bodies').delete(url); tx.objectStore('metadata').delete(url); } catch { /* Best effort. */ }
  }

  public static async clear(): Promise<boolean> {
    this.generation++; this.pending.clear(); this.pendingBytes = 0;
    this.pendingAccess.clear(); this.pendingDeletes.clear();
    await this.writes;
    const db = await this.open(); if (!db) return false;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 2000);
      const finish = (result: boolean) => { clearTimeout(timer); resolve(result); };
      try {
        const tx = db.transaction(['bodies', 'metadata'], 'readwrite');
        tx.objectStore('bodies').clear(); tx.objectStore('metadata').clear();
        tx.oncomplete = () => { this.writeFailed = false; this.counters.bytes = 0; this.counters.entries = 0; this.totalsKnown = true; finish(true); };
        tx.onerror = tx.onabort = () => finish(false);
      } catch { finish(false); }
    });
  }

  public static async refreshStats(): Promise<ReturnType<typeof this.getStats>> {
    const db = await this.open();
    if (db) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      try {
        const tx = db.transaction('metadata', 'readonly');
        const request = tx.objectStore('metadata').getAll();
        request.onsuccess = () => {
          this.counters.bytes = request.result.reduce((sum: number, entry: Metadata) => sum + entry.bytes, 0);
          this.counters.entries = request.result.length;
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(); };
      } catch { clearTimeout(timer); resolve(); }
    });
    return this.getStats();
  }
}

/** Enforce the byte cap while downloading, including chunked responses. */
export async function readBoundedBlob(response: Response, maxBytes: number): Promise<Blob> {
  if (!response.ok || response.type === 'opaque' || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new Error('Source response unavailable or too large');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob(); if (blob.size > maxBytes) throw new Error('Source response too large'); return blob;
  }
  const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Source response too large'); }
      chunks.push(chunk.value as Uint8Array<ArrayBuffer>);
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
}
