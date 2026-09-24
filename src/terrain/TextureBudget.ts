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
   * Adaptive, aspect-aware segment count for the 3D terrain plane mesh based on terrain physical dimensions (Section 18).
   * Maintains approximately 1:1 cell aspect ratio (dx ~= dz) with target cell spacing and bounded vertex budget.
   */
  public static getTerrainMeshResolution(
    widthOrExtentMeters: number,
    depthMeters?: number,
    isXRPresenting: boolean = false
  ): { segX: number; segZ: number } {
    // Backward-compatibility: if only 1 argument is provided, use legacy fixed square resolution
    if (depthMeters === undefined) {
      const extentMeters = widthOrExtentMeters;
      if (extentMeters <= 8000) {
        return { segX: 128, segZ: 128 };
      } else if (extentMeters <= 20000) {
        return { segX: 128, segZ: 128 };
      } else if (extentMeters <= 40000) {
        return { segX: 112, segZ: 112 };
      } else {
        return { segX: 96, segZ: 96 };
      }
    }

    const widthMeters = Math.max(1000, widthOrExtentMeters);
    const depthM = Math.max(1000, depthMeters);

    const isConstrained = isXRPresenting || this.isQuestHeadset();

    // Target cell size: ~120m for Quest (100-150m), ~75m for desktop (60-100m)
    const targetCellSize = isConstrained ? 120 : 75;
    // Maximum vertex budget: ~125k vertices on Quest (within 100k-150k budget), ~200k on desktop
    const maxVertices = isConstrained ? 125000 : 200000;

    let segX = Math.max(32, Math.ceil(widthMeters / targetCellSize));
    let segZ = Math.max(32, Math.ceil(depthM / targetCellSize));

    const totalVertices = (segX + 1) * (segZ + 1);

    if (totalVertices > maxVertices) {
      const scale = Math.sqrt(maxVertices / totalVertices);
      segX = Math.max(32, Math.floor(segX * scale));
      segZ = Math.max(32, Math.floor(segZ * scale));
    }

    return { segX, segZ };
  }
}
