import * as THREE from 'three';

export interface Disposable {
  dispose(): void;
}

/**
 * Recursively disposes a Three.js Object3D and all its children, releasing GPU memory
 * (geometries, materials, textures, and canvas backing stores).
 */
export function disposeObject3D(
  object: THREE.Object3D,
  preserveTextures?: Set<THREE.Texture>
): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();

  const disposeTexture = (texture: THREE.Texture | null | undefined) => {
    if (!texture) return;
    if (preserveTextures && preserveTextures.has(texture)) return;
    if (disposedTextures.has(texture)) return;
    disposedTextures.add(texture);

    try {
      texture.dispose();
      // If it has a canvas source, clear its dimensions to free backing canvas memory
      const source = texture.source?.data;
      if (source && typeof (source as HTMLCanvasElement).getContext === 'function') {
        const canvas = source as HTMLCanvasElement;
        canvas.width = 1;
        canvas.height = 1;
      }
    } catch {
      // Ignore dispose errors on already released textures
    }
  };

  const disposeMaterial = (material: THREE.Material | null | undefined) => {
    if (!material) return;
    if (disposedMaterials.has(material)) return;
    disposedMaterials.add(material);

    // Dispose all potential texture maps on standard/basic materials
    const mat = material as any;
    disposeTexture(mat.map);
    disposeTexture(mat.lightMap);
    disposeTexture(mat.bumpMap);
    disposeTexture(mat.normalMap);
    disposeTexture(mat.specularMap);
    disposeTexture(mat.envMap);
    disposeTexture(mat.alphaMap);
    disposeTexture(mat.aoMap);
    disposeTexture(mat.displacementMap);
    disposeTexture(mat.emissiveMap);
    disposeTexture(mat.metalnessMap);
    disposeTexture(mat.roughnessMap);

    try {
      material.dispose();
    } catch {
      // Ignore
    }
  };

  object.traverse((child) => {
    // 1. Geometries
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      try {
        mesh.geometry.dispose();
      } catch {
        // Ignore
      }
    }

    // 2. Materials (single or multi-material array)
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        for (const mat of mesh.material) {
          disposeMaterial(mat);
        }
      } else {
        disposeMaterial(mesh.material);
      }
    }
  });

  // Recursively detach all descendants
  const detachAll = (node: THREE.Object3D) => {
    while (node.children.length > 0) {
      const child = node.children[0];
      detachAll(child);
      node.remove(child);
    }
  };
  detachAll(object);

  // Remove from parent if still attached
  if (object.parent) {
    object.parent.remove(object);
  }
}
