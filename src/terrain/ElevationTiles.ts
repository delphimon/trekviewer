import type { GeoBounds } from '../gpx/TrackTypes.ts';
import { latLonToTile } from '../gpx/Coordinates.ts';

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
  isRealDEM: boolean;
}

export class ElevationTileService {
  /**
   * Fetches real-world AWS Terrarium DEM tiles covering the bounding box.
   * Decodes elevation in meters using exact Web Mercator pixel alignment.
   */
  public static async fetchElevationGrid(
    bounds: GeoBounds,
    marginRatio: number = 0.25,
    onProgress?: (loaded: number, total: number) => void
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

      if (numTilesX * numTilesY > 20) {
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
      let loadedTiles = 0;
      let successCount = 0;

      const tilePromises: Promise<void>[] = [];

      for (let tx = tileXMin; tx <= tileXMax; tx++) {
        for (let ty = tileYMin; ty <= tileYMax; ty++) {
          const promise = (async () => {
            const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`;
            try {
              const img = await this.loadImageWithTimeout(url, 4000);
              const dx = (tx - tileXMin) * TILE_SIZE;
              const dy = (ty - tileYMin) * TILE_SIZE;
              ctx.drawImage(img, dx, dy);
              successCount++;
            } catch {
              // Ignore single tile failures
            } finally {
              loadedTiles++;
              onProgress?.(loadedTiles, totalTiles);
            }
          })();
          tilePromises.push(promise);
        }
      }

      await Promise.all(tilePromises);

      if (successCount === 0) {
        return null;
      }

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imgData.data;
      const gridW = canvas.width;
      const gridH = canvas.height;
      const data = new Float32Array(gridW * gridH);

      // Decode Terrarium: elevation = (R * 256 + G + B / 256) - 32768
      for (let i = 0; i < gridW * gridH; i++) {
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        data[i] = (r * 256 + g + b / 256) - 32768;
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
        isRealDEM: true,
      };
    } catch (e) {
      console.warn('Failed to fetch elevation tiles:', e);
      return null;
    }
  }

  /**
   * Bilinearly samples elevation from the DEM grid using exact Web Mercator pixel math.
   */
  public static sampleElevation(
    grid: ElevationGrid,
    lat: number,
    lon: number
  ): number {
    const n = 2 ** grid.zoom;
    const xGlobal = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yGlobal = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;

    const gx = (xGlobal - grid.tileXMin) * 256;
    const gy = (yGlobal - grid.tileYMin) * 256;

    if (gx < 0 || gx >= grid.width - 1 || gy < 0 || gy >= grid.height - 1) {
      return 0;
    }

    const x0 = Math.floor(gx);
    const x1 = Math.min(x0 + 1, grid.width - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(y0 + 1, grid.height - 1);

    const fx = gx - x0;
    const fy = gy - y0;

    const e00 = grid.data[y0 * grid.width + x0];
    const e10 = grid.data[y0 * grid.width + x1];
    const e01 = grid.data[y1 * grid.width + x0];
    const e11 = grid.data[y1 * grid.width + x1];

    return (
      e00 * (1 - fx) * (1 - fy) +
      e10 * fx * (1 - fy) +
      e01 * (1 - fx) * fy +
      e11 * fx * fy
    );
  }

  private static loadImageWithTimeout(url: string, timeoutMs: number): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let timer: number | null = window.setTimeout(() => {
        timer = null;
        img.src = '';
        reject(new Error(`Timeout loading image: ${url}`));
      }, timeoutMs);

      img.onload = () => {
        if (timer) clearTimeout(timer);
        resolve(img);
      };
      img.onerror = (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      };
      img.src = url;
    });
  }
}
