import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAssetUrl } from '../src/utils/AssetUrl.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';

describe('Stage P: Deployment, Asset and Documentation Cleanup', () => {
  describe('Requirement #107: Asset URL Resolution with BASE_URL', () => {
    it('resolves asset paths for root hosting', () => {
      assert.strictEqual(resolveAssetUrl('/routes/manifest.json', '/'), '/routes/manifest.json');
      assert.strictEqual(resolveAssetUrl('routes/manifest.json', '/'), '/routes/manifest.json');
    });

    it('resolves asset paths for subpath hosting (e.g. GitHub Pages)', () => {
      assert.strictEqual(
        resolveAssetUrl('/routes/manifest.json', '/trekviewer/'),
        '/trekviewer/routes/manifest.json'
      );
      assert.strictEqual(
        resolveAssetUrl('routes/manifest.json', '/trekviewer'),
        '/trekviewer/routes/manifest.json'
      );
    });

    it('resolves relative base paths', () => {
      assert.strictEqual(resolveAssetUrl('/routes/manifest.json', './'), './routes/manifest.json');
      assert.strictEqual(resolveAssetUrl('routes/manifest.json', './'), './routes/manifest.json');
    });

    it('preserves external and scheme-specific URLs untouched', () => {
      assert.strictEqual(
        resolveAssetUrl('https://example.com/routes/test.gpx', '/trekviewer/'),
        'https://example.com/routes/test.gpx'
      );
      assert.strictEqual(
        resolveAssetUrl('http://cdn.com/asset.png', '/trekviewer/'),
        'http://cdn.com/asset.png'
      );
      assert.strictEqual(
        resolveAssetUrl('blob:http://localhost:5173/uuid-1234', '/trekviewer/'),
        'blob:http://localhost:5173/uuid-1234'
      );
      assert.strictEqual(
        resolveAssetUrl('data:text/plain;base64,mock', '/trekviewer/'),
        'data:text/plain;base64,mock'
      );
    });

    it('handles empty path gracefully', () => {
      assert.strictEqual(resolveAssetUrl('', '/trekviewer/'), '');
    });
  });

  describe('Requirements #108 & #110: Single Canonical Deploy Directory & No Duplicates', () => {
    it('verifies root /routes directory has been cleaned up', () => {
      assert.strictEqual(
        fs.existsSync('routes'),
        false,
        'Root /routes duplicate directory must not exist (public/routes is canonical)'
      );
    });

    it('verifies duplicate misspelled EnchantsmentsAndDragontail.gpx is removed', () => {
      assert.strictEqual(
        fs.existsSync('public/routes/EnchantsmentsAndDragontail.gpx'),
        false,
        'Misspelled EnchantsmentsAndDragontail.gpx must be deleted'
      );
      assert.strictEqual(
        fs.existsSync('public/routes/EnchantmentsAndDragontail.gpx'),
        true,
        'Canonical EnchantmentsAndDragontail.gpx must exist'
      );
    });
  });

  describe('Requirement #109: Normalized Filenames & Manifest Verification', () => {
    const manifestPath = path.resolve('public/routes/manifest.json');

    it('verifies manifest.json exists and is valid', () => {
      assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest.json must exist');
      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(content);
      assert.ok(Array.isArray(manifest));
      assert.ok(manifest.length >= 8, 'Manifest must contain at least 8 curated routes');
    });

    it('verifies every manifest entry points to an existing file with normalized names', () => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      for (const item of manifest) {
        assert.ok(item.id, `Item ${item.name} must have an id`);
        assert.ok(item.name, `Item ${item.id} must have a name`);
        assert.ok(item.file, `Item ${item.id} must have a file path`);
        assert.ok(item.region, `Item ${item.id} must have a region`);
        assert.ok(item.difficulty, `Item ${item.id} must have a difficulty`);
        assert.ok(item.description, `Item ${item.id} must have a description`);

        // Check file extension: must end with .gpx and have no double .gpx.gpx
        assert.ok(item.file.endsWith('.gpx'), `File path ${item.file} must end with .gpx`);
        assert.ok(!item.file.endsWith('.gpx.gpx'), `File path ${item.file} must not have double extension .gpx.gpx`);

        // Check relative file resolution on disk
        const relPath = item.file.startsWith('/') ? item.file.slice(1) : item.file;
        const diskPath = path.resolve('public', relPath);
        assert.ok(
          fs.existsSync(diskPath),
          `Manifest file for "${item.name}" must exist on disk: ${diskPath}`
        );

        // Verify GPX content is parseable
        const xml = fs.readFileSync(diskPath, 'utf8');
        const track = GPXParser.parse(xml, item.name);
        assert.ok(track.points.length > 0, `Route ${item.name} (${diskPath}) must contain track points`);
      }
    });
  });
});
