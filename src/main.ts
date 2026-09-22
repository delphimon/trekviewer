import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RouteManifestItem, ViewMode, TextureStyle, TrailColorMode, GPXWaypoint } from './gpx/TrackTypes.ts';
import { TrekSession } from './core/TrekSession.ts';
import { RouteLoader } from './core/RouteLoader.ts';
import { LoadedTrek } from './core/LoadedTrek.ts';
import { SceneManager } from './core/SceneManager.ts';
import { XRManager } from './core/XRManager.ts';
import { SpatialHUD } from './ui/SpatialHUD.ts';
import { DesktopOverlay } from './ui/DesktopOverlay.ts';

class TrekViewerApp {
  private session: TrekSession;
  private sceneManager: SceneManager;
  private routeLoader: RouteLoader;
  private xrManager: XRManager;
  private overlay: DesktopOverlay;
  private controls: OrbitControls;

  private spatialHUD: SpatialHUD | null = null;
  private manifest: RouteManifestItem[] = [];
  private currentHUDDockSide: 'left' | 'right' | 'center' = 'left';
  private lastTimestamp: number = performance.now();

  constructor() {
    const canvasContainer = document.getElementById('canvas-container')!;
    const uiContainer = document.getElementById('ui-container')!;

    this.lastTimestamp = performance.now();

    // 1. Authoritative Session Store
    this.session = new TrekSession();

    // 2. Scene Manager
    this.sceneManager = new SceneManager(canvasContainer);

    // 3. Route Loader with Transactional Lifecycle Management
    this.routeLoader = new RouteLoader(this.session, this.sceneManager);

    // 4. Desktop OrbitControls
    this.controls = new OrbitControls(this.sceneManager.camera, this.sceneManager.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxDistance = 8.0;
    this.controls.minDistance = 0.2;
    this.controls.target.set(0, 0, 0);

    // Disable OrbitControls during WebXR sessions and activate power-efficient mode
    this.sceneManager.renderer.xr.addEventListener('sessionstart', async () => {
      this.controls.enabled = false;
      this.sceneManager.setXREnergyMode(true);
      const session = this.sceneManager.renderer.xr.getSession();
      if (session) {
        // Request 72Hz framerate on Meta Quest 3 to drastically reduce heat and conserve battery
        try {
          const supported = (session as any).supportedFrameRates;
          if (supported && supported.includes(72)) {
            await (session as any).updateTargetFrameRate(72);
            console.log('WebXR: Activated 72Hz power-efficient framerate mode.');
          }
        } catch (e) {
          console.warn('Could not set target framerate to 72Hz:', e);
        }
      }
    });
    this.sceneManager.renderer.xr.addEventListener('sessionend', () => {
      this.controls.enabled = true;
      this.sceneManager.setPassthrough(false);
      this.sceneManager.setXREnergyMode(false);
    });

    // 5. WebXR Manager
    this.xrManager = new XRManager(this.sceneManager);
    this.xrManager.setCallbacks({
      onToggleViewMode: () => this.toggleViewMode(),
      onTogglePlay: () => this.togglePlay(),
      onReset: () => this.resetPosition(),
      onExitMR: () => this.exitMR(),
      onFocusHiker: () => this.focusOnHiker(),
      onSelectWaypoint: (name) => {
        const active = this.routeLoader.getActiveTrek();
        if (!active) return;
        const allWps = active.track.waypoints.concat(active.track.landmarks);
        const wp = allWps.find((w) => w.name === name);
        if (wp) {
          this.jumpToWaypoint(wp);
        }
      },
      onScrubDistance: (meters) => {
        const active = this.routeLoader.getActiveTrek();
        if (active) {
          active.flyoverController.pause();
          this.session.setPlayback(false);
          active.flyoverController.stepDistanceMeters(meters);
        }
      },
    });

    // 6. Desktop & Quest 2D Overlay
    this.overlay = new DesktopOverlay(
      uiContainer,
      {
        onSelectRoute: (route) => this.loadRouteByFile(route.file, route.name, route.id),
        onUploadGPX: (content, fileName) => this.loadTrackFromXML(content, fileName),
        onEnterXR: (mode) => this.enterXR(mode),
        onToggleViewMode: (mode) => this.setViewMode(mode),
        onTogglePlay: () => this.togglePlay(),
        onSetSpeed: (speed) => {
          this.session.setSpeed(speed);
          this.routeLoader.getActiveTrek()?.flyoverController.setSpeed(speed);
        },
        onScrub: (progress) => {
          this.routeLoader.getActiveTrek()?.flyoverController.setProgress(progress);
        },
        onSetTextureStyle: (style) => this.setTextureStyle(style),
        onSetTrailColorMode: (mode) => this.setTrailColorMode(mode),
        onSetVerticalExaggeration: (factor) => this.setVerticalExaggeration(factor),
        onSelectWaypoint: (wp) => this.jumpToWaypoint(wp),
      },
      this.session
    );

    // 7. Load Manifest and Initial Track
    this.initRoutes();

    // 8. Start WebXR Animation Loop
    this.sceneManager.renderer.setAnimationLoop(this.animate.bind(this));
  }

  private async initRoutes(): Promise<void> {
    try {
      const resp = await fetch('/routes/manifest.json');
      if (resp.ok) {
        this.manifest = await resp.json();
        this.overlay.setManifest(this.manifest);
        // Load default iconic trek: Mount Rainier via Emmons Glacier
        const initial = this.manifest.find((m) => m.id === 'rainier-emmons') || this.manifest[0];
        if (initial) {
          await this.loadRouteByFile(initial.file, initial.name, initial.id);
        }
      } else {
        throw new Error('Could not load routes manifest.');
      }
    } catch (e) {
      console.warn('Failed to load route manifest, attempting direct Rainier load:', e);
      await this.loadRouteByFile('/routes/MountRanierViaEmmons.gpx.gpx', 'Mount Rainier via Emmons', 'rainier-emmons');
    }
  }

  private async loadRouteByFile(url: string, fallbackName: string, routeId?: string): Promise<void> {
    const trek = await this.routeLoader.loadRouteFromUrl(url, fallbackName, routeId ?? url);
    if (trek) {
      this.onTrekLoaded(trek);
    }
  }

  public async loadTrackFromXML(xml: string, fallbackName?: string): Promise<void> {
    const trek = await this.routeLoader.loadRouteFromXml(xml, fallbackName, 'upload', 'upload');
    if (trek) {
      this.onTrekLoaded(trek);
    }
  }

  private onTrekLoaded(trek: LoadedTrek): void {
    // Setup Flyover Controller callbacks to sync session state
    trek.flyoverController.setUpdateCallback((state) => {
      this.session.setProgress(
        state.progress,
        state.currentPoint.ele,
        state.currentPoint.distanceFromStart,
        state.currentPoint
      );
      this.session.setPlayback(state.isPlaying);
    });

    // Remove and dispose old SpatialHUD if exists
    if (this.spatialHUD) {
      this.sceneManager.scene.remove(this.spatialHUD.group);
      this.spatialHUD.dispose();
      this.spatialHUD = null;
    }

    // Setup 3D Spatial HUD in VR
    this.spatialHUD = new SpatialHUD(
      trek.track,
      {
        onTogglePlay: () => this.togglePlay(),
        onToggleViewMode: () => this.toggleViewMode(),
        onToggleTexture: () => this.cycleTexture(),
        onToggleTrailColor: () => this.cycleTrailColor(),
        onCycleExaggeration: () => this.cycleExaggeration(),
        onReset: () => this.resetPosition(),
        onExitMR: () => this.exitMR(),
        onScrub: (progress) => trek.flyoverController.setProgress(progress),
        onSetSpeed: (speed) => {
          this.session.setSpeed(speed);
          trek.flyoverController.setSpeed(speed);
        },
        onStepSeconds: (secs) => trek.flyoverController.stepSeconds(secs),
        onFocusHiker: () => this.focusOnHiker(),
        onDockHUD: (side) => this.dockHUD(side),
        onSelectWaypoint: (wp) => this.jumpToWaypoint(wp),
      },
      this.session
    );

    // Add HUD to scene and dock
    this.sceneManager.scene.add(this.spatialHUD.group);
    this.dockHUD(this.currentHUDDockSide);

    // Register SpatialHUD with XRManager for laser raycasting and clicks
    this.xrManager.setSpatialHUD(this.spatialHUD);

    // Sync session state to trek components
    const state = this.session.getState();
    trek.trailResult.setColorMode(state.trailColorMode);
    trek.trailResult.setViewMode(state.viewMode);
    trek.flyoverController.setViewMode(state.viewMode);
    trek.flyoverController.setSpeed(state.playbackSpeed);
    trek.setVerticalExaggeration(state.verticalExaggeration);

    const maxDim = Math.max(trek.track.bounds.widthMeters, trek.track.bounds.depthMeters);
    this.sceneManager.setViewMode(state.viewMode, maxDim);
    this.xrManager.setViewMode(state.viewMode);
  }

  private jumpToWaypoint(wp: GPXWaypoint): void {
    this.session.selectWaypoint(wp);
    const active = this.routeLoader.getActiveTrek();
    if (!active) return;
    const track = active.track;
    if (!track || track.points.length === 0) return;

    // Find closest route track point to waypoint
    let bestIdx = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < track.points.length; i++) {
      const p = track.points[i];
      const dLat = p.lat - wp.lat;
      const dLon = p.lon - wp.lon;
      const dSq = dLat * dLat + dLon * dLon;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }

    const targetPoint = track.points[bestIdx];
    const progress = track.totalDistance > 0 ? targetPoint.distanceFromStart / track.totalDistance : 0;
    active.flyoverController.setProgress(progress);
  }

