/** Registers the offline app shell. A new version waits until the user chooses
 * "Reload to update" (never while in VR/MR or during playback). */
export function registerOfflineShell(canReload: () => boolean = () => true): void {
  const element = () => document.getElementById('offlineShellStatus');
  const status = (message: string) => { const el = element(); if (el) el.textContent = message; };
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) { status('Offline app startup is unavailable in this session.'); return; }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  const offerUpdate = (registration: ServiceWorkerRegistration) => {
    const el = element(); if (!el) return;
    el.textContent = 'A new version of TrekViewer is ready. ';
    const button = document.createElement('button');
    button.className = 'btn btn-sm'; button.type = 'button'; button.textContent = 'Reload to update';
    button.onclick = () => {
      if (!canReload()) { status('Pause playback and leave VR/MR, then choose Reload to update.'); setTimeout(() => offerUpdate(registration), 4000); return; }
      const waiting = registration.waiting; if (!waiting) { location.reload(); return; }
      reloading = true; button.disabled = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    };
    el.appendChild(button);
  };
  void navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { updateViaCache: 'none' }).then(registration => {
    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration);
    else if (registration.active) status('The app is saved for offline startup. Maps download separately.');
    const watch = () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') {
          if (navigator.serviceWorker.controller) offerUpdate(registration);
          else status('The app is saved for offline startup. Maps download separately.');
        } else if (worker.state === 'redundant' && !registration.active) status('Saving the app for offline use failed. Connect and reload to retry.');
      });
    };
    registration.addEventListener('updatefound', watch); watch();
  }).catch(() => status('Offline app startup is unavailable. Connect and reload to retry.'));
}
