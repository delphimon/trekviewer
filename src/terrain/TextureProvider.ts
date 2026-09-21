import * as THREE from 'three';
import type { GeoBounds } from '../gpx/TrackTypes.ts';
import { latLonToTile } from '../gpx/Coordinates.ts';

export const CESIUM_ION_DEFAULT_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IkZrUXgwQi1XYlIxSm5jZWwiLCJqdGkiOiIyMjVlZDUwNC0yZGFmLTRkYzUtYmI4MC00ZTAwZTEwZTEwNTIiLCJpZCI6NTAyODk3LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3ODk5NTk3ODF9.DtCT-vah0c3ltRXQryQmkFPX33oesxdnabVChvQbL00';

export interface TileGridBounds {
  zoom: number;
  tileXMin: number;
  tileXMax: number;
  tileYMin: number;
  tileYMax: number;
  numTilesX: number;
  numTilesY: number;
}

export class TextureProvider {
  private static bingMetadata: { key: string; urlTemplate: string; subdomains: string[] } | null = null;

  public static tileXYToQuadKey(tileX: number, tileY: number, levelOfDetail: number): string {
    let quadKey = '';
    for (let i = levelOfDetail; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((tileX & mask) !== 0) digit++;
      if ((tileY & mask) !== 0) digit += 2;
      quadKey += digit.toString();
    }
    return quadKey;
  }

