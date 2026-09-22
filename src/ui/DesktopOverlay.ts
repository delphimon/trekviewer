import type { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode, GPXWaypoint } from '../gpx/TrackTypes.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import type { TrekSession, TerrainQuality } from '../core/TrekSession.ts';

export interface OverlayCallbacks {
  onSelectRoute: (item: RouteManifestItem) => void;
  onUploadGPX: (content: string, fileName: string) => void;
  onEnterXR: (mode: 'immersive-vr' | 'immersive-ar') => void;
  onToggleViewMode: (mode: ViewMode) => void;
  onTogglePlay: () => void;
  onSetSpeed: (speed: number) => void;
  onScrub: (progress: number) => void;
  onSetTextureStyle: (style: TextureStyle) => void;
  onSetTrailColorMode: (mode: TrailColorMode) => void;
  onSetVerticalExaggeration?: (factor: number) => void;
  onSelectWaypoint?: (wp: GPXWaypoint) => void;
}

export class DesktopOverlay {
  private container: HTMLElement;
  private callbacks: OverlayCallbacks;
  private session?: TrekSession;
  private unsubscribeSession?: () => void;

  private manifest: RouteManifestItem[] = [];
  private currentTrack: TrackStats | null = null;
  private isPlaying: boolean = false;
  private currentProgress: number = 0;
  private viewMode: ViewMode = 'diorama';
  private textureStyle: TextureStyle = 'satellite';
  private trailColorMode: TrailColorMode = 'grade';
  private verticalExaggeration: number = 1.0;
  private terrainQuality: TerrainQuality = 'dem';

  // DOM elements
  private statsTitle!: HTMLElement;
  private statsSubtitle!: HTMLElement;
  private statsGrid!: HTMLElement;
  private playBtn!: HTMLElement;
  private scrubberInput!: HTMLInputElement;
  private scrubberFill!: HTMLElement;
  private scrubberCurEle!: HTMLElement;
  private scrubberCurDist!: HTMLElement;
  private canvasChart!: HTMLCanvasElement;
  private statusBanner!: HTMLElement;
  private waypointSelect!: HTMLSelectElement;
  private qualityBadge!: HTMLElement;
  private attributionFooter!: HTMLElement;

  private cachedChartCanvas: HTMLCanvasElement | null = null;

  constructor(container: HTMLElement, callbacks: OverlayCallbacks, session?: TrekSession) {
    this.container = container;
    this.callbacks = callbacks;
    this.session = session;
    this.createDOM();
    this.setupEventListeners();
    this.checkXRSupport();

    if (this.session) {
      const s = this.session.getState();
      this.syncFromState(s);
      this.unsubscribeSession = this.session.subscribe((newState) => {
        this.syncFromState(newState);
      });
    }
  }

  private checkXRSupport(): void {
    if (typeof navigator !== 'undefined' && 'xr' in navigator && (navigator as any).xr?.isSessionSupported) {
      (navigator as any).xr.isSessionSupported('immersive-vr').then((supported: boolean) => {
        const btnVR = document.getElementById('btnEnterVR');
        if (btnVR && !supported) {
          btnVR.setAttribute('title', 'WebXR Immersive VR not supported on this device/browser');
          btnVR.classList.add('btn-disabled');
        }
      }).catch(() => {});

      (navigator as any).xr.isSessionSupported('immersive-ar').then((supported: boolean) => {
        const btnAR = document.getElementById('btnEnterAR');
        if (btnAR && !supported) {
          btnAR.setAttribute('title', 'WebXR Passthrough MR not supported on this device/browser');
          btnAR.classList.add('btn-disabled');
        }
      }).catch(() => {});
    }
  }

