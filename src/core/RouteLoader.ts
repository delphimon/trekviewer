import * as THREE from 'three';
import { GPXParser } from '../gpx/GPXParser.ts';
import { TerrainGenerator, type TerrainResult } from '../terrain/TerrainGenerator.ts';
import { ElevationTileService } from '../terrain/ElevationTiles.ts';
import { TrailMesh, type TrailResult } from '../visualization/TrailMesh.ts';
import { DioramaBase } from '../visualization/DioramaBase.ts';
import { FlyoverController } from '../visualization/FlyoverController.ts';
import { LoadedTrek } from './LoadedTrek.ts';
import type { TrekSession } from './TrekSession.ts';
import type { SceneManager } from './SceneManager.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';

export interface RouteLoadContext {
  readonly generationId: number;
  readonly abortController: AbortController;
  readonly routeId: string;
  readonly routeName: string;
  isAborted(): boolean;
}

export class RouteLoader {
  private session: TrekSession;
  private sceneManager: SceneManager;
  private currentContext: RouteLoadContext | null = null;
  private activeTrek: LoadedTrek | null = null;
  private nextGenerationId: number = 1;

  constructor(session: TrekSession, sceneManager: SceneManager) {
    this.session = session;
    this.sceneManager = sceneManager;
  }

  public getActiveTrek(): LoadedTrek | null {
    return this.activeTrek;
  }

  public cancelCurrentLoad(): void {
    if (this.currentContext && !this.currentContext.isAborted()) {
      this.currentContext.abortController.abort();
      this.currentContext = null;
    }
  }

  public async loadRouteFromUrl(
    url: string,
    fallbackName: string,
    routeId: string = url
  ): Promise<LoadedTrek | null> {
    const context = this.createContext(routeId, fallbackName);

    try {
      this.session.setLoadingStatus('parsing', `Loading trek: ${fallbackName}...`, 0.05);

      const resp = await fetch(url, { signal: context.abortController.signal });
      if (!resp.ok) throw new Error(`HTTP error ${resp.status} while fetching route.`);

      if (context.isAborted()) return null;

      const xml = await resp.text();
      return await this.loadRouteFromXml(xml, fallbackName, routeId, 'manifest', context);
    } catch (e: any) {
      if (context.isAborted()) {
        return null;
      }
      console.error('Failed to load route from URL:', e);
      this.session.setLoadingStatus('error', `Failed to load ${fallbackName}: ${e.message}`, null, true);
      return null;
    }
  }

