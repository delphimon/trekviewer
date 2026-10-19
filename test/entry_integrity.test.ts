import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { entryIntegrity } from '../scripts/entry-integrity.ts';

it('stamps the exact entry bytes and installs bounded recovery without replacing unrelated scripts', () => {
  const code = 'console.log("verified")', bundle: any = {
    'index.html': { type:'asset',source:'<script type="module" crossorigin src="./assets/index-test.js"></script><script src="/other.js"></script>' },
    'assets/index-test.js': {type:'chunk',isEntry:true,code},
  };
  const hook = entryIntegrity().generateBundle as any;
  hook.handler({},bundle);
  expect(bundle['index.html'].source).toContain(`integrity="sha384-${createHash('sha384').update(code).digest('base64')}"`);
  expect(bundle['index.html'].source).toContain('data-trek-entry="true"');
  expect(bundle['index.html'].source).toContain('attempt >= 2');
  expect(bundle['index.html'].source).toContain('<script src="/other.js"></script>');
});

it('fails the build if the entry cannot be matched rather than publishing an unchecked app', () => {
  const hook = entryIntegrity().generateBundle as any;
  expect(()=>hook.handler({},{'index.html':{type:'asset',source:'<script type="module" src="./missing.js"></script>'}})).toThrow('Expected one application entry');
});
