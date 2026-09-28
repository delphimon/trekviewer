import manifest from '../data/enchantments-3dep-2019.json';
import { resolveAssetUrl } from '../../utils/AssetUrl.ts';
import type { ImageryProvider } from './ImageryProvider.ts';

const coveredTiles = new Set(manifest.tiles);
const tileCoordinates = manifest.tiles.map((key) => key.split('/').map(Number));

/** A public-domain, locally packaged 3DEP DEM experiment for Colchuck/Asgard. */
export class EnchantmentsRegionalDEMProvider implements ImageryProvider {
  readonly id = manifest.id;
  readonly displayName = 'USGS 3DEP Enchantments 1m source';
  readonly attribution = 'Elevation: USGS 3DEP, WA Eastern Cascades 2019';
  readonly maxZoom = manifest.zoom;

  readonly tileBounds = {
    minX: Math.min(...tileCoordinates.map(([x]) => x)),
    maxX: Math.max(...tileCoordinates.map(([x]) => x)),
    minY: Math.min(...tileCoordinates.map(([, y]) => y)),
    maxY: Math.max(...tileCoordinates.map(([, y]) => y)),
  };

  covers(zoom: number, x: number, y: number): boolean {
    return zoom === manifest.zoom && coveredTiles.has(`${x}/${y}`);
  }

  getTileUrls(zoom: number, x: number, y: number): string[] {
    if (!this.covers(zoom, x, y)) return [];
    return [resolveAssetUrl(`dem/enchantments-3dep-2019/${zoom}/${x}/${y}.png`)];
  }
}
