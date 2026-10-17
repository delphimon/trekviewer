import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SceneManager } from '../src/core/SceneManager.ts';
import { readXRRenderQuality, requestedXRFoveation } from '../src/core/XRRenderQuality.ts';

vi.mock('three', async importOriginal => {
  const real = await importOriginal<typeof import('three')>();
  return { ...real, WebGLRenderer: class {
    domElement = {};
    capabilities = { getMaxAnisotropy: () => 16 };
    shadowMap = { enabled: false, type: 0 };
    xr = Object.assign(new real.EventDispatcher(), {
      enabled: false, isPresenting: false, layer: null as any,
      setFoveation: vi.fn(function(this: any, value: number) { if (typeof this.layer?.fixedFoveation === 'number') this.layer.fixedFoveation = value; }),
      setFramebufferScaleFactor: vi.fn(), getBaseLayer() { return this.layer; }, getCamera: () => ({ cameras: [] }),
    });
    setSize = vi.fn(); setPixelRatio = vi.fn(); setAnimationLoop = vi.fn(); dispose = vi.fn();
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('applies High before XR entry, on session setup/re-entry, and after live quality switches; disposal removes the handler', () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 2 }));
  vi.spyOn(SceneManager.prototype as any, 'createSkyDome').mockImplementation(() => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  const scene = new SceneManager({ appendChild: vi.fn() } as any, 'quest-high'), xr = scene.renderer.xr as any;
  try {
    expect(xr.setFramebufferScaleFactor).toHaveBeenCalledExactlyOnceWith(1);
    expect(xr.setFoveation).toHaveBeenLastCalledWith(0);
    expect(scene.getXRRenderQuality()).toMatchObject({ xrRequestedFoveation: 0, xrLayerFoveation: null, xrLayerType: 'none' });
    const pose = scene.camera.position.clone(), root = scene.dioramaRoot.matrix.clone();
    for (let entry = 0; entry < 2; entry++) {
      xr.isPresenting = true; xr.layer = { textureWidth: 2400, textureHeight: 2560, textureArrayLength: 2, fixedFoveation: 1 };
      xr.dispatchEvent({ type: 'sessionstart' });
      expect(scene.getXRRenderQuality()).toMatchObject({ xrRequestedFoveation: 0, xrLayerFoveation: 0, xrLayerFoveationSupported: true });
      scene.setQualityProfile('quest-balanced'); expect(xr.layer.fixedFoveation).toBe(1);
      scene.setQualityProfile('desktop-high'); expect(xr.layer.fixedFoveation).toBe(0);
      xr.isPresenting = false; xr.layer = null; xr.dispatchEvent({ type: 'sessionend' });
    }
    expect(scene.camera.position.equals(pose)).toBe(true); expect(scene.dioramaRoot.matrix.equals(root)).toBe(true);
    const count = xr.setFoveation.mock.calls.length; scene.dispose();
    xr.dispatchEvent({ type: 'sessionstart' }); expect(xr.setFoveation).toHaveBeenCalledTimes(count);
  } finally { if (!vi.mocked(scene.renderer.dispose).mock.calls.length) scene.dispose(); }
});

it('reads a runtime-clamped projection-layer value independently of the request or Three cached getter', () => {
  const cachedGetter = vi.fn(() => 0);
  const xr = { isPresenting: true, getFoveation: cachedGetter,
    getBaseLayer: () => ({ textureWidth: 2400, textureHeight: 2560, textureArrayLength: 2, fixedFoveation: .75 }),
    getCamera: () => ({ cameras: [{ viewport: new THREE.Vector4(0, 0, 1200, 2560) }, { viewport: new THREE.Vector4(1200, 0, 1190, 2560) }] }) };
  expect(readXRRenderQuality(xr, 0)).toEqual({ xrRequestedFoveation: 0, xrLayerFoveation: .75, xrLayerFoveationSupported: true,
    xrFramebufferScaleRequested: 1, xrLayerType: 'projection', xrLayerWidth: 2400, xrLayerHeight: 2560, xrLayerArrayLength: 2,
    xrEyeViewports: [{ width: 1200, height: 2560 }, { width: 1190, height: 2560 }] });
  expect(cachedGetter).not.toHaveBeenCalled();
});

it.each([null, undefined])('reports unsupported WebGL-layer foveation %s without inventing an applied value', fixedFoveation => {
  const result = readXRRenderQuality({ isPresenting: true, getBaseLayer: () => ({ framebufferWidth: 3000, framebufferHeight: 1600, fixedFoveation }) }, 0);
  expect(result).toMatchObject({ xrLayerType: 'webgl', xrLayerWidth: 3000, xrLayerHeight: 1600,
    xrLayerArrayLength: null, xrLayerFoveation: null, xrLayerFoveationSupported: false });
});

it('keeps absent, detached and out-of-session runtime state unknown', () => {
  const throwing = vi.fn(() => { throw Error('Layer detached'); });
  expect(readXRRenderQuality({ isPresenting: true, getBaseLayer: throwing, getCamera: throwing }, 0))
    .toMatchObject({ xrLayerType: 'unknown', xrLayerFoveationSupported: null, xrLayerWidth: null, xrEyeViewports: [] });
  throwing.mockClear();
  expect(readXRRenderQuality({ isPresenting: false, getBaseLayer: throwing }, 1)).toMatchObject({ xrLayerType: 'none', xrLayerFoveation: null });
  expect(throwing).not.toHaveBeenCalled();
});

it('rejects malformed numeric metadata and bounds recorded eye data to stereo dimensions', () => {
  const result = readXRRenderQuality({ isPresenting: true,
    getBaseLayer: () => ({ textureWidth: Infinity, textureHeight: -1, textureArrayLength: NaN, fixedFoveation: 3 }),
    getCamera: () => ({ cameras: Array.from({ length: 5 }, () => ({ viewport: { z: 100, w: 120 } })) }) }, 0);
  expect(result).toMatchObject({ xrLayerWidth: null, xrLayerHeight: null, xrLayerArrayLength: null, xrLayerFoveation: null, xrLayerFoveationSupported: null });
  expect(result.xrEyeViewports).toHaveLength(2);
  expect(requestedXRFoveation('quest-high')).toBe(0); expect(requestedXRFoveation('desktop-high')).toBe(0);
  expect(requestedXRFoveation('quest-balanced')).toBe(1);
});
