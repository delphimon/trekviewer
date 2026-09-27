import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode } from './gpx/TrackTypes';
import { FrameTimingMonitor } from './core/FrameTimingMonitor';
import { PerformanceSessionRecorder, type ProfileCounters, type ProfilePhase, type ProfileReport } from './core/PerformanceSessionRecorder';
import { SceneManager } from './core/SceneManager';
import { XRManager } from './core/XRManager';
import { TerrainResult } from './terrain/TerrainGenerator';
import { TrailResult } from './visualization/TrailMesh';
import { FlyoverController } from './visualization/FlyoverController';
import { DioramaBase } from './visualization/DioramaBase';
import { SpatialHUD } from './ui/SpatialHUD';
import { DesktopOverlay } from './ui/DesktopOverlay';
import { LoadedTrek } from './core/LoadedTrek';
import { RouteLoader } from './core/RouteLoader';
import { TrekSession } from './core/TrekSession';
import { TextureProvider } from './terrain/TextureProvider';
import { TileImageCache } from './terrain/TileImageCache';
import { QualityProfileManager } from './terrain/QualityProfile';
import { resolveAssetUrl } from './utils/AssetUrl';

const _scratchV3 = new THREE.Vector3();

export class TrekViewerApp {
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
  private isProfilingMode: boolean = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('profile') === '1';
  private readonly profileRecorder = this.isProfilingMode ? new PerformanceSessionRecorder() : null;
  private readonly recordImageryPhase = (phase: ProfilePhase, elapsedMs: number): void => {
    this.profileRecorder?.recordPhase(phase, elapsedMs);
  };
  private completedProfile: ProfileReport | null = null;
  private profileControls: HTMLElement | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private profileSuspended = false;
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
  private readonly frameTiming = new FrameTimingMonitor();

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

    // Visual badge shown in development or when ?debug=1 is enabled (Requirement #112)
    if (typeof document !== 'undefined' && (this.isDebugMode || (import.meta as any).env?.DEV)) {
      const badge = document.createElement('div');
      badge.id = 'buildBadge';
      badge.style.cssText = 'position:fixed;bottom:8px;right:8px;font-family:monospace;font-size:11px;color:#94a3b8;background:rgba(15,23,42,0.85);padding:4px 10px;border-radius:6px;border:1px solid rgba(148,163,184,0.3);z-index:99999;pointer-events:none;';
      badge.textContent = `Build: ${__APP_BUILD_INFO__.shortSha} | ${__APP_BUILD_INFO__.label}`;
      document.body.appendChild(badge);
    }

    const canvasContainer = document.getElementById('canvas-container')!;
    const uiContainer = document.getElementById('ui-container')!;

