import type { TerrainWorkerJob } from '../terrain/TerrainJobs.ts';
import { decodeTerrarium } from '../terrain/TerrariumDecode.ts';
import { ElevationTileService } from '../terrain/ElevationTiles.ts';
import { GPXParser } from '../gpx/GPXParser.ts';
import { LocalTerrainChunk } from '../terrain/LocalTerrainChunk.ts';
import { sampleTerrainSurface, type TerrainSurfaceData } from '../terrain/TerrainGrid.ts';
import { buildPromotedSurfacePatches, type SurfaceMeshSnapshot } from '../terrain/SurfacePromotion.ts';
import { decodeLercElevation } from '../terrain/LercElevation.ts';
import { resolveSurfaceSources } from '../terrain/SurfaceSourceTransport.ts';

let surfaceSources: SurfaceMeshSnapshot[] | undefined;
let chunkBase: TerrainSurfaceData | undefined;

self.onmessage = async (event: MessageEvent<TerrainWorkerJob>) => {
  try {
    const job = event.data;
    if (job.kind === 'lerc') {
      const result = await decodeLercElevation(job.input);
      self.postMessage({ result }, { transfer: [result.data.buffer] });
    } else if (job.kind === 'decode') {
      const result = decodeTerrarium(job.input);
      self.postMessage({ result }, { transfer: [result.data.buffer] });
    } else if (job.kind === 'surface') {
      if (!job.reuseSources) surfaceSources = resolveSurfaceSources(job.input.sources, surfaceSources);
      if (!surfaceSources) throw new Error('Terrain worker has no source surface');
      const result = buildPromotedSurfacePatches({ ...job.input, sources: surfaceSources });
      self.postMessage({ result }, { transfer: result.flatMap(patch => [patch.positions.buffer, patch.normals.buffer, patch.uvs.buffer, patch.indices.buffer]) });
    } else if (job.kind === 'chunk') {
      if (!job.reuseBase) chunkBase = job.base;
      const base = chunkBase;
      if (!base) throw new Error('Terrain worker has no base grid');
      const chunk = new LocalTerrainChunk({ ...job.options, baseElevationSampler: (x, z) => sampleTerrainSurface(base, x, z) });
      const result = chunk.getBuildData();
      self.postMessage({ result }, { transfer: [result.positions.buffer, result.normals.buffer, result.uvs.buffer, result.indices.buffer, result.heights.buffer] });
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

// Signal that the full module and message handler loaded, before callers
// transfer sole-owned image/elevation buffers for the first job.
self.postMessage({ ready: true });
