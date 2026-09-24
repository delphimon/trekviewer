import { RouteManifestItem, TrackStats, ViewMode, TextureStyle, TrailColorMode, ElevationProvenanceStats } from '../gpx/TrackTypes';
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
  onSetVerticalExaggeration?: (val: number) => void;
  onSelectWaypoint?: (name: string, lat: number, lon: number) => void;
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
  private trailColorMode: TrailColorMode = 'solid';
  private verticalExaggeration: number = 1.0;

  // Cached elevation profile for high-performance scrubbing
  private cachedElevationSamples: { elevation: number; distance: number }[] = [];
  private staticChartCanvas: HTMLCanvasElement | null = null;
  private chartLandmarks: { x: number; y: number; radius: number; landmark: { name: string; lat: number; lon: number } }[] = [];

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

    const warningsPill = (track.warnings && track.warnings.length > 0)
      ? ` <span class="data-quality-pill" title="${track.warnings.join(' • ')}" style="display:inline-block;padding:2px 8px;font-size:11px;background:rgba(245,158,11,0.2);color:#f59e0b;border:1px solid rgba(245,158,11,0.4);border-radius:12px;margin-left:6px;cursor:help;">⚠ Data Notes (${track.warnings.length})</span>`
      : '';
    this.statsSubtitle.innerHTML = `High Point: ${Math.round(track.maxElevation)} m (${Math.round(track.maxElevation * 3.28084)} ft) • Total Vert: +${Math.round(track.elevationGain)} m${warningsPill}`;

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

    const isRecorded = track.timingType === 'recorded';
    const isMixed = track.timingType === 'mixed';
    const timeLabel = isRecorded ? 'RECORDED TIME' : isMixed ? 'MIXED TIME' : 'EST. TIME';
    const timeSub = isRecorded ? 'GPS Timestamps' : isMixed ? 'Partial GPS + Tobler' : 'Estimated (Tobler)';

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
        <span class="stat-label">${timeLabel}</span>
        <span class="stat-value">${timeStr}</span>
        <span class="stat-sub">${timeSub}</span>
      </div>
    `;

    // Cache elevation profile once per track change
    this.cachedElevationSamples = GPXParser.sampleElevationProfile(track.points, 180);
    this.renderStaticChartBackground();
    this.updateScrubber(0, track.points[0]?.ele || track.minElevation);
    this.updateTrailLegend();
    this.updateLandmarks(track);
  }

  private renderStaticChartBackground(): void {
    if (!this.currentTrack || this.cachedElevationSamples.length < 2) return;
    const w = this.canvasChart.width;
    const h = this.canvasChart.height;

    if (!this.staticChartCanvas) {
      this.staticChartCanvas = document.createElement('canvas');
    }
    this.staticChartCanvas.width = w;
    this.staticChartCanvas.height = h;

    const ctx = this.staticChartCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    const samples = this.cachedElevationSamples;
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

    // Draw landmark markers along the elevation profile (Section 30)
    this.chartLandmarks = [];
    const allLandmarks: { name: string; lat: number; lon: number; ele?: number; type?: string }[] = [];
    const seen = new Set<string>();
    const addLm = (item: { name: string; lat: number; lon: number; ele?: number; type?: string }) => {
      const k = `${item.lat.toFixed(3)},${item.lon.toFixed(3)}`;
      const nameKey = item.name.toLowerCase().trim();
      if (seen.has(k) || seen.has(nameKey)) return;
      seen.add(k);
      seen.add(nameKey);
      allLandmarks.push(item);
    };

    for (const lm of this.currentTrack.landmarks || []) {
      if (lm.type === 'summit' || lm.type === 'high_point' || lm.type === 'start' || lm.type === 'finish' || lm.type === 'day_boundary') {
        addLm(lm);
      }
    }
    for (const wp of this.currentTrack.waypoints || []) {
      addLm(wp);
    }

    for (const lm of allLandmarks) {
      let bestDistSq = Infinity;
      let bestDistFromStart = 0;
      let bestEle = lm.ele ?? minE;
      const cosLat = Math.cos((lm.lat * Math.PI) / 180);
      for (const p of this.currentTrack.points) {
        const dLat = (p.lat - lm.lat) * 111320;
        const dLon = (p.lon - lm.lon) * 111320 * cosLat;
        const d = dLat * dLat + dLon * dLon;
        if (d < bestDistSq) {
          bestDistSq = d;
          bestDistFromStart = p.distanceFromStart;
          bestEle = p.ele;
        }
      }

      const prog = this.currentTrack.totalDistance > 0 ? Math.min(1, Math.max(0, bestDistFromStart / this.currentTrack.totalDistance)) : 0;
      const lx = prog * w;
      const ly = h - 6 - ((bestEle - minE) / spanE) * (h - 16);

      const pinColor = lm.type === 'summit' || lm.type === 'high_point'
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

      this.chartLandmarks.push({
        x: lx,
        y: ly,
        radius: 12,
        landmark: { name: lm.name, lat: lm.lat, lon: lm.lon },
      });
    }
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

    if (this.staticChartCanvas) {
      ctx.drawImage(this.staticChartCanvas, 0, 0);
    }

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
              <button id="btnColorSolid" class="btn btn-sm btn-active">🧭 Solid</button>
              <button id="btnColorGrade" class="btn btn-sm">⛰️ Steepness</button>
              <button id="btnColorSpeed" class="btn btn-sm">🏃 Pace</button>
              <button id="btnColorEle" class="btn btn-sm">📈 Altitude</button>
            </div>
            <div id="trailLegend" class="trail-legend">
              <div class="legend-bar" id="legendBar"></div>
              <div class="legend-labels" id="legendLabels">
                <span id="legendMin"></span>
                <span id="legendMid">Solid Route (High-Contrast Cyan)</span>
                <span id="legendMax"></span>
              </div>
            </div>

            <h3>Vertical Exaggeration</h3>
            <div class="btn-group" id="groupExag">
              <button class="btn btn-sm btn-exag btn-active" data-exag="1">1.0x</button>
              <button class="btn btn-sm btn-exag" data-exag="1.5">1.5x</button>
              <button class="btn btn-sm btn-exag" data-exag="2">2.0x</button>
              <button class="btn btn-sm btn-exag" data-exag="3">3.0x</button>
            </div>

            <div class="landmarks-section" id="landmarksSection" style="display:none;">
              <div class="landmarks-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <h3 style="margin:0;">Key Landmarks</h3>
                <select id="selectLandmark" class="select-landmark styled-select" style="font-size:12px; padding:4px 8px; max-width:180px;">
                  <option value="" disabled selected>Jump to Landmark ▾</option>
                </select>
              </div>
              <div class="landmarks-list" id="landmarksList"></div>
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
              <button class="btn btn-xs speed-btn btn-active" data-speed="1">1x</button>
              <button class="btn btn-xs speed-btn" data-speed="5">5x</button>
              <button class="btn btn-xs speed-btn" data-speed="20">20x</button>
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

    // File Upload (with 25 MB pre-read guard)
    const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
    const fileInput = document.getElementById('gpxUploadInput') as HTMLInputElement;
    fileInput.addEventListener('change', (e) => {
      const file = fileInput.files?.[0];
      if (file) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const mb = (file.size / (1024 * 1024)).toFixed(1);
          this.showStatus(`File "${file.name}" exceeds 25 MB limit (${mb} MB).`, true);
          fileInput.value = '';
          return;
        }
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

    // Drag and Drop GPX onto window (with 25 MB pre-read guard)
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.gpx')) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const mb = (file.size / (1024 * 1024)).toFixed(1);
          this.showStatus(`File "${file.name}" exceeds 25 MB limit (${mb} MB).`, true);
          return;
        }
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

    // Trail Color Mode Buttons (Sections 14-19)
    const btnColSolid = document.getElementById('btnColorSolid')!;
    const btnColGrade = document.getElementById('btnColorGrade')!;
    const btnColSpd = document.getElementById('btnColorSpeed')!;
    const btnColEle = document.getElementById('btnColorEle')!;
    const clearColActive = () => {
      btnColSolid.classList.remove('btn-active');
      btnColGrade.classList.remove('btn-active');
      btnColSpd.classList.remove('btn-active');
      btnColEle.classList.remove('btn-active');
    };

    btnColSolid.addEventListener('click', () => {
      clearColActive();
      btnColSolid.classList.add('btn-active');
      this.callbacks.onSetTrailColorMode('solid');
    });
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

    // Vertical Exaggeration Buttons
    document.querySelectorAll('.btn-exag').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-exag').forEach((b) => b.classList.remove('btn-active'));
        btn.classList.add('btn-active');
        const factor = parseFloat(btn.getAttribute('data-exag') || '1');
        this.callbacks.onSetVerticalExaggeration?.(factor);
      });
    });

    // Landmark Dropdown Selection (Section 28)
    const selectLandmark = document.getElementById('selectLandmark') as HTMLSelectElement | null;
    selectLandmark?.addEventListener('change', () => {
      const val = selectLandmark.value;
      if (!val) return;
      const [latStr, lonStr] = val.split(',');
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      const selectedOpt = selectLandmark.options[selectLandmark.selectedIndex];
      let name = selectedOpt ? selectedOpt.textContent || '' : '';
      const parenIdx = name.lastIndexOf(' (');
      if (parenIdx > 0) {
        name = name.substring(0, parenIdx).trim();
      }
      this.callbacks.onSelectWaypoint?.(name, lat, lon);
      selectLandmark.selectedIndex = 0;
    });

    // Elevation Profile Interactive Click (Jump to Landmark or Scrub) (Section 30)
    this.canvasChart.addEventListener('click', (e) => {
      const rect = this.canvasChart.getBoundingClientRect();
      const scaleX = this.canvasChart.width / (rect.width || 1);
      const scaleY = this.canvasChart.height / (rect.height || 1);
      const clickX = (e.clientX - rect.left) * scaleX;
      const clickY = (e.clientY - rect.top) * scaleY;

      // Check if clicked near a landmark pin on the elevation chart
      let hitLandmark: { name: string; lat: number; lon: number } | null = null;
      let bestDistSq = Infinity;
      for (const cl of this.chartLandmarks) {
        const dx = cl.x - clickX;
        const dy = cl.y - clickY;
        const distSq = dx * dx + dy * dy;
        if (distSq <= cl.radius * cl.radius && distSq < bestDistSq) {
          bestDistSq = distSq;
          hitLandmark = cl.landmark;
        }
      }

      if (hitLandmark) {
        this.callbacks.onSelectWaypoint?.(hitLandmark.name, hitLandmark.lat, hitLandmark.lon);
      } else {
        const progress = Math.min(Math.max(clickX / this.canvasChart.width, 0), 1);
        this.callbacks.onScrub(progress);
      }
    });
  }

  public setVerticalExaggeration(factor: number): void {
    this.verticalExaggeration = factor;
    document.querySelectorAll('.btn-exag').forEach((btn) => {
      const f = parseFloat(btn.getAttribute('data-exag') || '1');
      btn.classList.toggle('btn-active', Math.abs(f - factor) < 0.05);
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
    const btnColSolid = document.getElementById('btnColorSolid');
    const btnColGrade = document.getElementById('btnColorGrade');
    const btnColSpd = document.getElementById('btnColorSpeed');
    const btnColEle = document.getElementById('btnColorEle');
    btnColSolid?.classList.toggle('btn-active', mode === 'solid');
    btnColGrade?.classList.toggle('btn-active', mode === 'grade');
    btnColSpd?.classList.toggle('btn-active', mode === 'speed');
    btnColEle?.classList.toggle('btn-active', mode === 'elevation');
    this.updateTrailLegend(mode);
  }

  public updateTrailLegend(mode: TrailColorMode = this.trailColorMode): void {
    const bar = document.getElementById('legendBar');
    const minEl = document.getElementById('legendMin');
    const midEl = document.getElementById('legendMid');
    const maxEl = document.getElementById('legendMax');
    if (!bar || !minEl || !midEl || !maxEl) return;

    if (mode === 'grade') {
      bar.style.background = 'linear-gradient(to right, #10b981 0%, #eab308 25%, #f97316 50%, #ef4444 75%, #a855f7 100%)';
      minEl.textContent = '0% (Gentle)';
      midEl.textContent = 'Smoothed Grade (15%)';
      maxEl.textContent = '40%+ (Extreme)';
    } else if (mode === 'speed') {
      bar.style.background = 'linear-gradient(to right, #ef4444 0%, #f97316 25%, #eab308 50%, #10b981 75%, #06b6d4 100%)';
      minEl.textContent = '< 1.1 mph (Slow)';
      midEl.textContent = 'Smoothed Pace (2.8 mph)';
      maxEl.textContent = '4.0+ mph (Fast)';
    } else if (mode === 'elevation') {
      bar.style.background = 'linear-gradient(to right, #00f5d4 0%, #10b981 25%, #f59e0b 55%, #ef4444 85%, #ffffff 100%)';
      if (this.currentTrack) {
        const minFt = Math.round(this.currentTrack.minElevation * 3.28084);
        const maxFt = Math.round(this.currentTrack.maxElevation * 3.28084);
        const midFt = Math.round((minFt + maxFt) / 2);
        minEl.textContent = `${minFt.toLocaleString()} ft`;
        midEl.textContent = `${midFt.toLocaleString()} ft`;
        maxEl.textContent = `${maxFt.toLocaleString()} ft`;
      } else {
        minEl.textContent = 'Min Alt';
        midEl.textContent = 'Mid Alt';
        maxEl.textContent = 'High Point';
      }
    } else {
      bar.style.background = '#38bdf8';
      minEl.textContent = '';
      midEl.textContent = 'Solid Route (High-Contrast Cyan)';
      maxEl.textContent = '';
    }
  }

  private updateLandmarks(track: TrackStats): void {
    const section = document.getElementById('landmarksSection');
    const list = document.getElementById('landmarksList');
    if (!section || !list) return;

    const landmarks: { name: string; lat: number; lon: number; ele?: number; type?: string }[] = [];
    const seen = new Set<string>();

    const addLandmark = (item: { name: string; lat: number; lon: number; ele?: number; type?: string }) => {
      const coordKey = `${item.lat.toFixed(3)},${item.lon.toFixed(3)}`;
      const nameKey = item.name.toLowerCase().trim();
      if (seen.has(coordKey) || seen.has(nameKey)) return;
      seen.add(coordKey);
      seen.add(nameKey);
      landmarks.push(item);
    };

    // 1. Derived landmarks (Summit / High Point, Start, Finish, Day Boundaries)
    for (const lm of track.landmarks || []) {
      if (lm.type === 'summit' || lm.type === 'high_point' || lm.type === 'start' || lm.type === 'finish' || lm.type === 'day_boundary') {
        addLandmark(lm);
      }
    }

    // 2. Explicit GPX Waypoints
    for (const wp of track.waypoints || []) {
      addLandmark(wp);
    }

    const selectEl = document.getElementById('selectLandmark') as HTMLSelectElement | null;
    if (landmarks.length === 0) {
      section.style.display = 'none';
      list.innerHTML = '';
      if (selectEl) selectEl.innerHTML = '<option value="" disabled selected>Jump to Landmark ▾</option>';
      return;
    }

    section.style.display = 'block';
    list.innerHTML = '';
    if (selectEl) {
      selectEl.innerHTML = '<option value="" disabled selected>Jump to Landmark ▾</option>';
    }

    for (const lm of landmarks) {
      const chip = document.createElement('button');
      chip.className = 'landmark-chip';
      chip.type = 'button';

      let icon = '📍';
      if (lm.type === 'start' || lm.name.toLowerCase().includes('start') || lm.name.toLowerCase().includes('trailhead')) {
        icon = '🟢';
      } else if (lm.type === 'summit' || lm.name.toLowerCase().includes('summit') || lm.name.toLowerCase().includes('peak') || lm.name.toLowerCase().includes('high point')) {
        icon = '⛰️';
      } else if (lm.type === 'finish' || lm.name.toLowerCase().includes('finish')) {
        icon = '🏁';
      } else if (lm.type === 'day_boundary' || lm.name.toLowerCase().includes('camp')) {
        icon = '⛺';
      }

      const eleText = lm.ele ? ` (${Math.round(lm.ele * 3.28084)} ft)` : '';
      chip.innerHTML = `${icon} <span>${lm.name}${eleText}</span>`;
      chip.title = `Jump route progress to ${lm.name}`;

      chip.addEventListener('click', () => {
        this.callbacks.onSelectWaypoint?.(lm.name, lm.lat, lm.lon);
      });

      list.appendChild(chip);

      if (selectEl) {
        const opt = document.createElement('option');
        opt.value = `${lm.lat},${lm.lon}`;
        opt.textContent = `${lm.name}${eleText}`;
        selectEl.appendChild(opt);
      }
    }
  }

  public setPlaybackSpeed(speed: number): void {
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      const spd = parseFloat(btn.getAttribute('data-speed') || '1');
      btn.classList.toggle('btn-active', Math.abs(spd - speed) < 0.05);
    });
  }

  public setXREnabled(enabled: boolean): void {
    const vrBtn = document.getElementById('btnEnterVR') as HTMLButtonElement | null;
    const arBtn = document.getElementById('btnEnterAR') as HTMLButtonElement | null;
    if (vrBtn) vrBtn.disabled = !enabled;
    if (arBtn) arBtn.disabled = !enabled;
  }

  public setMetaInfo(attribution?: string, terrainQuality?: string, provenance?: ElevationProvenanceStats): void {
    let metaEl = document.getElementById('desktopAttribution');
    if (!metaEl) {
      metaEl = document.createElement('div');
      metaEl.id = 'desktopAttribution';
      metaEl.className = 'desktop-attribution';
      metaEl.style.cssText = 'position:fixed;bottom:8px;left:8px;font-family:monospace;font-size:11px;color:#94a3b8;background:rgba(15,23,42,0.85);padding:4px 10px;border-radius:6px;border:1px solid rgba(148,163,184,0.3);z-index:99999;pointer-events:none;';
      document.body.appendChild(metaEl);
    }
    const qualityLabel = terrainQuality === 'dem' ? 'DEM' : terrainQuality === 'partial-dem' ? 'partial DEM' : 'approximate';
    const provStr = provenance && (provenance.demPercent > 0 || provenance.interpolatedPercent > 0)
      ? ` (${provenance.gpxPercent}% GPX, ${provenance.demPercent}% DEM${provenance.interpolatedPercent > 0 ? `, ${provenance.interpolatedPercent}% interp` : ''})`
      : '';
    metaEl.textContent = `Elevation: ${qualityLabel}${provStr}${attribution ? ` | Imagery: ${attribution}` : ''}`;
  }

  public dispose(): void {
    if (this.statusTimeout) {
      window.clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    const metaEl = document.getElementById('desktopAttribution');
    if (metaEl && metaEl.parentNode) {
      metaEl.parentNode.removeChild(metaEl);
    }
    this.container.innerHTML = '';
  }
}