    // Configure quality profile and tile cache limits for target device (Stage X)
    const isQuest = typeof navigator !== 'undefined' && /Quest|OculusBrowser/i.test(navigator.userAgent);
    const initialProfile = QualityProfileManager.getDefaultProfile(isQuest);
    QualityProfileManager.setActiveProfile(initialProfile);
    TileImageCache.applyProfile(initialProfile);
    this.session.setQualityProfile(initialProfile.name);

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
      if (this.profileRecorder) {
        if (!this.profileRecorder.isRecording) this.startProfile();
        this.profileRecorder.mark(performance.now(), 'xr-session-start');
      }
      this.xrManager.resetInteractionState();
      this.controls.enabled = false;
      this.sceneManager.setXREnergyMode(true);
      if (this.spatialHUD) this.spatialHUD.group.visible = true;
      if (this.currentViewMode === 'first-person') this.pendingHUDDock = true;
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
      if (this.profileRecorder?.isRecording) {
        this.profileRecorder.mark(performance.now(), 'xr-session-end');
        this.stopProfile();
      }
      this.xrManager.resetInteractionState();
      this.controls.enabled = true;
      this.sceneManager.setPassthrough(false);
      this.sceneManager.setXREnergyMode(false);
      if (this.spatialHUD) this.spatialHUD.group.visible = false;
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
      onTurn: (radians) => this.flyoverController?.turn(radians),
      onToggleHUD: () => this.toggleHUD(),
      onScrubDistance: (meters) => {
        if (this.flyoverController) {
          this.flyoverController.pause();
          this.overlay.setPlaying(false);
          this.flyoverController.stepDistanceMeters(meters);
        }
      },
      onSelectWaypoint: (name, lat, lon) => this.jumpToWaypoint(name, lat, lon),
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
      onSelectWaypoint: (name, lat, lon) => this.jumpToWaypoint(name, lat, lon),
      onSetQualityMode: (mode) => {
        const isQuest = typeof navigator !== 'undefined' && /Quest|OculusBrowser/i.test(navigator.userAgent);
        const profileName = QualityProfileManager.resolveProfileName(mode, isQuest);
        this.session.setQualityProfile(profileName);
      },
    });
    this.overlay.setQualityProfile(initialProfile.name);
    if (this.profileRecorder) this.installProfileControls();

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
      if (state.qualityProfile !== prev.qualityProfile) {
        this.profileRecorder?.mark(performance.now(), 'quality-profile', state.qualityProfile);
        const profile = QualityProfileManager.getProfile(state.qualityProfile);
        if (profile) {
          QualityProfileManager.setActiveProfile(profile);
          TileImageCache.applyProfile(profile);
          this.activeTrek?.setQualityProfile(profile);
          this.overlay.setQualityProfile(state.qualityProfile);
        }
      }
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
        this.profileRecorder?.mark(performance.now(), 'view-mode', state.viewMode);
        this.applyViewMode(state.viewMode, prev.viewMode);
      }
      if (state.textureStyle !== prev.textureStyle) {
        this.profileRecorder?.mark(performance.now(), 'texture-style', state.textureStyle);
        this.overlay.setTextureStyle(state.textureStyle);
        this.activeTrek?.setTextureStyle(state.textureStyle);
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
        this.profileRecorder?.mark(performance.now(), 'vertical-exaggeration', String(state.verticalExaggeration));
        const effectiveExaggeration = this.currentViewMode === 'first-person' ? 1.0 : state.verticalExaggeration;
        this.activeTrek?.setVerticalExaggeration(effectiveExaggeration);
        this.xrManager.setVerticalExaggeration(effectiveExaggeration);
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

  private routeSelectionGeneration = 0;

  private async initRoutes(): Promise<void> {
    const generation = this.routeSelectionGeneration;
    this.overlay.showStatus('Connecting to imagery provider…');
    await TextureProvider.waitForInitialization();
    try {
      const resp = await fetch(resolveAssetUrl('/routes/manifest.json'));
      if (resp.ok) {
        this.manifest = await resp.json();
        this.overlay.setManifest(this.manifest);
        // Load default iconic trek: Mount Rainier via Emmons Glacier
        const initial = this.manifest.find((m) => m.id === 'rainier-emmons') || this.manifest[0];
        if (initial && generation === this.routeSelectionGeneration) {
          await this.loadRouteByFile(initial.file, initial.name, initial.id);
        }
      } else {
        throw new Error('Could not load routes manifest.');
      }
    } catch (e) {
      console.warn('Failed to load route manifest, attempting direct Rainier load:', e);
      if (generation !== this.routeSelectionGeneration) return;
      await this.loadRouteByFile(resolveAssetUrl('/routes/MountRainierViaEmmons.gpx'), 'Mount Rainier via Emmons', 'rainier-emmons');
    }
  }

  private applySessionStateToTrek(newTrek: LoadedTrek): void {
    const state = this.session.getState();
    const track = newTrek.track;

    // Natural 1x vertical exaggeration in first-person mode; tabletop exaggeration preference in diorama (Stage V9)
    const effectiveExaggeration = state.viewMode === 'first-person' ? 1.0 : state.verticalExaggeration;

    newTrek.setViewMode(state.viewMode);
    this.xrManager.setViewMode(state.viewMode);
    newTrek.setTextureStyle(state.textureStyle);
    newTrek.setTrailColorMode(state.trailColorMode);
    newTrek.setVerticalExaggeration(effectiveExaggeration);
    this.xrManager.setVerticalExaggeration(effectiveExaggeration);

    this.xrManager.setDioramaContext(
      track.bounds,
      newTrek.terrainResult.elevationSampler,
      newTrek.terrainResult.terrainBaseElevation,
      effectiveExaggeration
    );

    if (this.isDebugMode) {
      newTrek.setDebugPatchBounds(true);
    }

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
      onSelectWaypoint: (name, lat, lon) => this.jumpToWaypoint(name, lat, lon),
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
    if (this.currentViewMode === 'diorama' && !this.sceneManager.renderer.xr.isPresenting) this.frameDesktopDiorama();

    // 6. Update 2D Overlay
    this.overlay.clearStatus();
    this.overlay.updateTrack(track);
    this.overlay.setXREnabled(true);
    const distMi = (track.totalDistance * 0.000621371).toFixed(1);
    const gainFt = Math.round(track.elevationGain * 3.28084);
    this.overlay.showStatus(`Loaded: ${track.name} (${distMi} mi, +${gainFt.toLocaleString()} ft gain)`);
  }

  private async loadRouteByFile(url: string, fallbackName: string, routeId?: string): Promise<void> {
    const generation = ++this.routeSelectionGeneration;
    await TextureProvider.waitForInitialization();
    if (generation !== this.routeSelectionGeneration) return;
    await this.routeLoader.loadRouteFromUrl(url, fallbackName, routeId);
  }

  public async loadTrackFromXML(xml: string, fallbackName?: string): Promise<void> {
    const generation = ++this.routeSelectionGeneration;
    await TextureProvider.waitForInitialization();
    if (generation !== this.routeSelectionGeneration) return;
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


  private pendingHUDDock = false;

  private currentHUDDockSide: 'left' | 'right' | 'center' = 'left';

  private dockHUD(side: 'left' | 'right' | 'center'): void {
    this.currentHUDDockSide = side;
    if (!this.spatialHUD) return;
    this.spatialHUD.setDockSide(side);
    this.spatialHUD.group.visible = this.sceneManager.renderer.xr.isPresenting;

    const isPresenting = this.sceneManager.renderer.xr.isPresenting;
    const activeCamera = isPresenting
      ? this.sceneManager.renderer.xr.getCamera()
      : this.sceneManager.camera;
    const camPos = _scratchV3;
    activeCamera.getWorldPosition(camPos);

    if (this.currentViewMode === 'first-person') {
      const direction = new THREE.Vector3();
      activeCamera.getWorldDirection(direction);
      const yaw = Math.atan2(-direction.x, -direction.z);
      const offset = new THREE.Vector3(side === 'left' ? -0.85 : side === 'right' ? 0.85 : 0, -0.25, -1.2);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      this.spatialHUD.group.position.copy(camPos).add(offset);
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

  private toggleHUD(): void {
    if (!this.spatialHUD) return;
    if (this.spatialHUD.group.visible) this.spatialHUD.group.visible = false;
    else this.dockHUD(this.currentHUDDockSide);
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

  private applyViewMode(mode: ViewMode, prevMode?: ViewMode): void {
    const priorMode = prevMode ?? (mode === 'first-person' ? 'diorama' : 'first-person');
    // Save tabletop transform when transitioning away from diorama
    if (priorMode === 'diorama' && mode === 'first-person') {
      const root = this.sceneManager.dioramaRoot;
      this.savedTabletopTransform = {
        position: root.position.clone(),
        quaternion: root.quaternion.clone(),
        scale: root.scale.clone(),
      };
    }

    // Natural 1x vertical exaggeration in first-person mode; restore user preference in diorama
    const effectiveExaggeration = mode === 'first-person' ? 1.0 : this.session.getState().verticalExaggeration;
    this.activeTrek?.setVerticalExaggeration(effectiveExaggeration);
    this.activeTrek?.setViewMode(mode);
    this.xrManager.setVerticalExaggeration(effectiveExaggeration);

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
        if (this.controls.enabled) this.frameDesktopDiorama();
        this.dockHUD(this.currentHUDDockSide);
      } else {
        this.controls.enabled = false;
        // Update the desktop eye before placing a world-space panel.
        this.flyoverController?.update(0, this.sceneManager.camera, this.sceneManager.dioramaRoot, this.sceneManager.renderer.xr.isPresenting);
        this.dockHUD(this.currentHUDDockSide);
      }
    }
  }

  private exitMR(): void {
    const session = this.sceneManager.renderer.xr.getSession();
    if (session) {
      session.end();
    }
  }

  private readonly onProfileVisibilityChange = (): void => {
    if (!this.profileRecorder?.isRecording) return;
    const now = performance.now();
    if (document.visibilityState === 'hidden' && !this.profileSuspended) {
      this.profileRecorder.pause(now, this.getProfileCounters());
      this.profileSuspended = true;
    } else if (document.visibilityState !== 'hidden' && this.profileSuspended) {
      this.profileRecorder.mark(now, 'visibility-resume');
      this.profileSuspended = false;
    }
  };

  private installProfileControls(): void {
    const box = document.createElement('div');
    box.id = 'profile-controls';
    box.style.cssText = 'position:fixed;right:16px;top:100px;z-index:10000;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;background:rgba(15,23,42,.94);color:#f1f5f9;font:12px system-ui,sans-serif;box-shadow:0 4px 16px #0005;';
    const status = document.createElement('span');
    status.id = 'profile-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Local profile ready';
    box.appendChild(status);
    for (const [label, id, action] of [
      ['Start', 'profile-start', () => this.startProfile()],
      ['Stop', 'profile-stop', () => this.stopProfile()],
      ['Download JSON', 'profile-download', () => this.downloadProfile()],
    ] as const) {
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'padding:5px 8px;border:1px solid #64748b;border-radius:6px;background:#334155;color:white;cursor:pointer;';
      button.addEventListener('click', action);
      box.appendChild(button);
    }
    document.body.appendChild(box);
    this.profileControls = box;
    document.addEventListener('visibilitychange', this.onProfileVisibilityChange);
    this.updateProfileControls();
  }

  private updateProfileControls(): void {
    if (!this.profileControls) return;
    const recording = this.profileRecorder?.isRecording ?? false;
    const status = this.profileControls.querySelector<HTMLElement>('#profile-status');
    if (status) status.textContent = recording ? 'Recording locally' : this.completedProfile ? `Saved ${this.completedProfile.windows.length} windows` : 'Local profile ready';
    const start = this.profileControls.querySelector<HTMLButtonElement>('#profile-start');
    const stop = this.profileControls.querySelector<HTMLButtonElement>('#profile-stop');
    const download = this.profileControls.querySelector<HTMLButtonElement>('#profile-download');
    if (start) { start.disabled = recording; start.style.opacity = recording ? '0.45' : '1'; }
    if (stop) { stop.disabled = !recording; stop.style.opacity = recording ? '1' : '0.45'; }
    if (download) { download.disabled = !this.completedProfile; download.style.opacity = this.completedProfile ? '1' : '0.45'; }
  }

  private startProfile(): void {
    if (!this.profileRecorder || this.profileRecorder.isRecording) return;
    this.completedProfile = null;
    this.profileRecorder.start(performance.now(), __APP_BUILD_INFO__.id, navigator.userAgent);
    this.profileSuspended = false;
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      try {
        this.longTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) this.profileRecorder?.recordLongTask(entry.duration);
        });
        this.longTaskObserver.observe({ type: 'longtask' });
      } catch { this.longTaskObserver = null; }
    }
    this.updateProfileControls();
  }

  private stopProfile(): void {
    if (!this.profileRecorder?.isRecording) return;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    this.completedProfile = this.profileRecorder.stop(performance.now(), this.getProfileCounters());
    this.profileSuspended = false;
    this.updateProfileControls();
  }

  private downloadProfile(): void {
    if (!this.completedProfile) return;
    const blob = new Blob([JSON.stringify(this.completedProfile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trekviewer-profile-${__APP_BUILD_INFO__.shortSha}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  private getProfileCounters(): ProfileCounters {
    const info = this.sceneManager.getMemoryInfo();
    const lod = this.activeTrek?.imageryLOD.getDiagnostics();
    const cache = TileImageCache.getStats();
    const state = this.session.getState();
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      tileCacheEntries: cache.entries,
      tileCacheDecodedMB: Number((cache.decodedBytes / 1048576).toFixed(1)),
      imageryPatches: lod?.activePatchesCount ?? 0,
      imageryCoveragePercent: lod?.coveragePercent ?? 0,
      imageryInFlight: lod?.inFlightRequests ?? 0,
      localTerrainChunks: this.activeTrek?.localTerrainStreamer?.activeChunks.length ?? 0,
      qualityProfile: state.qualityProfile,
      viewMode: state.viewMode,
      textureStyle: state.textureStyle,
      routeName: this.currentTrack?.name ?? null,
    };
  }

  private endProfilePhase(recorder: PerformanceSessionRecorder | null, phase: ProfilePhase, since: number): number {
    if (!recorder) return since;
    const now = performance.now();
    recorder.recordPhase(phase, now - since);
    return now;
  }

  private frameDesktopDiorama(): void {
    const terrain = this.activeTrek?.terrainResult.terrainMesh;
    if (!terrain) return;
    const root = this.sceneManager.dioramaRoot;
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(terrain);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const camera = this.sceneManager.camera;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const availableHeight = Math.max(0.45, (window.innerHeight - 220) / window.innerHeight);
    // The bounding-sphere fit is deliberately conservative for elongated
    // alpine routes; use the spare desktop space for larger visible detail.
    const distance = Math.max(0.7, radius / Math.sin(halfFov * availableHeight) * 0.75);
    // Center in the inspection area beside the desktop controls, with an elevated
    // view that exposes the route and landform instead of the vertical skirt.
    if (window.innerWidth >= 900) center.x -= 170 / window.innerHeight * 2 * distance * Math.tan(halfFov);
    this.controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0, 0.85, 1).normalize().multiplyScalar(distance));
    camera.lookAt(center);
    this.controls.update();
  }

  private resetPosition(): void {
    this.flyoverController?.setProgress(0);
    this.session.setProgress(0);
    if (this.currentTrack) {
      const maxDim = Math.max(this.currentTrack.bounds.widthMeters, this.currentTrack.bounds.depthMeters);
      this.sceneManager.setViewMode(this.currentViewMode, maxDim);
      if (this.currentViewMode === 'diorama' && !this.sceneManager.renderer.xr.isPresenting) this.frameDesktopDiorama();
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

  public jumpToWaypoint(name: string, lat?: number, lon?: number): void {
    if (!this.currentTrack || this.currentTrack.points.length === 0) return;

    let targetLat = lat;
    let targetLon = lon;

    // If coordinates were not passed, resolve by name from waypoints or landmarks
    if (targetLat === undefined || targetLon === undefined) {
      const match =
        this.currentTrack.waypoints?.find((w) => w.name.toLowerCase() === name.toLowerCase()) ||
        this.currentTrack.landmarks?.find((l) => l.name.toLowerCase() === name.toLowerCase()) ||
        this.currentTrack.waypoints?.find((w) => w.name.toLowerCase().includes(name.toLowerCase())) ||
        this.currentTrack.landmarks?.find((l) => l.name.toLowerCase().includes(name.toLowerCase()));
      if (match) {
        targetLat = match.lat;
        targetLon = match.lon;
      }
    }

    if (targetLat === undefined || targetLon === undefined) {
      console.warn(`[TrekViewer] Could not resolve coordinates for waypoint "${name}"`);
      return;
    }

    let progress = 0;
    let curEle = this.currentTrack.minElevation;
    let curDist = 0;
    let curPoint: any = null;

    if (this.activeTrek?.trailResult.routeGeometry) {
      const proj = this.activeTrek.trailResult.routeGeometry.projectGeoPointToVisualRoute(targetLat, targetLon);
      progress = proj.progress;
      curDist = proj.routeDistanceMeters;
      const telemetry = this.activeTrek.trailResult.routeGeometry.getTelemetryAtDistance(curDist);
      curEle = telemetry?.currentPoint.ele ?? telemetry?.position.y ?? this.currentTrack.minElevation;
      curPoint = telemetry?.currentPoint ?? null;
    } else {
      progress = this.findClosestTrackProgress(
        this.currentTrack.points,
        targetLat,
        targetLon,
        this.currentTrack.totalDistance
      );
      curDist = progress * this.currentTrack.totalDistance;
      const ptIdx = Math.min(
        this.currentTrack.points.length - 1,
        Math.max(0, Math.round(progress * (this.currentTrack.points.length - 1)))
      );
      curPoint = this.currentTrack.points[ptIdx] ?? null;
      curEle = curPoint?.ele ?? this.currentTrack.minElevation;
    }

    // Sync flyover controller
    if (this.flyoverController) {
      this.flyoverController.pause();
      this.flyoverController.setProgress(progress);
    }

    this.session.setProgress(progress, curEle, curDist, curPoint);
    DioramaBase.selectWaypointByName(this.sceneManager.dioramaRoot, name);

    this.overlay.showStatus(`Jumped to: ${name}`);
    this.spatialHUD?.showStatus(`Jumped to: ${name}`);
  }

  public findClosestTrackProgress(
    points: { lat: number; lon: number; distanceFromStart: number }[],
    lat: number,
    lon: number,
    totalDistance: number
  ): number {
    if (this.activeTrek?.trailResult.routeGeometry) {
      return this.activeTrek.trailResult.routeGeometry.projectGeoPointToVisualRoute(lat, lon).progress;
    }
    if (!points || points.length === 0 || totalDistance <= 0) return 0;

    let bestIdx = 0;
    let bestDistSq = Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const dLat = (pt.lat - lat) * 111320;
      const dLon = (pt.lon - lon) * 111320 * cosLat;
      const distSq = dLat * dLat + dLon * dLon;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIdx = i;
      }
    }

    const closestPt = points[bestIdx];
    return Math.min(1, Math.max(0, closestPt.distanceFromStart / totalDistance));
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
    const activeProfiler = this.profileRecorder?.isRecording ? this.profileRecorder : null;
    const recorder = this.profileSuspended ? null : activeProfiler;
    let phaseStart = now;
    const delta = Math.min((now - this.lastTimestamp) / 1000, 0.1);
    this.lastTimestamp = now;

    const isPresenting = this.sceneManager.renderer.xr.isPresenting;
    const activeCamera = isPresenting
      ? this.sceneManager.renderer.xr.getCamera()
      : this.sceneManager.camera;

    // 1. Update WebXR inputs (Touch Plus controllers, gestures, diorama grab)
    try {
      this.xrManager.update(delta);
    } catch (e) {
      console.warn('[TrekViewerApp] Error in xrManager.update:', e);
    }

    // 2. Update OrbitControls on desktop when not in XR or first-person
    if (this.controls.enabled && this.currentViewMode === 'diorama') {
      this.controls.update();
    }
    phaseStart = this.endProfilePhase(recorder, 'input', phaseStart);

    // 3. Update Flyover / Animation playback
    if (this.flyoverController) {
      this.flyoverController.update(
        delta,
        activeCamera,
        this.sceneManager.dioramaRoot,
        isPresenting
      );
    }
    phaseStart = this.endProfilePhase(recorder, 'simulation', phaseStart);

    // Wait for the first valid XR camera pose before docking after session entry.
    if (this.pendingHUDDock) {
      this.pendingHUDDock = false;
      this.dockHUD(this.currentHUDDockSide);
    }
    // HUD placement is explicit (mode entry, dock, summon, drag), never head-locked.

    // Flush any throttled HUD updates when due
    this.spatialHUD?.update();
    phaseStart = this.endProfilePhase(recorder, 'hud', phaseStart);

    // 5. Update Adaptive Imagery LOD (Stage M & Stage T5, Stage W3)
    if (this.activeTrek && !this.activeTrek.isDisposed) {
      const currentProgress = this.flyoverController?.getProgress() ?? this.session.getState().progress;
      const activeRay = this.xrManager.getActivePointerRay();
      this.activeTrek.imageryLOD.setActiveInteractionRay(activeRay);
      this.activeTrek.imageryLOD.update(
        activeCamera,
        this.sceneManager.dioramaRoot,
        isPresenting,
        currentProgress,
        this.sceneManager.renderer,
        recorder ? this.recordImageryPhase : undefined
      );
      phaseStart = this.endProfilePhase(recorder, 'imagery', phaseStart);
      // Stream local high-resolution terrain geometry along route (Stage W6) or tabletop focus (Stage X7)
      const inspectedGeo = this.activeTrek.imageryLOD.getInspectedGeo();
      this.activeTrek.updateHikerProgress(currentProgress, inspectedGeo);
      phaseStart = this.endProfilePhase(recorder, 'terrain', phaseStart);
      // Update waypoint marker scale compensation & billboard labels (Sections 21, 24, 25)
      this.activeTrek.updateWaypoints(activeCamera, this.sceneManager.dioramaRoot.scale.x, delta);
      phaseStart = this.endProfilePhase(recorder, 'waypoints', phaseStart);
    }

    // 6. Render Scene
    this.sceneManager.render();
    phaseStart = this.endProfilePhase(recorder, 'render', phaseStart);

    if (activeProfiler) {
      const session = this.sceneManager.renderer.xr.getSession();
      const visible = document.visibilityState !== 'hidden' && (!isPresenting || session?.visibilityState === 'visible');
      if (visible) {
        if (this.profileSuspended) {
          activeProfiler.mark(phaseStart, 'visibility-resume');
          this.profileSuspended = false;
        }
        if (recorder) {
          const hz = isPresenting ? (session as XRSession & { frameRate?: number } | null)?.frameRate ?? null : null;
          recorder.recordFrame(timestamp, phaseStart - now,
            `${isPresenting}/${this.currentViewMode}/${this.session.getState().qualityProfile}/${this.currentTextureStyle}`, hz);
          if (recorder.due) recorder.captureWindow(phaseStart, this.getProfileCounters());
        }
      } else if (!this.profileSuspended) {
        activeProfiler.pause(phaseStart, this.getProfileCounters());
        this.profileSuspended = true;
      }
    }

    // 6. Diagnostic Telemetry (?debug=1)
    if (this.isDebugMode) {
      const xrSession = this.sceneManager.renderer.xr.getSession();
      const refreshRate = (xrSession as XRSession & {frameRate?: number} | null)?.frameRate ?? null;
      const visible = document.visibilityState !== 'hidden' && (!isPresenting || xrSession?.visibilityState === 'visible');
      if (visible) {
        this.frameTiming.record(timestamp, performance.now() - now,
          `${isPresenting}/${this.currentViewMode}/${this.session.getState().qualityProfile}`, isPresenting ? refreshRate : null);
      } else this.frameTiming.reset();
      const diorama = this.sceneManager.dioramaRoot;
      if (!this.lastDioramaPos.equals(diorama.position) ||
          !this.lastDioramaRot.equals(diorama.rotation) ||
          !this.lastDioramaScale.equals(diorama.scale)) {
        this.dioramaMutationCount++;
        this.lastDioramaPos.copy(diorama.position);
        this.lastDioramaRot.copy(diorama.rotation);
        this.lastDioramaScale.copy(diorama.scale);

      }

      if (now - this.lastTelemetryLogTime > 1000) {
        this.lastTelemetryLogTime = now;
        const isPresenting = this.sceneManager.renderer.xr.isPresenting;
        const xrCam = isPresenting ? this.sceneManager.renderer.xr.getCamera() : null;
        const memInfo = this.sceneManager.getMemoryInfo();
        const tileStats = TileImageCache.getStats();
        const lodStats = this.activeTrek?.imageryLOD?.getDiagnostics();
        const hudUploadRate = this.spatialHUD ? this.spatialHUD.getUploadRate() : 0;
        const terrainQuality = this.activeTrek?.terrainResult?.terrainQuality || 'unknown';

        const lodVisibleStr =
          lodStats && lodStats.visibleByZoom.size > 0
            ? Array.from(lodStats.visibleByZoom.entries())
                .sort(([a], [b]) => b - a)
                .map(([z, c]) => `Z${z}: ${c}`)
                .join(', ')
            : 'Base only';

        const frameTiming = this.frameTiming.snapshot();
        const telemetryData = {
          frameTiming,
          buildId: __APP_BUILD_INFO__.id,
          builtAt: __APP_BUILD_INFO__.builtAt,
          dirty: __APP_BUILD_INFO__.dirty,
          sha: __APP_BUILD_INFO__.shortSha,
          label: __APP_BUILD_INFO__.label,
          isPresenting,
          viewMode: this.currentViewMode,
          dioramaMutations: this.dioramaMutationCount,
          dioramaPos: diorama.position.toArray().map((v) => Number(v.toFixed(2))),
          dioramaRotY: Number(diorama.rotation.y.toFixed(2)),
          dioramaScale: Number(diorama.scale.x.toFixed(4)),
          baseCamPos: this.sceneManager.camera.position.toArray().map((v) => Number(v.toFixed(2))),
          xrCamPos: xrCam ? xrCam.position.toArray().map((v) => Number(v.toFixed(2))) : null,
          drawCalls: memInfo.render.calls,
          gpuTextures: memInfo.memory.textures,
          tileCacheCount: tileStats.entries,
          tileCacheInFlight: tileStats.inFlight,
          tileCacheFailures: tileStats.failureCount,
          lodZoom: lodStats ? lodStats.targetZoom : 0,
          lodCalcZoom: lodStats ? lodStats.calculatedDesiredZoom : 0,
          lodProviderMax: lodStats ? lodStats.providerMaxZoom : 0,
          lodPatches: lodStats ? lodStats.activePatchesCount : 0,
          lodVisible: lodStats ? lodStats.visibleCount : 0,
          lodQueue: lodStats ? lodStats.requestQueueLength : 0,
          lodInFlight: lodStats ? lodStats.inFlightRequests : 0,
          lodReadyHighRes: lodStats ? `${lodStats.readyHighResCount}/${lodStats.totalDesiredHighResCount}` : '0/0',
          lodVisibleByZoom: lodStats ? Object.fromEntries(lodStats.visibleByZoom) : {},
          lodCoveragePercent: lodStats ? lodStats.coveragePercent : 0,
          lodZ19AheadM: lodStats ? lodStats.z19AheadDistanceMeters : 0,
          lodResidentWarm: lodStats ? lodStats.residentWarmCount : 0,
          lodEvictionsTotal: lodStats ? lodStats.evictionsTotal : 0,
          tileCacheMB: Number((tileStats.decodedBytes / (1024 * 1024)).toFixed(1)),
          cacheHitRate: tileStats.hitRate,
          hudUploadRate,
          terrainQuality,
          localTerrainMode: this.activeTrek?.localTerrainStreamer?.getViewMode() ?? 'disabled',
          localTerrainActive: !!this.activeTrek?.localTerrainStreamer?.activeVisibleChunk,
          localTerrainChunks: this.activeTrek?.localTerrainStreamer?.activeChunks.length ?? 0,
          imageryRequestedProvider: TextureProvider.getProviderInitState().requestedProvider,
          imageryActiveProvider: TextureProvider.getProviderInitState().activeProvider,
          imageryInitialized: TextureProvider.getProviderInitState().initialized,
          imageryFallbackReason: TextureProvider.getProviderInitState().fallbackReason ?? null,
          lodProvider: TextureProvider.getActiveSatelliteProvider().id,
        };

        console.log(`[TELEMETRY]`, telemetryData);

        // Compact real-time on-screen diagnostics overlay (Requirement #122 & Section 38 & Section 47 & Section 53, Stage W7)
        const badge = document.getElementById('buildBadge');
        if (badge) {
          const pState = TextureProvider.getProviderInitState();
          const fallbackStr = pState.fallbackReason ? ` (fallback: ${pState.fallbackReason})` : '';
          badge.innerHTML = `
            <div style="font-weight:bold;color:#38bdf8;">${__APP_BUILD_INFO__.shortSha}${__APP_BUILD_INFO__.dirty ? " (modified)" : ""} • ${isPresenting ? 'XR ON' : 'XR OFF'} • ${this.currentViewMode} • ${terrainQuality}</div>
            <div>Pos: [${telemetryData.dioramaPos.join(', ')}] Rot: ${telemetryData.dioramaRotY} S: ${telemetryData.dioramaScale}</div>
            <div>Callbacks: ${frameTiming.averageFps?.toFixed(1) ?? '—'}/s | p95: ${frameTiming.intervalP95Ms?.toFixed(1) ?? '—'} ms | CPU p95: ${frameTiming.cpuP95Ms?.toFixed(1) ?? '—'} ms</div>
            <div>Target: ${frameTiming.targetHz ?? 'unknown'} Hz | Est. missed callbacks: ${frameTiming.estimatedMissedCallbacks ?? '—'} (not GPU timing)</div>
            <div>Draw: ${telemetryData.drawCalls} | Tex: ${telemetryData.gpuTextures} | Cache: ${telemetryData.tileCacheCount} (${telemetryData.tileCacheMB} MB, hit: ${tileStats.hitRate}%, fails: ${tileStats.failureCount})</div>
            <div>LOD: ${lodVisibleStr} | Cov: ${lodStats?.coveragePercent ?? 0}% | Ahead: ${lodStats?.z19AheadDistanceMeters ?? 0}m | Ready: ${telemetryData.lodReadyHighRes} | Warm: ${lodStats?.residentWarmCount ?? 0} | Evict: ${lodStats?.evictionsTotal ?? 0}</div>
            <div>Local DEM: ${telemetryData.localTerrainMode} (${telemetryData.localTerrainActive ? 'active' : 'hidden'}, ${telemetryData.localTerrainChunks} warm)</div>
            <div>Imagery: ${pState.activeProvider} (req: ${pState.requestedProvider}, init: ${pState.initialized}${fallbackStr})</div>
          `.trim();
        }
      }
    }
  }

  public dispose(): void {
    this.stopProfile();
    this.profileControls?.remove();
    document.removeEventListener('visibilitychange', this.onProfileVisibilityChange);
    this.disposeCurrentTrek();
    this.xrManager.dispose();
    this.controls.dispose();
    this.overlay.dispose();
    this.sceneManager.dispose();
  }
}

// Initialize on DOM load with explicit provider environment resolution (Section 48)
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', async () => {
    new TrekViewerApp();
  });
}
