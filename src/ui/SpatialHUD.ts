import * as THREE from 'three';
import type { TrackStats, ViewMode, TextureStyle, TrailColorMode, ElevationProvenanceStats } from '../gpx/TrackTypes.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface SpatialHUDCallbacks {
  onTogglePlay: () => void;
  onToggleViewMode: () => void;
  onToggleTexture: () => void;
  onToggleTrailColor?: () => void;
  onSetVerticalExaggeration?: (factor: number) => void;
  onReset: () => void;
  onExitMR: () => void;
  onScrub: (progress: number) => void;
  onSetSpeed: (speed: number) => void;
  onStepSeconds: (seconds: number) => void;
  onFocusHiker: () => void;
  onDockHUD?: (side: 'left' | 'right' | 'center') => void;
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
  private texture: THREE.CanvasTexture;
  private track: TrackStats;
  private callbacks: SpatialHUDCallbacks;

  // Cached elevation profile for fast scrubbing without re-sampling
  private cachedElevationSamples: { elevation: number; distance: number }[] = [];

  // Dirty state tracking & throttled GPU uploads
  private staticDirty: boolean = true;
  private dynamicDirty: boolean = true;
  private lastTextureUploadTime: number = 0;
  // ~11.7 Hz (target 8-12 uploads/sec during active playback)
  private readonly UPLOAD_INTERVAL_MS: number = 85;
  private uploadCountInCurrentSecond: number = 0;
  private recentUploadsPerSecond: number = 0;
  private lastUploadRateCalcTime: number = 0;

  private currentProgress: number = 0;
  private currentElevation: number = 0;
  private elevationProvenance?: ElevationProvenanceStats;
  private isPlaying: boolean = false;
  private currentSpeed: number = 1.0;
  private currentViewMode: ViewMode = 'diorama';
  private currentTextureStyle: TextureStyle = 'satellite';
  private currentTrailColorMode: TrailColorMode = 'grade';
  private verticalExaggeration: number = 1.0;
  private currentDockSide: 'left' | 'right' | 'center' = 'left';
  private attribution: string = '';
  private terrainQuality: string = 'dem';

  private statusMessage: string | null = null;
  private statusProgress: number = 0;

  private hoveredAreaId: string | null = null;
  private interactiveAreas: InteractiveArea[] = [];
  private isDraggingScrubber: boolean = false;

  constructor(track: TrackStats, callbacks: SpatialHUDCallbacks) {
    this.track = track;
    this.callbacks = callbacks;
    this.group = new THREE.Group();
    this.group.name = 'SpatialHUDGroup';

    // Canvas resolution: 1024 x 680
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 680;
    this.ctx = this.canvas.getContext('2d')!;

    // Static offscreen canvas for invariant background, labels, and elevation curve
    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.width = 1024;
    this.staticCanvas.height = 680;
    this.staticCtx = this.staticCanvas.getContext('2d')!;

    // Cache elevation profile samples once upon construction
    this.cachedElevationSamples = GPXParser.sampleElevationProfile(track.points, 140);

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

    // 3D Physical Grab Handle above HUD panel for free room positioning
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

    // Initial state
    this.currentElevation = track.points[0]?.ele || track.minElevation;
    this.setupInteractiveAreas();
    this.drawHUD(true);
  }

  public isHoveringDragHandle(): boolean {
    return this.hoveredAreaId === 'hud-drag';
  }

  private statusTimeout: number | null = null;

  public showStatus(message: string, progress?: number): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    this.statusMessage = message;
    if (typeof progress === 'number') {
      this.statusProgress = Math.max(0, Math.min(1, progress));
    } else {
      const match = message.match(/\((\d+)%\)/);
      if (match) {
        this.statusProgress = parseInt(match[1], 10) / 100;
      } else {
        this.statusProgress = 0;
      }
    }
    this.drawHUD(true);

    // Automatically dismiss completed / active status messages after 2.5s
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
    this.drawHUD(true);
  }

  public setDockSide(side: 'left' | 'right' | 'center'): void {
    this.currentDockSide = side;
    this.drawHUD(true);
  }

  public setMetaInfo(attribution?: string, terrainQuality?: string, provenance?: ElevationProvenanceStats): void {
    let changed = false;
    if (attribution !== undefined && attribution !== this.attribution) {
      this.attribution = attribution;
      changed = true;
    }
    if (terrainQuality !== undefined && terrainQuality !== this.terrainQuality) {
      this.terrainQuality = terrainQuality;
      changed = true;
    }
    if (provenance !== undefined && provenance !== this.elevationProvenance) {
      this.elevationProvenance = provenance;
      changed = true;
    }
    if (changed) {
      this.staticDirty = true;
      this.drawHUD(true);
    }
  }

  public setVerticalExaggeration(factor: number): void {
    if (Math.abs(this.verticalExaggeration - factor) > 0.05) {
      this.verticalExaggeration = factor;
      this.drawHUD(true);
    }
  }

  private cycleVerticalExaggeration(): void {
    const factors = [1.0, 1.5, 2.0, 3.0];
    let nextIdx = 0;
    for (let i = 0; i < factors.length; i++) {
      if (Math.abs(this.verticalExaggeration - factors[i]) < 0.05) {
        nextIdx = (i + 1) % factors.length;
        break;
      }
    }
    const nextVal = factors[nextIdx];
    this.verticalExaggeration = nextVal;
    this.callbacks.onSetVerticalExaggeration?.(nextVal);
    this.drawHUD(true);
  }

  public getUploadRate(): number {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastUploadRateCalcTime >= 1000) {
      this.recentUploadsPerSecond = this.uploadCountInCurrentSecond;
      this.uploadCountInCurrentSecond = 0;
      this.lastUploadRateCalcTime = now;
    }
    return this.recentUploadsPerSecond;
  }

  private setupInteractiveAreas(): void {
    this.interactiveAreas = [
      // Drag handle on top of HUD canvas
      {
        id: 'hud-drag',
        x: 360,
        y: 8,
        w: 304,
        h: 36,
        action: () => {},
      },
      // Quick Dock side button (Left / Center / Right)
      {
        id: 'hud-dock',
        x: 650,
        y: 25,
        w: 115,
        h: 54,
        action: () => this.cycleDock(),
      },
      // Exit MR / VR button (top right)
      {
        id: 'exit-mr',
        x: 780,
        y: 25,
        w: 210,
        h: 54,
        action: () => this.callbacks.onExitMR(),
      },

      // Row 1: Flyover Transport & Speeds (y = 410)
      // Play / Pause button
      {
        id: 'btn-play',
        x: 35,
        y: 410,
        w: 180,
        h: 58,
        action: () => this.callbacks.onTogglePlay(),
      },
      // Step -10s
      {
        id: 'btn-step-back',
        x: 225,
        y: 410,
        w: 95,
        h: 58,
        action: () => this.callbacks.onStepSeconds(-10),
      },
      // Step +10s
      {
        id: 'btn-step-fwd',
        x: 330,
        y: 410,
        w: 95,
        h: 58,
        action: () => this.callbacks.onStepSeconds(10),
      },
      // Speed 1x
      {
        id: 'spd-1',
        x: 445,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 1.0;
          this.callbacks.onSetSpeed(1.0);
          this.drawHUD(true);
        },
      },
      // Speed 5x
      {
        id: 'spd-5',
        x: 535,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 5.0;
          this.callbacks.onSetSpeed(5.0);
          this.drawHUD(true);
        },
      },
      // Speed 20x
      {
        id: 'spd-20',
        x: 625,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 20.0;
          this.callbacks.onSetSpeed(20.0);
          this.drawHUD(true);
        },
      },
      // Speed 60x
      {
        id: 'spd-60',
        x: 715,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 60.0;
          this.callbacks.onSetSpeed(60.0);
          this.drawHUD(true);
        },
      },
      // Reset button
      {
        id: 'btn-reset',
        x: 810,
        y: 410,
        w: 180,
        h: 58,
        action: () => this.callbacks.onReset(),
      },

      // Row 2: View Modes, Focus, Map Style, Trail Colors, Vertical Exaggeration (y = 485)
      // View Mode Toggle (Tabletop ⇄ 1:1 Trail)
      {
        id: 'btn-view',
        x: 35,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onToggleViewMode(),
      },
      // Focus on Hiker
      {
        id: 'btn-focus',
        x: 225,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onFocusHiker(),
      },
      // Map Style (Satellite ⇄ Hybrid ⇄ Topo)
      {
        id: 'btn-texture',
        x: 415,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onToggleTexture(),
      },
      // Trail Color Mode (Grade ⇄ Speed ⇄ Elevation)
      {
        id: 'btn-color',
        x: 605,
        y: 485,
        w: 180,
        h: 58,
        action: () => this.callbacks.onToggleTrailColor?.(),
      },
      // Vertical Exaggeration (1.0x ⇄ 1.5x ⇄ 2.0x ⇄ 3.0x)
      {
        id: 'btn-exag',
        x: 795,
        y: 485,
        w: 195,
        h: 58,
        action: () => this.cycleVerticalExaggeration(),
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
    verticalExaggeration?: number
  ): void {
    const playStateChanged = this.isPlaying !== isPlaying;
    const viewModeChanged = this.currentViewMode !== viewMode;
    const textureChanged = this.currentTextureStyle !== textureStyle;
    const speedChanged = speed !== undefined && Math.abs(this.currentSpeed - speed) > 0.05;
    const trailColorChanged = trailColorMode !== undefined && this.currentTrailColorMode !== trailColorMode;
    const exagChanged = verticalExaggeration !== undefined && Math.abs(this.verticalExaggeration - verticalExaggeration) > 0.05;

    this.currentProgress = progress;
    this.currentElevation = currentEle;
    this.isPlaying = isPlaying;
    this.currentViewMode = viewMode;
    this.currentTextureStyle = textureStyle;
    if (speed !== undefined) this.currentSpeed = speed;
    if (trailColorMode !== undefined) this.currentTrailColorMode = trailColorMode;
    if (verticalExaggeration !== undefined) this.verticalExaggeration = verticalExaggeration;

    // Force immediate redraw if major state changed or playback stopped
    const force = playStateChanged || viewModeChanged || textureChanged || speedChanged || trailColorChanged || exagChanged || !isPlaying;
    this.drawHUD(force);
  }

  public update(): void {
    if (this.dynamicDirty) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - this.lastTextureUploadTime >= this.UPLOAD_INTERVAL_MS) {
        this.renderDynamicLayer();
        this.texture.needsUpdate = true;
        this.uploadCountInCurrentSecond++;
        this.lastTextureUploadTime = now;
        this.dynamicDirty = false;
      }
    }
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

    // Check chart hover
    if (!foundId && pt.x >= 35 && pt.x <= 989 && pt.y >= 195 && pt.y <= 385) {
      foundId = 'chart-scrub';
    }

    if (foundId !== this.hoveredAreaId) {
      this.hoveredAreaId = foundId;
      this.drawHUD(true);
    }
  }

  public onPointerLeave(): void {
    if (this.hoveredAreaId !== null) {
      this.hoveredAreaId = null;
      this.isDraggingScrubber = false;
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
        this.drawHUD(true);
        return true;
      }
    }

    // Click on elevation profile chart
    if (pt.x >= 35 && pt.x <= 989 && pt.y >= 190 && pt.y <= 395) {
      const chartWidth = 918; // 989 - 35 - 36
      const progress = Math.min(Math.max((pt.x - 53) / chartWidth, 0), 1);
      this.isDraggingScrubber = true;
      this.callbacks.onScrub(progress);
      this.drawHUD(true);
      return true;
    }

    return false;
  }

  public onPointerDrag(uv: THREE.Vector2): void {
    const pt = this.uvToCanvas(uv);
    if (pt.y >= 170 && pt.y <= 405) {
      const chartWidth = 918;
      const progress = Math.min(Math.max((pt.x - 53) / chartWidth, 0), 1);
      this.callbacks.onScrub(progress);
      this.drawHUD(true);
    }
  }

  public onPointerRelease(): void {
    this.isDraggingScrubber = false;
  }

  private drawHUD(force: boolean = false): void {
    if (this.staticDirty) {
      this.renderStaticLayer();
      this.staticDirty = false;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (force || now - this.lastTextureUploadTime >= this.UPLOAD_INTERVAL_MS) {
      this.renderDynamicLayer();
      this.texture.needsUpdate = true;
      this.uploadCountInCurrentSecond++;
      this.lastTextureUploadTime = now;
      this.dynamicDirty = false;
    } else {
      this.dynamicDirty = true;
    }
  }

  private renderStaticLayer(): void {
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

    // Unobtrusive Data Notes Pill if track has warnings
    if (this.track.warnings && this.track.warnings.length > 0) {
      const titleWidth = ctx.measureText(title).width;
      const pillX = 40 + titleWidth + 14;
      ctx.fillStyle = 'rgba(234, 179, 8, 0.15)';
      ctx.beginPath();
      ctx.roundRect(pillX, 34, 115, 26, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`⚠️ Data Notes`, pillX + 10, 51);
    }

    // Subtitle with Timing Type
    const isRecorded = this.track.timingType === 'recorded';
    const timeLabel = isRecorded ? 'GPS Timed' : 'Est. Pace';
    ctx.fillStyle = '#38bdf8';
    ctx.font = '600 15px sans-serif';
    ctx.fillText(`⛰️ Meta Quest 3 • 3D Trek Explorer • ${timeLabel}`, 40, 84);

    // Top Drag Handle Bar on HUD
    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.beginPath();
    ctx.roundRect(360, 8, 304, 30, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⠿ GRAB / DRAG TO MOVE HUD', 512, 28);
    ctx.textAlign = 'left';

    // 2. Static Stats Grid (Labels + Invariant values)
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
      { label: 'CURRENT ELEV', val: '', sub: '' }, // Dynamic value drawn in renderDynamicLayer
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

        ctx.fillStyle = '#94a3b8';
        ctx.font = '13px sans-serif';
        ctx.fillText(s.sub, colX + 10, 176);
      }
    });

    // 3. Static Elevation Profile Chart Box & Profile Curve
    const chartX = 35;
    const chartY = 195;
    const chartW = w - 70;
    const chartH = 190;

    ctx.fillStyle = 'rgba(30, 41, 59, 0.6)';
    ctx.beginPath();
    ctx.roundRect(chartX, chartY, chartW, chartH, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const samples = this.cachedElevationSamples;
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

      // Draw landmark markers directly on elevation curve (Requirement #117, #118)
      const allLandmarks = [...(this.track.waypoints || [])];
      for (const lm of this.track.landmarks || []) {
        if (lm.type === 'summit' || lm.type === 'start' || lm.type === 'finish' || lm.type === 'day_boundary') {
          if (!allLandmarks.some((w) => Math.hypot(w.lat - lm.lat, w.lon - lm.lon) < 0.0005)) {
            allLandmarks.push(lm);
          }
        }
      }

      for (const lm of allLandmarks) {
        let bestDistSq = Infinity;
        let bestDistFromStart = 0;
        let bestEle = lm.ele ?? minE;
        for (const p of this.track.points) {
          const dLat = p.lat - lm.lat;
          const dLon = (p.lon - lm.lon) * Math.cos((lm.lat * Math.PI) / 180);
          const d = dLat * dLat + dLon * dLon;
          if (d < bestDistSq) {
            bestDistSq = d;
            bestDistFromStart = p.distanceFromStart;
            bestEle = p.ele;
          }
        }

        const prog = this.track.totalDistance > 0 ? Math.min(1, Math.max(0, bestDistFromStart / this.track.totalDistance)) : 0;
        const lx = chartX + 18 + prog * (chartW - 36);
        const normH = (bestEle - minE) / spanE;
        const ly = chartY + chartH - 24 - normH * (chartH - 48);

        const pinColor = lm.type === 'summit'
          ? '#f59e0b'
          : lm.type === 'start'
          ? '#10b981'
          : lm.type === 'finish'
          ? '#ef4444'
          : lm.type === 'day_boundary'
          ? '#8b5cf6'
          : '#38bdf8';

        ctx.fillStyle = pinColor;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (lm.type === 'summit' || lm.type === 'start' || lm.type === 'finish') {
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          let shortName = lm.name;
          if (shortName.length > 10) shortName = shortName.substring(0, 9) + '…';
          ctx.fillText(shortName, lx, ly - 8);
          ctx.textAlign = 'left';
        }
      }
    }

    // 4. Footer Controller & Hand Gestures Guide
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('🖐️ Hands: 2-Hand Pinch to Zoom / Rotate / Move  •  1-Hand Pinch to Drag & Turn  •  Direct Poke HUD', 45, 565);
    ctx.fillText('🕹 Controllers: [L-Stick] Pan Mountain  •  [R-Stick] Rotate & Zoom  •  [Grip] Grab & Move  •  [A/X] 1:1 Mode', 45, 583);

    // Compact Attribution & Elevation quality badge
    const qualityLabel = this.terrainQuality === 'dem' ? 'DEM' : this.terrainQuality === 'partial-dem' ? 'partial DEM' : 'approximate';
    const provStr = this.elevationProvenance && (this.elevationProvenance.demPercent > 0 || this.elevationProvenance.interpolatedPercent > 0)
      ? ` (${this.elevationProvenance.gpxPercent}% GPX, ${this.elevationProvenance.demPercent}% DEM)`
      : '';
    const metaStr = `Elevation: ${qualityLabel}${provStr}${this.attribution ? ` • Imagery: ${this.attribution}` : ''}`;
    ctx.fillStyle = '#64748b';
    ctx.font = '12px sans-serif';
    ctx.fillText(metaStr, 45, 601);
  }

  private renderDynamicLayer(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // 1. Blit pre-rendered static layer
    ctx.drawImage(this.staticCanvas, 0, 0);

    // Top Drag Handle Hover effect
    if (this.hoveredAreaId === 'hud-drag') {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.beginPath();
      ctx.roundRect(360, 8, 304, 30, 10);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 2. Dock Button (Left / Center / Right)
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

    // 3. Exit MR Button (Top Right)
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

    // 4. Dynamic Stat 4: CURRENT ELEV
    const colW = (w - 70) / 4;
    const colX = 35 + 3 * colW;
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 23px sans-serif';
    ctx.fillText(`${Math.round(this.currentElevation * 3.28084).toLocaleString()} ft`, colX + 10, 154);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${Math.round(this.currentElevation)} m`, colX + 10, 176);

    // 5. Scrubber Line, Pin, and Tooltip
    const chartX = 35;
    const chartY = 195;
    const chartW = w - 70;
    const chartH = 190;
    const samples = this.cachedElevationSamples;

    if (samples.length > 1) {
      const minE = this.track.minElevation;
      const maxE = this.track.maxElevation;
      const spanE = Math.max(maxE - minE, 10);

      // Scrubber line
      const scrubX = chartX + 18 + this.currentProgress * (chartW - 36);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(scrubX, chartY + 10);
      ctx.lineTo(scrubX, chartY + chartH - 24);
      ctx.stroke();
      ctx.setLineDash([]);

      // Scrubber handle dot (Prominent multi-ring beacon marker)
      const currNorm = (this.currentElevation - minE) / spanE;
      const scrubY = chartY + chartH - 24 - currNorm * (chartH - 48);

      // Outer radiant cyan halo ring
      ctx.fillStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.beginPath();
      ctx.arc(scrubX, scrubY, 16, 0, Math.PI * 2);
      ctx.fill();

      // Inner glowing amber jewel
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(scrubX, scrubY, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Pure white center core pin
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(scrubX, scrubY, 4, 0, Math.PI * 2);
      ctx.fill();

      // Tooltip above handle
      const curDistMi = (this.track.totalDistance * this.currentProgress * 0.000621371).toFixed(1);
      const curEleFt = Math.round(this.currentElevation * 3.28084);
      const ptIdx = Math.min(
        Math.floor(this.currentProgress * (this.track.points.length - 1)),
        this.track.points.length - 1
      );
      const pt = this.track.points[ptIdx];
      let tipDetail = '';
      if (this.currentTrailColorMode === 'grade' && pt?.grade !== undefined) {
        tipDetail = ` • ${Math.round(Math.abs(pt.grade))}% slope`;
      } else if (this.currentTrailColorMode === 'speed') {
        const spdMph = pt?.speed ? (pt.speed * 2.23694).toFixed(1) : (this.track.avgSpeed * 0.621371).toFixed(1);
        tipDetail = ` • ${spdMph} mph`;
      }
      // Check if near landmark
      let nearLandmark = '';
      if (pt) {
        const allLm = (this.track.landmarks || []).concat(this.track.waypoints || []);
        for (const lm of allLm) {
          const d = Math.hypot(pt.lat - lm.lat, (pt.lon - lm.lon) * Math.cos((pt.lat * Math.PI) / 180)) * 111320;
          if (d < 150) {
            nearLandmark = `${lm.name} • `;
            break;
          }
        }
      }

      const tipText = `${nearLandmark}${curEleFt.toLocaleString()} ft • ${curDistMi} mi${tipDetail}`;
      const boxW = Math.max(140, tipText.length * 7.5 + 20);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.beginPath();
      ctx.roundRect(scrubX - boxW / 2, scrubY - 36, boxW, 26, 6);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tipText, scrubX, scrubY - 18);
      ctx.textAlign = 'left';
    }

    // 6. Row 1: Flyover Transport & Speeds (y = 410)
    // Play / Pause Button
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

    // Step -10s Button
    const stepBackHover = this.hoveredAreaId === 'btn-step-back';
    ctx.fillStyle = stepBackHover ? '#475569' : '#334155';
    ctx.beginPath();
    ctx.roundRect(225, 410, 95, 58, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('⏪ -10s', 242, 446);

    // Step +10s Button
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
      const isSelected = Math.abs(this.currentSpeed - spd) < 0.05;
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

    // 7. Row 2: View Modes, Focus, Map Style, Trail Colors, Vertical Exaggeration (y = 485)
    // 1. View Mode Toggle (x: 35, w: 180)
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

    // 2. Focus on Hiker (x: 225, w: 180)
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

    // 3. Map Style (Aerial ⇄ Hybrid ⇄ Topo) (x: 415, w: 180)
    const texHover = this.hoveredAreaId === 'btn-texture';
    ctx.fillStyle = texHover ? '#d97706' : '#b45309';
    ctx.beginPath();
    ctx.roundRect(415, 485, 180, 58, 12);
    ctx.fill();
    ctx.strokeStyle = texHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    const texLabel = this.currentTextureStyle === 'satellite'
      ? '🛰 Aerial View'
      : this.currentTextureStyle === 'hybrid'
      ? '🏷 Hybrid'
      : '🗺 Topo Map';
    ctx.fillText(texLabel, 415 + 90, 521);

    // 4. Trail Color Style (Grade ⇄ Speed ⇄ Elev) (x: 605, w: 180)
    const colHover = this.hoveredAreaId === 'btn-color';
    ctx.fillStyle = colHover ? '#059669' : '#047857';
    ctx.beginPath();
    ctx.roundRect(605, 485, 180, 58, 12);
    ctx.fill();
    ctx.strokeStyle = colHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    const colLabel = this.currentTrailColorMode === 'grade'
      ? '⛰ Steepness'
      : this.currentTrailColorMode === 'speed'
      ? '🏃 Pace / Speed'
      : '📈 Altitude';
    ctx.fillText(colLabel, 605 + 90, 521);

    // 5. Vertical Exaggeration (x: 795, w: 195)
    const exagHover = this.hoveredAreaId === 'btn-exag';
    ctx.fillStyle = exagHover ? '#4f46e5' : '#3730a3';
    ctx.beginPath();
    ctx.roundRect(795, 485, 195, 58, 12);
    ctx.fill();
    ctx.strokeStyle = exagHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`⛰️ ${this.verticalExaggeration.toFixed(1)}x Exag`, 795 + 97, 521);
    ctx.textAlign = 'left';

    // 8. Bottom Non-Intrusive Status & Progress Pill (never blocks header or controls)
    if (this.statusMessage) {
      const pillY = 620;
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
  }

  public dispose(): void {
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    disposeObject3D(this.group);
    this.texture.dispose();
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.staticCanvas.width = 1;
    this.staticCanvas.height = 1;
  }
}
