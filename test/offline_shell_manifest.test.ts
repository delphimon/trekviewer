import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { offlineShell } from '../scripts/offline-shell.ts';

let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

it('leaves dotfiles, source maps and CNAME out of the offline shell manifest', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-'));
  for (const f of ['index.html', 'assets/app.js', 'assets/app.js.map', '.DS_Store', 'assets/.hidden', 'CNAME']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f);
  }
  const plugin = offlineShell('test-build') as any;
  plugin.configResolved({ root: dir, build: { outDir: '.' } });
  plugin.closeBundle();
  const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
  const manifest = JSON.parse(sw.match(/const manifest = (\{.*?\});\n/s)![1]);
  expect(manifest.assets.map((a: { path: string }) => a.path).sort()).toEqual(['assets/app.js', 'index.html']);
});
