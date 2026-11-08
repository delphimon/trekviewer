import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode } from './gpx/TrackTypes';
import { FrameTimingMonitor } from './core/FrameTimingMonitor';
import type { PerformanceSessionRecorder, ProfileCounters, ProfilePhase } from './core/PerformanceSessionRecorder';
import { ProfileSession } from './core/ProfileSession.ts';
import { DebugTelemetry, type DebugTelemetrySnapshot } from './core/DebugTelemetry.ts';
import { endXRSessionAfterFrame } from './core/XRSessionExit.ts';
import { SceneManager } from './core/SceneManager';
import { XRManager } from './core/XRManager';
import { TerrainResult } from './terrain/TerrainGenerator';
import { TrailResult } from './visualization/TrailMesh';
import { FlyoverController } from './visualization/FlyoverController';
import { DioramaCameraFollow } from './visualization/DioramaCameraFollow.ts';
import { DioramaModelFollow } from './visualization/DioramaModelFollow.ts';
import { DioramaBase } from './visualization/DioramaBase';
import { SpatialHUD } from './ui/SpatialHUD';
import { DesktopOverlay } from './ui/DesktopOverlay';
import { LoadedTrek } from './core/LoadedTrek';
import { RouteLoader } from './core/RouteLoader';
import { TrekSession } from './core/TrekSession';
import { TextureProvider } from './terrain/TextureProvider';
import { TileImageCache } from './terrain/TileImageCache';
import { ElevationTileService } from './terrain/ElevationTiles';
import { QualityProfileManager } from './terrain/QualityProfile';
import { resolveAssetUrl } from './utils/AssetUrl';
import { readComfortPreferences, saveComfortPreferences } from './xr/ComfortPreferences.ts';
import { disposeTerrainJobs } from './terrain/TerrainJobs.ts';
import { configureDesktopInspection, fitInspectionBounds, levelHorizon, readHorizonLock, saveHorizonLock } from './core/InspectionView.ts';
import { GraphicsRecovery } from './core/GraphicsRecovery.ts';
import { releaseGraphicsResources } from './core/GraphicsResources.ts';
import { PersistentResourceCache } from './terrain/PersistentResourceCache.ts';
import { OfflineDownloads } from './offline/OfflineDownloads.ts';
import { resolveRouteLandmarks, type RouteLandmark } from './gpx/RouteLandmarks.ts';
import { localMetersToGeo } from './gpx/Coordinates.ts';
import { TablePlacement } from './xr/TablePlacement.ts';

/** Plain-language route-load errors (parser messages are kept in the console). */
export function friendlyRouteError(error: Error): string {
  const text = error?.message ?? '';
  if (/XML parse error|Unclosed|Unexpected|not well-formed|Invalid character/i.test(text)) return 'the file is not valid GPX (it may be damaged or incomplete).';
  if (/Valid GPS points|at least|no track points|No trackpoints/i.test(text)) return 'it needs at least two track points with valid coordinates.';
  if (/too large|exceeds/i.test(text)) return 'the file is too large (25 MB maximum).';
  if (/fetch|network|Failed to load|HTTP/i.test(text)) return 'it could not be downloaded. Check your connection and try again.';
  return text ? `${text.replace(/\.$/, '')}.` : 'an unknown error occurred.';
}

const _scratchV3 = new THREE.Vector3();
const _scratchHUDDir = new THREE.Vector3();
const _scratchHUDOffset = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _scratchFollowAhead = new THREE.Vector3();

export class TrekViewerApp {
  /** Device-local resource cache controls and diagnostics; contains no keys. */
  public readonly resourceCache = PersistentResourceCache;
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
  private routeLandmarks: readonly RouteLandmark[] = [];

