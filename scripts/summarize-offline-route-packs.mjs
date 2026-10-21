import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = process.env.TREK_PACK_ESTIMATE_OUT ?? '.review-cache/offline-packs';
const inventoryPath = path.join(root, 'inventory.json'), input = fs.readFileSync(inventoryPath), inventory = JSON.parse(input);
assert.equal(inventory.results.length, 8);
let browser;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  for (const route of inventory.results) {
    assert.equal(route.samples.length, 3, `Missing bounded samples for ${route.id}`);
    for (const sample of route.samples) {
      const bytes = fs.readFileSync(sample.file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
      sample.validation = await page.evaluate(async encoded => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let nonOpaquePixels = 0; const colors = new Set();
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) nonOpaquePixels++;
        for (let y = 0; y < image.height; y += 64) for (let x = 0; x < image.width; x += 64) {
          const offset = (y * image.width + x) * 4; colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
        }
        const result = { width: image.width, height: image.height, nonOpaquePixels, sampledUniqueColors: colors.size };
        image.close(); canvas.width = canvas.height = 1; return result;
      }, bytes.toString('base64'));
      assert.equal(sample.validation.nonOpaquePixels, 0, `NoData in ${route.id} Z${sample.zoom} sample`);
      assert.ok(sample.validation.sampledUniqueColors > 1, 'Blank imagery must not establish compression');
      delete sample.file; // Local ignored cache paths do not belong in the portable report.
    }
    const bpp = route.samples.map(s => s.bytes / 1024 ** 2), low = Math.min(...bpp) * 0.75, high = Math.max(...bpp) * 1.5;
    route.estimates = [];
    for (const maxZoom of [17, 18, 19]) for (const scope of ['full', 'corridor']) {
      const levels = route.imagery.filter(level => level.zoom <= maxZoom);
      const finePixels = levels.filter(level => level.zoom >= 17).reduce((sum, level) => sum + level[scope + 'Images'] * level.imageSide ** 2, 0);
      // Overview: reserve raw RGBA capacity instead of extrapolating fine-image entropy.
      const overviewBudget = levels.filter(level => level.zoom < 17).reduce((sum, level) => sum + level[scope + 'Images'] * level.imageSide ** 2 * 4, 0);
      const imageryLow = Math.ceil(finePixels * low + overviewBudget), imageryHigh = Math.ceil(finePixels * high + overviewBudget);
      const sourceBudget = route.terrain[scope].sourceFloat32Bytes;
      route.estimates.push({ maxZoom, scope, images: levels.reduce((sum, level) => sum + level[scope + 'Images'], 0),
        imageryBytes: { low: imageryLow, high: imageryHigh }, sourceFloat32Bytes: sourceBudget,
        planningBytes: { low: imageryLow + sourceBudget + route.gpxBytes, high: imageryHigh + sourceBudget + route.gpxBytes },
        optionalPreparedGeometryBytes: route.terrain[scope].preparedGeometryBytes });
    }
  }
} finally { await browser?.close(); }
const totals = [];
for (const maxZoom of [17, 18, 19]) for (const scope of ['full', 'corridor']) {
  const rows = inventory.results.map(route => route.estimates.find(row => row.scope === scope && row.maxZoom === maxZoom));
  const sum = select => rows.reduce((n, row) => n + select(row), 0);
  totals.push({ maxZoom, scope, imageryBytes: { low: sum(r => r.imageryBytes.low), high: sum(r => r.imageryBytes.high) },
    sourceFloat32Bytes: sum(r => r.sourceFloat32Bytes), planningBytes: { low: sum(r => r.planningBytes.low), high: sum(r => r.planningBytes.high) },
    optionalPreparedGeometryBytes: sum(r => r.optionalPreparedGeometryBytes) });
}
const report = { ...inventory, inputSha256: createHash('sha256').update(input).digest('hex'),
  compressedEstimateMethod: '24 real lossless 1024-square public-source images, one per fine zoom per route at track index fractions 0, 0.5, 1. All pixels fully opaque and sampled RGB nonblank in Chromium. For each route use 0.75 x smallest observed bytes/pixel through 1.5 x largest observed bytes/pixel for all fine levels, plus raw RGBA overview budget and uncompressed Float32 source budget. Planning range, not a statistical confidence interval or verified final archive size. No native-resolution proof. Summed independent routes are conservative; actual packs can share identical geographic imagery.',
  totalProbeBytes: inventory.results.reduce((s, r) => s + r.samples.reduce((n, sample) => n + sample.bytes, 0), 0), totals };
