import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function checkNaipGapStorage(page, reportFile) {
  const fixture = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const encoded = fixture.samples.map(s => {
    const file = path.resolve(path.dirname(reportFile), s.file); assert.ok(fs.statSync(file).size <= 8 * 1024 * 1024);
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, s.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), s.sha256);
    return bytes.toString('base64');
  });
  assert.equal(fixture.samples[0].passed, false); assert.equal(fixture.samples[1].passed, true);
  return page.evaluate(async ({ resource, encoded, samples }) => {
    const h = window.__offlineTest, assert = (value, message) => { if (!value) throw Error(message); };
    const plan = { id: 'controlled-naip-gap-v2', routeId: 'controlled-naip-gap', routeHash: 'a'.repeat(64),
      name: 'Controlled real NAIP gap crop; not a complete route', version: 2, coverage: 'full-model', maxZoom: 19,
      estimatedBytes: 1024 * 1024 * 4, resources: [resource] };
    const blobs = encoded.map(value => new Blob([Uint8Array.from(atob(value), c => c.charCodeAt(0))], { type: 'image/png' }));
    const nativeFetch = window.fetch.bind(window), requests = []; let offline = false;
    window.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url, index = resource.urls.indexOf(url);
      if (index >= 0 && new Error().stack?.includes('/__offline-test/')) {
        assert(!offline, 'A ready alternate must not depend on network'); requests.push(index);
        return Promise.resolve(new Response(blobs[index]));
      }
      return nativeFetch(input, options);
    };
    try {
      await h.OfflineDownloads.start(plan);
      const state = await h.OfflineStore.state(plan.id), asset = await h.OfflineStore.stored(plan.id, resource);
      assert(state.state === 'ready' && state.completed === 1, 'The fully covered real alternate must publish');
      assert(JSON.stringify(requests) === '[0,1]', 'The masked primary must fail before the genuine complete alternate');
      assert(asset.sourceUrl === resource.urls[1] && asset.sha256 === samples[1].sha256, 'Actual GeoPlatform provenance and original bytes must remain intact');
      offline = true; h.PersistentResourceCache.setEnabled(false);
      for (const url of resource.urls) {
        const blob = await h.PersistentResourceCache.read(url);
        assert(blob && await h.hashOfflineBlob(blob) === samples[1].sha256, 'Each current alias must resolve pinned exact alternate bytes with temporary caching disabled');
      }
      const provider = { id: 'controlled-pinned-naip-source', displayName: 'Controlled real NAIP crop', attribution: '', maxZoom: 19,
        getTileUrls: () => resource.urls, getTileImageRegion: () => ({ x: 0, y: 0, width: 256, height: 256 }) };
      const cropped = await h.TileImageCache.loadTile(provider, 17, 0, 0);
      const renderedSource = h.getImagerySource(cropped);
      assert(renderedSource?.source === 'geoplatform-naip' && renderedSource.configuredAlternative === true, 'Rendered cropped pinned imagery must report its actual GeoPlatform source, not its lookup alias');
      assert(h.getImagerySource(await h.TileImageCache.loadTile(provider, 17, 0, 0)) === renderedSource, 'Decoded tile cache must retain actual source reporting');
      await h.PersistentResourceCache.clear(); await h.OfflineDownloads.start(plan);
      const after = await h.PersistentResourceCache.read(resource.urls[0]);
      assert(after && await h.hashOfflineBlob(after) === samples[1].sha256 && requests.length === 2, 'Temporary clear and ready resume must retain the exact original without source requests');
      return { condition: 'One real Rainier crop under a controlled identity, actual production IndexedDB/Canvas/worker helper. No full-route or native acceptance.',
        primaryMissingCoverageRejected: true, originalAlternateSha256: samples[1].sha256,
        originalAlternateBytes: blobs[1].size, approvedSourceIndicesRequested: requests,
        originalProvenancePreserved: true, renderedSource, pinnedAliasesWithNetworkDisabled: resource.urls.length, temporaryClearRetainsAlternate: true };
    } finally {
      window.fetch = nativeFetch; h.PersistentResourceCache.setEnabled(true);
      await h.OfflineDownloads.withLock(() => h.OfflineStore.remove(plan.id));
    }
  }, { resource: fixture.resource, encoded, samples: fixture.samples });
}
