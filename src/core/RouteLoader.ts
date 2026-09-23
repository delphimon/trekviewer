import * as THREE from 'three';
import type { TrackStats, TrailColorMode } from '../gpx/TrackTypes.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import { TerrainGenerator, type TerrainResult } from '../terrain/TerrainGenerator.ts';
import { TrailMesh, type TrailResult } from '../visualization/TrailMesh.ts';
import { DioramaBase } from '../visualization/DioramaBase.ts';
import { FlyoverController } from '../visualization/FlyoverController.ts';
import { LoadedTrek } from './LoadedTrek.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';

export interface RouteLoaderOptions {
  dioramaRoot: THREE.Group;
  getIsXR: () => boolean;
  getCurrentTrailColorMode?: () => TrailColorMode;
  onProgress?: (message: string, progress?: number | null) => void;
  onError?: (error: Error, routeName?: string) => void;
  onTrekCommitted?: (trek: LoadedTrek, previousTrek: LoadedTrek | null) => void;
}

export interface RouteLoadContext {
  generationId: number;
  abortController: AbortController;
  routeId?: string;
  routeName?: string;
}

/**
 * RouteLoader provides transactional, atomic route loading.
 *
 * Guarantees:
 * 1. Off-Scene Generation: All assets (GPX, terrain DEM, trail ribbon, plinth) are constructed off-scene.
 * 2. Scene Continuity: The active diorama remains mounted, rendered, and interactive during route loads.
 * 3. Atomic Commit: When ready, the active diorama is atomically swapped with zero blank frames.
 * 4. Error Rollback: Failures dispose off-scene partials and preserve the active trek without disruption.
 * 5. Generation-ID Cancellation: Superseded requests are cancelled and discarded immediately.
 */
export class RouteLoader {
  private options: RouteLoaderOptions;
  private activeTrek: LoadedTrek | null = null;
  private currentContext: RouteLoadContext | null = null;
  private nextGenerationId: number = 0;

  constructor(options: RouteLoaderOptions) {
    this.options = options;
  }

  public getActiveTrek(): LoadedTrek | null {
    return this.activeTrek;
  }

  public isStale(context: RouteLoadContext): boolean {
    return context.abortController.signal.aborted || context.generationId !== this.currentContext?.generationId;
  }

  private isAbortError(e: any): boolean {
    return (
      e?.name === 'AbortError' ||
      (typeof e?.message === 'string' && e.message.toLowerCase().includes('abort'))
    );
  }

  public abortActiveLoad(): void {
    if (this.currentContext) {
      this.currentContext.abortController.abort();
      this.currentContext = null;
    }
  }

  public async loadRouteFromUrl(
    url: string,
    fallbackName?: string,
    routeId?: string
  ): Promise<LoadedTrek | null> {
    this.abortActiveLoad();

    const generationId = ++this.nextGenerationId;
    const abortController = new AbortController();
    const context: RouteLoadContext = {
      generationId,
      abortController,
      routeId,
      routeName: fallbackName,
    };
    this.currentContext = context;

    this.options.onProgress?.(`Fetching trek: ${fallbackName || 'route'}...`, 0.05);

    try {
      const resp = await fetch(url, { signal: abortController.signal });
      if (!resp.ok) {
        throw new Error(`HTTP error ${resp.status}: Could not fetch route from ${url}`);
      }
      const xml = await resp.text();

      if (this.isStale(context)) {
        return null;
      }

      return await this.loadRouteFromXml(xml, fallbackName, routeId, context);
    } catch (err: any) {
      if (this.isAbortError(err) || this.isStale(context)) {
        console.log(`[RouteLoader] Route load aborted: ${fallbackName || url}`);
        return null;
      }
      console.error('[RouteLoader] Failed to fetch route:', err);
      this.options.onError?.(err, fallbackName);
      return null;
    }
  }

  public async loadRouteFromXml(
    xml: string,
    fallbackName?: string,
    routeId?: string,
    existingContext?: RouteLoadContext
  ): Promise<LoadedTrek | null> {
    let context = existingContext;
    if (!context) {
      this.abortActiveLoad();
      context = {
        generationId: ++this.nextGenerationId,
        abortController: new AbortController(),
        routeId,
        routeName: fallbackName,
      };
      this.currentContext = context;
    }

    let terrain: TerrainResult | null = null;
    let trail: TrailResult | null = null;
    let base: THREE.Group | null = null;
    let trek: LoadedTrek | null = null;

    try {
      this.options.onProgress?.('Parsing GPX survey track...', 0.1);
      const track = GPXParser.parse(xml, fallbackName);

      if (this.isStale(context)) {
        return null;
      }

      // 1. Generate 3D Terrain off-scene
      const isXR = this.options.getIsXR();
      terrain = await TerrainGenerator.generate(
        track,
        (msg, progress) => {
          if (!this.isStale(context!)) {
            this.options.onProgress?.(msg, progress);
          }
        },
        context.abortController.signal,
        1.0,
        isXR
      );

      if (this.isStale(context)) {
        terrain.dispose();
        return null;
      }

      // 2. Generate 3D Trail Mesh off-scene
      trail = TrailMesh.create(track, terrain.elevationSampler, terrain.terrainBaseElevation);
      const trailColorMode = this.options.getCurrentTrailColorMode
        ? this.options.getCurrentTrailColorMode()
        : 'grade';
      trail.setColorMode(trailColorMode);

      if (this.isStale(context)) {
        terrain.dispose();
        trail.dispose();
        return null;
      }

      // 3. Generate Diorama Base Pedestal off-scene
      base = DioramaBase.create(
        track.bounds,
        -80,
        track.waypoints,
        terrain.terrainBaseElevation,
        terrain.elevationSampler,
        1.0
      );

      if (this.isStale(context)) {
        terrain.dispose();
        trail.dispose();
        disposeObject3D(base);
        return null;
      }

      // 4. Setup Flyover Controller
      const flyoverController = new FlyoverController(trail, track);

      // 5. Assemble LoadedTrek off-scene
      trek = new LoadedTrek({
        track,
        terrainResult: terrain,
        trailResult: trail,
        dioramaBase: base,
        flyoverController,
      });

      if (this.isStale(context)) {
        trek.dispose();
        return null;
      }

      // 6. ATOMIC SCENE COMMIT
      // Active diorama remains mounted and rendered until this atomic step.
      const previousTrek = this.activeTrek;
      if (previousTrek) {
        this.options.dioramaRoot.remove(previousTrek.group);
      }
      this.options.dioramaRoot.add(trek.group);
      this.activeTrek = trek;

      // Dispose previous trek only AFTER new trek is mounted
      if (previousTrek) {
        previousTrek.dispose();
      }

      // Notify caller of successful commit
      this.options.onTrekCommitted?.(trek, previousTrek);
      return trek;
    } catch (err: any) {
      // Rollback: dispose any off-scene partial assets
      if (trek) {
        trek.dispose();
      } else {
        if (base) disposeObject3D(base);
        if (trail) trail.dispose();
        if (terrain) terrain.dispose();
      }

      if (this.isAbortError(err) || this.isStale(context)) {
        console.log(`[RouteLoader] Load aborted during assembly: ${fallbackName}`);
        return null;
      }

      console.error('[RouteLoader] Failed to build trek:', err);
      this.options.onError?.(err, fallbackName);
      return null;
    }
  }

  public dispose(): void {
    this.abortActiveLoad();
    if (this.activeTrek) {
      this.options.dioramaRoot.remove(this.activeTrek.group);
      this.activeTrek.dispose();
      this.activeTrek = null;
    }
  }
}