  private syncFromState(s: any): void {
    this.isPlaying = s.isPlaying;
    this.setPlaying(s.isPlaying);
    this.setTextureStyle(s.textureStyle);
    this.setTrailColorMode(s.trailColorMode);
    this.setVerticalExaggeration(s.verticalExaggeration);
    this.setTerrainQuality(s.terrainQuality);
    if (s.attribution) {
      this.setAttribution(s.attribution);
    }

    if (s.track && s.track !== this.currentTrack) {
      this.updateTrack(s.track);
    }

    if (s.progress !== undefined && s.currentElevation !== undefined) {
      this.updateScrubber(s.progress, s.currentElevation);
    }

    if (s.activeRouteId) {
      const select = document.getElementById('routeSelect') as HTMLSelectElement;
      if (select && select.value !== s.activeRouteId) {
        select.value = s.activeRouteId;
      }
    }

    if (s.viewMode && s.viewMode !== this.viewMode) {
      this.viewMode = s.viewMode;
      const viewBtn = document.getElementById('btnViewToggle');
      if (viewBtn) {
        viewBtn.innerHTML = s.viewMode === 'diorama' ? '🚶 Walk Trail (1:1)' : '🏔 Tabletop Diorama';
      }
    }

    if (s.playbackSpeed !== undefined) {
      document.querySelectorAll('.speed-btn').forEach((btn) => {
        const spd = parseFloat(btn.getAttribute('data-speed') || '20');
        btn.classList.toggle('btn-active', Math.abs(spd - s.playbackSpeed) < 0.1);
      });
    }

    if (s.loadingMessage) {
      this.showStatus(s.loadingMessage, s.isError);
    }
  }

