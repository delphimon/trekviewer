import assert from 'node:assert';
import { describe, it } from 'vitest';
import { resolveAssetUrl } from '../src/main.ts';

describe('resolveAssetUrl', () => {
  it('handles external and data URLs without modification', () => {
    assert.strictEqual(
      resolveAssetUrl('https://example.com/route.gpx'),
      'https://example.com/route.gpx'
    );
    assert.strictEqual(
      resolveAssetUrl('http://example.com/route.gpx'),
      'http://example.com/route.gpx'
    );
    assert.strictEqual(
      resolveAssetUrl('blob:http://localhost/123-abc'),
      'blob:http://localhost/123-abc'
    );
    assert.strictEqual(
      resolveAssetUrl('data:text/plain;base64,AQID'),
      'data:text/plain;base64,AQID'
    );
  });

  it('resolves relative and root-relative paths cleanly', () => {
    const res1 = resolveAssetUrl('routes/manifest.json');
    assert.ok(res1.endsWith('/routes/manifest.json'), `Expected URL ending with /routes/manifest.json, got ${res1}`);

    const res2 = resolveAssetUrl('/routes/MountRainierViaEmmons.gpx');
    assert.ok(res2.endsWith('/routes/MountRainierViaEmmons.gpx'), `Expected URL ending with /routes/MountRainierViaEmmons.gpx, got ${res2}`);
  });
});