  public static getTileGridForBounds(
    bounds: GeoBounds,
    marginRatio: number = 0.25
  ): TileGridBounds {
    const latMargin = (bounds.maxLat - bounds.minLat) * marginRatio;
    const lonMargin = (bounds.maxLon - bounds.minLon) * marginRatio;
    const minLat = bounds.minLat - latMargin;
    const maxLat = bounds.maxLat + latMargin;
    const minLon = bounds.minLon - lonMargin;
    const maxLon = bounds.maxLon + lonMargin;

    const latSpan = maxLat - minLat;
    let zoom = 15;
    if (latSpan < 0.08) zoom = 16;
    else if (latSpan > 0.35) zoom = 14;

    const minTile = latLonToTile(maxLat, minLon, zoom);
    const maxTile = latLonToTile(minLat, maxLon, zoom);

    let tileXMin = Math.min(minTile.x, maxTile.x);
    let tileXMax = Math.max(minTile.x, maxTile.x);
    let tileYMin = Math.min(minTile.y, maxTile.y);
    let tileYMax = Math.max(minTile.y, maxTile.y);

    let numTilesX = tileXMax - tileXMin + 1;
    let numTilesY = tileYMax - tileYMin + 1;

    const MAX_TILES = 120;
    while (numTilesX * numTilesY > MAX_TILES && zoom > 11) {
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

    return { zoom, tileXMin, tileXMax, tileYMin, tileYMax, numTilesX, numTilesY };
  }

  /**
   * Calculates the exact UV coordinate on the composite tile canvas for any given lat/lon.
   * Uses exact Web Mercator projection so the satellite orthophoto drapes with zero distortion.
   */
  public static getUVForGeo(
    lat: number,
    lon: number,
    grid: TileGridBounds
  ): { u: number; v: number } {
    const n = 2 ** grid.zoom;
    const xGlobal = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yGlobal = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;

    const u = (xGlobal - grid.tileXMin) / grid.numTilesX;
    // In Three.js with flipY=true, v=1 is Top (North: yGlobal = tileYMin), v=0 is Bottom (South)
    const v = 1 - (yGlobal - grid.tileYMin) / grid.numTilesY;

    return {
      u: Math.max(0, Math.min(1, u)),
      v: Math.max(0, Math.min(1, v)),
    };
  }

  private static async getBingAerialMetadata(): Promise<{ key: string; urlTemplate: string; subdomains: string[] } | null> {
    if (this.bingMetadata) return this.bingMetadata;

    try {
      const res = await fetch(`https://api.cesium.com/v1/assets/2/endpoint?access_token=${CESIUM_ION_DEFAULT_TOKEN}`);
      if (!res.ok) throw new Error(`Cesium Ion error: ${res.status}`);
      const data = await res.json();
      const bingKey = data.options?.key;

      if (bingKey) {
        const metaRes = await fetch(`https://dev.virtualearth.net/REST/V1/Imagery/Metadata/Aerial?key=${bingKey}`);
        if (metaRes.ok) {
          const metaData = await metaRes.json();
          const resource = metaData.resourceSets?.[0]?.resources?.[0];
          if (resource) {
            let tmpl = resource.imageUrl as string;
            tmpl = tmpl.replace('http://', 'https://');
            const subdomains = (resource.imageUrlSubdomains as string[]) || ['t0', 't1', 't2', 't3'];
            this.bingMetadata = { key: bingKey, urlTemplate: tmpl, subdomains };
            return this.bingMetadata;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load Cesium Ion Bing metadata, fallback to Esri:', e);
    }
    return null;
  }

  /**
   * Fetches high-resolution satellite imagery tiles covering the exact tile grid bounds.
   * Uses an asynchronous concurrency worker pool with progressive real-time canvas updates.
   */
  public static async fetchSatelliteTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void
  ): Promise<THREE.CanvasTexture | null> {
    try {
      const TILE_SIZE = 256;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(grid.numTilesX * TILE_SIZE, 4096);
      canvas.height = Math.min(grid.numTilesY * TILE_SIZE, 4096);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scaleX = canvas.width / (grid.numTilesX * TILE_SIZE);
      const scaleY = canvas.height / (grid.numTilesY * TILE_SIZE);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 16;
      texture.generateMipmaps = true;

      const bing = await this.getBingAerialMetadata();

      const tasks: { tx: number; ty: number }[] = [];
      for (let tx = grid.tileXMin; tx <= grid.tileXMax; tx++) {
        for (let ty = grid.tileYMin; ty <= grid.tileYMax; ty++) {
          tasks.push({ tx, ty });
        }
      }

      const totalCount = tasks.length;
      let completedCount = 0;
      let successCount = 0;
      let lastUpdateTime = performance.now();

      const worker = async () => {
        while (tasks.length > 0) {
          const task = tasks.shift();
          if (!task) break;
          const { tx, ty } = task;

          let url: string;
          if (bing) {
            const qk = this.tileXYToQuadKey(tx, ty, grid.zoom);
            const sub = bing.subdomains[(tx + ty) % bing.subdomains.length];
            url = bing.urlTemplate.replace('{subdomain}', sub).replace('{quadkey}', qk);
          } else {
            url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${grid.zoom}/${ty}/${tx}`;
          }

          const x0 = Math.round((tx - grid.tileXMin) * TILE_SIZE * scaleX);
          const x1 = Math.round((tx - grid.tileXMin + 1) * TILE_SIZE * scaleX);
          const y0 = Math.round((ty - grid.tileYMin) * TILE_SIZE * scaleY);
          const y1 = Math.round((ty - grid.tileYMin + 1) * TILE_SIZE * scaleY);

          try {
            const img = await this.loadImageWithTimeout(url, 4500);
            ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
            successCount++;
          } catch {
            try {
              const fallbackUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${grid.zoom}/${ty}/${tx}`;
              const img = await this.loadImageWithTimeout(fallbackUrl, 3000);
              ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
              successCount++;
            } catch {
              // Ignore single tile error
            }
          }

          completedCount++;
          const now = performance.now();
          if (now - lastUpdateTime > 250 || completedCount === totalCount) {
            lastUpdateTime = now;
            texture.needsUpdate = true;
            onProgressUpdate?.(texture, completedCount, totalCount);
          }
        }
      };

      const concurrency = Math.min(14, totalCount);
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);

      if (successCount === 0) return null;

      texture.needsUpdate = true;
      return texture;
    } catch (e) {
      console.warn('Failed to fetch high-res satellite imagery:', e);
      return null;
    }
  }

  /**
   * Fetches high-resolution Hybrid satellite imagery with topographic labels:
   * 1. Base layer: Aerial orthophoto (Bing Aerial / Esri World Imagery / USGS NAIP)
   * 2. Overlay layer: Transparent vector reference labels (peaks with summit names and spot elevations,
   *    mountain passes, hiking trails, campsites, shelters, glaciers, and boundary names).
   */
  public static async fetchHybridTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void
  ): Promise<THREE.CanvasTexture | null> {
    try {
      const TILE_SIZE = 256;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(grid.numTilesX * TILE_SIZE, 4096);
      canvas.height = Math.min(grid.numTilesY * TILE_SIZE, 4096);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scaleX = canvas.width / (grid.numTilesX * TILE_SIZE);
      const scaleY = canvas.height / (grid.numTilesY * TILE_SIZE);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 16;
      texture.generateMipmaps = true;

      const bing = await this.getBingAerialMetadata();

      const tasks: { tx: number; ty: number }[] = [];
      for (let tx = grid.tileXMin; tx <= grid.tileXMax; tx++) {
        for (let ty = grid.tileYMin; ty <= grid.tileYMax; ty++) {
          tasks.push({ tx, ty });
        }
      }

      const totalCount = tasks.length;
      let completedCount = 0;
      let successCount = 0;
      let lastUpdateTime = performance.now();

      const worker = async () => {
        while (tasks.length > 0) {
          const task = tasks.shift();
          if (!task) break;
          const { tx, ty } = task;

          const x0 = Math.round((tx - grid.tileXMin) * TILE_SIZE * scaleX);
          const x1 = Math.round((tx - grid.tileXMin + 1) * TILE_SIZE * scaleX);
          const y0 = Math.round((ty - grid.tileYMin) * TILE_SIZE * scaleY);
          const y1 = Math.round((ty - grid.tileYMin + 1) * TILE_SIZE * scaleY);
          const dw = x1 - x0;
          const dh = y1 - y0;

          // 1. Draw 100% pure high-resolution satellite aerial base (vibrant photography, no washed-out topo tint)
          let baseDrawn = false;
          let satUrl: string;
          if (bing) {
            const qk = this.tileXYToQuadKey(tx, ty, grid.zoom);
            const sub = bing.subdomains[(tx + ty) % bing.subdomains.length];
            satUrl = bing.urlTemplate.replace('{subdomain}', sub).replace('{quadkey}', qk);
          } else {
            satUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${grid.zoom}/${ty}/${tx}`;
          }

          try {
            const satImg = await this.loadImageWithTimeout(satUrl, 4000);
            ctx.drawImage(satImg, x0, y0, dw, dh);
            baseDrawn = true;
            successCount++;
          } catch {
            try {
              const fallbackSat = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${grid.zoom}/${ty}/${tx}`;
              const satImg = await this.loadImageWithTimeout(fallbackSat, 3000);
              ctx.drawImage(satImg, x0, y0, dw, dh);
              baseDrawn = true;
              successCount++;
            } catch {
              // Base tile failed
            }
          }

          // Overlay transparent reference labels (peaks, trails, campsite landmarks)
          if (baseDrawn) {
            const overlayUrls = [
              `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/${grid.zoom}/${ty}/${tx}`,
              `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${grid.zoom}/${ty}/${tx}`,
              `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${grid.zoom}/${ty}/${tx}`,
            ];
            for (const oUrl of overlayUrls) {
              try {
                const oImg = await this.loadImageWithTimeout(oUrl, 3000);
                ctx.drawImage(oImg, x0, y0, dw, dh);
                break;
              } catch {
                // Try next label overlay provider
              }
            }
          }

          completedCount++;
          const now = performance.now();
          if (now - lastUpdateTime > 250 || completedCount === totalCount) {
            lastUpdateTime = now;
            texture.needsUpdate = true;
            onProgressUpdate?.(texture, completedCount, totalCount);
          }
        }
      };

      const concurrency = Math.min(14, totalCount);
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);