  public setManifest(manifest: RouteManifestItem[]): void {
    this.manifest = manifest;
    const select = document.getElementById('routeSelect') as HTMLSelectElement;
    if (select) {
      select.innerHTML = '';
      manifest.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.region})`;
        select.appendChild(opt);
      });
    }
  }

  private statusTimeout: number | null = null;

  public showStatus(message: string, isError: boolean = false): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    const textEl = document.getElementById('statusText') || this.statusBanner;
    textEl.textContent = message;
    this.statusBanner.style.display = 'flex';

    if (isError) {
      this.statusBanner.classList.add('status-error');
    } else {
      this.statusBanner.classList.remove('status-error');
    }

    const match = message.match(/\((\d+)%\)/);
    const fillEl = document.getElementById('statusProgressFill');
    const barEl = document.getElementById('statusProgressBar');
    if (fillEl && barEl) {
      if (match) {
        barEl.style.display = 'block';
        fillEl.style.width = `${match[1]}%`;
      } else if (message.includes('Downloading') || message.includes('Building')) {
        barEl.style.display = 'block';
      } else {
        barEl.style.display = 'none';
      }
    }

    if (!isError && (message.includes('Loaded:') || message.includes('active') || message.includes('ready'))) {
      this.statusTimeout = window.setTimeout(() => {
        this.statusBanner.style.display = 'none';
      }, 3500);
    }
  }

  public updateTrack(track: TrackStats): void {
    this.currentTrack = track;
    this.statsTitle.textContent = track.name;
    this.statsSubtitle.textContent = `High Point: ${Math.round(track.maxElevation)} m (${Math.round(track.maxElevation * 3.28084)} ft) • Total Vert: +${Math.round(track.elevationGain)} m`;

    const distKm = (track.totalDistance / 1000).toFixed(1);
    const distMi = (track.totalDistance * 0.000621371).toFixed(1);
    const gainM = Math.round(track.elevationGain);
    const gainFt = Math.round(track.elevationGain * 3.28084);
    const lossM = Math.round(track.elevationLoss);

    let timeStr = '--';
    if (track.movingTime > 0) {
      const hrs = Math.floor(track.movingTime / 3600);
      const mins = Math.floor((track.movingTime % 3600) / 60);
      timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    }

    this.statsGrid.innerHTML = `
      <div class="stat-item">
        <span class="stat-label">DISTANCE</span>
        <span class="stat-value">${distMi} <small>mi</small></span>
        <span class="stat-sub">${distKm} km</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">ELEV GAIN</span>
        <span class="stat-value">+${gainFt.toLocaleString()} <small>ft</small></span>
        <span class="stat-sub">+${gainM.toLocaleString()} m</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">DESCENT</span>
        <span class="stat-value">-${Math.round(lossM * 3.28084).toLocaleString()} <small>ft</small></span>
        <span class="stat-sub">-${lossM.toLocaleString()} m</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">EST. TIME</span>
        <span class="stat-value">${timeStr}</span>
        <span class="stat-sub">Moving Time</span>
      </div>
    `;

    // Populate Waypoints & Derived Landmarks selector
    const allWaypoints = track.waypoints.concat(track.landmarks);
    if (this.waypointSelect) {
      this.waypointSelect.innerHTML = '<option value="">📍 Jump to Waypoint / Summit...</option>';
      for (let i = 0; i < allWaypoints.length; i++) {
        const wp = allWaypoints[i];
        const opt = document.createElement('option');
        opt.value = i.toString();
        opt.textContent = `${wp.name} (${Math.round(wp.ele ?? 0)}m)`;
        this.waypointSelect.appendChild(opt);
      }
    }

    this.renderCachedElevationChart(track);
    this.drawElevationChart();
    this.updateScrubber(0, track.points[0]?.ele || track.minElevation);
  }

  public updateScrubber(progress: number, currentElevation: number): void {
    this.currentProgress = progress;
    this.scrubberInput.value = (progress * 100).toString();
    this.scrubberFill.style.width = `${progress * 100}%`;

    const eleM = Math.round(currentElevation);
    const eleFt = Math.round(currentElevation * 3.28084);
    this.scrubberCurEle.textContent = `${eleFt.toLocaleString()} ft (${eleM} m)`;

    if (this.currentTrack) {
      const curDistMi = (this.currentTrack.totalDistance * progress * 0.000621371).toFixed(1);
      this.scrubberCurDist.textContent = `${curDistMi} mi`;
    }

    this.drawElevationChart();
  }

  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    this.playBtn.innerHTML = playing ? '⏸ Pause' : '▶ Play';
  }

  public setTerrainQuality(quality: TerrainQuality): void {
    this.terrainQuality = quality;
    if (this.qualityBadge) {
      if (quality === 'dem') {
        this.qualityBadge.textContent = 'Terrain: Real DEM';
        this.qualityBadge.className = 'badge badge-success';
      } else if (quality === 'partial-dem') {
        this.qualityBadge.textContent = 'Terrain: Partial DEM';
        this.qualityBadge.className = 'badge badge-warning';
      } else {
        this.qualityBadge.textContent = 'Terrain: Synthetic Fallback';
        this.qualityBadge.className = 'badge badge-neutral';
      }
    }
  }

  public setVerticalExaggeration(factor: number): void {
    this.verticalExaggeration = factor;
    document.querySelectorAll('.exag-btn').forEach((btn) => {
      const f = parseFloat(btn.getAttribute('data-exag') || '1');
      btn.classList.toggle('btn-active', Math.abs(f - factor) < 0.1);
    });
  }

  public setAttribution(text: string): void {
    const textEl = document.getElementById('attributionText');
    if (textEl) {
      textEl.textContent = text;
    }
  }

  private renderCachedElevationChart(track: TrackStats): void {
    if (!this.cachedChartCanvas && typeof document !== 'undefined') {
      this.cachedChartCanvas = document.createElement('canvas');
      this.cachedChartCanvas.width = this.canvasChart.width;
      this.cachedChartCanvas.height = this.canvasChart.height;
    }
    if (!this.cachedChartCanvas) return;
    const canvas = this.cachedChartCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const samples = GPXParser.sampleElevationProfile(track.points, 180);
    if (samples.length < 2) return;

    const minE = track.minElevation;
    const maxE = track.maxElevation;
    const spanE = Math.max(maxE - minE, 10);

    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const px = (i / (samples.length - 1)) * w;
      const py = h - 6 - ((s.elevation - minE) / spanE) * (h - 16);

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.05)');
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  private drawElevationChart(): void {
    if (!this.currentTrack) return;
    const canvas = this.canvasChart;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (this.cachedChartCanvas) {
      ctx.drawImage(this.cachedChartCanvas, 0, 0);
    }

    const scrubX = this.currentProgress * w;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scrubX, 0);
    ctx.lineTo(scrubX, h);
    ctx.stroke();
  }

  private createDOM(): void {
    this.container.innerHTML = `
      <div class="app-ui">
        <header class="top-bar">
          <div class="logo-group">
            <span class="logo-icon">⛰️</span>
            <div>
              <h1 class="logo-title">TrekViewer 3D</h1>
              <span class="logo-subtitle">Meta Quest 3 Alpine Visualizer</span>
            </div>
          </div>

