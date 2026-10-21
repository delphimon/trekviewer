export function registerOfflineShell(): void {
  const status = (message: string) => { const el = document.getElementById('offlineShellStatus'); if (el) el.textContent = message; };
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) { status('Offline app startup is unavailable in this session.'); return; }
  void navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { updateViaCache: 'none' }).then(registration => {
    if (registration.waiting) status('App update ready. Close TrekViewer tabs and reopen to update.');
    else if (registration.active) status('App shell saved for offline startup. Route data downloads separately.');
    const watch = () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') status(navigator.serviceWorker.controller
          ? 'App update ready. Close TrekViewer tabs and reopen to update.' : 'App shell saved for offline startup. Route data downloads separately.');
        else if (worker.state === 'redundant') status('Offline app setup failed. Connect and reload to retry.');
      });
    };
    registration.addEventListener('updatefound', watch); watch();
  }).catch(() => status('Offline app setup is unavailable. Connect and reload to retry.'));
}
