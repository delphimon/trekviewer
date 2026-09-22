import type { GeoBounds } from '../gpx/TrackTypes.ts';
import { latLonToTile } from '../gpx/Coordinates.ts';
import { TileImageCache } from './TileImageCache.ts';
import { AWSTerrariumElevationProvider } from './providers/ImageryProvider.ts';

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
  tileValidity: Uint8Array; // 1 = tile valid & loaded, 0 = missing/failed
  minElevation: number;
  maxElevation: number;
  isRealDEM: boolean;
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

      if (numTilesX * numTilesY > 25) {
        zoom = Math.max(10, zoom - 1);
        const minT = latLonToTile(maxLat, minLon, zoom);
        const maxT = latLonToTile(minLat, maxLon, zoom);
        tileXMin = Math.min(minT.x, maxT.x);
        tileXMax = Math.max(minT.x, maxT.x);
        tileYMin = Math.min(minT.y, maxT.y);
        tileYMax = Math.max(minT.y, maxT.y);
        numTilesX = tileXMax - tileXMin + 1;
        numTilesY = tileYMax - tileYMin + 1;
      }

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

      const tilePromises: Promise<void>[] = [];

      for (let ty = tileYMin; ty <= tileYMax; ty++) {
        for (let tx = tileXMin; tx <= tileXMax; tx++) {
          const tileIdx = (ty - tileYMin) * numTilesX + (tx - tileXMin);

          const promise = (async () => {
            if (signal?.aborted) return;
            try {
              const img = await TileImageCache.loadTile(
                this.elevationProvider,
                zoom,
                tx,
                ty,
                4000,
                signal
              );
              const dx = (tx - tileXMin) * TILE_SIZE;
              const dy = (ty - tileYMin) * TILE_SIZE;
              ctx.drawImage(img, dx, dy);
              tileValidity[tileIdx] = 1;
              successCount++;
            } catch {
              // Mark tile as invalid; no drawing occurs
              tileValidity[tileIdx] = 0;
            } finally {
              loadedTiles++;
              onProgress?.(loadedTiles, totalTiles);
            }
          })();
          tilePromises.push(promise);
        }
      }

      await Promise.all(tilePromises);

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
        minElevation: isFinite(minEle) ? minEle : bounds.minEle,
        maxElevation: isFinite(maxEle) ? maxEle : bounds.maxEle,
        isRealDEM: true,
      };
    } catch (e) {
      console.warn('Failed to fetch elevation tiles:', e);
      return null;
    }
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

    if (isNaN(e00) || isNaN(e10) || isNaN(e01) || isNaN(e11)) {
      // Find at least one valid corner
      const valid = [e00, e10, e01, e11].filter((e) => !isNaN(e));
      if (valid.length === 0) {
        return { elevation: NaN, isValid: false };
      }
      return { elevation: valid[0], isValid: true };
    }

    const fx = gx - x0;
    const fy = gy - y0;

    const elevation =
      e00 * (1 - fx) * (1 - fy) +
      e10 * fx * (1 - fy) +
      e01 * (1 - fx) * fy +
      e11 * fx * fy;

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
