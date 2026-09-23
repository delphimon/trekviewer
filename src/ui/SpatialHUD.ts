import * as THREE from 'three';
import type { TrackStats, ViewMode, TextureStyle, TrailColorMode, GPXWaypoint } from '../gpx/TrackTypes.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import type { TrekSession, TerrainQuality } from '../core/TrekSession.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface SpatialHUDCallbacks {
  onTogglePlay: () => void;
  onToggleViewMode: () => void;
  onToggleTexture: () => void;
  onToggleTrailColor?: () => void;
  onCycleExaggeration?: () => void;
  onReset: () => void;
  onExitMR: () => void;
  onScrub: (progress: number) => void;
  onSetSpeed: (speed: number) => void;
  onStepSeconds: (seconds: number) => void;
  onFocusHiker: () => void;
  onDockHUD?: (side: 'left' | 'right' | 'center') => void;
  onSelectWaypoint?: (wp: GPXWaypoint) => void;
}

interface InteractiveArea {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  action: () => void;
}

export class SpatialHUD {
  public group: THREE.Group;
  public mesh: THREE.Mesh;
  public grabMesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private staticCanvas: HTMLCanvasElement;
  private staticCtx: CanvasRenderingContext2D;
  private staticDirty: boolean = true;
  private isDisposed: boolean = false;
  private lastProgressDrawTime: number = 0;
  private progressDrawScheduled: boolean = false;

  private texture: THREE.CanvasTexture;
  private track: TrackStats;
  private callbacks: SpatialHUDCallbacks;
  private session?: TrekSession;
  private unsubscribeSession?: () => void;

  private currentProgress: number = 0;
  private currentElevation: number = 0;
  private isPlaying: boolean = false;
  private currentSpeed: number = 20.0;
  private currentViewMode: ViewMode = 'diorama';
  private currentTextureStyle: TextureStyle = 'satellite';
  private currentTrailColorMode: TrailColorMode = 'grade';
  private currentExaggeration: number = 1.0;
  private currentTerrainQuality: TerrainQuality = 'dem';
  private currentDockSide: 'left' | 'right' | 'center' = 'left';
  private attribution: string = 'Map data: Esri, USGS, AWS Open Data';
  private selectedWaypoint: GPXWaypoint | null = null;

  private statusMessage: string | null = null;
  private statusProgress: number = 0;

  private hoveredAreaId: string | null = null;
  private interactiveAreas: InteractiveArea[] = [];
  private isDraggingScrubber: boolean = false;
  private statusTimeout: number | null = null;

  constructor(track: TrackStats, callbacks: SpatialHUDCallbacks, session?: TrekSession) {
    this.track = track;
    this.callbacks = callbacks;
    this.session = session;

    this.group = new THREE.Group();
    this.group.name = 'SpatialHUDGroup';

    // Canvas resolution: 1024 x 680
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);
    this.canvas.width = 1024;
    this.canvas.height = 680;
    this.ctx = (typeof this.canvas.getContext === 'function' ? this.canvas.getContext('2d') : null) as CanvasRenderingContext2D;

