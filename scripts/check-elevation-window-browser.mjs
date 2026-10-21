import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as Lerc from 'lerc';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_WINDOW_URL ?? 'https://127.0.0.1:4217/';
const out = process.env.TREK_WINDOW_OUT ?? '.review-cache/terrain-footprint/worker-local.json';
const build = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
const workerName = fs.readdirSync('dist/assets').find(name => /^TerrainWorker-.*\.js$/.test(name));
const workerHash = createHash('sha256').update(fs.readFileSync(path.join('dist/assets', workerName))).digest('hex');
const bytes = fs.readFileSync('test/fixtures/elevation/esri-california-nodata.lerc');
await Lerc.load({ locateFile: () => require.resolve('lerc/lerc-wasm.wasm') });
const decoded = Lerc.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const expected = Float32Array.from(decoded.pixels[0], (value, i) => decoded.mask && !decoded.mask[i] ? NaN : value);
const dataHash = createHash('sha256').update(new Uint8Array(expected.buffer)).digest('hex');
let browser, server;
try {
  if (!process.env.TREK_WINDOW_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4217', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4217')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(base + 'build-info.json', { waitUntil: 'domcontentloaded' });
  const actual = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json()); assert.equal(actual.id, build.id);
  const result = await page.evaluate(async ({ encoded, workerName }) => {
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const workerBytes = await (await fetch('assets/' + workerName)).arrayBuffer();
    const worker = new Worker('assets/' + workerName, { type: 'module' });
    const message = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('Worker timeout')); }, 10000);
      const receive = event => { cleanup(); resolve(event.data); };
      const fail = () => { cleanup(); reject(Error('Worker failed')); };
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', receive); worker.removeEventListener('error', fail); };
      worker.addEventListener('message', receive); worker.addEventListener('error', fail);
    });
    const rows = [];
    try {
      const ready = await message(); if (!ready.ready) throw Error('Missing worker handshake');
      for (const requiredWindow of [{ minX: 40, maxX: 104, minY: 8, maxY: 72 }, { minX: 0, maxX: 399, minY: 0, maxY: 399 }, { minX: -1, maxX: 2, minY: 0, maxY: 2 }]) {
        const buffer = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0)).buffer;
        const next = message(); worker.postMessage({ kind: 'lerc', input: { buffer, width: 400, height: 400, requiredWindow } }, [buffer]);
        const response = await next;
        if (response.error) rows.push({ requiredWindow, error: response.error.name, inputTransferred: buffer.byteLength === 0 });
        else rows.push({ requiredWindow, validCount: response.result.validCount, requiredValidCount: response.result.requiredValidCount,
          missing: response.result.data.reduce((n, value) => n + Number(Number.isNaN(value)), 0), dataHash: await hash(response.result.data.buffer), inputTransferred: buffer.byteLength === 0 });
      }
      return { workerHash: await hash(workerBytes), rows };
    } finally { worker.terminate(); }
  }, { encoded: bytes.toString('base64'), workerName });
  assert.equal(result.workerHash, workerHash);
  for (const row of result.rows.slice(0, 2)) { assert.equal(row.dataHash, dataHash); assert.equal(row.validCount, 58515); assert.equal(row.missing, 101485); }
  assert.equal(result.rows[0].requiredValidCount, 4225); assert.equal(result.rows[1].requiredValidCount, 58515);
  assert.equal(result.rows[2].error, 'RangeError'); assert.ok(result.rows.every(row => row.inputTransferred));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ condition: 'Exact built worker and genuine upstream NoData mask, transferred input/output buffers, bounded covered/missing/invalid windows. No app rendering or native headset claim.', build: actual, workerName, ...result }, null, 2) + '\n');
  console.log(JSON.stringify({ out, build: actual.id, workerHash, passed: true }));
} finally { await browser?.close(); server?.kill(); }
