export class TextureBudget {
  /**
   * Detects if running on Meta Quest or standalone VR headset.
   */
  public static isQuestHeadset(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /Quest|OculusBrowser/i.test(ua);
  }

  /**
   * Determines maximum canvas texture dimensions based on runtime platform and grid size.
   */
  public static getAssembledTextureSize(
    numTilesX: number,
    numTilesY: number,
    isXRPresenting: boolean = false,
    sourceTileSize: number = 256
  ): { width: number; height: number } {
    const rawW = numTilesX * sourceTileSize;
    const rawH = numTilesY * sourceTileSize;

    // Quest 3 / Standalone XR limit: 2048x2048 max to avoid thermal throttling and GPU VRAM spikes
    const isConstrained = isXRPresenting || this.isQuestHeadset();
    const maxDimension = isConstrained ? 2048 : 4096;

    let width = Math.min(rawW, maxDimension);
    let height = Math.min(rawH, maxDimension);

    // Keep power of two or multiples of 256
    width = Math.max(512, Math.min(maxDimension, Math.round(width / 256) * 256));
    height = Math.max(512, Math.min(maxDimension, Math.round(height / 256) * 256));

    return { width, height };
  }

  /**
   * Adaptive segment count for the 3D terrain plane mesh based on terrain physical extent.
   */
  public static getTerrainMeshResolution(
    extentMeters: number,
    isXRPresenting: boolean = false
  ): { segX: number; segZ: number } {
    // Target ~80m - 120m per cell for small alpine zones, ~150m - 200m for massive traverses
    if (extentMeters <= 8000) {
      // Small peak / climb (e.g. Putrid Pete P3: ~4km): crisp 144x144 or 128x128
      return { segX: 128, segZ: 128 };
    } else if (extentMeters <= 20000) {
      // Standard mountain massif (e.g. Rainier, Baker: 15-20km): 128x128
      return { segX: 128, segZ: 128 };
    } else if (extentMeters <= 40000) {
      // Extended ridge / traverse: 112x112
      return { segX: 112, segZ: 112 };
    } else {
      // Massive multi-day expedition (e.g. Bailey Range: 50km+): 96x96
      return { segX: 96, segZ: 96 };
    }
  }
}
