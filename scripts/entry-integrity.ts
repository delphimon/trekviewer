import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Serialized into the built HTML; keep this function self-contained. */
function installEntryRecovery(): void {
  const handled = new WeakSet<HTMLScriptElement>();
  window.addEventListener('error', event => {
    const failed = event.target;
    if (!(failed instanceof HTMLScriptElement) || failed.dataset.trekEntry !== 'true' || handled.has(failed)) return;
    handled.add(failed);
    const attempt = Number(failed.dataset.trekRetry ?? '0');
    if (attempt >= 2) {
      const message = document.createElement('div'); message.id = 'appLoadError'; message.setAttribute('role', 'alert');
      message.style.cssText = 'position:fixed;inset:20% 12%;padding:24px;background:#142031;color:#e2e8f0;font:18px system-ui;z-index:999999';
      message.textContent = 'Unable to load TrekViewer. Check your connection and reload. ';
      const reload = document.createElement('button'); reload.textContent = 'Reload TrekViewer'; reload.onclick = () => location.reload();
      // A damaged offline copy can keep failing even online: let the user discard it.
      // Saved offline maps live in IndexedDB and are not touched.
      const repair = document.createElement('button'); repair.textContent = 'Repair app (re-download it)'; repair.style.marginLeft = '8px';
      repair.onclick = async () => {
        try {
          for (const registration of await navigator.serviceWorker?.getRegistrations?.() ?? []) await registration.unregister();
          for (const name of await caches.keys()) if (name.startsWith('trekviewer-shell-')) await caches.delete(name);
        } catch { /* Reload anyway. */ }
        location.reload();
      };
      message.append(reload, repair); (document.body ?? document.documentElement).appendChild(message);
      return;
    }
    setTimeout(() => {
      const retry = document.createElement('script');
      retry.type = 'module'; retry.crossOrigin = 'anonymous'; retry.integrity = failed.integrity;
      retry.dataset.trekEntry = 'true'; retry.dataset.trekRetry = String(attempt + 1);
      const url = new URL(failed.src); url.searchParams.set('trekRetry', `${attempt + 1}-${Date.now()}`);
      retry.src = url.href; document.head.appendChild(retry);
    }, 200 * (attempt + 1));
  }, true);
}

export function entryIntegrity(): Plugin {
  return {
    name: 'trek-entry-integrity', apply: 'build', enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html'];
        if (!html || html.type !== 'asset' || typeof html.source !== 'string') throw Error('Expected built index.html');
        let count = 0;
        html.source = html.source.replace(/<script\b([^>]*?)src="([^\"]+\.js)"([^>]*)><\/script>/g, (tag, before: string, src: string, after: string) => {
          if (!/type="module"/.test(before + after)) return tag;
          const entry = bundle[src.replace(/^\.\//, '').replace(/^\//, '')];
          if (!entry || entry.type !== 'chunk' || !entry.isEntry) return tag;
          count++;
          const integrity = `sha384-${createHash('sha384').update(entry.code).digest('base64')}`;
          return `<script>(${installEntryRecovery.toString()})();</script>\n<script${before}src="${src}"${after} data-trek-entry="true" integrity="${integrity}"></script>`;
        });
        if (count !== 1) throw Error(`Expected one application entry, found ${count}`);
        // Shared chunks (e.g. the three.js vendor chunk) are preloaded; give them the same
        // integrity protection as the entry so a corrupted response is rejected, not executed.
        html.source = html.source.replace(/<link\b([^>]*?)rel="modulepreload"([^>]*?)href="([^\"]+\.js)"([^>]*)>/g,
          (tag, a: string, b: string, href: string, c: string) => {
            if (/integrity=/.test(tag)) return tag;
            const chunk = bundle[href.replace(/^\.\//, '').replace(/^\//, '')];
            if (!chunk || chunk.type !== 'chunk') return tag;
            const integrity = `sha384-${createHash('sha384').update(chunk.code).digest('base64')}`;
            return `<link${a}rel="modulepreload"${b}href="${href}"${c} integrity="${integrity}">`;
          });
      },
    },
  };
}
