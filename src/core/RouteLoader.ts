import * as THREE from 'three';
import type { TrackStats, TrailColorMode } from '../gpx/TrackTypes.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import { TerrainGenerator, type TerrainResult } from '../terrain/TerrainGenerator.ts';
import { TrailMesh, type TrailResult } from '../visualization/TrailMesh.ts';
import { DioramaBase } from '../visualization/DioramaBase.ts';
import { FlyoverController } from '../visualization/FlyoverController.ts';
import { LoadedTrek } from './LoadedTrek.ts';
import { TrekSession } from './TrekSession.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';
import { resolveAssetUrl } from '../utils/AssetUrl.ts';

export interface RouteLoaderOptions {
  dioramaRoot: THREE.Group;
  getIsXR: () => boolean;
  getCurrentTrailColorMode?: () => TrailColorMode;
  session?: TrekSession;
  onProgress?: (message: string, progress?: number | null) => void;
  onError?: (error: Error, routeName?: string) => void;
  onTrekCommitted?: (trek: LoadedTrek, previousTrek: LoadedTrek | null) => void;
}

export interface RouteLoadContext {
  generationId: number;
  abortController: AbortController;
  routeId?: string;
  routeName?: string;
  source: 'manifest' | 'upload';
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
      source: 'manifest',
    };
    this.currentContext = context;

    this.options.session?.setLoadingStatus('parsing', `Fetching trek: ${fallbackName || 'route'}...`, 0.05);
    this.options.onProgress?.(`Fetching trek: ${fallbackName || 'route'}...`, 0.05);

    try {
      const targetUrl = resolveAssetUrl(url);
      const resp = await fetch(targetUrl, { signal: abortController.signal });
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
      this.options.session?.setLoadingStatus('error', err.message, null, true);
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
        routeId: routeId || (fallbackName ? `upload:${fallbackName}` : `upload:${Date.now()}`),
        routeName: fallbackName,
        source: 'upload',
      };
      this.currentContext = context;
    }

    let terrain: TerrainResult | null = null;
    let trail: TrailResult | null = null;
    let base: THREE.Group | null = null;
    let trek: LoadedTrek | null = null;

    try {
      this.options.session?.setLoadingStatus('parsing', 'Parsing GPX survey track...', 0.05);
      this.options.onProgress?.('Parsing GPX survey track...', 0.05);

      // 1. Phase 1: Parse raw GPX survey track without requiring DEM
      const raw = GPXParser.parseRaw(xml, fallbackName);

      if (this.isStale(context)) {
        return null;
      }

      // Calculate raw geographic bounds to establish DEM footprint
      const rawBounds = GPXParser.calculateRawBounds(raw);

      // 2. Obtain DEM elevation coverage covering the route bounds
      const preparedElevation = await TerrainGenerator.prepareElevation(
        rawBounds,
        (msg, progress) => {
          if (!this.isStale(context!)) {
            this.options.session?.setLoadingStatus('terrain', msg, progress);
            this.options.onProgress?.(msg, progress);
          }
        },
        context.abortController.signal
      );

      if (this.isStale(context)) {
        return null;
      }

      // 3. Phase 2: Finalize track metrics and missing elevations using real DEM sampler
      this.options.session?.setLoadingStatus('parsing', 'Normalizing elevations with DEM surface...', 0.45);
      this.options.onProgress?.('Normalizing elevations with DEM surface...', 0.45);
      const track = GPXParser.finalizeWithDEM(raw, preparedElevation.elevationSamplerForGeo);

      if (this.isStale(context)) {
        return null;
      }

      // 4. Generate 3D Terrain off-scene reusing the prepared DEM grid
      const isXR = this.options.getIsXR();
      terrain = await TerrainGenerator.generate(
        track,
        (msg, progress) => {
          if (!this.isStale(context!)) {
            // Only update session loading status if this trek has not yet been committed to scene.
            // Post-commit background satellite streaming must not regress loadingPhase from 'ready' to 'terrain'.
            if (this.activeTrek !== trek) {
              this.options.session?.setLoadingStatus('terrain', msg, progress);
            }
            this.options.onProgress?.(msg, progress);
          }
        },
        context.abortController.signal,
        1.0,
        isXR,
        preparedElevation
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
      // Combine explicit waypoints with prominent derived landmarks (Start, Summit/High Point, Finish) (Requirement #117)
      const allWaypoints = [...track.waypoints];
      for (const lm of track.landmarks) {
        if (lm.type === 'summit' || lm.type === 'high_point' || lm.type === 'start' || lm.type === 'finish' || lm.type === 'day_boundary') {
          const isDuplicate = allWaypoints.some(
            (w) => Math.hypot(w.lat - lm.lat, w.lon - lm.lon) < 0.0005
          );
          if (!isDuplicate) {
            allWaypoints.push(lm);
          }
        }
      }

      base = DioramaBase.create(
        track.bounds,
        -80,
        allWaypoints,
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

      if (this.options.session) {
        this.options.session.setTerrainQuality(terrain.terrainQuality);
        const effectiveRouteId = context.routeId || routeId || (context.source === 'manifest' ? track.name : `upload:${track.name}`);
        this.options.session.setTrack(track, effectiveRouteId, context.source);
        this.options.session.setLoadingStatus('ready', `Loaded: ${track.name}`, 1.0);
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

      this.options.session?.setLoadingStatus('error', err.message, null, true);
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
