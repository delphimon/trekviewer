import type { SurfaceMeshSnapshot } from './SurfacePromotion.ts';

export type SurfaceSourceUpdate = SurfaceMeshSnapshot
  | (Omit<SurfaceMeshSnapshot, 'positions' | 'normals'> & { reuseSource: number });

/** References only the previous message's source set, so retired meshes cannot
 * accumulate in the worker. Metadata (including changed holes) always travels. */
export function encodeSurfaceSources(sources: SurfaceMeshSnapshot[], previous: SurfaceMeshSnapshot[] | null): SurfaceSourceUpdate[] {
  return sources.map(source => {
    const index = previous?.findIndex(old => old.positions === source.positions && old.normals === source.normals
      && old.positionVersion === source.positionVersion && old.normalVersion === source.normalVersion) ?? -1;
    if (index < 0) return source;
    const { positions: _positions, normals: _normals, ...metadata } = source;
    return { ...metadata, reuseSource: index };
  });
}

export function resolveSurfaceSources(updates: SurfaceSourceUpdate[], previous?: SurfaceMeshSnapshot[]): SurfaceMeshSnapshot[] {
  return updates.map(update => {
    if (!('reuseSource' in update)) return update;
    const source = previous?.[update.reuseSource];
    if (!Number.isInteger(update.reuseSource) || !source) throw new Error('Terrain worker has no referenced surface');
    const { reuseSource: _index, ...metadata } = update;
    return { ...metadata, positions: source.positions, normals: source.normals };
  });
}
