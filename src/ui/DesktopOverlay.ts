import { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode } from '../gpx/TrackTypes';
import { GPXParser } from '../gpx/GPXParser';

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
}

export class DesktopOverlay {
  private container: HTMLElement;
  private callbacks: OverlayCallbacks;
  private manifest: RouteManifestItem[] = [];
  private currentTrack: TrackStats | null = null;
  private isPlaying: boolean = false;
  private currentProgress: number = 0;
  private viewMode: ViewMode = 'diorama';
  private textureStyle: TextureStyle = 'satellite';
  private trailColorMode: TrailColorMode = 'grade';

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

  constructor(container: HTMLElement, callbacks: OverlayCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.createDOM();
    this.setupEventListeners();
  }

  public setManifest(manifest: RouteManifestItem[]): void {
    this.manifest = manifest;
    const select = document.getElementById('routeSelect') as HTMLSelectElement;
    if (select) {
      select.innerHTML = '';
      manifest.forEach((m, idx) => {
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

    // Extract percentage if present in message (e.g. "(45%)")
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

    const spinner = this.statusBanner.querySelector('.status-spinner') as HTMLElement;
    const isDone = !isError && (
      message.toLowerCase().includes('ready') ||
      message.includes('Loaded:') ||
      message.includes('active') ||
      message.includes('complete')
    );

    if (spinner) {
      spinner.style.display = (isDone || isError) ? 'none' : 'inline-block';
    }

    if (isDone) {
      this.statusTimeout = window.setTimeout(() => {
        this.statusBanner.style.display = 'none';
      }, 2500);
    } else if (isError) {
      this.statusTimeout = window.setTimeout(() => {
        this.statusBanner.style.display = 'none';
      }, 6000);
    }
  }

  public clearStatus(): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    this.statusBanner.style.display = 'none';
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

  private drawElevationChart(): void {
    if (!this.currentTrack) return;
    const canvas = this.canvasChart;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const samples = GPXParser.sampleElevationProfile(this.currentTrack.points, 180);
    if (samples.length < 2) return;

    const minE = this.currentTrack.minElevation;
    const maxE = this.currentTrack.maxElevation;
    const spanE = Math.max(maxE - minE, 10);

    // Profile Line
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const px = (i / (samples.length - 1)) * w;
      const py = h - 6 - ((s.elevation - minE) / spanE) * (h - 16);

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }

    // Gradient fill under curve
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

    // Progress scrub line
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
        <!-- Top Navigation & Controls Bar -->
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

          <!-- WebXR Meta Quest 3 Launch Buttons -->
          <div class="xr-buttons">
            <button id="btnEnterVR" class="btn btn-primary xr-btn">
              🥽 Enter VR
            </button>
            <button id="btnEnterAR" class="btn btn-accent xr-btn">
              👓 Passthrough (MR)
            </button>
          </div>
        </header>

        <!-- Status & Progress Notification Modal -->
        <div id="statusBanner" class="status-banner glass-card" style="display:none;">
          <div class="status-content">
            <span class="status-spinner"></span>
            <span id="statusText">Loading trek...</span>
          </div>
          <div id="statusProgressBar" class="status-progress-bar" style="display:none;">
            <div id="statusProgressFill" class="status-progress-fill"></div>
          </div>
        </div>

        <!-- Left Stats Panel -->
        <aside class="stats-panel glass-card">
          <h2 id="statsTitle" class="trek-title">Loading Route...</h2>
          <p id="statsSubtitle" class="trek-meta">Cascades Mountaineering</p>
          <div id="statsGrid" class="stats-grid"></div>

          <!-- Map & Visualization Options -->
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
          </div>

          <!-- Meta Quest 3 Controller Help -->
          <div class="controller-help">
            <h3>🎮 Quest 3 Controls</h3>
            <ul>
              <li><strong>🖐️ Bare Hands:</strong> 2-Hand Pinch to Zoom/Rotate/Move, 1-Hand Pinch to Drag & Turn, Direct Finger Poke HUD</li>
              <li><strong>Grip:</strong> Grab & reposition 3D diorama in your room</li>
              <li><strong>Right Thumbstick:</strong> Rotate & scale (zoom)</li>
              <li><strong>A / X Button:</strong> Toggle Tabletop MR ⇄ 1:1 Trail</li>
              <li><strong>B / Y Button:</strong> Play / Pause Flyover</li>
              <li><strong>Trigger:</strong> Laser pointer select</li>
            </ul>
          </div>
        </aside>

        <!-- Bottom Timeline & Flyover Player Bar -->
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
  }

  private setupEventListeners(): void {
    // Route Selection
    const select = document.getElementById('routeSelect') as HTMLSelectElement;
    select.addEventListener('change', () => {
      const selected = this.manifest.find((m) => m.id === select.value);
      if (selected) this.callbacks.onSelectRoute(selected);
    });

    // File Upload
    const fileInput = document.getElementById('gpxUploadInput') as HTMLInputElement;
    fileInput.addEventListener('change', (e) => {
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

    // Drag and Drop GPX onto window
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

    // WebXR Buttons
    document.getElementById('btnEnterVR')?.addEventListener('click', () => {
      this.callbacks.onEnterXR('immersive-vr');
    });
    document.getElementById('btnEnterAR')?.addEventListener('click', () => {
      this.callbacks.onEnterXR('immersive-ar');
    });

    // Play/Pause
    this.playBtn.addEventListener('click', () => {
      this.callbacks.onTogglePlay();
    });

    // Speed buttons
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('btn-active'));
        btn.classList.add('btn-active');
        const spd = parseFloat(btn.getAttribute('data-speed') || '20');
        this.callbacks.onSetSpeed(spd);
      });
    });

    // Scrubber
    this.scrubberInput.addEventListener('input', () => {
      const progress = parseFloat(this.scrubberInput.value) / 100;
      this.callbacks.onScrub(progress);
    });

    // View Mode Toggle Button
    const viewBtn = document.getElementById('btnViewToggle')!;
    viewBtn.addEventListener('click', () => {
      this.viewMode = this.viewMode === 'diorama' ? 'first-person' : 'diorama';
      viewBtn.innerHTML = this.viewMode === 'diorama' ? '🚶 Walk Trail (1:1)' : '🏔 Tabletop Diorama';
      this.callbacks.onToggleViewMode(this.viewMode);
    });

    // Texture Style Buttons
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

    // Trail Color Mode Buttons
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
    if (this.statusTimeout) {
      window.clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    this.container.innerHTML = '';
  }
}

