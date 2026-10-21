/* Generated worker: each installed shell version is complete and immutable.
 * Deliberately no skipWaiting()/clients.claim(): updates wait for existing tabs
 * and XR sessions to close. Route packs are independent IndexedDB resources.
 */
const manifest = __TREK_SHELL_MANIFEST__;
const cacheName = 'trekviewer-shell-' + manifest.id;
const scope = self.registration.scope;
const paths = new Set(manifest.assets.map(asset => new URL(asset.path, scope).href));
const indexUrl = new URL('index.html', scope).href;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      for (const asset of manifest.assets) {
        const url = new URL(asset.path, scope).href;
        const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok || response.type === 'opaque') throw Error('Incomplete offline shell');
        const bytes = await response.clone().arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (hash !== asset.sha256) throw Error('Offline shell integrity mismatch');
        await cache.put(url, response);
      }
    } catch (error) { await caches.delete(cacheName); throw error; }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('trekviewer-shell-') && name !== cacheName) await caches.delete(name);
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url), root = new URL(scope);
  if (request.method !== 'GET' || url.origin !== root.origin) return;
  const canonical = url.origin + url.pathname;
  const navigation = request.mode === 'navigate' && (url.pathname === root.pathname || canonical === indexUrl);
  if (!navigation && !paths.has(canonical)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const response = await cache.match(navigation ? indexUrl : canonical);
    // A missing installed asset is a storage failure, never an HTML substitute
    // for a JS/WASM request. Let the normal entry recovery report the failure.
    return response ?? fetch(request);
  })());
});
