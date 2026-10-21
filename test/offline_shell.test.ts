import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { expect, it } from 'vitest';

const worker = fs.readFileSync('scripts/offline-worker.js', 'utf8');
async function fixture(corrupt = false) {
  const bytes = new TextEncoder().encode('verified app');
  const digest = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const stores = new Map<string, Map<string, Response>>([['trekviewer-shell-old', new Map()], ['unrelated-cache', new Map()]]);
  const events = new Map<string, (event: any) => void>(); let takeover = 0;
  const caches = { open: async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map()); const entries = stores.get(name)!;
    return { put: async (url: string, response: Response) => { entries.set(url, response); }, match: async (url: string) => entries.get(url) };
  }, keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) };
  const context = vm.createContext({ URL, Uint8Array, Set, Error, crypto: webcrypto, caches,
    fetch: async () => new Response(corrupt ? 'broken' : bytes),
    self: { registration: { scope: 'https://example.test/app/' }, addEventListener: (name: string, fn: (event: any) => void) => events.set(name, fn),
      skipWaiting: () => { takeover++; }, clients: { claim: () => { takeover++; } } } });
  vm.runInContext(worker.replace('__TREK_SHELL_MANIFEST__', JSON.stringify({ id: 'new', assets: [
    { path: 'index.html', sha256: digest }, { path: 'assets/worker.js', sha256: digest }] })), context);
  const dispatch = (name: string, input = {}) => {
    let promise: Promise<unknown> | undefined;
    events.get(name)!({ ...input, waitUntil: (p: Promise<unknown>) => { promise = p; }, respondWith: (p: Promise<unknown>) => { promise = p; } });
    return promise;
  };
  return { stores, dispatch, takeovers: () => takeover };
}
it('installs a complete verified version without taking over existing tabs, and scopes offline responses to known public assets', async () => {
  const f = await fixture(); await f.dispatch('install');
  expect(f.stores.get('trekviewer-shell-new')?.size).toBe(2); expect(f.takeovers()).toBe(0);
  const response = await f.dispatch('fetch', { request: { method: 'GET', mode: 'navigate', url: 'https://example.test/app/?profile=1' } }) as Response;
  expect(await response.text()).toBe('verified app');
  expect(f.dispatch('fetch', { request: { method: 'GET', url: 'https://private.example.test/data?token=secret' } })).toBeUndefined();
  expect(f.dispatch('fetch', { request: { method: 'POST', url: 'https://example.test/app/index.html' } })).toBeUndefined();
  expect(f.dispatch('fetch', { request: { method: 'GET', url: 'https://example.test/app/assets/missing.js' } })).toBeUndefined();
  await f.dispatch('activate'); expect(f.stores.has('trekviewer-shell-old')).toBe(false); expect(f.stores.has('unrelated-cache')).toBe(true);
});
it('rejects corrupt shell bytes and removes only the incomplete new version', async () => {
  const f = await fixture(true);
  await expect(f.dispatch('install')).rejects.toThrow('integrity mismatch');
  expect(f.stores.has('trekviewer-shell-new')).toBe(false); expect(f.stores.has('trekviewer-shell-old')).toBe(true); expect(f.takeovers()).toBe(0);
});
