import type { GeoBounds } from '../gpx/TrackTypes.ts';
import { latLonToTile, localMetersToGeo } from '../gpx/Coordinates.ts';
import { AWSTerrariumElevationProvider } from './providers/ImageryProvider.ts';
import { TileImageCache } from './TileImageCache.ts';

export interface LocalDEMQuality {
  validTileRatio: number;
  totalTiles: number;
  validTiles: number;
  zoom: number;
}

export interface ElevationGrid {
  width: number;
  height: number;
  zoom: number;
  tileXMin: number;
  tileXMax: number;
  tileYMin: number;
  tileYMax: number;
  numTilesX: number;
  numTilesY: number;
  data: Float32Array;
  tileValidity: Uint8Array;
  minElevation: number;
  maxElevation: number;
  isRealDEM: boolean;
  quality?: LocalDEMQuality;
}

export interface ElevationSampleResult {
  elevation: number;
  isValid: boolean;
}

export class ElevationTileService {
  private static elevationProvider = new AWSTerrariumElevationProvider();

  /**
   * Fetches real-world AWS Terrarium DEM tiles covering the bounding box.
   * Tracks tile validity to prevent failed tiles from decoding as -32768m craters.
   */
  public static async fetchElevationGrid(
    bounds: GeoBounds,
    marginRatio: number = 0.25,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<ElevationGrid | null> {
    try {
      const latMargin = (bounds.maxLat - bounds.minLat) * marginRatio;
      const lonMargin = (bounds.maxLon - bounds.minLon) * marginRatio;
      const minLat = bounds.minLat - latMargin;
      const maxLat = bounds.maxLat + latMargin;
      const minLon = bounds.minLon - lonMargin;
      const maxLon = bounds.maxLon + lonMargin;

      const latSpan = maxLat - minLat;
      let zoom = 12;
      if (latSpan > 0.4) zoom = 11;
      if (latSpan < 0.1) zoom = 13;

      const minTile = latLonToTile(maxLat, minLon, zoom);
      const maxTile = latLonToTile(minLat, maxLon, zoom);

      let tileXMin = Math.min(minTile.x, maxTile.x);
      let tileXMax = Math.max(minTile.x, maxTile.x);
      let tileYMin = Math.min(minTile.y, maxTile.y);
      let tileYMax = Math.max(minTile.y, maxTile.y);

      let numTilesX = tileXMax - tileXMin + 1;
      let numTilesY = tileYMax - tileYMin + 1;

      const MAX_DEM_TILES = 25;
      const MIN_DEM_ZOOM = 10;
      while (numTilesX * numTilesY > MAX_DEM_TILES && zoom > MIN_DEM_ZOOM) {
        zoom--;
        const minT = latLonToTile(maxLat, minLon, zoom);
        const maxT = latLonToTile(minLat, maxLon, zoom);
        tileXMin = Math.min(minT.x, maxT.x);
        tileXMax = Math.max(minT.x, maxT.x);
        tileYMin = Math.min(minT.y, maxT.y);
        tileYMax = Math.max(minT.y, maxT.y);
        numTilesX = tileXMax - tileXMin + 1;
        numTilesY = tileYMax - tileYMin + 1;
      }

      return await this.decodeTileGrid(
        zoom,
        tileXMin,
        tileXMax,
        tileYMin,
        tileYMax,
        bounds.minEle,
        bounds.maxEle,
        onProgress,
        signal
      );
    } catch (e) {
      console.warn('Failed to fetch elevation tiles:', e);
      return null;
    }
  }

  private static localDemGridCache = new Map<string, ElevationGrid>();
  private static readonly MAX_GRID_CACHE_ENTRIES = 24;

  public static clearLocalGridCache(): void {
    this.localDemGridCache.clear();
  }

  /**
   * Fetches a bounded local high-resolution DEM chunk around a specific route coordinate (Stage V7 & X2).
   * Used for high-fidelity terrain geometry and micro-terrain elevation sampling around 1:1 first-person view.
   * Scales tile budget to quality profile (prefer Terrarium z15, fallback to z14 if budget exceeded).
   */
  public static async fetchLocalElevationGrid(
    centerLat: number,
    centerLon: number,
    radiusMeters: number = 1250,
    targetZoom: number = 15,
    maxTilesOrSignal?: number | AbortSignal,
    signal?: AbortSignal
  ): Promise<ElevationGrid | null> {
    try {
      let maxTiles = 16;
      let effectiveSignal = signal;
      if (typeof maxTilesOrSignal === 'number') {
        maxTiles = maxTilesOrSignal;
      } else if (maxTilesOrSignal && typeof maxTilesOrSignal === 'object' && 'aborted' in maxTilesOrSignal) {
        effectiveSignal = maxTilesOrSignal;
      }

      let zoom = Math.max(12, Math.min(15, targetZoom));
      const nw = localMetersToGeo(-radiusMeters, -radiusMeters, centerLat, centerLon);
      const se = localMetersToGeo(radiusMeters, radiusMeters, centerLat, centerLon);

      const minLat = Math.min(nw.lat, se.lat);
      const maxLat = Math.max(nw.lat, se.lat);
      const minLon = Math.min(nw.lon, se.lon);
      const maxLon = Math.max(nw.lon, se.lon);

      let minTile = latLonToTile(maxLat, minLon, zoom);
      let maxTile = latLonToTile(minLat, maxLon, zoom);
      let tileXMin = Math.min(minTile.x, maxTile.x);
      let tileXMax = Math.max(minTile.x, maxTile.x);
      let tileYMin = Math.min(minTile.y, maxTile.y);
      let tileYMax = Math.max(minTile.y, maxTile.y);

      let numTilesX = tileXMax - tileXMin + 1;
      let numTilesY = tileYMax - tileYMin + 1;

      // Bound local chunk to profile budget (prefer Terrarium z15, fallback to z14 if exceeded)
      const allowedTiles = Math.max(4, maxTiles);
      while (numTilesX * numTilesY > allowedTiles && zoom > 12) {
        zoom--;
        minTile = latLonToTile(maxLat, minLon, zoom);
        maxTile = latLonToTile(minLat, maxLon, zoom);
        tileXMin = Math.min(minTile.x, maxTile.x);
        tileXMax = Math.max(minTile.x, maxTile.x);
        tileYMin = Math.min(minTile.y, maxTile.y);
        tileYMax = Math.max(minTile.y, maxTile.y);
        numTilesX = tileXMax - tileXMin + 1;
        numTilesY = tileYMax - tileYMin + 1;
      }

      const cacheKey = `${zoom}_${tileXMin}_${tileXMax}_${tileYMin}_${tileYMax}`;
      const cached = this.localDemGridCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const grid = await this.decodeTileGrid(
        zoom,
        tileXMin,
        tileXMax,
        tileYMin,
        tileYMax,
        0,
        4000,
        undefined,
        effectiveSignal
      );

      // Stage X3.1: Reject incomplete local DEM grids (< 70% valid tiles) to prevent terrain holes/cliffs
      if (grid && grid.quality && grid.quality.validTileRatio < 0.70) {
        console.warn(
          `[ElevationTileService] Rejecting local DEM: coverage too low (${(grid.quality.validTileRatio * 100).toFixed(1)}% < 70%)`
        );
        return null;
      }

      if (grid) {
        if (this.localDemGridCache.size >= this.MAX_GRID_CACHE_ENTRIES) {
          const firstKey = this.localDemGridCache.keys().next().value;
          if (firstKey) this.localDemGridCache.delete(firstKey);
        }
        this.localDemGridCache.set(cacheKey, grid);
      }

      return grid;
    } catch (e) {
      console.warn('Failed to fetch local elevation chunk:', e);
      return null;
    }
  }

  private static async decodeTileGrid(
    zoom: number,
    tileXMin: number,
    tileXMax: number,
    tileYMin: number,
    tileYMax: number,
    fallbackMinEle: number,
    fallbackMaxEle: number,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<ElevationGrid | null> {
    const numTilesX = tileXMax - tileXMin + 1;
    const numTilesY = tileYMax - tileYMin + 1;

    const TILE_SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = numTilesX * TILE_SIZE;
    canvas.height = numTilesY * TILE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const totalTiles = numTilesX * numTilesY;
    const tileValidity = new Uint8Array(totalTiles);
    let loadedTiles = 0;
    let successCount = 0;

    // Bound DEM request concurrency to a 6-worker pool (Requirement #100)
    const CONCURRENCY = 6;
    const tileTasks: { tx: number; ty: number; tileIdx: number }[] = [];
    for (let ty = tileYMin; ty <= tileYMax; ty++) {
      for (let tx = tileXMin; tx <= tileXMax; tx++) {
        const tileIdx = (ty - tileYMin) * numTilesX + (tx - tileXMin);
        tileTasks.push({ tx, ty, tileIdx });
      }
    }

    let nextTaskIdx = 0;
    const worker = async () => {
      while (nextTaskIdx < tileTasks.length) {
        if (signal?.aborted) return;
        const task = tileTasks[nextTaskIdx++];
        try {
          const img = await TileImageCache.loadTile(
            this.elevationProvider,
            zoom,
            task.tx,
            task.ty,
            4000,
            signal
          );
          if (signal?.aborted) return;
          const dx = (task.tx - tileXMin) * TILE_SIZE;
          const dy = (task.ty - tileYMin) * TILE_SIZE;
          ctx.drawImage(img, dx, dy);
          tileValidity[task.tileIdx] = 1;
          successCount++;
        } catch {
          // Mark tile as invalid; no drawing occurs
          tileValidity[task.tileIdx] = 0;
        } finally {
          loadedTiles++;
          onProgress?.(loadedTiles, totalTiles);
        }
      }
    };

    const workerCount = Math.min(CONCURRENCY, tileTasks.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    if (signal?.aborted || successCount === 0) {
      return null;
    }

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imgData.data;
    const gridW = canvas.width;
    const gridH = canvas.height;
    const data = new Float32Array(gridW * gridH);

    let minEle = Infinity;
    let maxEle = -Infinity;

    // Decode Terrarium: elevation = (R * 256 + G + B / 256) - 32768
    for (let py = 0; py < gridH; py++) {
      const tyOffset = Math.floor(py / TILE_SIZE);
      for (let px = 0; px < gridW; px++) {
        const txOffset = Math.floor(px / TILE_SIZE);
        const tileIdx = tyOffset * numTilesX + txOffset;
        const idx = py * gridW + px;

        if (tileValidity[tileIdx] === 0) {
          // Missing tile: store NaN so it never acts as -32768m
          data[idx] = NaN;
          continue;
        }

        const r = pixels[idx * 4];
        const g = pixels[idx * 4 + 1];
        const b = pixels[idx * 4 + 2];
        const decoded = (r * 256 + g + b / 256) - 32768;

        // Black pixel guard: Terrarium (0,0,0) decodes to -32768
        if (decoded < -1000) {
          data[idx] = NaN;
        } else {
          data[idx] = decoded;
          minEle = Math.min(minEle, decoded);
          maxEle = Math.max(maxEle, decoded);
        }
      }
    }

    const validTileRatio = totalTiles > 0 ? successCount / totalTiles : 0;
    const quality: LocalDEMQuality = {
      validTileRatio,
      totalTiles,
      validTiles: successCount,
      zoom,
    };

    return {
      width: gridW,
      height: gridH,
      zoom,
      tileXMin,
      tileXMax,
      tileYMin,
      tileYMax,
      numTilesX,
      numTilesY,
      data,
      tileValidity,
      minElevation: isFinite(minEle) ? minEle : fallbackMinEle,
      maxElevation: isFinite(maxEle) ? maxEle : fallbackMaxEle,
      isRealDEM: true,
      quality,
    };
  }

  /**
   * Bilinearly samples elevation prioritizing a local high-resolution DEM grid,
   * falling back to the base DEM grid if outside local coverage or invalid (Stage V7).
   */
  public static sampleElevationWithFallback(
    localGrid: ElevationGrid | null | undefined,
    baseGrid: ElevationGrid | null | undefined,
    lat: number,
    lon: number
  ): ElevationSampleResult {
    if (localGrid) {
      const localSample = this.sampleElevation(localGrid, lat, lon);
      if (localSample.isValid && !isNaN(localSample.elevation)) {
        return localSample;
      }
    }
    if (baseGrid) {
      return this.sampleElevation(baseGrid, lat, lon);
    }
    return { elevation: NaN, isValid: false };
  }

  /**
   * Bilinearly samples elevation from the DEM grid.
   * Returns { elevation, isValid } where isValid indicates genuine DEM coverage.
   */
  public static sampleElevation(
    grid: ElevationGrid,
    lat: number,
    lon: number
  ): ElevationSampleResult {
    const n = 2 ** grid.zoom;
    const xGlobal = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yGlobal = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;

    const gx = (xGlobal - grid.tileXMin) * 256;
    const gy = (yGlobal - grid.tileYMin) * 256;

    if (gx < 0 || gx >= grid.width - 1 || gy < 0 || gy >= grid.height - 1) {
      return { elevation: NaN, isValid: false };
    }

    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    if (tx < 0 || tx >= grid.numTilesX || ty < 0 || ty >= grid.numTilesY) {
      return { elevation: NaN, isValid: false };
    }

    const tileIdx = ty * grid.numTilesX + tx;
    if (grid.tileValidity[tileIdx] === 0) {
      return { elevation: NaN, isValid: false };
    }

    const x0 = Math.floor(gx);
    const x1 = Math.min(x0 + 1, grid.width - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(y0 + 1, grid.height - 1);

    const e00 = grid.data[y0 * grid.width + x0];
    const e10 = grid.data[y0 * grid.width + x1];
    const e01 = grid.data[y1 * grid.width + x0];
    const e11 = grid.data[y1 * grid.width + x1];

    const fx = gx - x0;
    const fy = gy - y0;

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    let sumWeight = 0;
    let sumElevation = 0;

    if (!isNaN(e00) && isFinite(e00)) {
      sumWeight += w00;
      sumElevation += w00 * e00;
    }
    if (!isNaN(e10) && isFinite(e10)) {
      sumWeight += w10;
      sumElevation += w10 * e10;
    }
    if (!isNaN(e01) && isFinite(e01)) {
      sumWeight += w01;
      sumElevation += w01 * e01;
    }
    if (!isNaN(e11) && isFinite(e11)) {
      sumWeight += w11;
      sumElevation += w11 * e11;
    }

    if (sumWeight <= 1e-6) {
      return { elevation: NaN, isValid: false };
    }

    const elevation = sumElevation / sumWeight;
    return { elevation, isValid: true };
  }

  /**
   * Helper that returns elevation number or undefined if unavailable.
   */
  public static sampleElevationValue(
    grid: ElevationGrid,
    lat: number,
    lon: number
  ): number | undefined {
    const res = this.sampleElevation(grid, lat, lon);
    return res.isValid && !isNaN(res.elevation) ? res.elevation : undefined;
  }
}
