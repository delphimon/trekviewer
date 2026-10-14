import type { TerrainJob } from '../terrain/TerrainJobs.ts';
import { decodeTerrarium } from '../terrain/TerrariumDecode.ts';
import { ElevationTileService } from '../terrain/ElevationTiles.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import { LocalTerrainChunk } from '../terrain/LocalTerrainChunk.ts';
import { sampleTerrainSurface } from '../terrain/TerrainGrid.ts';
import { buildPromotedSurfacePatches } from '../terrain/SurfacePromotion.ts';

self.onmessage = (event: MessageEvent<TerrainJob>) => {
  try {
    const job = event.data;
    if (job.kind === 'decode') {
      const result = decodeTerrarium(job.input);
      self.postMessage({ result }, { transfer: [result.data.buffer] });
    } else if (job.kind === 'surface') {
      const result = buildPromotedSurfacePatches(job.input);
      self.postMessage({ result }, { transfer: result.flatMap(patch => [patch.positions.buffer, patch.normals.buffer, patch.uvs.buffer, patch.indices.buffer]) });
    } else if (job.kind === 'chunk') {
      const chunk = new LocalTerrainChunk({ ...job.options, baseElevationSampler: (x, z) => sampleTerrainSurface(job.base, x, z) });
      const result = chunk.getBuildData();
      self.postMessage({ result }, { transfer: [result.positions.buffer, result.normals.buffer, result.uvs.buffer, result.heights.buffer] });
      chunk.dispose();
    } else {
      const sample = (lat: number, lon: number): number | undefined => {
        const regional = job.regional && ElevationTileService.sampleElevation(job.regional, lat, lon);
        if (regional?.isValid) return regional.elevation;
        return job.dem ? ElevationTileService.sampleElevationValue(job.dem, lat, lon) : undefined;
      };
      const result = GPXParser.finalizeWithDEM(job.raw, sample);
      self.postMessage({ result });
    }
  } catch (error) {
    self.postMessage({ error: { name: (error as Error).name, message: (error as Error).message } });
  }
};
