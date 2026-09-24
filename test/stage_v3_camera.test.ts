import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { XRManager } from '../src/core/XRManager';
import { TrekSession } from '../src/core/TrekSession';
import { TrekViewerApp } from '../src/main';

describe('Stage V3: First-Person Exaggeration on Route Switch & XR Active Camera Consistency', () => {
  beforeEach(() => {
    const mockCtx: any = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      measureText: () => ({ width: 80 }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
      roundRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };

    (globalThis as any).window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        getContext: () => mockCtx,
        width: 384,
        height: 128,
        style: {},
      }),
    };
  });

  describe('3.1 First-Person Exaggeration on Route Switch (Stage V9)', () => {
    it('applies 1.0x natural scale in first-person mode during route replacement, preserving stored tabletop preference', () => {
      const session = new TrekSession();
      const app = Object.create(TrekViewerApp.prototype);
      app.session = session;
      app.overlay = {
        setTextureStyle: vi.fn(),
        setTrailColorMode: vi.fn(),
        setPlaybackSpeed: vi.fn(),
        setVerticalExaggeration: vi.fn(),
        setMetaInfo: vi.fn(),
      };

      // 1. User sets tabletop exaggeration preference to 2.5x in diorama mode
      session.setVerticalExaggeration(2.5);
      expect(session.getState().verticalExaggeration).toBe(2.5);

      // 2. User enters first-person mode
      session.setViewMode('first-person');
      expect(session.getState().viewMode).toBe('first-person');
      // The session still preserves 2.5x as the user's tabletop preference!
      expect(session.getState().verticalExaggeration).toBe(2.5);

      // 3. User loads a new trek while in first-person mode
      const mockSetVerticalExaggeration = vi.fn();
      const mockSetViewMode = vi.fn();
      const mockSetTextureStyle = vi.fn();
      const mockSetTrailColorMode = vi.fn();

      const newTrek: any = {
        track: {
          bounds: {
            minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
            minEle: 1000, maxEle: 4000, centerLat: 46.85, centerLon: -121.75,
            widthMeters: 8000, depthMeters: 8000, elevationSpan: 3000,
          },
          points: [{ ele: 1000 }],
        },
        terrainResult: {
          elevationSampler: vi.fn(),
          terrainBaseElevation: 1000,
          terrainQuality: 'full',
        },
        flyoverController: {
          setSpeed: vi.fn(),
          setProgress: vi.fn(),
          pause: vi.fn(),
        },
        setViewMode: mockSetViewMode,
        setTextureStyle: mockSetTextureStyle,
        setTrailColorMode: mockSetTrailColorMode,
        setVerticalExaggeration: mockSetVerticalExaggeration,
      };

      const mockXrManager = {
        setViewMode: vi.fn(),
        setVerticalExaggeration: vi.fn(),
        setDioramaContext: vi.fn(),
      };
      app.xrManager = mockXrManager;

      // Execute applySessionStateToTrek
      (app as any).applySessionStateToTrek(newTrek);

      // Invariant: Because viewMode is 'first-person', effective exaggeration applied to 3D components MUST be 1.0!
      expect(mockSetVerticalExaggeration).toHaveBeenCalledWith(1.0);
      expect(mockXrManager.setVerticalExaggeration).toHaveBeenCalledWith(1.0);
      expect(mockXrManager.setDioramaContext).toHaveBeenCalledWith(
        newTrek.track.bounds,
        newTrek.terrainResult.elevationSampler,
        newTrek.terrainResult.terrainBaseElevation,
        1.0 // Effective exaggeration must be 1.0
      );

      // User's stored preference in session state is still 2.5
      expect(session.getState().verticalExaggeration).toBe(2.5);

      // 4. Now test switching back to diorama mode restores 2.5x
      session.setViewMode('diorama');
      (app as any).applySessionStateToTrek(newTrek);

      // Invariant: In diorama mode, user preference 2.5x is restored!
      expect(mockSetVerticalExaggeration).toHaveBeenLastCalledWith(2.5);
      expect(mockXrManager.setVerticalExaggeration).toHaveBeenLastCalledWith(2.5);
      expect(mockXrManager.setDioramaContext).toHaveBeenLastCalledWith(
        newTrek.track.bounds,
        newTrek.terrainResult.elevationSampler,
        newTrek.terrainResult.terrainBaseElevation,
        2.5
      );
    });
  });

  describe('3.2 XR Active Camera Consistency (Stage V10)', () => {
    it('returns renderer.xr.getCamera() when presenting and sceneManager.camera when not presenting', () => {
      const baseCamera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      baseCamera.position.set(0, 1.6, 2.5);

      const xrCamera = new THREE.PerspectiveCamera(90, 1.0, 0.1, 100);
      xrCamera.position.set(0.5, 1.8, -0.2); // Headset position in room space

      let isPresenting = false;
      const mockSceneManager: any = {
        renderer: {
          xr: {
            get isPresenting() {
              return isPresenting;
            },
            getCamera: () => xrCamera,
            getController: () => new THREE.Group(),
            getControllerGrip: () => new THREE.Group(),
            getHand: () => new THREE.Group(),
            getSession: () => null,
          },
        },
        camera: baseCamera,
        scene: new THREE.Scene(),
        dioramaRoot: new THREE.Group(),
      };

      const xrManager = new XRManager(mockSceneManager);

      // When NOT presenting in XR
      isPresenting = false;
      expect(xrManager.getActiveCamera()).toBe(baseCamera);

      // When presenting in XR
      isPresenting = true;
      expect(xrManager.getActiveCamera()).toBe(xrCamera);
    });

    it('orients Spatial HUD dragging toward active XR camera position rather than stale desktop camera', () => {
      const baseCamera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      baseCamera.position.set(0, 1.6, 2.5); // Stale desktop position

      const xrCamera = new THREE.PerspectiveCamera(90, 1.0, 0.1, 100);
      xrCamera.position.set(0.2, 1.7, -0.5); // Active headset position

      const mockSceneManager: any = {
        renderer: {
          xr: {
            isPresenting: true,
            getCamera: () => xrCamera,
            getController: () => new THREE.Group(),
            getControllerGrip: () => new THREE.Group(),
            getHand: () => new THREE.Group(),
            getSession: () => null,
          },
        },
        camera: baseCamera,
        scene: new THREE.Scene(),
        dioramaRoot: new THREE.Group(),
      };

      const xrManager = new XRManager(mockSceneManager);

      const mockHUD = {
        group: new THREE.Group(),
        grabMesh: new THREE.Mesh(),
        setDockSide: vi.fn(),
      };
      xrManager.setSpatialHUD(mockHUD as any);

      const lookAtSpy = vi.spyOn(mockHUD.group, 'lookAt');

      // Hand direct grab on HUD top handle
      const handState = (xrManager as any).hands[0];
      const fingerPos = new THREE.Vector3(0, 1.2, -0.6);

      // Simulate hand pinch grabbing HUD handle
      // Place finger inside grab handle local coordinate space
      mockHUD.group.position.set(0, 1.0, -0.6);
      mockHUD.group.updateMatrixWorld(true);

      // Handle area is local y in [0.18, 0.38] -> world Y around 1.25
      const handleFingerPos = new THREE.Vector3(0, 1.25, -0.6);
      const isHandled = (xrManager as any).checkHandHUDInteraction(handState, handleFingerPos, true);

      expect(isHandled).toBe(true);
      expect(lookAtSpy).toHaveBeenCalled();

      // LookAt target must be using xrCamera's world coordinates (x = 0.2, z = -0.5), NOT baseCamera (x = 0, z = 2.5)
      const lastCallArgs = lookAtSpy.mock.calls[lookAtSpy.mock.calls.length - 1];
      expect(lastCallArgs[0]).toBeCloseTo(0.2, 2); // xrCamera.x
      expect(lastCallArgs[2]).toBeCloseTo(-0.5, 2); // xrCamera.z
    });
  });
});