  private dockHUD(side: 'left' | 'right' | 'center'): void {
    this.currentHUDDockSide = side;
    if (!this.spatialHUD) return;
    this.spatialHUD.setDockSide(side);

    const isXR = this.sceneManager.renderer.xr.isPresenting;
    const viewMode = this.session.getState().viewMode;

    if (viewMode === 'first-person') {
      const xrCam = isXR ? this.sceneManager.renderer.xr.getCamera() : this.sceneManager.camera;
      const forward = new THREE.Vector3(0, -0.15, -1.2).applyQuaternion(xrCam.quaternion);
      this.spatialHUD.group.position.copy(xrCam.position).add(forward);
      this.spatialHUD.group.quaternion.copy(xrCam.quaternion);
      return;
    }

    if (isXR) {
      const xrCam = this.sceneManager.renderer.xr.getCamera();
      const headPos = xrCam.position;
      const hasValidHead = headPos.y > 0.4;

      if (hasValidHead) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
        fwd.y = 0;
        if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
        else fwd.normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

        if (side === 'left') {
          const target = headPos.clone()
            .addScaledVector(fwd, 0.70)
            .addScaledVector(right, -0.72)
            .add(new THREE.Vector3(0, -0.05, 0));
          this.spatialHUD.group.position.copy(target);
          this.spatialHUD.group.lookAt(headPos.x, this.spatialHUD.group.position.y, headPos.z);
        } else if (side === 'right') {
          const target = headPos.clone()
            .addScaledVector(fwd, 0.70)
            .addScaledVector(right, 0.72)
            .add(new THREE.Vector3(0, -0.05, 0));
          this.spatialHUD.group.position.copy(target);
          this.spatialHUD.group.lookAt(headPos.x, this.spatialHUD.group.position.y, headPos.z);
        } else {
          const target = headPos.clone()
            .addScaledVector(fwd, 1.12)
            .add(new THREE.Vector3(0, 0.18, 0));
          this.spatialHUD.group.position.copy(target);
          this.spatialHUD.group.lookAt(headPos.x, headPos.y, headPos.z);
        }
      } else {
        // Standard WebXR room coordinates (user at origin facing -Z)
        if (side === 'left') {
          this.spatialHUD.group.position.set(-0.70, 1.05, -0.70);
          this.spatialHUD.group.lookAt(0, 1.05, 0);
        } else if (side === 'right') {
          this.spatialHUD.group.position.set(0.70, 1.05, -0.70);
          this.spatialHUD.group.lookAt(0, 1.05, 0);
        } else {
          this.spatialHUD.group.position.set(0.0, 1.35, -1.15);
          this.spatialHUD.group.lookAt(0, 1.20, 0);
        }
      }
    } else {
      // Desktop inspection mode
      if (side === 'left') {
        this.spatialHUD.group.position.set(-0.65, 0.25, -0.55);
        this.spatialHUD.group.rotation.set(0, 0.35, 0);
      } else if (side === 'right') {
        this.spatialHUD.group.position.set(0.65, 0.25, -0.55);
        this.spatialHUD.group.rotation.set(0, -0.35, 0);
      } else {
        this.spatialHUD.group.position.set(0.0, 0.45, -0.75);
        this.spatialHUD.group.rotation.set(-0.15, 0, 0);
      }
    }
  }

  private togglePlay(): void {
    const active = this.routeLoader.getActiveTrek();
    if (!active) return;
    const isPlaying = active.flyoverController.togglePlay();
    this.session.setPlayback(isPlaying);
  }

  private cycleTexture(): void {
    const current = this.session.getState().textureStyle;
    const next: TextureStyle =
      current === 'satellite' ? 'hybrid' : current === 'hybrid' ? 'topo' : 'satellite';
    this.setTextureStyle(next);
  }

  private cycleTrailColor(): void {
    const current = this.session.getState().trailColorMode;
    const next: TrailColorMode =
      current === 'solid'
        ? 'grade'
        : current === 'grade'
        ? 'speed'
        : current === 'speed'
        ? 'elevation'
        : 'solid';
    this.setTrailColorMode(next);
  }

  private cycleExaggeration(): void {
    const current = this.session.getState().verticalExaggeration;
    const next = current >= 2.9 ? 1.0 : current >= 1.9 ? 3.0 : 2.0;
    this.setVerticalExaggeration(next);
  }

  private setViewMode(mode: ViewMode): void {
    this.session.setViewMode(mode);
    const active = this.routeLoader.getActiveTrek();
    if (active) {
      active.flyoverController.setViewMode(mode);
      active.trailResult.setViewMode(mode);
      const maxDim = Math.max(active.track.bounds.widthMeters, active.track.bounds.depthMeters);
      this.sceneManager.setViewMode(mode, maxDim);
    }
    this.xrManager.setViewMode(mode);

    if (mode === 'diorama') {
      this.controls.enabled = !this.sceneManager.renderer.xr.isPresenting;
      this.dockHUD(this.currentHUDDockSide);
    } else {
      this.controls.enabled = false;
      if (this.spatialHUD) {
        this.spatialHUD.group.position.set(0, 1.25, -1.2);
        this.spatialHUD.group.rotation.set(-0.15, 0, 0);
      }
    }
  }

  private toggleViewMode(): void {
    const current = this.session.getState().viewMode;
    const nextMode: ViewMode = current === 'diorama' ? 'first-person' : 'diorama';
    this.setViewMode(nextMode);
  }

  private async setTextureStyle(style: TextureStyle): Promise<void> {
    this.session.setTextureStyle(style);
    const active = this.routeLoader.getActiveTrek();
    if (active) {
      active.setTextureStyle(style);
    }
  }

  private setTrailColorMode(mode: TrailColorMode): void {
    this.session.setTrailColorMode(mode);
    const active = this.routeLoader.getActiveTrek();
    if (active) {
      active.trailResult.setColorMode(mode);
    }
  }

  private setVerticalExaggeration(factor: number): void {
    this.session.setVerticalExaggeration(factor);
    const active = this.routeLoader.getActiveTrek();
    if (active) {
      active.setVerticalExaggeration(factor);
    }
  }

  private exitMR(): void {
    const session = this.sceneManager.renderer.xr.getSession();
    if (session) {
      session.end();
    }
  }

  private resetPosition(): void {
    const active = this.routeLoader.getActiveTrek();
    if (active) {
      active.flyoverController.setProgress(0);
      const maxDim = Math.max(active.track.bounds.widthMeters, active.track.bounds.depthMeters);
      this.sceneManager.setViewMode(this.session.getState().viewMode, maxDim);
    }
    // Re-anchor diorama and HUD right in front of user within arm's reach
    this.sceneManager.resetToArmLength();
    this.dockHUD(this.currentHUDDockSide);
  }

  private focusOnHiker(): void {
    const active = this.routeLoader.getActiveTrek();
    if (!active) return;
    const hikerPos = active.flyoverController.getCurrentWorldPosition();

    if (this.session.getState().viewMode === 'diorama') {
      const scale = this.sceneManager.dioramaRoot.scale.x;
      const rotY = this.sceneManager.dioramaRoot.rotation.y;
      const rotated = hikerPos.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      this.sceneManager.dioramaRoot.position.set(
        -rotated.x * scale,
        -0.2 - rotated.y * scale,
        -1.0 - rotated.z * scale
      );
    }
  }

  private async enterXR(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
    if (!('xr' in navigator)) {
      alert('WebXR is not supported by this browser. Open this URL in the Meta Quest Browser on your Quest 3!');
      return;
    }

    try {
      const isSupported = await (navigator as any).xr.isSessionSupported(mode);
      if (!isSupported) {
        const vrSupported = await (navigator as any).xr.isSessionSupported('immersive-vr');
        if (!vrSupported) {
          alert(`WebXR ${mode} is not supported on this device.`);
          return;
        }
        mode = 'immersive-vr';
      }

      const sessionInit: XRSessionInit = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'layers'],
      };

      const session = await (navigator as any).xr.requestSession(mode, sessionInit);
      await this.sceneManager.renderer.xr.setSession(session);

      if (mode === 'immersive-ar') {
        this.sceneManager.setPassthrough(true);
      } else {
        this.sceneManager.setPassthrough(false);
      }
    } catch (e: any) {
      console.error('Failed to start WebXR session:', e);
      alert(`Could not start WebXR session: ${e.message}`);
    }
  }

  private animate(timestamp: number, frame?: XRFrame): void {
    const now = performance.now();
    const delta = Math.min((now - this.lastTimestamp) / 1000, 0.1);
    this.lastTimestamp = now;

    // 1. Update WebXR inputs with frame delta (frame-rate independent locomotion, pan, zoom)
    this.xrManager.update(delta);

    // 2. Update OrbitControls on desktop when not in XR or first-person
    if (this.controls.enabled && this.session.getState().viewMode === 'diorama') {
      this.controls.update();
    }

    // 3. Update Flyover / Animation playback & Adaptive Imagery LOD
    const active = this.routeLoader.getActiveTrek();
    if (active) {
      active.flyoverController.update(
        delta,
        this.sceneManager.camera,
        this.sceneManager.dioramaRoot,
        this.sceneManager.renderer.xr.isPresenting
      );
      active.lodManager?.update(
        this.sceneManager.camera,
        this.sceneManager.dioramaRoot,
        this.session.getState().viewMode,
        delta
      );
    }

    // 4. In First-Person mode, keep HUD floating comfortably in front of user
    if (this.session.getState().viewMode === 'first-person' && this.spatialHUD) {
      const forward = new THREE.Vector3(0, -0.15, -1.2).applyQuaternion(this.sceneManager.camera.quaternion);
      this.spatialHUD.group.position.copy(this.sceneManager.camera.position).add(forward);
      this.spatialHUD.group.quaternion.copy(this.sceneManager.camera.quaternion);
    }

    // 5. Render Scene
    this.sceneManager.render();
  }
}

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  new TrekViewerApp();
});
