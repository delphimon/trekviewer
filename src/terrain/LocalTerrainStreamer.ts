import type { TerrainResult } from './TerrainGenerator.ts';
import type { ElevationGrid } from './ElevationTiles.ts';
import { LocalTerrainChunk } from './LocalTerrainChunk.ts';
import type { RouteGeometry } from '../visualization/RouteGeometry.ts';
import { type QualityProfile, QualityProfileManager } from './QualityProfile.ts';

export interface LocalTerrainStreamerOptions {
  terrainResult: TerrainResult;
  routeGeometry: RouteGeometry;
  demGrid: ElevationGrid;
  qualityProfile?: QualityProfile;
  chunkRadiusM?: number;
  maxChunks?: number;
  evalThresholdM?: number;
}

/**
 * LocalTerrainStreamer (Stage W6)
 *
 * Implements rolling multi-chunk streaming of high-resolution local DEM geometry
 * (1000–1500m radius) along the active hiking route without geometry seams.
 *
 * Architecture:
 * - Maintains 2-3 overlapping LocalTerrainChunk instances positioned at:
 *   1. Behind hiker (retention corridor)
 *   2. Current hiker position
 *   3. Ahead of hiker (forward prefetch corridor)
 * - Seamless edge blending via Hermite smoothstep to base terrain elevation.
 * - Dynamic rolling eviction: oldest/furthest chunks are smoothly detached and disposed
 *   as the hiker progresses along the route.
 */
export class LocalTerrainStreamer {
  public readonly terrainResult: TerrainResult;
  public readonly routeGeometry: RouteGeometry;
  public readonly demGrid: ElevationGrid;
  public readonly qualityProfile: QualityProfile;
  public readonly chunkRadiusM: number;
  public readonly maxChunks: number;
  public readonly evalThresholdM: number;

  private managedChunks: LocalTerrainChunk[] = [];
  private lastEvalProgress: number = -1;
  private currentExaggeration: number = 1.0;
  private isDisposed: boolean = false;

  constructor(options: LocalTerrainStreamerOptions) {
    this.terrainResult = options.terrainResult;
    this.routeGeometry = options.routeGeometry;
    this.demGrid = options.demGrid;
    this.qualityProfile =
      options.qualityProfile || QualityProfileManager.getDefaultProfile(false);
    this.chunkRadiusM =
      options.chunkRadiusM ?? this.qualityProfile.localTerrainRadiusM;
    this.maxChunks = options.maxChunks ?? 3;
    this.evalThresholdM = options.evalThresholdM ?? 30; // 30m progress threshold
  }

  public get activeChunks(): readonly LocalTerrainChunk[] {
    return this.managedChunks;
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed) return;
    this.currentExaggeration = factor;
    for (const chunk of this.managedChunks) {
      chunk.setVerticalExaggeration(factor);
    }
  }

  /**
   * Updates streaming stations along the route based on hiker progress [0, 1].
   */
  public update(currentProgress: number): void {
    if (this.isDisposed || !this.demGrid) return;

    const totalDist = this.routeGeometry.totalDistance;
    if (totalDist <= 0) return;

    const progressDistMoved =
      this.lastEvalProgress >= 0
        ? Math.abs(currentProgress - this.lastEvalProgress) * totalDist
        : Infinity;

    if (progressDistMoved < this.evalThresholdM && this.managedChunks.length > 0) {
      return;
    }
    this.lastEvalProgress = currentProgress;

    const hikerTele = this.routeGeometry.getTelemetryAtProgress(currentProgress);
    const hikerDist = currentProgress * totalDist;

    // Station spacing: ~90% of radius to maintain 20-30% continuous overlap between adjacent chunks
    const stationSpacing = this.chunkRadiusM * 0.9;

    const stationDistances: number[] = [hikerDist];
    if (hikerDist + stationSpacing <= totalDist + stationSpacing * 0.5) {
      stationDistances.push(Math.min(totalDist, hikerDist + stationSpacing));
    }
    if (hikerDist - stationSpacing >= -stationSpacing * 0.5) {
      stationDistances.push(Math.max(0, hikerDist - stationSpacing));
    }

    // Ensure stations are ordered: current position first, then ahead, then behind
    const stationCoords = stationDistances.map((dist) => {
      const prog = Math.max(0, Math.min(1, dist / totalDist));
      const tele = this.routeGeometry.getTelemetryAtProgress(prog);
      return {
        lat: tele.currentPoint.lat,
        lon: tele.currentPoint.lon,
        dist,
      };
    });

    const neededChunks: LocalTerrainChunk[] = [];
    const availableChunks = [...this.managedChunks];

    for (const station of stationCoords) {
      // Find existing chunk closest to this station
      let bestIdx = -1;
      let bestDist = Infinity;

      for (let i = 0; i < availableChunks.length; i++) {
        const c = availableChunks[i];
        const latDiff = (c.centerLat - station.lat) * 111320;
        const lonDiff =
          (c.centerLon - station.lon) *
          111320 *
          Math.cos((station.lat * Math.PI) / 180);
        const d = Math.hypot(latDiff, lonDiff);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }

      // If an existing chunk is within 60% of radius, reuse it
      if (bestIdx !== -1 && bestDist <= this.chunkRadiusM * 0.6) {
        neededChunks.push(availableChunks[bestIdx]);
        availableChunks.splice(bestIdx, 1);
      } else {
        // Create new high-resolution chunk
        const newChunk = new LocalTerrainChunk({
          localGrid: this.demGrid,
          centerLat: station.lat,
          centerLon: station.lon,
          referenceCenterLat:
            this.terrainResult.terrainGeoBounds?.centerLat ?? station.lat,
          referenceCenterLon:
            this.terrainResult.terrainGeoBounds?.centerLon ?? station.lon,
          terrainBaseElevation: this.terrainResult.terrainBaseElevation,
          radiusMeters: this.chunkRadiusM,
          baseElevationSampler: (x, z) =>
            this.terrainResult.elevationSampler(x, z),
          initialExaggeration: this.currentExaggeration,
        });

        this.terrainResult.attachLocalChunk?.(newChunk);
        neededChunks.push(newChunk);
      }
    }

    // Available chunks not needed for the current stations are candidates for eviction
    // Enforce maxChunks budget
    while (neededChunks.length + availableChunks.length > this.maxChunks) {
      if (availableChunks.length > 0) {
        const staleChunk = availableChunks.pop()!;
        this.terrainResult.detachLocalChunk?.(staleChunk);
      } else {
        // If neededChunks itself exceeds maxChunks, trim furthest from hiker
        neededChunks.sort((a, b) => {
          const distA = Math.hypot(
            a.localCenter.x - hikerTele.position.x,
            a.localCenter.z - hikerTele.position.z
          );
          const distB = Math.hypot(
            b.localCenter.x - hikerTele.position.x,
            b.localCenter.z - hikerTele.position.z
          );
          return distA - distB;
        });
        const excess = neededChunks.pop()!;
        this.terrainResult.detachLocalChunk?.(excess);
      }
    }

    this.managedChunks = [...neededChunks, ...availableChunks];
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const chunk of this.managedChunks) {
      this.terrainResult.detachLocalChunk?.(chunk);
    }
    this.managedChunks = [];
  }
}
