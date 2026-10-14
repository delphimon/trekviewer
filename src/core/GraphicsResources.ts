import * as THREE from 'three';
export type GraphicsResource = THREE.BufferGeometry | THREE.Material | THREE.Texture;

/** Release renderer callbacks/handles while the lost context ignores GPU deletes; retain CPU scene data. */
export function releaseGraphicsResources(roots: Iterable<THREE.Object3D>, shadowTarget?: THREE.RenderTarget | null, cached: Iterable<GraphicsResource> = []): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  for (const resource of cached) {
    if (resource instanceof THREE.BufferGeometry) geometries.add(resource);
    else if (resource instanceof THREE.Material) materials.add(resource);
    else textures.add(resource);
  }
  const instances = new Set<THREE.InstancedMesh>();
  for (const root of roots) root.traverse(object => {
    const drawable = object as THREE.Mesh;
    if (drawable.geometry) geometries.add(drawable.geometry);
    if (drawable.material) for (const material of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) materials.add(material);
    if (object instanceof THREE.InstancedMesh) instances.add(object);
    const boneTexture = (object as THREE.SkinnedMesh).skeleton?.boneTexture;
    if (boneTexture) textures.add(boneTexture);
    if (object instanceof THREE.Scene) {
      if (object.background instanceof THREE.Texture) textures.add(object.background);
      if (object.environment) textures.add(object.environment);
    }
  });
  const collectTexture = (value: unknown) => {
    if (value instanceof THREE.Texture) textures.add(value);
    else if (Array.isArray(value)) for (const item of value) if (item instanceof THREE.Texture) textures.add(item);
  };
  for (const material of materials) {
    for (const value of Object.values(material)) collectTexture(value);
    if (material instanceof THREE.ShaderMaterial) for (const uniform of Object.values(material.uniforms)) collectTexture(uniform.value);
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  for (const instance of instances) {
    const morphTexture = instance.morphTexture;
    instance.dispose();
    instance.morphTexture = morphTexture;
  }
  shadowTarget?.dispose();
}
