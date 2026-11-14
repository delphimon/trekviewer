import * as THREE from 'three';
import type { GPXPoint, TrackStats, ViewMode } from '../gpx/TrackTypes.ts';
import type { TrailResult } from './TrailMesh.ts';
import { headingForForwardVector } from './RouteGeometry.ts';
import { TOUR_DURATION_SECONDS, type PlaybackMode } from './PlaybackPresentation.ts';

export interface FlyoverUpdate {
  progress: number;
  currentPoint: GPXPoint;
  position: THREE.Vector3;
  isPlaying: boolean;
  speed: number;
}

/** Desktop "Fly the trail" chase camera (XR life-size mode does not use it). */
export const CHASE_BACK_M = 60;
export const CHASE_UP_M = 25;
export const CHASE_AHEAD_M = 40;
export const CHASE_MIN_CLEARANCE_M = 8;
const CHASE_HEADING_TAU_S = 0.7;
export const CHASE_DEFAULT_DISTANCE_M = Math.hypot(CHASE_BACK_M, CHASE_UP_M);
export const CHASE_DEFAULT_PITCH_RAD = Math.atan2(CHASE_UP_M, CHASE_BACK_M);
export const CHASE_PITCH_LIMITS_RAD = [THREE.MathUtils.degToRad(5), THREE.MathUtils.degToRad(80)] as const;
export const CHASE_DISTANCE_LIMITS_M = [15, 400] as const;
/** After this long without look input the view eases back to the default chase pose. */
export const CHASE_LOOK_RETURN_S = 3;
const CHASE_LINE_SAMPLES = 6;

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
  private playbackMode: PlaybackMode = 'recorded';
  private navigationYaw: number | null = null;
  private readonly navigationOffset = new THREE.Vector3();
  private readonly viewerAnchor = new THREE.Vector3();
  private readonly _scratchForward = new THREE.Vector3();
  private readonly _scratchPivot = new THREE.Vector3();
  private readonly _scratchUpAxis = new THREE.Vector3(0, 1, 0);
  private readonly _scratchLookTarget = new THREE.Vector3();
  private viewerHeading: number = 0;
  private readonly chaseHeading = new THREE.Vector3();
  private hasChaseHeading = false;
  private readonly _scratchChaseBack = new THREE.Vector3();
  private chaseYawOffset = 0;
  private chasePitch = CHASE_DEFAULT_PITCH_RAD;
  private chaseDistance = CHASE_DEFAULT_DISTANCE_M;
  private chaseClock = 0;
  private lastChaseInput = -Infinity;
  private chaseDragging = false;
  private onUpdateCallback?: (state: FlyoverUpdate) => void;
  private elevationSampler?: (x: number, z: number) => number;

  constructor(trailResult: TrailResult, track: TrackStats, elevationSampler?: (x: number, z: number) => number) {
    this.trailResult = trailResult;
    this.track = track;
    this.totalPlaybackSeconds = Math.max(track.totalPlaybackSeconds || 60, 10);
    this.elevationSampler = elevationSampler;
  }

  public setElevationSampler(sampler: (x: number, z: number) => number): void {
    this.elevationSampler = sampler;
  }

  public setUpdateCallback(cb: (state: FlyoverUpdate) => void): void {
    this.onUpdateCallback = cb;
  }

  public setViewMode(mode: ViewMode): void {
    if (this.viewMode !== mode) {
      this.hasChaseHeading = false;
      this.chaseYawOffset = 0; this.chasePitch = CHASE_DEFAULT_PITCH_RAD; this.chaseDistance = CHASE_DEFAULT_DISTANCE_M;
      this.navigationYaw = null;
      this.viewerAnchor.set(0, 0, 0);
      this.viewerHeading = 0;
      if (mode === 'first-person') this.pause();
    }
    this.viewMode = mode;
  }

  /** Capture the current local-floor viewer pose, preserving subsequent physical movement. */
  public recenterViewer(camera: THREE.Camera): void {
    camera.getWorldPosition(this.viewerAnchor);
    this.viewerAnchor.y = 0;
    const forward = this._scratchForward;
    camera.getWorldDirection(forward);
    this.viewerHeading = Math.atan2(-forward.x, -forward.z);
    this.navigationYaw = null;
  }

  public turn(radians: number, camera?: THREE.Camera): void {
    if (this.navigationYaw === null) {
      this.navigationYaw = headingForForwardVector(this.trailResult.routeGeometry.getRouteForwardAtProgress(this.progress));
    }
    this.navigationYaw += radians;
    if (camera) {
      const pivot = this._scratchPivot;
      camera.getWorldPosition(pivot);
      pivot.y = 0;
      this.viewerAnchor.sub(pivot).applyAxisAngle(this._scratchUpAxis, radians).add(pivot);
    }
  }

  public getViewMode(): ViewMode {
    return this.viewMode;
  }

  public setPlaybackMode(mode: PlaybackMode): void {
    // Keep the same geographic position when changing the time basis.
    this.playbackMode = mode;
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

  /** Predict only distance progress; never advance playback or move the viewer. */
  public getLookaheadProgress(seconds: number): number {
    if (!this.isPlaying || this.viewMode !== 'diorama' || !Number.isFinite(seconds) || seconds <= 0) return this.progress;
    const delta = seconds * this.playbackSpeed;
    return this.playbackMode === 'tour'
      ? Math.min(1, this.progress + delta / TOUR_DURATION_SECONDS)
      : this.timeToProgress(Math.min(this.totalPlaybackSeconds, this.playbackTime + delta));
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
    if (this.viewMode === 'first-person') {
      this.pause();
      this.stepDistanceMeters(Math.sign(seconds) * 25);
      return;
    }
    if (this.playbackMode === 'tour') {
      this.setProgress(this.progress + seconds / TOUR_DURATION_SECONDS);
      return;
    }
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
    const pos = this.trailResult.routeGeometry.getTelemetryAtProgress(this.progress).position.clone();
    if (this.elevationSampler) {
      const sampled = this.elevationSampler(pos.x, pos.z);
      if (!isNaN(sampled)) {
        pos.y = sampled;
      }
    }
    return pos;
  }

  private smoothedGroundY: number | null = null;

  public update(
    deltaSeconds: number,
    camera?: THREE.Camera,
    dioramaRoot?: THREE.Group,
    isWebXRPresenting: boolean = false
  ): void {
    if (this.isPlaying) {
      const previousProgress = this.progress;
      const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
      if (this.playbackMode === 'tour' && this.viewMode === 'diorama') {
        // Constant route distance avoids GPS pauses and multi-day timestamp gaps.
        this.progress = Math.min(1, this.progress + delta * this.playbackSpeed / TOUR_DURATION_SECONDS);
        this.playbackTime = this.progressToTime(this.progress);
        this.isPlaying = this.progress < 1;
      } else {
        // Track timing retains its existing recorded/estimated temporal multiplier.
        this.playbackTime += delta * this.playbackSpeed;
        if (this.playbackTime >= this.totalPlaybackSeconds) {
          this.playbackTime = this.totalPlaybackSeconds;
          this.progress = 1.0;
          this.isPlaying = false;
        } else {
          this.progress = this.timeToProgress(this.playbackTime);
        }

        if (this.viewMode === 'first-person') {
          // Accelerated tabletop playback must not become high-speed locomotion.
          const maxProgress = previousProgress + delta * 1.4 / Math.max(this.track.totalDistance, 1);
          if (this.progress > maxProgress) {
            this.progress = Math.min(maxProgress, 1);
            this.playbackTime = this.progressToTime(this.progress);
          }
          this.isPlaying = this.progress < 1 && this.playbackTime < this.totalPlaybackSeconds;
        }
      }

      this.updatePosition();
    }

    // 1:1 First-Person Trail Mode (Sections 6, 7)
    if (this.viewMode === 'first-person') {
      const telemetry = this.trailResult.routeGeometry.getTelemetryAtProgress(this.progress);
      const pos = telemetry.position;
      const forward = this.trailResult.routeGeometry.getRouteForwardAtProgress(this.progress);

      let groundY = pos.y;
      if (this.elevationSampler) {
        const sampled = this.elevationSampler(pos.x, pos.z);
        if (!isNaN(sampled)) {
          groundY = sampled;
        }
      }
      // Smooth small ground changes (terrain detail refining under the viewer used to pop the
      // whole world up/down). Large changes are steps/jumps and snap, like a teleport.
      const deltaS = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
      if (this.smoothedGroundY === null || Math.abs(groundY - this.smoothedGroundY) > 3) {
        this.smoothedGroundY = groundY;
      } else {
        this.smoothedGroundY += (groundY - this.smoothedGroundY) * (1 - Math.exp(-deltaS / 0.12));
      }
      groundY = this.smoothedGroundY;

      if (isWebXRPresenting && dioramaRoot) {
        // In WebXR: Move dioramaRoot so that trail point is directly under user feet (floor level y=0)
        // Rotate so increasing route direction points forward (-Z) in room space (Section 6)
        // Align on entry, then preserve user heading through bends and paused frames.
        if (this.navigationYaw === null) this.navigationYaw = headingForForwardVector(forward) + this.viewerHeading;
        const rotY = this.navigationYaw;
        dioramaRoot.rotation.set(0, rotY, 0);

        // Apply rotated offset to place current trail point at origin
        const offset = this.navigationOffset.set(
          -pos.x * Math.cos(rotY) - pos.z * Math.sin(rotY),
          -groundY,
          pos.x * Math.sin(rotY) - pos.z * Math.cos(rotY)
        );
        offset.add(this.viewerAnchor);
        dioramaRoot.position.copy(offset);
        dioramaRoot.scale.set(1, 1, 1);
      } else if (camera) {
        this.updateChaseCamera(camera, pos.x, groundY, pos.z, forward, deltaS);
      }
    }
  }

  /** Desktop chase view: behind the hiker along the (smoothed) direction of travel, looking
   * ahead, never closer than CHASE_MIN_CLEARANCE_M to the terrain along the line of sight. */
  private updateChaseCamera(camera: THREE.Camera, x: number, groundY: number, z: number, forward: THREE.Vector3, dt: number): void {
    const length = Math.hypot(forward.x, forward.z);
    if (length > 1e-6) {
      if (!this.hasChaseHeading) { this.chaseHeading.set(forward.x / length, 0, forward.z / length); this.hasChaseHeading = true; }
      else {
        const k = 1 - Math.exp(-dt / CHASE_HEADING_TAU_S);
        this.chaseHeading.x += (forward.x / length - this.chaseHeading.x) * k;
        this.chaseHeading.z += (forward.z / length - this.chaseHeading.z) * k;
        const h = Math.hypot(this.chaseHeading.x, this.chaseHeading.z);
        if (h > 1e-6) { this.chaseHeading.x /= h; this.chaseHeading.z /= h; }
      }
    }
    this.easeChaseLook(dt);
    const back = this._scratchChaseBack.set(-this.chaseHeading.x, 0, -this.chaseHeading.z);
    if (this.chaseYawOffset !== 0) back.applyAxisAngle(this._scratchUpAxis, this.chaseYawOffset);
    const horizontal = this.chaseHorizontal(), vertical = this.chaseVertical();
    let camY = groundY + vertical;
    const camX = x + back.x * horizontal, camZ = z + back.z * horizontal;
    if (this.elevationSampler) {
      // Lift until every sampled point on the line from the hiker to the camera clears the
      // terrain; the camera endpoint gets the full clearance.
      const eyeY = groundY + 2;
      for (let i = 1; i <= CHASE_LINE_SAMPLES; i++) {
        const t = i / CHASE_LINE_SAMPLES;
        const h = this.elevationSampler(x + (camX - x) * t, z + (camZ - z) * t);
        if (!Number.isFinite(h)) continue;
        camY = Math.max(camY, eyeY + (h + CHASE_MIN_CLEARANCE_M * t - eyeY) / t);
      }
    }
    camera.position.set(camX, camY, camZ);
    const tx = x - back.x * CHASE_AHEAD_M, tz = z - back.z * CHASE_AHEAD_M;
    const ahead = this.elevationSampler?.(tx, tz);
    this._scratchLookTarget.set(tx, Number.isFinite(ahead) ? ahead! : groundY, tz);
    camera.lookAt(this._scratchLookTarget);
  }

  private chaseHorizontal(): number { return this.chaseDistance * Math.cos(this.chasePitch); }
  private chaseVertical(): number { return this.chaseDistance * Math.sin(this.chasePitch); }

  /** Desktop mouse look: orbit the chase view around the hiker (yaw free, pitch 5-80 deg). */
  public chaseLook(deltaYaw: number, deltaPitch: number): void {
    this.chaseYawOffset += deltaYaw;
    this.chasePitch = THREE.MathUtils.clamp(this.chasePitch + deltaPitch, CHASE_PITCH_LIMITS_RAD[0], CHASE_PITCH_LIMITS_RAD[1]);
    this.lastChaseInput = this.chaseClock;
  }

  /** Desktop wheel: follow distance, 15-400 m. */
  public chaseZoom(factor: number): void {
    if (!(factor > 0)) return;
    this.chaseDistance = THREE.MathUtils.clamp(this.chaseDistance * factor, CHASE_DISTANCE_LIMITS_M[0], CHASE_DISTANCE_LIMITS_M[1]);
    this.lastChaseInput = this.chaseClock;
  }

  /** While the pointer is held the view never eases back. */
  public setChaseDragging(dragging: boolean): void {
    this.chaseDragging = dragging;
    this.lastChaseInput = this.chaseClock;
  }

  private easeChaseLook(dt: number): void {
    this.chaseClock += dt;
    if (this.chaseDragging || this.chaseClock - this.lastChaseInput < CHASE_LOOK_RETURN_S) return;
    const k = 1 - Math.exp(-dt / 0.6);
    // Shortest way back to the default heading.
    const yaw = Math.atan2(Math.sin(this.chaseYawOffset), Math.cos(this.chaseYawOffset));
    this.chaseYawOffset = yaw - yaw * k;
    this.chasePitch += (CHASE_DEFAULT_PITCH_RAD - this.chasePitch) * k;
    this.chaseDistance += (CHASE_DEFAULT_DISTANCE_M - this.chaseDistance) * k;
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
