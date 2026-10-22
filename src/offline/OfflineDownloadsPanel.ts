import { GPXParser } from '../gpx/GPXParser.ts';
import { resolveAssetUrl } from '../utils/AssetUrl.ts';
import { readBoundedBlob } from '../terrain/PersistentResourceCache.ts';
import { DEFAULT_OFFLINE_ROUTES, planOfflineRoute, sha256, type OfflinePlan } from './OfflinePlan.ts';
import { OfflineDownloads } from './OfflineDownloads.ts';
import { OfflineStore } from './OfflineStore.ts';
import { registerOfflineShell } from './OfflineShell.ts';
import type { RouteManifestItem } from '../gpx/TrackTypes.ts';

const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
export class OfflineDownloadsPanel {
  private plans: OfflinePlan[] = [];
  private disposed = false;
  private preparing = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private message: HTMLElement;
  private states: HTMLElement;
  private prepare: HTMLButtonElement;
  private download: HTMLButtonElement;
  private pause: HTMLButtonElement;
  private manifest: RouteManifestItem[] = [];
  private changed = () => { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250); };
  private pageHide = () => OfflineDownloads.pause();
  constructor(private root: HTMLElement, private canPrepare: () => boolean = () => true) {
    root.innerHTML = `<h3>Offline route downloads</h3>
      <p class="trek-meta">USGS satellite imagery and 3DEP elevation, with full surrounding terrain in High. Rainier and Enchantments are selected by default. Downloads can be several GB and require this tab to stay open. Play or entering VR/MR pauses preparation.</p>
      <label class="comfort-option"><span>Mount Rainier — Emmons</span><input type="checkbox" data-offline-route="rainier-emmons" checked /></label>
      <label class="comfort-option"><span>Enchantments &amp; Dragontail</span><input type="checkbox" data-offline-route="enchantments-dragontail" checked /></label>
      <div class="btn-group"><button class="btn btn-sm" data-offline-action="prepare">Estimate selected</button><button class="btn btn-sm" data-offline-action="download" disabled>Download selected</button><button class="btn btn-sm" data-offline-action="pause" disabled>Pause</button></div>
      <p class="trek-meta" data-offline-message role="status" aria-live="polite">Select routes, then estimate storage before downloading.</p>
      <div data-offline-states></div>
      <p class="trek-meta">Downloaded packs are separate from the temporary cache. Ready covers normal High satellite viewing; other styles, providers and experimental detail settings may still need a connection. Browser storage can be reclaimed.</p>
      <p id="offlineShellStatus" class="trek-meta" role="status">Saving the app for offline startup…</p>`;
    this.message = root.querySelector('[data-offline-message]')!; this.states = root.querySelector('[data-offline-states]')!;
    this.prepare = root.querySelector('[data-offline-action="prepare"]')!; this.download = root.querySelector('[data-offline-action="download"]')!; this.pause = root.querySelector('[data-offline-action="pause"]')!;
    root.querySelectorAll<HTMLInputElement>('[data-offline-route]').forEach(input => input.addEventListener('change', () => {
      this.plans = []; this.download.disabled = true; this.message.textContent = 'Selection changed. Estimate storage again.';
    }));
    this.prepare.onclick = () => { void this.preparePlans(); };
    this.download.onclick = () => { void this.downloadPlans(); };
    this.pause.onclick = () => OfflineDownloads.pause();
    OfflineStore.events.addEventListener('change', this.changed); window.addEventListener('pagehide', this.pageHide);
    registerOfflineShell(); void this.refresh();
  }
  public setManifest(manifest: RouteManifestItem[]): void { this.manifest = manifest; }
  private async preparePlans(): Promise<void> {
    if (this.preparing || OfflineDownloads.busy()) return;
    if (!this.canPrepare()) { this.message.textContent = 'Pause playback before preparing offline downloads.'; return; }
    this.preparing = true; this.plans = []; this.controls();
    this.message.textContent = 'Preparing storage estimates…';
    try {
      const selected = [...this.root.querySelectorAll<HTMLInputElement>('[data-offline-route]:checked')].map(el => el.dataset.offlineRoute!);
      if (!selected.length) throw Error('Select at least one route.');
      const plans: OfflinePlan[] = [];
      for (const id of selected) {
        if (!DEFAULT_OFFLINE_ROUTES.some(route => route === id)) throw Error('Unknown route');
        const route = this.manifest.find(route => route.id === id); if (!route) throw Error('Route list is not ready. Try again.');
        const response = await fetch(resolveAssetUrl(route.file));
        const blob = await readBoundedBlob(response, 25 * 1024 * 1024), bytes = await blob.arrayBuffer();
        if (this.disposed) return;
        const xml = new TextDecoder().decode(bytes);
        // A checkout/deployment newline change must not invalidate gigabytes of
        // otherwise identical route data. Shell byte integrity remains separate.
        const hash = await sha256(new TextEncoder().encode(xml.replace(/\r\n?/g, '\n')).buffer), expected = OfflineStore.bundledHash(id);
        if (expected && hash !== expected) throw Error('Route files changed. Close TrekViewer tabs and reopen before downloading.');
        plans.push(planOfflineRoute(GPXParser.parse(xml), id, hash));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      this.plans = plans;
      const estimate = await navigator.storage?.estimate();
      if (this.disposed) return;
      this.message.textContent = `${plans.map(p => `${p.routeId === 'rainier-emmons' ? 'Rainier' : 'Enchantments'}: ${size(p.estimatedBytes)} uncompressed budget`).join(' • ')}. Downloads keep original compressed files; actual sizes appear as sources are saved. This budget is not required free space. Space is checked before each write; a full browser pauses the pack for resume.${estimate?.quota ? ` Available browser storage: ${size(Math.max(0, estimate.quota - (estimate.usage ?? 0)))}.` : ' Browser storage capacity unavailable.'}`;
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Could not prepare downloads.'; }
    finally { this.preparing = false; if (!this.disposed) this.controls(); }
  }
  private async downloadPlans(): Promise<void> {
    if (!this.plans.length || this.running || OfflineDownloads.busy()) return;
    if (!this.canPrepare()) { this.message.textContent = 'Pause playback before downloading route data.'; return; }
    this.running = true; this.controls();
    try {
      for (const plan of this.plans) {
        if (this.disposed) return;
        this.message.textContent = `Downloading ${plan.routeId === 'rainier-emmons' ? 'Rainier' : 'Enchantments'}. Completed sources survive pause/reload.`;
        await OfflineDownloads.start(plan);
        if ((await OfflineStore.state(plan.id))?.state !== 'ready') break;
      }
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Download failed. Resume to retry.'; }
    finally { this.running = false; if (!this.disposed) { this.controls(); await this.refresh(); } }
  }
  private controls(): void {
    const busy = this.running || OfflineDownloads.busy() || this.preparing;
    this.prepare.disabled = busy; this.download.disabled = busy || !this.plans.length; this.pause.disabled = !this.running;
    this.root.querySelectorAll<HTMLInputElement>('[data-offline-route]').forEach(input => { input.disabled = busy; });
  }
  private async refresh(): Promise<void> {
    try {
      const rows = await OfflineStore.list(); if (this.disposed) return;
      this.states.replaceChildren();
      for (const row of rows.sort((a, b) => b.updated - a.updated)) {
        const line = document.createElement('p'); line.className = 'trek-meta';
        const state = !OfflineStore.compatible(row) ? 'Saved older route revision — estimate and download the current route'
          : row.state === 'downloading' && !OfflineDownloads.busy() ? 'Interrupted — resume' : row.state;
        line.textContent = `${row.name}: ${state} • ${row.completed}/${row.total} sources • ${size(row.bytes)}. ${row.message} `;
        const remove = document.createElement('button'); remove.className = 'btn btn-sm'; remove.textContent = 'Remove pack'; remove.disabled = this.running || OfflineDownloads.busy();
        remove.onclick = () => { void OfflineDownloads.withLock(() => OfflineStore.remove(row.id)).catch(error => { this.message.textContent = String(error.message); }); };
        line.appendChild(remove); this.states.appendChild(line);
      }
      this.controls();
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Offline storage unavailable.'; }
  }
  public dispose(): void {
    this.disposed = true; OfflineDownloads.pause(); if (this.timer) clearTimeout(this.timer);
    OfflineStore.events.removeEventListener('change', this.changed); window.removeEventListener('pagehide', this.pageHide);
  }
}
