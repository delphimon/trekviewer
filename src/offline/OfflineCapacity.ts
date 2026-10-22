// Source blobs are stored in their original encoded form. A raw-pixel planning
// budget is neither a measurement nor a reservation of browser quota.
const HEADROOM = 32 * 1024 * 1024;

/** Recheck shared origin usage before acquisition and before each new write.
 * Leave working/metadata headroom; IndexedDB remains the final quota authority.
 * Never evict another pack or treat an unknown quota as unlimited. */
export async function requireOfflineCapacity(encodedBytes = 0): Promise<void> {
  const storage = await navigator.storage?.estimate();
  if (!storage || !Number.isFinite(storage.quota) || !Number.isFinite(storage.usage)
    || storage.quota! <= 0 || storage.usage! < 0) throw Error('Browser storage capacity unavailable. Retry before downloading.');
  if (storage.quota! - storage.usage! < HEADROOM + Math.ceil(encodedBytes * 1.1)) {
    throw new DOMException('Browser storage is nearly full. Free space, then resume.', 'QuotaExceededError');
  }
}
