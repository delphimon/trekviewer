import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Inventory final, integrity-stamped output, including lazy workers/WASM and
 * public regional DEM/GPX assets. No source map, provider token or remote tiles.
 * The worker installs a complete version before activation; no forced takeover. */
export function offlineShell(buildId: string): Plugin {
  let output = '';
  return {
    name: 'trek-offline-shell', apply: 'build',
    configResolved(config) { output = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
      const assets = walk(output).filter(file => !/\.(?:map)$/.test(file) && !['sw.js', 'CNAME'].includes(path.basename(file)))
        .map(file => ({ path: path.relative(output, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
      const source = fs.readFileSync(new URL('./offline-worker.js', import.meta.url), 'utf8');
      fs.writeFileSync(path.join(output, 'sw.js'), source.replace('__TREK_SHELL_MANIFEST__', JSON.stringify({ id: buildId, assets })));
    },
  };
}
