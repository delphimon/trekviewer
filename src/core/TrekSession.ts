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

/**
 * TrekSession is the authoritative, reactive state machine for TrekViewer.
 *
 * Guarantees:
 * - Single source of truth for both 2D desktop UI and 3D VR Spatial HUD.
 * - Reactive change notifications with fine-grained delta inspection.
 * - Robust input validation and clamping for speeds, progress, and exaggerations.
 * - Safe subscription lifecycle with automatic unsubscribe handles.
 */
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
      trailColorMode: 'solid',
      verticalExaggeration: 1.0,
      isPlaying: false,
      playbackSpeed: 1.0,
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
    // Check if any actual values changed
    let hasChanges = false;
    for (const key of Object.keys(partial) as (keyof TrekSessionState)[]) {
      if (prev[key] !== partial[key]) {
        hasChanges = true;
        break;
      }
    }
    if (!hasChanges) return;

    this.state = { ...prev, ...partial };
    this.notify(prev);
  }

  private notify(prev: Readonly<TrekSessionState>): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state, prev);
      } catch (err) {
        console.error('[TrekSession] Error in state listener:', err);
      }
    }
  }

  public setTrack(
    track: TrackStats | null,
    routeId?: string,
    source: 'manifest' | 'upload' = 'manifest'
  ): void {
    if (!track) {
      this.setState({
        track: null,
        activeRouteId: null,
        routeName: 'No Trek Selected',
        routeSource: null,
        progress: 0,
        currentDistance: 0,
        currentElevation: 0,
        currentPoint: null,
        warnings: [],
      });
      return;
    }

    const firstPt = track.points[0];
    this.setState({
      track,
      activeRouteId: routeId ?? track.name,
      routeName: track.name,
      routeSource: source,
      progress: 0,
      currentDistance: 0,
      currentElevation: firstPt?.ele ?? track.minElevation,
      currentPoint: firstPt ?? null,
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
      this.setState({ textureStyle });
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