  private lastTimestamp: number = performance.now();
  private isDebugMode: boolean = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
  private isProfilingMode: boolean = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('profile') === '1';
  private readonly profile: ProfileSession | null = this.isProfilingMode
    ? new ProfileSession(() => this.getProfileCounters(), () => {
      const state = this.session.getState();
      return JSON.stringify({ mode: state.playbackMode, speed: state.playbackSpeed, playing: state.isPlaying, follow: state.followRoute });
    }) : null;
  private readonly recordImageryPhase = (phase: ProfilePhase, elapsedMs: number): void => {
    this.profile?.activeRecorder?.recordPhase(phase, elapsedMs);
  };
  private savedTabletopTransform: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  } | null = null;
  private readonly frameTiming = new FrameTimingMonitor();
  private readonly debugTelemetry: DebugTelemetry | null = this.isDebugMode ? new DebugTelemetry(this.frameTiming) : null;
  private comfort = readComfortPreferences();
  private horizonLocked = readHorizonLock();
  private lastLocomotionTime = 0;
  private isDisposed = false;
  private graphicsRecovery: GraphicsRecovery | null = null;
  private readonly preparingTreks = new Set<LoadedTrek>();
  private readonly animateFrame = (timestamp: number, frame?: XRFrame) => this.animate(timestamp, frame);
  private xrEntryPending = false;
  private xrExitPending = false;
  private xrAvailabilityGeneration = 0;
  private readonly onXRDeviceChange = () => { void this.updateXRAvailability(); };
  private xrReferenceSpace: XRReferenceSpace | null = null;
  private readonly onReferenceReset = () => {
    this.session.setFollowRoute(false);
    this.flyoverController?.pause();
    this.session.setPlayback(false);
    this.xrManager.resetInteractionState();
    this.pendingHUDDock = true;
  };
  private readonly onResize = () => {
    if (this.isDisposed) return;
    const playerHeight = document.querySelector('.player-bar')?.getBoundingClientRect().height;
    if (playerHeight) document.documentElement.style.setProperty('--trek-player-height', `${playerHeight}px`);
    const headerBottom = document.querySelector('.top-bar')?.getBoundingClientRect().bottom;
    if (headerBottom) document.documentElement.style.setProperty('--trek-header-height', `${headerBottom}px`);
    if (this.desktopViewFitted && !this.sceneManager.renderer.xr.isPresenting && this.currentViewMode === 'diorama') this.frameDesktopDiorama();
  };
  private layoutObserver: ResizeObserver | null = null;
  private desktopViewFitted = false;
  private readonly dioramaFollow = new DioramaCameraFollow();
  private readonly dioramaModelFollow = new DioramaModelFollow();
  private readonly followFocus = new THREE.Vector3();
  private readonly tablePlacement = new TablePlacement();
  private readonly onOrbitStart = () => {
    this.desktopViewFitted = false;
    this.session.setFollowRoute(false);
  };

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
    const demParams = new URLSearchParams(window.location.search);
    ElevationTileService.setBestAvailableEnabled(demParams.get('bestDem') !== '0');
    ElevationTileService.setRegionalDEMEnabled(demParams.get('regionalDem') !== '0');
    this.session.setQualityProfile(initialProfile.name);

    this.lastTimestamp = performance.now();

    // 1. Scene Manager
    this.sceneManager = new SceneManager(canvasContainer, initialProfile.name);

    // 2. Desktop OrbitControls
    this.controls = new OrbitControls(this.sceneManager.camera, this.sceneManager.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    configureDesktopInspection(this.controls);
    this.controls.addEventListener('start', this.onOrbitStart);
    this.controls.target.set(0, 0, 0);

    this.sceneManager.renderer.xr.addEventListener('sessionstart', async () => {
      this.session.setFollowRoute(false);
      if (this.profile) {
        if (!this.profile.isRecording) this.profile.start();
        this.profile.mark('xr-session-start');
      }
      this.xrManager.resetInteractionState();
      this.controls.enabled = false;
      this.sceneManager.setXREnergyMode(true);
      this.sceneManager.updateCameraClipping(1);
      if (this.spatialHUD) this.spatialHUD.group.visible = true;
      this.pendingHUDDock = true;
      // A desktop tabletop transform is not meaningful in room space.
      this.savedTabletopTransform = null;
      if (this.currentViewMode === 'diorama') {
        // Natural tabletop height in room space (82cm above floor, 80cm in front of user)
        this.sceneManager.dioramaRoot.position.set(0, 0.82, -0.80);
        this.sceneManager.dioramaRoot.rotation.set(0, 0, 0);
      }
      // Look for a real table (Space Setup planes) for a few seconds and anchor the model to it.
      this.tablePlacement.start(performance.now());
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
      this.session.setFollowRoute(false);
      this.xrReferenceSpace?.removeEventListener('reset', this.onReferenceReset);
      this.xrReferenceSpace = null;
      if (this.isDisposed) return;
      if (this.profile?.isRecording) {
        this.profile.mark('xr-session-end');
        this.profile.stop();
      }
      this.xrManager.resetInteractionState();
      this.viewTransition = null; this.viewHoldProgress = null; this.sceneManager.setFade(0);
      this.tablePlacement.dispose();
      this.controls.enabled = true;
      this.sceneManager.setPassthrough(false);
      this.sceneManager.setXREnergyMode(false);
      this.sceneManager.updateCameraClipping(1);
      if (this.spatialHUD) this.spatialHUD.group.visible = false;
      // Room-space transforms (tabletop placement, 1:1 viewer offset/yaw) do not apply on desktop.
      this.savedTabletopTransform = null;
      if (this.currentTrack) {
        const maxDim = Math.max(this.currentTrack.bounds.widthMeters, this.currentTrack.bounds.depthMeters);
        this.sceneManager.setViewMode(this.currentViewMode, maxDim);
      }
      if (this.currentViewMode === 'diorama') {
        this.sceneManager.dioramaRoot.position.set(0, -0.2, -1.1);
        this.sceneManager.dioramaRoot.rotation.set(0, 0, 0);
        this.frameDesktopDiorama();
      } else {
        this.flyoverController?.update(0, this.sceneManager.camera, this.sceneManager.dioramaRoot, false);
      }
    });

    // 3. WebXR Manager
    this.xrManager = new XRManager(this.sceneManager);
    this.xrManager.setComfortPreferences(this.comfort);
    this.xrManager.setHorizonLocked(this.horizonLocked);
    this.xrManager.setCallbacks({
      onToggleViewMode: () => this.toggleViewMode(),
      onViewModeHoldProgress: (progress) => { this.viewHoldProgress = progress; },
      onTogglePlay: () => this.togglePlay(),
      onReset: () => this.resetPosition(),
      onExitMR: () => this.exitMR(),
      onFocusHiker: () => this.focusOnHiker(),
      onDioramaManipulation: () => { this.session.setFollowRoute(false); this.tablePlacement.stopSearching(); },
      onTurn: (radians) => this.flyoverController?.turn(radians, this.sceneManager.renderer.xr.getCamera()),
      onLocomotion: () => { this.lastLocomotionTime = performance.now(); },
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
      canPrepareOffline: () => !this.xrEntryPending && !this.sceneManager.renderer.xr.isPresenting && !this.graphicsRecovery?.isSuspended,
      onRetryGraphics: () => { void this.graphicsRecovery?.recover(); },
      onSetHorizonLocked: (locked) => this.setHorizonLocked(locked),
      onResetHorizon: () => this.resetHorizon(),
      onFitTerrain: () => this.frameDesktopDiorama(),
      onSetComfort: (preferences) => {
        this.comfort = { ...this.comfort, ...preferences };
        saveComfortPreferences(this.comfort);
        this.xrManager.setComfortPreferences(this.comfort);
        this.dockHUD(this.currentHUDDockSide);
      },
      onSelectRoute: (route) => this.loadRouteByFile(route.file, route.name, route.id),
      onUploadGPX: (content, fileName) => this.loadTrackFromXML(content, fileName),
      onEnterXR: (mode) => this.enterXR(mode),
      onToggleViewMode: (mode) => this.setViewMode(mode),
      onTogglePlay: () => this.togglePlay(),
      onSetSpeed: (speed) => this.session.setSpeed(speed),
      onSetPlaybackMode: (mode) => this.session.setPlaybackMode(mode),
      onToggleFollowRoute: () => {
        this.toggleFollowRoute();
      },
      onScrub: (progress) => {
        this.flyoverController?.setProgress(progress);
        this.session.setProgress(progress);
      },
      onSetTextureStyle: (style) => this.setTextureStyle(style),
      onSetSatelliteProvider: (provider, token) => {
        void this.setSatelliteProvider(provider, token);
      },
      onSetTrailColorMode: (mode) => this.setTrailColorMode(mode),
      onSetVerticalExaggeration: (val) => this.session.setVerticalExaggeration(val),
      onSelectWaypoint: (name, lat, lon, progress) => this.jumpToWaypoint(name, lat, lon, progress),
      onSetQualityMode: (mode) => {
        const isQuest = typeof navigator !== 'undefined' && /Quest|OculusBrowser/i.test(navigator.userAgent);
        const profileName = QualityProfileManager.resolveProfileName(mode, isQuest);
        this.session.setQualityProfile(profileName);
      },
    });
    this.overlay.setQualityProfile(initialProfile.name);
    this.overlay.setHorizonLocked(this.horizonLocked);
    // Startup provider resolution happens once, awaited, in TextureProvider.initializeFromEnvironment()
    // (saved choice → build default). The dropdown shows the choice now and the
    // active provider's credits once initialization settles.
    this.overlay.setSatelliteProvider(TextureProvider.resolveInitialProviderSetting());
    void TextureProvider.waitForInitialization().then(() => {
      if (this.isDisposed) return;
      this.overlay.setSatelliteProvider(TextureProvider.getSatelliteProviderSetting(),
        TextureProvider.getAttributionForStyle(this.session.getState().textureStyle));
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.layoutObserver = new ResizeObserver(this.onResize);
      for (const selector of ['.top-bar', '.player-bar']) {
        const panel = document.querySelector(selector);
        if (panel) this.layoutObserver.observe(panel, { box: 'border-box' });
      }
    }
    void this.updateXRAvailability();
    navigator.xr?.addEventListener('devicechange', this.onXRDeviceChange);
    if (this.isDebugMode || this.isProfilingMode) (window as any).__trekViewerApp = this;
    this.profile?.installControls();

    // 5. Transactional Route Loader (Stage F & G)
    this.routeLoader = new RouteLoader({
      dioramaRoot: this.sceneManager.dioramaRoot,
      getIsXR: () => this.sceneManager.renderer.xr.isPresenting,
      prepareRender: async (trek, signal) => {
        this.preparingTreks.add(trek);
        try {
          let revision: number | undefined;
          do {
            await this.graphicsRecovery?.waitUntilReady(signal);
            if (signal.aborted) throw new DOMException('Route preparation cancelled', 'AbortError');
            revision = this.graphicsRecovery?.revision;
            trek.imageryLOD.syncRenderer?.(this.sceneManager.renderer);
            const camera = this.sceneManager.renderer.xr.isPresenting ? this.sceneManager.renderer.xr.getCamera() : this.sceneManager.camera;
            await this.sceneManager.renderer.compileAsync(trek.group, camera, this.sceneManager.scene);
            await this.graphicsRecovery?.waitUntilReady(signal);
          } while (revision !== this.graphicsRecovery?.revision);
        } finally { this.preparingTreks.delete(trek); }
      },
      // Tiled local terrain and terrain-shader imagery are the only shipped paths; the legacy
      // single-chunk streamer remains solely as the fallback when no base mesh grid exists.
      tiledTerrain: true,
      experimentalImageryBatching: false,
      experimentalTerrainImagery: demParams.get('terrainImagery') !== '0',
      markerBatching: demParams.get('markerBatch') !== '0',
      baseTerrainCellSizeM: [60, 75, 120].includes(Number(demParams.get('terrainGrid'))) ? Number(demParams.get('terrainGrid')) : undefined,
      getBaseTerrainCellSizeM: () => QualityProfileManager.getActiveProfile().name === 'quest-balanced' ? undefined : 60,
      regionalBase: new URLSearchParams(window.location.search).get('regionalBase') !== '0',
      getCurrentTrailColorMode: () => this.currentTrailColorMode,
      session: this.session,
      onProgress: (msg, progress) => {
        this.overlay.showStatus(msg);
        this.spatialHUD?.showStatus(msg, progress ?? undefined);
      },
      onError: (err, routeName) => {
        console.error('[TrekViewerApp] Route load error:', err);
        const message = friendlyRouteError(err);
        this.overlay.showStatus(`Couldn't open ${routeName || 'this route'}: ${message} The previous route is still shown.`, true);
        this.spatialHUD?.showStatus(`Couldn't open route: ${message}`);
      },
      onTrekCommitted: (newTrek, prevTrek) => {
        this.onTrekCommitted(newTrek, prevTrek);
      },
    });

    // 6. Reactive State Subscriptions (Stage G)
    this.session.subscribe((state, prev) => {
      if (state.playbackMode !== prev.playbackMode || state.playbackSpeed !== prev.playbackSpeed ||
          state.isPlaying !== prev.isPlaying || state.followRoute !== prev.followRoute) this.profile?.markPlaybackContext();
      if (state.followRoute !== prev.followRoute) {
        this.overlay.setFollowRoute(state.followRoute);
        this.spatialHUD?.setFollowRoute(state.followRoute);
        if (state.followRoute) {
          this.desktopViewFitted = false;
          if (this.sceneManager.renderer.xr.isPresenting) {
            this.dioramaModelFollow.start(this.sceneManager.renderer.xr.getCamera());
          } else {
            const damping = this.controls.enableDamping;
            this.controls.enableDamping = false;
            this.controls.update();
            this.controls.enableDamping = damping;
            this.dioramaFollow.start(this.sceneManager.camera, this.controls.target);
          }
        }
      }
      if (state.playbackMode !== prev.playbackMode) {
        this.flyoverController?.setPlaybackMode(state.playbackMode);
        this.overlay.setPlaybackMode(state.playbackMode);
        this.overlay.setPlaybackSpeed(state.playbackSpeed);
        this.syncHUDState();
      }
      if (state.qualityProfile !== prev.qualityProfile) {
        this.profile?.mark('quality-profile', state.qualityProfile);
        const profile = QualityProfileManager.getProfile(state.qualityProfile);
        if (profile) {
          QualityProfileManager.setActiveProfile(profile);
          this.sceneManager.setQualityProfile(profile.name);
          TileImageCache.applyProfile(profile);
          this.activeTrek?.setQualityProfile(profile);
          this.overlay.setQualityProfile(state.qualityProfile);
        }
      }
      if (state.isPlaying !== prev.isPlaying) {
        this.overlay.setPlaying(state.isPlaying);
        this.syncHUDState();
      }
      if (state.playbackSpeed !== prev.playbackSpeed) {
        this.flyoverController?.setSpeed(state.playbackSpeed);
        this.overlay.setPlaybackSpeed(state.playbackSpeed);
        this.syncHUDState();
      }
      if (state.progress !== prev.progress) {
        this.overlay.updateScrubber(state.progress, state.currentElevation);
        this.syncHUDState();
      }
      if (state.viewMode !== prev.viewMode) {
        this.profile?.mark('view-mode', state.viewMode);
        this.applyViewMode(state.viewMode, prev.viewMode);
      }
      if (state.textureStyle !== prev.textureStyle) {
        this.profile?.mark('texture-style', state.textureStyle);
        this.overlay.setTextureStyle(state.textureStyle);
        this.activeTrek?.setTextureStyle(state.textureStyle);
        const attr = TextureProvider.getAttributionForStyle(state.textureStyle, this.activeTrek?.terrainResult.terrainGeoBounds);
        this.session.setAttribution(attr);
        this.syncHUDState();
      }
      if (state.trailColorMode !== prev.trailColorMode) {
        this.overlay.setTrailColorMode(state.trailColorMode);
        this.trailResult?.setColorMode(state.trailColorMode);
        this.syncHUDState();
      }
      if (state.verticalExaggeration !== prev.verticalExaggeration) {
        this.profile?.mark('vertical-exaggeration', String(state.verticalExaggeration));
        const effectiveExaggeration = this.currentViewMode === 'first-person' ? 1.0 : state.verticalExaggeration;
        this.activeTrek?.setVerticalExaggeration(effectiveExaggeration);
        this.xrManager.setVerticalExaggeration(effectiveExaggeration);
        this.overlay.setVerticalExaggeration(state.verticalExaggeration);
        this.spatialHUD?.setVerticalExaggeration(state.verticalExaggeration);
      }
      if (state.attribution !== prev.attribution || state.terrainQuality !== prev.terrainQuality) {
        this.overlay.setMetaInfo(state.attribution, state.terrainQuality, this.activeTrek?.track.elevationProvenanceStats, this.activeTrek?.terrainResult.demGrid?.source);
        this.spatialHUD?.setMetaInfo(state.attribution, state.terrainQuality, this.activeTrek?.track.elevationProvenanceStats, this.activeTrek?.terrainResult.demGrid?.source);
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

    this.graphicsRecovery = new GraphicsRecovery({
      canvas: this.sceneManager.renderer.domElement,
      isContextLost: () => this.sceneManager.renderer.getContext().isContextLost(),
      pause: async () => {
        this.sceneManager.renderer.setAnimationLoop(null);
        const treks = new Set(this.preparingTreks);
        if (this.activeTrek) treks.add(this.activeTrek);
        const batchReleases = [...treks].map(trek => trek.imageryLOD.releaseBatches?.());
        releaseGraphicsResources([this.sceneManager.scene, ...[...treks].map(trek => trek.group)], this.sceneManager.sunLight.shadow.map,
          [...treks].flatMap(trek => trek.getGraphicsResources()));
        this.flyoverController?.pause();
        this.session.setPlayback(false);
        this.xrManager.resetInteractionState();
        this.profile?.mark('graphics-lost');
        await Promise.all(batchReleases);
        if (this.sceneManager.renderer.xr.isPresenting) await this.sceneManager.renderer.xr.getSession()?.end().catch(() => {});
      },
      prepare: async () => {
        const renderer = this.sceneManager.renderer;
        const camera = renderer.xr.isPresenting ? renderer.xr.getCamera() : this.sceneManager.camera;
        await renderer.compileAsync(this.sceneManager.skyMesh, camera, this.sceneManager.scene);
        const trek = this.activeTrek;
        if (trek && !trek.isDisposed) {
          trek.imageryLOD.syncRenderer?.(renderer);
          await renderer.compileAsync(trek.group, camera, this.sceneManager.scene);
          if (!renderer.xr.isPresenting && !renderer.getContext().isContextLost()) this.sceneManager.render();
        }
      },
      resume: () => {
        this.lastTimestamp = performance.now();
        this.frameTiming.reset();
        this.profile?.mark('graphics-ready', undefined, this.lastTimestamp);
        this.sceneManager.renderer.setAnimationLoop(this.animateFrame);
      },
      status: (message, retry) => {
        this.sceneManager.renderer.domElement.style.visibility = message ? 'hidden' : 'visible';
        this.overlay.setGraphicsStatus(message, retry);
      },
    });

    // 7. Load Manifest and Initial Track
    this.initRoutes();
    this.overlay.setComfortPreferences(this.comfort);
    window.addEventListener('resize', this.onResize);

    // 8. Start WebXR Animation Loop
    void this.graphicsRecovery.recover();
  }

  private routeSelectionGeneration = 0;

  private async initRoutes(): Promise<void> {
    const generation = this.routeSelectionGeneration;
    this.overlay.showStatus('Connecting to imagery provider…');
    await TextureProvider.waitForInitialization();
    if (this.isDisposed) return;
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

    newTrek.flyoverController.setPlaybackMode(state.playbackMode);
    newTrek.flyoverController.setSpeed(state.playbackSpeed);
    newTrek.flyoverController.setProgress(0);
    newTrek.flyoverController.pause();

    this.session.setProgress(0, track.points[0]?.ele || track.minElevation);
    this.session.setPlayback(false);
    this.session.setTerrainQuality(newTrek.terrainResult.terrainQuality);
    const attr = TextureProvider.getAttributionForStyle(state.textureStyle, newTrek.terrainResult.terrainGeoBounds);
    this.session.setAttribution(attr);

    this.overlay.setTextureStyle(state.textureStyle);
    this.overlay.setTrailColorMode(state.trailColorMode);
    this.overlay.setPlaybackSpeed(state.playbackSpeed);
    this.overlay.setVerticalExaggeration(state.verticalExaggeration);
    this.overlay.setMetaInfo(attr, newTrek.terrainResult.terrainQuality, newTrek.track.elevationProvenanceStats, newTrek.terrainResult.demGrid?.source);
    this.spatialHUD?.setVerticalExaggeration(state.verticalExaggeration);
    this.spatialHUD?.setMetaInfo(attr, newTrek.terrainResult.terrainQuality, newTrek.track.elevationProvenanceStats, newTrek.terrainResult.demGrid?.source);
  }

  private onTrekCommitted(newTrek: LoadedTrek, prevTrek: LoadedTrek | null): void {
    this.session.setFollowRoute(false);
    // The previous route's tabletop scale/position must not be applied to this route.
    this.savedTabletopTransform = null;
    this.dioramaFollow.setTerrain(newTrek.terrainResult);
    const track = newTrek.track;
    this.routeLandmarks = resolveRouteLandmarks(track);

    // 1. Setup Flyover Controller callback -> sync to session
    newTrek.flyoverController.setUpdateCallback((state) => {
      this.session.setProgress(state.progress, state.currentPoint.ele, undefined, state.currentPoint);
      this.session.setPlayback(state.isPlaying);
    });

    // 2. Update or create Spatial HUD for this track
    if (this.spatialHUD) {
      this.spatialHUD.setTrack(track, this.routeLandmarks);
      this.spatialHUD.setHorizonLocked(this.horizonLocked);
      if (!this.spatialHUD.group.parent) {
        this.sceneManager.scene.add(this.spatialHUD.group);
      }
    } else {
      this.spatialHUD = new SpatialHUD(track, {
        onSetHorizonLocked: (locked) => this.setHorizonLocked(locked),
        onResetHorizon: () => this.resetHorizon(),
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
        onSetPlaybackMode: (mode) => this.session.setPlaybackMode(mode),
        onStepSeconds: (secs) => this.flyoverController?.stepSeconds(secs),
        onFocusHiker: () => this.focusOnHiker(),
        onToggleFollowRoute: () => this.toggleFollowRoute(),
        onDockHUD: (side) => this.dockHUD(side),
        onSelectWaypoint: (name, lat, lon, progress) => this.jumpToWaypoint(name, lat, lon, progress),
      }, this.sceneManager.renderer.xr.isPresenting, this.routeLandmarks);
      this.spatialHUD.setHorizonLocked(this.horizonLocked);
      this.sceneManager.scene.add(this.spatialHUD.group);
    }

    // Position Spatial HUD docked comfortably to the left (leaving center mountain view completely open)
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
    if (this.currentViewMode === 'first-person' && this.sceneManager.renderer.xr.isPresenting) {
      // A new route starts at the reference-space origin; place it around the viewer instead.
      const xrCamera = this.sceneManager.renderer.xr.getCamera();
      newTrek.flyoverController.recenterViewer(xrCamera);
      newTrek.flyoverController.update(0, xrCamera, this.sceneManager.dioramaRoot, true);
    }

    // 6. Update 2D Overlay
    this.overlay.clearStatus();
    this.overlay.updateTrack(track, this.routeLandmarks);
    this.overlay.setXREnabled(true);
    void this.autoEnterInstalledPWA();
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
    this.dioramaFollow.setTerrain(null);
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

    // Dock relative to where the user is looking (never fixed room coordinates, which could
    // land across the room after walking or table placement). Meta's hands guidance: panels
    // used by ray belong at >= 0.8-1 m, never the 0.5-0.8 m band where users try to poke.
    const direction = _scratchHUDDir;
    activeCamera.getWorldDirection(direction);
    const yaw = Math.atan2(-direction.x, -direction.z);
    const firstPerson = this.currentViewMode === 'first-person';
    const lateral = side === 'left' ? -0.6 : side === 'right' ? 0.6 : 0;
    const offset = _scratchHUDOffset.set(lateral, firstPerson ? -0.25 : -0.2, firstPerson ? -1.2 : -1.05);
    offset.applyAxisAngle(_yAxis, yaw);
    this.spatialHUD.group.position.copy(camPos).add(offset);
    // Level orientation facing user: pure vertical yaw, zero crooked tilt/roll
    this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);
    this.spatialHUD.setAngularSize(camPos.distanceTo(this.spatialHUD.group.position), this.comfort.panelScale);
  }

  private toggleHUD(): void {
    if (!this.spatialHUD) return;
    if (this.spatialHUD.group.visible) this.spatialHUD.group.visible = false;
    else this.dockHUD(this.currentHUDDockSide);
  }

  private syncHUDState(): void {
    const s = this.session.getState();
    this.spatialHUD?.setFollowRoute(s.followRoute);
    this.spatialHUD?.setPlaybackMode(s.playbackMode);
    this.spatialHUD?.updateState(
      s.progress,
      s.currentElevation,
      s.isPlaying,
      s.viewMode,
      s.textureStyle,
      s.playbackSpeed,
      s.trailColorMode,
      s.verticalExaggeration,
      s.currentPoint
    );
  }

  private togglePlay(): void {
    OfflineDownloads.pause();
    if (this.graphicsRecovery?.isSuspended) return;
    if (!this.flyoverController) return;
    const isPlaying = this.flyoverController.togglePlay();
    // Desktop: following moves the camera, so it is a sensible default. XR: following slides
    // the anchored table through the room, so it stays an explicit choice (HUD Follow button).
    if (isPlaying && this.currentViewMode === 'diorama' && !this.sceneManager.renderer.xr.isPresenting) this.session.setFollowRoute(true);
    this.session.setPlayback(isPlaying);
  }

  private toggleFollowRoute(): void {
    if (!this.currentTrack || this.currentViewMode !== 'diorama' || this.graphicsRecovery?.isSuspended) return;
    this.session.setFollowRoute(!this.session.getState().followRoute);
  }

  private setViewMode(mode: ViewMode): void {
    this.session.setViewMode(mode);
  }

  private applyViewMode(mode: ViewMode, prevMode?: ViewMode): void {
    this.session.setFollowRoute(false);
    this.overlay.setViewMode(mode);
    this.syncHUDState();
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
          if (this.horizonLocked) levelHorizon(root);
        }
        this.controls.enabled = !this.sceneManager.renderer.xr.isPresenting;
        if (this.controls.enabled) this.frameDesktopDiorama();
        this.dockHUD(this.currentHUDDockSide);
      } else {
        this.controls.enabled = false;
        this.flyoverController?.pause();
        this.session.setPlayback(false);
        if (this.sceneManager.renderer.xr.isPresenting) {
          this.flyoverController?.recenterViewer(this.sceneManager.renderer.xr.getCamera());
        }
        // Update the desktop eye before placing a world-space panel.
        this.flyoverController?.update(0, this.sceneManager.camera, this.sceneManager.dioramaRoot, this.sceneManager.renderer.xr.isPresenting);
        this.dockHUD(this.currentHUDDockSide);
      }
    }
  }

  private exitMR(): void {
    const session = this.sceneManager.renderer.xr.getSession();
    if (!session || this.xrExitPending) return;
    this.xrExitPending = true;
    void endXRSessionAfterFrame(session).catch(error => {
      console.warn('Failed to end XR session:', error);
      if (!this.isDisposed) this.overlay.showStatus('Could not exit VR/MR. Use the headset menu to leave.', true);
    }).finally(() => { this.xrExitPending = false; });
  }

  private getProfileCounters(): ProfileCounters {
    const info = this.sceneManager.getMemoryInfo();
    const lod = this.activeTrek?.imageryLOD.getDiagnostics();
    const batch = this.activeTrek?.imageryLOD.getBatchDiagnostics?.();
    const cache = TileImageCache.getStats();
    const resourceCache = PersistentResourceCache.getStats();
    const state = this.session.getState();
    const xr = this.sceneManager.renderer.xr;
    const hud = this.spatialHUD?.getUploadDiagnostics();
    return {
      ...this.sceneManager.getXRRenderQuality(),
      xrPresenting: xr.isPresenting,
      xrEnvironmentBlendMode: xr.getSession()?.environmentBlendMode ?? 'none',
      xrEyeCount: xr.isPresenting ? xr.getCamera().cameras.length : 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      tileCacheEntries: cache.entries,
      tileCacheDecodedMB: Number((cache.decodedBytes / 1048576).toFixed(1)),
      resourceCacheHits: resourceCache.hits,
      resourceCacheMisses: resourceCache.misses,
      resourceCacheWrites: resourceCache.writes,
      resourceCacheWriteFailed: resourceCache.writeFailed,
      imageryPatches: lod?.activePatchesCount ?? 0,
      imageryBatchStatus: batch?.status ?? 'off',
      imageryBatchMode: batch?.mode ?? 'patches',
      imageryLookupMB: (batch?.lookupBytes ?? 0) / (1024 * 1024),
      imageryReclippingAvoidedTotal: batch?.reprojectionsAvoided ?? 0,
      imageryBatchedPatches: batch?.patches ?? 0,
      imageryBatchPreparationMs: batch?.lastPreparationMs ?? 0,
      imageryBatchArrayMB: (batch?.arrayBytes ?? 0) / (1024 * 1024),
      imageryBatchGeometryMB: (batch?.geometryBytes ?? 0) / (1024 * 1024),
      imageryCoveragePercent: lod?.coveragePercent ?? 0,
      firstPersonViewSamples: lod?.firstPersonViewSamples ?? 0,
      firstPersonHighResSamples: lod?.firstPersonHighResSamples ?? 0,
      firstPersonViewMinZoom: lod?.firstPersonViewMinZoom ?? 0,
      firstPersonViewMeanZoom: lod?.firstPersonViewMeanZoom ?? 0,
      firstPersonLocalSurfaceRays: lod?.firstPersonLocalSurfaceRays ?? 0,
      firstPersonBaseSurfaceRays: lod?.firstPersonBaseSurfaceRays ?? 0,
      baseTerrainCellXM: this.activeTrek?.terrainResult.baseMeshGrid
        ? Number((this.activeTrek.terrainResult.baseMeshGrid.width /
          this.activeTrek.terrainResult.baseMeshGrid.segmentsX).toFixed(1)) : 0,
      baseTerrainCellZM: this.activeTrek?.terrainResult.baseMeshGrid
        ? Number((this.activeTrek.terrainResult.baseMeshGrid.depth /
          this.activeTrek.terrainResult.baseMeshGrid.segmentsZ).toFixed(1)) : 0,
      baseDemZoom: this.activeTrek?.terrainResult.demGrid?.zoom ?? 0,
      regionalBaseDemZoom: this.activeTrek?.terrainResult.regionalGrid?.zoom ?? 0,
      regionalBaseTiles: this.activeTrek?.terrainResult.regionalGrid?.quality?.regionalTiles ?? 0,
      baseElevationSource: this.activeTrek?.terrainResult.demGrid?.source ?? 'unavailable',
      localElevationSource: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.currentGrid.source ?? 'unavailable',
      localElevationSampleSpacingM: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.currentGrid.sampleSpacingMeters ?? 0,
      residentUSGSRasterMB: (this.terrainResult?.localChunks ?? []).reduce((bytes, chunk) => bytes + (chunk.currentGrid.rasterBounds ? chunk.currentGrid.data.byteLength : 0), 0) / (1024 * 1024),
      visibleLocalDemZoom: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.currentGrid.zoom ?? 0,
      visibleLocalCellXM: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.getCellSize().x ?? 0,
      visibleLocalCellZM: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.getCellSize().z ?? 0,
      regionalDemEnabled: ElevationTileService.isRegionalDEMEnabled(),
      visibleLocalRegionalTiles: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.currentGrid.quality?.regionalTiles ?? 0,
      visibleLocalAwsTiles: this.activeTrek?.localTerrainStreamer?.activeVisibleChunk?.currentGrid.quality?.awsTiles ?? 0,
      imageryInFlight: lod?.inFlightRequests ?? 0,
      imageryTargetZoom: lod?.targetZoom ?? 0,
      imageryFocusSource: this.activeTrek?.imageryLOD.getFocusSource() ?? 'none',
      imageryDesiredTiles: lod?.requestedCount ?? 0,
      imageryVisiblePatches: lod?.visibleCount ?? 0,
      imageryVisibleBySource: lod?.visibleBySource ?? {},
      imageryVisibleFineBySource: lod?.visibleFineBySource ?? {},
      imageryVisibleAlternativeSources: lod?.visibleAlternativeSources ?? 0,
      imageryCreatedTotal: lod?.patchesCreatedTotal ?? 0,
      imageryDisposedTotal: lod?.patchesDisposedTotal ?? 0,
      imageryBudgetEvictionsTotal: lod?.budgetEvictionsTotal ?? 0,
      imageryVisibleBudgetEvictionsTotal: lod?.visibleBudgetEvictionsTotal ?? 0,
      imageryDesiredBudgetEvictionsTotal: lod?.desiredBudgetEvictionsTotal ?? 0,
      tileCacheFailures: cache.failureCount,
      localTerrainChunks: this.activeTrek?.localTerrainStreamer?.activeChunks.length ?? 0,
      localTerrainFocusChangesTotal: this.activeTrek?.localTerrainStreamer?.getTabletopFocusChangesTotal() ?? 0,
      qualityProfile: state.qualityProfile,
      viewMode: state.viewMode,
      playbackMode: state.playbackMode,
      playbackSpeed: state.playbackSpeed,
      isPlaying: state.isPlaying,
      followRoute: state.followRoute,
      routeProgress: state.progress,
      hudVisible: hud?.visible ?? false,
      hudUploadRequestsTotal: hud?.requests,
      hudUploadBytesRequestedTotal: hud?.requestedBytes,
      textureStyle: state.textureStyle,
      imageryProvider: TextureProvider.getProviderInitState().activeProvider,
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
    if (this.sceneManager.renderer.xr.isPresenting || this.currentViewMode !== 'diorama' || this.graphicsRecovery?.isSuspended) return;
    this.session.setFollowRoute(false);
    const terrain = this.activeTrek?.terrainResult.terrainMesh;
    if (!terrain) return;
    const root = this.sceneManager.dioramaRoot;
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(terrain);
    const skirt = this.activeTrek?.terrainResult.skirtMesh;
    if (skirt) box.union(new THREE.Box3().setFromObject(skirt));
    for (const chunk of this.activeTrek?.terrainResult.localChunks ?? []) {
      if (chunk.mesh.visible) box.union(new THREE.Box3().setFromObject(chunk.mesh));
    }
    const camera = this.sceneManager.camera;
    const top = document.querySelector('.top-bar')?.getBoundingClientRect().bottom ?? 80;
    const bottom = document.querySelector('.player-bar')?.getBoundingClientRect().top ?? window.innerHeight - 140;
    const statsRight = window.innerWidth > 900 ? (document.querySelector('.stats-panel')?.getBoundingClientRect().right ?? 344) + 16 : 0;
    // Finish pending orbit inertia before applying a deliberate camera fit.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    if (!fitInspectionBounds(camera, this.controls.target, box, window.innerWidth, window.innerHeight,
      { left: Math.max(16, statsRight), right: window.innerWidth - 16, top: top + 16, bottom: bottom - 16 })) return;
    this.controls.update();
    this.sceneManager.updateCameraClipping(this.controls.getDistance());
    this.desktopViewFitted = true;
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

  private setHorizonLocked(locked: boolean): void {
    this.horizonLocked = locked;
    this.session.setHorizonLocked(locked);
    saveHorizonLock(locked);
    this.xrManager.setHorizonLocked(locked);
    this.overlay.setHorizonLocked(locked);
    this.spatialHUD?.setHorizonLocked(locked);
    if (locked) this.resetHorizon();
  }

  private resetHorizon(): void {
    // A level reset is independent of route progress, model position and inspection zoom.
    if (this.currentViewMode === 'diorama') levelHorizon(this.sceneManager.dioramaRoot);
    if (this.savedTabletopTransform) {
      const saved = new THREE.Object3D();
      saved.quaternion.copy(this.savedTabletopTransform.quaternion);
      levelHorizon(saved);
      this.savedTabletopTransform.quaternion.copy(saved.quaternion);
    }
    if (!this.sceneManager.renderer.xr.isPresenting) {
      const camera = this.sceneManager.camera;
      camera.up.set(0, 1, 0);
      if (this.currentViewMode === 'diorama') camera.lookAt(this.controls.target);
    }
  }

  private focusOnHiker(): void {
    if (!this.flyoverController || !this.currentTrack) return;
    this.desktopViewFitted = false;
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

  public jumpToWaypoint(name: string, lat?: number, lon?: number, routeProgress?: number): void {
    if (!this.currentTrack || this.currentTrack.points.length === 0) return;

    let targetLat = lat;
    let targetLon = lon;
    const presented = this.routeLandmarks?.find(item => item.name === name &&
      (lat === undefined || Math.abs(item.lat - lat) < 1e-7) &&
      (lon === undefined || Math.abs(item.lon - lon) < 1e-7));
    const progressHint = routeProgress ?? presented?.progress;

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
      if (progressHint !== undefined && Number.isFinite(progressHint)) {
        progress = Math.max(0, Math.min(1, progressHint));
        curDist = progress * this.currentTrack.totalDistance;
      } else {
        const proj = this.activeTrek.trailResult.routeGeometry.projectGeoPointToVisualRoute(targetLat, targetLon);
        progress = proj.progress;
        curDist = proj.routeDistanceMeters;
      }
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

  /** XR view switches fade through black (~0.25 s each way) so the world never jumps
   * from tabletop to life-size in a single frame. Desktop switches stay instant. */
  private viewTransition: { phase: 'out' | 'in'; elapsed: number; next: ViewMode } | null = null;
  private viewHoldProgress: number | null = null;
  private static readonly VIEW_FADE_S = 0.25;

  private toggleViewMode(): void {
    const nextMode: ViewMode = this.currentViewMode === 'diorama' ? 'first-person' : 'diorama';
    if (!this.sceneManager.renderer.xr.isPresenting) { this.setViewMode(nextMode); return; }
    if (this.viewTransition) return;
    this.viewTransition = { phase: 'out', elapsed: 0, next: nextMode };
  }

  private updateViewTransition(delta: number): void {
    const t = this.viewTransition;
    if (!t) {
      // While A/X is held, dim slightly as a progress cue for the coming switch.
      this.sceneManager.setFade(this.viewHoldProgress != null ? 0.35 * this.viewHoldProgress : 0);
      return;
    }
    t.elapsed += delta;
    const k = Math.min(1, t.elapsed / TrekViewerApp.VIEW_FADE_S);
    if (t.phase === 'out') {
      this.sceneManager.setFade(k);
      if (k >= 1) {
        this.setViewMode(t.next);
        if (t.next === 'first-person' && this.sceneManager.renderer.xr.getSession()?.environmentBlendMode !== 'opaque') {
          this.spatialHUD?.showStatus('Life-size view: the terrain covers your real floor. Stay in place and move with the thumbstick.');
        }
        this.viewTransition = { phase: 'in', elapsed: 0, next: t.next };
      }
    } else {
      this.sceneManager.setFade(1 - k);
      if (k >= 1) { this.viewTransition = null; this.sceneManager.setFade(0); }
    }
  }

  private async setTextureStyle(style: TextureStyle): Promise<void> {
    this.session.setTextureStyle(style);
  }

  public async setSatelliteProvider(provider: 'auto' | 'esri' | 'cesium-bing', token?: string): Promise<void> {
    try {
      localStorage.setItem(TextureProvider.PROVIDER_STORAGE_KEY, provider);
      if (token !== undefined) {
        if (token.trim().length > 0) {
          localStorage.setItem('trekviewer-cesium-token', token.trim());
        } else {
          localStorage.removeItem('trekviewer-cesium-token');
        }
      }
    } catch {}
    const resolvedToken = token || (typeof localStorage !== 'undefined' ? localStorage.getItem('trekviewer-cesium-token') ?? undefined : undefined);
    await TextureProvider.waitForInitialization();
    const success = await TextureProvider.setSatelliteProvider(provider, resolvedToken);
    // A newer selection superseded this one while it was loading.
    if (this.isDisposed || TextureProvider.getSatelliteProviderSetting() !== provider) return;
    // Imagery tiles are keyed by provider id; drop only satellite/label imagery, never DEM tiles.
    TileImageCache.clearProviders(TextureProvider.getSatelliteImageryProviderIds());
    const style = this.session.getState().textureStyle;
    const bounds = this.currentTrack?.bounds;
    const attribution = TextureProvider.getAttributionForStyle(style, bounds);
    this.session.setAttribution(attribution);
    this.overlay.setSatelliteProvider(provider, attribution);
    if (this.activeTrek) {
      await this.activeTrek.setTextureStyle(style, true);
    }
    const displayName = TextureProvider.getActiveSatelliteProvider().displayName;
    const fallbackReason = TextureProvider.getProviderInitState().fallbackReason;
    const statusMsg = fallbackReason && provider !== 'auto'
      ? `Satellite provider fallback: ${fallbackReason}`
      : `Satellite provider: ${displayName}`;
    this.overlay.showStatus(statusMsg, !success && provider !== 'auto', success ? 'ready' : 'error');
  }

  private setTrailColorMode(mode: TrailColorMode): void {
    this.session.setTrailColorMode(mode);
  }

  private async updateXRAvailability(): Promise<void> {
    if (this.isDisposed) return;
    const generation = ++this.xrAvailabilityGeneration;
    this.overlay.beginXRSupportCheck();
    const xr = navigator.xr;
    if (!xr) {
      this.overlay.setXRSupport(false, false, 'VR/MR is unavailable here. Open this page in a headset browser.');
      return;
    }
    const support = await Promise.allSettled([
      Promise.resolve().then(() => xr.isSessionSupported('immersive-vr')),
      Promise.resolve().then(() => xr.isSessionSupported('immersive-ar')),
    ]);
    if (this.isDisposed || generation !== this.xrAvailabilityGeneration) return;
    const vr = support[0].status === 'fulfilled' ? support[0].value : null;
    const ar = support[1].status === 'fulfilled' ? support[1].value : null;
    const message = vr === false && ar === false ? 'VR/MR is unavailable here. Open this page in a headset browser.'
      : ar === false && vr === true ? 'Passthrough is unavailable here. Enter VR is available.'
      : vr === null || ar === null ? 'Availability could not be checked. Try entering with your headset connected.' : '';
    this.overlay.setXRSupport(vr, ar, message);
  }

  private autoEnterAttempted = false;

  /** Meta's WebXR PWA guidance: an installed PWA should open straight into immersive mode
   * (the app-icon tap counts as user activation). `getDigitalGoodsService` only exists inside
   * the packaged PWA, so a normal browser tab keeps the 2D landing page. Passthrough is
   * preferred because the tabletop is designed for mixed reality. Runs once per page load. */
  private async autoEnterInstalledPWA(): Promise<void> {
    if (this.autoEnterAttempted || typeof window === 'undefined') return;
    this.autoEnterAttempted = true;
    if ((window as Window & { getDigitalGoodsService?: unknown }).getDigitalGoodsService === undefined) return;
    if (!navigator.xr || this.sceneManager.renderer.xr.isPresenting) return;
    const ar = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    await this.enterXR(ar ? 'immersive-ar' : 'immersive-vr');
  }

  private async enterXR(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
    if (this.isDisposed || this.graphicsRecovery?.isSuspended || this.xrEntryPending || this.sceneManager.renderer.xr.isPresenting) return;
    if (!navigator.xr) {
      this.overlay.showStatus('WebXR is not supported by this browser. Open this URL in the Meta Quest Browser on your Quest 3!', true);
      return;
    }

    if (!this.activeTrek) {
      this.overlay.showStatus('Please wait for the trek to finish loading before entering VR/MR.', false);
      return;
    }

    this.xrEntryPending = true;
    OfflineDownloads.pause();
    let requestedSession: XRSession | null = null;
    try {
      const isSupported = await (navigator as any).xr.isSessionSupported(mode);
      if (!isSupported) {
        this.overlay.showStatus(mode === 'immersive-ar'
          ? 'Passthrough is unavailable here. Choose Enter VR to use virtual reality.'
          : 'VR is unavailable in this browser or device.', true);
        return;
      }

      const sessionInit: XRSessionInit = {
        requiredFeatures: ['local-floor'],
        // plane-detection + anchors let the tabletop sit on, and stay with, the real table.
        optionalFeatures: ['hand-tracking', 'layers', 'plane-detection', 'anchors'],
      };

      if (this.isDisposed) return;
      const session = await (navigator as any).xr.requestSession(mode, sessionInit);
      requestedSession = session;
      if (this.isDisposed) { await session.end(); return; }
      await this.sceneManager.renderer.xr.setSession(session);
      this.xrReferenceSpace = this.sceneManager.renderer.xr.getReferenceSpace();
      this.xrReferenceSpace?.addEventListener('reset', this.onReferenceReset);

      if (mode === 'immersive-ar') {
        this.sceneManager.setPassthrough(true);
      } else {
        this.sceneManager.setPassthrough(false);
      }
    } catch (e: any) {
      if (requestedSession) await requestedSession.end().catch(() => {});
      console.error('Failed to start WebXR session:', e);
      this.overlay.showStatus(`Could not start WebXR session: ${e.message}`, true);
    } finally {
      this.xrEntryPending = false;
    }
  }

  private animate(timestamp: number, frame?: XRFrame): void {
    if (this.isDisposed || this.graphicsRecovery?.isSuspended) return;
    const now = performance.now();
    const recorder = this.profile?.activeRecorder ?? null;
    let phaseStart = now;
    const elapsedS = Math.max(0, (now - this.lastTimestamp) / 1000);
    // Physics-like updates use a tight clamp; playback uses a looser one so a slow
    // frame rate does not stretch the 90 s tour (a long pause still cannot jump far).
    const delta = Math.min(elapsedS, 0.1);
    const playbackDelta = Math.min(elapsedS, 0.5);
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

    phaseStart = this.endProfilePhase(recorder, 'input', phaseStart);

    this.updateViewTransition(isPresenting ? elapsedS : 1);

    // 3. Update Flyover / Animation playback
    if (this.flyoverController) {
      this.flyoverController.update(
        playbackDelta,
        activeCamera,
        this.sceneManager.dioramaRoot,
        isPresenting
      );
    }
    if (this.currentViewMode === 'diorama' && this.session.getState().followRoute && this.trailResult) {
      this.trailResult.hikerMarker.getWorldPosition(this.followFocus);
      if (isPresenting) this.dioramaModelFollow.update(this.sceneManager.dioramaRoot, this.followFocus, delta);
      else {
        // Aim between the hiker and the trail a little ahead, so the upcoming route stays in view.
        const marker = this.trailResult.hikerMarker;
        const progress = this.flyoverController?.getProgress() ?? 0;
        const ahead = this.trailResult.routeGeometry?.getTelemetryAtProgress(Math.min(1, progress + 0.02))?.position;
        if (ahead) {
          _scratchFollowAhead.copy(ahead);
          if (marker.parent) marker.parent.localToWorld(_scratchFollowAhead);
          this.followFocus.lerp(_scratchFollowAhead, 0.4);
        }
        this.dioramaFollow.update(this.sceneManager.camera, this.controls.target, this.followFocus, delta);
      }
    }
    if (this.controls.enabled && this.currentViewMode === 'diorama') this.controls.update();
    phaseStart = this.endProfilePhase(recorder, 'simulation', phaseStart);

    if (isPresenting && this.currentViewMode === 'diorama') {
      activeCamera.getWorldPosition(_scratchV3);
      const placed = this.tablePlacement?.update(frame, this.sceneManager.renderer.xr.getReferenceSpace(),
        this.sceneManager.dioramaRoot, _scratchV3, now);
      if (placed) { this.spatialHUD?.showStatus(placed); this.pendingHUDDock = true; }
    } else if (isPresenting) {
      this.tablePlacement?.stopSearching();
    }

    // Wait for the first valid XR camera pose before docking after session entry.
    if (this.pendingHUDDock && frame?.getViewerPose(this.sceneManager.renderer.xr.getReferenceSpace()!)) {
      this.pendingHUDDock = false;
      // Entering XR during playback keeps the table where it was placed (no automatic follow).
      if (this.currentViewMode === 'first-person') {
        this.flyoverController?.recenterViewer(activeCamera);
        this.flyoverController?.update(0, activeCamera, this.sceneManager.dioramaRoot, true);
      }
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
      // Follow prioritizes the hiker's ground; broad visible anchors still refine
      // the surroundings. Looking toward the horizon must not starve the tour.
      const state = this.session.getState();
      let inspectedGeo = this.activeTrek.imageryLOD.getInspectedGeo();
      if (state.followRoute && this.currentViewMode === 'diorama') {
        // The visible route is smoothed independently of analytical GPS
        // telemetry. Refine the ground the camera/model actually follows.
        const point = this.activeTrek.trailResult.hikerMarker.position;
        const center = this.activeTrek.track.bounds;
        inspectedGeo = localMetersToGeo(point.x, point.z, center.centerLat, center.centerLon);
      }
      const previousSurfaceRevision = this.activeTrek.terrainResult.surfaceRevision;
      const prefetchProgress = state.followRoute && state.isPlaying && this.currentViewMode === 'diorama'
        ? this.activeTrek.flyoverController.getLookaheadProgress(1.5) : undefined;
      this.activeTrek.updateHikerProgress(currentProgress, inspectedGeo, this.activeTrek.imageryLOD.getDetailFocusPoints(), prefetchProgress);
      if (this.currentViewMode === 'first-person' && previousSurfaceRevision !== this.activeTrek.terrainResult.surfaceRevision) {
        // Ground the viewer on the promoted surface before this frame renders.
        this.flyoverController?.update(0, activeCamera, this.sceneManager.dioramaRoot, isPresenting);
      }
      phaseStart = this.endProfilePhase(recorder, 'terrain', phaseStart);
      // Update waypoint marker scale compensation & billboard labels (Sections 21, 24, 25)
      this.activeTrek.updateWaypoints(activeCamera, this.sceneManager.dioramaRoot.scale.x, delta,
        isPresenting ? undefined : window.innerHeight);
      phaseStart = this.endProfilePhase(recorder, 'waypoints', phaseStart);
    }

    // 6. Render Scene
    this.activeTrek?.imageryLOD.syncRenderer?.(this.sceneManager.renderer);
    this.sceneManager.updateCameraClipping(!isPresenting && this.currentViewMode === 'diorama'
      ? this.sceneManager.camera.position.distanceTo(this.controls.target) : 0);
    this.sceneManager.updateMotionVignette(this.comfort.vignette && isPresenting && this.currentViewMode === 'first-person'
      && ((this.flyoverController?.getIsPlaying() ?? false) || now - this.lastLocomotionTime < 180), delta);
    this.sceneManager.render();
    phaseStart = this.endProfilePhase(recorder, 'render', phaseStart);

    if (this.profile?.isRecording) {
      const session = this.sceneManager.renderer.xr.getSession();
      const visible = document.visibilityState !== 'hidden' && (!isPresenting || session?.visibilityState === 'visible');
      const hz = isPresenting ? (session as XRSession & { frameRate?: number } | null)?.frameRate ?? null : null;
      this.profile.endFrame(timestamp, now, phaseStart, visible,
        `${isPresenting}/${this.currentViewMode}/${this.session.getState().qualityProfile}/${this.currentTextureStyle}`, hz);
    }

    // 6. Diagnostic Telemetry (?debug=1)
    if (this.debugTelemetry) {
      const xrSession = this.sceneManager.renderer.xr.getSession();
      const refreshRate = (xrSession as XRSession & {frameRate?: number} | null)?.frameRate ?? null;
      const visible = document.visibilityState !== 'hidden' && (!isPresenting || xrSession?.visibilityState === 'visible');
      this.debugTelemetry.frame(timestamp, performance.now() - now, now, visible,
        `${isPresenting}/${this.currentViewMode}/${this.session.getState().qualityProfile}`, isPresenting ? refreshRate : null,
        this.sceneManager.dioramaRoot, (frameTiming, mutations) => this.collectDebugTelemetry(isPresenting, frameTiming, mutations));
    }
  }

  /** 1 Hz debug snapshot for `?debug=1` (console + on-screen badge). */
  private collectDebugTelemetry(isPresenting: boolean, frameTiming: ReturnType<FrameTimingMonitor['snapshot']>, mutations: number): DebugTelemetrySnapshot {
    const diorama = this.sceneManager.dioramaRoot;
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

    const telemetryData = {
      frameTiming,
      buildId: __APP_BUILD_INFO__.id,
      builtAt: __APP_BUILD_INFO__.builtAt,
      dirty: __APP_BUILD_INFO__.dirty,
      sha: __APP_BUILD_INFO__.shortSha,
      label: __APP_BUILD_INFO__.label,
      isPresenting,
      viewMode: this.currentViewMode,
      dioramaMutations: mutations,
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

    return { data: telemetryData, lodVisible: lodVisibleStr, hitRate: tileStats.hitRate, failures: tileStats.failureCount };
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.graphicsRecovery?.dispose();
    this.xrAvailabilityGeneration++;
    navigator.xr?.removeEventListener('devicechange', this.onXRDeviceChange);
    if ((window as any).__trekViewerApp === this) delete (window as any).__trekViewerApp;
    this.routeSelectionGeneration++;
    this.sceneManager.renderer.setAnimationLoop(null);
    void this.sceneManager.renderer.xr.getSession()?.end().catch(() => {});
    window.removeEventListener('resize', this.onResize);
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.profile?.dispose();
    this.disposeCurrentTrek();
    this.xrReferenceSpace?.removeEventListener('reset', this.onReferenceReset);
    this.xrReferenceSpace = null;
    disposeTerrainJobs();
    this.tablePlacement.dispose();
    this.xrManager.dispose();
    this.controls.removeEventListener('start', this.onOrbitStart);
    this.controls.dispose();
    this.overlay.dispose();
    this.sceneManager.dispose();
  }
}

// Initialize on DOM load with explicit provider environment resolution (Section 48)
if (typeof window !== 'undefined') {
  const start = () => { new TrekViewerApp(); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start(); // A verified retry can load after DOMContentLoaded already fired.
}