          <div class="route-select-wrapper">
            <label for="routeSelect">Select Trek:</label>
            <select id="routeSelect" class="styled-select"></select>
            <label for="gpxUploadInput" class="btn btn-secondary upload-btn">
              📂 Import GPX
            </label>
            <input type="file" id="gpxUploadInput" accept=".gpx" style="display:none;" />
          </div>

          <div class="xr-buttons">
            <button id="btnEnterVR" class="btn btn-primary xr-btn">
              🥽 Enter VR
            </button>
            <button id="btnEnterAR" class="btn btn-accent xr-btn">
              👓 Passthrough (MR)
            </button>
          </div>
        </header>

        <div id="statusBanner" class="status-banner glass-card" style="display:none;">
          <div class="status-content">
            <span class="status-spinner"></span>
            <span id="statusText">Loading trek...</span>
          </div>
          <div id="statusProgressBar" class="status-progress-bar" style="display:none;">
            <div id="statusProgressFill" class="status-progress-fill"></div>
          </div>
        </div>

        <aside class="stats-panel glass-card">
          <div class="panel-header">
            <h2 id="statsTitle" class="trek-title">Loading Route...</h2>
            <div id="qualityBadge" class="badge badge-success">Terrain: Real DEM</div>
          </div>
          <p id="statsSubtitle" class="trek-meta">Cascades Mountaineering</p>
          <div id="statsGrid" class="stats-grid"></div>

          <!-- Waypoint Quick Jump -->
          <div class="controls-section">
            <h3>Waypoints & Landmarks</h3>
            <select id="waypointSelect" class="styled-select" style="width: 100%; margin-top: 4px;"></select>
          </div>

          <div class="controls-section">
            <h3>Visual Style</h3>
            <div class="btn-group">
              <button id="btnSatTex" class="btn btn-sm btn-active">🛰️ Aerial</button>
              <button id="btnHybridTex" class="btn btn-sm">🏷️ Hybrid</button>
              <button id="btnTopoTex" class="btn btn-sm">🗺️ Topo</button>
            </div>

            <h3>Trail Colors</h3>
            <div class="btn-group">
              <button id="btnColorGrade" class="btn btn-sm btn-active">⛰️ Steepness</button>
              <button id="btnColorSpeed" class="btn btn-sm">🏃 Pace</button>
              <button id="btnColorEle" class="btn btn-sm">📈 Altitude</button>
            </div>

            <h3>Vertical Exaggeration (Diorama)</h3>
            <div class="btn-group">
              <button class="btn btn-sm exag-btn btn-active" data-exag="1.0">1.0x (True)</button>
              <button class="btn btn-sm exag-btn" data-exag="1.5">1.5x</button>
              <button class="btn btn-sm exag-btn" data-exag="2.0">2.0x</button>
            </div>
          </div>

          <div class="controller-help">
            <h3>🎮 Quest 3 Controls</h3>
            <ul>
              <li><strong>🖐️ Bare Hands:</strong> 2-Hand Pinch to Zoom/Rotate/Move, 1-Hand Pinch to Drag & Turn, Direct Poke HUD</li>
              <li><strong>Grip:</strong> Grab & reposition 3D diorama in your room</li>
              <li><strong>Right Stick:</strong> Rotate & exponential zoom</li>
              <li><strong>Left Stick:</strong> Walk along trail (1:1) / pan table</li>
              <li><strong>A / X Button:</strong> Toggle Tabletop MR ⇄ 1:1 Trail</li>
            </ul>
          </div>

          <div class="privacy-note">
            <small>🔒 <em>Imported GPX files stay in your browser. Map and elevation tile requests are sent to external map providers for the area being viewed.</em></small>
          </div>

