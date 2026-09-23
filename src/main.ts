import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode } from './gpx/TrackTypes';
import { GPXParser } from './gpx/GPXParser';
import { SceneManager } from './core/SceneManager';
import { XRManager } from './core/XRManager';
import { TerrainGenerator, TerrainResult } from './terrain/TerrainGenerator';
import { TrailMesh, TrailResult } from './visualization/TrailMesh';
import { DioramaBase } from './visualization/DioramaBase';
import { FlyoverController } from './visualization/FlyoverController';
import { SpatialHUD } from './ui/SpatialHUD';
import { DesktopOverlay } from './ui/DesktopOverlay';

class TrekViewerApp {
  private sceneManager: SceneManager;
  private xrManager: XRManager;
  private overlay: DesktopOverlay;
  private controls: OrbitControls;

  // Active Trek State
  private currentTrack: TrackStats | null = null;
  private terrainResult: TerrainResult | null = null;
  private trailResult: TrailResult | null = null;
  private flyoverController: FlyoverController | null = null;
  private spatialHUD: SpatialHUD | null = null;
  private currentViewMode: ViewMode = 'diorama';
  private currentTextureStyle: TextureStyle = 'satellite';
  private currentTrailColorMode: TrailColorMode = 'solid';
  private manifest: RouteManifestItem[] = [];

  private lastTimestamp: number = performance.now();
  private isDebugMode: boolean = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
  private dioramaMutationCount: number = 0;
  private lastDioramaPos: THREE.Vector3 = new THREE.Vector3();
  private lastDioramaRot: THREE.Euler = new THREE.Euler();
  private lastDioramaScale: THREE.Vector3 = new THREE.Vector3();
  private lastTelemetryLogTime: number = 0;

