import type { OfflinePlan, OfflineResource } from './OfflinePlan.ts';
import { sameOfflineSource } from './OfflineSourceIdentity.ts';
declare const __OFFLINE_ROUTE_HASHES__: Record<string, string>;

export interface OfflinePackState {
  id: string; routeId: string; name: string; routeHash: string;
  state: 'paused' | 'downloading' | 'ready'; total: number; completed: number;
  bytes: number; estimatedBytes: number; message: string; updated: number;
}
export interface OfflineAsset {
  key: string; packId: string; urls: string[]; sourceUrl: string;
  blob: Blob; sha256: string; bytes: number;
}
export function offlineSourceAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || [...u.searchParams.keys()].some(k => /token|key|auth|signature|credential/i.test(k))) return false;
    if (u.hostname === 'elevation.nationalmap.gov') return u.pathname === '/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
    if (u.hostname === 'imagery.nationalmap.gov') return /^\/arcgis\/rest\/services\/USGSNAIP(?:Plus|Imagery)\/ImageServer\/exportImage$/.test(u.pathname);
    if (u.hostname === 'imagery.geoplatform.gov') return u.pathname === '/iipp/rest/services/NAIP/NAIP_plus/ImageServer/exportImage';
    return u.hostname === 'basemap.nationalmap.gov' && u.pathname === '/arcgis/rest/services/USGSImageryOnly/MapServer/export';
  } catch { return false; }
}
const DATABASE = 'trekviewer-offline-packs-v1';
export const offlineAssetKey = (packId: string, resource: OfflineResource) => packId + '\n' + resource.urls[0];
export async function hashOfflineBlob(blob: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
}

/** Pinned encoded resources; independent from TTL/LRU and Clear temporary cache.
 * One bounded Blob per transaction/read. Never enumerate all encoded bodies.
 * Only completely validated, atomically published packs enter the read path. */
