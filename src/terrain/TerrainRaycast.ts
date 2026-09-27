import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

interface CachedTree {
  tree: MeshBVH;
  index: THREE.BufferAttribute | null;
  indexVersion: number;
  position: THREE.BufferAttribute;
  positionVersion: number;
  drawStart: number;
  drawCount: number;
}

/** Exact ray hits on the rendered terrain triangles, with a tree rebuilt only after geometry changes. */
export class TerrainRaycast {
  private readonly trees = new WeakMap<THREE.BufferGeometry, CachedTree>();

  public closest(raycaster: THREE.Raycaster, surfaces: readonly THREE.Mesh[]): THREE.Intersection | null {
    const acceleratedRaycaster = raycaster as THREE.Raycaster & { firstHitOnly?: boolean };
    const previousFirstHitOnly = acceleratedRaycaster.firstHitOnly;
    acceleratedRaycaster.firstHitOnly = true;
    let nearest: THREE.Intersection | null = null;
    try {
      for (const mesh of surfaces) {
        if (!mesh.visible) continue;
        const hits: THREE.Intersection[] = [];
        const geometry = mesh.geometry;
        if (geometry instanceof THREE.BufferGeometry && geometry.getAttribute('position')) {
          this.getTree(geometry).raycastObject3D(mesh, raycaster, hits);
        } else {
          mesh.raycast(raycaster, hits);
        }
        for (const hit of hits) {
          if (!nearest || hit.distance < nearest.distance) nearest = hit;
        }
      }
    } finally {
      acceleratedRaycaster.firstHitOnly = previousFirstHitOnly;
    }
    return nearest;
  }

  private getTree(geometry: THREE.BufferGeometry): MeshBVH {
    const index = geometry.index;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const cached = this.trees.get(geometry);
    if (cached && cached.index === index && cached.indexVersion === (index?.version ?? -1) &&
        cached.position === position && cached.positionVersion === position.version &&
        cached.drawStart === geometry.drawRange.start && cached.drawCount === geometry.drawRange.count) {
      return cached.tree;
    }
    // The base mesh replaces its index range when a local terrain chunk becomes visible.
    // Indirect mode leaves that render index untouched while honoring its current draw range.
    const tree = new MeshBVH(geometry, { indirect: true, verbose: false });
    this.trees.set(geometry, {
      tree,
      index,
      indexVersion: index?.version ?? -1,
      position,
      positionVersion: position.version,
      drawStart: geometry.drawRange.start,
      drawCount: geometry.drawRange.count,
    });
    return tree;
  }
}