fs.writeFileSync(path.join(root, 'estimates.json'), JSON.stringify(report, null, 2) + '\n');
const gb = n => (n / 1e9).toFixed(2), range = r => `${gb(r.low)}–${gb(r.high)}`;
const lines = [
  '# Offline sizes for all eight bundled routes', '',
  `Calculated ${inventory.generatedAt}. **Planning estimates only; no route pack or installed offline app has been built.** Decimal GB (1 GB = 1,000,000,000 bytes).`, '',
  'These estimates preserve the current public imagery provider’s lossless PNG layout, sharing each 1024-square source image among sixteen child crops. “Full” covers the complete surrounding model (1.5 times track bounds, at least 1.5 km per axis). “Corridor” retains full-model Z13–16 overview and selects fine images/terrain tiles intersecting a buffer 1 km to each side of the actual track, without joining separate GPX segments. Whole boundary tiles are retained. This is a pack scope comparison; live High settings and coverage are unchanged.', '',
  `The bounded probe retained **${report.results.reduce((n, route) => n + route.samples.length, 0)} validated public-source images (${(report.totalProbeBytes / 1e6).toFixed(1)} MB)**. Every pixel is opaque and sampled colours are nonblank. Per route, fine imagery is budgeted at 75% of the smallest observed bytes/pixel through 150% of the largest, plus raw RGBA overview capacity. This deliberately broad planning range is not a confidence interval, a complete coverage check or a measured archive download. The small probe does not establish native source resolution.`, '',
  'Pack budgets below add the uncompressed one-metre requested Float32 elevation inventory and GPX, leaving elevation compression savings unclaimed. Exact source/imagery coverage and rights still need validation before baking. Optional prepared geometry is separate.', '',
  '| All eight routes | Full model | 1 km corridor + complete overview |',
  '|---|---:|---:|',
  ...[17, 18, 19].map(zoom => `| Imagery through Z${zoom} + elevation | ${range(totals.find(r => r.maxZoom === zoom && r.scope === 'full').planningBytes)} GB | ${range(totals.find(r => r.maxZoom === zoom && r.scope === 'corridor').planningBytes)} GB |`), '',
  'Z19 is the current maximum imagery request level. Z17/Z18 are explicit smaller pack options, not established equivalents in visual quality. A finer request can resample a coarser survey. A future source-native archive/pyramid bake could avoid storing redundant resampled pixels, but its size and visual parity must be measured.', '',
  '| Route | Full-model pack through Z19 | Corridor pack through Z19 |',
  '|---|---:|---:|',
  ...report.results.map(route => `| ${route.name} | ${range(route.estimates.find(r => r.maxZoom === 19 && r.scope === 'full').planningBytes)} GB | ${range(route.estimates.find(r => r.maxZoom === 19 && r.scope === 'corridor').planningBytes)} GB |`), '',
  '| Route | Model km (width × depth) | Raw elevation GB, full / corridor | Optional prepared geometry GB, full / corridor |',
  '|---|---:|---:|---:|',
  ...report.results.map(route => `| ${route.name} | ${route.modelWidthKm.toFixed(1)} × ${route.modelDepthKm.toFixed(1)} | ${gb(route.terrain.full.sourceFloat32Bytes)} / ${gb(route.terrain.corridor.sourceFloat32Bytes)} | ${gb(route.terrain.full.preparedGeometryBytes)} / ${gb(route.terrain.corridor.preparedGeometryBytes)} |`), '',
  `All-route raw elevation: **${gb(totals[0].sourceFloat32Bytes)} GB full / ${gb(totals[1].sourceFloat32Bytes)} GB corridor**. Optional prepared geometry: **${gb(totals[0].optionalPreparedGeometryBytes)} GB full / ${gb(totals[1].optionalPreparedGeometryBytes)} GB corridor**.`, '',
  'Terrain counts use current High Quest base-grid policy, approximately 5 m refinement meshes, exact tile footprints, four-metre source guards and endpoint-inclusive one-metre sampling. They describe a proposed offline baking inventory, not the production request format. Raw elevation preserves Float32 samples; one-metre export spacing does not certify one-metre native DEM coverage. Prepared geometry counts current position/normal/UV/height/index arrays for the Quest variant, not a full-resolution source archive. Desktop variants and finer future meshes are excluded.', '',
  'Budgets exclude optional label/topographic layers, source masks, small base-grid/manifest/index data, filesystem overhead, temporary staging/update copies and APK overhead. Reserve free space separately once the streaming installer is designed. Lossless compression may reduce elevation/geometry; PNG is already compressed. Do not assume a ZIP dramatically reduces imagery. The existing complete built website is approximately 7.8 MB before HTTP compression, including all bundled GPX files. Large map data should remain independently versioned and removable.', '',
  'These packs would avoid network tile acquisition while playing downloaded coverage. They still require bounded local reads, decoding and GPU residency. Prebuilding geometry may remove known rebuild work; it does not certify native frame rate. The first implementation should validate a bounded source-native sample, offline storage and network-disabled startup/tour before provisioning all routes.', '',
  'Machine-readable counts, public sample URLs, SHA-256 hashes, alpha checks and per-component estimates: [estimates.json](estimates.json). Reproduce from the repository with:', '',
  '```powershell', "$env:TREK_PACK_SAMPLE='1'", 'node --experimental-transform-types scripts/estimate-offline-route-packs.mjs', 'node scripts/summarize-offline-route-packs.mjs', '```', '',
  'The first command limits probing to three selected images per route, uses at most two concurrent requests and reuses URL-hashed local files. Failed requests may try permitted public fallback sources. No private provider credentials are read and no pack-scale acquisition occurs.', ''
];
fs.writeFileSync(path.join(root, 'SIZE_ESTIMATES.md'), lines.join('\n'));
console.log(JSON.stringify({ totalProbeBytes: report.totalProbeBytes, totals }));
