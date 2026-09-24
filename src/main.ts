import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode } from './gpx/TrackTypes';
import { SceneManager } from './core/SceneManager';
import { XRManager } from './core/XRManager';
import { TerrainResult } from './terrain/TerrainGenerator';
import { TrailResult } from './visualization/TrailMesh';
import { FlyoverController } from './visualization/FlyoverController';
import { SpatialHUD } from './ui/SpatialHUD';
import { DesktopOverlay } from './ui/DesktopOverlay';
import { LoadedTrek } from './core/LoadedTrek';
import { RouteLoader } from './core/RouteLoader';
import { TrekSession } from './core/TrekSession';
import { TextureProvider } from './terrain/TextureProvider';

class TrekViewerApp {
  private sceneManager: SceneManager;
  private xrManager: XRManager;
  private overlay: DesktopOverlay;
  private controls: OrbitControls;
  private routeLoader: RouteLoader;
  public readonly session: TrekSession = new TrekSession();

  // Active Trek State Accessors (delegated to RouteLoader & TrekSession)
  public get activeTrek(): LoadedTrek | null {
    return this.routeLoader.getActiveTrek();
  }
  public get currentTrack(): TrackStats | null {
    return this.routeLoader.getActiveTrek()?.track ?? null;
  }
  public get terrainResult(): TerrainResult | null {
    return this.routeLoader.getActiveTrek()?.terrainResult ?? null;
  }
  public get trailResult(): TrailResult | null {
    return this.routeLoader.getActiveTrek()?.trailResult ?? null;
  }
  public get flyoverController(): FlyoverController | null {
    return this.routeLoader.getActiveTrek()?.flyoverController ?? null;
  }
  public get currentViewMode(): ViewMode {
    return this.session.getState().viewMode;
  }
  public get currentTextureStyle(): TextureStyle {
    return this.session.getState().textureStyle;
  }
  public get currentTrailColorMode(): TrailColorMode {
    return this.session.getState().trailColorMode;
  }

  private spatialHUD: SpatialHUD | null = null;
  private manifest: RouteManifestItem[] = [];

