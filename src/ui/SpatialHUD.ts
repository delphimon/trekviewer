import * as THREE from 'three';
import type { TrackStats, ViewMode, TextureStyle, TrailColorMode } from '../gpx/TrackTypes.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface SpatialHUDCallbacks {
  onTogglePlay: () => void;
  onToggleViewMode: () => void;
  onToggleTexture: () => void;
  onToggleTrailColor?: () => void;
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
  private texture: THREE.CanvasTexture;
  private track: TrackStats;
  private callbacks: SpatialHUDCallbacks;

  private currentProgress: number = 0;
  private currentElevation: number = 0;
  private isPlaying: boolean = false;
  private currentSpeed: number = 1.0;
  private currentViewMode: ViewMode = 'diorama';
  private currentTextureStyle: TextureStyle = 'satellite';
  private currentTrailColorMode: TrailColorMode = 'grade';
  private currentDockSide: 'left' | 'right' | 'center' = 'left';

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
    this.drawHUD();
  }

  public isHoveringDragHandle(): boolean {
    return this.hoveredAreaId === 'hud-drag';
  }

  private statusTimeout: number | null = null;

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
    this.drawHUD();

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
    this.drawHUD();
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
    this.drawHUD();
  }

  public setDockSide(side: 'left' | 'right' | 'center'): void {
    this.currentDockSide = side;
    this.drawHUD();
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
      // Speed 0.5x
      {
        id: 'spd-0.5',
        x: 445,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 0.5;
          this.callbacks.onSetSpeed(0.5);
          this.drawHUD();
        },
      },
      // Speed 1x
      {
        id: 'spd-1',
        x: 535,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 1.0;
          this.callbacks.onSetSpeed(1.0);
          this.drawHUD();
        },
      },
      // Speed 2x
      {
        id: 'spd-2',
        x: 625,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 2.0;
          this.callbacks.onSetSpeed(2.0);
          this.drawHUD();
        },
      },
      // Speed 5x
      {
        id: 'spd-5',
        x: 715,
        y: 410,
        w: 80,
        h: 58,
        action: () => {
          this.currentSpeed = 5.0;
          this.callbacks.onSetSpeed(5.0);
          this.drawHUD();
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

      // Row 2: View Modes, Focus, Map Style & Trail Colors (y = 485)
      // View Mode Toggle (Tabletop ⇄ 1:1 Trail)
      {
        id: 'btn-view',
        x: 35,
        y: 485,
        w: 225,
        h: 58,
        action: () => this.callbacks.onToggleViewMode(),
      },
      // Focus on Hiker
      {
        id: 'btn-focus',
        x: 275,
        y: 485,
        w: 225,
        h: 58,
        action: () => this.callbacks.onFocusHiker(),
      },
      // Map Style (Satellite ⇄ Hybrid ⇄ Topo)
      {
        id: 'btn-texture',
        x: 515,
        y: 485,
        w: 235,
        h: 58,
        action: () => this.callbacks.onToggleTexture(),
      },
      // Trail Color Mode (Grade ⇄ Speed ⇄ Elevation)
      {
        id: 'btn-color',
        x: 765,
        y: 485,
        w: 225,
        h: 58,
        action: () => this.callbacks.onToggleTrailColor?.(),
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
    trailColorMode?: TrailColorMode
  ): void {
    this.currentProgress = progress;
    this.currentElevation = currentEle;
    this.isPlaying = isPlaying;
    this.currentViewMode = viewMode;
    this.currentTextureStyle = textureStyle;
    if (speed !== undefined) this.currentSpeed = speed;
    if (trailColorMode !== undefined) this.currentTrailColorMode = trailColorMode;
    this.drawHUD();
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
      this.drawHUD();
    }
  }

  public onPointerLeave(): void {
    if (this.hoveredAreaId !== null) {
      this.hoveredAreaId = null;
      this.isDraggingScrubber = false;
      this.drawHUD();
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
        this.drawHUD();
        return true;
      }
    }

    // Click on elevation profile chart
    if (pt.x >= 35 && pt.x <= 989 && pt.y >= 190 && pt.y <= 395) {
      const chartWidth = 989 - 35 - 30;
      const progress = Math.min(Math.max((pt.x - 50) / chartWidth, 0), 1);
      this.isDraggingScrubber = true;
      this.callbacks.onScrub(progress);
      return true;
    }

    return false;
  }

  public onPointerDrag(uv: THREE.Vector2): void {
    const pt = this.uvToCanvas(uv);
    if (pt.y >= 170 && pt.y <= 405) {
      const chartWidth = 989 - 35 - 30;
      const progress = Math.min(Math.max((pt.x - 50) / chartWidth, 0), 1);
      this.callbacks.onScrub(progress);
    }
  }

  public onPointerRelease(): void {
    this.isDraggingScrubber = false;
  }

  private drawHUD(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

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
    if (title.length > 26) title = title.substring(0, 24) + '...';
    ctx.fillText(title, 40, 56);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '600 16px sans-serif';
    ctx.fillText('⛰️ Meta Quest 3 • 3D Trek Explorer', 40, 84);

    // Top Drag Handle Bar on HUD
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

    // Dock Button (Left / Center / Right)
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

    // 2. Exit MR Button (Top Right)
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

    // 3. Stats Grid
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
      {
        label: 'CURRENT ELEV',
        val: `${Math.round(this.currentElevation * 3.28084).toLocaleString()} ft`,
        sub: `${Math.round(this.currentElevation)} m`,
      },
    ];

    const colW = (w - 70) / 4;
    stats.forEach((s, idx) => {
      const colX = 35 + idx * colW;
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(s.label, colX + 10, 126);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 23px sans-serif';
      ctx.fillText(s.val, colX + 10, 154);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px sans-serif';
      ctx.fillText(s.sub, colX + 10, 176);
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
      const tipText = `${curEleFt.toLocaleString()} ft • ${curDistMi} mi${tipDetail}`;

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
    }

    // 5. Row 1: Flyover Transport & Speeds (y = 410)
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

    // Speeds: 0.5x, 1x, 2x, 5x
    const speeds = [0.5, 1.0, 2.0, 5.0];
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

    // 6. Row 2: View Modes, Focus, Map Style & Trail Colors (y = 485)
    // 1. View Mode Toggle
    const viewHover = this.hoveredAreaId === 'btn-view';
    ctx.fillStyle = this.currentViewMode === 'diorama'
      ? viewHover ? '#7c3aed' : '#6d28d9'
      : viewHover ? '#2563eb' : '#1d4ed8';
    ctx.beginPath();
    ctx.roundRect(35, 485, 225, 58, 12);
    ctx.fill();
    ctx.strokeStyle = viewHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.currentViewMode === 'diorama' ? '🚶 1:1 Trail' : '🏔 Diorama', 35 + 112, 521);

    // 2. Focus on Hiker
    const focusHover = this.hoveredAreaId === 'btn-focus';
    ctx.fillStyle = focusHover ? '#0284c7' : '#0f766e';
    ctx.beginPath();
    ctx.roundRect(275, 485, 225, 58, 12);
    ctx.fill();
    ctx.strokeStyle = focusHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText('🎯 Center Hiker', 275 + 112, 521);

    // 3. Map Style (Aerial ⇄ Hybrid ⇄ Topo)
    const texHover = this.hoveredAreaId === 'btn-texture';
    ctx.fillStyle = texHover ? '#d97706' : '#b45309';
    ctx.beginPath();
    ctx.roundRect(515, 485, 235, 58, 12);
    ctx.fill();
    ctx.strokeStyle = texHover ? '#ffffff' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    const texLabel = this.currentTextureStyle === 'satellite'
      ? '🛰 Aerial View'
      : this.currentTextureStyle === 'hybrid'
      ? '🏷 Hybrid (Labels)'
      : '🗺 Topo Map';
    ctx.fillText(texLabel, 515 + 117, 521);

    // 4. Trail Color Style (Grade ⇄ Speed ⇄ Elev)
    const colHover = this.hoveredAreaId === 'btn-color';
    ctx.fillStyle = colHover ? '#059669' : '#047857';
    ctx.beginPath();
    ctx.roundRect(765, 485, 225, 58, 12);
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
    ctx.fillText(colLabel, 765 + 112, 521);
    ctx.textAlign = 'left';

    // 7. Footer Controller & Hand Gestures Guide
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('🖐️ Hands: 2-Hand Pinch to Zoom / Rotate / Move  •  1-Hand Pinch to Drag & Turn  •  Direct Poke HUD', 45, 575);
    ctx.fillText('🕹 Controllers: [L-Stick] Pan Mountain  •  [R-Stick] Rotate & Zoom  •  [Grip] Grab & Move  •  [A/X] 1:1 Mode', 45, 595);

    // 8. Bottom Non-Intrusive Status & Progress Pill (never blocks header or controls)
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

    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    disposeObject3D(this.group);
    this.texture.dispose();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
