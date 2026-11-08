import { GPXParser } from '../gpx/GPXParser.ts';
import { resolveAssetUrl } from '../utils/AssetUrl.ts';
import { readBoundedBlob } from '../terrain/PersistentResourceCache.ts';
import { DEFAULT_OFFLINE_ROUTES, planOfflineRoute, sha256, type OfflinePlan, type OfflinePlanOptions } from './OfflinePlan.ts';
import { OfflineDownloads } from './OfflineDownloads.ts';
import { OfflineStore, type OfflinePackState } from './OfflineStore.ts';
import { registerOfflineShell } from './OfflineShell.ts';
import { exportOfflineArchive, inspectOfflineArchive, offlineArchiveSource } from './OfflineArchive.ts';
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
  private importer: HTMLButtonElement;
  private filePicker: HTMLInputElement;
  private modeSelect: HTMLSelectElement | null = null;
  private persistence: HTMLElement | null = null;
  /** Missing-source counts for ready packs, keyed by pack id + update time. */
  private readonly missing = new Map<string, Promise<number>>();
  private manifest: RouteManifestItem[] = [];
  private changed = () => { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250); };
  private pageHide = () => OfflineDownloads.pause();
  constructor(private root: HTMLElement, private canPrepare: () => boolean = () => true) {
    root.innerHTML = `<h3>Offline maps</h3>
      <p class="trek-meta">Save a route's aerial imagery and terrain so it works without a connection. Keep this tab open while downloading; playing the tour or entering VR/MR pauses the download, and Resume continues where it stopped.</p>
      <label class="comfort-option"><span>Mount Rainier — Emmons</span><input type="checkbox" data-offline-route="rainier-emmons" checked /></label>
      <label class="comfort-option"><span>Enchantments &amp; Dragontail</span><input type="checkbox" data-offline-route="enchantments-dragontail" checked /></label>
      <label class="comfort-option"><span>Detail</span><select data-offline-mode><option value="corridor-v3">Sharp along the trail (smaller)</option><option value="full-v2">Sharp everywhere (very large)</option></select></label>
      <div class="btn-group"><button class="btn btn-sm" data-offline-action="prepare">Check size</button><button class="btn btn-sm" data-offline-action="download" disabled>Download</button><button class="btn btn-sm" data-offline-action="pause" disabled>Pause</button></div>
      <p class="trek-meta" data-offline-persistence role="status"></p>
      <p class="trek-meta" data-offline-message role="status" aria-live="polite">Choose routes, then check the size before downloading.</p>
      <div data-offline-states></div>
      <details class="offline-advanced"><summary>Import or export a pack file</summary>
        <button class="btn btn-sm" data-offline-action="import">Import pack file</button><input type="file" data-offline-file accept=".tar,application/x-tar" hidden />
        <p class="trek-meta">Copy a .trekpack.tar prepared on a computer, then import it here. If an import is interrupted, choose the same file again to continue.</p>
      </details>
      <p class="trek-meta">Offline maps cover the default Aerial view. Hybrid, Topo and other imagery sources still need a connection.</p>
      <p id="offlineShellStatus" class="trek-meta" role="status">Saving the app for offline startup…</p>`;
    this.message = root.querySelector('[data-offline-message]')!; this.states = root.querySelector('[data-offline-states]')!;
    this.prepare = root.querySelector('[data-offline-action="prepare"]')!; this.download = root.querySelector('[data-offline-action="download"]')!; this.pause = root.querySelector('[data-offline-action="pause"]')!;
    this.importer = root.querySelector('[data-offline-action="import"]')!; this.filePicker = root.querySelector('[data-offline-file]')!;
    this.modeSelect = root.querySelector<HTMLSelectElement>('[data-offline-mode]');
    this.persistence = root.querySelector('[data-offline-persistence]');
    const onSelectionChange = () => {
      this.plans = []; this.download.disabled = true; this.message.textContent = 'Selection changed. Check the size again.';
    };
    root.querySelectorAll<HTMLInputElement>('[data-offline-route]').forEach(input => input.addEventListener('change', onSelectionChange));
    if (this.modeSelect) this.modeSelect.onchange = onSelectionChange;
    this.prepare.onclick = () => { void this.preparePlans(); };
    this.download.onclick = () => { void this.downloadPlans(); };
    this.pause.onclick = () => OfflineDownloads.pause();
    this.importer.onclick = () => this.filePicker.click();
    this.filePicker.onchange = () => { const file = this.filePicker.files?.[0]; this.filePicker.value = ''; if (file) void this.importArchive(file); };
    OfflineStore.events.addEventListener('change', this.changed); window.addEventListener('pagehide', this.pageHide);
    registerOfflineShell(this.canPrepare); void this.refresh(); void this.updatePersistence(false);
  }
  public setManifest(manifest: RouteManifestItem[]): void { this.manifest = manifest; }
  private getSelectedMode(): NonNullable<OfflinePlanOptions['mode']> {
    return this.modeSelect?.value === 'full-v2' ? 'full-v2' : 'corridor-v3';
  }
  /** Browsers evict a whole non-persistent origin under pressure, offline maps included. */
  private async updatePersistence(request: boolean): Promise<void> {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!this.persistence || !storage?.persisted) return;
    let persisted = await storage.persisted().catch(() => false);
    if (!persisted && request && storage.persist) persisted = await storage.persist().catch(() => false);
    if (this.disposed || !this.persistence) return;
    this.persistence.textContent = persisted ? 'Storage is protected: the browser will not clear saved maps on its own.'
      : request ? '⚠ The browser did not protect storage. It may delete saved maps when the device is low on space. Installing the app usually allows protection.'
      : '';
    this.persistence.classList.toggle('status-warning', !persisted && request);
  }
  private async loadPlan(id: string, signal?: AbortSignal, modeOverride?: NonNullable<OfflinePlanOptions['mode']>): Promise<OfflinePlan> {
    if (!DEFAULT_OFFLINE_ROUTES.some(route => route === id)) throw Error('This pack route is not supported.');
    const route = this.manifest.find(route => route.id === id); if (!route) throw Error('Route list is not ready. Try again.');
    const response = await fetch(resolveAssetUrl(route.file), { signal });
    const blob = await readBoundedBlob(response, 25 * 1024 * 1024), xml = await blob.text();
    const hash = await sha256(new TextEncoder().encode(xml.replace(/\r\n?/g, '\n')).buffer), expected = OfflineStore.bundledHash(id);
    if (expected && hash !== expected) throw Error('Route files changed. Close TrekViewer tabs and reopen before downloading.');
    if (signal?.aborted || this.disposed) throw new DOMException('Preparation paused', 'AbortError');
    const mode = modeOverride ?? this.getSelectedMode();
    return planOfflineRoute(GPXParser.parse(xml), id, hash, { mode });
  }
  private async preparePlans(): Promise<void> {
    if (this.preparing || OfflineDownloads.busy()) return;
    if (!this.canPrepare()) { this.message.textContent = 'Pause playback and leave VR/MR before preparing offline downloads.'; return; }
    this.preparing = true; this.plans = []; this.controls();
    this.message.textContent = 'Checking sizes…';
    void this.updatePersistence(true);
    try {
      const selected = [...this.root.querySelectorAll<HTMLInputElement>('[data-offline-route]:checked')].map(el => el.dataset.offlineRoute!);
      if (!selected.length) throw Error('Select at least one route.');
      const plans: OfflinePlan[] = [];
      for (const id of selected) {
        plans.push(await this.loadPlan(id));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      this.plans = plans;
      const estimate = await navigator.storage?.estimate();
      if (this.disposed) return;
      // The plan budget counts raw pixels; saved files are compressed. Past packs averaged
      // about a third of the budget, so show that as the expected size and keep the budget as a ceiling.
      const free = estimate?.quota ? Math.max(0, estimate.quota - (estimate.usage ?? 0)) : undefined;
      this.message.textContent = `${plans.map(p => `${p.routeId === 'rainier-emmons' ? 'Rainier' : 'Enchantments'}: about ${size(p.estimatedBytes / 3)} (at most ${size(p.estimatedBytes)})`).join(' • ')}. `
        + (free !== undefined ? `Free browser storage: ${size(free)}. ` : '')
        + `${plans.reduce((n, p) => n + p.resources.length, 0).toLocaleString()} map pieces to download. If storage fills up, the download pauses and keeps what it saved.`;
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Could not prepare downloads.'; }
    finally { this.preparing = false; if (!this.disposed) this.controls(); }
  }
  private async downloadPlans(): Promise<void> {
    if (!this.plans.length || this.running || OfflineDownloads.busy()) return;
    if (!this.canPrepare()) { this.message.textContent = 'Pause playback and leave VR/MR before downloading route data.'; return; }
    this.running = true; this.controls();
    try {
      for (const plan of this.plans) {
        if (this.disposed) return;
        this.message.textContent = `Downloading ${plan.routeId === 'rainier-emmons' ? 'Rainier' : 'Enchantments'}. Saved pieces are kept if you pause or reload.`;
        await OfflineDownloads.start(plan);
        if ((await OfflineStore.state(plan.id))?.state !== 'ready') break;
      }
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Download failed. Resume to retry.'; }
    finally { this.running = false; if (!this.disposed) { this.controls(); await this.refresh(); } }
  }
  private async importArchive(file: File): Promise<void> {
    if (this.running || this.preparing || OfflineDownloads.busy()) return;
    if (!this.canPrepare()) { this.message.textContent = 'Pause playback and leave VR/MR before importing a route pack.'; return; }
    this.running = true; this.controls(); this.message.textContent = 'Checking route pack…';
    let importedId: string | undefined;
    try {
      await OfflineDownloads.prepare(async signal => {
        const index = await inspectOfflineArchive(file, signal);
        const mode = index.manifest.planId.includes('-v3-') ? 'corridor-v3' : 'full-v2';
        const plan = await this.loadPlan(index.manifest.routeId, signal, mode);
        importedId = plan.id;
        return { plan, source: await offlineArchiveSource(file, index, plan, signal) };
      });
      const state = importedId ? await OfflineStore.state(importedId) : undefined;
      if (!this.disposed) this.message.textContent = state?.state === 'ready' ? `${state.name} is ready to view offline.`
        : 'Import paused. Choose the same pack file again to continue; imported pieces are kept.';
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Import failed. Reselect the pack file to retry.'; }
    finally { this.running = false; if (!this.disposed) { this.controls(); await this.refresh(); } }
  }
  private controls(): void {
    const busy = this.running || OfflineDownloads.busy() || this.preparing;
    this.prepare.disabled = busy; this.download.disabled = busy || !this.plans.length; this.pause.disabled = !this.running; this.importer.disabled = busy;
    if (this.modeSelect) this.modeSelect.disabled = busy;
    this.root.querySelectorAll<HTMLInputElement>('[data-offline-route]').forEach(input => { input.disabled = busy; });
  }
  private async refresh(): Promise<void> {
    try {
      const rows = await OfflineStore.list(); if (this.disposed) return;
      this.states.replaceChildren();
      for (const row of rows.sort((a, b) => b.updated - a.updated)) {
        const line = document.createElement('p'); line.className = 'trek-meta offline-pack-row';
        const busy = this.running || OfflineDownloads.busy();
        const label = document.createElement('strong'); label.textContent = row.name;
        const status = document.createElement('span');
        const percent = row.total ? Math.floor((row.completed / row.total) * 100) : 0;
        status.textContent = !OfflineStore.compatible(row) ? ' — made for an older version of this route. Remove it and download again.'
          : row.state === 'ready' ? ` — ✓ Ready offline • ${size(row.bytes)}`
          : row.state === 'downloading' && !OfflineDownloads.busy() ? ` — Interrupted at ${percent}%. Check size, then Download to resume.`
          : row.state === 'downloading' ? ` — Downloading ${percent}% • ${size(row.bytes)}`
          : ` — Paused at ${percent}% • ${size(row.bytes)}. ${row.message}`;
        line.append(label, status);
        if (row.state === 'ready' && OfflineStore.compatible(row)) {
          const detail = document.createElement('span'); detail.textContent = ` • ${row.message}`;
          line.appendChild(detail);
          void this.reportMissing(row, status);
          const exp = document.createElement('button'); exp.className = 'btn btn-sm'; exp.textContent = 'Export'; exp.disabled = busy;
          exp.onclick = () => { void this.exportArchive(row.id, row.routeId); };
          line.appendChild(exp);
        }
        const remove = document.createElement('button'); remove.className = 'btn btn-sm'; remove.textContent = 'Remove'; remove.disabled = busy;
        remove.onclick = () => {
          if (!window.confirm(`Delete the offline map for ${row.name} (${size(row.bytes)})? This cannot be undone; you would need to download it again.`)) return;
          void OfflineDownloads.withLock(() => OfflineStore.remove(row.id)).catch(error => { this.message.textContent = String(error.message); });
        };
        line.appendChild(remove); this.states.appendChild(line);
      }
      this.controls();
    } catch (error) { if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Offline storage unavailable.'; }
  }
  /** Shows "Needs update" when the current app expects sources this ready pack lacks. */
  private async reportMissing(row: OfflinePackState, status: HTMLElement): Promise<void> {
    const key = `${row.id}:${row.updated}`;
    let pending = this.missing.get(key);
    if (!pending) {
      pending = this.loadPlan(row.routeId, undefined, row.id.includes('-v3-') ? 'corridor-v3' : 'full-v2')
        .then(plan => plan.id === row.id ? OfflineStore.missingCount(plan) : 0).catch(() => 0);
      this.missing.set(key, pending);
    }
    const missing = await pending;
    if (missing > 0 && !this.disposed && status.isConnected) {
      status.textContent = ` — Needs update: ${missing.toLocaleString()} pieces changed in this app version and will load online. Check size, then Download to fetch them.`;
    }
  }
  private async exportArchive(packId: string, routeId: string): Promise<void> {
    if (this.running || this.preparing || OfflineDownloads.busy()) return;
    this.running = true; this.controls(); this.message.textContent = 'Preparing route pack export…';
    try {
      const mode = packId.includes('-v3-') ? 'corridor-v3' : 'full-v2';
      const plan = await this.loadPlan(routeId, undefined, mode);
      const blob = await exportOfflineArchive(plan);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `${packId}.tar`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!this.disposed) this.message.textContent = `Exported ${plan.name} (${size(blob.size)}).`;
    } catch (error) {
      if (!this.disposed) this.message.textContent = error instanceof Error ? error.message : 'Export failed.';
    } finally {
      this.running = false; if (!this.disposed) this.controls();
    }
  }
  public dispose(): void {
    this.disposed = true; OfflineDownloads.pause(); if (this.timer) clearTimeout(this.timer);
    OfflineStore.events.removeEventListener('change', this.changed); window.removeEventListener('pagehide', this.pageHide);
  }
}
