import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { registerOfflineShell } from '../src/offline/OfflineShell.ts';
import { OfflineDownloads } from '../src/offline/OfflineDownloads.ts';

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

function shellPage() {
  const listeners = new Map<string, () => void>();
  const status = { textContent: '', children: [] as any[], appendChild(child: any) { this.children.push(child); } };
  const reload = vi.fn();
  vi.stubEnv('PROD', true);
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('document', { baseURI: 'https://example.test/app/', getElementById: () => status,
    createElement: () => ({ className: '', type: '', textContent: '', disabled: false, onclick: null as null | (() => void) }) });
  vi.stubGlobal('navigator', { serviceWorker: { controller: {}, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    register: () => new Promise(() => {}) } });
  return { reload, status, controllerChange: () => listeners.get('controllerchange')!() };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reloads a second idle tab when another tab activates the new version', () => {
  const page = shellPage();
  registerOfflineShell(() => true);
  page.controllerChange();
  expect(page.reload).toHaveBeenCalledTimes(1);
});

it('asks a busy second tab to reload, in the status banner too, instead of reloading under it', () => {
  const page = shellPage(), notify = vi.fn();
  let busy = true; vi.spyOn(OfflineDownloads, 'busy').mockImplementation(() => busy);
  registerOfflineShell(() => true, notify);
  page.controllerChange();
  expect(page.reload).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/reload to update/i));
  const button = page.status.children.at(-1);
  expect(button.textContent).toBe('Reload to update');
  busy = false; button.onclick();
  expect(page.reload).toHaveBeenCalledTimes(1);
});

it('does not reload a tab presenting XR or playing when the controller changes', () => {
  const page = shellPage();
  registerOfflineShell(() => false);
  page.controllerChange();
  expect(page.reload).not.toHaveBeenCalled();
  expect(page.status.children.at(-1).textContent).toBe('Reload to update');
});
