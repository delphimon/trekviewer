import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

const html = readFileSync('index.html', 'utf8');
const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
const directive = (name: string) => csp.split(';').map(part => part.trim()).find(part => part.startsWith(name + ' ')) ?? '';

it('never allows inline or eval script, only the build-time hash of the entry-recovery script', () => {
  const scripts = directive('script-src');
  expect(scripts).toContain("'self'");
  expect(scripts).not.toContain("'unsafe-inline'");
  expect(scripts).not.toMatch(/'unsafe-eval'/);
  expect(scripts).toContain('__TREK_ENTRY_RECOVERY_HASH__');
});

it('allows every imagery and elevation host the app requests', () => {
  const files = ['src/offline/OfflineStore.ts', 'src/offline/OfflineSourceIdentity.ts', 'src/terrain/TextureProvider.ts',
    ...readdirSync('src/terrain/providers').map(name => `src/terrain/providers/${name}`)];
  const hosts = new Set(files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]+)/g)].map(m => m[1])));
  hosts.add('elevation.nationalmap.gov'); hosts.add('s3.amazonaws.com'); // terrain sources outside providers/
  for (const host of hosts) {
    expect(directive('connect-src'), host).toContain(`https://${host}`);
    expect(directive('img-src'), host).toContain(`https://${host}`);
  }
});