export class OfflineStore {
  private static opening: Promise<IDBDatabase> | undefined;
  private static readyIds: Promise<Set<string>> | undefined;
  private static channel: BroadcastChannel | undefined;
  public static readonly events = new EventTarget();
  public static hits = 0;
  public static available(): boolean { return typeof indexedDB !== 'undefined'; }
  public static bundledHash(routeId: string): string | undefined {
    return typeof __OFFLINE_ROUTE_HASHES__ === 'undefined' ? undefined : __OFFLINE_ROUTE_HASHES__[routeId];
  }
  public static compatible(state: OfflinePackState): boolean {
    return typeof __OFFLINE_ROUTE_HASHES__ === 'undefined' || this.bundledHash(state.routeId) === state.routeHash;
  }
  private static notify(broadcast = true): void {
    this.readyIds = undefined; this.events.dispatchEvent(new Event('change'));
    if (broadcast) this.channel?.postMessage('change');
  }
  private static open(): Promise<IDBDatabase> {
    if (!this.available()) return Promise.reject(Error('Offline storage is unavailable in this browser.'));
    if (!this.opening) this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { done = true; reject(Error('Offline storage did not open. Close other TrekViewer tabs and retry.')); }, 5000);
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('packs', { keyPath: 'id' });
        const assets = request.result.createObjectStore('assets', { keyPath: 'key' });
        assets.createIndex('urls', 'urls', { multiEntry: true }); assets.createIndex('packId', 'packId');
      };
      request.onsuccess = () => {
        if (done) { request.result.close(); return; }
        done = true; clearTimeout(timer);
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = undefined; this.readyIds = undefined; };
        if (typeof BroadcastChannel !== 'undefined' && !this.channel) {
          this.channel = new BroadcastChannel(DATABASE); this.channel.onmessage = () => this.notify(false);
        }
        resolve(db);
      };
      request.onerror = request.onblocked = () => { if (!done) { done = true; clearTimeout(timer); reject(Error('Offline storage is blocked or unavailable.')); } };
    }).catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private static async transaction<T>(stores: string[], mode: IDBTransactionMode,
    work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode); let value: T;
      const timer = setTimeout(() => { try { tx.abort(); } catch {} }, 30000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? Error('Offline storage operation failed.')); };
      try { work(tx, result => { value = result; }); } catch (error) { tx.abort(); reject(error); }
    });
  }
  public static async list(): Promise<OfflinePackState[]> {
    return this.transaction(['packs'], 'readonly', (tx, done) => {
      const request = tx.objectStore('packs').getAll(); request.onsuccess = () => done(request.result);
    });
  }
  public static async state(id: string): Promise<OfflinePackState | undefined> {
    return this.transaction(['packs'], 'readonly', (tx, done) => {
      const request = tx.objectStore('packs').get(id); request.onsuccess = () => done(request.result);
    });
  }
  public static async putState(state: OfflinePackState): Promise<void> {
    await this.transaction<void>(['packs'], 'readwrite', tx => { tx.objectStore('packs').put(state); }); this.notify();
  }
  public static async stored(packId: string, resource: OfflineResource): Promise<OfflineAsset | undefined> {
    return this.transaction(['assets'], 'readonly', (tx, done) => {
      const request = tx.objectStore('assets').get(offlineAssetKey(packId, resource)); request.onsuccess = () => done(request.result);
    });
  }
  public static async save(pack: OfflinePackState, resource: OfflineResource, sourceUrl: string, blob: Blob, sha256: string): Promise<void> {
    if (!resource.urls.length || resource.urls.some(url => !offlineSourceAllowed(url)) || !offlineSourceAllowed(sourceUrl) || !sameOfflineSource(sourceUrl, resource.urls)
      || !blob.size || blob.size > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('Invalid offline source');
    await this.transaction<void>(['assets', 'packs'], 'readwrite', tx => {
      tx.objectStore('assets').put({ key: offlineAssetKey(pack.id, resource), packId: pack.id, urls: resource.urls,
        sourceUrl, blob, bytes: blob.size, sha256 } satisfies OfflineAsset);
      tx.objectStore('packs').put(pack);
    });
    this.notify();
  }
  public static async publish(plan: OfflinePlan, completed: number, bytes: number): Promise<void> {
    if (completed !== plan.resources.length) throw Error('Incomplete offline pack');
    // Counts are checked against the committed asset index in the same transaction
    // as the visibility transition. A paused download cannot expose its staging.
    await this.transaction<void>(['assets', 'packs'], 'readwrite', tx => {
      const count = tx.objectStore('assets').index('packId').count(plan.id);
      count.onsuccess = () => {
        if (count.result !== completed) { tx.abort(); return; }
        tx.objectStore('packs').put({ id: plan.id, routeId: plan.routeId, routeHash: plan.routeHash, name: plan.name,
          state: 'ready', total: completed, completed, bytes, estimatedBytes: plan.estimatedBytes,
          message: 'High satellite • full surrounding terrain • through Z19', updated: Date.now() } satisfies OfflinePackState);
      };
    });
    this.notify();
  }
  public static async read(url: string): Promise<Blob | null> {
    if (!this.available() || !offlineSourceAllowed(url)) return null;
    try {
      this.readyIds ??= this.list().then(rows => new Set(rows.filter(r => r.state === 'ready' && this.compatible(r)).map(r => r.id)));
      const ready = await this.readyIds; if (!ready.size) return null;
      const asset = await this.transaction<OfflineAsset | undefined>(['assets'], 'readonly', (tx, done) => {
        const request = tx.objectStore('assets').index('urls').openCursor(url);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { done(undefined); return; }
          if (ready.has(cursor.value.packId)) done(cursor.value); else cursor.continue();
        };
      });
      if (!asset) return null;
      if (asset.blob.size !== asset.bytes || await hashOfflineBlob(asset.blob) !== asset.sha256) { await this.invalidate(url); return null; }
      this.hits++; return asset.blob;
    } catch { this.readyIds = undefined; return null; }
  }
  public static async invalidate(url: string): Promise<void> {
    if (!this.available() || !offlineSourceAllowed(url)) return;
    await this.transaction<void>(['assets', 'packs'], 'readwrite', tx => {
      const request = tx.objectStore('assets').index('urls').openCursor(url);
      request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        const asset = cursor.value as OfflineAsset;
        const header = tx.objectStore('packs').get(asset.packId);
        header.onsuccess = () => {
          const state = header.result as OfflinePackState | undefined;
          if (state) tx.objectStore('packs').put({ ...state, state: 'paused', completed: Math.max(0, state.completed - 1),
            bytes: Math.max(0, state.bytes - asset.bytes), message: 'A saved source failed validation. Resume to repair.', updated: Date.now() });
        };
        cursor.delete(); cursor.continue();
      };
    });
    this.notify();
  }
  public static async remove(id: string): Promise<void> {
    // Caller holds the download lock. Existing pinned revisions remain available
    // until explicitly removed; normal source-cache clearing never calls this.
    await this.transaction<void>(['assets', 'packs'], 'readwrite', tx => {
      const request = tx.objectStore('assets').index('packId').openKeyCursor(id);
      request.onsuccess = () => { const cursor = request.result; if (cursor) { tx.objectStore('assets').delete(cursor.primaryKey); cursor.continue(); } };
      tx.objectStore('packs').delete(id);
    });
    this.notify();
  }
}
