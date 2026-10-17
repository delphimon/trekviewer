import type { ProfileReport } from './PerformanceSessionRecorder.ts';

const DATABASE = 'trekviewer-profiles';
const STORE = 'reports';
const LATEST = 'latest';

function isReport(value: unknown): value is ProfileReport {
  const report = value as ProfileReport | null;
  return !!report && report.schemaVersion === 1 && report.measurement === 'webxr-callback-and-js-submission'
    && typeof report.buildId === 'string' && typeof report.userAgent === 'string'
    && Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.endedAt))
    && Array.isArray(report.windows) && report.windows.length > 0 && report.windows.length <= 1800
    && report.windows.every(window => window && Number.isFinite(window.elapsedSeconds))
    && Array.isArray(report.events) && report.events.length <= 128 && !!report.summary;
}

/** Only the latest completed opt-in report is retained; no per-frame writes. */
async function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) { database?.close(); return; }
      settled = true; resolve(database);
    };
    try {
      if (typeof indexedDB === 'undefined') { finish(null); return; }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch { finish(null); }
  });
}

export async function loadLastProfileReport(): Promise<ProfileReport | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise(resolve => {
    const finish = (report: ProfileReport | null) => { database.close(); resolve(report); };
    try {
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(LATEST);
      transaction.oncomplete = () => finish(isReport(request.result) ? request.result : null);
      transaction.onabort = transaction.onerror = () => finish(null);
    } catch { finish(null); }
  });
}

export async function saveLastProfileReport(report: ProfileReport): Promise<boolean> {
  if (!isReport(report)) return false;
  const database = await openDatabase();
  if (!database) return false;
  return new Promise(resolve => {
    const finish = (saved: boolean) => { database.close(); resolve(saved); };
    try {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.get(LATEST);
      let saved = false;
      request.onsuccess = () => {
        // Another tab may have finished a newer run while this one was asleep.
        if (isReport(request.result) && Date.parse(request.result.endedAt) > Date.parse(report.endedAt)) return;
        store.put(report, LATEST);
        saved = true;
      };
      transaction.oncomplete = () => finish(saved);
      transaction.onabort = transaction.onerror = () => finish(false);
    } catch { finish(false); }
  });
}

export function profileDownloadFilename(report: ProfileReport): string {
  const build = report.buildId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ended = report.endedAt.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `trekviewer-profile-${build}-${ended}.json`;
}