  constructor() {
    // Diagnostic instance count (Section 46)
    if (typeof window !== 'undefined') {
      (window as any).__trekViewerInstances = ((window as any).__trekViewerInstances || 0) + 1;
      if ((window as any).__trekViewerInstances > 1) {
        console.warn(`[DIAGNOSTIC] Multiple TrekViewerApp instances detected: ${(window as any).__trekViewerInstances}`);
      }
    }

    console.log(
      `%c[TrekViewer Build]\nLabel: ${__APP_BUILD_INFO__.label}\nSHA: ${__APP_BUILD_INFO__.sha}\nBranch: ${__APP_BUILD_INFO__.branch}\nBuilt: ${__APP_BUILD_INFO__.builtAt}`,
      'color: #38bdf8; font-weight: bold;'
    );

    if (typeof document !== 'undefined') {
      const badge = document.createElement('div');
      badge.id = 'buildBadge';
      badge.style.cssText = 'position:fixed;bottom:8px;right:8px;font-family:monospace;font-size:11px;color:#94a3b8;background:rgba(15,23,42,0.85);padding:4px 10px;border-radius:6px;border:1px solid rgba(148,163,184,0.3);z-index:99999;pointer-events:none;';
      badge.textContent = `Build: ${__APP_BUILD_INFO__.shortSha} | ${__APP_BUILD_INFO__.label}`;
      document.body.appendChild(badge);
    }

    const canvasContainer = document.getElementById('canvas-container')!;
    const uiContainer = document.getElementById('ui-container')!;

    this.lastTimestamp = performance.now();

    // 1. Scene Manager
    this.sceneManager = new SceneManager(canvasContainer);

    // 2. Desktop OrbitControls
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

    // 3. WebXR Manager
    this.xrManager = new XRManager(this.sceneManager);
    this.xrManager.setCallbacks({
      onToggleViewMode: () => this.toggleViewMode(),
      onTogglePlay: () => this.togglePlay(),
      onReset: () => this.resetPosition(),
      onExitMR: () => this.exitMR(),
      onFocusHiker: () => this.focusOnHiker(),
      onScrubDistance: (meters) => {
        if (this.flyoverController) {
          this.flyoverController.pause();
          this.overlay.setPlaying(false);
          this.flyoverController.stepDistanceMeters(meters);
        }
      },
    });

    // 4. Desktop & Quest 2D Overlay
    this.overlay = new DesktopOverlay(uiContainer, {
      onSelectRoute: (route) => this.loadRouteByFile(route.file, route.name),
      onUploadGPX: (content, fileName) => this.loadTrackFromXML(content, fileName),
      onEnterXR: (mode) => this.enterXR(mode),
      onToggleViewMode: (mode) => this.setViewMode(mode),
      onTogglePlay: () => this.togglePlay(),
      onSetSpeed: (speed) => this.flyoverController?.setSpeed(speed),
      onScrub: (progress) => this.flyoverController?.setProgress(progress),
      onSetTextureStyle: (style) => this.setTextureStyle(style),
      onSetTrailColorMode: (mode) => this.setTrailColorMode(mode),
    });

    // 5. Load Manifest and Initial Track
    this.initRoutes();

    // 6. Start WebXR Animation Loop
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
          await this.loadRouteByFile(initial.file, initial.name);
        }
      } else {
        throw new Error('Could not load routes manifest.');
      }
    } catch (e) {
      console.warn('Failed to load route manifest, attempting direct Rainier load:', e);
      await this.loadRouteByFile('/routes/MountRanierViaEmmons.gpx.gpx', 'Mount Rainier via Emmons');
    }
  }

  private async loadRouteByFile(url: string, fallbackName: string): Promise<void> {
    this.overlay.showStatus(`Loading trek: ${fallbackName}...`);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP error ${resp.status}`);
      const xml = await resp.text();
      await this.loadTrackFromXML(xml, fallbackName);
    } catch (e) {
      console.error(e);
      this.overlay.showStatus(`Failed to load trek from ${url}`, true);
    }
  }

  public async loadTrackFromXML(xml: string, fallbackName?: string): Promise<void> {
    try {
      this.overlay.showStatus('Parsing GPX survey track...');
      const track = GPXParser.parse(xml, fallbackName);
      this.currentTrack = track;

      // Clear existing models from dioramaRoot
      while (this.sceneManager.dioramaRoot.children.length > 0) {
        const child = this.sceneManager.dioramaRoot.children[0];
        this.sceneManager.dioramaRoot.remove(child);
      }

      // Generate 3D Terrain
      const terrain = await TerrainGenerator.generate(track, (msg) => {
        this.overlay.showStatus(msg);
        this.spatialHUD?.showStatus(msg);
      });
      this.terrainResult = terrain;
      this.spatialHUD?.clearStatus();
      this.overlay.clearStatus();

      // Generate 3D Trail Mesh
      const trail = TrailMesh.create(track, terrain.elevationSampler, terrain.terrainBaseElevation);
      trail.setColorMode(this.currentTrailColorMode);
      this.trailResult = trail;

      // Generate Diorama Base Pedestal
      const base = DioramaBase.create(track.bounds, -80, track.waypoints, terrain.terrainBaseElevation, terrain.elevationSampler, 1.0);

      // Assemble Diorama Group
      this.sceneManager.dioramaRoot.add(terrain.group);
      this.sceneManager.dioramaRoot.add(trail.group);
      this.sceneManager.dioramaRoot.add(base);

      // Setup Flyover Controller
      this.flyoverController = new FlyoverController(trail, track);
      this.flyoverController.setUpdateCallback((state) => {
        this.overlay.updateScrubber(state.progress, state.currentPoint.ele);
        this.spatialHUD?.updateState(
          state.progress,
          state.currentPoint.ele,
          state.isPlaying,
          this.currentViewMode,
          this.currentTextureStyle,
          undefined,
          this.currentTrailColorMode
        );
      });

      // Remove old Spatial HUD from scene if exists
      if (this.spatialHUD) {
        this.sceneManager.scene.remove(this.spatialHUD.group);
      }

      // Setup 3D Spatial HUD in VR
      this.spatialHUD = new SpatialHUD(track, {
        onTogglePlay: () => this.togglePlay(),
        onToggleViewMode: () => this.toggleViewMode(),
        onToggleTexture: () => {
          const next: TextureStyle =
            this.currentTextureStyle === 'satellite'
              ? 'hybrid'
              : this.currentTextureStyle === 'hybrid'
              ? 'topo'
              : 'satellite';
          this.setTextureStyle(next);
        },
        onToggleTrailColor: () => {
          const next: TrailColorMode =
            this.currentTrailColorMode === 'solid'
              ? 'grade'
              : this.currentTrailColorMode === 'grade'
              ? 'speed'
              : this.currentTrailColorMode === 'speed'
              ? 'elevation'
              : 'solid';
          this.setTrailColorMode(next);
        },
        onReset: () => this.resetPosition(),
        onExitMR: () => this.exitMR(),
        onScrub: (progress) => this.flyoverController?.setProgress(progress),
        onSetSpeed: (speed) => this.flyoverController?.setSpeed(speed),
        onStepSeconds: (secs) => this.flyoverController?.stepSeconds(secs),
        onFocusHiker: () => this.focusOnHiker(),
        onDockHUD: (side) => this.dockHUD(side),
      });

      // Position Spatial HUD docked comfortably to the left (leaving center mountain view completely open)
      this.sceneManager.scene.add(this.spatialHUD.group);
      this.dockHUD('left');

      // Register SpatialHUD with XRManager for laser raycasting and clicks
      this.xrManager.setSpatialHUD(this.spatialHUD);
      this.xrManager.setDioramaContext(track.bounds, terrain.elevationSampler, terrain.terrainBaseElevation, 1.0);

      // Configure View Mode
      const maxDim = Math.max(track.bounds.widthMeters, track.bounds.depthMeters);
      this.sceneManager.setViewMode(this.currentViewMode, maxDim);
      this.trailResult.setViewMode(this.currentViewMode);
      this.xrManager.setViewMode(this.currentViewMode);

      // Update 2D Overlay
      this.overlay.updateTrack(track);
      const distMi = (track.totalDistance * 0.000621371).toFixed(1);
      const gainFt = Math.round(track.elevationGain * 3.28084);
      this.overlay.showStatus(`Loaded: ${track.name} (${distMi} mi, +${gainFt.toLocaleString()} ft gain)`);
    } catch (e: any) {
      console.error(e);
      this.overlay.showStatus(`Error parsing GPX: ${e.message}`, true);
    }
  }

  private currentHUDDockSide: 'left' | 'right' | 'center' = 'left';

  private dockHUD(side: 'left' | 'right' | 'center'): void {
    this.currentHUDDockSide = side;
    if (!this.spatialHUD) return;
    this.spatialHUD.setDockSide(side);

    const camPos = this.sceneManager.camera.position;

    if (this.currentViewMode === 'first-person') {
      this.spatialHUD.group.position.set(0, 1.25, -1.2);
      this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);
      return;
    }

    if (side === 'left') {
      // Docked comfortably to the left of the mountain
      this.spatialHUD.group.position.set(-0.70, 0.95, -0.70);
    } else if (side === 'right') {
      // Docked to the right of the mountain
      this.spatialHUD.group.position.set(0.70, 0.95, -0.70);
    } else {
      // Centered
      this.spatialHUD.group.position.set(0, 0.95, -0.90);
    }

    // Level orientation facing user: pure vertical yaw, zero crooked tilt/roll
    this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);
  }

  private togglePlay(): void {
    if (!this.flyoverController) return;
    const isPlaying = this.flyoverController.togglePlay();
    this.overlay.setPlaying(isPlaying);
    if (this.currentTrack && this.spatialHUD) {
      this.spatialHUD.updateState(
        this.flyoverController.getProgress(),
        this.currentTrack.minElevation,
        isPlaying,
        this.currentViewMode,
        this.currentTextureStyle
      );
    }
  }

  private setViewMode(mode: ViewMode): void {
    this.currentViewMode = mode;
    this.flyoverController?.setViewMode(mode);
    this.trailResult?.setViewMode(mode);
    this.xrManager.setViewMode(mode);

    if (this.currentTrack) {
      const maxDim = Math.max(this.currentTrack.bounds.widthMeters, this.currentTrack.bounds.depthMeters);
      this.sceneManager.setViewMode(mode, maxDim);

      if (mode === 'diorama') {
        this.controls.enabled = !this.sceneManager.renderer.xr.isPresenting;
        // Position HUD docked to preferred side
        this.dockHUD(this.currentHUDDockSide);
      } else {
        // In 1:1 First-Person mode, disable orbit controls
        this.controls.enabled = false;
        // Position HUD comfortably at eye/chest level in front of user
        if (this.spatialHUD) {
          this.spatialHUD.group.position.set(0, 1.25, -1.2);
          this.spatialHUD.group.rotation.set(-0.15, 0, 0);
        }
      }
    }
  }

  private exitMR(): void {
    const session = this.sceneManager.renderer.xr.getSession();
    if (session) {
      session.end();
    }
  }

  private resetPosition(): void {
    this.flyoverController?.setProgress(0);
    if (this.currentTrack) {
      const maxDim = Math.max(this.currentTrack.bounds.widthMeters, this.currentTrack.bounds.depthMeters);
      this.sceneManager.setViewMode(this.currentViewMode, maxDim);
    }
  }

  private focusOnHiker(): void {
    if (!this.flyoverController || !this.currentTrack) return;
    const hikerPos = this.flyoverController.getCurrentWorldPosition();

    if (this.currentViewMode === 'diorama') {
      const scale = this.sceneManager.dioramaRoot.scale.x;
      const rotY = this.sceneManager.dioramaRoot.rotation.y;
      const rotated = hikerPos.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      // Center dioramaRoot so that hiker position is placed comfortably in front of user
      this.sceneManager.dioramaRoot.position.set(
        -rotated.x * scale,
        -0.2 - rotated.y * scale,
        -1.0 - rotated.z * scale
      );
    }
  }

  private toggleViewMode(): void {
    const nextMode: ViewMode = this.currentViewMode === 'diorama' ? 'first-person' : 'diorama';
    this.setViewMode(nextMode);
  }

  private async setTextureStyle(style: TextureStyle): Promise<void> {
    this.currentTextureStyle = style;
    this.overlay.setTextureStyle(style);
    if (this.spatialHUD && this.flyoverController && this.currentTrack) {
      this.spatialHUD.updateState(
        this.flyoverController.getProgress(),
        this.currentTrack.minElevation,
        this.flyoverController.getIsPlaying(),
        this.currentViewMode,
        this.currentTextureStyle,
        undefined,
        this.currentTrailColorMode
      );
    }
    if (this.terrainResult) {
      await this.terrainResult.setTextureStyle(style);
    }
  }

  private setTrailColorMode(mode: TrailColorMode): void {
    this.currentTrailColorMode = mode;
    this.overlay.setTrailColorMode(mode);
    this.trailResult?.setColorMode(mode);
    if (this.spatialHUD && this.flyoverController && this.currentTrack) {
      this.spatialHUD.updateState(
        this.flyoverController.getProgress(),
        this.currentTrack.minElevation,
        this.flyoverController.getIsPlaying(),
        this.currentViewMode,
        this.currentTextureStyle,
        undefined,
        this.currentTrailColorMode
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
        // Fallback to immersive-vr if immersive-ar isn't directly advertised
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

    // 1. Update WebXR inputs (Touch Plus controllers, gestures, diorama grab)
    this.xrManager.update();

    // 2. Update OrbitControls on desktop when not in XR or first-person
    if (this.controls.enabled && this.currentViewMode === 'diorama') {
      this.controls.update();
    }

    // 3. Update Flyover / Animation playback
    if (this.flyoverController) {
      this.flyoverController.update(
        delta,
        this.sceneManager.camera,
        this.sceneManager.dioramaRoot,
        this.sceneManager.renderer.xr.isPresenting
      );
    }

    // 4. In First-Person mode, keep HUD floating comfortably in front of user
    if (this.currentViewMode === 'first-person' && this.spatialHUD) {
      const forward = new THREE.Vector3(0, -0.15, -1.2).applyQuaternion(this.sceneManager.camera.quaternion);
      this.spatialHUD.group.position.copy(this.sceneManager.camera.position).add(forward);
      this.spatialHUD.group.quaternion.copy(this.sceneManager.camera.quaternion);
    }

    // 5. Render Scene
    this.sceneManager.render();

    // 6. Diagnostic Telemetry (?debug=1)
    if (this.isDebugMode) {
      const diorama = this.sceneManager.dioramaRoot;
      if (!this.lastDioramaPos.equals(diorama.position) ||
          !this.lastDioramaRot.equals(diorama.rotation) ||
          !this.lastDioramaScale.equals(diorama.scale)) {
        this.dioramaMutationCount++;
        this.lastDioramaPos.copy(diorama.position);
        this.lastDioramaRot.copy(diorama.rotation);
        this.lastDioramaScale.copy(diorama.scale);
        console.log(`[TELEMETRY] dioramaRoot mutated (#${this.dioramaMutationCount}):`, {
          pos: diorama.position.toArray(),
          rot: [diorama.rotation.x, diorama.rotation.y, diorama.rotation.z],
          scale: diorama.scale.toArray(),
        });
      }

      if (now - this.lastTelemetryLogTime > 1000) {
        this.lastTelemetryLogTime = now;
        const isPresenting = this.sceneManager.renderer.xr.isPresenting;
        const xrCam = isPresenting ? this.sceneManager.renderer.xr.getCamera() : null;
        console.log(`[TELEMETRY]`, {
          build: __APP_BUILD_INFO__.shortSha,
          label: __APP_BUILD_INFO__.label,
          isPresenting,
          dioramaMutations: this.dioramaMutationCount,
          dioramaPos: diorama.position.toArray(),
          dioramaRotY: diorama.rotation.y,
          baseCamPos: this.sceneManager.camera.position.toArray(),
          baseCamQuat: this.sceneManager.camera.quaternion.toArray(),
          xrCamPos: xrCam ? xrCam.position.toArray() : null,
          xrCamQuat: xrCam ? xrCam.quaternion.toArray() : null,
        });
      }
    }
  }
}

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  new TrekViewerApp();
});