  private lastTimestamp: number = performance.now();
  private isDebugMode: boolean = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
  private dioramaMutationCount: number = 0;
  private lastDioramaPos: THREE.Vector3 = new THREE.Vector3();
  private lastDioramaRot: THREE.Euler = new THREE.Euler();
  private lastDioramaScale: THREE.Vector3 = new THREE.Vector3();
  private savedTabletopTransform: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  } | null = null;
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

    this.sceneManager.renderer.xr.addEventListener('sessionstart', async () => {
      this.xrManager.resetInteractionState();
      this.controls.enabled = false;
      this.sceneManager.setXREnergyMode(true);
      if (this.currentViewMode === 'diorama') {
        // Natural tabletop height in room space (82cm above floor, 80cm in front of user)
        this.sceneManager.dioramaRoot.position.set(0, 0.82, -0.80);
        this.sceneManager.dioramaRoot.rotation.set(0, 0, 0);
      }
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
      this.xrManager.resetInteractionState();
      this.controls.enabled = true;
      this.sceneManager.setPassthrough(false);
      this.sceneManager.setXREnergyMode(false);
      if (this.currentViewMode === 'diorama') {
        this.sceneManager.dioramaRoot.position.set(0, -0.2, -1.1);
        this.sceneManager.dioramaRoot.rotation.set(0, 0, 0);
      }
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
      onSelectRoute: (route) => this.loadRouteByFile(route.file, route.name, route.id),
      onUploadGPX: (content, fileName) => this.loadTrackFromXML(content, fileName),
      onEnterXR: (mode) => this.enterXR(mode),
      onToggleViewMode: (mode) => this.setViewMode(mode),
      onTogglePlay: () => this.togglePlay(),
      onSetSpeed: (speed) => this.session.setSpeed(speed),
      onScrub: (progress) => {
        this.flyoverController?.setProgress(progress);
        this.session.setProgress(progress);
      },
      onSetTextureStyle: (style) => this.setTextureStyle(style),
      onSetTrailColorMode: (mode) => this.setTrailColorMode(mode),
      onSetVerticalExaggeration: (val) => this.session.setVerticalExaggeration(val),
    });

    // 5. Transactional Route Loader (Stage F & G)
    this.routeLoader = new RouteLoader({
      dioramaRoot: this.sceneManager.dioramaRoot,
      getIsXR: () => this.sceneManager.renderer.xr.isPresenting,
      getCurrentTrailColorMode: () => this.currentTrailColorMode,
      session: this.session,
      onProgress: (msg, progress) => {
        this.overlay.showStatus(msg);
        this.spatialHUD?.showStatus(msg, progress ?? undefined);
      },
      onError: (err, routeName) => {
        console.error('[TrekViewerApp] Route load error:', err);
        this.overlay.showStatus(`Failed to load trek ${routeName || ''}: ${err.message}`, true);
        this.spatialHUD?.showStatus(`Error: ${err.message}`);
      },
      onTrekCommitted: (newTrek, prevTrek) => {
        this.onTrekCommitted(newTrek, prevTrek);
      },
    });

    // 6. Reactive State Subscriptions (Stage G)
    this.session.subscribe((state, prev) => {
      if (state.isPlaying !== prev.isPlaying) {
        this.overlay.setPlaying(state.isPlaying);
      }
      if (state.playbackSpeed !== prev.playbackSpeed) {
        this.flyoverController?.setSpeed(state.playbackSpeed);
        this.overlay.setPlaybackSpeed(state.playbackSpeed);
      }
      if (state.progress !== prev.progress) {
        this.overlay.updateScrubber(state.progress, state.currentElevation);
        this.syncHUDState();
      }
      if (state.viewMode !== prev.viewMode) {
        this.applyViewMode(state.viewMode);
      }
      if (state.textureStyle !== prev.textureStyle) {
        this.overlay.setTextureStyle(state.textureStyle);
        this.terrainResult?.setTextureStyle(state.textureStyle);
        const attr = TextureProvider.getAttributionForStyle(state.textureStyle);
        this.session.setAttribution(attr);
        this.syncHUDState();
      }
      if (state.trailColorMode !== prev.trailColorMode) {
        this.overlay.setTrailColorMode(state.trailColorMode);
        this.trailResult?.setColorMode(state.trailColorMode);
        this.syncHUDState();
      }
      if (state.verticalExaggeration !== prev.verticalExaggeration) {
        this.activeTrek?.setVerticalExaggeration(state.verticalExaggeration);
        this.xrManager.setVerticalExaggeration(state.verticalExaggeration);
        this.overlay.setVerticalExaggeration(state.verticalExaggeration);
        this.spatialHUD?.setVerticalExaggeration(state.verticalExaggeration);
      }
      if (state.attribution !== prev.attribution || state.terrainQuality !== prev.terrainQuality) {
        this.overlay.setMetaInfo(state.attribution, state.terrainQuality, this.activeTrek?.track.elevationProvenanceStats);
        this.spatialHUD?.setMetaInfo(state.attribution, state.terrainQuality, this.activeTrek?.track.elevationProvenanceStats);
      }
      if (state.loadingPhase !== prev.loadingPhase) {
        this.overlay.setXREnabled(state.loadingPhase === 'ready' || this.activeTrek !== null);
      }
      if (state.loadingMessage !== prev.loadingMessage || state.loadingProgress !== prev.loadingProgress) {
        if (state.loadingPhase === 'error') {
          this.overlay.showStatus(state.loadingMessage, true);
          this.spatialHUD?.showStatus(state.loadingMessage);
        } else if (state.loadingPhase === 'ready') {
          this.overlay.clearStatus();
          this.spatialHUD?.clearStatus();
        } else if (state.loadingMessage) {
          this.overlay.showStatus(state.loadingMessage);
          this.spatialHUD?.showStatus(state.loadingMessage, state.loadingProgress ?? undefined);
        }
      }
    });

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

  private applySessionStateToTrek(newTrek: LoadedTrek): void {
    const state = this.session.getState();
    const track = newTrek.track;

    newTrek.setViewMode(state.viewMode);
    this.xrManager.setViewMode(state.viewMode);
    newTrek.setTextureStyle(state.textureStyle);
    newTrek.setTrailColorMode(state.trailColorMode);
    newTrek.setVerticalExaggeration(state.verticalExaggeration);
    this.xrManager.setVerticalExaggeration(state.verticalExaggeration);

    this.xrManager.setDioramaContext(
      track.bounds,
      newTrek.terrainResult.elevationSampler,
      newTrek.terrainResult.terrainBaseElevation,
      state.verticalExaggeration
    );

    newTrek.flyoverController.setSpeed(state.playbackSpeed);
    newTrek.flyoverController.setProgress(0);
    newTrek.flyoverController.pause();

    this.session.setProgress(0, track.points[0]?.ele || track.minElevation);
    this.session.setPlayback(false);
    this.session.setTerrainQuality(newTrek.terrainResult.terrainQuality);
    const attr = TextureProvider.getAttributionForStyle(state.textureStyle);
    this.session.setAttribution(attr);

    this.overlay.setTextureStyle(state.textureStyle);
    this.overlay.setTrailColorMode(state.trailColorMode);
    this.overlay.setPlaybackSpeed(state.playbackSpeed);
    this.overlay.setVerticalExaggeration(state.verticalExaggeration);
    this.overlay.setMetaInfo(attr, newTrek.terrainResult.terrainQuality, newTrek.track.elevationProvenanceStats);
    this.spatialHUD?.setVerticalExaggeration(state.verticalExaggeration);
    this.spatialHUD?.setMetaInfo(attr, newTrek.terrainResult.terrainQuality, newTrek.track.elevationProvenanceStats);
  }

  private onTrekCommitted(newTrek: LoadedTrek, prevTrek: LoadedTrek | null): void {
    const track = newTrek.track;

    // 1. Setup Flyover Controller callback -> sync to session
    newTrek.flyoverController.setUpdateCallback((state) => {
      this.session.setProgress(state.progress, state.currentPoint.ele, undefined, state.currentPoint);
      this.session.setPlayback(state.isPlaying);
    });

    // 2. Re-create and mount Spatial HUD for this track
    if (this.spatialHUD) {
      if (this.xrManager) {
        this.xrManager.setSpatialHUD(null);
      }
      this.sceneManager.scene.remove(this.spatialHUD.group);
      this.spatialHUD.dispose();
      this.spatialHUD = null;
    }

    this.spatialHUD = new SpatialHUD(track, {
      onTogglePlay: () => this.togglePlay(),
      onToggleViewMode: () => this.toggleViewMode(),
      onToggleTexture: () => {
        const cur = this.session.getState().textureStyle;
        const next: TextureStyle =
          cur === 'satellite'
            ? 'hybrid'
            : cur === 'hybrid'
            ? 'topo'
            : 'satellite';
        this.setTextureStyle(next);
      },
      onToggleTrailColor: () => {
        const cur = this.session.getState().trailColorMode;
        const next: TrailColorMode =
          cur === 'solid'
            ? 'grade'
            : cur === 'grade'
            ? 'speed'
            : cur === 'speed'
            ? 'elevation'
            : 'solid';
        this.setTrailColorMode(next);
      },
      onSetVerticalExaggeration: (factor) => this.session.setVerticalExaggeration(factor),
      onReset: () => this.resetPosition(),
      onExitMR: () => this.exitMR(),
      onScrub: (progress) => {
        this.flyoverController?.setProgress(progress);
        this.session.setProgress(progress);
      },
      onSetSpeed: (speed) => this.session.setSpeed(speed),
      onStepSeconds: (secs) => this.flyoverController?.stepSeconds(secs),
      onFocusHiker: () => this.focusOnHiker(),
      onDockHUD: (side) => this.dockHUD(side),
    });

    // Position Spatial HUD docked comfortably to the left (leaving center mountain view completely open)
    this.sceneManager.scene.add(this.spatialHUD.group);
    this.dockHUD(this.currentHUDDockSide);

    // Register SpatialHUD with XRManager for laser raycasting and clicks
    this.xrManager.setSpatialHUD(this.spatialHUD);

    // 3. Reconcile active session state into newly committed trek
    this.applySessionStateToTrek(newTrek);

    // 4. Reset diorama interaction state
    this.xrManager.resetInteractionState();

    // 5. Configure View Mode in SceneManager
    const maxDim = Math.max(track.bounds.widthMeters, track.bounds.depthMeters);
    this.sceneManager.setViewMode(this.currentViewMode, maxDim);

    // 6. Update 2D Overlay
    this.overlay.clearStatus();
    this.overlay.updateTrack(track);
    this.overlay.setXREnabled(true);
    const distMi = (track.totalDistance * 0.000621371).toFixed(1);
    const gainFt = Math.round(track.elevationGain * 3.28084);
    this.overlay.showStatus(`Loaded: ${track.name} (${distMi} mi, +${gainFt.toLocaleString()} ft gain)`);
  }

  private async loadRouteByFile(url: string, fallbackName: string, routeId?: string): Promise<void> {
    await this.routeLoader.loadRouteFromUrl(url, fallbackName, routeId);
  }

  public async loadTrackFromXML(xml: string, fallbackName?: string): Promise<void> {
    await this.routeLoader.loadRouteFromXml(xml, fallbackName);
  }

  private disposeCurrentTrek(): void {
    if (this.spatialHUD) {
      if (this.xrManager) {
        this.xrManager.setSpatialHUD(null);
      }
      this.sceneManager.scene.remove(this.spatialHUD.group);
      this.spatialHUD.dispose();
      this.spatialHUD = null;
    }
    this.routeLoader.dispose();
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

  private syncHUDState(): void {
    const s = this.session.getState();
    this.spatialHUD?.updateState(
      s.progress,
      s.currentElevation,
      s.isPlaying,
      s.viewMode,
      s.textureStyle,
      s.playbackSpeed,
      s.trailColorMode,
      s.verticalExaggeration
    );
  }

  private togglePlay(): void {
    if (!this.flyoverController) return;
    const isPlaying = this.flyoverController.togglePlay();
    this.session.setPlayback(isPlaying);
  }

  private setViewMode(mode: ViewMode): void {
    this.session.setViewMode(mode);
  }

  private applyViewMode(mode: ViewMode): void {
    const prevMode = this.session.getState().viewMode;
    // Save tabletop transform when transitioning away from diorama
    if (prevMode === 'diorama' && mode === 'first-person') {
      const root = this.sceneManager.dioramaRoot;
      this.savedTabletopTransform = {
        position: root.position.clone(),
        quaternion: root.quaternion.clone(),
        scale: root.scale.clone(),
      };
    }

    this.flyoverController?.setViewMode(mode);
    this.trailResult?.setViewMode(mode);
    this.xrManager.setViewMode(mode);

    if (this.currentTrack) {
      const maxDim = Math.max(this.currentTrack.bounds.widthMeters, this.currentTrack.bounds.depthMeters);
      this.sceneManager.setViewMode(mode, maxDim);

      if (mode === 'diorama') {
        // Restore user diorama transform if saved
        if (this.savedTabletopTransform) {
          const root = this.sceneManager.dioramaRoot;
          root.position.copy(this.savedTabletopTransform.position);
          root.quaternion.copy(this.savedTabletopTransform.quaternion);
          root.scale.copy(this.savedTabletopTransform.scale);
        }
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
  }

  private exitMR(): void {
    const session = this.sceneManager.renderer.xr.getSession();
    if (session) {
      session.end();
    }
  }

  private resetPosition(): void {
    this.flyoverController?.setProgress(0);
    this.session.setProgress(0);
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
      const isXR = this.sceneManager.renderer.xr.isPresenting;
      const baseY = isXR ? 0.82 : -0.2;
      const baseZ = isXR ? -0.80 : -1.0;
      this.sceneManager.dioramaRoot.position.set(
        -rotated.x * scale,
        baseY - rotated.y * scale,
        baseZ - rotated.z * scale
      );
    }
  }

  private toggleViewMode(): void {
    const nextMode: ViewMode = this.currentViewMode === 'diorama' ? 'first-person' : 'diorama';
    this.setViewMode(nextMode);
  }

  private async setTextureStyle(style: TextureStyle): Promise<void> {
    this.session.setTextureStyle(style);
  }

  private setTrailColorMode(mode: TrailColorMode): void {
    this.session.setTrailColorMode(mode);
  }

  private async enterXR(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
    if (!('xr' in navigator)) {
      this.overlay.showStatus('WebXR is not supported by this browser. Open this URL in the Meta Quest Browser on your Quest 3!', true);
      return;
    }

    if (!this.activeTrek) {
      this.overlay.showStatus('Please wait for the trek to finish loading before entering VR/MR.', false);
      return;
    }

    try {
      const isSupported = await (navigator as any).xr.isSessionSupported(mode);
      if (!isSupported) {
        // Fallback to immersive-vr if immersive-ar isn't directly advertised
        const vrSupported = await (navigator as any).xr.isSessionSupported('immersive-vr');
        if (!vrSupported) {
          this.overlay.showStatus(`WebXR ${mode} is not supported on this device.`, true);
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
      this.overlay.showStatus(`Could not start WebXR session: ${e.message}`, true);
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

    // Flush any throttled HUD updates when due
    this.spatialHUD?.update();

    // 5. Update Adaptive Imagery LOD (Stage M)
    if (this.activeTrek && !this.activeTrek.isDisposed) {
      this.activeTrek.imageryLOD.update(
        this.sceneManager.camera,
        this.sceneManager.dioramaRoot,
        this.sceneManager.renderer.xr.isPresenting
      );
    }

    // 6. Render Scene
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
        const memInfo = this.sceneManager.getMemoryInfo();
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
          gpuMemory: memInfo.memory,
          renderCalls: memInfo.render.calls,
        });
      }
    }
  }

  public dispose(): void {
    this.disposeCurrentTrek();
    this.controls.dispose();
    this.overlay.dispose();
    this.sceneManager.dispose();
  }
}

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  new TrekViewerApp();
});