    this.staticCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);
    this.staticCanvas.width = 1024;
    this.staticCanvas.height = 680;
    this.staticCtx = (typeof this.staticCanvas.getContext === 'function' ? this.staticCanvas.getContext('2d') : null) as CanvasRenderingContext2D;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    // Physical dimensions in VR: 0.8m wide, 0.53m tall
    const geo = new THREE.PlaneGeometry(0.8, 0.53);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'SpatialHUDMesh';
    this.group.add(this.mesh);

    // 3D Grab Handle
    const grabGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.42, 16);
    grabGeo.rotateZ(Math.PI / 2);
    const grabMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0.8,
      roughness: 0.2,
      emissive: 0x0284c7,
      emissiveIntensity: 0.8,
    });
    this.grabMesh = new THREE.Mesh(grabGeo, grabMat);
    this.grabMesh.position.set(0, 0.29, 0);
    this.grabMesh.name = 'SpatialHUDGrabHandle';
    this.group.add(this.grabMesh);

    // Initial state from track or session
    if (this.session) {
      const s = this.session.getState();
      this.currentProgress = s.progress;
      this.currentElevation = s.currentElevation || (track.points[0]?.ele ?? track.minElevation);
      this.isPlaying = s.isPlaying;
      this.currentSpeed = s.playbackSpeed;
      this.currentViewMode = s.viewMode;
      this.currentTextureStyle = s.textureStyle;
      this.currentTrailColorMode = s.trailColorMode;
      this.currentExaggeration = s.verticalExaggeration;
      this.currentTerrainQuality = s.terrainQuality;
      this.attribution = s.attribution || this.attribution;
      this.selectedWaypoint = s.selectedWaypoint;
      this.statusMessage = s.loadingMessage || null;
      this.statusProgress = s.loadingProgress || 0;

      this.unsubscribeSession = this.session.subscribe((newState) => {
        if (this.isDisposed) return;
        const newLoadingMsg = newState.loadingMessage || null;
        const staticChanged =
          this.isPlaying !== newState.isPlaying ||
          this.currentSpeed !== newState.playbackSpeed ||
          this.currentViewMode !== newState.viewMode ||
          this.currentTextureStyle !== newState.textureStyle ||
          this.currentTrailColorMode !== newState.trailColorMode ||
          this.currentExaggeration !== newState.verticalExaggeration ||
          this.currentTerrainQuality !== newState.terrainQuality ||
          this.attribution !== (newState.attribution || this.attribution) ||
          this.selectedWaypoint !== newState.selectedWaypoint ||
          this.statusMessage !== newLoadingMsg;

        const prevProgress = this.currentProgress;
        const progressDelta = Math.abs(prevProgress - newState.progress);
        const shouldRedrawProgress = this.isPlaying || progressDelta > 0.0001;

        this.currentProgress = newState.progress;
        this.currentElevation = newState.currentElevation;
        this.isPlaying = newState.isPlaying;
        this.currentSpeed = newState.playbackSpeed;
        this.currentViewMode = newState.viewMode;
        this.currentTextureStyle = newState.textureStyle;
        this.currentTrailColorMode = newState.trailColorMode;
        this.currentExaggeration = newState.verticalExaggeration;
        this.currentTerrainQuality = newState.terrainQuality;
        if (newState.attribution) this.attribution = newState.attribution;
        this.selectedWaypoint = newState.selectedWaypoint;
        if (newLoadingMsg) {
          this.statusMessage = newLoadingMsg;
          this.statusProgress = newState.loadingProgress ?? 0;
        } else {
          this.statusMessage = null;
        }

        if (staticChanged) {
          this.staticDirty = true;
          this.drawHUD(true);
        } else if (shouldRedrawProgress) {
          // Throttled progress update (target ~11Hz)
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          if (now - this.lastProgressDrawTime >= 90) {
            this.lastProgressDrawTime = now;
            this.drawHUD(false);
          } else if (!this.progressDrawScheduled) {
            this.progressDrawScheduled = true;
            const wait = Math.max(10, 90 - (now - this.lastProgressDrawTime));
            setTimeout(() => {
              this.progressDrawScheduled = false;
              if (!this.isDisposed) {
                this.lastProgressDrawTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
                this.drawHUD(false);
              }
            }, wait);
          }
        }
      });
    } else {
      this.currentElevation = track.points[0]?.ele ?? track.minElevation;
    }

    this.setupInteractiveAreas();
    this.drawHUD(true);
  }

  public isHoveringDragHandle(): boolean {
    return this.hoveredAreaId === 'hud-drag';
  }

  public showStatus(message: string): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    this.statusMessage = message;
    const match = message.match(/\((\d+)%\)/);
    if (match) {
      this.statusProgress = parseInt(match[1], 10) / 100;
    } else {
      this.statusProgress = 0;
    }
    this.staticDirty = true;
    this.drawHUD(true);

    if (
      message.includes('active') ||
      message.includes('Loaded:') ||
      message.includes('ready') ||
      message.includes('complete')
    ) {
      this.statusTimeout = window.setTimeout(() => {
        this.clearStatus();
      }, 2500);
    }
  }

  public clearStatus(): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    this.statusMessage = null;
    this.statusProgress = 0;
    this.staticDirty = true;
    this.drawHUD(true);
  }

  private cycleDock(): void {
    if (this.currentDockSide === 'left') {
      this.currentDockSide = 'center';
    } else if (this.currentDockSide === 'center') {
      this.currentDockSide = 'right';
    } else {
      this.currentDockSide = 'left';
    }
    this.callbacks.onDockHUD?.(this.currentDockSide);
    this.staticDirty = true;
    this.drawHUD(true);
  }

  public setDockSide(side: 'left' | 'right' | 'center'): void {
    if (this.currentDockSide === side) return;
    this.currentDockSide = side;
    this.staticDirty = true;
    this.drawHUD(true);
  }

  private setupInteractiveAreas(): void {
    this.interactiveAreas = [
      // Drag handle
      {
        id: 'hud-drag',
        x: 360,
        y: 8,
        w: 304,
        h: 36,
        action: () => {},
      },
      // Quick Dock side button
      {
        id: 'hud-dock',
        x: 650,
        y: 25,
        w: 115,
        h: 54,
        action: () => this.cycleDock(),
      },
      // Exit MR button
      {
        id: 'exit-mr',
        x: 780,
        y: 25,
        w: 210,
        h: 54,
        action: () => this.callbacks.onExitMR(),
      },

      // Waypoint Quick-Jump Controls (inside chart header)
      {
        id: 'btn-wp-prev',
        x: 55,
        y: 204,
        w: 36,
        h: 32,
        action: () => this.cycleWaypoint(-1),
      },
      {
        id: 'btn-wp-curr',
        x: 93,
        y: 204,
        w: 320,
        h: 32,
        action: () => this.jumpToCurrentWaypoint(),
      },
      {
        id: 'btn-wp-next',
        x: 415,
        y: 204,
        w: 36,
        h: 32,
        action: () => this.cycleWaypoint(1),
      },

      // Row 1: Flyover Transport & Speeds (y = 410)
      {
        id: 'btn-play',
        x: 35,
        y: 410,
        w: 180,
        h: 58,
        action: () => this.callbacks.onTogglePlay(),
      },
      {
        id: 'btn-step-back',
        x: 225,
        y: 410,
        w: 95,
        h: 58,
        action: () => this.callbacks.onStepSeconds(-10),
      },
      {
        id: 'btn-step-fwd',
        x: 330,
        y: 410,
        w: 95,
        h: 58,
        action: () => this.callbacks.onStepSeconds(10),
      },
      {
        id: 'spd-1',
        x: 445,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 1.0;
          this.callbacks.onSetSpeed(1.0);
          this.staticDirty = true;
          this.drawHUD(true);
        },
      },
      {
        id: 'spd-5',
        x: 535,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 5.0;
          this.callbacks.onSetSpeed(5.0);
          this.staticDirty = true;
          this.drawHUD(true);
        },
      },
      {
        id: 'spd-20',
        x: 625,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 20.0;
          this.callbacks.onSetSpeed(20.0);
          this.staticDirty = true;
          this.drawHUD(true);
        },
      },
      {
        id: 'spd-60',
        x: 715,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 60.0;
          this.callbacks.onSetSpeed(60.0);
          this.staticDirty = true;
          this.drawHUD(true);
        },
      },
      {
        id: 'btn-reset',
        x: 810,
        y: 410,
        w: 180,
        h: 58,
        action: () => this.callbacks.onReset(),
      },

      // Row 2: View Modes, Focus, Map Style, Trail Colors, Exaggeration (y = 485)
      {
        id: 'btn-view',
        x: 35,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onToggleViewMode(),
      },
      {
        id: 'btn-focus',
        x: 225,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onFocusHiker(),
      },
      {
        id: 'btn-texture',
        x: 415,
        y: 485,
        w: 190,
        h: 58,
        action: () => this.callbacks.onToggleTexture(),
      },
      {
        id: 'btn-color',
        x: 615,
        y: 485,
        w: 185,
        h: 58,
        action: () => this.callbacks.onToggleTrailColor?.(),
      },
      {
        id: 'btn-exaggeration',
        x: 810,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onCycleExaggeration?.(),
      },
    ];
  }

  public updateState(
    progress: number,
    currentEle: number,
    isPlaying: boolean,
    viewMode: ViewMode,
    textureStyle: TextureStyle,
    speed?: number,
    trailColorMode?: TrailColorMode,
    exaggeration?: number,
    terrainQuality?: TerrainQuality
  ): void {
    const staticChanged =
      this.isPlaying !== isPlaying ||
      this.currentViewMode !== viewMode ||
      this.currentTextureStyle !== textureStyle ||
      (speed !== undefined && this.currentSpeed !== speed) ||
      (trailColorMode !== undefined && this.currentTrailColorMode !== trailColorMode) ||
      (exaggeration !== undefined && this.currentExaggeration !== exaggeration) ||
      (terrainQuality !== undefined && this.currentTerrainQuality !== terrainQuality);

    this.currentProgress = progress;
    this.currentElevation = currentEle;
    this.isPlaying = isPlaying;
    this.currentViewMode = viewMode;
    this.currentTextureStyle = textureStyle;
    if (speed !== undefined) this.currentSpeed = speed;
    if (trailColorMode !== undefined) this.currentTrailColorMode = trailColorMode;
    if (exaggeration !== undefined) this.currentExaggeration = exaggeration;
    if (terrainQuality !== undefined) this.currentTerrainQuality = terrainQuality;

    if (staticChanged) {
      this.staticDirty = true;
    }
    this.drawHUD(staticChanged);
  }

  private cycleWaypoint(delta: number): void {
    const allWaypoints = this.track.waypoints.concat(this.track.landmarks);
    if (allWaypoints.length === 0) return;
    const curIdx = this.selectedWaypoint
      ? allWaypoints.findIndex((w) => w.name === this.selectedWaypoint!.name)
      : -1;
    const nextIdx = (curIdx + delta + allWaypoints.length) % allWaypoints.length;
    const wp = allWaypoints[nextIdx];
    this.selectedWaypoint = wp;
    this.callbacks.onSelectWaypoint?.(wp);
    this.staticDirty = true;
    this.drawHUD(true);
  }

  private jumpToCurrentWaypoint(): void {
    const allWaypoints = this.track.waypoints.concat(this.track.landmarks);
    if (allWaypoints.length === 0) return;
    const wp = this.selectedWaypoint || allWaypoints[0];
    this.selectedWaypoint = wp;
    this.callbacks.onSelectWaypoint?.(wp);
    this.staticDirty = true;
    this.drawHUD(true);
  }

  private uvToCanvas(uv: THREE.Vector2): { x: number; y: number } {
    return {
      x: uv.x * this.canvas.width,
      y: (1 - uv.y) * this.canvas.height,
    };
  }

  public onPointerHover(uv: THREE.Vector2): void {
    const pt = this.uvToCanvas(uv);
    let foundId: string | null = null;

    for (const area of this.interactiveAreas) {
      if (
        pt.x >= area.x &&
        pt.x <= area.x + area.w &&
        pt.y >= area.y &&
        pt.y <= area.y + area.h
      ) {
        foundId = area.id;
        break;
      }
    }

    if (!foundId && pt.x >= 35 && pt.x <= 989 && pt.y >= 195 && pt.y <= 385) {
      foundId = 'chart-scrub';
    }

    if (foundId !== this.hoveredAreaId) {
      this.hoveredAreaId = foundId;
      this.staticDirty = true;
      this.drawHUD(true);
    }
  }

  public onPointerLeave(): void {
    if (this.hoveredAreaId !== null) {
      this.hoveredAreaId = null;
      this.isDraggingScrubber = false;
      this.staticDirty = true;
      this.drawHUD(true);
    }
  }

  public onPointerClick(uv: THREE.Vector2): boolean {
    const pt = this.uvToCanvas(uv);

    for (const area of this.interactiveAreas) {
      if (
        pt.x >= area.x &&
        pt.x <= area.x + area.w &&
        pt.y >= area.y &&
        pt.y <= area.y + area.h
      ) {
        area.action();
        this.staticDirty = true;
        this.drawHUD(true);
        return true;
      }
    }

    if (pt.x >= 35 && pt.x <= 989 && pt.y >= 190 && pt.y <= 395) {
      const chartWidth = 989 - 35 - 36;
      const progress = Math.min(Math.max((pt.x - 53) / chartWidth, 0), 1);
      this.isDraggingScrubber = true;
      this.callbacks.onScrub(progress);
      return true;
    }

    return false;
  }

  public onPointerDrag(uv: THREE.Vector2): void {
    const pt = this.uvToCanvas(uv);
    if (pt.y >= 170 && pt.y <= 405) {
      const chartWidth = 989 - 35 - 36;
      const progress = Math.min(Math.max((pt.x - 53) / chartWidth, 0), 1);
      this.callbacks.onScrub(progress);
    }
  }

  public onPointerRelease(): void {
    this.isDraggingScrubber = false;
  }

  private drawStaticHUD(): void {
    if (!this.staticCtx) return;
    const ctx = this.staticCtx;
    const w = this.staticCanvas.width;
    const h = this.staticCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // Glassmorphism card background
    ctx.fillStyle = 'rgba(11, 17, 32, 0.94)';
    ctx.beginPath();
    ctx.roundRect(10, 10, w - 20, h - 20, 28);
    ctx.fill();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 1. Header Title & Subtitle
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    let title = this.track.name;
    if (title.length > 24) title = title.substring(0, 22) + '...';
    ctx.fillText(title, 40, 56);

    // Subtle terrain quality and attribution badge
    const qualityLabel =
      this.currentTerrainQuality === 'dem'
        ? 'DEM: Authoritative USGS/SRTM'
        : this.currentTerrainQuality === 'partial-dem'
        ? 'DEM: Mixed / Partial'
        : 'DEM: Approximate Synthetic';

    ctx.fillStyle = this.currentTerrainQuality === 'dem' ? '#10b981' : '#f59e0b';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`⛰️ ${qualityLabel}`, 40, 84);

    ctx.fillStyle = '#64748b';
    ctx.font = '12px sans-serif';
    ctx.fillText(`•  ${this.attribution}`, 260, 84);

    // Top Drag Handle Bar
    const isDragHover = this.hoveredAreaId === 'hud-drag';
    ctx.fillStyle = isDragHover ? 'rgba(56, 189, 248, 0.35)' : 'rgba(56, 189, 248, 0.15)';
    ctx.beginPath();
    ctx.roundRect(360, 8, 304, 30, 10);
    ctx.fill();
    ctx.strokeStyle = isDragHover ? '#38bdf8' : 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = isDragHover ? '#ffffff' : '#38bdf8';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⠿ GRAB / DRAG TO MOVE HUD', 512, 28);
    ctx.textAlign = 'left';

    // Dock Button
    const dockHover = this.hoveredAreaId === 'hud-dock';
    ctx.fillStyle = dockHover ? '#0284c7' : 'rgba(30, 41, 59, 0.85)';
    ctx.beginPath();
    ctx.roundRect(650, 25, 115, 54, 14);
    ctx.fill();
    ctx.strokeStyle = dockHover ? '#ffffff' : 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    const dockLabel = this.currentDockSide === 'left' ? '📍 Dock L' : this.currentDockSide === 'center' ? '📍 Dock C' : '📍 Dock R';
    ctx.fillText(dockLabel, 664, 58);

    // 2. Exit MR Button
    const exitHover = this.hoveredAreaId === 'exit-mr';
    ctx.fillStyle = exitHover ? '#e11d48' : 'rgba(225, 29, 72, 0.9)';
    ctx.beginPath();
    ctx.roundRect(780, 25, 210, 54, 14);
    ctx.fill();
    ctx.strokeStyle = exitHover ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText('🚪 Exit MR / VR', 808, 59);

    // 3. Stats Grid (Distance, Elev Gain, Summit Elev, and Current Elev label)
    const distKm = (this.track.totalDistance / 1000).toFixed(1);
    const distMi = (this.track.totalDistance * 0.000621371).toFixed(1);
    const gainM = Math.round(this.track.elevationGain);
    const gainFt = Math.round(this.track.elevationGain * 3.28084);
    const peakM = Math.round(this.track.maxElevation);
    const peakFt = Math.round(this.track.maxElevation * 3.28084);

    const stats = [
      { label: 'DISTANCE', val: `${distMi} mi`, sub: `${distKm} km` },
      { label: 'ELEV GAIN', val: `+${gainFt.toLocaleString()} ft`, sub: `+${gainM.toLocaleString()} m` },
      { label: 'SUMMIT ELEV', val: `${peakFt.toLocaleString()} ft`, sub: `${peakM.toLocaleString()} m` },
      { label: 'CURRENT ELEV', val: null, sub: null },
    ];

    const colW = (w - 70) / 4;
    stats.forEach((s, idx) => {
      const colX = 35 + idx * colW;
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(s.label, colX + 10, 126);

      if (s.val) {
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 23px sans-serif';
        ctx.fillText(s.val, colX + 10, 154);
      }
      if (s.sub) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '13px sans-serif';
        ctx.fillText(s.sub, colX + 10, 176);
      }
    });

    // 4. Elevation Profile Chart Box
    const chartX = 35;
    const chartY = 195;
    const chartW = w - 70;
    const chartH = 190;

    const chartHover = this.hoveredAreaId === 'chart-scrub';
    ctx.fillStyle = chartHover ? 'rgba(30, 41, 59, 0.85)' : 'rgba(30, 41, 59, 0.6)';
    ctx.beginPath();
    ctx.roundRect(chartX, chartY, chartW, chartH, 14);
    ctx.fill();
    ctx.strokeStyle = chartHover ? 'rgba(56, 189, 248, 0.6)' : 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const samples = GPXParser.sampleElevationProfile(this.track.points, 140);
    if (samples.length > 1) {
      const minE = this.track.minElevation;
      const maxE = this.track.maxElevation;
      const spanE = Math.max(maxE - minE, 10);

      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const px = chartX + 18 + (i / (samples.length - 1)) * (chartW - 36);
        const normH = (s.elevation - minE) / spanE;
        const py = chartY + chartH - 24 - normH * (chartH - 48);

        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 3;
      ctx.stroke();

      const grad = ctx.createLinearGradient(0, chartY, 0, chartY + chartH);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.04)');
      ctx.fillStyle = grad;
      ctx.lineTo(chartX + chartW - 18, chartY + chartH - 24);
      ctx.lineTo(chartX + 18, chartY + chartH - 24);
      ctx.closePath();
      ctx.fill();

      // Waypoint Quick-Jump Controls & Markers
      const allWaypoints = this.track.waypoints.concat(this.track.landmarks);
      if (allWaypoints.length > 0) {
        const currentWp = this.selectedWaypoint || allWaypoints[0];
        const wpBarX = 55;
        const wpBarY = 204;
        const wpBarW = 396;
        const wpBarH = 30;

        const isWpHover = this.hoveredAreaId === 'btn-wp-curr';
        ctx.fillStyle = isWpHover ? 'rgba(56, 189, 248, 0.25)' : 'rgba(15, 23, 42, 0.75)';
        ctx.beginPath();
        ctx.roundRect(wpBarX, wpBarY, wpBarW, wpBarH, 8);
        ctx.fill();
        ctx.strokeStyle = isWpHover ? '#38bdf8' : 'rgba(56, 189, 248, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Prev Arrow
        const prevHover = this.hoveredAreaId === 'btn-wp-prev';
        ctx.fillStyle = prevHover ? '#ffffff' : '#38bdf8';
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('◀', wpBarX + 18, wpBarY + 20);

        // Next Arrow
        const nextHover = this.hoveredAreaId === 'btn-wp-next';
        ctx.fillStyle = nextHover ? '#ffffff' : '#38bdf8';
        ctx.fillText('▶', wpBarX + wpBarW - 18, wpBarY + 20);

        // Center Waypoint Details
        const wpIcon = currentWp.type === 'summit' ? '⛰️' : currentWp.type === 'start' ? '🟢' : currentWp.type === 'finish' ? '🏁' : '📍';
        const eleStr = currentWp.ele !== undefined ? `${Math.round(currentWp.ele * 3.28084).toLocaleString()} ft` : '';
        let wpTitle = `${wpIcon} ${currentWp.name} ${eleStr ? `(${eleStr})` : ''} • Jump`;
        if (wpTitle.length > 34) wpTitle = wpTitle.substring(0, 32) + '...';
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(wpTitle, wpBarX + wpBarW / 2, wpBarY + 20);
        ctx.textAlign = 'left';

        // Render Waypoint Markers on Elevation Profile Curve
        for (const wp of allWaypoints) {
          let closestDist = 0;
          let minSq = Infinity;
          for (const pt of this.track.points) {
            const dSq = (pt.lat - wp.lat) ** 2 + (pt.lon - wp.lon) ** 2;
            if (dSq < minSq) {
              minSq = dSq;
              closestDist = pt.distanceFromStart;
            }
          }
          const wpProgress = this.track.totalDistance > 0 ? closestDist / this.track.totalDistance : 0;
          const wpX = chartX + 18 + wpProgress * (chartW - 36);
          const wpNorm = ((wp.ele ?? this.track.minElevation) - minE) / spanE;
          const wpY = chartY + chartH - 24 - Math.max(0, Math.min(1, wpNorm)) * (chartH - 48);

          const isSelected = this.selectedWaypoint?.name === wp.name;
          const col = wp.type === 'summit' ? '#f59e0b' : wp.type === 'start' ? '#10b981' : '#38bdf8';

          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(wpX, wpY, isSelected ? 8 : 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = isSelected ? 2.5 : 1.2;
          ctx.stroke();

          if (isSelected) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(wp.name, wpX, wpY - 12);
            ctx.textAlign = 'left';
          }
        }
      }
    }

    // 5. Row 1: Flyover Controls & Speeds (y = 410)
    const playHover = this.hoveredAreaId === 'btn-play';
    ctx.fillStyle = this.isPlaying
      ? playHover ? '#0284c7' : '#0369a1'
      : playHover ? '#059669' : '#047857';
    ctx.beginPath();
    ctx.roundRect(35, 410, 180, 58, 12);
    ctx.fill();
    ctx.strokeStyle = playHover ? '#ffffff' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText(this.isPlaying ? '⏸ Pause' : '▶ Play Flyover', 50, 447);

    // Step -10s
    const stepBackHover = this.hoveredAreaId === 'btn-step-back';
    ctx.fillStyle = stepBackHover ? '#475569' : '#334155';
    ctx.beginPath();
    ctx.roundRect(225, 410, 95, 58, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('⏪ -10s', 242, 446);

    // Step +10s
    const stepFwdHover = this.hoveredAreaId === 'btn-step-fwd';
    ctx.fillStyle = stepFwdHover ? '#475569' : '#334155';
    ctx.beginPath();
    ctx.roundRect(330, 410, 95, 58, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('+10s ⏩', 345, 446);

    // Speeds: 1x, 5x, 20x, 60x
    const speeds = [1.0, 5.0, 20.0, 60.0];
    const speedXs = [445, 535, 625, 715];
    speeds.forEach((spd, idx) => {
      const sx = speedXs[idx];
      const isSelected = Math.abs(this.currentSpeed - spd) < 0.1;
      const hover = this.hoveredAreaId === `spd-${spd}`;

      ctx.fillStyle = isSelected
        ? '#0284c7'
        : hover ? 'rgba(51, 65, 85, 0.9)' : 'rgba(30, 41, 59, 0.8)';
      ctx.beginPath();
      ctx.roundRect(sx, 410, 80, 58, 12);
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#38bdf8' : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      ctx.fillStyle = isSelected ? '#ffffff' : '#cbd5e1';
      ctx.font = isSelected ? 'bold 17px sans-serif' : '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${spd}x`, sx + 40, 446);
      ctx.textAlign = 'left';
    });

    // Reset Button
    const resetHover = this.hoveredAreaId === 'btn-reset';
    ctx.fillStyle = resetHover ? '#475569' : '#334155';
    ctx.beginPath();
    ctx.roundRect(810, 410, 180, 58, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('⏮ Trailhead', 840, 446);

    // 6. Row 2: View Modes, Focus, Map Style, Trail Colors & Vertical Exaggeration (y = 485)
    // View Mode
    const viewHover = this.hoveredAreaId === 'btn-view';
    ctx.fillStyle = this.currentViewMode === 'diorama'
      ? viewHover ? '#7c3aed' : '#6d28d9'
      : viewHover ? '#2563eb' : '#1d4ed8';
    ctx.beginPath();
    ctx.roundRect(35, 485, 180, 58, 12);
    ctx.fill();
    ctx.strokeStyle = viewHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.currentViewMode === 'diorama' ? '🚶 1:1 Trail' : '🏔 Diorama', 35 + 90, 521);

    // Focus
    const focusHover = this.hoveredAreaId === 'btn-focus';
    ctx.fillStyle = focusHover ? '#0284c7' : '#0f766e';
    ctx.beginPath();
    ctx.roundRect(225, 485, 180, 58, 12);
    ctx.fill();
    ctx.strokeStyle = focusHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('🎯 Center Hiker', 225 + 90, 521);

    // Map Style
    const texHover = this.hoveredAreaId === 'btn-texture';
    ctx.fillStyle = texHover ? '#d97706' : '#b45309';
    ctx.beginPath();
    ctx.roundRect(415, 485, 190, 58, 12);
    ctx.fill();
    ctx.strokeStyle = texHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    const texLabel = this.currentTextureStyle === 'satellite'
      ? '🛰 Aerial View'
      : this.currentTextureStyle === 'hybrid'
      ? '🏷 Hybrid'
      : '🗺 Topo Map';
    ctx.fillText(texLabel, 415 + 95, 521);

    // Trail Color
    const colHover = this.hoveredAreaId === 'btn-color';
    ctx.fillStyle = colHover ? '#059669' : '#047857';
    ctx.beginPath();
    ctx.roundRect(615, 485, 185, 58, 12);
    ctx.fill();
    ctx.strokeStyle = colHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    const colLabel = this.currentTrailColorMode === 'grade'
      ? '⛰ Steepness'
      : this.currentTrailColorMode === 'speed'
      ? '🏃 Pace'
      : '📈 Altitude';
    ctx.fillText(colLabel, 615 + 92, 521);

    // Vertical Exaggeration
    const exagHover = this.hoveredAreaId === 'btn-exaggeration';
    ctx.fillStyle = exagHover ? '#475569' : '#334155';
    ctx.beginPath();
    ctx.roundRect(810, 485, 180, 58, 12);
    ctx.fill();
    ctx.strokeStyle = exagHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`⛰ Vert: ${this.currentExaggeration.toFixed(1)}x`, 810 + 90, 521);
    ctx.textAlign = 'left';

    // 7. Footer
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('🖐️ Hands: 2-Hand Pinch to Zoom / Rotate / Move  •  1-Hand Pinch to Drag & Turn  •  Direct Poke HUD', 45, 575);
    ctx.fillText('🕹 Controllers: [L-Stick] Pan Mountain  •  [R-Stick] Rotate & Zoom  •  [Grip] Grab & Move  •  [A/X] 1:1 Mode', 45, 595);

    // 8. Status notification pill
    if (this.statusMessage) {
      const pillY = 614;
      const pillH = 38;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      ctx.beginPath();
      ctx.roundRect(35, pillY, w - 70, pillH, 10);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText(this.statusMessage, 55, pillY + 24);

      if (this.statusProgress > 0) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
        ctx.fillRect(45, pillY + 31, w - 90, 4);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(45, pillY + 31, Math.max(8, (w - 90) * this.statusProgress), 4);
      }
    }

    this.staticDirty = false;
  }

  private drawHUD(forceStatic = false): void {
    if (this.isDisposed || !this.ctx || !this.staticCtx) return;

    if (forceStatic || this.staticDirty) {
      this.drawStaticHUD();
    }

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.staticCanvas, 0, 0);

    // 1. Dynamic Current Elevation Stat (Column 3)
    const colW = (w - 70) / 4;
    const colX = 35 + 3 * colW;
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 23px sans-serif';
    ctx.fillText(`${Math.round(this.currentElevation * 3.28084).toLocaleString()} ft`, colX + 10, 154);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${Math.round(this.currentElevation)} m`, colX + 10, 176);

    // 2. Dynamic Scrubber & Tooltip on Elevation Profile
    const chartX = 35;
    const chartY = 195;
    const chartW = w - 70;
    const chartH = 190;

    const minE = this.track.minElevation;
    const maxE = this.track.maxElevation;
    const spanE = Math.max(maxE - minE, 10);

    const scrubX = chartX + 18 + this.currentProgress * (chartW - 36);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(scrubX, chartY + 10);
    ctx.lineTo(scrubX, chartY + chartH - 24);
    ctx.stroke();
    ctx.setLineDash([]);

    // Scrubber dot marker
    const currNorm = (this.currentElevation - minE) / spanE;
    const scrubY = chartY + chartH - 24 - Math.max(0, Math.min(1, currNorm)) * (chartH - 48);

    ctx.fillStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.beginPath();
    ctx.arc(scrubX, scrubY, 16, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(scrubX, scrubY, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(scrubX, scrubY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Tooltip
    const curDistMi = (this.track.totalDistance * this.currentProgress * 0.000621371).toFixed(1);
    const curEleFt = Math.round(this.currentElevation * 3.28084);
    const tipText = `${curEleFt.toLocaleString()} ft • ${curDistMi} mi`;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.beginPath();
    ctx.roundRect(scrubX - 70, scrubY - 36, 140, 26, 6);
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tipText, scrubX, scrubY - 18);
    ctx.textAlign = 'left';

    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.unsubscribeSession) {
      this.unsubscribeSession();
      this.unsubscribeSession = undefined;
    }
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    this.progressDrawScheduled = false;

    this.texture.dispose();
    if (this.canvas) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    if (this.staticCanvas) {
      this.staticCanvas.width = 1;
      this.staticCanvas.height = 1;
    }
    disposeObject3D(this.group);
  }
}