          <div id="attributionFooter" class="attribution-note">
            <small id="attributionText">Map data: Esri, USGS, AWS Open Data</small>
          </div>
        </aside>

        <footer class="player-bar glass-card">
          <div class="player-left">
            <button id="btnPlay" class="btn btn-primary play-btn">▶ Play</button>
            <div class="speed-selector">
              <button class="btn btn-xs speed-btn" data-speed="1">1x</button>
              <button class="btn btn-xs speed-btn" data-speed="5">5x</button>
              <button class="btn btn-xs speed-btn btn-active" data-speed="20">20x</button>
              <button class="btn btn-xs speed-btn" data-speed="60">60x</button>
            </div>
            <button id="btnViewToggle" class="btn btn-secondary view-toggle-btn">
              🚶 Walk Trail (1:1)
            </button>
          </div>

          <div class="player-center">
            <div class="chart-container">
              <canvas id="canvasChart" width="800" height="70"></canvas>
            </div>
            <div class="scrubber-wrapper">
              <div id="scrubberFill" class="scrubber-fill"></div>
              <input type="range" id="scrubberInput" min="0" max="100" value="0" step="0.1" />
            </div>
          </div>

          <div class="player-right">
            <div class="current-stat">
              <span class="c-label">ALTITUDE</span>
              <span id="scrubberCurEle" class="c-val">-- ft</span>
            </div>
            <div class="current-stat">
              <span class="c-label">PROGRESS</span>
              <span id="scrubberCurDist" class="c-val">-- mi</span>
            </div>
          </div>
        </footer>
      </div>
    `;

    this.statsTitle = document.getElementById('statsTitle')!;
    this.statsSubtitle = document.getElementById('statsSubtitle')!;
    this.statsGrid = document.getElementById('statsGrid')!;
    this.playBtn = document.getElementById('btnPlay')!;
    this.scrubberInput = document.getElementById('scrubberInput') as HTMLInputElement;
    this.scrubberFill = document.getElementById('scrubberFill')!;
    this.scrubberCurEle = document.getElementById('scrubberCurEle')!;
    this.scrubberCurDist = document.getElementById('scrubberCurDist')!;
    this.canvasChart = document.getElementById('canvasChart') as HTMLCanvasElement;
    this.statusBanner = document.getElementById('statusBanner')!;
    this.waypointSelect = document.getElementById('waypointSelect') as HTMLSelectElement;
    this.qualityBadge = document.getElementById('qualityBadge')!;
    this.attributionFooter = document.getElementById('attributionFooter')!;
  }

  private setupEventListeners(): void {
    const select = document.getElementById('routeSelect') as HTMLSelectElement;
    select.addEventListener('change', () => {
      const selected = this.manifest.find((m) => m.id === select.value);
      if (selected) this.callbacks.onSelectRoute(selected);
    });

    const fileInput = document.getElementById('gpxUploadInput') as HTMLInputElement;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target?.result as string;
          if (content) {
            this.callbacks.onUploadGPX(content, file.name);
          }
        };
        reader.readAsText(file);
      }
    });

    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.gpx')) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target?.result as string;
          if (content) {
            this.callbacks.onUploadGPX(content, file.name);
          }
        };
        reader.readAsText(file);
      }
    });

    document.getElementById('btnEnterVR')?.addEventListener('click', () => {
      this.callbacks.onEnterXR('immersive-vr');
    });
    document.getElementById('btnEnterAR')?.addEventListener('click', () => {
      this.callbacks.onEnterXR('immersive-ar');
    });

    this.playBtn.addEventListener('click', () => {
      this.callbacks.onTogglePlay();
    });

    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('btn-active'));
        btn.classList.add('btn-active');
        const spd = parseFloat(btn.getAttribute('data-speed') || '20');
        this.callbacks.onSetSpeed(spd);
      });
    });

    document.querySelectorAll('.exag-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const factor = parseFloat(btn.getAttribute('data-exag') || '1.0');
        this.setVerticalExaggeration(factor);
        this.callbacks.onSetVerticalExaggeration?.(factor);
      });
    });

    this.waypointSelect.addEventListener('change', () => {
      const idx = parseInt(this.waypointSelect.value, 10);
      if (!isNaN(idx) && this.currentTrack) {
        const allWp = this.currentTrack.waypoints.concat(this.currentTrack.landmarks);
        const wp = allWp[idx];
        if (wp) {
          this.callbacks.onSelectWaypoint?.(wp);
        }
      }
    });

    this.scrubberInput.addEventListener('input', () => {
      const progress = parseFloat(this.scrubberInput.value) / 100;
      this.callbacks.onScrub(progress);
    });

    const viewBtn = document.getElementById('btnViewToggle')!;
    viewBtn.addEventListener('click', () => {
      this.viewMode = this.viewMode === 'diorama' ? 'first-person' : 'diorama';
      viewBtn.innerHTML = this.viewMode === 'diorama' ? '🚶 Walk Trail (1:1)' : '🏔 Tabletop Diorama';
      this.callbacks.onToggleViewMode(this.viewMode);
    });

    const btnSat = document.getElementById('btnSatTex')!;
    const btnHybrid = document.getElementById('btnHybridTex')!;
    const btnTopo = document.getElementById('btnTopoTex')!;
    const clearTexActive = () => {
      btnSat.classList.remove('btn-active');
      btnHybrid.classList.remove('btn-active');
      btnTopo.classList.remove('btn-active');
    };

    btnSat.addEventListener('click', () => {
      clearTexActive();
      btnSat.classList.add('btn-active');
      this.callbacks.onSetTextureStyle('satellite');
    });
    btnHybrid.addEventListener('click', () => {
      clearTexActive();
      btnHybrid.classList.add('btn-active');
      this.callbacks.onSetTextureStyle('hybrid');
    });
    btnTopo.addEventListener('click', () => {
      clearTexActive();
      btnTopo.classList.add('btn-active');
      this.callbacks.onSetTextureStyle('topo');
    });

    const btnColGrade = document.getElementById('btnColorGrade')!;
    const btnColSpd = document.getElementById('btnColorSpeed')!;
    const btnColEle = document.getElementById('btnColorEle')!;
    const clearColActive = () => {
      btnColGrade.classList.remove('btn-active');
      btnColSpd.classList.remove('btn-active');
      btnColEle.classList.remove('btn-active');
    };

    btnColGrade.addEventListener('click', () => {
      clearColActive();
      btnColGrade.classList.add('btn-active');
      this.callbacks.onSetTrailColorMode('grade');
    });
    btnColSpd.addEventListener('click', () => {
      clearColActive();
      btnColSpd.classList.add('btn-active');
      this.callbacks.onSetTrailColorMode('speed');
    });
    btnColEle.addEventListener('click', () => {
      clearColActive();
      btnColEle.classList.add('btn-active');
      this.callbacks.onSetTrailColorMode('elevation');
    });
  }

  public setTextureStyle(style: TextureStyle): void {
    this.textureStyle = style;
    const btnSat = document.getElementById('btnSatTex');
    const btnHybrid = document.getElementById('btnHybridTex');
    const btnTopo = document.getElementById('btnTopoTex');
    btnSat?.classList.toggle('btn-active', style === 'satellite');
    btnHybrid?.classList.toggle('btn-active', style === 'hybrid');
    btnTopo?.classList.toggle('btn-active', style === 'topo');
  }

  public setTrailColorMode(mode: TrailColorMode): void {
    this.trailColorMode = mode;
    const btnColGrade = document.getElementById('btnColorGrade');
    const btnColSpd = document.getElementById('btnColorSpeed');
    const btnColEle = document.getElementById('btnColorEle');
    btnColGrade?.classList.toggle('btn-active', mode === 'grade');
    btnColSpd?.classList.toggle('btn-active', mode === 'speed');
    btnColEle?.classList.toggle('btn-active', mode === 'elevation');
  }

  public dispose(): void {
    if (this.unsubscribeSession) {
      this.unsubscribeSession();
      this.unsubscribeSession = undefined;
    }
  }
}
