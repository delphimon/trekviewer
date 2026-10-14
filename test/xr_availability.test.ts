import { it, expect, vi, afterEach } from 'vitest';
import { TrekViewerApp } from '../src/main.ts';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function appFixture() {
  const app: any = Object.create(TrekViewerApp.prototype);
  app.xrAvailabilityGeneration = 0; app.isDisposed = false; app.xrEntryPending = false;
  app.overlay = { beginXRSupportCheck: vi.fn(), setXRSupport: vi.fn(), showStatus: vi.fn() };
  app.routeLoader = { getActiveTrek: () => ({}) };
  app.sceneManager = { renderer: { xr: { isPresenting: false, setSession: vi.fn(), getReferenceSpace: () => null } }, setPassthrough: vi.fn() };
  return app;
}

it('reports separate VR and MR availability without requesting an immersive session', async () => {
  const app = appFixture(), requestSession = vi.fn();
  vi.stubGlobal('navigator', { xr: { isSessionSupported: vi.fn(async (mode) => mode === 'immersive-vr'), requestSession } });
  await app.updateXRAvailability();
  expect(app.overlay.setXRSupport).toHaveBeenCalledWith(true, false, expect.stringContaining('Enter VR'));
  expect(requestSession).not.toHaveBeenCalled();
});

it('keeps entry retryable when capability checks fail and handles missing WebXR', async () => {
  const app = appFixture();
  vi.stubGlobal('navigator', { xr: { isSessionSupported: vi.fn().mockRejectedValue(Error('Permission denied')) } });
  await app.updateXRAvailability();
  expect(app.overlay.setXRSupport).toHaveBeenCalledWith(null, null, expect.stringContaining('could not be checked'));
  vi.stubGlobal('navigator', {}); await app.updateXRAvailability();
  expect(app.overlay.setXRSupport).toHaveBeenLastCalledWith(false, false, expect.stringContaining('headset browser'));
});

it('ignores stale capability checks after a device change or disposal', async () => {
  const app = appFixture(); let resolve!: (value: boolean) => void, calls = 0;
  const pending = new Promise<boolean>(complete => { resolve = complete; });
  vi.stubGlobal('navigator', { xr: { isSessionSupported: () => ++calls <= 2 ? pending : Promise.resolve(true) } });
  const first = app.updateXRAvailability(); await Promise.resolve();
  await app.updateXRAvailability(); resolve(false); await first;
  expect(app.overlay.setXRSupport).toHaveBeenCalledTimes(1);
  expect(app.overlay.setXRSupport).toHaveBeenCalledWith(true, true, '');
  app.isDisposed = true; await app.updateXRAvailability();
  expect(app.overlay.setXRSupport).toHaveBeenCalledTimes(1);
});

it('preserves the explicit MR choice when passthrough is unsupported', async () => {
  const app = appFixture(), requestSession = vi.fn();
  const supported = vi.fn(async (mode) => mode === 'immersive-vr');
  vi.stubGlobal('navigator', { xr: { isSessionSupported: supported, requestSession } });
  await app.enterXR('immersive-ar');
  expect(supported).toHaveBeenCalledTimes(1);
  expect(requestSession).not.toHaveBeenCalled();
  expect(app.overlay.showStatus).toHaveBeenCalledWith(expect.stringContaining('Choose Enter VR'), true);
  expect(app.xrEntryPending).toBe(false);
});

it('composes route readiness with per-mode availability and permits hot-plug recovery', () => {
  const elements: Record<string, any> = { btnEnterVR: {}, btnEnterAR: {}, xrSupportStatus: {} };
  vi.stubGlobal('document', { getElementById: (id: string) => elements[id] });
  const overlay: any = Object.create(DesktopOverlay.prototype);
  overlay.xrEnabled = true; overlay.xrSupport = { vr: null, ar: null };
  overlay.setXRSupport(true, false, 'Passthrough unavailable');
  expect(elements.btnEnterVR.disabled).toBe(false); expect(elements.btnEnterAR.disabled).toBe(true);
  overlay.setXREnabled(false); expect(elements.btnEnterVR.disabled).toBe(true);
  overlay.setXREnabled(true); expect(elements.btnEnterAR.disabled).toBe(true);
  overlay.setXRSupport(true, true, ''); expect(elements.btnEnterAR.disabled).toBe(false);
  expect(elements.xrSupportStatus.hidden).toBe(true);
});

it('blocks both entry controls until asynchronous availability checks settle', async () => {
  const app = appFixture(); let resolve!: (supported: boolean) => void;
  const pending = new Promise<boolean>(complete => { resolve = complete; });
  vi.stubGlobal('navigator', { xr: { isSessionSupported: () => pending } });
  const checking = app.updateXRAvailability();
  expect(app.overlay.beginXRSupportCheck).toHaveBeenCalledTimes(1);
  expect(app.overlay.setXRSupport).not.toHaveBeenCalled();
  resolve(true); await checking;
  expect(app.overlay.setXRSupport).toHaveBeenCalledWith(true, true, '');
});

it('composes a pending check with loading, graphics and retryable unknown results', () => {
  const elements: Record<string, any> = { btnEnterVR: {}, btnEnterAR: {}, xrSupportStatus: {} };
  vi.stubGlobal('document', { getElementById: (id: string) => elements[id] });
  const overlay: any = Object.create(DesktopOverlay.prototype);
  overlay.xrSupport = { vr: true, ar: true }; overlay.xrEnabled = true; overlay.graphicsPaused = false;
  overlay.beginXRSupportCheck();
  expect(elements.btnEnterVR.disabled).toBe(true); expect(elements.btnEnterAR.disabled).toBe(true);
  expect(elements.xrSupportStatus.ariaBusy).toBe('true'); expect(elements.xrSupportStatus.hidden).toBe(false);
  overlay.setXREnabled(false); overlay.setXRSupport(true, true, '');
  expect(elements.btnEnterVR.disabled).toBe(true); expect(elements.xrSupportStatus.ariaBusy).toBe('false');
  overlay.setXREnabled(true); expect(elements.btnEnterVR.disabled).toBe(false);
  overlay.graphicsPaused = true; overlay.beginXRSupportCheck(); overlay.setXRSupport(null, null, 'Try again');
  expect(elements.btnEnterVR.disabled).toBe(true);
  overlay.graphicsPaused = false; overlay.setXREnabled(true);
  expect(elements.btnEnterVR.disabled).toBe(false); expect(elements.btnEnterAR.disabled).toBe(false);
});

it('does not begin another capability check or mutate controls after disposal', async () => {
  const app = appFixture(), support = vi.fn();
  app.isDisposed = true; vi.stubGlobal('navigator', { xr: { isSessionSupported: support } });
  await app.updateXRAvailability();
  expect(support).not.toHaveBeenCalled(); expect(app.overlay.beginXRSupportCheck).not.toHaveBeenCalled(); expect(app.overlay.setXRSupport).not.toHaveBeenCalled();
});