  public async loadRouteFromXml(
    xml: string,
    fallbackName: string = 'Custom GPX Route',
    routeId: string = 'upload',
    source: 'manifest' | 'upload' = 'upload',
    existingContext?: RouteLoadContext
  ): Promise<LoadedTrek | null> {
    const context = existingContext ?? this.createContext(routeId, fallbackName);

    let terrain: TerrainResult | null = null;
    let trail: TrailResult | null = null;
    let base: THREE.Group | null = null;
    let newTrek: LoadedTrek | null = null;
    let committed = false;

    try {
      // 1. Parse & Validate GPX
      this.session.setLoadingStatus('parsing', 'Parsing GPX survey track...', 0.1);
      if (context.isAborted()) return null;

      const raw = GPXParser.parseRaw(xml, fallbackName);
      let track = GPXParser.finalizeWithDEM(raw);

      this.session.setLoadingStatus('validating', `Survey validated: ${track.points.length.toLocaleString()} points`, 0.15);
      if (context.isAborted()) return null;

      // 2. Generate 3D Terrain off-scene
      const isXR = this.sceneManager.renderer.xr.isPresenting;
      const initialExaggeration = this.session.getState().verticalExaggeration;
      const initialStyle = this.session.getState().textureStyle;

      terrain = await TerrainGenerator.generate(
        track,
        (msg, progress) => {
          if (!context.isAborted()) {
            const currentPhase = this.session.getState().loadingPhase;
            const phase = currentPhase === 'ready' ? 'ready' : 'terrain';
            this.session.setLoadingStatus(phase, msg, progress ?? null);
          }
        },
        context.abortController.signal,
        initialExaggeration,
        isXR
      );

      if (context.isAborted()) {
        terrain.dispose();
        terrain = null;
        return null;
      }

      // If user had a non-default texture style selected, preserve it
      if (initialStyle !== 'satellite') {
        terrain.setTextureStyle(initialStyle).catch(() => {});
      }

      // If any points originally lacked elevation, refine track using real DEM grid
      const hadMissingEle = raw.rawSegments.some((seg) => seg.some((p) => p.rawEle === undefined));
      if (hadMissingEle && terrain.demGrid) {
        const demSampler = (lat: number, lon: number) => {
          const s = ElevationTileService.sampleElevation(terrain!.demGrid!, lat, lon);
          return s.isValid ? s.elevation : undefined;
        };
        track = GPXParser.finalizeWithDEM(raw, demSampler);
      }

      // 3. Generate 3D Trail Mesh off-scene
      this.session.setLoadingStatus('terrain', 'Building trail geometry...', 0.85);
      trail = TrailMesh.create(track, terrain.elevationSampler, terrain.terrainBaseElevation);
      trail.setColorMode(this.session.getState().trailColorMode);
      trail.setViewMode(this.session.getState().viewMode);
      if (initialExaggeration !== 1.0) {
        trail.setVerticalExaggeration(initialExaggeration);
      }

      if (context.isAborted()) {
        terrain.dispose();
        terrain = null;
        trail.dispose();
        trail = null;
        return null;
      }

      // 4. Generate Diorama Base Pedestal
      base = DioramaBase.create(
        track.bounds,
        -80,
        track.waypoints.concat(track.landmarks),
        terrain.terrainBaseElevation,
        terrain.elevationSampler,
        initialExaggeration
      );

      if (context.isAborted()) {
        terrain.dispose();
        terrain = null;
        trail.dispose();
        trail = null;
        disposeObject3D(base);
        base = null;
        return null;
      }

      // 5. Setup Flyover Controller
      const flyover = new FlyoverController(
        trail,
        track,
        this.session.getState().playbackSpeed
      );
      flyover.setViewMode(this.session.getState().viewMode);

      // 6. Bundle into LoadedTrek
      newTrek = new LoadedTrek(track, terrain, trail, base, flyover);

      // Verify this is still the active transaction before committing to the live scene
      if (this.currentContext?.generationId !== context.generationId || context.isAborted()) {
        newTrek.dispose();
        newTrek = null;
        return null;
      }

      // 7. Atomic scene replacement:
      // Clear dioramaRoot and attach the new trek's group
      while (this.sceneManager.dioramaRoot.children.length > 0) {
        this.sceneManager.dioramaRoot.remove(this.sceneManager.dioramaRoot.children[0]);
      }

      this.sceneManager.dioramaRoot.add(newTrek.group);
      committed = true;

      // Dispose previous trek's resources now that new trek is active
      const oldTrek = this.activeTrek;
      this.activeTrek = newTrek;
      if (oldTrek) {
        oldTrek.dispose();
      }

      // 8. Update authoritative session state
      this.session.setTrack(track, routeId, source);
      this.session.setTerrainQuality(terrain.terrainQuality);

      const bounds = track.bounds;
      const margin = 0.25;
      const widthM = Math.max(bounds.widthMeters * (1 + margin * 2), 1500);
      const depthM = Math.max(bounds.depthMeters * (1 + margin * 2), 1500);
      this.sceneManager.setDioramaVolume({
        halfWidthM: widthM / 2,
        halfDepthM: depthM / 2,
        minY: -110,
        maxY: Math.max(bounds.elevationSpan + 100, 500),
      });

      const maxDim = Math.max(bounds.widthMeters, bounds.depthMeters);
      this.sceneManager.setViewMode(this.session.getState().viewMode, maxDim);

      this.session.setLoadingStatus(
        'ready',
        `Loaded: ${track.name} (${(track.totalDistance * 0.000621371).toFixed(1)} mi, +${Math.round(track.elevationGain * 3.28084).toLocaleString()} ft)`,
        1.0
      );

      return newTrek;
    } catch (e: any) {
      if (!committed) {
        if (newTrek) {
          (newTrek as LoadedTrek).dispose();
        } else {
          terrain?.dispose();
          trail?.dispose();
          if (base) disposeObject3D(base);
        }
      }
      if (context.isAborted()) {
        return null;
      }
      console.error('Error in route loader:', e);
      this.session.setLoadingStatus('error', `Error loading route: ${e.message}`, null, true);
      return null;
    }
  }

  private createContext(routeId: string, routeName: string): RouteLoadContext {
    // Abort previous loading operation
    this.cancelCurrentLoad();

    const generationId = this.nextGenerationId++;
    const abortController = new AbortController();

    const context: RouteLoadContext = {
      generationId,
      abortController,
      routeId,
      routeName,
      isAborted: () => abortController.signal.aborted,
    };

    this.currentContext = context;
    return context;
  }
}
