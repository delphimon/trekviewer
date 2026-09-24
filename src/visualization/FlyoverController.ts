import * as THREE from 'three';
import type { GPXPoint, TrackStats, ViewMode } from '../gpx/TrackTypes.ts';
import type { TrailResult } from './TrailMesh.ts';
import { headingForForwardVector } from './RouteGeometry.ts';

export interface FlyoverUpdate {
  progress: number;
  currentPoint: GPXPoint;
  position: THREE.Vector3;
  isPlaying: boolean;
  speed: number;
}

export class FlyoverController {
  private trailResult: TrailResult;
  private track: TrackStats;
  private progress: number = 0; // 0.0 to 1.0
  private playbackTime: number = 0; // simulated elapsed seconds along the trek
  private totalPlaybackSeconds: number = 60.0;
  private isPlaying: boolean = false;
  private playbackSpeed: number = 1.0; // 1.0 = base nominal duration
  private baseDurationSeconds: number = 60.0;
  private viewMode: ViewMode = 'diorama';
  private onUpdateCallback?: (state: FlyoverUpdate) => void;

  constructor(trailResult: TrailResult, track: TrackStats) {
    this.trailResult = trailResult;
    this.track = track;
    this.totalPlaybackSeconds = Math.max(track.totalPlaybackSeconds || 60, 10);
  }

  public setUpdateCallback(cb: (state: FlyoverUpdate) => void): void {
    this.onUpdateCallback = cb;
  }

  public setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
  }

  public getViewMode(): ViewMode {
    return this.viewMode;
  }

  public play(): void {
    this.isPlaying = true;
    if (this.progress >= 0.999) {
      this.setProgress(0);
    }
  }

  public pause(): void {
    this.isPlaying = false;
  }

  public dispose(): void {
    this.pause();
    this.onUpdateCallback = undefined;
  }

  public togglePlay(): boolean {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
    return this.isPlaying;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public setSpeed(speed: number): void {
    this.playbackSpeed = Math.max(0.1, speed);
  }

  public getSpeed(): number {
    return this.playbackSpeed;
  }

  public setProgress(progress: number): void {
    this.progress = Math.min(Math.max(progress, 0), 1);
    this.playbackTime = this.progressToTime(this.progress);
    this.updatePosition();
  }

  public getProgress(): number {
    return this.progress;
  }

  public getPlaybackTime(): number {
    return this.playbackTime;
  }

  public getTotalPlaybackSeconds(): number {
    return this.totalPlaybackSeconds;
  }

  /**
   * Steps forward/backward by a duration scaled to the trek's total time.
   */
  public stepSeconds(seconds: number): void {
    const timeDelta = seconds * this.playbackSpeed;
    const newTime = Math.max(0, Math.min(this.totalPlaybackSeconds, this.playbackTime + timeDelta));
    this.playbackTime = newTime;
    this.progress = this.timeToProgress(newTime);
    this.updatePosition();
  }

  /**
   * Directly steps distance along the route in meters (ideal for 1:1 thumbstick walking/scrubbing).
   */
  public stepDistanceMeters(meters: number): void {
    const totalDist = Math.max(this.track.totalDistance, 10);
    const currentDist = this.progress * totalDist;
    const newDist = Math.max(0, Math.min(totalDist, currentDist + meters));
    this.setProgress(newDist / totalDist);
  }

  public getCurrentWorldPosition(): THREE.Vector3 {
    return this.trailResult.routeGeometry.getTelemetryAtProgress(this.progress).position;
  }

  public update(
    deltaSeconds: number,
    camera?: THREE.Camera,
    dioramaRoot?: THREE.Group,
    isWebXRPresenting: boolean = false
  ): void {
    if (this.isPlaying) {
      // True temporal multiplier: 1x = 1 real second per trek second (e.g. 20x advances 20 trek seconds per second)
      const simRate = this.playbackSpeed;
      this.playbackTime += deltaSeconds * simRate;

      if (this.playbackTime >= this.totalPlaybackSeconds) {
        this.playbackTime = this.totalPlaybackSeconds;
        this.progress = 1.0;
        this.isPlaying = false;
      } else {
        this.progress = this.timeToProgress(this.playbackTime);
      }

      this.updatePosition();
    }

    // 1:1 First-Person Trail Mode (Sections 6, 7)
    if (this.viewMode === 'first-person') {
      const telemetry = this.trailResult.routeGeometry.getTelemetryAtProgress(this.progress);
      const pos = telemetry.position;
      const forward = this.trailResult.routeGeometry.getRouteForwardAtProgress(this.progress);

      if (isWebXRPresenting && dioramaRoot) {
        // In WebXR: Move dioramaRoot so that trail point is directly under user feet (floor level y=0)
        // Rotate so increasing route direction points forward (-Z) in room space (Section 6)
        const trailHeading = headingForForwardVector(forward);
        const rotY = trailHeading;
        dioramaRoot.rotation.set(0, rotY, 0);

        // Apply rotated offset to place current trail point at origin
        const offset = new THREE.Vector3(-pos.x, -pos.y, -pos.z);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
        dioramaRoot.position.copy(offset);
        dioramaRoot.scale.set(1, 1, 1);
      } else if (camera) {
        // Desktop fallback: place camera at eye level (+2m above trail) looking forward (Section 7)
        camera.position.set(pos.x, pos.y + 2.0, pos.z);
        const lookTarget = pos.clone().add(forward.clone().multiplyScalar(40)).add(new THREE.Vector3(0, 1.2, 0));
        camera.lookAt(lookTarget);
      }
    }
  }

  /**
   * Converts simulated GPS playback time (seconds) to distance fraction [0..1] along the route.
   */
  private timeToProgress(time: number): number {
    const points = this.track.points;
    if (points.length < 2) return 0;

    if (time <= 0) return 0;
    if (time >= this.totalPlaybackSeconds) return 1;

    // Binary search for interval
    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].playbackSeconds < time) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const idx = Math.max(0, Math.min(points.length - 2, low - 1));
    const p0 = points[idx];
    const p1 = points[idx + 1];

    const dt = p1.playbackSeconds - p0.playbackSeconds;
    const alpha = dt > 0.001 ? (time - p0.playbackSeconds) / dt : 0;
    const dist = p0.distanceFromStart + alpha * (p1.distanceFromStart - p0.distanceFromStart);

    return Math.max(0, Math.min(1, dist / Math.max(this.track.totalDistance, 1)));
  }

  /**
   * Converts distance fraction [0..1] to simulated GPS playback time.
   */
  private progressToTime(progress: number): number {
    const points = this.track.points;
    if (points.length < 2) return 0;

    const targetDist = progress * this.track.totalDistance;
    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].distanceFromStart < targetDist) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const idx = Math.max(0, Math.min(points.length - 2, low - 1));
    const p0 = points[idx];
    const p1 = points[idx + 1];

    const dd = p1.distanceFromStart - p0.distanceFromStart;
    const alpha = dd > 0.001 ? (targetDist - p0.distanceFromStart) / dd : 0;
    const time = p0.playbackSeconds + alpha * (p1.playbackSeconds - p0.playbackSeconds);

    return Math.max(0, Math.min(this.totalPlaybackSeconds, time));
  }

  private updatePosition(): void {
    const res = this.trailResult.updateHikerPosition(this.progress);
    if (this.onUpdateCallback) {
      this.onUpdateCallback({
        progress: this.progress,
        currentPoint: res.currentPoint,
        position: res.position,
        isPlaying: this.isPlaying,
        speed: this.playbackSpeed,
      });
    }
  }
}
