import type { GPXPoint, GPXWaypoint, TrackStats, ViewMode, TextureStyle, TrailColorMode } from '../gpx/TrackTypes.ts';

export type TerrainQuality = 'dem' | 'partial-dem' | 'synthetic';

export type LoadingPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'elevation'
  | 'terrain'
  | 'imagery'
  | 'ready'
  | 'error';

export interface TrekSessionState {
  activeRouteId: string | null;
  routeName: string;
  routeSource: 'manifest' | 'upload' | null;
  viewMode: ViewMode;
  textureStyle: TextureStyle;
  trailColorMode: TrailColorMode;
  verticalExaggeration: number;
  isPlaying: boolean;
  playbackSpeed: number;
  progress: number;
  currentDistance: number;
  currentElevation: number;
  currentPoint: GPXPoint | null;
  terrainQuality: TerrainQuality;
  loadingPhase: LoadingPhase;
  loadingProgress: number | null;
  loadingMessage: string;
  isError: boolean;
  selectedWaypoint: GPXWaypoint | null;
  attribution: string;
  warnings: string[];
  track: TrackStats | null;
}

export type StateListener = (
  state: Readonly<TrekSessionState>,
  prev: Readonly<TrekSessionState>
) => void;

export class TrekSession {
  private state: TrekSessionState;
  private listeners: Set<StateListener> = new Set();

  constructor(initialState?: Partial<TrekSessionState>) {
    this.state = {
      activeRouteId: null,
      routeName: 'No Trek Selected',
      routeSource: null,
      viewMode: 'diorama',
      textureStyle: 'satellite',
      trailColorMode: 'grade',
      verticalExaggeration: 1.0,
      isPlaying: false,
      playbackSpeed: 20.0,
      progress: 0,
      currentDistance: 0,
      currentElevation: 0,
      currentPoint: null,
      terrainQuality: 'dem',
      loadingPhase: 'idle',
      loadingProgress: null,
      loadingMessage: '',
      isError: false,
      selectedWaypoint: null,
      attribution: 'Map data: Esri, USGS, AWS Open Data',
      warnings: [],
      track: null,
      ...initialState,
    };
  }

  public getState(): Readonly<TrekSessionState> {
    return this.state;
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setState(partial: Partial<TrekSessionState>): void {
    const prev = this.state;
    let hasChanged = false;
    for (const key of Object.keys(partial) as (keyof TrekSessionState)[]) {
      if (partial[key] !== prev[key]) {
        hasChanged = true;
        break;
      }
    }
    if (!hasChanged) return;

    this.state = { ...prev, ...partial };
    this.notify(prev);
  }

  private notify(prev: Readonly<TrekSessionState>): void {
    for (const listener of this.listeners) {
      listener(this.state, prev);
    }
  }

  public static getAttributionForStyle(style: TextureStyle): string {
    switch (style) {
      case 'satellite':
        return 'Satellite imagery: Esri World Imagery • Elevation: AWS Open Data / USGS';
      case 'hybrid':
        return 'Imagery: Esri World Imagery & Labels • Elevation: AWS Open Data / USGS';
      case 'topo':
        return 'Topographic map: USGS National Map / OpenTopoMap • Elevation: USGS 3DEP';
      case 'elevation-ramp':
      default:
        return 'Procedural Topographic Map • Elevation: AWS Open Data';
    }
  }

  public setTrack(
    track: TrackStats,
    routeId?: string,
    source?: 'manifest' | 'upload'
  ): void {
    this.setState({
      track,
      activeRouteId: routeId ?? this.state.activeRouteId,
      routeName: track.name,
      routeSource: source ?? this.state.routeSource,
      progress: 0,
      currentDistance: 0,
      currentElevation: track.points[0]?.ele || track.minElevation,
      currentPoint: track.points[0] || null,
      selectedWaypoint: null,
      warnings: track.warnings ?? [],
    });
  }

  public setProgress(
    progress: number,
    currentEle?: number,
    currentDist?: number,
    currentPoint?: GPXPoint | null
  ): void {
    const clamped = Math.max(0, Math.min(1, progress));
    const dist = currentDist ?? (this.state.track ? clamped * this.state.track.totalDistance : 0);
    const ele = currentEle ?? (currentPoint?.ele ?? this.state.currentElevation);

    this.setState({
      progress: clamped,
      currentDistance: dist,
      currentElevation: ele,
      currentPoint: currentPoint !== undefined ? currentPoint : this.state.currentPoint,
    });
  }

  public setPlayback(isPlaying: boolean): void {
    if (this.state.isPlaying !== isPlaying) {
      this.setState({ isPlaying });
    }
  }

  public setSpeed(speed: number): void {
    const playbackSpeed = Math.max(0.1, speed);
    if (this.state.playbackSpeed !== playbackSpeed) {
      this.setState({ playbackSpeed });
    }
  }

  public setViewMode(viewMode: ViewMode): void {
    if (this.state.viewMode !== viewMode) {
      this.setState({ viewMode });
    }
  }

  public setTextureStyle(textureStyle: TextureStyle): void {
    if (this.state.textureStyle !== textureStyle) {
      this.setState({
        textureStyle,
        attribution: TrekSession.getAttributionForStyle(textureStyle),
      });
    }
  }

  public setTrailColorMode(trailColorMode: TrailColorMode): void {
    if (this.state.trailColorMode !== trailColorMode) {
      this.setState({ trailColorMode });
    }
  }

  public setVerticalExaggeration(verticalExaggeration: number): void {
    const clamped = Math.max(1.0, Math.min(3.0, verticalExaggeration));
    if (this.state.verticalExaggeration !== clamped) {
      this.setState({ verticalExaggeration: clamped });
    }
  }

  public setLoadingStatus(
    phase: LoadingPhase,
    message: string,
    progress: number | null = null,
    isError: boolean = false
  ): void {
    this.setState({
      loadingPhase: phase,
      loadingMessage: message,
      loadingProgress: progress,
      isError,
    });
  }

  public setTerrainQuality(terrainQuality: TerrainQuality): void {
    if (this.state.terrainQuality !== terrainQuality) {
      this.setState({ terrainQuality });
    }
  }

  public setAttribution(attribution: string): void {
    if (this.state.attribution !== attribution) {
      this.setState({ attribution });
    }
  }

  public selectWaypoint(selectedWaypoint: GPXWaypoint | null): void {
    this.setState({ selectedWaypoint });
  }
}