      if (successCount === 0) return null;

      texture.needsUpdate = true;
      return texture;
    } catch (e) {
      console.warn('Failed to fetch hybrid satellite & label texture:', e);
      return null;
    }
  }

  /**
   * Fetches authentic high-resolution topographic raster map tiles covering the exact tile grid bounds.
   * Downloads official USGS Topographic Quadrangle maps (complete with peaks, hiking trails, campsites,
   * shelters, and contour lines), with automatic fallback to ArcGIS World Topo and OpenTopoMap.
   */
  public static async fetchTopoTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void
  ): Promise<THREE.CanvasTexture | null> {
    try {
      const TILE_SIZE = 256;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(grid.numTilesX * TILE_SIZE, 4096);
      canvas.height = Math.min(grid.numTilesY * TILE_SIZE, 4096);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scaleX = canvas.width / (grid.numTilesX * TILE_SIZE);
      const scaleY = canvas.height / (grid.numTilesY * TILE_SIZE);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 16;
      texture.generateMipmaps = true;

      const tasks: { tx: number; ty: number }[] = [];
      for (let tx = grid.tileXMin; tx <= grid.tileXMax; tx++) {
        for (let ty = grid.tileYMin; ty <= grid.tileYMax; ty++) {
          tasks.push({ tx, ty });
        }
      }

      const totalCount = tasks.length;
      let completedCount = 0;
      let successCount = 0;
      let lastUpdateTime = performance.now();

      const worker = async () => {
        while (tasks.length > 0) {
          const task = tasks.shift();
          if (!task) break;
          const { tx, ty } = task;

          const x0 = Math.round((tx - grid.tileXMin) * TILE_SIZE * scaleX);
          const x1 = Math.round((tx - grid.tileXMin + 1) * TILE_SIZE * scaleX);
          const y0 = Math.round((ty - grid.tileYMin) * TILE_SIZE * scaleY);
          const y1 = Math.round((ty - grid.tileYMin + 1) * TILE_SIZE * scaleY);

          // 1. Primary: Official USGS Topo (The National Map) - authenticated peaks, trails, campsites, shelters
          const usgsUrl = `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${grid.zoom}/${ty}/${tx}`;
          // 2. Secondary: ArcGIS World Topographic Basemap
          const esriTopoUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${grid.zoom}/${ty}/${tx}`;
          // 3. Tertiary: OpenTopoMap
          const sub = ['a', 'b', 'c'][(tx + ty) % 3];
          const otmUrl = `https://${sub}.tile.opentopomap.org/${grid.zoom}/${tx}/${ty}.png`;

          for (const url of [usgsUrl, esriTopoUrl, otmUrl]) {
            try {
              const img = await this.loadImageWithTimeout(url, 4000);
              ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
              successCount++;
              break;
            } catch {
              // Try next fallback source
            }
          }

          completedCount++;
          const now = performance.now();
          if (now - lastUpdateTime > 250 || completedCount === totalCount) {
            lastUpdateTime = now;
            texture.needsUpdate = true;
            onProgressUpdate?.(texture, completedCount, totalCount);
          }
        }
      };

      const concurrency = Math.min(12, totalCount);
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);

      if (successCount === 0) return null;

      texture.needsUpdate = true;
      return texture;
    } catch (e) {
      console.warn('Failed to fetch high-res topographic map tiles:', e);
      return null;
    }
  }

  /**
   * Generates a rich Topographic texture aligned to the exact tile grid bounds.
   */
  public static generateTopoTexture(
    bounds: GeoBounds,
    grid: TileGridBounds,
    elevationSampler: (lat: number, lon: number) => number,
    width: number = 1024,
    height: number = 1024
  ): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    const minEle = bounds.minEle;
    const maxEle = bounds.maxEle;
    const eleSpan = Math.max(maxEle - minEle, 50);

    const n = 2 ** grid.zoom;

    for (let py = 0; py < height; py++) {
      // py = 0 is top (North), py = height-1 is bottom (South)
      const gy = grid.tileYMin + (py / height) * grid.numTilesY;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / n)));
      const lat = (latRad * 180) / Math.PI;

      for (let px = 0; px < width; px++) {
        const gx = grid.tileXMin + (px / width) * grid.numTilesX;
        const lon = (gx / n) * 360 - 180;

        const ele = elevationSampler(lat, lon);
        const normEle = Math.min(Math.max((ele - minEle) / eleSpan, 0), 1);

        let r = 0, g = 0, b = 0;
        if (normEle < 0.25) {
          const t = normEle / 0.25;
          r = 30 + t * 45;
          g = 68 + t * 40;
          b = 38 + t * 15;
        } else if (normEle < 0.5) {
          const t = (normEle - 0.25) / 0.25;
          r = 75 + t * 45;
          g = 108 + t * 15;
          b = 53 + t * 65;
        } else if (normEle < 0.75) {
          const t = (normEle - 0.5) / 0.25;
          r = 120 + t * 50;
          g = 123 + t * 50;
          b = 118 + t * 60;
        } else {
          const t = (normEle - 0.75) / 0.25;
          r = 170 + t * 80;
          g = 173 + t * 80;
          b = 178 + t * 77;
        }

        const contour100 = Math.abs((ele % 100) - 50);
        const contour500 = Math.abs((ele % 500) - 250);

        if (contour500 < 6) {
          r = Math.max(0, r - 35);
          g = Math.max(0, g - 35);
          b = Math.max(0, b - 35);
        } else if (contour100 < 3) {
          r = Math.max(0, r - 18);
          g = Math.max(0, g - 18);
          b = Math.max(0, b - 18);
        }

        const idx = (py * width + px) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 16;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
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
